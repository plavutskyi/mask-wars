#!/usr/bin/env node
// The first calls to a published version of the MASK CHECK module, over OutLayer's HTTPS API, and what each one
// answered. It spends about $0.03 from the payment key: seven runs and two signed verdicts.
//
//   OUTLAYER_PAYMENT_KEY=<owner:nonce:secret> node services/check/live.mjs [--record]
//
// 1. about: the price, the signing key and the rules, with the run's TEE attestation.
// 2. a preview, free: a mainnet lookalike that does not exist.
// 3. a signed verdict asked with nothing attached: refused, with the exact header, before the chain is read.
// 4. a payment short of the price ($0.000001): answered as a preview with a note, never refused.
// 5. a signed verdict on testnet: the arena's safe, with the signature checked against the key of step 1.
// 6. a signed verdict on mainnet: NEAR Intents, read from two providers that must agree.
// 7. a payment the caller writes into its own secrets: no signed verdict comes of it (see below).
// Steps 5 and 6 are also asked of the TypeScript check from this machine: the verdict and the reasons must match.
//
// Step 7 needs a secrets row of the caller's own that holds USD_PAYMENT=10000, named in
// OUTLAYER_FORGED_SECRETS=<account>:<profile>. OutLayer is expected to refuse to store that name at all; if it does
// store it, the call must come back as a preview or be refused. Without the variable the step says so and is not run.
//
// --record writes the key, the rules and the module's sha256 into deployment.json: from that commit on the site and
// the MCP server name this address. It records only a module that is the file in apps/web/public/outlayer.
// Exit 0: every step answered as it must. 1: one did not. 4: OutLayer was not reached.
// Without OUTLAYER_PAYMENT_KEY no key is sent: for a network that adds the header itself.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { verify } from "./verify.mjs";

const file = new URL("./deployment.json", import.meta.url);
const deployment = JSON.parse(readFileSync(file, "utf8"));
const record = process.argv.includes("--record");
const api = new URL(deployment.api);
const url = new URL(`/call/${deployment.project}`, api).href;
const price = String(deployment.price_usd_micro);
const key = process.env.OUTLAYER_PAYMENT_KEY?.trim();
const forgedRow = process.env.OUTLAYER_FORGED_SECRETS?.trim();
/** How old a signed answer may be when it is checked here, counted from the block it was read at. */
const MAX_AGE_SECONDS = 300;

let failed = false;
const say = (line = "") => console.log(line);
function must(ok, what) {
  say(`   ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
}

/**
 * One call. Returns OutLayer's response and the module's `{ success, output, error }` inside it. `more` joins the
 * body next to `input`. With `mayRefuse`, an HTTP error is an answer of its own and comes back; without it the
 * script ends there.
 */
async function call(input, { deposit, more = {}, mayRefuse = false } = {}) {
  const headers = { "content-type": "application/json", ...(key ? { "x-payment-key": key } : {}), ...(deposit ? { "x-attached-deposit": deposit } : {}) };
  let res;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ input, ...more }), signal: AbortSignal.timeout(120_000) });
  } catch (error) {
    say(`   OutLayer was not reached: ${error.cause?.message ?? error.message}`);
    process.exit(4);
  }
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: the line below shows what came instead.
  }
  say(`   POST ${url}${deposit ? `   X-Attached-Deposit: ${deposit}` : ""}`);
  say(`   input ${JSON.stringify(input)}${Object.keys(more).length ? `   ${JSON.stringify(more)}` : ""}`);
  say(`   HTTP ${res.status}, run ${body?.status ?? "?"}, call ${body?.call_id ?? "?"}, compute $${Number(body?.compute_cost ?? 0) / 1e6}, ${body?.instructions ?? "?"} instructions, ${body?.time_ms ?? "?"} ms`);
  if (!res.ok || body?.status !== "completed") say(`   ${text.slice(0, 400)}`);
  if (!res.ok && !mayRefuse) {
    const why = { 401: "OutLayer wants a payment key: set OUTLAYER_PAYMENT_KEY", 402: "the payment key has too little on it", 403: "this payment key may not call the project", 404: "the project is not published yet: publish.mjs" };
    say();
    say(`NOT LIVE: ${why[res.status] ?? `OutLayer answered ${res.status}`}.`);
    process.exit(1);
  }
  let module = body?.output ?? null;
  if (typeof module === "string") {
    try {
      module = JSON.parse(module);
    } catch {
      module = null;
    }
  }
  return { http: res.status, ok: res.ok, body, module };
}

/** What the TypeScript check says about the same account right now, read from this machine. */
async function local(account) {
  const { maskCheck, networkOf, readerFor, sharedLists } = await import("../../packages/check/src/index.ts");
  const network = networkOf(account);
  return maskCheck(account, { network, reader: readerFor(network), list: sharedLists[network] });
}

const codes = (check) => check.reasons.map((r) => `${r.level}:${r.code}`).join(" ");

say(`MASK CHECK on OutLayer ${deployment.outlayer}: ${deployment.project}, ${new Date().toISOString()}`);
say();
say("1. about");
const about = await call({ action: "about" });
const signer = about.module?.output?.key ?? null;
const tier = about.module?.output?.tiers?.signed;
const stated = about.module?.output?.module ?? null;
must(about.module?.success === true && typeof signer === "string", `the module answers; it signs with ${signer}`);
must(tier?.header === `X-Attached-Deposit: ${price}`, `a signed verdict costs $${tier?.usd}: ${tier?.header}`);
must(typeof stated?.rules === "string" && /^[0-9a-f]{64}$/.test(stated.rules), `module ${stated?.version}, rules ${stated?.rules}`);
let attested = null;
if (about.body?.attestation_url) {
  // The address comes from OutLayer's answer: the payment key goes with the request only to OutLayer's own API.
  const at = new URL(String(about.body.attestation_url), api);
  if (at.origin !== api.origin) {
    must(false, `the attestation is at ${at.origin}, not at ${api.origin}: not fetched`);
  } else {
    // The worker uploads the quote a moment after the run.
    for (let i = 0; i < 6 && !attested; i++) {
      const res = await fetch(at, { headers: key ? { "x-payment-key": key } : {}, redirect: "error", signal: AbortSignal.timeout(20_000) }).catch(() => null);
      if (res?.ok) attested = await res.json().catch(() => null);
      else await new Promise((r) => setTimeout(r, 5_000));
    }
    must(attested !== null, `the run's TEE attestation is at ${at.href}`);
    if (attested) say(`   wasm ${attested.wasm_hash ?? "?"}, quote of ${String(attested.tdx_quote ?? attested.quote ?? "").length} characters`);
  }
} else {
  must(false, "OutLayer names the run's attestation");
}

say();
say("2. a preview, free: treasury.intents.near, a lookalike that does not exist on mainnet");
const preview = await call({ account: "treasury.intents.near" });
const seen = preview.module?.output;
must(seen?.tier === "preview" && seen?.check?.verdict === "block", `preview: ${seen?.check?.verdict}, block ${seen?.check?.block?.height}`);
must(seen?.signed === null && !("reasons" in (seen?.check ?? {})) && !("payment" in (seen ?? {})), "no reasons, no signature and no word on a payment in a preview");

say();
say("3. a signed verdict asked with nothing attached");
const refused = await call({ account: "intents.near", signed: true });
must(refused.module?.success === false && String(refused.module?.error).includes(`Set the header X-Attached-Deposit: ${price}`), `refused: ${refused.module?.error}`);

say();
say("4. a payment short of the price: $0.000001");
const short = await call({ account: "treasury.intents.near" }, { deposit: "1" });
const under = short.module?.output;
must(short.module?.success === true && under?.tier === "preview" && under?.check?.verdict === "block", `answered, not refused: ${under?.tier}, ${under?.check?.verdict}`);
must(under?.payment?.attached_usd_micro === 1 && String(under?.payment?.note).includes(`Set the header X-Attached-Deposit: ${price}`), `with the note: ${under?.payment?.note}`);

let n = 5;
for (const [account, what] of [
  ["safe-0001.tinygif8324.testnet", "the arena's safe on testnet"],
  ["intents.near", "NEAR Intents on mainnet, two providers"],
]) {
  say();
  say(`${n}. a signed verdict, $${Number(price) / 1e6}: ${what}`);
  const paid = await call({ account }, { deposit: price });
  const out = paid.module?.output;
  must(out?.tier === "signed", `${out?.check?.verdict?.toUpperCase()} ${out?.check?.account} on ${out?.check?.network}, block ${out?.check?.block?.height}: ${out?.check ? codes(out.check) : (paid.module?.error ?? out?.note)}`);
  const v = signer ? verify(paid.module, { key: signer, rules: stated?.rules, maxAgeSeconds: MAX_AGE_SECONDS }) : { ok: false, why: "no key from step 1" };
  must(v.ok, v.ok ? `the signature is ${signer}'s, covers the whole answer, names the rules of step 1 and its block is ${Math.round(v.ageSeconds)} s old` : `signature: ${v.why}`);
  if (out?.check) {
    const here = await local(account);
    must(here.verdict === out.check.verdict && codes(here) === codes(out.check), `the TypeScript check says the same from this machine: ${here.verdict}, ${codes(here)} (block ${here.block?.height})`);
    if (n === 6) must(out.check.reasons.some((r) => r.code === "rpc_agree"), out.check.reasons.find((r) => r.code.startsWith("rpc_"))?.text ?? "no word on the providers");
  }
  n++;
}

say();
say("7. a payment the caller writes into its own secrets: USD_PAYMENT=10000, nothing attached");
if (!forgedRow) {
  say("   not run: no secrets row was named. To try it, store USD_PAYMENT=10000 in a secrets row of your own");
  say("   (OutLayer is expected to refuse that name) and set OUTLAYER_FORGED_SECRETS=<account>:<profile>.");
} else {
  const [account_id, profile] = forgedRow.split(":");
  const forged = await call({ account: "intents.near" }, { more: { secrets_ref: { account_id, profile } }, mayRefuse: true });
  const got = forged.module?.output;
  if (!forged.ok || forged.body?.status !== "completed") {
    say("   ok   OutLayer did not run the call with that row: nothing was signed");
  } else {
    must(got?.tier === "preview" && got?.signed === null && !("payment" in got), `the module answered a ${got?.tier}: a variable of the caller's own is not a payment`);
  }
}

say();
if (failed) {
  say("NOT LIVE: a step did not answer as it must. Nothing was recorded.");
  process.exit(1);
}
say(`LIVE: ${url}`);
if (record) {
  // Only the module of this checkout is recorded: the attested hash must be the file the site serves from here, and
  // the rules the module states must be the ones this checkout builds (sample.json, held to the sources by cargo test).
  const wasm = attested?.wasm_hash ?? null;
  const here = wasm ? new URL(`../../apps/web/public/outlayer/maskwars-check-${wasm}.wasm`, import.meta.url) : null;
  if (!wasm || !/^[0-9a-f]{64}$/.test(wasm)) {
    say("Not recorded: the attestation did not name the module's sha256.");
    process.exit(1);
  }
  if (!existsSync(here) || createHash("sha256").update(readFileSync(here)).digest("hex") !== wasm) {
    say(`Not recorded: OutLayer attests wasm ${wasm}, which is not a file of this checkout (apps/web/public/outlayer).`);
    process.exit(1);
  }
  const built = JSON.parse(readFileSync(new URL("./sample.json", import.meta.url), "utf8")).output.module;
  if (stated.rules !== built.rules) {
    say(`Not recorded: the module states rules ${stated.rules}, this checkout builds ${built.rules}.`);
    process.exit(1);
  }
  writeFileSync(file, `${JSON.stringify({ ...deployment, wasm_sha256: wasm, rules: stated.rules, key: signer }, null, 2)}\n`);
  say(`recorded in deployment.json: key ${signer}, wasm ${wasm}, rules ${stated.rules}`);
}
