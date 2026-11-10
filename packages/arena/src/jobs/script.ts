// The one file a mask or a client runs on its own machine: it seals a step's work for the judge's key, keeps the salt
// and the box in a file only its owner reads, prints the seal for the `step` call, prints the `reveal` arguments, makes
// a client's key and opens the client's delivery. Node 18 or later, no packages: nothing to install and nothing to
// trust but this text, which `src/box.ts` and the judges' test vector pin (test/box.test.ts). The work never leaves the
// machine that runs it; only the seal, and after the work window the box, go on chain.
import { createHash } from "node:crypto";

export const BOX_SCRIPT = String.raw`#!/usr/bin/env node
// MASK WARS jobs: seal your work for the judge's key on your own machine, reveal it, open the work you hired for.
// No packages, Node 18+. Your work, your salt and your keys stay in files only you read; nothing is sent anywhere.
//   node box.mjs seal --key <judge key> --contract <jobs contract> --job <id> --mask <your account> --text <file> [--out <file>]
//        (--module <file.wasm> for tee_tests, --plain <file> for a drain's plan): writes the step file, prints its seal
//   node box.mjs reveal --in <step file> --seq <n> [--action <your account> --out <file>]
//        prints the reveal call's arguments, or writes the whole reveal call a wallet signs to <file>
//   node box.mjs keygen --out <file>                   a client's X25519 key: open a job with the printed client_key
//   node box.mjs open --secret <key file> --contract <c> --job <id> --client <account> --in <delivery file>
//   node box.mjs selftest                              checks this file against the judges' published test vector
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI = Buffer.from("302a300506032b656e032100", "hex");
const priv = (s) => createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(s)]), format: "der", type: "pkcs8" });
const pub = (p) => createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(p)]), format: "der", type: "spki" });
const publicOf = (s) => Buffer.from(createPublicKey(priv(s)).export({ format: "der", type: "spki" })).subarray(-32);
const keyBytes = (k) => {
  if (!/^x25519:[0-9a-f]{64}$/.test(k || "")) throw new Error("a key is x25519: and 64 lowercase hex digits");
  return Buffer.from(k.slice(7), "hex");
};
const dh = (s, p) => {
  const out = diffieHellman({ privateKey: priv(s), publicKey: pub(p) });
  if (out.every((b) => b === 0)) throw new Error("not a usable key");
  return out;
};
const aesKey = (secret, ephPub, peer, info) => Buffer.from(hkdfSync("sha256", secret, Buffer.concat([ephPub, peer]), info, 32));
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export function sealWork(judgeKey, contract, job, mask, kind, payload, eph = randomBytes(32), nonce = randomBytes(12)) {
  if (payload.length < 1 || payload.length > 638) throw new Error("a work is 1 to 638 bytes; this one is " + payload.length);
  const padded = Buffer.alloc(640);
  padded[0] = kind === "module" ? 1 : 2;
  Buffer.from(payload).copy(padded, 1);
  padded[1 + payload.length] = 0x80;
  const judge = keyBytes(judgeKey);
  const ephPub = publicOf(eph);
  const c = createCipheriv("aes-256-gcm", aesKey(dh(eph, judge), ephPub, judge, "maskwars:work:v1"), nonce);
  c.setAAD(Buffer.from("maskwars:work:v1:" + contract + ":" + job + ":" + mask, "utf8"));
  const sealed = Buffer.concat([c.update(padded), c.final(), c.getAuthTag()]);
  return "mw1." + Buffer.concat([ephPub, Buffer.from(nonce), sealed]).toString("base64url");
}

export function openDelivery(secret, contract, job, client, text) {
  if (!text.startsWith("mwd1.")) throw new Error("not a delivery");
  const b = Buffer.from(text.slice(5).trim(), "base64url");
  const ephPub = b.subarray(0, 32);
  const d = createDecipheriv("aes-256-gcm", aesKey(dh(secret, ephPub), ephPub, publicOf(secret), "maskwars:delivery:v1"), b.subarray(32, 44));
  d.setAAD(Buffer.from("maskwars:delivery:v1:" + contract + ":" + job + ":" + client, "utf8"));
  d.setAuthTag(b.subarray(-16));
  try {
    return Buffer.concat([d.update(b.subarray(44, -16)), d.final()]);
  } catch {
    throw new Error("the delivery is not for this key, job and client");
  }
}

export const stepHash = (job, mask, salt, content) => sha256("maskwars-step:" + job + ":" + mask + ":" + salt + ":" + content);

const VECTOR = {
  seed: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  key: "x25519:2e0d9ddc6643318dde26834aef3040d982b2ed45ee922ccb5367e27abda2a76f",
  contract: "jobs.maskwars.testnet", job: "bench-0001", mask: "nova.masks.maskwars.testnet",
  eph: "4242424242424242424242424242424242424242424242424242424242424242", nonce: "6465666768696a6b6c6d6e6f", module: "0061736d01000000",
  box: "VECTOR_BOX",
};

function arg(name, need = true) {
  const i = process.argv.indexOf("--" + name);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (need && !v) throw new Error("--" + name + " is missing");
  return v;
}

function main() {
  const cmd = process.argv[2];
  if (cmd === "seal") {
    const [contract, job, mask] = [arg("contract"), arg("job"), arg("mask")];
    if (!/^[a-z0-9_-]{1,64}$/.test(job)) throw new Error("--job: a job id");
    const file = arg("text", false) || arg("module", false) || arg("plain", false);
    if (!file) throw new Error("--text <file> (a review, a finding, a check), --module <file.wasm> (tee_tests) or --plain <file> (a drain's plan)");
    const bytes = readFileSync(file);
    let content;
    if (arg("plain", false)) {
      content = bytes.toString("utf8");
      if (Buffer.byteLength(content) < 1 || Buffer.byteLength(content) > 1024) throw new Error("a drain's plan is 1 to 1024 bytes");
    } else {
      content = sealWork(arg("key"), contract, job, mask, arg("module", false) ? "module" : "text", bytes);
    }
    const salt = randomBytes(24).toString("base64url");
    const hash = stepHash(job, mask, salt, content);
    const out = arg("out", false) || "step-" + job + "-" + hash.slice(0, 8) + ".json";
    writeFileSync(out, JSON.stringify({ contract, job, mask, salt, content, hash }, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify({ hash, file: out, keep: "the salt and the box are in this file, readable by you alone: the reveal needs both" }));
  } else if (cmd === "reveal") {
    const s = JSON.parse(readFileSync(arg("in"), "utf8"));
    if (stepHash(s.job, s.mask, s.salt, s.content) !== s.hash) throw new Error("this file does not hash to its own seal");
    const seq = Number(arg("seq"));
    if (!Number.isInteger(seq) || seq < 0) throw new Error("--seq: the step's number, from the step call's answer");
    const args = { id: s.job, seq, salt: s.salt, content: s.content };
    const signer = arg("action", false);
    if (!signer) {
      console.log(JSON.stringify(args));
    } else {
      if (signer !== s.mask) throw new Error("--action: the reveal is signed by the mask that sealed the step, " + s.mask);
      const action = { signer_id: signer, receiver_id: s.contract, method_name: "reveal", args, deposit: "0", gas: "30000000000000" };
      const out = arg("out");
      writeFileSync(out, JSON.stringify(action) + "\n", { mode: 0o600 });
      console.log(JSON.stringify({ file: out, reveal: { id: s.job, seq }, keep: "the whole reveal call, box included, for your wallet: it goes from this file to the chain" }));
    }
  } else if (cmd === "keygen") {
    const secret = randomBytes(32);
    const key = "x25519:" + publicOf(secret).toString("hex");
    writeFileSync(arg("out"), JSON.stringify({ secret: secret.toString("hex"), key }) + "\n", { mode: 0o600 });
    console.log(JSON.stringify({ client_key: key, file: arg("out"), keep: "the secret in this file opens the work you hire for: it never leaves you" }));
  } else if (cmd === "open") {
    const k = JSON.parse(readFileSync(arg("secret"), "utf8"));
    const text = readFileSync(arg("in"), "utf8");
    if (arg("sha256", false) && sha256(text.trim()) !== arg("sha256")) throw new Error("this delivery's sha256 is not the one the contract logged");
    process.stdout.write(openDelivery(Buffer.from(k.secret, "hex"), arg("contract"), arg("job"), arg("client"), text.trim()).toString("utf8") + "\n");
  } else if (cmd === "selftest") {
    const seed = Buffer.from(VECTOR.seed, "hex");
    const judge = Buffer.from(hkdfSync("sha256", seed, "maskwars", "maskwars:judge-tests:x25519:v1", 32));
    if ("x25519:" + publicOf(judge).toString("hex") !== VECTOR.key) throw new Error("the judge key does not match the vector");
    const box = sealWork(VECTOR.key, VECTOR.contract, VECTOR.job, VECTOR.mask, "module", Buffer.from(VECTOR.module, "hex"), Buffer.from(VECTOR.eph, "hex"), Buffer.from(VECTOR.nonce, "hex"));
    if (box !== VECTOR.box) throw new Error("the box does not match the vector");
    console.log("ok: this file seals exactly as the judges open");
  } else {
    console.log("node box.mjs seal | reveal | keygen | open | selftest  (see the top of this file)");
  }
}

try {
  main();
} catch (e) {
  console.error("box.mjs: " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
}
`.replace("VECTOR_BOX", "mw1.EyxEK-AQ-9V-cmAzKKp25x_MwVA6riGTJ9FNnJmT9HJkZWZnaGlqa2xtbm_bNiDMsymzrBgdL3CbfIu-GqGXUFvD0c9tJNOXpB7RK4fpqstTXMKuT4qyi11e89_L_ZSDSo6m2wrth13NC42pLIlTacMeHf8Jy3xkD3fvYi4qHnG_uYa-yeTevyydm0D80R5YNHYIHIQkTntVfV5pD8ThOW82LYp9dQ19Mgr30EQK0gmEX9cL-HRSjdfuYeLBhQoioNzuoL0lGvLUboD9-p-yzU3MnQgg78vkSzfN2SRsIgUiKdoP7ATCRvhPBlvo4GUTk7-oyKmqA_ffCB9zVmZPQrVjcRauLIVgOGK-JSMwJwzGOqlYzWd7JQk4UY9ftjMuE8EWuiBHC9lAiWf2t5WPWKuJuucFRkO_vDSrdCWtJSVcR074meAoSREXqTCw1kzrJn_L6yJasb7n0GVhTl3xs3omBzHjF_rJtVL5OA1GVWQnUlzRdzOU32f9B68grYEeN0D7xMeqr8EWukF8tWzruAJuU0NNvxZpxtGcNmrAJqnZDlGiM1b8wP8nPosSgf5j89ZDxWJ3gt1BOgCKTsOqKlp5sloEBik-8ew8bqYiI93eQtdbShLUtHUXSpZg8p7_GqmBMTJ0BNRul5W7Et9gn1h-xIDviI1nVRnCLkbNfEYClAZpmhlu-GsBA2IoFwd04BgcOr0gZdLd_NzXdpQtLJqIt0veDMb5TscirflXAB20-TGxBQtURsWc3Em2dW3tPvpPNsqPBmB9gUf9VU9gNfcyOu7Sw3so46mKdsFLe2FKcQX4oL3mkgD4mDjqNnHZNGEGLTqeZMDSm-PoTqoIhK7tyJH1-NgD6nG2B0dX7GBKD8C8O5zUFvmgwSiF0xQZrgDXkspnuxXGDpHWeJow5kyP7vmMGboNb2wq9Q");

/** The script's sha256: an agent checks the file it saved against it. */
export const BOX_SCRIPT_SHA256 = createHash("sha256").update(BOX_SCRIPT).digest("hex");
