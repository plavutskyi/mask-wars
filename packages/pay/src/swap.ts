import { NEAR_ASSET } from "./catalog.ts";
import { addressOfKind, type AddressKind } from "./chains.ts";
import {
  chainMemo,
  chainName,
  chainRank,
  chainWindow,
  listedCoin,
  readNearAccount,
  type AppFee,
  type NearCoin,
  type NearQuoteRequest,
  nearQuoteView,
  type NearQuoteView,
} from "./bridge.ts";
import { EVM_CHAINS, evmChainOf } from "./evm.ts";
import { listedTokens } from "./listed.ts";
import type { DepositType, QuoteResponse, StatusResponse, Token } from "./oneclick.ts";
import { checkQuote, REFERRAL, SLIPPAGE_BPS, type QuoteCheck } from "./quote.ts";
import { solanaWalletOk } from "./solana.ts";
import type { CallAction, Transaction } from "./spend.ts";
import { progressOf, type Progress } from "./status.ts";

/**
 * Swap: any coin 1Click takes, on any network it reaches, for any coin it lists on a network whose receiving address
 * this code reads with certainty: NEAR (names and implicit accounts), the nine EVM networks a wallet here pays on,
 * Solana, Tron and Bitcoin. A coin sent to an address that is wrong for its network is lost, so a network joins the
 * "You receive" side only with a reader for its addresses and tests for it.
 *
 * Get NEAR is the same swap with native NEAR on NEAR as what arrives.
 *
 * How a person pays decides where a refund goes, and the page says which before anything is sent:
 *
 *   from a wallet in the browser  back to the paying wallet, on the network it paid from (`ORIGIN_CHAIN`)
 *   from an exchange, to NEAR     the receiving NEAR account inside NEAR Intents, when the person says it is theirs
 *   from an exchange, elsewhere   a refund address the person gives on the network they pay from; where this code
 *                                 cannot read that network's addresses, a NEAR account inside NEAR Intents instead
 *
 * A refund is never sent to an exchange's deposit address that might not credit it, and never to an account the page
 * only guesses is the person's.
 *
 * A coin on NEAR itself is paid only from the person's NEAR wallet (`ft_transfer` to the deposit account, native NEAR
 * wrapped first): an exchange sends native NEAR as a plain transfer, which a deposit account does not take as wNEAR.
 */

/** The networks a swap pays out to: those whose addresses `readSwapAddress` reads with certainty. */
export const SWAP_TO: readonly string[] = ["near", ...EVM_CHAINS.map((c) => c.id), "sol", "tron", "btc"];

/** What kind of address a network has, when this code reads it with certainty; `null` for the rest. */
export function addressKindOf(chainId: string): "near" | AddressKind | null {
  if (chainId === "near") return "near";
  if (evmChainOf(chainId)) return "evm";
  if (chainId === "sol" || chainId === "tron" || chainId === "btc") return chainId;
  return null;
}

export interface SwapChain {
  readonly id: string;
  readonly name: string;
  /** How long a deposit address waits for the transfer, in minutes. */
  readonly window: number;
  /** A deposit needs the memo shown next to the address. */
  readonly memo: boolean;
  /** Coins arrive here: its receiving addresses are read with certainty. */
  readonly to: boolean;
  /** A deposit address an exchange or any wallet can pay; NEAR is paid only from a NEAR wallet. */
  readonly address: boolean;
  readonly coins: readonly NearCoin[];
}

export interface SwapCatalog {
  /** NEAR itself, as 1Click prices it. */
  readonly near: { readonly assetId: string; readonly decimals: number; readonly price: number };
  readonly chains: readonly SwapChain[];
}

/** A token on NEAR that a NEAR wallet pays with `ft_transfer`: a NEP-141 contract, named the same in its asset id. */
const nep141 = (t: Token) => t.assetId.startsWith("nep141:") && t.contractAddress === t.assetId.slice("nep141:".length);

/**
 * Every network and coin a swap can start from or end in: only what listed.ts lists, and of that only what 1Click quotes
 * today at a plausible price (listedTokens), so a coin outside the list is never shown and never quoted. On NEAR only a
 * plain NEP-141 token a NEAR wallet pays with `ft_transfer`; wNEAR is NEAR here: it arrives native and leaves wrapped by
 * the wallet itself. In the list's order: NEAR first, then where money usually sits; on each network stablecoins, its
 * own coin, then the rest.
 */
export function swapCatalogOf(tokens: readonly Token[]): SwapCatalog | null {
  const near = tokens.find((t) => t.assetId === NEAR_ASSET && t.blockchain === "near");
  if (!near || !(near.price > 0)) return null;
  const byChain = new Map<string, NearCoin[]>();
  for (const { listed, token } of listedTokens(tokens)) {
    if (listed.chain === "near" && !nep141(token)) continue;
    const list = byChain.get(listed.chain) ?? byChain.set(listed.chain, []).get(listed.chain)!;
    list.push(listedCoin(listed, token));
  }
  const chains: SwapChain[] = [...byChain].map(([id, coins]) => ({
    id,
    name: chainName(id),
    window: chainWindow(id),
    memo: chainMemo(id),
    to: SWAP_TO.includes(id),
    address: id !== "near",
    coins,
  }));
  chains.sort((a, b) => chainRank(a.id) - chainRank(b.id));
  return { near: { assetId: near.assetId, decimals: near.decimals, price: near.price }, chains };
}

export function swapCoinOf(c: SwapCatalog, assetId: string): { chain: SwapChain; coin: NearCoin } | null {
  for (const chain of c.chains) {
    const coin = chain.coins.find((x) => x.assetId === assetId);
    if (coin) return { chain, coin };
  }
  return null;
}

// ---- Addresses ----

/**
 * Why an address was refused: nothing typed; an address of another network (`other` names it); a checksum that does not
 * match (one character off); a Solana token account or program address instead of a wallet; an address nobody spends
 * from (the EVM zero address, a Solana program, Tron's black hole); an
 * `0x…` pasted as a NEAR account; a testnet account; or anything else.
 */
export type AddressWhy = "empty" | "other" | "checksum" | "token-account" | "zero" | "eth" | "testnet" | "bad";

export type AddressRead =
  | { readonly ok: true; readonly id: string; readonly kind: "near" | AddressKind; readonly implicit?: boolean }
  | { readonly ok: false; readonly why: AddressWhy; readonly other?: string };

/**
 * Addresses of the right shape that no wallet spends from: Solana's own programs and its incinerator (on the curve, so
 * they read as wallets), and Tron's black hole. A coin sent there is gone, like one sent to the EVM zero address.
 */
const NOBODY = new Set([
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "1nc1nerator11111111111111111111111111111111",
  "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
]);

const KIND_NAME: Record<"near" | AddressKind, string> = { near: "NEAR", evm: "EVM", sol: "Solana", tron: "Tron", btc: "Bitcoin" };

/** Which network an address that is not for this one looks like it is for, to say so instead of "not an address". */
function looksLike(text: string): string | null {
  if (/^0x[0-9a-fA-F]{40}$/.test(text)) return "an Ethereum";
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(text)) return "a Tron";
  if (/^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$/.test(text) && addressOfKind("btc", text)) return "a Bitcoin";
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text) && addressOfKind("sol", text)) return "a Solana";
  if (/^[a-z0-9_.-]+\.(near|tg)$/.test(text) || /^[0-9a-f]{64}$/.test(text)) return "a NEAR";
  return null;
}

/**
 * What a person typed as an address on `chainId`, read with certainty, normalized the way a swap sends it: an EVM
 * address in lower case (always valid, no checksum to get wrong), a NEAR account in lower case, a segwit Bitcoin
 * address in lower case. `null` network: no reader, so nothing is taken.
 */
export function readSwapAddress(chainId: string, text: string): AddressRead {
  const kind = addressKindOf(chainId);
  const a = text.trim();
  if (!a) return { ok: false, why: "empty" };
  if (!kind) return { ok: false, why: "bad" };
  const other = (): AddressRead => {
    const like = looksLike(a);
    return like && !like.endsWith(KIND_NAME[kind]) ? { ok: false, why: "other", other: like } : { ok: false, why: "bad" };
  };
  switch (kind) {
    case "near": {
      const r = readNearAccount(a);
      // A name without a dot is a top-level account only a registrar makes, never a person's wallet: an address of
      // another network (a TON address reads as one) would otherwise pass as a NEAR name nobody holds.
      if (r.ok && r.kind === "named" && !r.id.includes(".")) return other();
      if (r.ok) return { ok: true, id: r.id, kind, implicit: r.kind === "implicit" };
      if (r.why === "eth" && /^0x[0-9a-fA-F]{40}$/.test(a)) return { ok: false, why: "other", other: "an Ethereum" };
      return r.why === "bad" ? other() : { ok: false, why: r.why };
    }
    case "evm":
      if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return other();
      if (!addressOfKind("evm", a)) return { ok: false, why: "checksum" };
      if (/^0x0{40}$/i.test(a)) return { ok: false, why: "zero" };
      return { ok: true, id: a.toLowerCase(), kind };
    case "sol":
      if (!addressOfKind("sol", a)) return other();
      if (NOBODY.has(a)) return { ok: false, why: "zero" };
      if (!solanaWalletOk(a)) return { ok: false, why: "token-account" };
      return { ok: true, id: a, kind };
    case "tron":
      if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) {
        if (!addressOfKind("tron", a)) return { ok: false, why: "checksum" };
        return NOBODY.has(a) ? { ok: false, why: "zero" } : { ok: true, id: a, kind };
      }
      return other();
    case "btc": {
      if (/^(tb1|bcrt1|[mn2])/i.test(a)) return { ok: false, why: "testnet" };
      if (addressOfKind("btc", a)) return { ok: true, id: /^bc1/i.test(a) ? a.toLowerCase() : a, kind };
      return /^(bc1|[13])/i.test(a) && !looksLike(a) ? { ok: false, why: "checksum" } : other();
    }
  }
}

/**
 * Addresses a shared preview is priced for: nothing is sent to them (a preview has no deposit address), they only make
 * the price include the payout on that network. Each passes `readSwapAddress`.
 */
export const PREVIEW_ADDRESS: Readonly<Record<"evm" | "sol" | "tron" | "btc", string>> = {
  evm: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
  sol: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  tron: "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7",
  btc: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
};

// ---- The quote ----

/** Where a refund goes: an address on the network the coin came from, or a NEAR account inside NEAR Intents. */
export interface Refund {
  readonly to: string;
  readonly type: DepositType;
}

/**
 * The refund a person can give for a coin paid in on `chainId`, read with certainty: an address of that network where
 * this code reads its addresses, otherwise a NEAR account (the refund then waits for it inside NEAR Intents).
 */
export function readRefund(chainId: string, text: string): { ok: true; refund: Refund } | { ok: false; why: AddressWhy; other?: string } {
  if (addressKindOf(chainId)) {
    const r = readSwapAddress(chainId, text);
    return r.ok ? { ok: true, refund: { to: r.id, type: "ORIGIN_CHAIN" } } : r;
  }
  const r = readSwapAddress("near", text);
  return r.ok ? { ok: true, refund: { to: r.id, type: "INTENTS" } } : r;
}

/** Whether a refund for a coin paid in on `chainId` is an address of that network (else a NEAR account in NEAR Intents). */
export const refundOnOrigin = (chainId: string) => addressKindOf(chainId) !== null;

/**
 * A swap: the person sends `amount` units of `from` to the deposit address (or from their NEAR wallet for a coin on
 * NEAR), 1Click swaps it and pays `to` out to `recipient` on its own network. FLEX_INPUT, so a transfer an exchange
 * shaves a little (up to 1%) still goes through. `recipient` and `refund` must already be read (`readSwapAddress`,
 * `readRefund`); they are read again here. `fee`: MASK WARS's own share, from packages/network.
 */
export function swapRequest(o: {
  from: { chain: SwapChain; coin: NearCoin };
  to: { chain: SwapChain; coin: NearCoin };
  amount: bigint;
  recipient: string;
  refund: Refund;
  dry: boolean;
  fee?: AppFee | null;
  now?: Date;
}): NearQuoteRequest {
  if (o.amount <= 0n) throw new Error("amount must be positive");
  if (!o.from.chain.coins.some((c) => c.assetId === o.from.coin.assetId)) throw new Error(`${o.from.coin.assetId} is not on ${o.from.chain.id}`);
  if (!o.to.chain.coins.some((c) => c.assetId === o.to.coin.assetId)) throw new Error(`${o.to.coin.assetId} is not on ${o.to.chain.id}`);
  if (!o.to.chain.to) throw new Error(`no payout to ${o.to.chain.id}`);
  if (o.from.coin.assetId === o.to.coin.assetId) throw new Error("the same coin in and out");
  const to = readSwapAddress(o.to.chain.id, o.recipient);
  if (!to.ok || to.id !== o.recipient) throw new Error(`not an address on ${o.to.chain.id}: ${o.recipient}`);
  const back = o.refund.type === "INTENTS" ? readSwapAddress("near", o.refund.to) : readSwapAddress(o.from.chain.id, o.refund.to);
  if (!back.ok || back.id !== o.refund.to) throw new Error(`not a refund address: ${o.refund.to}`);
  const now = o.now ?? new Date();
  return {
    dry: o.dry,
    swapType: "FLEX_INPUT",
    slippageTolerance: SLIPPAGE_BPS,
    originAsset: o.from.coin.assetId,
    depositType: "ORIGIN_CHAIN",
    ...(o.from.chain.memo ? { depositMode: "MEMO" as const } : {}),
    destinationAsset: o.to.coin.assetId,
    amount: o.amount.toString(),
    refundTo: o.refund.to,
    refundType: o.refund.type,
    recipient: o.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(now.getTime() + o.from.chain.window * 60_000).toISOString(),
    referral: REFERRAL,
    quoteWaitingTimeMs: o.dry ? 0 : 3000,
    ...(o.fee && o.fee.fee > 0 ? { appFees: [{ recipient: o.fee.recipient, fee: o.fee.fee }] } : {}),
  };
}

/**
 * Reads a swap's quote back before its deposit address is shown or paid: this coin in, that coin out on its own network
 * to this address, the refund where the page said, exactly the amount asked, a promised minimum within 1% of the price
 * and no lower than the preview slid by more than the price may move. An EVM address is compared in lower case.
 */
export function checkSwapQuote(
  v: NearQuoteView,
  o: { from: string; to: string; recipient: string; refund: Refund; amountIn: string; seen?: string | null },
): QuoteCheck {
  const low = (a: string | null) => (a && /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : a);
  const view = { ...v, recipient: low(v.recipient), refundTo: low(v.refundTo) };
  return checkQuote(view, {
    account: low(o.refund.to)!,
    refundType: o.refund.type,
    from: o.from,
    to: o.to,
    recipient: low(o.recipient)!,
    recipientType: "DESTINATION_CHAIN",
    amountIn: o.amountIn,
    seen: o.seen ?? null,
  });
}

/** Whether a deposit address 1Click gave is one a wallet on `chainId` can pay: read with certainty, or `false`. */
export function depositAddressOk(chainId: string, address: string): boolean {
  if (chainId === "near") return /^[0-9a-f]{64}$/.test(address);
  const kind = addressKindOf(chainId);
  if (!kind || kind === "near") return /^[A-Za-z0-9._:-]{20,120}$/.test(address);
  // A Solana deposit address may be a program's, off the curve: only its shape is read.
  return kind === "sol" ? addressOfKind("sol", address) : addressOfKind(kind, address);
}

// ---- Where it is ----

/** A swap as the page follows it: 1Click's progress, and the transaction that paid the receiver, with its explorer. */
export interface SwapProgress extends Progress {
  readonly landed: { readonly hash: string; readonly link: string } | null;
}

/** Where a person opens a transaction on `chainId`, or `null` for a hash that is not one of that network's. */
export function txExplorer(chainId: string, hash: string): string | null {
  const kind = addressKindOf(chainId);
  if (kind === "near") return /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(hash) ? `https://nearblocks.io/txns/${hash}` : null;
  if (kind === "evm") return /^0x[0-9a-fA-F]{64}$/.test(hash) ? `${evmChainOf(chainId)!.explorer}/tx/${hash}` : null;
  if (kind === "sol") return /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(hash) ? `https://solscan.io/tx/${hash}` : null;
  if (kind === "tron") return /^(0x)?[0-9a-fA-F]{64}$/.test(hash) ? `https://tronscan.org/#/transaction/${hash.replace(/^0x/, "")}` : null;
  if (kind === "btc") return /^[0-9a-fA-F]{64}$/.test(hash) ? `https://mempool.space/tx/${hash}` : null;
  return null;
}

/** 1Click's status for a swap paying out on `chainId`, with the payout's transaction once it is done. */
export function swapProgressOf(r: StatusResponse, chainId: string): SwapProgress {
  const p = progressOf(r);
  const d = r.swapDetails ?? {};
  let landed: SwapProgress["landed"] = null;
  if (p.stage === "done") {
    const hashes = [...(d.destinationChainTxHashes ?? []).map((t) => t?.hash), ...(chainId === "near" ? [...(d.nearTxHashes ?? [])].reverse() : [])];
    for (const h of hashes) {
      const link = typeof h === "string" ? txExplorer(chainId, h) : null;
      if (link) {
        landed = { hash: h!, link };
        break;
      }
    }
  }
  return { ...p, landed };
}

// ---- The quote as the page gets it ----

/** A swap's quote: the prices and fees the page shows, and what the networks charge on the way. */
export interface SwapQuoteView extends NearQuoteView {
  /** Units of the coin out the payout network takes for sending it (already inside `amountOut`). */
  readonly withdrawFee: string | null;
  /** Units of the coin in a refund to the origin network would cost, if it comes to that. */
  readonly refundFee: string | null;
}

const units = (t: unknown) => (typeof t === "string" && /^\d{1,40}$/.test(t) ? t : null);

export function swapQuoteView(q: QuoteResponse): SwapQuoteView {
  return { ...nearQuoteView(q), withdrawFee: units(q.quote.withdrawFee), refundFee: units(q.quote.refundFee) };
}

/** A preview shared by everyone pricing the same coins and amount: the prices and fees, nobody's addresses. */
export function swapPreviewView(v: SwapQuoteView): SwapQuoteView {
  return { ...v, recipient: null, refundTo: null, depositAddress: null, depositMemo: null };
}

// ---- Paying from a NEAR wallet ----

const TGAS = 10n ** 12n;
const callOf = (methodName: string, args: Record<string, unknown>, tgas: number, deposit: bigint): CallAction => ({
  type: "FunctionCall",
  params: { methodName, args, gas: (BigInt(tgas) * TGAS).toString(), deposit: deposit.toString() },
});

/** Gas a NEAR wallet pays for the deposit transaction at most, in yoctoNEAR (60 TGas at 0.1 NEAR per 1000 TGas, rounded up). */
export const NEAR_PAY_GAS = 10_000_000_000_000_000_000n;

/**
 * The one transaction a NEAR wallet pays a swap's deposit account with, to the coin's own contract, so it goes through
 * whole or not at all (actions to one contract run as one receipt):
 *
 *   storage_deposit(deposit account)   when the contract does not know the deposit account yet: an `ft_transfer` to an
 *                                      account it does not know fails
 *   storage_deposit(payer)             native NEAR only, when wrap.near does not know the payer: `near_deposit` would
 *                                      otherwise keep that much back and the transfer would come up short
 *   near_deposit                       native NEAR only: wraps exactly the amount
 *   ft_transfer(deposit account)       exactly the quoted amount, 1 yoctoNEAR attached as NEP-141 asks
 *
 * `depositStorage` and `payerStorage` are what the contract asks to register an account, 0 when it already knows it.
 */
export function nearDepositTransaction(o: {
  coin: NearCoin;
  payer: string;
  depositAddress: string;
  amount: bigint;
  depositStorage: bigint;
  payerStorage: bigint;
}): Transaction {
  const payer = readNearAccount(o.payer);
  if (!payer.ok || payer.id !== o.payer) throw new Error(`not a NEAR account: ${o.payer}`);
  if (!depositAddressOk("near", o.depositAddress)) throw new Error(`not a NEAR deposit account: ${o.depositAddress}`);
  if (!o.coin.assetId.startsWith("nep141:") || o.coin.contract !== o.coin.assetId.slice("nep141:".length)) throw new Error(`not a NEAR token: ${o.coin.assetId}`);
  if (o.amount <= 0n) throw new Error("amount must be positive");
  if (o.depositStorage < 0n || o.payerStorage < 0n) throw new Error("storage must not be negative");
  const native = o.coin.assetId === NEAR_ASSET;
  const actions: CallAction[] = [];
  if (o.depositStorage > 0n) actions.push(callOf("storage_deposit", { account_id: o.depositAddress, registration_only: true }, 10, o.depositStorage));
  if (native && o.payerStorage > 0n) actions.push(callOf("storage_deposit", { account_id: o.payer, registration_only: true }, 10, o.payerStorage));
  if (native) actions.push(callOf("near_deposit", {}, 10, o.amount));
  actions.push(callOf("ft_transfer", { receiver_id: o.depositAddress, amount: o.amount.toString() }, 30, 1n));
  return { receiverId: o.coin.contract, actions };
}

/** NEAR the payer's account spends on the deposit transaction besides the coin: storage, 1 yocto and gas at most. */
export function nearPayExtra(o: { depositStorage: bigint; payerStorage: bigint; native: boolean }): bigint {
  return o.depositStorage + (o.native ? o.payerStorage : 0n) + 1n + NEAR_PAY_GAS;
}
