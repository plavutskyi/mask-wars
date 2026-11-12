// The security encyclopedia on this server: one account's facts read through the shared arena reader and MASK CHECK,
// and its page, written by a model in a TEE on NEAR AI Cloud when the facts change. A page is written in the
// background, after the answer, and only for accounts the arena has a record of: a page view never waits for a model
// and a stranger cannot make the server write about any account they like. Written pages live in Vercel Blob next to
// their attestation; every page read back passes the whole check again before it is shown.
//
// Everything is read on the network the site reads (MASKWARS_NETWORK: mainnet on maskwars.xyz). ARENA_FIXTURE (a
// recorded answer file) replays recorded chain answers instead of the network, and turns the writing off: a local
// check never calls NEAR AI. DOSSIER_WRITTEN (with ARENA_FIXTURE only) names a folder of pages a model already wrote
// in a TEE from those recorded facts (packages/dossier/test/fixtures/written): each is shown only if it passes every
// check, its signature included.
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after } from 'next/server';
import { get, put } from '@vercel/blob';
import { type Recording, replayFetch } from '@maskwars/arena/replay';
import { NETWORK, RPCS } from '@maskwars/arena';
import { type CheckResult, ChainReader, InvalidAccountError, accountOk, isMainnetName, isTestnetName, maskCheck, readerFor, sharedLists } from '@maskwars/check';
import {
  DEFAULT_MODEL,
  type Dossier,
  MemoryStore,
  type PageStore,
  type TeeProof,
  type WrittenPage,
  collect,
  libraryEntry,
  nearAiWriter,
  pagePath,
  readWritten,
  teeProof,
  writable,
  writePage,
  writesPages,
} from '@maskwars/dossier';
import { verifyModel } from '@maskwars/mind/attestation';
import { readArena } from './arena';
import { createLimiter } from './limit';
import { TEAMS } from './show';

const fixture = process.env.ARENA_FIXTURE;
const apiKey = process.env.NEARAI_CLOUD_API_KEY || process.env.NEAR_AI_API_KEY;
/** DOSSIER_MODEL only when it is a TEE model that answers a page with no reasoning: any other never writes one. */
const model = process.env.DOSSIER_MODEL && writesPages(process.env.DOSSIER_MODEL) ? process.env.DOSSIER_MODEL : DEFAULT_MODEL;

/** The model that writes pages here, for the page to name. */
export const WRITER_MODEL = model;

let recorded: Recording | null | undefined;
function recording(): Recording | null {
  if (recorded !== undefined) return recorded;
  // Development only: the path is the developer's, so the build must not trace it.
  recorded = fixture ? (JSON.parse(readFileSync(/* turbopackIgnore: true */ resolve(/* turbopackIgnore: true */ process.cwd(), fixture), 'utf8')) as Recording) : null;
  return recorded;
}

let reader: ChainReader | null = null;
/** MASK CHECK's reader of the site's network, as /api/check reads it: on mainnet several nodes, cross-checked. */
function chain(): ChainReader {
  if (reader) return reader;
  const r = recording();
  reader = r ? new ChainReader({ endpoints: RPCS, fetch: replayFetch(r) }) : readerFor(NETWORK, { env: process.env });
  return reader;
}

// Account ids --------------------------------------------------------------------------------------------------------

export type Subject = { ok: true; account: string } | { ok: false; why: string };

/** An account on the site's network, or a training target's name. */
export function subjectOf(raw: string): Subject {
  let id: string;
  try {
    id = decodeURIComponent(raw).trim().toLowerCase();
  } catch {
    return { ok: false, why: 'not a NEAR account id' };
  }
  if (!accountOk(id)) return { ok: false, why: 'not a NEAR account id' };
  if (NETWORK === 'testnet' && isMainnetName(id)) return { ok: false, why: `${id} is a mainnet name; this arena reads testnet` };
  if (NETWORK === 'mainnet' && isTestnetName(id)) return { ok: false, why: `${id} is a testnet name; this arena reads mainnet` };
  return { ok: true, account: id };
}

// Reading ------------------------------------------------------------------------------------------------------------

interface Cached<T> {
  at: number;
  value: Promise<T>;
}

/** MASK CHECK is about ten RPC calls: one answer per account serves every view for a minute. */
const CHECK_MS = 60_000;
/** One dossier per account serves every view and API call for a few seconds. */
const DOSSIER_MS = 10_000;
const MAX_KEYS = 2_000;

const checks = new Map<string, Cached<CheckResult | null>>();
const dossiers = new Map<string, Cached<Dossier>>();
/** The last MASK CHECK that read the chain, per account: one failed read does not change the facts. */
const lastRead = new Map<string, CheckResult>();
/** New MASK CHECK reads per minute, per caller and on this server: a crawl of random accounts cannot flood the RPC nodes. */
const checkReads = createLimiter({ perWindow: 120, windowMs: 60_000 });
const checkReadsPerCaller = createLimiter({ perWindow: 20, windowMs: 60_000 });
/** Signals that say only that something could not be read now: such an answer does not replace a good one. */
const PASSING = new Set(['chain_unreadable', 'history_unavailable', 'arena_unreadable', 'arena_pending']);

function remember<T>(map: Map<string, Cached<T>>, key: string, ttl: number, make: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = map.get(key);
  if (hit && now - hit.at < ttl) return hit.value;
  if (map.size >= MAX_KEYS) {
    for (const [k, v] of map) if (now - v.at >= ttl) map.delete(k);
    if (map.size >= MAX_KEYS) map.delete(map.keys().next().value as string);
  }
  const value = make();
  map.set(key, { at: now, value });
  value.catch(() => {
    if (map.get(key)?.value === value) map.delete(key);
  });
  return value;
}

function checkOf(account: string, caller: string): Promise<CheckResult | null> {
  const fresh = checks.get(account);
  if ((!fresh || Date.now() - fresh.at >= CHECK_MS) && checkReadsPerCaller.take(caller) !== null) return Promise.resolve(lastRead.get(account) ?? null);
  return remember(checks, account, CHECK_MS, async () => {
    const before = lastRead.get(account) ?? null;
    if (checkReads.take('all') !== null) return before;
    const now = await maskCheck(account, { network: NETWORK, reader: chain(), list: sharedLists[NETWORK] }).catch((error: unknown) => {
      if (error instanceof InvalidAccountError) return null;
      throw error;
    });
    if (now?.block && !now.reasons.some((r) => PASSING.has(r.code))) {
      if (lastRead.size >= MAX_KEYS) lastRead.delete(lastRead.keys().next().value as string);
      lastRead.set(account, now);
      return now;
    }
    return before ?? now;
  });
}

/** Everything known about one account now. Never throws: a silent chain reads as `unknown`. */
export function readDossier(account: string, caller = 'unknown'): Promise<Dossier> {
  return remember(dossiers, account, DOSSIER_MS, async () => {
    const view = await readArena().catch(() => null);
    // A training target lives in the sandbox: there is no account of that name for MASK CHECK to read.
    const isTarget = !account.includes('.') && libraryEntry(account) !== null;
    const check = isTarget ? null : await checkOf(account, caller).catch(() => null);
    return collect({ account, view, check, teams: TEAMS, now: view?.readAt ?? recording()?.recordedAt ?? Date.now() });
  });
}

// Pages --------------------------------------------------------------------------------------------------------------

const memory = new MemoryStore();
const useBlob = !fixture && Boolean(process.env.BLOB_READ_WRITE_TOKEN);

/** Development only: the recorded pages, each checked whole before it is kept. */
let replayed = false;
async function replayWritten(): Promise<void> {
  if (replayed) return;
  replayed = true;
  const dir = process.env.DOSSIER_WRITTEN;
  if (!fixture || !dir) return;
  const folder = resolve(/* turbopackIgnore: true */ process.cwd(), dir);
  for (const name of readdirSync(/* turbopackIgnore: true */ folder).filter((n) => n.endsWith('.json'))) {
    const page = readWritten(JSON.parse(readFileSync(/* turbopackIgnore: true */ join(folder, name), 'utf8')));
    if (page && page.network === NETWORK) await memory.put(page);
  }
}

/** The model TEE signers this server's own attestation named, for six hours: a stored page must be signed by one. */
let attested: { at: number; signers: Set<string> } | null = null;
const ATTESTED_MS = 6 * 60 * 60_000;
/**
 * How long a view waits for this server's first attestation when a stored page is there to show: a fresh instance
 * attests in a few seconds, and the page then shows on the first view instead of disappearing until the next one.
 */
export const ATTEST_WAIT_MS = 6_000;

/** This server's attested signers, or null while it has none: then a fresh attestation starts after the answer. */
function attestedSigners(): Set<string> | null {
  if (attested && Date.now() - attested.at < ATTESTED_MS) return attested.signers;
  after(() => teeNow().catch(() => undefined));
  return null;
}

/** This server's attested signers, waiting at most `ms` for an attestation already on its way or started now. */
async function signersWithin(ms: number): Promise<Set<string> | null> {
  const now = attestedSigners();
  if (now) return now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([teeNow().catch(() => undefined), new Promise<void>((done) => (timer = setTimeout(done, ms)))]);
  clearTimeout(timer);
  return attested && Date.now() - attested.at < ATTESTED_MS ? attested.signers : null;
}

/**
 * Pages found in Blob that this server could not check yet, because its attestation is not in: the page shows a
 * verifying state and asks again shortly, rather than saying there is no page, and no second page is written for them.
 */
const unverified = new Set<string>();

const store: PageStore = {
  async get(account, hash) {
    await replayWritten();
    const near = await memory.get(account, hash);
    if (near || !useBlob) return near;
    const key = `${account}/${hash}`;
    try {
      const found = await get(pagePath(NETWORK, account, hash), { access: 'private', useCache: false });
      if (!found || found.statusCode !== 200) return null;
      // Only with this server's own fresh attestation: a stored page never vouches for its own signer.
      const signers = await signersWithin(ATTEST_WAIT_MS);
      if (!signers) {
        if (unverified.size >= MAX_KEYS) unverified.delete(unverified.values().next().value as string);
        unverified.add(key);
        return null;
      }
      unverified.delete(key);
      const page = readWritten(JSON.parse(await new Response(found.stream).text()), { account, evidenceHash: hash }, { signers });
      if (page) await memory.put(page);
      return page;
    } catch {
      return null;
    }
  },
  async put(page) {
    await memory.put(page);
    if (!useBlob) return;
    await put(pagePath(page.network, page.account, page.evidenceHash), JSON.stringify(page), {
      access: 'private',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
    }).catch(() => undefined);
  },
};

/** One attestation of the writing model serves ten minutes of pages. */
const TEE_MS = 10 * 60_000;
/** A page that could not be written is tried again after this long (still at most four writes an hour per account). */
const RETRY_MS = 5 * 60_000;
/**
 * A whole write ends inside the function's 90 seconds, attestation included. NEAR AI cuts a signed reply off at thirty
 * seconds; a page takes ten to twenty-five, so up to three replies fit, and a reply starts only with time to finish.
 */
const WRITE_MS = 75_000;
/** At most this many pages an hour per server, and per account: the model is paid per page. */
const budget = createLimiter({ perWindow: 30, windowMs: 60 * 60_000 });
const perAccount = createLimiter({ perWindow: 4, windowMs: 60 * 60_000 });

let tee: Cached<TeeProof> | null = null;
const writing = new Set<string>();
const tried = new Map<string, number>();

/** Writing is on: a NEAR AI key, real chain answers. */
export const canWrite = Boolean(apiKey) && !fixture;

function teeNow(): Promise<TeeProof> {
  const now = Date.now();
  if (!tee || now - tee.at >= TEE_MS) {
    // A key is not needed for the report; with one, the shared keyless limit does not apply.
    const value = verifyModel(model, { timeoutMs: 15_000, ...(apiKey ? { apiKey } : {}) }).then(teeProof);
    const entry = { at: now, value };
    tee = entry;
    value.then(
      (t) => {
        if (t.outcome === 'pass' && t.signers.length) attested = { at: Date.now(), signers: new Set(t.signers.map((x) => x.toLowerCase())) };
        else if (tee === entry) tee = null;
      },
      () => {
        if (tee === entry) tee = null;
      },
    );
  }
  return tee.value;
}

async function write(d: Dossier, key: string, started: number): Promise<void> {
  try {
    const proof = await teeNow();
    // A failed attestation names no signer, so nothing written now could be published: no model call at all.
    if (proof.outcome !== 'pass' || !proof.signers.length) {
      console.warn(`dossier ${d.account}: no page, the attestation of ${model} did not pass (${proof.outcome})`);
      return;
    }
    // Each write has its own writer: the bytes it keeps are its own exchange's.
    const w = await nearAiWriter({ apiKey: apiKey!, model, tee: proof });
    const out = await writePage(d, { ...w, teams: TEAMS, attempts: 3, timeoutMs: 30_000, budgetMs: WRITE_MS - (Date.now() - started) });
    if (out.status === 'published') {
      await store.put(out.page);
      tried.delete(key);
      console.info(`dossier ${d.account}: page written in a TEE, ${out.attempts} ${out.attempts === 1 ? 'reply' : 'replies'}, ${Date.now() - started} ms`);
    } else {
      // The gate's reasons and the provider's error: a reason may quote one short token of the reply, never a sentence.
      console.warn(`dossier ${d.account}: no page (${out.reason}, ${out.attempts} replies, ${Date.now() - started} ms): ${out.problems.slice(0, 3).map((p) => p.slice(0, 160)).join(' | ')}`);
    }
  } catch (error) {
    // Tried, and marked as tried before it began: the next try comes after RETRY_MS.
    console.warn(`dossier ${d.account}: no page: ${(error as Error).message}`);
  } finally {
    writing.delete(key);
  }
}

export interface PageState {
  /** The page for exactly these facts, checked again as it was read. */
  readonly page: WrittenPage | null;
  /** A model is writing the page for these facts right now. */
  readonly writing: boolean;
  /** A page for these facts is stored, and this server is still attesting the model before it shows it. */
  readonly verifying: boolean;
}

/** The written page for these facts, and the writing of it when there is none yet. */
/** `started`: when the request began, so the write ends inside the same function. */
export async function pageFor(d: Dossier, started = Date.now()): Promise<PageState> {
  const page = await store.get(d.account, d.evidenceHash);
  const key = `${d.account}/${d.evidenceHash}`;
  if (page) return { page, writing: false, verifying: false };
  if (unverified.has(key)) return { page: null, writing: false, verifying: true };
  if (!canWrite || !writable(d, { teams: TEAMS })) return { page: null, writing: false, verifying: false };
  // A server that has not attested yet cannot read what is stored: it does not pay to write it again meanwhile.
  if (useBlob && !attestedSigners()) return { page: null, writing: false, verifying: false };
  if (writing.has(key)) return { page: null, writing: true, verifying: false };
  const last = tried.get(key);
  if (last !== undefined && Date.now() - last < RETRY_MS) return { page: null, writing: false, verifying: false };
  // The server's budget first: a refusal there spends nothing of the account's own allowance.
  if (writing.size >= 2 || budget.take('pages') !== null || perAccount.take(d.account) !== null) return { page: null, writing: false, verifying: false };
  writing.add(key);
  // Marked as tried before it begins: a write the platform cuts off is not started again on every view.
  if (tried.size >= MAX_KEYS) tried.delete(tried.keys().next().value as string);
  tried.set(key, Date.now());
  after(() => write(d, key, started));
  return { page: null, writing: true, verifying: false };
}
