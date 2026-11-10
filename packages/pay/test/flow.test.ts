import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  base64,
  checkIntent,
  checkQuote,
  final,
  intentDeadline,
  Ledger,
  nonceBytes,
  OneClick,
  OneClickError,
  previewView,
  progressOf,
  quoteView,
  signedNep413,
  vaultAccountOk,
  viewResult,
  withDeadline,
  type StatusResponse,
  type UnsignedIntent,
} from "../src/index.ts";

const fx = JSON.parse(readFileSync(new URL("./fixtures/oneclick.json", import.meta.url), "utf8"));

/** 1Click as recorded: answers by method and path, and keeps what was asked. */
function replay(answers: Record<string, unknown | ((body: unknown) => Response)>) {
  const asked: { method: string; path: string; body: unknown; auth: string | null }[] = [];
  const f: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    asked.push({ method, path: url.pathname + url.search, body, auth: new Headers(init?.headers).get("authorization") });
    const a = answers[`${method} ${url.pathname}`];
    if (a === undefined) return new Response("{}", { status: 404 });
    if (typeof a === "function") return (a as (b: unknown) => Response)(body);
    return Response.json(a);
  };
  return { f, asked };
}

describe("1Click", () => {
  it("walks a top-up from Solana to the deposit step and follows it to the end", async () => {
    const { f, asked } = replay({
      "GET /v0/tokens": fx.tokens,
      "POST /v0/quote": (b: unknown) => Response.json((b as { dry: boolean }).dry ? fx.topUp.dry : fx.topUp.wet),
      "GET /v0/status": fx.topUp.status.SUCCESS,
    });
    const api = new OneClick({ fetch: f, token: "partner-key" });
    expect((await api.tokens()).length).toBe(fx.tokens.length);
    const preview = await api.quote(fx.topUp.dry.quoteRequest);
    expect(preview.quote.depositAddress).toBeUndefined();
    const wet = await api.quote(fx.topUp.wet.quoteRequest);
    expect(wet.quote.depositAddress).toBe("4kaeYXudWmAoke31uXPhnQTSg7BFy1VGJdey3x48hVQv");
    const done = progressOf(await api.status(wet.quote.depositAddress!));
    expect(done).toMatchObject({ stage: "done", amountOut: fx.topUp.status.SUCCESS.swapDetails.amountOut, refunded: null, deposited: "10000000" });
    expect(asked.map((a) => `${a.method} ${a.path.split("?")[0]}`)).toEqual(["GET /v0/tokens", "POST /v0/quote", "POST /v0/quote", "GET /v0/status"]);
    expect(asked[3]!.path).toBe("/v0/status?depositAddress=4kaeYXudWmAoke31uXPhnQTSg7BFy1VGJdey3x48hVQv");
    expect(asked.every((a) => a.auth === "Bearer partner-key")).toBe(true);
  });

  it("reads 1Click's recorded answer for an address nothing has reached yet", () => {
    // Recorded live: every amount is null, the refund is the string "0", no transactions.
    expect(progressOf(fx.topUp.status.PENDING_DEPOSIT)).toEqual({
      stage: "waiting",
      status: "PENDING_DEPOSIT",
      correlationId: "d6cdf435-d5fe-4f1d-b3e9-3508acf0db44",
      updatedAt: "2026-11-08T10:48:35.808Z",
      deposited: null,
      amountOut: null,
      refunded: null,
      refundReason: null,
      txs: [],
    });
  });

  it("names every status the way the screen says it, REFUNDED and FAILED included", () => {
    const stages = Object.fromEntries(
      Object.entries(fx.topUp.status as Record<string, StatusResponse>).map(([k, v]) => [k, progressOf(v).stage]),
    );
    expect(stages).toEqual({
      PENDING_DEPOSIT: "waiting",
      KNOWN_DEPOSIT_TX: "seen",
      PROCESSING: "moving",
      SUCCESS: "done",
      INCOMPLETE_DEPOSIT: "short",
      REFUNDED: "refunded",
      FAILED: "failed",
    });
    const refunded = progressOf(fx.topUp.status.REFUNDED);
    expect(refunded).toMatchObject({ refunded: "10000000", refundReason: "QUOTE_EXPIRED", amountOut: null });
    expect(refunded.txs[0]!.explorerUrl).toMatch(/^https:\/\/solscan\.io\//);
    expect(final("refunded") && final("failed") && final("short") && final("done")).toBe(true);
    expect(final("waiting") || final("seen") || final("moving")).toBe(false);
    expect(() => progressOf({ ...fx.topUp.status.FAILED, status: "LOST" })).toThrow();
  });

  it("passes 1Click's own refusal through", async () => {
    const { f } = replay({ "POST /v0/quote": () => Response.json(fx.errors.tooSmall.body, { status: 400 }) });
    const err = await new OneClick({ fetch: f }).quote(fx.topUp.dry.quoteRequest).catch((e) => e);
    expect(err).toBeInstanceOf(OneClickError);
    expect(err).toMatchObject({ status: 400, message: fx.errors.tooSmall.body.message });
  });

  it("says when 1Click does not answer at all", async () => {
    const f: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const err = await new OneClick({ fetch: f }).tokens().catch((e) => e);
    expect(err).toMatchObject({ status: 0 });
  });

  it("cashes out: quote, the intent to sign, the signed intent, its status", async () => {
    const { f, asked } = replay({
      "POST /v0/quote": fx.cashOut.wet,
      "POST /v0/generate-intent": { intent: fx.cashOut.intent.webauthn, correlationId: "x" },
      "POST /v0/submit-intent": fx.cashOut.submit,
      "GET /v0/status": fx.cashOut.status.SUCCESS,
    });
    const api = new OneClick({ fetch: f });
    const q = await api.quote(fx.cashOut.wet.quoteRequest);
    const intent = await api.generateIntent({ depositAddress: q.quote.depositAddress!, signerId: fx.account, standard: "webauthn" });
    expect(asked[1]!.body).toEqual({ type: "swap_transfer", depositAddress: q.quote.depositAddress, signerId: fx.account, standard: "webauthn" });
    expect(intent.standard).toBe("webauthn");
    const sent = await api.submitIntent({
      standard: "webauthn",
      payload: intent.payload as string,
      public_key: "p256:x",
      signature: "p256:y",
      client_data_json: "{}",
      authenticator_data: "AA",
    });
    expect(asked[2]!.body).toMatchObject({ type: "swap_transfer", signedData: { standard: "webauthn" } });
    expect(sent.intentHash).toBe(fx.cashOut.submit.intentHash);
    const p = progressOf(await api.status(q.quote.depositAddress!));
    expect(p.stage).toBe("done");
    expect(p.txs[0]!.explorerUrl).toMatch(/^https:\/\/basescan\.org\/tx\//);
  });
});

describe("the intent a person signs", () => {
  const wet = fx.cashOut.wet;
  const expected = {
    signer: fx.account,
    depositAddress: wet.quote.depositAddress,
    asset: wet.quoteRequest.originAsset,
    amount: wet.quote.amountIn,
    notAfter: wet.quote.deadline,
    now: new Date("2026-11-08T10:48:40.000Z"),
  };
  const web = fx.cashOut.intent.webauthn as { standard: "webauthn"; payload: string };
  const edit = (f: (m: Record<string, unknown>) => void): UnsignedIntent => {
    const m = JSON.parse(web.payload);
    f(m);
    return { standard: "webauthn", payload: JSON.stringify(m) };
  };

  it("is signed when it moves exactly the agreed coin to the quote's address (1Click's recorded intents)", () => {
    expect(checkIntent(web, expected)).toEqual({ ok: true });
    expect(checkIntent(fx.cashOut.intent.nep413, expected)).toEqual({ ok: true });
  });

  it("lives no longer than its quote, and half an hour when the quote does not say", () => {
    const { notAfter: _, ...bare } = expected;
    expect(checkIntent(web, bare)).toMatchObject({ ok: false, why: "deadline is too far away: 2026-11-11T11:03:36.477Z" });
    expect(checkIntent(web, { ...expected, notAfter: "2026-11-10T00:00:00.000Z" }).ok).toBe(false);
  });

  it("is signed only once it is dated to the cash-out quote's fifteen minutes, not the address's three days", () => {
    const quoteEnds = wet.quoteRequest.deadline;
    const short = { ...expected, notAfter: quoteEnds };
    // 1Click dates its intent as late as the deposit address lives: the page refuses that as it is.
    expect(checkIntent(web, short)).toMatchObject({ ok: false, why: "deadline is too far away: 2026-11-11T11:03:36.477Z" });
    for (const intent of [web, fx.cashOut.intent.nep413 as UnsignedIntent]) {
      const dated = withDeadline(intent, quoteEnds)!;
      expect(checkIntent(dated, short)).toEqual({ ok: true });
      const text = dated.standard === "webauthn" ? dated.payload : dated.payload.message;
      const was = intent.standard === "webauthn" ? intent.payload : intent.payload.message;
      expect(JSON.parse(text).deadline).toBe("2026-11-08T11:03:36.477Z");
      // Nothing but the date moved, byte for byte.
      expect(text).toBe(was.replace("2026-11-11T11:03:36.477Z", "2026-11-08T11:03:36.477Z"));
      if (dated.standard === "nep413" && intent.standard === "nep413") expect(dated.payload.nonce).toBe(intent.payload.nonce);
    }
    expect(intentDeadline(withDeadline(web, quoteEnds)!)).toBe(Date.parse("2026-11-08T11:03:36.477Z"));
    expect(intentDeadline(fx.cashOut.intent.nep413)).toBe(Date.parse("2026-11-11T11:03:36.477Z"));
    expect(intentDeadline({ standard: "webauthn", payload: "{" })).toBeNull();
    // It never lives longer than it already did.
    expect(withDeadline(web, "2026-12-01T00:00:00.000Z")).toEqual(web);
    expect(withDeadline(web, "soon")).toBeNull();
    expect(withDeadline({ standard: "webauthn", payload: "{" }, quoteEnds)).toBeNull();
    expect(withDeadline({ standard: "webauthn", payload: '{"intents":[]}' }, quoteEnds)).toBeNull();
    // A payload that names the same deadline twice (here in a nested object) is not one this page rewrites.
    const twice = web.payload.replace('"intents":[', '"intents":[{"when":{"deadline":"2026-11-11T11:03:36.477Z"}},');
    expect(withDeadline({ standard: "webauthn", payload: twice }, quoteEnds)).toBeNull();
  });

  it("is refused for anything more than that", () => {
    const bad: [string, UnsignedIntent][] = [
      ["another receiver", edit((m) => ((m.intents as { receiver_id: string }[])[0]!.receiver_id = "thief.near"))],
      ["more coins", edit((m) => ((m.intents as { tokens: Record<string, string> }[])[0]!.tokens["nep141:wrap.near"] = "4000000000000000000000001"))],
      ["another coin", edit((m) => ((m.intents as { tokens: Record<string, string> }[])[0]!.tokens = { "nep141:usdt.tether-token.near": "1" }))],
      ["a second intent", edit((m) => (m.intents as unknown[]).push({ intent: "transfer", receiver_id: "x", tokens: {} }))],
      ["another kind", edit((m) => ((m.intents as { intent: string }[])[0]!.intent = "ft_withdraw"))],
      ["a call riding along", edit((m) => ((m.intents as { msg?: string }[])[0]!.msg = "{}"))],
      ["another signer", edit((m) => (m.signer_id = "0x0000000000000000000000000000000000000000"))],
      ["another contract", edit((m) => (m.verifying_contract = "intents.evil.near"))],
      ["a later deadline than the quote's", edit((m) => (m.deadline = "2026-11-12T11:03:36.477Z"))],
      ["a past deadline", edit((m) => (m.deadline = "2026-11-08T10:00:00.000Z"))],
      ["a short nonce", edit((m) => (m.nonce = base64(new Uint8Array(8))))],
      ["an extra field", edit((m) => (m.extra = 1))],
      ["not JSON", { standard: "webauthn", payload: "{" }],
    ];
    for (const [why, intent] of bad) expect([why, checkIntent(intent, expected).ok]).toEqual([why, false]);
    const nep = fx.cashOut.intent.nep413;
    expect(checkIntent({ ...nep, payload: { ...nep.payload, recipient: "evil.near" } }, expected).ok).toBe(false);
    expect(checkIntent({ ...nep, payload: { ...nep.payload, callbackUrl: "https://x" } }, expected).ok).toBe(false);
    expect(checkIntent(nep, { ...expected, signer: "maskfan.near" }).ok).toBe(false);
  });
});

describe("a quote read back before it is used", () => {
  const cash = quoteView(fx.cashOut.wet);
  const top = quoteView(fx.topUp.wet);
  const out = {
    account: fx.account,
    from: "nep141:wrap.near",
    to: fx.cashOut.wet.quoteRequest.destinationAsset,
    recipient: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
    recipientType: "DESTINATION_CHAIN" as const,
    amountIn: "3000000000000000000000000",
    seen: fx.cashOut.dry.quote.amountOut,
  };
  const into = { account: fx.account, from: fx.topUp.wet.quoteRequest.originAsset, to: "nep141:wrap.near", recipient: fx.account, recipientType: "INTENTS" as const };

  it("gives the page 1Click's terms: receiver, coins, refunds and the promised minimum", () => {
    expect(cash).toMatchObject({
      dry: false,
      depositAddress: fx.cashOut.wet.quote.depositAddress,
      recipient: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
      refundTo: fx.account,
      minAmountOut: "10981445",
      deadline: "2026-11-08T11:03:36.477Z",
      closes: "2026-11-11T11:03:36.477Z",
    });
    expect(previewView(cash)).toMatchObject({ recipient: null, refundTo: null, depositAddress: null, amountOut: cash.amountOut });
  });

  it("holds for what the person typed (1Click's recorded quotes)", () => {
    expect(checkQuote(cash, out)).toEqual({ ok: true });
    expect(checkQuote(top, { ...into, seen: fx.topUp.dry.quote.amountOut })).toEqual({ ok: true });
  });

  it("is refused when anything differs from it", () => {
    const bad: [string, ReturnType<typeof checkQuote>][] = [
      ["another receiver", checkQuote({ ...cash, recipient: "0x0000000000000000000000000000000000000001" }, out)],
      ["another coin out", checkQuote({ ...cash, destinationAsset: "nep141:usdt.tether-token.near" }, out)],
      ["another coin in", checkQuote({ ...cash, originAsset: "nep141:usdt.tether-token.near" }, out)],
      ["refunds elsewhere", checkQuote({ ...cash, refundTo: "thief.near" }, out)],
      ["refunds on the origin chain", checkQuote({ ...cash, refundType: "ORIGIN_CHAIN" }, out)],
      ["into NEAR Intents instead of the chain", checkQuote({ ...cash, recipientType: "INTENTS" }, out)],
      ["more out of the vault", checkQuote({ ...cash, amountIn: "3000000000000000000000001" }, out)],
      ["a minimum past 1%", checkQuote({ ...cash, minAmountOut: "10900000" }, out)],
      ["a minimum above the amount", checkQuote({ ...cash, minAmountOut: "11092370" }, out)],
      ["nothing out", checkQuote({ ...cash, amountOut: "0", minAmountOut: "0" }, out)],
      ["a preview", checkQuote({ ...cash, dry: true }, out)],
      ["a top-up landing elsewhere", checkQuote({ ...top, recipient: "thief.near" }, into)],
    ];
    for (const [why, c] of bad) expect([why, c.ok]).toEqual([why, false]);
  });

  it("says when the price slid away from the preview the person saw", () => {
    const c = checkQuote(cash, { ...out, seen: "11500000" });
    expect(c).toEqual({ ok: false, why: "the price moved", moved: true });
    expect(checkQuote(cash, { ...out, seen: "11300000" }).ok).toBe(true);
    expect(checkQuote(cash, { ...out, seen: null }).ok).toBe(true);
  });
});

describe("vault accounts", () => {
  it("are a passkey's 0x account or a NEAR mainnet account", () => {
    expect(vaultAccountOk("0x3602b546589a8fcafdce7fad64a46f91db0e4d50")).toBe(true);
    expect(vaultAccountOk("maskfan.near")).toBe(true);
    expect(vaultAccountOk("423df0a6640e9467769c55a573f15b9ee999dc8970048959c72890abf5cc3a8e")).toBe(true);
    expect(vaultAccountOk("0x3602B546589a8fcafdce7fad64a46f91db0e4d50")).toBe(false);
    expect(vaultAccountOk("nova.tinygif8324.testnet")).toBe(false);
    expect(vaultAccountOk("Mask.near")).toBe(false);
    expect(vaultAccountOk("a")).toBe(false);
  });
});

describe("NEAR wallets", () => {
  it("turn a NEP-413 signature into the signed intent", () => {
    const payload = fx.cashOut.intent.nep413.payload;
    expect(nonceBytes(payload)).toHaveLength(32);
    const sig = new Uint8Array(64).fill(9);
    const s = signedNep413(payload, { accountId: "maskfan.near", publicKey: "ed25519:5TagutioHgKLh7KZ1VEFBYfgRkPtqnKm9LoMnJMJugxm", signature: base64(sig) });
    expect(s).toMatchObject({ standard: "nep413", public_key: "ed25519:5TagutioHgKLh7KZ1VEFBYfgRkPtqnKm9LoMnJMJugxm" });
    expect(s.signature).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{86,88}$/);
    const again = signedNep413(payload, { accountId: "maskfan.near", publicKey: "ed25519:5TagutioHgKLh7KZ1VEFBYfgRkPtqnKm9LoMnJMJugxm", signature: s.signature });
    expect(again.signature).toBe(s.signature);
    expect(() => signedNep413(payload, { accountId: "a", publicKey: "ed25519:5Tag", signature: base64(sig) })).toThrow();
  });
});

describe("ledger", () => {
  it("reads a vault's balances from NEAR Intents, falling back to the second RPC", async () => {
    const calls: string[] = [];
    const f: typeof fetch = async (input, init) => {
      calls.push(String(input));
      if (String(input).includes("first")) return new Response("busy", { status: 502 });
      const req = JSON.parse(String(init!.body));
      const args = JSON.parse(atob(req.params.args_base64));
      expect(req.params).toMatchObject({ request_type: "call_function", account_id: "intents.near", finality: "final" });
      if (req.params.method_name === "mt_batch_balance_of") {
        expect(args).toEqual({ account_id: fx.account, token_ids: ["nep141:wrap.near", "x"] });
        return Response.json({ jsonrpc: "2.0", id: "maskwars", result: { result: viewResult(["4210000000000000000000000", "0"]) } });
      }
      expect(args).toEqual({ account_id: "maskfan.near", public_key: "ed25519:abc" });
      return Response.json({ jsonrpc: "2.0", id: "maskwars", result: { result: viewResult(true) } });
    };
    const ledger = new Ledger({ rpcs: ["https://first", "https://second"], fetch: f });
    expect(await ledger.balances(fx.account, ["nep141:wrap.near", "x"])).toEqual([4_210_000_000_000_000_000_000_000n, 0n]);
    expect(await ledger.hasKey("maskfan.near", "ed25519:abc")).toBe(true);
    expect(calls).toEqual(["https://first", "https://second", "https://first", "https://second"]);
  });

  it("gives no numbers when no RPC answers", async () => {
    const f: typeof fetch = async () => new Response("down", { status: 503 });
    await expect(new Ledger({ rpcs: ["https://a"], fetch: f }).balances("x", ["y"])).rejects.toThrow(/503/);
  });
});
