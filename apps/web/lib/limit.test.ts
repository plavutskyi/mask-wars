import { describe, expect, it } from 'vitest';
import { callerOf, createLimiter } from './limit';

describe('createLimiter', () => {
  it('lets a caller through up to the limit, then says when to come back', () => {
    const l = createLimiter({ perWindow: 2, windowMs: 60_000 });
    expect(l.take('a', 0)).toBeNull();
    expect(l.take('a', 1_000)).toBeNull();
    expect(l.take('a', 2_000)).toBe(58);
    expect(l.take('b', 2_000)).toBeNull();
    expect(l.take('a', 60_000)).toBeNull();
  });

  it('keeps its memory bounded', () => {
    const l = createLimiter({ perWindow: 1, windowMs: 60_000, maxKeys: 2 });
    l.take('a', 0);
    l.take('b', 0);
    expect(l.take('c', 0)).toBeNull();
    expect(l.take('a', 0)).toBeNull();
  });
});

describe('callerOf', () => {
  it('reads the address Vercel reports', () => {
    expect(callerOf(new Request('https://x', { headers: { 'x-real-ip': '1.2.3.4' } }))).toBe('1.2.3.4');
    expect(callerOf(new Request('https://x', { headers: { 'x-forwarded-for': '5.6.7.8, 10.0.0.1' } }))).toBe('5.6.7.8');
    expect(callerOf(new Request('https://x'))).toBe('unknown');
  });
});
