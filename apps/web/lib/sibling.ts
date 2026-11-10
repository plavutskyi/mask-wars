// What this site reads from the other one (MASKWARS_SIBLING_URL): when the season there opens its next round, for the
// home page's one line about the other network. The other site is the same code on the other network, so its open
// /api/races is asked, the answer is kept for a minute, and the page never waits on it for longer than a moment: with
// no answer the line simply carries no time.
import { SITE } from './site';

/** The other site is asked at most this often. */
const KEEP_MS = 60_000;
/** A time the other site gave stays good this long while it cannot be asked again. */
const TRUST_MS = 10 * 60_000;
const DAY_MS = 24 * 3_600_000;

export interface SiblingReader {
  /** When the other network's next round opens, in ms: only a round its treasury can open, due within a day. */
  nextRound(now?: number): Promise<number | null>;
}

export function siblingReader(o: { origin: string | null; fetch?: typeof fetch; waitMs?: number }): SiblingReader {
  const f = o.fetch ?? fetch;
  let answer: { at: number; next: number | null } | null = null;
  let askedAt: number | null = null;
  let asking: Promise<void> | null = null;

  const ask = async (now: number) => {
    askedAt = now;
    try {
      const res = await f(`${o.origin}/api/races`, { cache: 'no-store', signal: AbortSignal.timeout(4_000) });
      if (!res.ok) throw new Error(String(res.status));
      const view = (await res.json()) as { next?: { at?: unknown; funded?: unknown } | null };
      const n = view.next;
      answer = { at: now, next: n && n.funded === true && typeof n.at === 'number' ? n.at : null };
    } catch {
      /* the other site did not answer: what it last said stands for a while (TRUST_MS) */
    } finally {
      asking = null;
    }
  };

  return {
    async nextRound(now = Date.now()) {
      if (!o.origin) return null;
      if (askedAt === null || now - askedAt >= KEEP_MS) {
        const first = askedAt === null;
        asking ??= ask(now);
        // The first visitor waits a moment for the answer; everyone after gets the last one while a new one is read.
        if (first) await Promise.race([asking, new Promise((done) => setTimeout(done, o.waitMs ?? 700))]);
      }
      const at = answer && now - answer.at <= TRUST_MS ? answer.next : null;
      return at !== null && at > now && at - now <= DAY_MS ? at : null;
    },
  };
}

const reader = siblingReader({ origin: SITE.sibling });

/** When the other network's next round opens, or `null`: no other site, no funded round within a day, or no answer. */
export const siblingNextRound = (now?: number) => reader.nextRound(now);
