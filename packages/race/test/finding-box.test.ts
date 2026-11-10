import { createPublicKey, generateKeyPairSync, diffieHellman } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openFinding, sealableKeys, sealFinding, x25519OfEd25519, type ListedKey } from "../src/finding-box.ts";
import { base58Encode, NearKey } from "../src/near-tx.ts";
import { runnerEnv } from "../src/sandbox.ts";

const key = (n: number) => new NearKey(`ed25519:${base58Encode(Buffer.alloc(32, n))}`);
const NOVA = key(1);
const ONYX = key(2);
const FINDING = JSON.stringify({ attacker: "NOVA", plan: { steps: [{ kind: "call", method: "set_owner" }] } });
const to = { mask: "NOVA", account: "nova.tinygif8324.testnet", to: NOVA.publicKeyText };

describe("the finding handed from the race job to the drain job (A3)", () => {
  it("opens only with the winning mask's own key", () => {
    const box = sealFinding(FINDING, to);
    expect(openFinding(box, NOVA)).toBe(FINDING);
    // Nothing of the plan shows in the box itself.
    expect(JSON.stringify(box)).not.toContain("set_owner");
    expect(() => openFinding(box, ONYX)).toThrow("sealed for another key");
    expect(() => openFinding({ ...box, to: ONYX.publicKeyText }, ONYX)).toThrow();
  });

  it("refuses a box that was changed on the way", () => {
    const box = sealFinding(FINDING, to);
    const flip = (b64: string) => {
      const b = Buffer.from(b64, "base64");
      b[0]! ^= 1;
      return b.toString("base64");
    };
    expect(() => openFinding({ ...box, ct: flip(box.ct) }, NOVA)).toThrow();
    expect(() => openFinding({ ...box, account: "onyx.tinygif8324.testnet" }, NOVA)).toThrow();
    expect(() => openFinding({ ...box, epk: flip(box.epk) }, NOVA)).toThrow();
  });

  it("turns an ed25519 key into the X25519 key its secret half agrees with", () => {
    // The public half converted from ed25519 is the public half of the X25519 secret the key makes.
    for (const k of [NOVA, ONYX, key(77)]) {
      const fromPublic = x25519OfEd25519(k.publicKey).export({ format: "der", type: "spki" });
      const fromSecret = createPublicKey(k.x25519()).export({ format: "der", type: "spki" });
      expect(Buffer.compare(fromPublic, fromSecret)).toBe(0);
    }
    const eph = generateKeyPairSync("x25519");
    const a = diffieHellman({ privateKey: eph.privateKey, publicKey: x25519OfEd25519(NOVA.publicKey) });
    const b = diffieHellman({ privateKey: NOVA.x25519(), publicKey: eph.publicKey });
    expect(a.equals(b)).toBe(true);
  });
});

describe("the sandbox runner's environment (A3)", () => {
  it("gets what it needs to run and no key", () => {
    const env = runnerEnv({
      PATH: "/usr/bin",
      HOME: "/home/runner",
      RUST_LOG: "warn",
      NEAR_SANDBOX_BIN_PATH: "/opt/neard",
      NEAR_ENABLE_SANDBOX_LOG: "0",
      HTTPS_PROXY: "http://proxy",
      NEAR_AI_API_KEY: "sk-secret",
      NEARAI_CLOUD_API_KEY: "sk-secret",
      MASK_KEYS: '{"NOVA":{"safe":"ed25519:…"}}',
      GITHUB_TOKEN: "ghs_secret",
      ACTIONS_RUNTIME_TOKEN: "secret",
    });
    expect(Object.keys(env).sort()).toEqual(
      ["HOME", "HTTPS_PROXY", "NEAR_ENABLE_SANDBOX_LOG", "NEAR_SANDBOX_BIN_PATH", "PATH", "RUST_LOG"].sort(),
    );
  });
});

describe("whom the finding is sealed for (review finding 4)", () => {
  const BOUNTY = "bounty.tinygif8324.testnet";
  const fc = (k: NearKey, receiver: string): ListedKey => ({
    public_key: k.publicKeyText,
    access_key: { permission: { FunctionCall: { receiver_id: receiver } } },
  });
  const OLD = key(7);
  const NEW = key(8);

  it("seals only for a published key the mask holds on the bounty contract, not for every key on chain", () => {
    // A rotation left the old key on chain next to the new one, and someone added a key of their own: before the fix
    // each of them got a box. Now only the key on the published list does.
    const onChain = [
      fc(OLD, BOUNTY),
      fc(NEW, BOUNTY),
      fc(ONYX, BOUNTY),
      fc(NEW, "safe-0003.tinygif8324.testnet"),
      { public_key: NOVA.publicKeyText, access_key: { permission: "FullAccess" } },
    ];
    expect(sealableKeys(onChain, BOUNTY, [NEW.publicKeyText])).toEqual([NEW.publicKeyText]);
    // A published key that is not on chain on the bounty contract opens nothing either.
    expect(sealableKeys(onChain, BOUNTY, [NOVA.publicKeyText])).toEqual([]);
    expect(sealableKeys(onChain, BOUNTY, [])).toEqual([]);
  });
});
