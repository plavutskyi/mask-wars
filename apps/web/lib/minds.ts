// The price of the masks' thinking, race by race, kept for good. The race job writes what each mask's mind cost in a
// race (packages/race/src/minds.ts) and the public repository's workflow keeps it as the artifact `minds-<race>` for 90
// days. This server reads it there with the token it already holds for that repository's Actions
// (SEASON_DISPATCH_TOKEN, lib/season.ts: Actions read and write, nothing else), checks it, and keeps it in Vercel Blob
// (`minds/v1/<network>/<race>.json`, private) so a race shows its price long after the artifact is gone.
//
// Only an artifact of a run on `main` of the repository itself counts: a fork's run cannot name a price. A round two
// runs raced (a later run races a round that still seals) has both runs' answers added up (`mergeRecords`).
//
// GitHub's "no record yet" is kept too, for `MISS_MS`, where every instance reads it (`minds/v1-miss/<network>/`): a
// cold instance does not ask GitHub again about a round another instance asked about a minute ago.
//
// With no Blob token (a local run) the records are kept in this process's memory; MINDS_FIXTURE names a file of records
// for local screenshots. A race without a record shows no price and no ×; a record says how each price was found
// (@maskwars/arena/minds, `priceState`).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { Race } from '@maskwars/arena';
import { NETWORK } from '@maskwars/arena/config';
import { mergeRecords, parseMindRecord, type MindRecord } from '@maskwars/arena/minds';
import { get, list, put } from '@vercel/blob';
import { after } from 'next/server';
import { SEASON_REPO } from './season';

/** Where the records live, under this network and no other. */
export const ROOT = `minds/v1/${NETWORK}/`;
/** Where GitHub's latest "no record yet" for a round is kept, apart from the records so that listing them never reads it. */
export const MISS_ROOT = `minds/v1-miss/${NETWORK}/`;
/** An artifact lives 90 days; a round older than that is never looked for on GitHub. */
const ARTIFACT_DAYS = 90;
/** A round nobody found a record for is looked for again after this long, per instance. */
export const MISS_MS = 10 * 60_000;
/** Kept records are listed again after this long, per instance: a record written by another instance shows by then. */
const LIST_MS = 60_000;
/** One page asks GitHub about this many rounds at most, each for this long. */
const ASK_AT_ONCE = 6;
const ASK_MS = 4_000;
/** An artifact this size or larger is not a record. */
const MAX_ZIP = 256 * 1024;

export interface MindStore {
  /** Every record kept for this network, by race. */
  all(): Promise<Map<string, MindRecord>>;
  keep(record: MindRecord): Promise<void>;
  /** When GitHub last said it holds no record of `race`, as every instance sees it; null when nobody kept that. */
  missedAt(race: string): Promise<number | null>;
  missed(race: string, at: number): Promise<void>;
}

/** Looks for a round's record where the race job left it; null when there is none (yet). */
export type Harvest = (race: string) => Promise<MindRecord | null>;

// ---- Stores ----------------------------------------------------------------------------------------------------------

export function memoryStore(seed: readonly MindRecord[] = []): MindStore {
  const kept = new Map(seed.map((r) => [r.race, r]));
  const misses = new Map<string, number>();
  return {
    all: async () => new Map(kept),
    keep: async (r) => {
      kept.set(r.race, r);
    },
    missedAt: async (race) => misses.get(race) ?? null,
    missed: async (race, at) => {
      misses.set(race, at);
    },
  };
}

const RACE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Vercel Blob, private. A record never changes once kept, so each is read once per instance. */
export function blobStore(o: { now?: () => number } = {}): MindStore {
  const now = o.now ?? Date.now;
  const read = new Map<string, MindRecord>();
  let listed: { at: number; names: string[] } | null = null;
  return {
    async all() {
      if (!listed || now() - listed.at > LIST_MS) {
        const names: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await list({ prefix: ROOT, limit: 1000, ...(cursor ? { cursor } : {}) });
          names.push(...page.blobs.map((b) => b.pathname));
          cursor = page.hasMore ? page.cursor : undefined;
        } while (cursor);
        listed = { at: now(), names };
      }
      await Promise.all(
        listed.names
          .filter((n) => !read.has(n))
          .map(async (n) => {
            const found = await get(n, { access: 'private', useCache: false }).catch(() => null);
            if (!found || found.statusCode !== 200) return;
            const record = parseMindRecord(JSON.parse(await new Response(found.stream).text()));
            if (record && record.network === NETWORK && `${ROOT}${record.race}.json` === n) read.set(n, record);
          }),
      );
      return new Map([...read.values()].map((r) => [r.race, r]));
    },
    async keep(r) {
      const path = `${ROOT}${r.race}.json`;
      await put(path, JSON.stringify(r), { access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true });
      read.set(path, r);
      if (listed && !listed.names.includes(path)) listed.names.push(path);
    },
    async missedAt(race) {
      if (!RACE_ID.test(race)) return null;
      const found = await get(`${MISS_ROOT}${race}.json`, { access: 'private', useCache: false }).catch(() => null);
      if (!found || found.statusCode !== 200) return null;
      try {
        const at = (JSON.parse(await new Response(found.stream).text()) as { at?: unknown }).at;
        return typeof at === 'number' && Number.isFinite(at) ? at : null;
      } catch {
        return null;
      }
    },
    async missed(race, at) {
      if (!RACE_ID.test(race)) return;
      await put(`${MISS_ROOT}${race}.json`, JSON.stringify({ at }), { access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true });
    },
  };
}

// ---- GitHub ------------------------------------------------------------------------------------------------------------

interface Artifact {
  id: number;
  name: string;
  expired: boolean;
  created_at: string;
  archive_download_url: string;
  workflow_run?: { id?: number; head_branch?: string; repository_id?: number; head_repository_id?: number };
}

/** The one file in a zip by its name, stored or deflated; null when it is not there or not readable. */
export function unzipOne(zip: Uint8Array, name: string): string | null {
  const b = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  // The end of the central directory sits in the last 22 bytes and the comment after them.
  for (let end = b.length - 22; end >= Math.max(0, b.length - 22 - 0xffff); end--) {
    if (b.readUInt32LE(end) !== 0x06054b50) continue;
    const count = b.readUInt16LE(end + 10);
    let at = b.readUInt32LE(end + 16);
    for (let i = 0; i < count && at + 46 <= b.length; i++) {
      if (b.readUInt32LE(at) !== 0x02014b50) return null;
      const method = b.readUInt16LE(at + 10);
      const packed = b.readUInt32LE(at + 20);
      const size = b.readUInt32LE(at + 24);
      const nameLen = b.readUInt16LE(at + 28);
      const extraLen = b.readUInt16LE(at + 30);
      const commentLen = b.readUInt16LE(at + 32);
      const local = b.readUInt32LE(at + 42);
      const entry = b.toString('utf8', at + 46, at + 46 + nameLen);
      at += 46 + nameLen + extraLen + commentLen;
      if (entry !== name) continue;
      if (local + 30 > b.length || b.readUInt32LE(local) !== 0x04034b50 || size > MAX_ZIP) return null;
      const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
      const data = b.subarray(start, start + packed);
      if (data.length !== packed) return null;
      try {
        const out = method === 0 ? data : method === 8 ? inflateRawSync(data, { maxOutputLength: MAX_ZIP }) : null;
        return out && out.length === size ? out.toString('utf8') : null;
      } catch {
        return null;
      }
    }
    return null;
  }
  return null;
}

/**
 * A round's record from the public repository's artifacts `minds-<race>`: every run on `main` of the repository
 * itself, added up. Needs a token that reads the repository's Actions.
 */
export function githubHarvest(o: { token: string; repo?: string; fetch?: typeof fetch; timeoutMs?: number }): Harvest {
  const repo = o.repo ?? SEASON_REPO;
  const get = o.fetch ?? fetch;
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${o.token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'maskwars-minds',
  };
  return async (race) => {
    const signal = AbortSignal.timeout(o.timeoutMs ?? ASK_MS);
    const q = new URLSearchParams({ name: `minds-${race}`, per_page: '20' });
    const res = await get(`https://api.github.com/repos/${repo}/actions/artifacts?${q}`, { headers, signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { artifacts?: Artifact[] };
    const ours = (body.artifacts ?? []).filter(
      (a) =>
        a.name === `minds-${race}` &&
        !a.expired &&
        a.workflow_run?.head_branch === 'main' &&
        typeof a.workflow_run.id === 'number' &&
        a.workflow_run.repository_id !== undefined &&
        a.workflow_run.head_repository_id === a.workflow_run.repository_id,
    );
    const records: MindRecord[] = [];
    for (const a of ours) {
      // GitHub answers with a short-lived link to the zip; the token is not sent on to it.
      const link = await get(a.archive_download_url, { headers, redirect: 'manual', signal });
      const to = link.status >= 300 && link.status < 400 ? link.headers.get('location') : null;
      const zip = to ? await get(to, { signal }) : link.ok ? link : null;
      if (!zip || !zip.ok) continue;
      const bytes = new Uint8Array(await zip.arrayBuffer());
      if (bytes.length >= MAX_ZIP) continue;
      const text = unzipOne(bytes, 'minds.json');
      let raw: unknown = null;
      try {
        raw = text ? JSON.parse(text) : null;
      } catch {
        raw = null;
      }
      const record = parseMindRecord(raw);
      if (!record || record.race !== race || record.network !== NETWORK) continue;
      records.push({ ...record, run: `https://github.com/${repo}/actions/runs/${a.workflow_run!.id}` });
    }
    return mergeRecords(records);
  };
}

// ---- The reader --------------------------------------------------------------------------------------------------------

/** The rounds whose race job may have left a record by now: the arena's own, past their sealing, within 90 days. */
export function lookable(r: Pick<Race, 'id' | 'official' | 'kind' | 'phase' | 'openedAt'>, now: number): boolean {
  if (!r.official || r.kind !== 'safe' || r.phase === 'sealing' || r.openedAt === null) return false;
  return now - r.openedAt < ARTIFACT_DAYS * 24 * 3_600_000;
}

export interface MindsReader {
  /** The records of these races that exist: kept ones, and ones found on GitHub now (then kept). */
  of(races: readonly Race[]): Promise<Map<string, MindRecord>>;
}

export function mindsReader(o: { store: MindStore; harvest: Harvest | null; now?: () => number; background?: (work: Promise<void>) => void }): MindsReader {
  const now = o.now ?? Date.now;
  /** What GitHub said about a round lately, found or not: asked again only after `MISS_MS`. */
  const asked = new Map<string, { at: number; record: MindRecord | null }>();
  return {
    async of(races) {
      const kept = await o.store.all().catch(() => new Map<string, MindRecord>());
      const out = new Map<string, MindRecord>();
      const t = now();
      for (const r of races) {
        const hit = kept.get(r.id) ?? (o.harvest && t - (asked.get(r.id)?.at ?? -Infinity) <= MISS_MS ? asked.get(r.id)?.record : null);
        if (hit) out.set(r.id, hit);
      }
      if (!o.harvest) return out;
      const due = races.filter((r) => !out.has(r.id) && lookable(r, t) && t - (asked.get(r.id)?.at ?? -Infinity) > MISS_MS).slice(0, ASK_AT_ONCE);
      // Another instance may have asked GitHub a moment ago: its "no record yet" stands for this one too.
      const missedAt = await Promise.all(due.map((r) => o.store.missedAt(r.id).catch(() => null)));
      const ask = due.filter((r, i) => {
        const at = missedAt[i];
        if (at === null || at === undefined || t - at > MISS_MS) return true;
        asked.set(r.id, { at, record: null });
        return false;
      });
      const found = await Promise.all(ask.map((r) => o.harvest!(r.id).catch(() => null)));
      ask.forEach((r, i) => {
        const record = found[i] ?? null;
        asked.set(r.id, { at: t, record });
        if (!record) {
          o.background?.(o.store.missed(r.id, t).catch(() => {}));
          return;
        }
        out.set(r.id, record);
        // A race still on its way may have another run to come: its record is shown, and kept once the race is over.
        if (r.phase === 'broken' || r.phase === 'held') o.background?.(o.store.keep(record).catch(() => {}));
      });
      return out;
    },
  };
}

function behind(work: Promise<void>): void {
  try {
    after(work);
  } catch {
    /* no request to outlive */
  }
}

const globals = globalThis as unknown as { __maskwarsMinds?: MindsReader };

function fixtureRecords(): MindRecord[] {
  const file = process.env.MINDS_FIXTURE;
  if (!file || process.env.VERCEL) return [];
  const raw = JSON.parse(readFileSync(/* turbopackIgnore: true */ resolve(/* turbopackIgnore: true */ process.cwd(), file), 'utf8')) as unknown[];
  return raw.map((r) => parseMindRecord(r)).filter((r): r is MindRecord => r !== null);
}

/** The site's reader: Vercel Blob and GitHub on Vercel, memory (and MINDS_FIXTURE) elsewhere. */
export function minds(): MindsReader {
  if (globals.__maskwarsMinds) return globals.__maskwarsMinds;
  const fixture = Boolean(process.env.ARENA_FIXTURE) || Boolean(process.env.MINDS_FIXTURE);
  const blob = !fixture && Boolean(process.env.BLOB_READ_WRITE_TOKEN);
  const token = (process.env.SEASON_DISPATCH_TOKEN ?? '').trim();
  const repo = (process.env.SEASON_REPO ?? '').trim() || SEASON_REPO;
  globals.__maskwarsMinds = mindsReader({
    store: blob ? blobStore() : memoryStore(fixtureRecords()),
    harvest: !fixture && token ? githubHarvest({ token, repo }) : null,
    background: behind,
  });
  return globals.__maskwarsMinds;
}

/** The records of these races, or none when the store cannot be read: a page never fails for want of them. */
export async function mindsOf(races: readonly Race[]): Promise<Map<string, MindRecord>> {
  try {
    return await minds().of(races);
  } catch {
    return new Map();
  }
}
