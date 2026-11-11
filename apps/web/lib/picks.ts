// The server side of "pick the breaker": who a person is, where their picks are kept, and how a round is settled.
//
// Who: a person with a vault on this site (a passkey) picks as their vault's account, once they prove it with one
// touch; anyone else as their device, a random id in a cookie. Both cookies are signed here: a page cannot name
// someone else, nor write its own record of picks.
//
// Where: Vercel Blob, the store the site already has for /break and the vault's passkeys (BLOB_READ_WRITE_TOKEN).
// A pick is one empty blob whose name says it all (`picks/v1/<network>/<round>/<who>~<choice>~<from>~<ms>`), so one
// listing reads a whole round and a change of mind is one more write: the last one before the close counts. When the
// chain says how a round ended, its picks are settled once into a tally that is never rewritten, and the callers'
// table is folded again from every tally. Nothing here is the record of the race: the chain is. With no token (a
// local run, a recording) the same is kept in this process's memory.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { del, get, list, put } from '@vercel/blob';
import type { ArenaView, Race } from '@maskwars/arena';
import { NETWORK } from '@maskwars/arena/config';
import { type Board, boardOf, EMPTY_BOARD, type Entry, type Filed, fileName, KEEP, keyIs, keyOk, parseFile, raceKey, settledOn, type Tally, tallyOf, whoOk } from './pick';

// ---- Signing ----------------------------------------------------------------------------------------------------------

const fixture = Boolean(process.env.ARENA_FIXTURE);
const blobOn = !fixture && Boolean(process.env.BLOB_READ_WRITE_TOKEN);

/**
 * The key the cookies are signed with. PICKS_SECRET when the owner sets one; else one derived from the Blob token the
 * site already holds, so no new secret has to be made. A run with neither signs with a key of its own that dies with it.
 */
const KEY: Buffer = (() => {
  const own = process.env.PICKS_SECRET;
  if (own && own.length >= 32) return createHash('sha256').update(`maskwars picks v1|${own}`).digest();
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (token) return createHash('sha256').update(`maskwars picks v1|${token}`).digest();
  return randomBytes(32);
})();

const mac = (text: string): string => createHmac('sha256', KEY).update(text).digest('base64url').slice(0, 27);

/** `<payload>.<mac>`: the payload readable, its mac proving this server wrote it. */
export function seal(payload: string): string {
  return `${payload}.${mac(payload)}`;
}

export function unseal(value: string | undefined | null): string | null {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const want = Buffer.from(mac(payload));
  const got = Buffer.from(value.slice(dot + 1));
  return want.length === got.length && timingSafeEqual(want, got) ? payload : null;
}

/** A short tag of a caller's address: enough to cap one address's share of a round, never the address itself. */
export const fromTag = (address: string): string => createHmac('sha256', KEY).update(`from|${address}`).digest('hex').slice(0, 8);

// ---- Cookies ----------------------------------------------------------------------------------------------------------

export const WHO_COOKIE = 'mw_who';
export const PICKS_COOKIE = 'mw_picks';
/** About a year, the most browsers keep a cookie (400 days). */
const COOKIE_S = 400 * 24 * 3600;

/** The person a cookie names, if this server signed it. */
export const whoOf = (cookie: string | undefined): string | null => {
  const w = unseal(cookie);
  return whoOk(w) ? w : null;
};

export const newDevice = (): string => `d${randomBytes(16).toString('base64url')}`;

/** The picks a cookie keeps, if this server signed it. */
export function entriesOf(cookie: string | undefined): Entry[] {
  const raw = unseal(cookie);
  if (!raw) return [];
  try {
    const list = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(list)) return [];
    return list
      .filter((e): e is [string, string, number] => Array.isArray(e) && keyOk(e[0]) && typeof e[1] === 'string' && e[1].length <= 64 && typeof e[2] === 'number')
      .slice(0, KEEP)
      .map(([key, choice, at]) => ({ key, choice, at }));
  } catch {
    return [];
  }
}

export const entriesCookie = (entries: readonly Entry[]): string =>
  seal(Buffer.from(JSON.stringify(entries.map((e) => [e.key, e.choice, e.at]))).toString('base64url'));

/** The cookies a request carries, by name. */
export function cookiesOf(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** A Set-Cookie line: the browser keeps it, scripts on the page never read it. */
export function cookieLine(name: string, value: string, secure: boolean): string {
  return `${name}=${value}; Path=/; Max-Age=${COOKIE_S}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

// ---- The store --------------------------------------------------------------------------------------------------------

export interface PickStore {
  /** Writes `body` at `path`. `once`: only if nothing is there yet; false when something was. */
  write(path: string, body: string, once?: boolean): Promise<boolean>;
  read(path: string): Promise<string | null>;
  /** The names under `prefix`, without it. */
  names(prefix: string): Promise<string[]>;
  /** The folders right under `prefix`, without it and without their slash. */
  folders(prefix: string): Promise<string[]>;
  remove(path: string): Promise<void>;
}

export function memoryPicks(): PickStore {
  const kept = new Map<string, string>();
  const under = (prefix: string) => [...kept.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  return {
    async write(path, body, once = false) {
      if (once && kept.has(path)) return false;
      kept.set(path, body);
      return true;
    },
    async read(path) {
      return kept.get(path) ?? null;
    },
    async names(prefix) {
      return under(prefix).filter((k) => !k.includes('/'));
    },
    async folders(prefix) {
      return [...new Set(under(prefix).filter((k) => k.includes('/')).map((k) => k.slice(0, k.indexOf('/'))))];
    },
    async remove(path) {
      kept.delete(path);
    },
  };
}

/**
 * A folder on this machine (PICKS_DIR): a local run that walks a person through several recorded rounds, each served by
 * its own run of the site, keeps the same record across them. Never on Vercel.
 */
export function dirPicks(root: string): PickStore {
  const at = (p: string) => join(/* turbopackIgnore: true */ root, p);
  const entries = async (prefix: string) => {
    const dir = prefix.endsWith('/') ? prefix : dirname(prefix);
    try {
      return await readdir(at(dir), { withFileTypes: true });
    } catch {
      return [];
    }
  };
  return {
    async write(path, body, once = false) {
      if (once && (await stat(at(path)).catch(() => null))) return false;
      await mkdir(dirname(at(path)), { recursive: true });
      await writeFile(at(path), body);
      return true;
    },
    async read(path) {
      return readFile(at(path), 'utf8').catch(() => null);
    },
    async names(prefix) {
      return (await entries(prefix)).filter((e) => e.isFile()).map((e) => e.name);
    },
    async folders(prefix) {
      return (await entries(prefix)).filter((e) => e.isDirectory()).map((e) => e.name);
    },
    async remove(path) {
      await rm(at(path), { force: true });
    },
  };
}

/** Vercel Blob, private: nothing in it is served to anyone but this server. */
export function blobPicks(): PickStore {
  const listAll = async (prefix: string, mode: 'expanded' | 'folded') => {
    const blobs: string[] = [];
    const folders: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, mode, limit: 1000, ...(cursor ? { cursor } : {}) });
      blobs.push(...page.blobs.map((b) => b.pathname.slice(prefix.length)));
      if ('folders' in page && Array.isArray(page.folders)) folders.push(...page.folders.map((f: string) => f.slice(prefix.length).replace(/\/$/, '')));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return { blobs, folders };
  };
  return {
    async write(path, body, once = false) {
      try {
        await put(path, body, { access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: !once, cacheControlMaxAge: 60 });
        return true;
      } catch (e) {
        // Written once: a second write of a tally fails, and the first one stands.
        if (once) return false;
        throw e;
      }
    },
    async read(path) {
      const found = await get(path, { access: 'private', useCache: false });
      if (!found || found.statusCode !== 200) return null;
      return new Response(found.stream).text();
    },
    async names(prefix) {
      return (await listAll(prefix, 'expanded')).blobs.filter((n) => !n.includes('/'));
    },
    async folders(prefix) {
      return (await listAll(prefix, 'folded')).folders;
    },
    async remove(path) {
      await del(path);
    },
  };
}

const globals = globalThis as unknown as { __maskwarsPicks?: PickStore };
export function pickStore(): PickStore {
  const dir = process.env.VERCEL ? undefined : process.env.PICKS_DIR;
  globals.__maskwarsPicks ??= blobOn ? blobPicks() : dir ? dirPicks(dir) : memoryPicks();
  return globals.__maskwarsPicks;
}

// ---- The record ---------------------------------------------------------------------------------------------------------

/** Every path of this network's picks. A path written under another version is never read as this one. */
export const ROOT = `picks/v1/${NETWORK}/`;
const ROUNDS = `${ROOT}round/`;
const TALLIES = `${ROOT}tally/`;
const ALIASES = `${ROOT}alias/`;
const BOARD = `${ROOT}board.json`;

/** Files one pick. The last pick a person files before the close is the one that counts. */
export async function filePick(store: PickStore, key: string, f: Filed): Promise<void> {
  await store.write(`${ROUNDS}${key}/${fileName(f)}`, '{}');
}

/** A device's picks are the vault's from now on: the table folds them under the vault's account. */
export async function linkDevice(store: PickStore, device: string, vault: string): Promise<void> {
  if (!device.startsWith('d') || !vault.startsWith('a')) return;
  await store.write(`${ALIASES}${device}~${vault}`, '{}');
}

async function aliases(store: PickStore): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const name of await store.names(ALIASES)) {
    const [device, vault] = name.split('~');
    if (whoOk(device) && whoOk(vault) && device.startsWith('d') && vault.startsWith('a')) map.set(device, vault);
  }
  return map;
}

/** Every pick filed on `race`, under its own key and under the scheduled time it opened for. */
async function filedOn(store: PickStore, race: Race, races: readonly Race[]): Promise<Filed[]> {
  const keys = (await store.folders(ROUNDS)).filter((k) => keyOk(k) && keyIs(k, race, races));
  const out: Filed[] = [];
  for (const key of keys) for (const name of await store.names(`${ROUNDS}${key}/`)) {
    const f = parseFile(name);
    if (f) out.push(f);
  }
  return out;
}

const tallies = new Map<string, Tally>();

function readTally(raw: string | null): Tally | null {
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as Tally;
    return t && t.v === 1 && keyOk(t.key) && typeof t.outcome === 'string' && Array.isArray(t.picks) ? t : null;
  } catch {
    return null;
  }
}

/** Every settled round: each tally read once per server, they never change. */
async function allTallies(store: PickStore): Promise<Tally[]> {
  const names = (await store.names(TALLIES)).filter((n) => n.endsWith('.json'));
  const missing = names.filter((n) => !tallies.has(n));
  const read = await Promise.all(missing.map(async (n) => [n, readTally(await store.read(`${TALLIES}${n}`))] as const));
  for (const [n, t] of read) if (t) tallies.set(n, t);
  return names.map((n) => tallies.get(n)).filter((t): t is Tally => Boolean(t));
}

function readBoardJson(raw: string | null): Board | null {
  if (!raw) return null;
  try {
    const b = JSON.parse(raw) as Board;
    return b && b.v === 1 && Array.isArray(b.rounds) && b.callers && typeof b.callers === 'object' ? b : null;
  } catch {
    return null;
  }
}

/** The board this server last read, for a minute: the league and every page ask often, it changes once a day. */
let held: { at: number; board: Board } | null = null;
const HOLD_MS = 60_000;

export async function readBoard(store: PickStore = pickStore(), now = Date.now()): Promise<Board> {
  if (held && now - held.at < HOLD_MS) return held.board;
  const board = readBoardJson(await store.read(BOARD)) ?? EMPTY_BOARD;
  held = { at: now, board };
  return board;
}

/**
 * Settles every finished round of the reading that the board does not hold yet: its tally, written once, and the
 * table folded again from all of them. Returns the board as it stands after.
 */
export async function settle(view: Pick<ArenaView, 'races'>, store: PickStore = pickStore(), now = Date.now()): Promise<Board> {
  let board = await readBoard(store, now);
  const due = view.races.filter((r) => r.official && r.sealUntil !== null && !settledOn(board, r)).filter((r) => tallyOf(r, []) !== null);
  if (!due.length) return board;
  const alias = await aliases(store);
  for (const race of due) {
    const tally = tallyOf(race, await filedOn(store, race, view.races), alias)!;
    const path = `${TALLIES}${raceKey(race)}.json`;
    if (!(await store.write(path, JSON.stringify(tally), true))) continue;
    tallies.set(`${raceKey(race)}.json`, tally);
  }
  board = boardOf(await allTallies(store), alias);
  await store.write(BOARD, JSON.stringify(board));
  held = { at: now, board };
  return board;
}

/** Only one settling at a time per server: the pages that ask at once wait for the same one. */
let settling: Promise<Board> | null = null;
export function settleOnce(view: Pick<ArenaView, 'races'>): Promise<Board> {
  settling ??= settle(view).finally(() => {
    settling = null;
  });
  return settling;
}

/** For tests: forget what this server read. */
export function forget(): void {
  held = null;
  settling = null;
  tallies.clear();
}

