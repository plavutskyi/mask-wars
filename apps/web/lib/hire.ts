import { del, get, list, put } from '@vercel/blob';
import { MAINNET_RPCS, sha256Hex, type QuoteView, type SwapStatus } from '@maskwars/pay';
import { feeOf, originOk, readProof, type HireJob, type VaultProof } from '@maskwars/hire';
import { NETWORKS } from '@maskwars/network';
import { createLimiter, type Limiter } from './limit';
import { isFixture, ledger, NO_STORE, oneClick, origins, reply } from './pay';

// The server side of the hire checkout. Money moves through /api/pay's 1Click client and the same partner key, which
// never leaves this server. What this file adds: its own switch (HIRE_LIVE, apart from the vault's PAY_LIVE), the
// proof that a payer holds the vault an address pays into, a budget per page that frames the checkout, and the job's
// note: one record per deposit address, written once, gone again if nothing was paid by the time the address closes.

/** Real deposit addresses for hires: on with HIRE_LIVE=1, the owner's switch, independent of PAY_LIVE for /wallet. */
export const hireLive = isFixture || process.env.HIRE_LIVE === '1';

/** The most one hire may pay, in dollars: limits.hire_usd_max of packages/network/mainnet.json. */
export const HIRE_USD_MAX = NETWORKS.mainnet.limits.hire_usd_max ?? 9_999;

/** The site's cut through 1Click's appFees: HIRE_FEE_BPS (1–300) to HIRE_FEE_ACCOUNT, none by default. */
export const hireFee = feeOf(process.env.HIRE_FEE_BPS, process.env.HIRE_FEE_ACCOUNT);

/** The passkey's domain, and the NEP-413 recipient a NEAR wallet signs for: maskwars.xyz. */
export const rpId = () => process.env.PASSKEY_RP_ID || 'maskwars.xyz';

/**
 * The page that framed the checkout, as the browser told the checkout (`ancestorOrigins`, else the referrer the
 * element sends): `x-hire-page`. `null` when it would not say. Only for budgets and for checking a proof names the
 * same page: nothing here trusts it further.
 */
export function pageOf(req: Request): string | null {
  const v = req.headers.get('x-hire-page');
  return v && v.length <= 200 ? originOk(v) : null;
}

/**
 * What one page that frames the checkout may spend an hour, and what all of them together may: 1Click previews,
 * proofs (each may ask the chain about a key) and deposit addresses. Kept in this instance's memory; the Vercel
 * Firewall rule on /api/hire/* holds the same line across instances by IP. Deposit addresses are also counted across
 * instances in the ticket store (`keepTicket`).
 */
export const BUDGET = {
  preview: { page: 600, all: 6_000 },
  proof: { page: 120, all: 2_000 },
  address: { page: 60, all: 600 },
} as const;
export type Spend = keyof typeof BUDGET;

const HOUR = 3_600_000;
const budgets = new Map<string, Limiter>();
const limiter = (key: string, per: number) => {
  let l = budgets.get(key);
  if (!l) budgets.set(key, (l = createLimiter({ perWindow: per, windowMs: HOUR, maxKeys: 5_000 })));
  return l;
};

/** `null` when `page` may spend one more `kind`; a 429 otherwise. The page's own budget is taken first. */
export function overBudget(kind: Spend, page: string | null, now = Date.now()): Response | null {
  const b = BUDGET[kind];
  const wait = limiter(`${kind}:page`, b.page).take(page ?? 'unknown', now) ?? limiter(`${kind}:all`, b.all).take('all', now);
  if (wait === null) return null;
  return Response.json({ error: 'busy' }, { status: 429, headers: { ...NO_STORE, 'retry-after': String(wait) } });
}

/** For tests: a fresh hour. */
export const resetBudgets = () => budgets.clear();

const rpcs = process.env.PAY_RPC?.split(',').map((s) => s.trim()).filter(Boolean);
const RPCS = rpcs?.length ? rpcs : [...MAINNET_RPCS];
const keys = new Map<string, { at: number; ok: boolean }>();

/**
 * Whether `publicKey` can act for the named NEAR `account`: a full-access key on the account itself (what a NEAR
 * wallet signs with), or a key NEAR Intents already lets sign for the account's vault. Asked of two public RPCs,
 * kept five minutes. `null` when the chain could not be reached: no proof is taken on a guess.
 */
export async function keyHolds(
  account: string,
  publicKey: string,
  f: typeof fetch = fetch,
  intents = (a: string, k: string) => ledger.hasKey(a, k),
): Promise<boolean | null> {
  if (isFixture && f === fetch) return true;
  const id = `${account}|${publicKey}`;
  const hit = keys.get(id);
  if (hit && Date.now() - hit.at < 300_000) return hit.ok;
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 'maskwars',
    method: 'query',
    params: { request_type: 'view_access_key', finality: 'final', account_id: account, public_key: publicKey },
  });
  let full: boolean | null = null;
  for (const rpc of RPCS) {
    try {
      const res = await f(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(6_000) });
      if (!res.ok) continue;
      const json = (await res.json()) as { result?: { permission?: unknown }; error?: { cause?: { name?: string } } };
      if (json.result && 'permission' in json.result) full = json.result.permission === 'FullAccess';
      else if (json.error?.cause?.name === 'UNKNOWN_ACCESS_KEY' || json.error?.cause?.name === 'UNKNOWN_ACCOUNT') full = false;
      if (full !== null) break;
    } catch {
      /* the next RPC */
    }
  }
  let ok = full;
  if (ok !== true) {
    try {
      ok = (await intents(account, publicKey)) || (full === false ? false : null);
    } catch {
      /* NEAR Intents could not be asked: what the account said stands, unless it said nothing */
    }
  }
  if (ok === null) return null;
  if (keys.size >= 2_000) keys.clear();
  keys.set(id, { at: Date.now(), ok });
  return ok;
}

export type Proven = { readonly vault: string } | { readonly error: 'proof' | 'vault' | 'busy' };

/**
 * Reads a payer's proof against the job (its text and contract) and the page that framed the checkout: signed for this
 * site, by the key of the vault it names, within the half hour. `team`: the vault the page named; any other is
 * refused (`vault`), so a page can name a vault only its own payer holds.
 */
export async function proven(
  proof: unknown,
  o: { text: string; target: string; team: string | null; page: string | null; req: Request },
  f: typeof fetch = fetch,
): Promise<Proven> {
  if (!proof || typeof proof !== 'object') return { error: 'proof' };
  const r = readProof(proof as VaultProof, { text: o.text, target: o.target, page: o.page, recipient: rpId(), rpId: rpId(), origins: origins(o.req) });
  if (!r.ok) return { error: 'proof' };
  if (o.team && r.vault !== o.team) return { error: 'vault' };
  if (r.onChain) {
    const holds = await keyHolds(r.onChain.account, r.onChain.publicKey, f);
    if (holds === null) return { error: 'busy' };
    if (!holds) return { error: 'proof' };
  }
  return { vault: r.vault };
}

// ---- The store: tickets, and proofs on their way back to a checkout ----

const useBlob = !isFixture && Boolean(process.env.BLOB_READ_WRITE_TOKEN);
/** In production a record kept only in one instance's memory would be lost on its next cold start: there it is the store or nothing. */
const memoryOk = () => isFixture || process.env.VERCEL_ENV !== 'production';
const memory = new Map<string, { at: number; body: string }>();

/** For tests and local runs: what is kept in memory, by path. */
export const memoryStore: ReadonlyMap<string, { at: number; body: string }> = memory;

async function save(path: string, value: unknown): Promise<boolean> {
  if (!useBlob) {
    if (!memoryOk() || memory.has(path)) return false;
    memory.set(path, { at: Date.now(), body: JSON.stringify(value) });
    return true;
  }
  try {
    // Written once: a second write to the same path fails.
    await put(path, JSON.stringify(value), { access: 'private', contentType: 'application/json', addRandomSuffix: false });
    return true;
  } catch {
    return false;
  }
}

async function load<T>(path: string): Promise<T | null> {
  if (!useBlob) {
    const hit = memory.get(path);
    return hit ? (JSON.parse(hit.body) as T) : null;
  }
  try {
    const found = await get(path, { access: 'private', useCache: false });
    if (!found || found.statusCode !== 200) return null;
    return JSON.parse(await new Response(found.stream).text()) as T;
  } catch {
    return null;
  }
}

async function drop(path: string): Promise<void> {
  if (!useBlob) return void memory.delete(path);
  await del(path).catch(() => {});
}

/** Paths under `prefix`, with when each was written: at most 1,000, which the limits below keep it under. */
async function paths(prefix: string): Promise<{ path: string; at: number }[] | null> {
  if (!useBlob) {
    if (!memoryOk()) return null;
    return [...memory].filter(([p]) => p.startsWith(prefix)).map(([path, v]) => ({ path, at: v.at }));
  }
  try {
    const { blobs } = await list({ prefix, limit: 1000 });
    return blobs.map((b) => ({ path: b.pathname, at: new Date(b.uploadedAt).getTime() }));
  } catch {
    return null;
  }
}

/** What is kept for a job: the job itself, its mark, the page that asked, and the deposit its money comes through. */
export interface Ticket {
  readonly job: HireJob;
  readonly network: 'mainnet' | 'testnet';
  readonly usd: number;
  readonly page: string | null;
  readonly proof: 'passkey' | 'near';
  readonly from: { readonly chain: string; readonly symbol: string; readonly assetId: string };
  readonly quote: Pick<QuoteView, 'correlationId' | 'depositAddress' | 'depositMemo' | 'amountIn' | 'minAmountOut' | 'amountOut' | 'deadline' | 'closes'>;
  readonly at: string;
}

const OPEN = 'hire/open/';
const FUNDED = 'hire/funded/';
const RELAY = 'hire/relay/';

/** One name per deposit address (and memo): the ticket's key. */
export const depositKey = (address: string, memo: string | null) => sha256Hex(`${address}|${memo ?? ''}`).slice(0, 32);
const pageKey = (page: string | null) => sha256Hex(page ?? 'unknown').slice(0, 8);

/** `hire/open/<deposit>.<closes ms>.<page>.json`: found by its deposit, swept by its time, counted by its page. */
function openPath(t: Ticket): string {
  return `${OPEN}${depositKey(t.quote.depositAddress!, t.quote.depositMemo)}.${Date.parse(t.quote.closes)}.${pageKey(t.page)}.json`;
}
const parseOpen = (path: string) => {
  const m = /^hire\/open\/([0-9a-f]{32})\.(\d{10,16})\.([0-9a-f]{8})\.json$/.exec(path);
  return m ? { deposit: m[1]!, closes: Number(m[2]), page: m[3]! } : null;
};

/**
 * Keeps a job's ticket before its address goes out, once per deposit address. Across every instance, in the store:
 * at most `BUDGET.address.all` open tickets made in the last hour, and `BUDGET.address.page` for one page. `full`
 * when a limit is reached, `down` when it could not be kept: either way no address goes out.
 */
export async function keepTicket(t: Ticket, now = Date.now()): Promise<'kept' | 'full' | 'down'> {
  if (!t.quote.depositAddress) return 'down';
  const open = await paths(OPEN);
  if (!open) return 'down';
  const key = depositKey(t.quote.depositAddress, t.quote.depositMemo);
  const recent = open
    .filter((p) => now - p.at < HOUR)
    .map((p) => parseOpen(p.path))
    .filter((p) => p !== null);
  if (open.some((p) => parseOpen(p.path)?.deposit === key)) return 'down';
  if (recent.length >= BUDGET.address.all || recent.filter((p) => p.page === pageKey(t.page)).length >= BUDGET.address.page) return 'full';
  return (await save(openPath(t), t)) ? 'kept' : 'down';
}

/** For tests and local runs: the open ticket for a deposit address. */
export async function openTicket(address: string, memo: string | null): Promise<Ticket | null> {
  const key = depositKey(address, memo);
  const hit = (await paths(OPEN))?.find((p) => parseOpen(p.path)?.deposit === key);
  return hit ? load<Ticket>(hit.path) : null;
}

/** An address that closed with nothing on its way is done: 1Click says so, and the ticket goes. */
const UNPAID: readonly SwapStatus[] = ['PENDING_DEPOSIT', 'INCOMPLETE_DEPOSIT', 'REFUNDED', 'FAILED'];
/** Past `closes`, how long a swap may still be finishing before its ticket is looked at. */
const GRACE_MS = 15 * 60_000;
let lastSweep = 0;

/**
 * Tidies the store, at most every ten minutes per instance and 25 tickets at a time: a ticket whose address has closed
 * moves to `hire/funded/` if its money landed, and is deleted if nothing was paid; a proof never picked up is deleted
 * after an hour. Runs after a response is sent (`after`), never in a payer's way.
 */
export async function sweep(
  o: { now?: number; force?: boolean; status?: (address: string, memo: string | null) => Promise<SwapStatus> } = {},
): Promise<{ funded: number; removed: number }> {
  const now = o.now ?? Date.now();
  const out = { funded: 0, removed: 0 };
  if (!o.force && now - lastSweep < 10 * 60_000) return out;
  lastSweep = now;
  const status = o.status ?? (async (address: string, memo: string | null) => (await oneClick.status(address, memo ?? undefined)).status);
  const due = ((await paths(OPEN)) ?? []).flatMap((p) => {
    const x = parseOpen(p.path);
    return x && x.closes + GRACE_MS < now ? [{ ...x, path: p.path }] : [];
  });
  for (const d of due.slice(0, 25)) {
    const t = await load<Ticket>(d.path);
    if (!t?.quote.depositAddress) {
      await drop(d.path);
      out.removed++;
      continue;
    }
    let s: SwapStatus;
    try {
      s = await status(t.quote.depositAddress, t.quote.depositMemo);
    } catch {
      continue;
    }
    if (s === 'SUCCESS') {
      if (await save(`${FUNDED}${d.deposit}.json`, { ...t, funded: new Date(now).toISOString() })) out.funded++;
      await drop(d.path);
    } else if (UNPAID.includes(s)) {
      await drop(d.path);
      out.removed++;
    }
  }
  for (const r of (await paths(RELAY)) ?? []) {
    if (now - r.at > HOUR) {
      await drop(r.path);
      out.removed++;
    }
  }
  return out;
}

/** For tests: the next sweep runs whenever it is asked. */
export const resetSweep = () => {
  lastSweep = 0;
};

/**
 * A proof on its way back to the checkout that opened the vault window, for a page whose policy cut the window off
 * from its opener (so `postMessage` cannot carry it). Kept under the hash of the checkout's own random relay id, which
 * only that checkout and its window know, and deleted when the checkout picks it up.
 */
export const relayPath = (relay: string) => `${RELAY}${sha256Hex(relay)}.json`;

export const keepRelay = (relay: string, value: { proof: VaultProof; vault: string }) => save(relayPath(relay), value);

export async function takeRelay(relay: string): Promise<{ proof: VaultProof; vault: string } | null> {
  const found = await load<{ proof: VaultProof; vault: string }>(relayPath(relay));
  if (found) await drop(relayPath(relay));
  return found;
}

/** A refusal the checkout words itself. */
export const refuse = (error: 'proof' | 'vault' | 'busy', status: number) => reply({ error }, status);
