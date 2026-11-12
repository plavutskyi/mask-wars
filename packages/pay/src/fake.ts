import { usdOf } from "./amount.ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64, fromBase64, hex, utf8 } from "./codec.ts";
import { EVM_CHAINS } from "./evm.ts";
import { checkIntent, INTENTS } from "./intent.ts";
import type { QuoteRequest, QuoteResponse, SignedIntent, StatusResponse, SwapStatus, Token } from "./oneclick.ts";
import { accountOf, keyBytes, verifyWebauthn } from "./passkey.ts";

/**
 * 1Click and the NEAR Intents ledger in memory, for walking the money pages end to end on a laptop and in screenshots:
 * the same paths and shapes as the real services, priced from 1Click's recorded token list. A top-up's transfer "lands"
 * by itself a few seconds after its deposit address is handed out; a cash-out moves only after a signed intent that
 * passes the same checks NEAR Intents makes (a passkey signature included). Never used in production: the site turns
 * it on only with PAY_FIXTURE=1.
 *
 * Every way a top-up can end can be walked by hand, by its cents in a stablecoin (USDC, USDT): `.13` is refunded to the
 * vault (REFUNDED), `.66` fails (FAILED), `.07` arrives short and goes back (INCOMPLETE_DEPOSIT). Any other amount goes
 * through. The mask factory is here too (`masks_of`, `get_mask`), with a NEAR wallet's own transactions (`send`): what
 * the vault spends on a mask's mind moves from NEAR Intents to the wallet's account and into the mask's tank.
 */

interface Swap {
  readonly quote: QuoteResponse;
  readonly at: number;
  submittedAt: number | null;
  settled: boolean;
  /** How a top-up ends, by its cents: through, or one of the ways it does not. */
  readonly ends: "SUCCESS" | "REFUNDED" | "FAILED" | "INCOMPLETE_DEPOSIT";
}

/** A forged mask as the factory's `get_mask` gives it: amounts in yoctoNEAR. Only what the fake reads is required. */
export interface FakeMask {
  readonly name: string;
  readonly account: string;
  readonly owner: string;
  readonly brain: string;
  readonly fuel: string;
  readonly [field: string]: unknown;
}

/** One function call of a NEAR wallet's transaction, as `spendTransactions` builds them. */
interface WalletTx {
  readonly receiverId: string;
  readonly actions: readonly { readonly type: string; readonly params: { readonly methodName: string; readonly args: Record<string, unknown>; readonly deposit: string } }[];
}

export interface FakePay {
  readonly fetch: typeof fetch;
  /** account → asset → units */
  readonly ledger: Map<string, Map<string, bigint>>;
  /** The factory's masks, by name. */
  readonly masks: Map<string, FakeMask>;
  /** A NEAR wallet signs and sends `txs` in order, as NEAR Connect does: one outcome each, none after one that fails. */
  send(signer: string, txs: readonly WalletTx[]): unknown[];
}

/** By its cents, how a stablecoin top-up ends here. */
function endsOf(usd: number): Swap["ends"] {
  const c = Math.round(usd * 100) % 100;
  return c === 13 ? "REFUNDED" : c === 66 ? "FAILED" : c === 7 ? "INCOMPLETE_DEPOSIT" : "SUCCESS";
}

const evmDeposit = () => `0x${hex(crypto.getRandomValues(new Uint8Array(20)))}`;
/** A base58check address: a version byte, 20 random bytes and the double-sha256 checksum (Tron, legacy Bitcoin). */
function base58check(version: number): string {
  const body = Uint8Array.of(version, ...crypto.getRandomValues(new Uint8Array(20)));
  return base58(Uint8Array.of(...body, ...sha256(sha256(body)).subarray(0, 4)));
}

const DEPOSIT: Record<string, () => string> = {
  sol: () => base58(crypto.getRandomValues(new Uint8Array(32))),
  ...Object.fromEntries(EVM_CHAINS.map((c) => [c.id, evmDeposit])),
  tron: () => base58check(0x41),
  btc: () => base58check(0x00),
  // A deposit account on NEAR is a 64-character implicit account, as 1Click gives one.
  near: () => hex(crypto.getRandomValues(new Uint8Array(32))),
};

function base58ish(n: number): string {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => A[b % 58]).join("");
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

const WNEAR_ASSET = "nep141:wrap.near";
const YOCTO = 10n ** 24n;
const MIN_REFUEL = YOCTO / 10n;

export function fakePay(o: { tokens: readonly Token[]; stepMs?: number; now?: () => number; factory?: string; masks?: readonly FakeMask[] }): FakePay {
  const step = o.stepMs ?? 4000;
  const now = o.now ?? Date.now;
  const factory = o.factory ?? "masks.maskwars.near";
  const swaps = new Map<string, Swap>();
  const ledger = new Map<string, Map<string, bigint>>();
  const masks = new Map<string, FakeMask>((o.masks ?? []).map((m) => [m.name, { ...m }]));
  /** NEAR and wNEAR on the wallets' own accounts, outside NEAR Intents. Every account starts with 1 NEAR for gas. */
  const native = new Map<string, bigint>();
  const wnear = new Map<string, bigint>();
  const token = (assetId: string) => o.tokens.find((t) => t.assetId === assetId);
  const held = (account: string) => ledger.get(account) ?? ledger.set(account, new Map()).get(account)!;
  const credit = (account: string, asset: string, units: bigint) => held(account).set(asset, (held(account).get(asset) ?? 0n) + units);

  function quote(req: QuoteRequest): Response {
    const tin = token(req.originAsset);
    const tout = token(req.destinationAsset);
    if (!tin || !tout) return json({ message: "tokenIn or tokenOut is not supported" }, 400);
    const amountIn = BigInt(req.amount);
    const usd = usdOf(amountIn, tin.decimals, tin.price);
    if (usd < 1) return json({ message: `Amount is too low for bridge, try at least ${Math.ceil((1 / tin.price) * 10 ** tin.decimals)}` }, 400);
    if (req.depositType === "INTENTS" && (held(req.refundTo).get(req.originAsset) ?? 0n) < amountIn) {
      return json({ message: "Insufficient balance" }, 400);
    }
    const out = (usd * 0.997) / tout.price;
    const amountOut = BigInt(Math.floor(out * 10 ** Math.min(tout.decimals, 12))) * 10n ** BigInt(Math.max(0, tout.decimals - 12));
    const fmt = (u: bigint, d: number) => (Number(u) / 10 ** d).toString();
    // Like 1Click: the deposit address lives three days past the swap's own deadline.
    const deadline = new Date(Date.parse(req.deadline) + 3 * 86_400_000).toISOString();
    const depositAddress = req.dry
      ? undefined
      : req.depositType === "INTENTS"
        ? hex(crypto.getRandomValues(new Uint8Array(32)))
        : (DEPOSIT[tin.blockchain] ?? DEPOSIT.sol!)();
    const res: QuoteResponse = {
      correlationId: crypto.randomUUID(),
      timestamp: new Date(now()).toISOString(),
      signature: "ed25519:fake",
      quoteRequest: req,
      quote: {
        ...(depositAddress ? { depositAddress, deadline, timeWhenInactive: deadline } : {}),
        amountIn: amountIn.toString(),
        amountInFormatted: fmt(amountIn, tin.decimals),
        amountInUsd: usd.toFixed(4),
        minAmountIn: req.swapType === "FLEX_INPUT" ? ((amountIn * 99n) / 100n).toString() : amountIn.toString(),
        amountOut: amountOut.toString(),
        amountOutFormatted: fmt(amountOut, tout.decimals),
        amountOutUsd: (usd * 0.997).toFixed(4),
        minAmountOut: ((amountOut * 99n) / 100n).toString(),
        timeEstimate: req.depositType === "INTENTS" ? 12 : 20,
      },
    };
    const stable = ["USDC", "USDT"].includes(tin.symbol);
    const ends = req.depositType === "INTENTS" || !stable ? "SUCCESS" : endsOf(Number(amountIn) / 10 ** tin.decimals);
    if (depositAddress) swaps.set(depositAddress, { quote: res, at: now(), submittedAt: null, settled: false, ends });
    return json(res);
  }

  function status(depositAddress: string): Response {
    const s = swaps.get(depositAddress);
    if (!s) return json({ message: "Deposit address not found" }, 404);
    const req = s.quote.quoteRequest;
    const q = s.quote.quote;
    const toIntents = req.depositType === "INTENTS";
    const since = toIntents ? (s.submittedAt === null ? -1 : now() - s.submittedAt) : now() - s.at;
    let st: SwapStatus;
    if (toIntents) st = since < 0 ? "PENDING_DEPOSIT" : since < step ? "PROCESSING" : "SUCCESS";
    else if (s.ends === "INCOMPLETE_DEPOSIT") st = since < step * 2 ? "PENDING_DEPOSIT" : since < step * 3 ? "KNOWN_DEPOSIT_TX" : "INCOMPLETE_DEPOSIT";
    else st = since < step * 2 ? "PENDING_DEPOSIT" : since < step * 3 ? "KNOWN_DEPOSIT_TX" : since < step * 4 ? "PROCESSING" : s.ends;
    // What arrived: the whole amount, or for a short deposit four fifths of it.
    const deposited = s.ends === "INCOMPLETE_DEPOSIT" ? (BigInt(q.amountIn) * 4n) / 5n : BigInt(q.amountIn);
    if ((st === "SUCCESS" || st === "REFUNDED" || st === "INCOMPLETE_DEPOSIT") && !s.settled) {
      s.settled = true;
      if (st === "SUCCESS" && req.recipientType === "INTENTS") credit(req.recipient, req.destinationAsset, BigInt(q.amountOut));
      // A refund goes where the quote said: the vault, in NEAR Intents, as the coin that came.
      else if (st !== "SUCCESS" && req.refundType === "INTENTS" && req.refundTo) credit(req.refundTo, req.originAsset, deposited);
    }
    const arrived = st !== "PENDING_DEPOSIT";
    const origin = !toIntents && arrived ? [{ hash: base58ish(64), explorerUrl: "https://solscan.io/tx/fake" }] : [];
    const dest = st === "SUCCESS" && !toIntents ? [] : st === "SUCCESS" ? [{ hash: `0x${hex(utf8(depositAddress).subarray(0, 32))}`, explorerUrl: "https://basescan.org/tx/fake" }] : [];
    const body: StatusResponse = {
      correlationId: s.quote.correlationId,
      quoteResponse: s.quote,
      status: st,
      updatedAt: new Date(now()).toISOString(),
      swapDetails: {
        intentHashes: [],
        nearTxHashes: [],
        originChainTxHashes: origin,
        destinationChainTxHashes: dest,
        ...(arrived ? { depositedAmount: deposited.toString(), amountIn: q.amountIn } : {}),
        ...(st === "SUCCESS" ? { amountOut: q.amountOut, amountOutFormatted: q.amountOutFormatted } : {}),
        ...(st === "REFUNDED" || st === "INCOMPLETE_DEPOSIT" ? { refundedAmount: deposited.toString(), refundReason: st === "REFUNDED" ? "PRICE_MOVED" : "DEPOSIT_TOO_SMALL" } : {}),
      },
    };
    return json(body);
  }

  function generate(b: { depositAddress: string; signerId: string; standard: string }): Response {
    const s = swaps.get(b.depositAddress);
    if (!s || s.quote.quoteRequest.depositType !== "INTENTS") return json({ message: "Invalid input or quote state" }, 400);
    const q = s.quote;
    const intents = [{ intent: "transfer", receiver_id: b.depositAddress, tokens: { [q.quoteRequest.originAsset]: q.quote.amountIn } }];
    const nonce = base64(crypto.getRandomValues(new Uint8Array(32)));
    const deadline = q.quote.deadline ?? q.quoteRequest.deadline;
    if (b.standard === "webauthn") {
      const payload = JSON.stringify({ signer_id: b.signerId, verifying_contract: INTENTS, deadline, nonce, intents });
      return json({ intent: { standard: "webauthn", payload }, correlationId: crypto.randomUUID() });
    }
    const message = JSON.stringify({ signer_id: b.signerId, deadline, intents });
    return json({ intent: { standard: "nep413", payload: { message, nonce, recipient: INTENTS } }, correlationId: crypto.randomUUID() });
  }

  function submit(signed: SignedIntent): Response {
    const message = signed.standard === "webauthn" ? JSON.parse(signed.payload) : JSON.parse(signed.payload.message);
    const transfer = message.intents?.[0];
    const s = transfer ? swaps.get(transfer.receiver_id) : undefined;
    if (!s) return json({ message: "Invalid signature or intent data" }, 400);
    const q = s.quote;
    const expected = {
      signer: message.signer_id,
      depositAddress: transfer.receiver_id,
      asset: q.quoteRequest.originAsset,
      amount: q.quote.amountIn,
      ...(q.quote.deadline ? { notAfter: q.quote.deadline } : {}),
      now: new Date(now()),
    };
    const intent = signed.standard === "webauthn" ? { standard: "webauthn" as const, payload: signed.payload } : { standard: "nep413" as const, payload: signed.payload };
    if (!checkIntent(intent, expected).ok) return json({ message: "Invalid signature or intent data" }, 400);
    if (signed.standard === "webauthn") {
      const key = keyBytes(signed.public_key);
      if (!key || !verifyWebauthn(signed) || accountOf(key) !== message.signer_id) return json({ message: "Invalid signature or intent data" }, 400);
    } else if (fromBase64(signed.payload.nonce)?.length !== 32) {
      return json({ message: "Invalid signature or intent data" }, 400);
    }
    const have = held(message.signer_id).get(q.quoteRequest.originAsset) ?? 0n;
    if (have < BigInt(q.quote.amountIn) || s.submittedAt !== null) return json({ message: "Invalid signature or intent data" }, 400);
    credit(message.signer_id, q.quoteRequest.originAsset, -BigInt(q.quote.amountIn));
    s.submittedAt = now();
    return json({ intentHash: base58ish(44), correlationId: crypto.randomUUID() });
  }

  function rpc(body: { params?: { request_type?: string; method_name?: string; args_base64?: string; account_id?: string } }): Response {
    const p = body.params ?? {};
    // A NEAR wallet's own account: 50 NEAR on it, so a swap from NEAR can be walked.
    if (p.request_type === "view_account") return json({ jsonrpc: "2.0", id: "maskwars", result: { amount: (50n * YOCTO).toString(), locked: "0", storage_usage: 500 } });
    const args = JSON.parse(new TextDecoder().decode(fromBase64(p.args_base64 ?? "") ?? new Uint8Array()));
    let value: unknown;
    if (p.account_id === INTENTS && p.method_name === "mt_batch_balance_of") value = (args.token_ids as string[]).map((t) => (held(args.account_id).get(t) ?? 0n).toString());
    else if (p.account_id === INTENTS && p.method_name === "has_public_key") value = true;
    else if (p.account_id === factory && p.method_name === "masks_of") value = [...masks.values()].filter((m) => m.owner === args.owner);
    else if (p.account_id === factory && p.method_name === "get_mask") value = masks.get(args.name) ?? null;
    // Any other contract is a NEP-141 token as a swap from a NEAR wallet reads it: no account registered yet, wrap.near's
    // registration price, and a wallet that holds plenty.
    else if (p.account_id !== INTENTS && p.account_id !== factory && p.method_name === "storage_balance_of") value = null;
    else if (p.account_id !== INTENTS && p.account_id !== factory && p.method_name === "storage_balance_bounds") value = { min: "1250000000000000000000", max: "1250000000000000000000" };
    else if (p.account_id !== INTENTS && p.account_id !== factory && p.method_name === "ft_balance_of") value = (10n ** 30n).toString();
    else if (p.account_id !== INTENTS && p.account_id !== factory) return json({ jsonrpc: "2.0", id: "maskwars", error: { message: "unknown account" } });
    else return json({ jsonrpc: "2.0", id: "maskwars", error: { message: "MethodNotFound" } });
    return json({ jsonrpc: "2.0", id: "maskwars", result: { result: [...utf8(JSON.stringify(value))] } });
  }

  /** One transaction of a NEAR wallet, applied as the chain would: a value it returns, or the reason it fails. */
  function apply(signer: string, tx: WalletTx): { ok: true; value: unknown } | { ok: false; why: string } {
    const a = Array.isArray(tx?.actions) && tx.actions.length === 1 ? tx.actions[0] : undefined;
    if (!a || a.type !== "FunctionCall" || !a.params || typeof a.params.args !== "object" || !/^\d+$/.test(String(a.params.deposit))) return { ok: false, why: "one function call" };
    const { methodName: m, args, deposit } = a.params;
    const attached = BigInt(deposit);
    const has = native.get(signer) ?? YOCTO;
    if (has < attached) return { ok: false, why: "NotEnoughBalance" };
    if (tx.receiverId === "wrap.near" && m === "storage_deposit") return { ok: true, value: { total: "1250000000000000000000", available: "0" } };
    if (tx.receiverId === INTENTS && m === "ft_withdraw") {
      const amount = BigInt(String(args.amount));
      if (args.token !== "wrap.near" || args.receiver_id !== signer || attached !== 1n) return { ok: false, why: "bad withdraw" };
      const inVault = held(signer).get(WNEAR_ASSET) ?? 0n;
      if (inVault < amount) return { ok: false, why: "insufficient balance" };
      held(signer).set(WNEAR_ASSET, inVault - amount);
      wnear.set(signer, (wnear.get(signer) ?? 0n) + amount);
      return { ok: true, value: amount.toString() };
    }
    if (tx.receiverId === "wrap.near" && m === "near_withdraw") {
      const amount = BigInt(String(args.amount));
      const w = wnear.get(signer) ?? 0n;
      if (w < amount || attached !== 1n) return { ok: false, why: "The account doesn't have enough balance" };
      wnear.set(signer, w - amount);
      native.set(signer, has - 1n + amount);
      return { ok: true, value: null };
    }
    if (tx.receiverId === factory && m === "refuel") {
      const mask = masks.get(String(args.name));
      if (!mask) return { ok: false, why: "no such mask" };
      if (attached < MIN_REFUEL) return { ok: false, why: "refuel with at least 0.1 NEAR" };
      native.set(signer, has - attached);
      const next = { ...mask, brain: (BigInt(mask.brain) + attached).toString(), fuel: (BigInt(mask.fuel) + attached).toString() };
      masks.set(mask.name, next);
      return { ok: true, value: next };
    }
    return { ok: false, why: "MethodNotFound" };
  }

  function send(signer: string, txs: readonly WalletTx[]): unknown[] {
    const out: unknown[] = [];
    for (const tx of txs) {
      const r = apply(signer, tx);
      const hash = base58ish(44);
      out.push({
        status: r.ok ? { SuccessValue: base64(utf8(JSON.stringify(r.value))) } : { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: r.why } } } } },
        transaction: { hash, receiver_id: tx.receiverId, signer_id: signer },
        transaction_outcome: { id: hash },
      });
      if (!r.ok) break;
    }
    return out;
  }

  const f: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.hostname !== "1click.chaindefuser.com") return rpc(body);
    switch (`${method} ${url.pathname}`) {
      case "GET /v0/tokens":
        return json(o.tokens);
      case "POST /v0/quote":
        return quote(body);
      case "GET /v0/status":
        return status(url.searchParams.get("depositAddress") ?? "");
      case "POST /v0/generate-intent":
        return generate(body);
      case "POST /v0/submit-intent":
        return submit(body.signedData);
      case "POST /v0/deposit/submit":
        // A deposit told about: 1Click answers with the swap's status, as for /v0/status.
        return status(body.depositAddress ?? "");
      default:
        return json({ message: "not found" }, 404);
    }
  };
  return { fetch: f, ledger, masks, send };
}
