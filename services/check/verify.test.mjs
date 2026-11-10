// verify.mjs against an answer the module itself gave (sample.json, held to the module by `cargo test`), and against
// answers signed here with a key of our own, the way a forger would.
//   node --test services/check/
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MESSAGE_VERSION, answerOf, argumentsOf, base58, span, verify } from "./verify.mjs";

const sample = JSON.parse(readFileSync(new URL("./sample.json", import.meta.url), "utf8"));
/** RFC 8032's first test key, the one sample.json is signed with. Its seed is public: anyone signs with it. */
const KEY = "ed25519:FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z";
const RULES = sample.output.module.rules;
const copy = () => structuredClone(sample);
/** The time of the block sample.json was read at. */
const READ = Date.parse(sample.output.check.block.time);

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function toBase58(bytes) {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let out = "";
  for (; n > 0n; n /= 58n) out = B58[Number(n % 58n)] + out;
  return out;
}

/**
 * A key nobody trusts, and an answer signed with it. `change` edits the check before it is signed; `write` makes the
 * message from the check, the module's own way unless told otherwise.
 */
function forged(change = () => {}, write = (check) => ({ maskwars_check: MESSAGE_VERSION, module: sample.output.module, ...check })) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = `ed25519:${toBase58(publicKey.export({ format: "der", type: "spki" }).subarray(-32))}`;
  const check = structuredClone(sample.output.check);
  change(check);
  const message = JSON.stringify(write(check));
  const signature = sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64");
  return { key, answer: { success: true, output: { ...sample.output, check, signed: { alg: "ed25519", key, message, signature } }, error: null } };
}

/** The command line, as a caller runs it. */
function run(body, ...args) {
  const file = join(mkdtempSync(join(tmpdir(), "maskwars-verify-")), "answer.json");
  writeFileSync(file, JSON.stringify(body));
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("./verify.mjs", import.meta.url)), file, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("the module's signature verifies with Node alone, against the key you trust", () => {
  const r = verify(sample, { key: KEY });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.key, KEY);
  assert.deepEqual([r.check.verdict, r.check.account, r.check.reasons[0].code], ["block", "safe-0001.tinygif8324.testnet", "arena_drained"]);
  assert.equal(Buffer.from(base58(KEY.slice(8))).toString("hex"), "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
});

test("it reads the answer inside OutLayer's response, the module's output, or alone", () => {
  for (const body of [{ call_id: "c", status: "completed", output: sample }, sample, sample.output]) {
    assert.equal(answerOf(body).tier, "signed");
    assert.equal(verify(body, { key: KEY }).ok, true);
  }
});

test("without a key to trust nothing is verified: a forger's own signature is whole and proves nothing", () => {
  // The forger turns the block into an allow and signs it with a key of their own.
  const { key, answer } = forged((check) => {
    check.verdict = "allow";
    check.summary = "No signals against this account were found.";
    check.reasons = check.reasons.filter((r) => r.level === "info");
  });
  for (const options of [undefined, {}, { key: null }, { key: "" }]) {
    const r = verify(answer, options);
    assert.equal(r.ok, false);
    assert.notEqual(r.nothing, true);
    assert.match(r.why, /^no key to trust: the answer names ed25519:/);
  }
  // The same holds for the real answer: who signed it is the caller's to say.
  assert.match(verify(sample).why, /^no key to trust/);
  // Against the key the caller trusts the forgery is another key's.
  assert.equal(verify(answer, { key: KEY }).why, `signed by ${key}, not by ${KEY}`);
  // And it does verify against the forger's key: the signature is fine, which is exactly why a key must be named.
  assert.equal(verify(answer, { key }).ok, true);
});

test("the command line exits 1 without a trusted key and prints no VERIFIED line", () => {
  const { answer } = forged((check) => void (check.verdict = "allow"));
  for (const body of [answer, sample]) {
    const r = run(body);
    assert.equal(r.code, 1, r.err);
    assert.equal(r.out, "");
    assert.match(r.err, /^NOT VERIFIED: /);
  }
  const ok = run(sample, KEY);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /^VERIFIED: BLOCK safe-0001\.tinygif8324\.testnet on testnet, block \d+, 2026-11-08T23:30:47Z \(.+ ago\)\nsigned by ed25519:FVen.+, the key you passed\nmodule \d+\.\d+\.\d+, rules [0-9a-f]{64}/);
  assert.equal(run(answer, KEY).code, 1);
  assert.equal(run({ success: true, output: { tier: "preview", check: {}, signed: null }, error: null }, KEY).code, 2);
  assert.equal(run(sample, KEY, "--max-age").code, 2);
  assert.equal(run(sample, KEY, "--no-such-option").code, 2);
});

test("a changed verdict, reason or evidence does not verify", () => {
  const verdict = copy();
  verdict.output.check.verdict = "allow";
  assert.match(verify(verdict, { key: KEY }).why, /`check` is not what was signed/);
  const evidence = copy();
  evidence.output.check.reasons[0].evidence.winner = "onyx.tinygif8324.testnet";
  assert.equal(verify(evidence, { key: KEY }).ok, false);
  const message = copy();
  message.output.signed.message = message.output.signed.message.replace('"verdict":"block"', '"verdict":"allow"');
  assert.match(verify(message, { key: KEY }).why, /the signature does not match the message/);
});

test("another key's signature is refused, and so is an answer that names a key it was not signed with", () => {
  assert.match(verify(sample, { key: "ed25519:11111111111111111111111111111111" }).why, /^signed by ed25519:FVen/);
  const renamed = copy();
  renamed.output.signed.key = "ed25519:11111111111111111111111111111111";
  assert.match(verify(renamed, { key: "ed25519:11111111111111111111111111111111" }).why, /the signature does not match the message/);
  assert.match(verify(sample, { key: "ed25519:not-base58-0OIl" }).why, /^signed by/);
});

test("a signature names the rules that made it, and an answer made by other rules is refused", () => {
  const r = verify(sample, { key: KEY, rules: RULES });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(Object.keys(r.module), ["version", "rules"]);
  assert.match(sample.output.signed.message, new RegExp(`^\\{"maskwars_check":${MESSAGE_VERSION},"module":\\{"version":"[0-9.]+","rules":"${RULES}"\\},"account":`));
  const other = "0".repeat(64);
  assert.equal(verify(sample, { key: KEY, rules: other }).why, `made by rules ${RULES} (module ${r.module.version}), not by ${other}`);
  assert.equal(run(sample, KEY, "--rules", other).code, 1);
  assert.equal(run(sample, KEY, "--rules", RULES).code, 0);
  // A message of the first shape, properly signed but with no module in it, is not an answer of this version:
  // nothing in it says which rules made it.
  const first = forged(undefined, (check) => ({ maskwars_check: 1, ...check }));
  assert.equal(verify(first.answer, { key: first.key }).why, "the signed message is not a MASK CHECK answer of this version (maskwars_check 2)");
  const nameless = forged(undefined, (check) => ({ maskwars_check: MESSAGE_VERSION, ...check }));
  assert.equal(verify(nameless.answer, { key: nameless.key }).why, "the signed message does not name the module that made it");
});

test("the age is counted from the block's time, not from the clock of the machine that answered", () => {
  const minute = 60_000;
  assert.equal(verify(sample, { key: KEY, maxAgeSeconds: 600, now: READ + minute }).ageSeconds, 60);
  assert.equal(verify(sample, { key: KEY, maxAgeSeconds: 600, now: READ + 600_000 }).ok, true);
  assert.equal(verify(sample, { key: KEY, maxAgeSeconds: 600, now: READ + 601_000 }).why, "read from the chain 10 min ago (block 276842544, 2026-11-08T23:30:47Z): older than 10 min");
  // Without a limit an old answer is still a true record of that block, and its age is reported.
  assert.equal(verify(sample, { key: KEY, now: READ + 86_400_000 }).ageSeconds, 86_400);

  // The machine that ran the module says it answered a moment ago; the block it read is an hour old.
  const now = Date.parse("2026-11-09T12:00:00Z");
  const stale = forged((check) => {
    check.checked_at = "2026-11-09T11:59:58Z";
    check.block.time = "2026-11-09T11:00:00Z";
  });
  assert.match(verify(stale.answer, { key: stale.key, maxAgeSeconds: 600, now }).why, /^read from the chain 60 min ago .*older than 10 min$/);
  // And the other way round: an old `checked_at` does not age an answer read from a fresh block.
  const fresh = forged((check) => {
    check.checked_at = "2020-01-01T00:00:00Z";
    check.block.time = "2026-11-09T11:59:30Z";
  });
  assert.equal(verify(fresh.answer, { key: fresh.key, maxAgeSeconds: 600, now }).ok, true);

  // No block, no age: an answer that could not read the chain never passes a limit.
  const unread = forged((check) => void (check.block = null));
  assert.equal(verify(unread.answer, { key: unread.key, now }).ageSeconds, null);
  assert.equal(verify(unread.answer, { key: unread.key, maxAgeSeconds: 600, now }).why, "the chain was not read, so no block says how old the answer is");
  // A block from the future says the clock here is wrong.
  const ahead = forged((check) => void (check.block.time = "2026-11-09T13:00:00Z"));
  assert.match(verify(ahead.answer, { key: ahead.key, maxAgeSeconds: 600, now }).why, /is ahead of this machine's clock$/);

  const old = run(sample, KEY, "--max-age", "600");
  assert.equal(old.code, 1);
  assert.match(old.err, /^NOT VERIFIED: read from the chain .* ago \(block 276842544, 2026-11-08T23:30:47Z\): older than 10 min/);
});

test("a preview, an unsigned answer and an error have nothing to verify", () => {
  const preview = { success: true, output: { tier: "preview", check: { verdict: "block" }, signed: null }, error: null };
  assert.deepEqual([verify(preview, { key: KEY }).ok, verify(preview, { key: KEY }).nothing], [false, true]);
  const unsigned = { success: true, output: { tier: "unsigned", check: sample.output.check, signed: null }, error: null };
  assert.deepEqual([verify(unsigned, { key: KEY }).nothing, verify(unsigned, { key: KEY }).why], [true, "the unsigned tier carries no signature"]);
  assert.equal(verify({ success: false, output: null, error: "payment required" }, { key: KEY }).nothing, true);
});

test("the arguments: a file, a key, an age and the rules", () => {
  assert.deepEqual(argumentsOf(["a.json"]), { file: "a.json", key: null, rules: null, maxAgeSeconds: undefined });
  assert.deepEqual(argumentsOf(["-", KEY, "--max-age", "600", "--rules", RULES]), { file: "-", key: KEY, rules: RULES, maxAgeSeconds: 600 });
  assert.deepEqual(argumentsOf(["--max-age", "0", "a.json"]), { file: "a.json", key: null, rules: null, maxAgeSeconds: 0 });
  for (const bad of [[], ["a.json", "not-a-key"], ["a.json", "--max-age"], ["a.json", "--max-age", "ten"], ["a.json", "--rules", "abc"], ["a.json", "--key", KEY], ["a.json", KEY, KEY]]) {
    assert.equal(argumentsOf(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual([span(40), span(600), span(3 * 3600), span(3 * 86_400)], ["40 s", "10 min", "3 h", "3 d"]);
});
