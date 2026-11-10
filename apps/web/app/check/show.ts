// What the page shows of MASK CHECK's answer (GET /api/check): the line under the verdict, where evidence can be
// seen, and when the chain was read. Text in an answer may be written by others (a report's reason): it is shown as
// text, never followed.
import type { CheckResult, Reason } from '@maskwars/check';

/** The arena's first live safe: a mask drained it in race-0003, so the page opens on a real BLOCK. */
export const EXAMPLE = 'safe-0001.tinygif8324.testnet';

/** The strongest reason's own words: the line under the verdict. */
export function lineOf(check: Pick<CheckResult, 'verdict' | 'summary' | 'reasons'>): string {
  if (check.verdict === 'allow') return check.summary;
  return check.reasons.find((r) => r.level === check.verdict)?.text ?? check.summary.replace(/^[A-Z]+: /, '');
}

const EXPLORER_TX = /^https:\/\/(testnet\.)?nearblocks\.io\/txns\/[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A reason's transaction on NEAR's explorer; `null` for anything else an answer carries. */
export function txOf(reason: Pick<Reason, 'evidence'>): string | null {
  const tx = reason.evidence?.['tx'];
  return typeof tx === 'string' && EXPLORER_TX.test(tx) ? tx : null;
}

/** `9 Nov 2026, 20:10 UTC` from an ISO time. */
export function utc(iso: string): string {
  const at = new Date(iso);
  const day = at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  return `${day}, ${time} UTC`;
}

/** `Block 223,814,527` and `9 Nov 2026, 20:10 UTC`, each kept on one line; `null` when the chain was not read. */
export function readAt(check: Pick<CheckResult, 'block'>): [string, string] | null {
  return check.block ? [`Block ${check.block.height.toLocaleString('en-US')}`, utc(check.block.time)] : null;
}

const ISO_TIME = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/;

/** A reason's text in parts: an ISO time inside it reads as a date and stays on one line. */
export function partsOf(text: string): { text: string; keep: boolean }[] {
  return text
    .split(ISO_TIME)
    .map((part, i) => (i % 2 ? { text: utc(part), keep: true } : { text: part, keep: false }))
    .filter((part) => part.text);
}

/** The reasons Details lists: every one but the line already under the verdict. */
export function restOf(check: Pick<CheckResult, 'verdict' | 'reasons'>): Reason[] {
  const shown = check.verdict === 'allow' ? -1 : check.reasons.findIndex((r) => r.level === check.verdict);
  return check.reasons.filter((_, i) => i !== shown);
}

/** The transaction behind the line under the verdict, when it has one. */
export function proofOf(check: Pick<CheckResult, 'verdict' | 'reasons'>): string | null {
  const shown = check.verdict === 'allow' ? undefined : check.reasons.find((r) => r.level === check.verdict);
  return shown ? txOf(shown) : null;
}

/** The providers an answer was read from, by host. */
export function hostsOf(check: Pick<CheckResult, 'rpc'>): string[] {
  return check.rpc.map((url) => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  });
}

/** Why no verdict came, in the page's words, from what the API answered. */
export function refusalOf(status: number, retryAfter: string | null): string {
  if (status === 400) return 'Not a NEAR account. Try alice.near or alice.testnet.';
  if (status === 429) return `Too many checks. Try again in ${Math.max(1, Number(retryAfter) || 5)} s.`;
  return 'No answer this time. Try again.';
}
