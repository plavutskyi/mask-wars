#!/usr/bin/env node
// Checks a signed MASK CHECK answer with nothing but Node: who signed it, that it says what was signed, which rules
// made it and how old it is.
//
//   node services/check/verify.mjs answer.json                     the key and the rules deployment.json names
//   node services/check/verify.mjs answer.json ed25519:<base58>    the key you trust
//   node services/check/verify.mjs answer.json --max-age 600       and read from the chain within the last 10 minutes
//   node services/check/verify.mjs answer.json --rules <sha256>    and made by exactly these rules
//   curl … | node services/check/verify.mjs -
//
// Takes what OutLayer's HTTPS API returns for the call, the module's own `{ success, output, error }`, or the
// `output` alone.
// Exit 0: the signature is the trusted key's and the signed message says exactly what `check` says.
// Exit 1: it is not verified. That includes having no key to trust: a signature proves nothing until you say whose
//         it must be, since anyone can sign anything with a key of their own.
// Exit 2: nothing to verify (a preview, an unsigned answer, an error, a file that is not an answer, a wrong argument).
import { createPublicKey, verify as verifySignature } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** The first field of a signed message and the shape that follows it (lib.rs: `MESSAGE_VERSION`). */
export const MESSAGE_VERSION = 2;

/** How far a block's time may be ahead of this machine's clock before the clock is the thing to check. */
const CLOCK_SLACK_SECONDS = 120;

/** Base58 as NEAR writes keys, to bytes. */
export function base58(text) {
  let n = 0n;
  for (const c of text) {
    const digit = B58.indexOf(c);
    if (digit < 0) throw new Error(`not base58: ${text}`);
    n = n * 58n + BigInt(digit);
  }
  const zeros = text.length - text.replace(/^1+/, "").length;
  const hex = n === 0n ? "" : n.toString(16);
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex")]);
}

/** The module's answer inside whatever wraps it. */
export function answerOf(body) {
  let at = body;
  // OutLayer: { call_id, status, output }, then the module: { success, output, error }.
  for (let i = 0; i < 2 && at && typeof at === "object" && !("tier" in at) && "output" in at; i++) at = at.output;
  return at && typeof at === "object" && "tier" in at ? at : null;
}

/** JSON values that say the same, whatever order their fields come in. */
function same(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const [ka, kb] = [Object.keys(a), Object.keys(b)];
  return ka.length === kb.length && ka.every((k) => k in b && same(a[k], b[k]));
}

/** Seconds as a person reads them: `40 s`, `12 min`, `3 h`, `2 d`. */
export function span(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s} s`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} d`;
}

/**
 * Verifies a signed answer.
 * - `key`: the key you trust (`ed25519:<base58>`), required. The key an answer names is only a claim.
 * - `rules`: when given, the answer must be made by exactly these rules (the module's `module.rules`).
 * - `maxAgeSeconds`: when given, the block the answer was read at must be no older than this. The age is counted
 *   from the block's own time, which comes from the chain; `checked_at` is the clock of the machine that ran the
 *   module, and that machine sets it.
 * - `now`: the time to count the age from, in milliseconds. Default: this machine's clock.
 */
export function verify(body, { key: trusted, rules, maxAgeSeconds, now = Date.now() } = {}) {
  const answer = answerOf(body);
  if (!answer) return { ok: false, nothing: true, why: "not a MASK CHECK answer" };
  const { check, signed } = answer;
  if (!signed) return { ok: false, nothing: true, why: `the ${answer.tier} tier carries no signature` };
  if (!trusted) return { ok: false, why: `no key to trust: the answer names ${signed.key}, and anyone can sign with a key of their own. Pass the project's key` };
  if (signed.alg !== "ed25519") return { ok: false, why: `unknown signature scheme: ${signed.alg}` };
  if (signed.key !== trusted) return { ok: false, why: `signed by ${signed.key}, not by ${trusted}` };
  let raw;
  try {
    raw = base58(String(trusted).replace(/^ed25519:/, ""));
  } catch {
    return { ok: false, why: "the key is not base58" };
  }
  if (raw.length !== 32) return { ok: false, why: "the key is not 32 bytes" };
  // An ed25519 public key as SubjectPublicKeyInfo: a fixed 12-byte header, then the 32 bytes.
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
  if (typeof signed.message !== "string" || typeof signed.signature !== "string") return { ok: false, why: "no message or no signature" };
  if (!verifySignature(null, Buffer.from(signed.message, "utf8"), publicKey, Buffer.from(signed.signature, "base64"))) {
    return { ok: false, why: "the signature does not match the message" };
  }
  let said;
  try {
    said = JSON.parse(signed.message);
  } catch {
    return { ok: false, why: "the signed message is not JSON" };
  }
  if (!said || typeof said !== "object" || Array.isArray(said)) return { ok: false, why: "the signed message is not a MASK CHECK answer" };
  const { maskwars_check: mark, module, ...rest } = said;
  if (mark !== MESSAGE_VERSION) return { ok: false, why: `the signed message is not a MASK CHECK answer of this version (maskwars_check ${MESSAGE_VERSION})` };
  if (!module || typeof module.version !== "string" || !/^[0-9a-f]{64}$/.test(String(module.rules))) return { ok: false, why: "the signed message does not name the module that made it" };
  if (!same(rest, check)) return { ok: false, why: "`check` is not what was signed" };
  if (rules && module.rules !== rules) return { ok: false, why: `made by rules ${module.rules} (module ${module.version}), not by ${rules}` };

  // From here on only what was signed is read.
  const readMs = rest.block ? Date.parse(rest.block.time) : Number.NaN;
  const ageSeconds = Number.isFinite(readMs) ? (now - readMs) / 1000 : null;
  if (maxAgeSeconds !== undefined) {
    if (ageSeconds === null) return { ok: false, why: "the chain was not read, so no block says how old the answer is" };
    if (ageSeconds < -CLOCK_SLACK_SECONDS) return { ok: false, why: `the block's time, ${rest.block.time}, is ahead of this machine's clock` };
    if (ageSeconds > maxAgeSeconds) return { ok: false, why: `read from the chain ${span(ageSeconds)} ago (block ${rest.block.height}, ${rest.block.time}): older than ${span(maxAgeSeconds)}` };
  }
  return { ok: true, key: signed.key, module, check: rest, ageSeconds };
}

/** The arguments of the command line: the file, the key, and the options. `null` when they make no sense. */
export function argumentsOf(argv) {
  const out = { file: null, key: null, rules: null, maxAgeSeconds: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max-age" || a === "--rules") {
      const value = argv[++i];
      if (value === undefined) return null;
      if (a === "--rules") {
        if (!/^[0-9a-f]{64}$/.test(value)) return null;
        out.rules = value;
      } else {
        if (!/^\d+$/.test(value)) return null;
        out.maxAgeSeconds = Number(value);
      }
    } else if (a.startsWith("--")) return null;
    else if (out.file === null) out.file = a;
    else if (out.key === null && a.startsWith("ed25519:")) out.key = a;
    else return null;
  }
  return out.file === null ? null : out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = argumentsOf(process.argv.slice(2));
  if (!args) {
    console.error("usage: verify.mjs <answer.json | -> [ed25519:<key you trust>] [--max-age <seconds>] [--rules <sha256>]");
    process.exit(2);
  }
  let body;
  try {
    body = JSON.parse(readFileSync(args.file === "-" ? 0 : args.file, "utf8"));
  } catch (error) {
    console.error(`cannot read ${args.file}: ${error.message}`);
    process.exit(2);
  }
  // No key on the command line: the published one, with the rules published next to it.
  const published = JSON.parse(readFileSync(new URL("./deployment.json", import.meta.url), "utf8"));
  const key = args.key ?? published.key ?? null;
  const rules = args.rules ?? (args.key ? null : (published.rules ?? null));
  const r = verify(body, { key, rules, maxAgeSeconds: args.maxAgeSeconds });
  if (!r.ok) {
    console.error(r.nothing ? `NOTHING TO VERIFY: ${r.why}` : `NOT VERIFIED: ${r.why}`);
    if (!r.nothing && !key) console.error("deployment.json names no key until a version is published: pass ed25519:<the project's key>.");
    process.exit(r.nothing ? 2 : 1);
  }
  const c = r.check;
  const read = c.block ? `block ${c.block.height}, ${c.block.time} (${span(r.ageSeconds)} ago)` : "chain unread";
  console.log(`VERIFIED: ${c.verdict.toUpperCase()} ${c.account} on ${c.network}, ${read}`);
  console.log(`signed by ${r.key}, ${args.key ? "the key you passed" : "the key in deployment.json"}`);
  console.log(`module ${r.module.version}, rules ${r.module.rules}${rules ? "" : " (not compared: pass --rules to hold the answer to one version)"}`);
}
