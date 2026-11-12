import { createHash } from 'node:crypto';
import {
  accountExists,
  base58,
  MAINNET_RPCS,
  minimumUsd,
  nearCatalogOf,
  OneClick,
  OneClickError,
  tooSmall,
  type AppFee,
  type NearCatalog,
  type NearCoin,
  type NearQuoteView,
  type StatusResponse,
} from '@maskwars/pay';
import type { FakePay } from '@maskwars/pay/fake';
import { NETWORKS } from '@maskwars/network';
import { isFixture, NO_STORE, oneClick, PAY_USD_MAX } from './pay';

// Get NEAR (/near): the server side. Any coin on any network 1Click reaches, swapped to native NEAR and sent to a NEAR
// account. Prices (dry quotes) are always open; a real deposit address only with GET_NEAR_LIVE=1, the owner's switch.
// With PAY_FIXTURE=1 (local runs and screenshots, never production) 1Click is simulated in memory from its whole
// recorded token list, so the walk from a coin to NEAR landing needs no money. Account lookups always read NEAR mainnet:
// they cost nothing and move nothing.

/** Real deposit addresses: on with GET_NEAR_LIVE=1. */
export const nearLive = isFixture || process.env.GET_NEAR_LIVE === '1';

/** The most one swap may bring, in dollars: the same season limit as a vault top-up (limits.pay_usd_max). */
export const NEAR_USD_MAX = PAY_USD_MAX;

const config = NETWORKS.mainnet.get_near;

/** MASK WARS's own fee inside the price (packages/network/mainnet.json `get_near`), or none. */
export const NEAR_FEE: AppFee | null = config && config.fee_bps > 0 ? { recipient: config.fee_to, fee: config.fee_bps } : null;

/** Who a shared preview is priced for: the team's account, so a preview names nobody's. */
export const PREVIEW_ACCOUNT = config?.fee_to ?? NETWORKS.mainnet.admin;

// ---- 1Click, or its stand-in ----

const globals = globalThis as unknown as { __maskwarsNearFake?: Promise<FakePay> };
function fake(): Promise<FakePay> {
  globals.__maskwarsNearFake ??= Promise.all([import('@maskwars/pay/fake'), import('@maskwars/pay/fixtures/tokens.json')]).then(([m, f]) =>
    m.fakePay({ tokens: f.default.tokens, stepMs: Number(process.env.PAY_FIXTURE_STEP_MS) || 4000 }),
  );
  return globals.__maskwarsNearFake;
}

/**
 * A transaction hash for a simulated payout, shaped like one of the network it lands on and fixed by the deposit address:
 * base58 of 32 bytes on NEAR, 0x and 64 hex digits on an EVM network, base58 of 64 bytes on Solana, 64 hex digits on
 * Tron and Bitcoin.
 */
function fakeTx(address: string, chain = 'near'): string {
  const h = (salt: string) => createHash('sha256').update(`${salt}:${address}`).digest();
  if (chain === 'near') return base58(h('near-payout'));
  if (chain === 'sol') return base58(Buffer.concat([h('sol-payout-1'), h('sol-payout-2')]));
  const hex = h(`${chain}-payout`).toString('hex');
  return chain === 'tron' || chain === 'btc' ? hex : `0x${hex}`;
}

/**
 * How a simulated swap to a NEAR account goes, the way 1Click reports it: SUCCESS names the NEAR transaction without an
 * explorer link, as 1Click does for NEAR. PAY_FIXTURE_END=refunded|failed ends every swap that way instead;
 * PAY_FIXTURE_END=short has 98% of the amount arrive (an exchange that took its fee out of it) and waits for the rest
 * until the quote's deadline, then refunds what came; =short-unknown is the same without saying how much came, as 1Click
 * may. So each way it can go can be walked on a laptop.
 */
export function settleFixture(s: StatusResponse, address: string, end = process.env.PAY_FIXTURE_END, now = Date.now(), chain = 'near'): StatusResponse {
  const req = s.quoteResponse?.quoteRequest;
  if (req?.recipientType !== 'DESTINATION_CHAIN') return s;
  // What did not happen leaves the answer, as 1Click leaves it out: no amount out, no payout transaction.
  const { amountOut: _out, amountOutFormatted: _outText, destinationChainTxHashes: _paid, ...d } = s.swapDetails;
  const amountIn = s.quoteResponse.quote.amountIn;
  if ((end === 'short' || end === 'short-unknown') && s.status !== 'PENDING_DEPOSIT') {
    const deposited = ((BigInt(amountIn) * 98n) / 100n).toString();
    if (Date.parse(req.deadline) > now) {
      if (end === 'short-unknown') {
        const { depositedAmount: _a, depositedAmountFormatted: _b, amountIn: _c, ...unknown } = d;
        return { ...s, status: 'INCOMPLETE_DEPOSIT', swapDetails: unknown };
      }
      return { ...s, status: 'INCOMPLETE_DEPOSIT', swapDetails: { ...d, depositedAmount: deposited } };
    }
    return { ...s, status: 'REFUNDED', swapDetails: { ...d, depositedAmount: deposited, refundedAmount: deposited, refundReason: 'Deposit is below the minimum' } };
  }
  if (s.status !== 'SUCCESS') return s;
  if (end === 'refunded') {
    return { ...s, status: 'REFUNDED', swapDetails: { ...d, depositedAmount: amountIn, refundedAmount: amountIn, refundReason: 'Price moved beyond slippage' } };
  }
  if (end === 'failed') return { ...s, status: 'FAILED', swapDetails: d };
  const hash = fakeTx(address, chain);
  return { ...s, swapDetails: { ...s.swapDetails, nearTxHashes: chain === 'near' ? [hash] : [], destinationChainTxHashes: [{ hash, explorerUrl: '' }] } };
}

/**
 * PAY_FIXTURE=1 only: 1Click and NEAR's RPC in memory. A payout lands on the network of the coin that goes out, so a
 * swap to Arbitrum ends with an Arbitrum-shaped transaction.
 */
export const fixtureFetch: typeof fetch = async (input, init) => {
  const res = await (await fake()).fetch(input, init);
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.pathname !== '/v0/status' || !res.ok) return res;
  const address = url.searchParams.get('depositAddress') ?? '';
  const status = (await res.json()) as StatusResponse;
  const tokens = (await import('@maskwars/pay/fixtures/tokens.json')).default.tokens;
  const chain = tokens.find((t) => t.assetId === status.quoteResponse?.quoteRequest?.destinationAsset)?.blockchain ?? 'near';
  return Response.json(settleFixture(status, address, process.env.PAY_FIXTURE_END, Date.now(), chain));
};

/** The 1Click client of /near: the site's own (its partner key) in production, the stand-in with PAY_FIXTURE=1. */
export const nearClient: OneClick = isFixture ? new OneClick({ fetch: fixtureFetch }) : oneClick;

let cached: { at: number; catalog: NearCatalog } | null = null;

/** Every network and coin on offer, from 1Click's live token list, kept for a minute. */
export async function nearCatalog(): Promise<NearCatalog> {
  if (cached && Date.now() - cached.at < 60_000) return cached.catalog;
  const c = nearCatalogOf(await nearClient.tokens());
  if (!c) throw new Error('1Click does not list NEAR');
  cached = { at: Date.now(), catalog: c };
  return c;
}

// ---- Accounts ----

const rpcs = process.env.PAY_RPC?.split(',').map((s) => s.trim()).filter(Boolean);
const seen = new Map<string, { at: number; exists: boolean }>();

/** Whether a NEAR mainnet account exists: a minute for one that does (accounts stay), ten seconds for one that does not. */
export async function nearAccountExists(id: string, now = Date.now()): Promise<boolean> {
  const hit = seen.get(id);
  if (hit && now - hit.at < (hit.exists ? 60_000 : 10_000)) return hit.exists;
  const exists = await accountExists(id, { rpcs: rpcs?.length ? rpcs : [...new Set([...NETWORKS.mainnet.rpc, ...MAINNET_RPCS])] });
  if (seen.size >= 2_000) seen.delete(seen.keys().next().value as string);
  seen.set(id, { at: now, exists });
  return exists;
}

// ---- Shared previews ----

const PREVIEW_MS = 10_000;
const previews = new Map<string, { at: number; view: NearQuoteView }>();

export function nearPreview(key: string, now = Date.now()): NearQuoteView | null {
  const hit = previews.get(key);
  if (hit && now - hit.at < PREVIEW_MS) return hit.view;
  if (hit) previews.delete(key);
  return null;
}

export function keepNearPreview(key: string, view: NearQuoteView, now = Date.now()): void {
  if (previews.size >= 500) {
    for (const [k, v] of previews) if (now - v.at >= PREVIEW_MS) previews.delete(k);
    if (previews.size >= 500) previews.delete(previews.keys().next().value as string);
  }
  previews.set(key, { at: now, view });
}

// ---- Answers ----

/** What /near shows for a failure: a short code, never a raw message from upstream. */
export type NearProblem = 'small' | 'route' | 'closed' | 'busy' | 'bad' | 'account';

export function nearProblem(code: NearProblem, status: number, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error: code, ...extra }, { status, headers: NO_STORE });
}

/**
 * 1Click's refusal in the page's words: too small (with the least the route takes, in dollars, when 1Click names it),
 * no route right now (a network paused, no liquidity), or busy.
 */
export function nearUpstream(error: unknown, coin: NearCoin | null): Response {
  if (error instanceof OneClickError) {
    const min = coin ? minimumUsd(error.message, coin) : null;
    if (error.status === 400 && (tooSmall(error.message) || min !== null)) return nearProblem('small', 422, min !== null ? { min } : {});
    if (error.status === 400) return nearProblem('route', 422);
    if (error.status === 404) return nearProblem('bad', 404);
  }
  return nearProblem('busy', 503);
}
