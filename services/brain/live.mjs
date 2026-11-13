#!/usr/bin/env node
// The mind's road checked on the live network, with no mask on it and no round open. It spends about two cents from
// the payment key: one run that tells the mind's key and one probe per model.
//
//   OUTLAYER_PAYMENT_KEY=<owner:nonce:secret> node services/brain/live.mjs [--version <sha256>] [--model <id>]
//   node services/brain/live.mjs --key-number 1          reads the key through the OutLayer CLI, never printing it
//
// 1. key: the module answers with its public key, and the key is the one the factory seals strategies for
//    (`config().strategy_key`, read from the chain by this machine). A project whose secrets were written anew fails
//    here: its masks' strategies would no longer open.
// 2. probe, once per model: inside the TEE the module reads the factory over the worker's RPC and asks the model one
//    small question in a request of four writes of its body (a real attempt is seventeen), sent the same way. A module that
//    cannot write a long request, a project with no NEAR AI key, a model NEAR AI does not serve: each fails here, hours
//    before a round and not in it.
//
// --version asks one build by its sha256 before it is the project's active version: check first, activate after.
// Exit 0: every step answered as it must. 1: one did not. 4: OutLayer was not reached.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const arg = (name) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const network = JSON.parse(readFileSync(new URL("../../packages/network/mainnet.json", import.meta.url), "utf8"));
const words = JSON.parse(readFileSync(new URL("./mind.json", import.meta.url), "utf8"));
const api = (process.env.OUTLAYER_API || network.outlayer?.api || "https://api.outlayer.ai").replace(/\/$/, "");
const owner = network.admin ?? "maskwars.near";
const project = process.env.BRAIN_PROJECT || `${owner}/brain`;
const factory = arg("--factory") ?? `masks.${owner}`;
const rpc = process.env.NEAR_RPC || "https://rpc.mainnet.fastnear.com";
const version = arg("--version");
const models = arg("--model") ? [arg("--model")] : words.models;
if (version && !/^[0-9a-f]{64}$/.test(version)) stop("--version is the sha256 of a build, 64 hex characters", 1);

function stop(why, code) {
  console.error(`STOP: ${why}`);
  process.exit(code);
}

/** The payment key: from the environment, or through the OutLayer CLI by its number. Never printed. */
function paymentKey() {
  const fromEnv = process.env.OUTLAYER_PAYMENT_KEY?.trim();
  if (fromEnv) return fromEnv;
  const nonce = arg("--key-number");
  if (!/^\d{1,9}$/.test(nonce ?? "")) stop("set OUTLAYER_PAYMENT_KEY, or name the key: --key-number <n>", 1);
  const cli = [process.env.OUTLAYER_CLI, fileURLToPath(new URL("../../.scratch/outlayer/outlayer.exe", import.meta.url)), "outlayer"].find(
    (path) => path && (path === "outlayer" || existsSync(path)),
  );
  let shown;
  try {
    shown = execFileSync(cli, ["keys", "show", nonce], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    stop(`outlayer keys show ${nonce} failed: ${String(error.stderr || error.message).trim().split("\n")[0]}`, 1);
  }
  const found = new RegExp(`${owner.replace(/\./g, "\\.")}:${nonce}:[^\\s"'\`]+`).exec(shown);
  if (!found) stop(`outlayer keys show ${nonce} printed no key of the form ${owner}:${nonce}:<secret>`, 1);
  return found[0];
}

const key = paymentKey();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One run of the module, asked async and read until it is over: `{ ok, output, error, seconds }`. */
async function run(input, seconds) {
  const started = Date.now();
  const body = {
    input,
    async: true,
    resource_limits: { max_instructions: 1_000_000_000, max_memory_mb: 128, max_execution_seconds: seconds },
    secrets_ref: { profile: "default", account_id: owner },
    ...(version ? { version_key: version } : {}),
  };
  let call;
  try {
    const sent = await fetch(`${api}/call/${project}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-payment-key": key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!sent.ok) return { ok: false, error: `OutLayer answered ${sent.status}: ${(await sent.text()).slice(0, 200)}`, reached: sent.status < 500 };
    call = await sent.json();
  } catch (error) {
    return { ok: false, unreachable: true, error: `OutLayer was not reached: ${error.name}` };
  }
  const deadline = started + (seconds + 120) * 1000;
  if (call?.status === "pending" && !call.call_id) return { ok: false, error: "the run has no call id to read it by" };
  while (call?.status === "pending" && Date.now() < deadline) {
    await sleep(3_000);
    const read = await fetch(`${api}/calls/${encodeURIComponent(call.call_id)}`, { headers: { "x-payment-key": key }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!read?.ok) continue;
    const next = await read.json().catch(() => null);
    if (next?.status) call = { ...next, call_id: next.call_id ?? call.call_id };
  }
  const took = Math.round((Date.now() - started) / 1000);
  if (call?.status !== "completed") return { ok: false, error: `the run is ${call?.status ?? "unreadable"}${call?.error ? `: ${call.error}` : ""}`, seconds: took };
  const wrapped = call.output;
  if (!wrapped || typeof wrapped !== "object" || !("success" in wrapped)) return { ok: false, error: "the module's answer is unreadable", seconds: took };
  return { ok: wrapped.success === true, output: wrapped.output, error: wrapped.error ?? null, seconds: took };
}

/** `config()` of the factory, from the chain. */
async function factoryConfig() {
  const said = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "live", method: "query", params: { request_type: "call_function", finality: "final", account_id: factory, method_name: "config", args_base64: "e30=" } }),
    signal: AbortSignal.timeout(15_000),
  })
    .then((res) => res.json())
    .catch(() => null);
  if (!said?.result?.result) stop(`${factory}.config gave no result from ${rpc}`, 4);
  return JSON.parse(Buffer.from(said.result.result).toString("utf8"));
}

let failed = false;
const line = (ok, text) => {
  if (!ok) failed = true;
  console.log(`${ok ? "ok  " : "FAIL"} ${text}`);
};

console.log(`${project}${version ? ` @ ${version.slice(0, 8)}…` : " (active version)"} on ${api}, factory ${factory}`);

const config = await factoryConfig();
const told = await run({ action: "key" }, 60);
// No answer to the first call at all: nothing was checked, and that is not the mind's own failure.
if (told.unreachable) {
  console.error(`STOP: ${told.error}`);
  process.exitCode = 4;
} else line(told.ok && told.output?.key === config.strategy_key, `key: ${told.ok ? `${String(told.output?.key).slice(0, 22)}… ${told.output?.key === config.strategy_key ? "is the factory's" : `is NOT the factory's (${String(config.strategy_key).slice(0, 22)}…)`}` : told.error}`);

for (const model of told.unreachable ? [] : models) {
  const probed = await run({ action: "probe", factory, model }, 120);
  const out = probed.output ?? {};
  const reached = probed.ok && out.key === true && (out.answered === true || out.cut === true);
  const how = !probed.ok
    ? probed.error
    : `${out.answered ? "answered" : out.cut ? "reached, still thinking at the probe's allowance" : "no answer"}; request ${out.asked_bytes} bytes; factory key ${out.key ? "matches" : "DOES NOT match"}; ${probed.seconds} s`;
  line(reached, `probe ${model}: ${how}`);
}

if (!told.unreachable) {
  console.log(failed ? "\nThe mind is NOT ready for a round." : "\nThe mind is ready: the key is the factory's and every model answered a request of several writes.");
  process.exitCode = failed ? 1 : 0;
}
