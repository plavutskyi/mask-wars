import { depositUnits, usdOf } from "./amount.ts";
import { NEAR_ASSET } from "./catalog.ts";
import { MAINNET_RPCS } from "./ledger.ts";
import { listedTokens, networkName, networkRank, type Listed } from "./listed.ts";
import type { QuoteRequest, QuoteResponse, StatusResponse, Token } from "./oneclick.ts";
import { checkQuote, quoteView, REFERRAL, SLIPPAGE_BPS, type QuoteCheck, type QuoteView } from "./quote.ts";
import { progressOf, type Progress, type Stage } from "./status.ts";

/**
 * Get NEAR: any coin 1Click takes, on any network it reaches, swapped to NEAR and sent straight to a NEAR account.
 *
 * What arrives is native NEAR. 1Click pays `nep141:wrap.near` out to a NEAR account with a `native_withdraw` intent, which
 * unwraps it on the way (read on chain 2026-11-11: swap aa39ab52… paid azimimahdi57.tg in NEAR, tx HYZ4ycqX…). Nothing
 * has to be unwrapped afterwards, and a 64-character implicit account that does not exist yet is created by the
 * transfer itself.
 *
 * If the swap cannot go through, the coin goes to the receiving NEAR account inside NEAR Intents (`refundType: INTENTS`):
 * no refund address to type, and nothing is sent back to an exchange's deposit address that might not credit it. The
 * page therefore asks for the person's own wallet, never an exchange's deposit address: whoever holds the receiving
 * account holds a refund too.
 */

/** Networks this page does not take money from: NEAR is where it goes. */
const LEFT_OUT = new Set(["near"]);

/** Networks where a deposit carries a memo next to the address (1Click: `depositMode: MEMO`). */
const MEMO = new Set(["stellar"]);

/** Networks that confirm slowly: a deposit address waits two hours for them, one hour for the rest. */
const SLOW = new Set(["btc", "ltc", "doge", "bch", "zec", "dash"]);

/** A 1Click network by the name people know it by (packages/pay/src/listed.ts names them, with their explorers). */
export const chainName = networkName;
/** Where a network stands in a list: NEAR, then where money usually sits. */
export const chainRank = networkRank;
/** How long a deposit address on `id` waits for the transfer, in minutes. */
export const chainWindow = (id: string): number => (SLOW.has(id) ? 120 : 60);
/** Whether a deposit on `id` carries a memo next to the address. */
export const chainMemo = (id: string): boolean => MEMO.has(id);

/** A coin a person can send to get NEAR. */
export interface NearCoin {
  readonly assetId: string;
  /** As people and exchanges know it (listed.ts): `USDT` for Tether's token on Arbitrum, which 1Click calls USDT0. */
  readonly symbol: string;
  readonly decimals: number;
  /** Dollars a coin, from 1Click: for showing only. */
  readonly price: number;
  /** The token's contract on its network, as 1Click lists it; none for the network's own coin. */
  readonly contract: string | null;
  // For showing only, from listed.ts. Optional: a swap a browser remembers from before them has none.
  /** In full: `Tether USD`. */
  readonly name?: string;
  /** A quiet second line: `Tether · USD₮0`. */
  readonly note?: string;
  /** File in /coins/: the coin's logo. */
  readonly logo?: string;
  /** Shown as its network's own coin: no contract to open. */
  readonly native?: boolean;
  /** More words a search finds it by. */
  readonly aka?: readonly string[];
}

/** A listed coin as the pages get it: 1Click's units and price, our symbol, name and logo. */
export function listedCoin(listed: Listed, token: Token): NearCoin {
  return {
    assetId: token.assetId,
    symbol: listed.symbol,
    decimals: token.decimals,
    price: token.price,
    contract: token.contractAddress ?? null,
    name: listed.name,
    ...(listed.note ? { note: listed.note } : {}),
    logo: listed.logo,
    native: listed.native === true || listed.contract === null,
    ...(listed.aka?.length ? { aka: listed.aka } : {}),
  };
}

export interface NearChain {
  readonly id: string;
  readonly name: string;
  /** How long a deposit address waits for the transfer, in minutes. */
  readonly window: number;
  /** A deposit needs the memo shown next to the address. */
  readonly memo: boolean;
  readonly coins: readonly NearCoin[];
}

export interface NearCatalog {
  /** NEAR itself, as 1Click prices it. */
  readonly near: { readonly assetId: string; readonly decimals: number; readonly price: number };
  readonly chains: readonly NearChain[];
}

/**
 * The networks and coins NEAR can come from: only what listed.ts lists, and of that only what 1Click quotes today at a
 * plausible price (listedTokens). In the list's order: networks as people look for them, and on each network
 * stablecoins first, then its own coin. `null` when 1Click does not list NEAR itself.
 */
export function nearCatalogOf(tokens: readonly Token[]): NearCatalog | null {
  const near = tokens.find((t) => t.assetId === NEAR_ASSET && t.blockchain === "near");
  if (!near || !(near.price > 0)) return null;
  const byChain = new Map<string, NearCoin[]>();
  for (const { listed, token } of listedTokens(tokens)) {
    if (LEFT_OUT.has(listed.chain)) continue;
    const list = byChain.get(listed.chain) ?? byChain.set(listed.chain, []).get(listed.chain)!;
    list.push(listedCoin(listed, token));
  }
  const chains: NearChain[] = [...byChain].map(([id, coins]) => ({ id, name: chainName(id), window: chainWindow(id), memo: MEMO.has(id), coins }));
  chains.sort((a, b) => chainRank(a.id) - chainRank(b.id));
  return { near: { assetId: near.assetId, decimals: near.decimals, price: near.price }, chains };
}

export function nearCoinOf(c: NearCatalog, assetId: string): { chain: NearChain; coin: NearCoin } | null {
  for (const chain of c.chains) {
    const coin = chain.coins.find((x) => x.assetId === assetId);
    if (coin) return { chain, coin };
  }
  return null;
}

/** The units of `coin` that `usd` dollars are, as a number a person can type into a wallet or an exchange. */
export function nearDepositUnits(usd: number, coin: NearCoin): bigint {
  return depositUnits(usd, coin);
}

// ---- Who receives ----

/** A NEAR mainnet account NEAR can be sent to: a name (`maskfan.near`, `alice.tg`) or a 64-character implicit address. */
export type NearAccountKind = "named" | "implicit";

export type NearAccountRead =
  | { readonly ok: true; readonly id: string; readonly kind: NearAccountKind }
  | { readonly ok: false; readonly why: "empty" | "eth" | "testnet" | "bad" };

const NAMED = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/**
 * What a person typed as the receiver, read as a NEAR mainnet account. An `0x…` address is refused on purpose: on NEAR it
 * is an account only an Ethereum key opens, and a vault address pasted there would put the NEAR where nobody can spend it.
 */
export function readNearAccount(text: string): NearAccountRead {
  const id = text.trim().toLowerCase();
  if (!id) return { ok: false, why: "empty" };
  if (/^0x[0-9a-f]*$/.test(id)) return { ok: false, why: "eth" };
  if (id.endsWith(".testnet")) return { ok: false, why: "testnet" };
  if (/^[0-9a-f]{64}$/.test(id)) return { ok: true, id, kind: "implicit" };
  if (id.length < 2 || id.length > 64 || !NAMED.test(id)) return { ok: false, why: "bad" };
  return { ok: true, id, kind: "named" };
}

export interface AccountLookup {
  readonly rpcs?: readonly string[];
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * Whether `id` is an account on NEAR mainnet now (`view_account` at the final block). A name must exist to receive
 * NEAR; an implicit account need not. Throws when no RPC answers, so a busy node never reads as "no such account".
 */
export async function accountExists(id: string, o: AccountLookup = {}): Promise<boolean> {
  const rpcs = o.rpcs?.length ? o.rpcs : MAINNET_RPCS;
  const doFetch = o.fetch ?? ((input, init) => fetch(input, init));
  const body = JSON.stringify({ jsonrpc: "2.0", id: "maskwars", method: "query", params: { request_type: "view_account", finality: "final", account_id: id } });
  let last: unknown = null;
  for (const rpc of rpcs) {
    try {
      const res = await doFetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(o.timeoutMs ?? 6_000) });
      if (!res.ok) throw new Error(`${rpc} answered ${res.status}`);
      const json = (await res.json()) as { result?: { amount?: unknown }; error?: { cause?: { name?: string }; data?: unknown } };
      if (json.result && typeof json.result.amount === "string") return true;
      const cause = json.error?.cause?.name ?? "";
      if (cause === "UNKNOWN_ACCOUNT" || /does not exist/.test(String(json.error?.data ?? ""))) return false;
      throw new Error(cause || "unexpected answer");
    } catch (error) {
      last = error;
    }
  }
  throw last instanceof Error ? last : new Error("no RPC answered");
}

// ---- The quote ----

/** A fee taken inside the price, in basis points of what is sent. */
export interface AppFee {
  readonly recipient: string;
  readonly fee: number;
}

/** 1Click's quote request with the two fields this page uses beyond the vault's. */
export type NearQuoteRequest = QuoteRequest & {
  readonly depositMode?: "SIMPLE" | "MEMO";
  readonly appFees?: readonly AppFee[];
};

/**
 * Get NEAR for `recipient`: the person sends `amount` units of `from` on `chain` to the deposit address, 1Click swaps it
 * and pays NEAR out to `recipient` on NEAR. FLEX_INPUT, so a transfer an exchange shaves a little (up to 1%) still goes
 * through. Refunds wait for the same account inside NEAR Intents. `fee`: MASK WARS's own share, from packages/network.
 */
export function nearRequest(o: {
  recipient: string;
  chain: NearChain;
  from: NearCoin;
  amount: bigint;
  dry: boolean;
  fee?: AppFee | null;
  now?: Date;
}): NearQuoteRequest {
  if (o.amount <= 0n) throw new Error("amount must be positive");
  if (!o.chain.coins.some((c) => c.assetId === o.from.assetId)) throw new Error(`${o.from.assetId} is not on ${o.chain.id}`);
  const to = readNearAccount(o.recipient);
  if (!to.ok) throw new Error(`not a NEAR account: ${o.recipient}`);
  const now = o.now ?? new Date();
  return {
    dry: o.dry,
    swapType: "FLEX_INPUT",
    slippageTolerance: SLIPPAGE_BPS,
    originAsset: o.from.assetId,
    depositType: "ORIGIN_CHAIN",
    ...(o.chain.memo ? { depositMode: "MEMO" as const } : {}),
    destinationAsset: NEAR_ASSET,
    amount: o.amount.toString(),
    refundTo: to.id,
    refundType: "INTENTS",
    recipient: to.id,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(now.getTime() + o.chain.window * 60_000).toISOString(),
    referral: REFERRAL,
    quoteWaitingTimeMs: o.dry ? 0 : 3000,
    ...(o.fee && o.fee.fee > 0 ? { appFees: [{ recipient: o.fee.recipient, fee: o.fee.fee }] } : {}),
  };
}

/** A quote as the page gets it, with the fees inside its price as 1Click states them (ours and its own). */
export interface NearQuoteView extends QuoteView {
  readonly fees: readonly AppFee[];
}

export function nearQuoteView(q: QuoteResponse): NearQuoteView {
  const raw = (q.quoteRequest as { appFees?: unknown }).appFees;
  const fees = Array.isArray(raw)
    ? raw.filter((f): f is AppFee => !!f && typeof f.recipient === "string" && Number.isInteger(f.fee) && f.fee >= 0 && f.fee <= 10_000).map((f) => ({ recipient: f.recipient, fee: f.fee }))
    : [];
  return { ...quoteView(q), fees };
}

/** A preview shared by everyone pricing the same coin and amount: the prices and fees, nobody's account or address. */
export function nearPreviewView(v: NearQuoteView): NearQuoteView {
  return { ...v, recipient: null, refundTo: null, depositAddress: null, depositMemo: null };
}

/** Everything inside the price, in basis points. */
export const feeBps = (v: Pick<NearQuoteView, "fees">) => v.fees.reduce((n, f) => n + f.fee, 0);

/**
 * Reads a quote back before its deposit address is shown: this coin in, NEAR out on NEAR itself to this account, a
 * refund to the same account in NEAR Intents, a promised minimum within 1% of the price and no lower than the preview
 * slid by more than the price may move.
 */
export function checkNearQuote(v: QuoteView, o: { recipient: string; from: string; seen?: string | null }): QuoteCheck {
  return checkQuote(v, { account: o.recipient, from: o.from, to: NEAR_ASSET, recipient: o.recipient, recipientType: "DESTINATION_CHAIN", seen: o.seen ?? null });
}

/**
 * The least a route takes, in dollars, from 1Click's refusal: `$100` as it words a temporary limit, or units of the coin
 * (`try at least 6559325`) priced at `coin`. `null` when the refusal names none.
 */
export function minimumUsd(message: string, coin: Pick<NearCoin, "decimals" | "price">): number | null {
  const usd = /\$\s?(\d[\d,]*(?:\.\d+)?)/.exec(message);
  if (usd) return Number(usd[1]!.replace(/,/g, ""));
  const units = /at least\s+(\d{1,40})\b/i.exec(message);
  if (units && coin.price > 0) return Math.ceil(usdOf(BigInt(units[1]!), coin.decimals, coin.price) * 100) / 100;
  return null;
}

// ---- Where it is ----

/**
 * A stage a Get NEAR swap does not leave. Unlike a vault top-up, a short deposit (`INCOMPLETE_DEPOSIT`) is not the end
 * here: the deposit address keeps taking the rest until the quote's deadline (an exchange that took its fee out of the
 * amount is the usual cause), and 1Click refunds only after it. The page keeps the address, the clock and the polling.
 */
export function nearFinal(stage: Stage): boolean {
  return stage === "done" || stage === "refunded" || stage === "failed";
}

/** A Get NEAR swap as the page follows it: 1Click's progress, and the NEAR transaction that paid the account out. */
export interface NearProgress extends Progress {
  /** The hash of the NEAR transaction that sent the NEAR, once it is done. NEAR's explorer opens it. */
  readonly landedTx: string | null;
}

export function nearProgressOf(r: StatusResponse): NearProgress {
  const p = progressOf(r);
  const d = r.swapDetails ?? {};
  const hash = p.stage === "done" ? (d.destinationChainTxHashes?.find((t) => t?.hash)?.hash ?? d.nearTxHashes?.at(-1) ?? null) : null;
  return { ...p, landedTx: hash && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(hash) ? hash : null };
}
