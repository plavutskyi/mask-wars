// One shape for a "break my contract" request, checked the same way in the form and on the server.

export const MIN_BOUNTY = 100;
export const MAX_BOUNTY = 10_000_000;

export interface BreakRequest {
  repo: string;
  bounty: number;
  contact: string;
}

/** github.com/you/vault → https://github.com/you/vault; null if it is not a link to code. */
export function normalizeRepo(input: string): string | null {
  const t = input.trim();
  if (!t || t.length > 300) return null;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(t) ? t : `https://${t}`);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.') || u.pathname.replace(/\/+$/, '').split('/').filter(Boolean).length < 1) return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

export const contactOk = (c: string) => {
  const t = c.trim();
  return t.length >= 3 && t.length <= 200;
};

export const bountyOk = (b: number) => Number.isInteger(b) && b >= MIN_BOUNTY && b <= MAX_BOUNTY;

/** A clean request, or null if any field is wrong. */
export function parseBreakRequest(input: unknown): BreakRequest | null {
  if (!input || typeof input !== 'object') return null;
  const { repo, bounty, contact } = input as Record<string, unknown>;
  if (typeof repo !== 'string' || typeof contact !== 'string' || typeof bounty !== 'number') return null;
  const r = normalizeRepo(repo);
  if (!r || !bountyOk(bounty) || !contactOk(contact)) return null;
  return { repo: r, bounty, contact: contact.trim() };
}

/**
 * Only the site's own form may send a request. It posts JSON, which a page on another site cannot do without a CORS
 * preflight we never answer; a browser also says outright when a request comes from another site.
 */
export function fromOwnSite(headers: Headers): boolean {
  const type = headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(type.trim())) return false;
  const site = headers.get('sec-fetch-site');
  return site === null || site === 'same-origin' || site === 'none';
}
