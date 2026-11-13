// The masks people forged, as the league lists them: every mask the factory holds, read on the server and reused for a
// few seconds like the arena's own reading (lib/arena.ts). The league never waits long for the factory and never fails
// with it: a factory that is not there, does not answer in time or lists nothing leaves the page without the section.
import type { MaskStats, Who } from '@maskwars/arena';
import { listMasks, look as lookOf, type MaskView } from '@maskwars/forge';
import { FORGE_NET, FORGE_STATED } from './forge';
import { stateOf } from './person';
import { artOf, type Faces, lookTone } from './show';

/** How many masks the league shows; the rest is one line, "and N more". */
export const FORGED_SHOWN = 12;
/** One reading of the factory serves every page for this long, ms. */
const TTL_MS = 15_000;
/** A page waits this long for the factory, ms; one RPC gets a little less for one page of the list. */
const WAIT_MS = 3_000;
const RPC_MS = 2_500;
/** A reading the factory did not replace is shown for this long, ms: after it, a state word could be about a race long over. */
const KEEP_MS = 10 * 60_000;

/** One row of the league's "Forged masks". Amounts are yoctoNEAR. */
export interface ForgedMask {
  readonly name: string;
  readonly look: string;
  readonly races: number;
  readonly breaks: number;
  /** What its mind has left to race on (the factory's `brain`). */
  readonly tank: string;
  readonly state: { readonly key: string; readonly word: string };
}

export interface Forged {
  readonly masks: readonly ForgedMask[];
  /** How many more the factory lists beyond the ones shown. */
  readonly more: number;
}

export interface ForgedReader {
  /** The factory's masks, or null when there is nothing to show for them now. It never throws. */
  read(): Promise<readonly MaskView[] | null>;
}

/**
 * A reader over one factory: one instance of the server. A reading is reused for `ttlMs`. A page waits `waitMs` for a
 * new one and no longer: a slow reading goes on behind it and serves the pages after it. When the factory fails or is
 * late, the last good reading stands in, for `keepMs` at most.
 */
export function forgedReader(o: { list: () => Promise<readonly MaskView[]>; now?: () => number; ttlMs?: number; waitMs?: number; keepMs?: number }): ForgedReader {
  const now = o.now ?? Date.now;
  const ttl = o.ttlMs ?? TTL_MS;
  const wait = o.waitMs ?? WAIT_MS;
  const keep = o.keepMs ?? KEEP_MS;
  let reading: { at: number; value: Promise<readonly MaskView[] | null> } | null = null;
  let good: { at: number; value: readonly MaskView[] } | null = null;
  const kept = () => (good && now() - good.at <= keep ? good.value : null);
  return {
    async read() {
      if (!reading || now() - reading.at >= ttl) {
        const mine = {
          at: now(),
          value: Promise.resolve()
            .then(o.list)
            .then(
              (value) => {
                good = { at: now(), value };
                return value;
              },
              () => {
                // A reading that failed is not reused: the next page asks again.
                if (reading === mine) reading = null;
                return null;
              },
            ),
        };
        reading = mine;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>((done) => {
        timer = setTimeout(() => done(null), wait);
      });
      const value = await Promise.race([reading.value, late]);
      clearTimeout(timer);
      return value ?? kept();
    },
  };
}

let reader: ForgedReader | null = null;

/**
 * The masks people forged on this network, for the league: null when the network has no forge, when the factory does
 * not answer in time and no recent reading stands in, and never an error.
 */
export async function readForged(): Promise<readonly MaskView[] | null> {
  if (!FORGE_STATED || !FORGE_NET.factory) return null;
  reader ??= forgedReader({ list: () => listMasks(FORGE_NET, { timeoutMs: RPC_MS }) });
  return reader.read();
}

const oldestFirst = (a: MaskView, b: MaskView) => {
  const x = BigInt(a.born_ns);
  const y = BigInt(b.born_ns);
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * The rows of "Forged masks": most races first, then the oldest; `shown` at most, and how many more there are. A mask
 * still being forged has no page yet and is left out. Races and breaks are the ones its own page shows: the arena's
 * record of it (`league`) beside the factory's count. Null when there is no mask to show.
 */
export function forgedRows(masks: readonly MaskView[] | null, league: readonly MaskStats[], shown = FORGED_SHOWN): Forged | null {
  const stats = new Map(league.map((m) => [m.who.account, m]));
  const rows = (masks ?? [])
    .filter((m) => m.state !== 'forging')
    .map((m) => ({ m, races: Math.max(stats.get(m.account)?.races ?? 0, m.races), breaks: stats.get(m.account)?.breaks ?? 0 }))
    .sort((a, b) => b.races - a.races || oldestFirst(a.m, b.m));
  if (!rows.length) return null;
  return {
    masks: rows.slice(0, shown).map(({ m, races, breaks }): ForgedMask => {
      const { key, word } = stateOf(m);
      return { name: m.name, look: m.look, races, breaks, tank: m.brain, state: { key, word } };
    }),
    more: Math.max(0, rows.length - shown),
  };
}

/** Whether a round has a mask whose face only the factory knows: a person's mask, which the arena has no art for. */
export function hasForged(masks: readonly Who[] | null | undefined): boolean {
  return (masks ?? []).some((m) => m.mask && m.slug !== null && !artOf(m));
}

/**
 * The faces of the forged masks among `field`, by account: the art of each one's look and the colour of its eyes. A
 * mask the factory's reading does not hold, or a look the site has no art for, is left out: the stage gives it the mark.
 */
export function facesOf(masks: readonly MaskView[] | null, field: readonly Who[]): Faces {
  const out: Record<string, Faces[string]> = {};
  const inField = new Set(field.map((m) => m.account));
  for (const m of masks ?? []) {
    const art = inField.has(m.account) ? lookOf(m.look)?.art : undefined;
    if (art) out[m.account] = { art, tone: lookTone(m.look) };
  }
  return out;
}
