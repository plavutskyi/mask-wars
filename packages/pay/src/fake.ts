import { usdOf } from "./amount.ts";
import { base64, fromBase64, hex, utf8 } from "./codec.ts";
import { checkIntent, INTENTS } from "./intent.ts";
import type { QuoteRequest, QuoteResponse, SignedIntent, StatusResponse, SwapStatus, Token } from "./oneclick.ts";
import { accountOf, keyBytes, verifyWebauthn } from "./passkey.ts";

/**
 * 1Click and the NEAR Intents ledger in memory, for walking the money pages end to end on a laptop and in screenshots:
 * the same paths and shapes as the real services, priced from 1Click's recorded token list. A top-up's transfer "lands"
 * by itself a few seconds after its deposit address is handed out; a cash-out moves only after a signed intent that
 * passes the same checks NEAR Intents makes (a passkey signature included). Never used in production: the site turns
 * it on only with PAY_FIXTURE=1.
 */

interface Swap {
  readonly quote: QuoteResponse;
  readonly at: number;
  submittedAt: number | null;
  settled: boolean;
}

export interface FakePay {
  readonly fetch: typeof fetch;
  /** account → asset → units */
  readonly ledger: Map<string, Map<string, bigint>>;
}

const DEPOSIT: Record<string, () => string> = {
  sol: () => base58ish(44),
  base: () => `0x${hex(crypto.getRandomValues(new Uint8Array(20)))}`,
  eth: () => `0x${hex(crypto.getRandomValues(new Uint8Array(20)))}`,
  arb: () => `0x${hex(crypto.getRandomValues(new Uint8Array(20)))}`,
  tron: () => `T${base58ish(33)}`,
  btc: () => `bc1q${[...crypto.getRandomValues(new Uint8Array(38))].map((b) => "qpzry9x8gf2tvdw0s3jn54khce6mua7l"[b % 32]).join("")}`,
};

function base58ish(n: number): string {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => A[b % 58]).join("");
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

export function fakePay(o: { tokens: readonly Token[]; stepMs?: number; now?: () => number }): FakePay {
  const step = o.stepMs ?? 4000;
  const now = o.now ?? Date.now;
  const swaps = new Map<string, Swap>();
  const ledger = new Map<string, Map<string, bigint>>();
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
    if (depositAddress) swaps.set(depositAddress, { quote: res, at: now(), submittedAt: null, settled: false });
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
    else st = since < step * 2 ? "PENDING_DEPOSIT" : since < step * 3 ? "KNOWN_DEPOSIT_TX" : since < step * 4 ? "PROCESSING" : "SUCCESS";
    if (st === "SUCCESS" && !s.settled) {
      s.settled = true;
      if (req.recipientType === "INTENTS") credit(req.recipient, req.destinationAsset, BigInt(q.amountOut));
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
        ...(arrived ? { depositedAmount: q.amountIn, depositedAmountFormatted: q.amountInFormatted, amountIn: q.amountIn } : {}),
        ...(st === "SUCCESS" ? { amountOut: q.amountOut, amountOutFormatted: q.amountOutFormatted } : {}),
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

  function rpc(body: { params?: { method_name?: string; args_base64?: string; account_id?: string } }): Response {
    const p = body.params ?? {};
    if (p.account_id !== INTENTS) return json({ jsonrpc: "2.0", id: "maskwars", error: { message: "unknown account" } });
    const args = JSON.parse(new TextDecoder().decode(fromBase64(p.args_base64 ?? "") ?? new Uint8Array()));
    let value: unknown;
    if (p.method_name === "mt_batch_balance_of") value = (args.token_ids as string[]).map((t) => (held(args.account_id).get(t) ?? 0n).toString());
    else if (p.method_name === "has_public_key") value = true;
    else return json({ jsonrpc: "2.0", id: "maskwars", error: { message: "MethodNotFound" } });
    return json({ jsonrpc: "2.0", id: "maskwars", result: { result: [...utf8(JSON.stringify(value))] } });
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
      default:
        return json({ message: "not found" }, 404);
    }
  };
  return { fetch: f, ledger };
}
