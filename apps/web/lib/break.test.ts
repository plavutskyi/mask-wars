import { describe, expect, it } from 'vitest';
import { fromOwnSite, parseBreakRequest } from './break';

const h = (init: Record<string, string>) => new Headers(init);

describe('fromOwnSite', () => {
  it('lets the form through', () => {
    expect(fromOwnSite(h({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(fromOwnSite(h({ 'content-type': 'application/json; charset=utf-8' }))).toBe(true);
  });

  it('refuses a post from another site', () => {
    expect(fromOwnSite(h({ 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(fromOwnSite(h({ 'content-type': 'application/json', 'sec-fetch-site': 'same-site' }))).toBe(false);
  });

  it('refuses the bodies a page on another site can send without asking', () => {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      expect(fromOwnSite(h({ 'content-type': type })), type).toBe(false);
    }
    expect(fromOwnSite(h({}))).toBe(false);
  });
});

describe('parseBreakRequest', () => {
  it('keeps a clean request', () => {
    expect(parseBreakRequest({ repo: 'github.com/you/vault/', bounty: 500, contact: ' @you ' })).toEqual({
      repo: 'https://github.com/you/vault',
      bounty: 500,
      contact: '@you',
    });
  });

  it('refuses a link that is not code or a bounty out of range', () => {
    expect(parseBreakRequest({ repo: 'javascript:alert(1)', bounty: 500, contact: '@you' })).toBeNull();
    expect(parseBreakRequest({ repo: 'github.com/you/vault', bounty: 50, contact: '@you' })).toBeNull();
  });
});
