import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import {
  accountOf,
  base64url,
  challengeOf,
  concat,
  fromBase58,
  fromBase64url,
  fromHex,
  keyBytes,
  keyFromSpki,
  keyText,
  recoverKeys,
  signedBy,
  signedWebauthn,
  utf8,
  verifyWebauthn,
  type Assertion,
  type SignedWebauthn,
} from "../src/index.ts";

const h = (x: string) => fromHex(x)!;

// near/intents, contracts/defuse/core/src/payload/webauthn.rs, test `p256`: a real passkey's signed transfer intent.
const DEFUSE: SignedWebauthn = {
  standard: "webauthn",
  payload:
    '{"signer_id":"0x3602b546589a8fcafdce7fad64a46f91db0e4d50","verifying_contract":"defuse.test.near","deadline":"2025-03-30T00:00:00Z","nonce":"A3nsY1GMVjzyXL3mUzOOP3KT+5a0Ruy+QDNWPhchnxM=","intents":[{"intent":"transfer","receiver_id":"user1.test.near","tokens":{"nep141:ft1.poa-factory.test.near":"1000"}}]}',
  public_key: "p256:2V8Np9vGqLiwVZ8qmMmpkxU7CTRqje4WtwFeLimSwuuyF1rddQK5fELiMgxUnYbVjbZHCNnGc6fAe4JeDcVxgj3Q",
  signature: "p256:3KBMZ72BHUiVfE1ey5dpi3KgbXvSEf9kuxgBEax7qLBQtidZExxxjjQk1hTTGFRrPvUoEStfrjoFNVVW4Abar94W",
  client_data_json:
    '{"type":"webauthn.get","challenge":"4cveZsIe6p-WaEcL-Lhtzt3SZuXbYsjDdlFhLNrSjjk","origin":"https://defuse-widget-git-feat-passkeys-defuse-94bbc1b2.vercel.app"}',
  authenticator_data: "933cQogpBzE3RSAYSAkfWoNEcBd3X84PxE8iRrRVxMgdAAAAAA==",
};

/** A software passkey: what an authenticator does, with a key we hold, for the ceremony end to end. */
function authenticator(secret = p256.utils.randomSecretKey()) {
  const key = p256.getPublicKey(secret, false).slice(1);
  return {
    key,
    sign(challenge: Uint8Array, { highS = false } = {}): Assertion {
      const authenticatorData = concat(sha256(utf8("maskwars.xyz")), Uint8Array.of(0x05), new Uint8Array(4));
      const clientDataJSON = utf8(JSON.stringify({ type: "webauthn.get", challenge: base64url(challenge), origin: "https://maskwars.xyz" }));
      const hash = sha256(concat(authenticatorData, sha256(clientDataJSON)));
      let sig = p256.Signature.fromBytes(p256.sign(hash, secret, { prehash: false, lowS: true }), "compact");
      if (highS) sig = new p256.Signature(sig.r, p256.Point.Fn.neg(sig.s));
      return { authenticatorData, clientDataJSON, signature: sig.toBytes("der") };
    },
  };
}

describe("vault account", () => {
  it("is the one NEAR Intents derives from the passkey's key", () => {
    // near/intents public_key.rs, test to_implicit_account_id
    const sample = fromBase58("3aMVMxsoAnHUbweXMtdKaN1uJaNwsfKv7wnc97SDGjXhyK62VyJwhPUPLZefKVthcoUcuWK6cqkSU4M542ipNxS3")!;
    expect(accountOf(sample)).toBe("0x7edf07ede58238026db3f90fc8032633b69b8de5");
    expect(accountOf(keyBytes(DEFUSE.public_key)!)).toBe("0x3602b546589a8fcafdce7fad64a46f91db0e4d50");
  });

  it("reads the key from what the browser returns at creation", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    expect(keyFromSpki(spki)).toEqual(raw.slice(1));
    expect(keyText(keyFromSpki(spki)!)).toBe(`p256:${keyText(raw.slice(1)).slice(5)}`);
    expect(keyFromSpki(spki.slice(1))).toBeNull();
    const bad = spki.slice();
    bad[bad.length - 1]! ^= 1;
    expect(keyFromSpki(bad)).toBeNull();
  });

  it("rejects keys that are not points on the curve", () => {
    expect(keyBytes("p256:3aMVMxsoAnHUbweXMtdKaN1uJaNwsfKv7wnc97SDGjXhyK62VyJwhPUPLZefKVthcoUcuWK6cqkSU4M542ipNxS3")).toBeNull();
    expect(keyBytes("ed25519:5TagutioHgKLh7KZ1VEFBYfgRkPtqnKm9LoMnJMJugxm")).toBeNull();
  });
});

describe("signed intent", () => {
  it("verifies NEAR Intents' own passkey vector", () => {
    expect(verifyWebauthn(DEFUSE)).toBe(true);
    expect(verifyWebauthn({ ...DEFUSE, payload: DEFUSE.payload.replace("1000", "1001") })).toBe(false);
    expect(verifyWebauthn({ ...DEFUSE, client_data_json: DEFUSE.client_data_json.replace("webauthn.get", "webauthn.create") })).toBe(false);
  });

  it("verifies near/intents' raw WebAuthn vector and recovers its key", () => {
    // near/intents crates/signatures/webauthn/src/p256.rs, test verify_ok
    const key = h("b87da10683d04e6ec4e2f1775556a63cbb01be843058eb737fe02f9e22663093cf61b416dfb33ba2e32e9c6f3a09d84fa90d0ab9709f4a298d52e0799c8217f5");
    const a: Assertion = {
      authenticatorData: h("49960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d97631d00000000"),
      clientDataJSON: utf8('{"type":"webauthn.get","challenge":"BvJpGRQxNyM3oMYGoVgi40m9DV7DF3BPl77xpO1vXh0","origin":"http://localhost:5173","crossOrigin":false}'),
      signature: p256.Signature.fromBytes(
        h("002527c17a17d709ab62ffab033e0a26d901f5bee6686a0d605032828e490a7c47a9f4161e6a17688ae42a66adb67c9c22c86153afb08103b1e9eccd5314c271"),
        "compact",
      ).toBytes("der"),
    };
    expect(base64url(h("06f269191431372337a0c606a15822e349bd0d5ec317704f97bef1a4ed6f5e1d"))).toBe("BvJpGRQxNyM3oMYGoVgi40m9DV7DF3BPl77xpO1vXh0");
    expect(signedBy(a, key)).toBe(true);
    expect(recoverKeys(a).some((k) => keyText(k) === keyText(key))).toBe(true);
  });

  it("turns a passkey's assertion into the intent NEAR Intents accepts", () => {
    const pk = authenticator();
    const payload = '{"signer_id":"x","intents":[]}';
    const signed = signedWebauthn(payload, pk.key, pk.sign(challengeOf(payload)))!;
    expect(signed).not.toBeNull();
    expect(signed.public_key).toBe(keyText(pk.key));
    expect(signed.signature).toMatch(/^p256:[1-9A-HJ-NP-Za-km-z]+$/);
    expect(fromBase58(signed.signature.slice(5))).toHaveLength(64);
    expect(fromBase64url(signed.authenticator_data)).toHaveLength(37);
    expect(JSON.parse(signed.client_data_json).type).toBe("webauthn.get");
    expect(verifyWebauthn(signed)).toBe(true);
  });

  it("folds a high-S signature into the low-S form NEAR Intents requires", () => {
    const pk = authenticator();
    const payload = "pay";
    const a = pk.sign(challengeOf(payload), { highS: true });
    expect(p256.Signature.fromBytes(a.signature, "der").hasHighS()).toBe(true);
    const signed = signedWebauthn(payload, pk.key, a)!;
    expect(p256.Signature.fromBytes(fromBase58(signed.signature.slice(5))!, "compact").hasHighS()).toBe(false);
    expect(verifyWebauthn(signed)).toBe(true);
  });

  it("signs nothing it cannot verify: another payload, another key", () => {
    const pk = authenticator();
    const other = authenticator();
    expect(signedWebauthn("b", pk.key, pk.sign(challengeOf("a")))).toBeNull();
    expect(signedWebauthn("a", other.key, pk.sign(challengeOf("a")))).toBeNull();
  });

  it("finds the key on a new device from two touches", () => {
    const pk = authenticator();
    const a = recoverKeys(pk.sign(crypto.getRandomValues(new Uint8Array(32))));
    const b = recoverKeys(pk.sign(crypto.getRandomValues(new Uint8Array(32))));
    expect(a.length).toBeGreaterThanOrEqual(1);
    const both = a.filter((k) => b.some((x) => keyText(x) === keyText(k)));
    expect(both.map(keyText)).toEqual([keyText(pk.key)]);
  });

  it("trusts a stored key only if the passkey's signature holds for it", () => {
    const pk = authenticator();
    const a = pk.sign(new Uint8Array(32));
    expect(signedBy(a, pk.key)).toBe(true);
    expect(signedBy(a, authenticator().key)).toBe(false);
  });
});
