/**
 * An outside agent's sign-up for the house's round: the script it runs signs exactly what the house and the site check,
 * and nothing else passes: another round, another network, another account, another key.
 */
import { execFile } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GUEST_RECIPIENT, JOIN_SCRIPT, JOIN_SCRIPT_SHA256, nep413Hash, signupMessage, signupNonce, signupProblems, slotText, verifyEd25519 } from "../src/guests.ts";

const SLOT = Date.UTC(2026, 10, 12, 18, 0);
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (b: Uint8Array) => {
  let n = BigInt(`0x${Buffer.from(b).toString("hex") || "0"}`);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    s = `1${s}`;
  }
  return s;
};

/** A NEAR key pair as near-cli keeps it: `ed25519:<base58 of seed and public half>`. */
function keyPair() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url");
  const pub = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(12);
  return { secret: `ed25519:${b58(Buffer.concat([seed, pub]))}`, public_key: `ed25519:${b58(pub)}`, key: privateKey };
}

describe("the message an agent signs", () => {
  it("names the account, the round and the network; its nonce is its own sha256", () => {
    expect(slotText(SLOT)).toBe("2026-11-12 18:00 UTC");
    const m = signupMessage("mainnet", SLOT, "agent.near");
    expect(m).toBe("MASK WARS: agent.near enters the house round of 2026-11-12 18:00 UTC on NEAR mainnet");
    expect(signupNonce(m).toString("hex")).toHaveLength(64);
    expect(GUEST_RECIPIENT).toBe("maskwars.xyz");
  });

  it("is signed as NEP-413: tag, message, nonce, recipient, no callback, then sha256", () => {
    const m = "hi";
    const nonce = Buffer.alloc(32, 7);
    // 4 bytes tag (2^31 + 413, little-endian), 4 + 2 message, 32 nonce, 4 + 12 recipient, 1 for no callback URL.
    const tag = Buffer.from([0x9d, 0x01, 0x00, 0x80]);
    const want = Buffer.concat([tag, Buffer.from([2, 0, 0, 0]), Buffer.from("hi"), nonce, Buffer.from([12, 0, 0, 0]), Buffer.from("maskwars.xyz"), Buffer.from([0])]);
    expect(nep413Hash(m, nonce).toString("hex")).toBe(createHash("sha256").update(want).digest("hex"));
  });
});

describe("a sign-up", () => {
  const k = keyPair();
  const signed = (account: string, slot = SLOT, network: "mainnet" | "testnet" = "mainnet") => {
    const m = signupMessage(network, slot, account);
    return sign(null, nep413Hash(m, signupNonce(m)), k.key).toString("base64");
  };

  it("passes with the account's signature of this very round", () => {
    expect(signupProblems({ account: "agent.near", public_key: k.public_key, signature: signed("agent.near"), slot: SLOT }, "mainnet", SLOT)).toEqual([]);
  });

  it("is refused for another round, network or account, a key that did not sign, or a malformed field", () => {
    const base = { account: "agent.near", public_key: k.public_key, signature: signed("agent.near"), slot: SLOT };
    expect(signupProblems({ ...base, slot: SLOT + 86_400_000 }, "mainnet", SLOT + 86_400_000)[0]).toMatch(/^signature: not a NEP-413 signature/);
    expect(signupProblems(base, "mainnet", SLOT + 86_400_000)[0]).toMatch(/^slot:/);
    expect(signupProblems(base, "testnet", SLOT)[0]).toMatch(/^signature:/);
    expect(signupProblems({ ...base, account: "other.near" }, "mainnet", SLOT)[0]).toMatch(/^signature:/);
    expect(signupProblems({ ...base, public_key: keyPair().public_key }, "mainnet", SLOT)[0]).toMatch(/^signature:/);
    expect(signupProblems({ ...base, account: "Bad Name" }, "mainnet", SLOT)[0]).toMatch(/^account:/);
    expect(signupProblems({ ...base, signature: "abc" }, "mainnet", SLOT)[0]).toMatch(/^signature: the 64-byte/);
    expect(verifyEd25519("ed25519:xyz", base.signature, Buffer.alloc(32))).toBe(false);
  });
});

describe("join.mjs, the script an agent runs", () => {
  it("signs on the agent's machine and sends exactly a sign-up the house accepts", async () => {
    const k = keyPair();
    const dir = mkdtempSync(join(tmpdir(), "join-"));
    const file = join(dir, "join.mjs");
    writeFileSync(file, JOIN_SCRIPT);
    expect(JOIN_SCRIPT_SHA256).toMatch(/^[0-9a-f]{64}$/);
    let got: unknown = null;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        got = { url: req.url, body: JSON.parse(body) };
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(process.execPath, [file, `http://127.0.0.1:${port}`, "testnet", String(SLOT)], { env: { ...process.env, NEAR_ACCOUNT_ID: "agent.testnet", NEAR_PRIVATE_KEY: k.secret, NODE_USE_ENV_PROXY: "", HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "" } }, (e) => (e ? reject(e) : resolve()));
      });
    } finally {
      server.close();
    }
    const { url, body } = got as { url: string; body: Record<string, unknown> };
    expect(url).toBe("/api/round/join");
    expect(body).toMatchObject({ network: "testnet", account: "agent.testnet", public_key: k.public_key, slot: SLOT });
    expect(signupProblems(body, "testnet", SLOT)).toEqual([]);
  });
});

describe("which round, and who can never be a guest", () => {
  it("a sign-up fills the next slot; the house opens the slot that came", async () => {
    const { NETWORKS } = await import("@maskwars/network");
    const { fillingSlot, openingSlot, arenaAccount } = await import("../src/guests.ts");
    const n = NETWORKS.mainnet;
    expect(fillingSlot(n, SLOT - 1)).toBe(SLOT);
    expect(fillingSlot(n, SLOT)).toBe(SLOT + 86_400_000);
    expect(openingSlot(n, SLOT + 4 * 60_000)).toBe(SLOT);
    for (const a of ["maskwars.near", "bounty.maskwars.near", "house.maskwars.near", "vault.house.maskwars.near", "nova.maskwars.near", "kira.masks.maskwars.near", "s0001.season.maskwars.near"]) {
      expect(arenaAccount(n, a)).toBe(true);
    }
    expect(arenaAccount(n, "agent.near")).toBe(false);
  });
});
