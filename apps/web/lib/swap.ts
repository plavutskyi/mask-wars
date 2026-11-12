import {
  addressKindOf,
  Ledger,
  MAINNET_RPCS,
  minimumUsd,
  OneClickError,
  PREVIEW_ADDRESS,
  swapCatalogOf,
  tooSmall,
  type AppFee,
  type NearCoin,
  type SwapCatalog,
  type SwapQuoteView,
} from '@maskwars/pay';
import { NETWORKS } from '@maskwars/network';
import { fixtureFetch, nearAccountExists, nearClient } from './getnear';
import { isFixture, NO_STORE } from './pay';

// Swap (/swap): the server side. Any coin on any network 1Click reaches, for any coin it lists on a network whose
// receiving address the code reads with certainty. Prices (dry quotes) are always open; a real deposit address only with
// SWAP_LIVE=1, the owner's switch, separate from GET_NEAR_LIVE and PAY_LIVE. With PAY_FIXTURE=1 (local runs and
// screenshots, never production) 1Click and NEAR's RPC are simulated in memory, so the walk from a price to the coin
// landing needs no money. Whether a NEAR account exists is always read on NEAR mainnet: it costs nothing.

/** Real deposit addresses: on with SWAP_LIVE=1. */
export const swapLive = isFixture || process.env.SWAP_LIVE === '1';

const config = NETWORKS.mainnet.swap;

/** MASK WARS's own fee inside the price (packages/network/mainnet.json `swap`), or none. */
export const SWAP_FEE: AppFee | null = config && config.fee_bps > 0 ? { recipient: config.fee_to, fee: config.fee_bps } : null;

/** The most one swap may bring, in dollars, while it is new (`swap.usd_max`). */
export const SWAP_USD_MAX = config?.usd_max ?? 100;

/** Who a shared preview to NEAR is priced for: the team's account, so a preview names nobody's. */
const PREVIEW_NEAR = config?.fee_to ?? NETWORKS.mainnet.admin;

/** The address a shared preview is priced for on the network that receives: nothing is ever sent to it. */
export function previewRecipient(chainId: string): string | null {
  const kind = addressKindOf(chainId);
  if (kind === 'near') return PREVIEW_NEAR;
  return kind ? PREVIEW_ADDRESS[kind] : null;
}

/** Where a shared preview's refund would go: the team's account inside NEAR Intents, valid whatever pays in. */
export const PREVIEW_REFUND = { to: PREVIEW_NEAR, type: 'INTENTS' as const };

let cached: { at: number; catalog: SwapCatalog } | null = null;

/** Every network and coin a swap can start from or end in, from 1Click's live token list, kept for a minute. */
export async function swapCatalog(): Promise<SwapCatalog> {
  if (cached && Date.now() - cached.at < 60_000) return cached.catalog;
  const c = swapCatalogOf(await nearClient.tokens());
  if (!c) throw new Error('1Click does not list NEAR');
  cached = { at: Date.now(), catalog: c };
  return c;
}

export { nearAccountExists };

// ---- Paying from a NEAR wallet ----

const rpcs = process.env.PAY_RPC?.split(',').map((s) => s.trim()).filter(Boolean);
const nearRpcs = rpcs?.length ? rpcs : [...new Set([...NETWORKS.mainnet.rpc, ...MAINNET_RPCS])];
const doFetch: typeof fetch = isFixture ? fixtureFetch : (input, init) => fetch(input, init);
const ledger = new Ledger({ rpcs: nearRpcs, fetch: doFetch });

/**
 * NEAR an account can spend, in yoctoNEAR, at the final block: its balance less what its storage holds (1 NEAR per
 * 100 KB), which NEAR never lets it send. 0 for an account that is not there.
 */
async function nearBalance(id: string): Promise<bigint> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 'maskwars', method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: id } });
  let last: unknown = null;
  for (const rpc of nearRpcs) {
    try {
      const res = await doFetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(6_000) });
      const json = (await res.json()) as { result?: { amount?: unknown; storage_usage?: unknown }; error?: { cause?: { name?: string } } };
      if (json.result && typeof json.result.amount === 'string' && /^\d+$/.test(json.result.amount)) {
        const held = BigInt(Number.isSafeInteger(json.result.storage_usage) ? (json.result.storage_usage as number) : 0) * STORAGE_PRICE;
        const amount = BigInt(json.result.amount);
        return amount > held ? amount - held : 0n;
      }
      if (json.error?.cause?.name === 'UNKNOWN_ACCOUNT') return 0n;
      last = json.error ?? res.status;
    } catch (error) {
      last = error;
    }
  }
  throw new Error(`no NEAR node answered: ${String(last)}`);
}

/** What NEAR keeps back per byte an account stores: 10^19 yoctoNEAR (1 NEAR per 100 KB). */
const STORAGE_PRICE = 10n ** 19n;

const yocto = (v: unknown): bigint | null => (typeof v === 'string' && /^\d{1,40}$/.test(v) ? BigInt(v) : null);

/** What a contract asks to register an account, 0 when it already knows it. */
async function storageNeeded(contract: string, account: string, min: bigint): Promise<bigint> {
  const have = await ledger.call<{ total?: string } | null>(contract, 'storage_balance_of', { account_id: account });
  return have && yocto(have.total) !== null ? 0n : min;
}

/**
 * What the person's NEAR wallet needs to pay a deposit account: what the coin's contract asks to register the deposit
 * account (and, for native NEAR, the payer on wrap.near), and what the wallet holds of the coin and of NEAR.
 */
export async function nearPayReads(o: { coin: NearCoin; deposit: string; payer: string }): Promise<{
  depositStorage: bigint;
  payerStorage: bigint;
  balance: bigint;
  near: bigint;
}> {
  const contract = o.coin.contract!;
  const bounds = await ledger.call<{ min?: string } | null>(contract, 'storage_balance_bounds', {});
  const min = yocto(bounds?.min);
  if (min === null) throw new Error(`${contract} names no storage price`);
  const native = o.coin.contract === 'wrap.near' && o.coin.assetId === 'nep141:wrap.near';
  const [depositStorage, payerStorage, near, token] = await Promise.all([
    storageNeeded(contract, o.deposit, min),
    native ? storageNeeded(contract, o.payer, min) : Promise.resolve(0n),
    nearBalance(o.payer),
    native ? Promise.resolve(null) : ledger.call<string>(contract, 'ft_balance_of', { account_id: o.payer }),
  ]);
  const balance = native ? near : yocto(token);
  if (balance === null) throw new Error(`${contract} answered no balance`);
  return { depositStorage, payerStorage, balance, near };
}

// ---- Answers ----

/** What /swap shows for a failure: a short code, never a raw message from upstream. */
export type SwapProblem = 'small' | 'route' | 'closed' | 'busy' | 'bad' | 'account' | 'refund' | 'limit';

export function swapProblem(code: SwapProblem, status: number, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error: code, ...extra }, { status, headers: NO_STORE });
}

/**
 * 1Click's refusal in the page's words: too small (with the least the route takes, in dollars, when 1Click names it),
 * an address it would not take, no route right now (a network paused, no liquidity), or busy.
 */
export function swapUpstream(error: unknown, coin: NearCoin | null): Response {
  if (error instanceof OneClickError) {
    const min = coin ? minimumUsd(error.message, coin) : null;
    if (error.status === 400 && (tooSmall(error.message) || min !== null)) return swapProblem('small', 422, min !== null ? { min } : {});
    if (error.status === 400 && /recipient/i.test(error.message)) return swapProblem('account', 422, { why: 'bad' });
    if (error.status === 400 && /refund/i.test(error.message)) return swapProblem('refund', 422, { why: 'bad' });
    if (error.status === 400) return swapProblem('route', 422);
    if (error.status === 404) return swapProblem('bad', 404);
  }
  return swapProblem('busy', 503);
}

// ---- Shared previews ----

const PREVIEW_MS = 10_000;
const previews = new Map<string, { at: number; view: SwapQuoteView }>();

/** A preview priced in the last 10 s for the same coins and amount: everyone pricing it gets the same answer. */
export function swapPreview(key: string, now = Date.now()): SwapQuoteView | null {
  const hit = previews.get(key);
  if (hit && now - hit.at < PREVIEW_MS) return hit.view;
  if (hit) previews.delete(key);
  return null;
}

export function keepSwapPreview(key: string, view: SwapQuoteView, now = Date.now()): void {
  if (previews.size >= 500) {
    for (const [k, v] of previews) if (now - v.at >= PREVIEW_MS) previews.delete(k);
    if (previews.size >= 500) previews.delete(previews.keys().next().value as string);
  }
  previews.set(key, { at: now, view });
}
