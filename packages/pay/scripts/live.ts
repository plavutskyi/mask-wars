/**
 * 1Click itself, with no money: the token list, a top-up from Solana and from Base up to its deposit address, the
 * address's status, and a cash-out up to the intent a passkey would sign, read back through the same check the page
 * runs before it signs, and the page's own fifteen-minute intent submitted from a fresh vault that holds nothing, next to
 * 1Click's three-day one: 1Click must treat both the same. Nothing is deposited and no money can move.
 *
 *   pnpm --filter @maskwars/pay live [--record]
 *
 * --record writes every answer to test/fixtures/oneclick.live.json and prints it between RECORD markers.
 * Exits 1 when an answer is not what the page expects, 4 when 1Click does not answer. ONE_CLICK_API_KEY is used if set.
 */
import { writeFileSync } from "node:fs";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  accountOf,
  base64url,
  challengeOf,
  concat,
  hex,
  signedWebauthn,
  utf8,
  withDeadline,
  type SignedWebauthn,
  type UnsignedIntent,
  CHAINS,
  cashOutRequest,
  catalogOf,
  checkIntent,
  coinText,
  OneClick,
  OneClickError,
  progressOf,
  topUpRequest,
  depositUnits,
  type Coin,
  type QuoteResponse,
} from "../src/index.ts";

// The vault of near/intents' own passkey test vector: a real account that nobody here holds a key to. Nothing is sent.
const ACCOUNT = "0x3602b546589a8fcafdce7fad64a46f91db0e4d50";
const BASE_ADDRESS = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
const record = process.argv.includes("--record");
// Quotes wait for market makers: give them time, and say how long each answer took.
const api = new OneClick({ token: process.env.ONE_CLICK_API_KEY ?? "", timeoutMs: 45_000 });
const recorded: Record<string, unknown> = { recordedAt: new Date().toISOString(), account: ACCOUNT, keyed: Boolean(process.env.ONE_CLICK_API_KEY) };
let failed = false;

const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};

async function step<T>(name: string, run: () => Promise<T>): Promise<T | null> {
  const t0 = Date.now();
  try {
    const out = await run();
    recorded[name] = out;
    console.log(`     ${name} answered in ${Date.now() - t0} ms`);
    return out;
  } catch (error) {
    if (error instanceof OneClickError) {
      recorded[name] = { error: { status: error.status, body: error.body ?? error.message, ms: Date.now() - t0 } };
      // No token list at all means 1Click is down for us; any later step failing is a finding, not an outage.
      if (error.status === 0 && name === "tokens") {
        console.error(error.message);
        process.exit(4);
      }
      check(false, `${name}: 1Click ${error.status || "no answer"} ${error.message} (${Date.now() - t0} ms)`);
      return null;
    }
    throw error;
  }
}

const tokens = await step("tokens", () => api.tokens());
const catalog = tokens ? catalogOf(tokens) : null;
check(catalog !== null, "NEAR is listed, a vault has something to hold");
if (!catalog) process.exit(1);
for (const chain of CHAINS) {
  const found = catalog.chains.find((c) => c.id === chain.id)?.coins.map((c) => c.symbol) ?? [];
  check(found.length === chain.coins.length, `${chain.name}: ${chain.coins.map((c) => `${c.symbol}${found.includes(c.symbol) ? "" : " (missing)"}`).join(", ")}`);
}

const coin = (chain: string, symbol: string): Coin | null => catalog.chains.find((c) => c.id === chain)?.coins.find((c) => c.symbol === symbol) ?? null;
const show = (q: QuoteResponse, from: Coin, to: Coin) =>
  `${coinText(q.quote.amountIn, from.decimals)} ${from.symbol} → ${coinText(q.quote.amountOut, to.decimals)} ${to.symbol}`;

// Which shape of request 1Click answers, and how fast: the page's own (FLEX_INPUT, refunds to the vault) next to
// plainer ones. Only previews; nothing here hands out an address.
{
  const usdc = coin("sol", "USDC");
  if (usdc) {
    const base = topUpRequest({ account: ACCOUNT, from: usdc, amount: depositUnits(10, usdc), dry: true });
    const variants: [string, typeof base][] = [
      ["probeExactInput", { ...base, swapType: "EXACT_INPUT" }],
      ["probeWait3s", { ...base, quoteWaitingTimeMs: 3000 }],
      ["probeRefundOnSolana", { ...base, refundType: "ORIGIN_CHAIN", refundTo: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" }],
    ];
    for (const [name, req] of variants) {
      const q = await step(name, () => api.quote(req));
      if (q) console.log(`     ${name}: ${show(q, usdc, catalog.near)}`);
    }
  }
}

// Top up: $10 of USDC from Solana and from Base, a preview each, then a real deposit address for Solana.
for (const [chain, name] of [["sol", "topUpSolDry"], ["base", "topUpBaseDry"]] as const) {
  const from = coin(chain, "USDC");
  if (!from) continue;
  const q = await step(name, () => api.quote(topUpRequest({ account: ACCOUNT, from, amount: depositUnits(10, from), dry: true })));
  if (q) check(BigInt(q.quote.amountOut) > 0n && !q.quote.depositAddress, `top up from ${chain}: ${show(q, from, catalog.near)}`);
}
const usdcSol = coin("sol", "USDC");
if (usdcSol) {
  const wet = await step("topUpSolWet", () => api.quote(topUpRequest({ account: ACCOUNT, from: usdcSol, amount: depositUnits(10, usdcSol), dry: false })));
  if (wet) {
    check(typeof wet.quote.depositAddress === "string" && wet.quote.depositAddress.length > 30, `deposit address on Solana: ${wet.quote.depositAddress}`);
    const st = await step("topUpSolStatus", () => api.status(wet.quote.depositAddress!));
    if (st) check(progressOf(st).stage === "waiting", `status before any transfer: ${st.status}`);
  }
}

// Cash out: 3 NEAR from the vault to USDC on Base, a preview, then the intent a passkey and a NEAR wallet would sign.
const usdcBase = coin("base", "USDC");
if (usdcBase) {
  const amount = 3n * 10n ** BigInt(catalog.near.decimals);
  const dry = await step("cashOutDry", () => api.quote(cashOutRequest({ account: ACCOUNT, from: catalog.near, to: usdcBase, recipient: BASE_ADDRESS, amount, dry: true })));
  if (dry) check(BigInt(dry.quote.amountOut) > 0n, `cash out to Base: ${show(dry, catalog.near, usdcBase)}`);
  const wet = await step("cashOutWet", () => api.quote(cashOutRequest({ account: ACCOUNT, from: catalog.near, to: usdcBase, recipient: BASE_ADDRESS, amount, dry: false })));
  if (wet?.quote.depositAddress) {
    const expected = { signer: ACCOUNT, depositAddress: wet.quote.depositAddress, asset: catalog.near.assetId, amount: wet.quote.amountIn, ...(wet.quote.deadline ? { notAfter: wet.quote.deadline } : {}) };
    for (const standard of ["webauthn", "nep413"] as const) {
      const intent = await step(`cashOutIntent_${standard}`, () => api.generateIntent({ depositAddress: wet.quote.depositAddress!, signerId: ACCOUNT, standard }));
      if (intent) {
        const c = checkIntent(intent, expected);
        check(c.ok, `${standard} intent reads as exactly the agreed transfer${c.ok ? "" : `: ${c.why}`}`);
      }
    }
  } else if (wet) {
    check(false, "cash-out quote has no deposit address");
  }
}

// The intent the page signs is dated to the cash-out quote (15 minutes), not to the deposit address (three days). From a
// fresh software passkey whose vault holds nothing, 1Click must answer the page's shortened intent exactly as it answers
// its own; a receiver it never issued shows what a refusal of the payload itself looks like.
async function probe(name: string, run: () => Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    const out = await run();
    recorded[name] = out;
    return { status: 200, message: "accepted" };
  } catch (error) {
    if (!(error instanceof OneClickError)) throw error;
    recorded[name] = { error: { status: error.status, body: error.body ?? error.message } };
    // Hashes, nonces and accounts differ between the two; the kind of answer must not.
    return { status: error.status, message: error.message.replace(/0x[0-9a-f]{40}|[0-9a-f]{64}|[1-9A-HJ-NP-Za-km-z]{32,}|[A-Za-z0-9+/]{43}=/g, "…") };
  }
}
if (usdcBase) {
  const secret = p256.utils.randomSecretKey();
  const key = p256.getPublicKey(secret, false).slice(1);
  const fresh = accountOf(key);
  const sign = (payload: string): SignedWebauthn | null => {
    const authenticatorData = concat(sha256(utf8("maskwars.xyz")), Uint8Array.of(0x1d), new Uint8Array(4));
    const clientDataJSON = utf8(JSON.stringify({ type: "webauthn.get", challenge: base64url(challengeOf(payload)), origin: "https://maskwars.xyz", crossOrigin: false }));
    const signature = p256.sign(sha256(concat(authenticatorData, sha256(clientDataJSON))), secret, { prehash: false, format: "der" });
    return signedWebauthn(payload, key, { authenticatorData, clientDataJSON, signature });
  };
  const amount = 3n * 10n ** BigInt(catalog.near.decimals);
  // Two quotes, so one submission cannot stand in the way of the other.
  const quote = (name: string) => step(name, () => api.quote(cashOutRequest({ account: fresh, from: catalog.near, to: usdcBase, recipient: BASE_ADDRESS, amount, dry: false })));
  const wet = await quote("shortQuoteOurs");
  const wet2 = await quote("shortQuoteTheirs");
  const at = wet?.quote.depositAddress;
  const at2 = wet2?.quote.depositAddress;
  const ours0 = at ? await step("shortIntentOurs", () => api.generateIntent({ depositAddress: at, signerId: fresh, standard: "webauthn" })) : null;
  const theirs = at2 ? await step("shortIntentTheirs", () => api.generateIntent({ depositAddress: at2, signerId: fresh, standard: "webauthn" })) : null;
  if (wet && wet2 && at && at2 && theirs && ours0) {
    const expected = { signer: fresh, depositAddress: at, asset: catalog.near.assetId, amount: wet.quote.amountIn, notAfter: wet.quoteRequest.deadline };
    const ours = withDeadline(ours0, wet.quoteRequest.deadline) as UnsignedIntent | null;
    check(!checkIntent(ours0, expected).ok, `1Click's own intent outlives the quote (${JSON.parse(ours0.payload as string).deadline}), so the page does not sign it as it is`);
    check(ours !== null && checkIntent(ours, expected).ok, `dated to the quote (${wet.quoteRequest.deadline}) it reads as exactly the agreed transfer`);
    const a = ours ? sign(ours.payload as string) : null;
    const b = sign(theirs.payload as string);
    const forged = JSON.parse(theirs.payload as string);
    forged.intents[0].receiver_id = hex(crypto.getRandomValues(new Uint8Array(32)));
    const c = sign(JSON.stringify(forged));
    if (a && b && c) {
      const short = await probe("shortSubmitOurs", () => api.submitIntent(a));
      const long = await probe("shortSubmitTheirs", () => api.submitIntent(b));
      const other = await probe("shortSubmitForged", () => api.submitIntent(c));
      console.log(`     submit, 15-minute intent: ${short.status} ${short.message}`);
      console.log(`     submit, 1Click's 3-day intent: ${long.status} ${long.message}`);
      console.log(`     submit, a receiver 1Click never issued: ${other.status} ${other.message}`);
      check(short.status === long.status && short.message === long.message, "1Click answers the page's 15-minute intent as it answers its own");
    } else {
      check(false, "the software passkey signs");
    }
  }
}

if (record) {
  // The token list keeps only the coins on offer: the full list is thousands of lines no test reads.
  const offered = new Set([catalog.near.assetId, ...catalog.chains.flatMap((c) => c.coins.map((x) => x.assetId))]);
  recorded.tokens = (tokens ?? []).filter((t) => offered.has(t.assetId));
  writeFileSync(new URL("../test/fixtures/oneclick.live.json", import.meta.url), `${JSON.stringify(recorded, null, 2)}\n`);
  // One line per answer: a log line is cut at 64 KB.
  for (const [k, v] of Object.entries(recorded)) console.log(`RECORD ${k} ${JSON.stringify(v)}`);
}
process.exit(failed ? 1 : 0);
