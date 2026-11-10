import { describe, expect, it } from 'vitest';
import { PLAN_SHOWN, nameFit, planCalls, planLine } from './show';

// The plan ORACLE revealed on the first paid job, exactly as the jobs contract holds it.
const REAL =
  '[{"method":"set_owner","args":{"new_owner":"oracle.tinygif8324.testnet"}},{"method":"sweep","args":{"to":"oracle.tinygif8324.testnet","amount":"1000000000000000000000000"}}]';

describe('a revealed drain plan on the job’s course', () => {
  it('is named by the calls it makes, in order: one line a person reads', () => {
    expect(planCalls(REAL)).toEqual(['set_owner', 'sweep']);
    expect(planLine(REAL)).toBe('set_owner, then sweep');
  });

  it('shows none of the plan’s raw text: no braces, no quotes, no accounts, no amounts', () => {
    const line = planLine(REAL)!;
    expect(line).not.toMatch(/[{}[\]"]/);
    expect(line).not.toContain('testnet');
    expect(line).not.toContain('1000000000000000000000000');
  });

  it('names the first calls of a long plan and counts the rest', () => {
    const many = JSON.stringify(['a', 'b', 'c', 'd', 'e', 'f'].map((method) => ({ method, args: {} })));
    expect(planCalls(many)).toHaveLength(6);
    expect(planLine(many)).toBe(`a, then b, then c, then d, and ${6 - PLAN_SHOWN} more`);
    expect(planLine(JSON.stringify([{ method: 'sweep' }]))).toBe('sweep');
  });

  it('leaves any other revealed content to be shown as it is: text of a review, a box, broken JSON', () => {
    for (const other of [
      null,
      undefined,
      '',
      'The contract lets anyone call set_owner.',
      'mw1.AAECAwQ',
      '[]',
      '[1,2]',
      '[{"method":42}]',
      '[{"args":{}}]',
      '[{"method":"<script>alert(1)</script>"}]',
      '[{"method":"set_owner"},"sweep"]',
      '[{"method":"set_owner"}',
      '{"method":"set_owner"}',
    ]) {
      expect(planCalls(other), String(other)).toBeNull();
      expect(planLine(other), String(other)).toBeNull();
    }
  });
});

describe('a mask’s name in a narrow card', () => {
  it('stands in the full width of the face up to ten letters, the arena’s own masks among them', () => {
    for (const name of ['NOVA', 'ONYX', 'ORACLE', 'WRAITH', 'TENLETTERS']) expect(nameFit(name), name).toBe('wide');
  });

  it('is set narrower as it grows, up to the sixteen letters a person’s mask may have, and is never cut', () => {
    expect(nameFit('ELEVENCHARS')).toBe('mid');
    expect(nameFit('THIRTEENCHARS')).toBe('mid');
    expect(nameFit('FOURTEENLETTER')).toBe('narrow');
    expect(nameFit('X'.repeat(16))).toBe('narrow');
  });
});
