import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { accountOf, base58, base64, base64url, concat, hex, keyText, utf8, type Assertion } from "@maskwars/pay";
import {
  keyFromTwo,
  keyOfAssertion,
  proofHash,
  proofMessage,
  proofOf,
  proofTime,
  readProof,
  type ProofAsk,
  type ProofTerms,
  type VaultProof,
} from "../src/proof.ts";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const ask: ProofAsk = {
  text: "Break our lending vault before mainnet",
  target: "vault.northwind-lend.testnet",
  page: "https://northwind.example",
  at: "2026-11-09T11:55:00Z",
};
const terms: ProofTerms = {
  text: ask.text,
  target: ask.target,
  page: ask.page,
  recipient: "maskwars.xyz",
  rpId: "maskwars.xyz",
  origins: ["https://maskwars.xyz"],
  now: NOW,
};
const nonce = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

/** A NEAR wallet with a key we hold: what `signMessage` does under NEP-413. */
function wallet(account: string, secret = ed25519.utils.randomSecretKey()) {
  const pub = ed25519.getPublicKey(secret);
  return {
    pub,
    sign(a: ProofAsk = ask, n = nonce, recipient = "maskwars.xyz"): VaultProof {
      const signature = base64(ed25519.sign(proofHash(proofMessage(a), n, recipient), secret));
      return { kind: "near", ask: a, nonce: base64(n), recipient, account, publicKey: `ed25519:${base58(pub)}`, signature };
    },
  };
}

/** A software passkey on maskwars.xyz: an authenticator's assertion over the proof's hash, with a key we hold. */
function passkey(secret = p256.utils.randomSecretKey()) {
  const key = p256.getPublicKey(secret, false).slice(1);
  const assert = (challenge: Uint8Array, o: { rpId?: string; origin?: string; flags?: number; crossOrigin?: boolean } = {}): Assertion => {
    const authenticatorData = concat(sha256(utf8(o.rpId ?? "maskwars.xyz")), Uint8Array.of(o.flags ?? 0x05), new Uint8Array(4));
    const clientDataJSON = utf8(
      JSON.stringify({
        type: "webauthn.get",
        challenge: base64url(challenge),
        origin: o.origin ?? "https://maskwars.xyz",
        ...(o.crossOrigin ? { crossOrigin: true } : {}),
      }),
    );
    const signature = p256.sign(sha256(concat(authenticatorData, sha256(clientDataJSON))), secret, { prehash: false, format: "der" });
    return { authenticatorData, clientDataJSON, signature };
  };
  return {
    key,
    account: accountOf(key),
    assert,
    sign(a: ProofAsk = ask, o: Parameters<typeof assert>[1] = {}): VaultProof {
      const x = assert(proofHash(proofMessage(a), nonce, "maskwars.xyz"), o);
      return {
        kind: "passkey",
        ask: a,
        nonce: base64(nonce),
        recipient: "maskwars.xyz",
        key: keyText(key),
        authenticatorData: base64url(x.authenticatorData),
        clientDataJSON: base64url(x.clientDataJSON),
        signature: base64url(x.signature),
      };
    },
  };
}

describe("the line a payer signs", () => {
  it("names the job, the contract, the page that asked and when, one per line", () => {
    expect(proofMessage(ask)).toBe(
      "MASK WARS: fund my vault for this job.\nJob: Break our lending vault before mainnet\nContract: vault.northwind-lend.testnet\nAsked by: https://northwind.example\nAt: 2026-11-09T11:55:00Z",
    );
    expect(proofMessage({ ...ask, page: null })).toContain("Asked by: a page that did not say");
    expect(proofTime(new Date("2026-11-09T11:55:00.789Z"))).toBe("2026-11-09T11:55:00Z");
  });

  it("is hashed as NEP-413 asks: tag 2^31+413, then borsh message, nonce, recipient, no callback", () => {
    // The same bytes written out by hand, as NEP-413's reference does it.
    const str = (s: string) => {
      const b = Buffer.from(s, "utf8");
      const len = Buffer.alloc(4);
      len.writeUInt32LE(b.length);
      return Buffer.concat([len, b]);
    };
    const tag = Buffer.alloc(4);
    tag.writeUInt32LE(2 ** 31 + 413);
    const bytes = Buffer.concat([tag, str("hi"), Buffer.from(nonce), str("maskwars.xyz"), Buffer.from([0])]);
    expect(hex(proofHash("hi", nonce, "maskwars.xyz"))).toBe(hex(sha256(bytes)));
    expect(() => proofHash("hi", new Uint8Array(31), "maskwars.xyz")).toThrow();
  });
});

describe("a NEAR wallet’s proof", () => {
  it("proves the account it signed for, and leaves the key’s owner to the chain", () => {
    const w = wallet("northwind-lend.near");
    expect(readProof(w.sign(), terms)).toEqual({
      ok: true,
      vault: "northwind-lend.near",
      onChain: { account: "northwind-lend.near", publicKey: `ed25519:${base58(w.pub)}` },
    });
  });

  it("proves an implicit account by its key alone: the name is the key", () => {
    const secret = ed25519.utils.randomSecretKey();
    const id = hex(ed25519.getPublicKey(secret));
    expect(readProof(wallet(id, secret).sign(), terms)).toEqual({ ok: true, vault: id, onChain: null });
    // Someone else's key cannot sign for that name.
    expect(readProof(wallet(id).sign(), terms)).toMatchObject({ ok: false, why: "not this account's key" });
  });

  it("reads base58 signatures too, as some wallets give them", () => {
    const secret = ed25519.utils.randomSecretKey();
    const p = wallet("acme.near", secret).sign() as Extract<VaultProof, { kind: "near" }>;
    const raw = ed25519.sign(proofHash(proofMessage(ask), nonce, "maskwars.xyz"), secret);
    expect(readProof({ ...p, signature: base58(raw) }, terms).ok).toBe(true);
    expect(readProof({ ...p, signature: `ed25519:${base58(raw)}` }, terms).ok).toBe(true);
  });

  it("refuses a proof for another job, page, site, time or signer", () => {
    const w = wallet("acme.near");
    const p = w.sign() as Extract<VaultProof, { kind: "near" }>;
    expect(readProof(w.sign({ ...ask, text: "Something else entirely" }), terms)).toMatchObject({ ok: false, why: "signed for another job" });
    expect(readProof(w.sign({ ...ask, target: "other.near" }), terms)).toMatchObject({ ok: false, why: "signed for another job" });
    expect(readProof(w.sign({ ...ask, page: "https://evil.example" }), terms)).toMatchObject({ ok: false, why: "signed for another page" });
    expect(readProof(w.sign(ask, nonce, "evil.example"), terms)).toMatchObject({ ok: false, why: "signed for another site" });
    expect(readProof(w.sign({ ...ask, at: "2026-11-09T11:29:59Z" }), terms)).toMatchObject({ ok: false, why: "too old" });
    expect(readProof(w.sign({ ...ask, at: "2026-11-09T12:02:01Z" }), terms)).toMatchObject({ ok: false, why: "too old" });
    // The fields say one thing, the signature was made over another.
    expect(readProof({ ...p, ask: { ...ask, at: "2026-11-09T11:56:00Z" } }, terms)).toMatchObject({ ok: false, why: "the signature does not hold" });
    expect(readProof({ ...p, publicKey: `ed25519:${base58(ed25519.getPublicKey(ed25519.utils.randomSecretKey()))}` }, terms)).toMatchObject({
      ok: false,
      why: "the signature does not hold",
    });
    expect(readProof({ ...p, account: "acme.testnet" }, terms)).toMatchObject({ ok: false, why: "not a NEAR account" });
    expect(readProof({ ...p, nonce: base64(new Uint8Array(16)) }, terms)).toMatchObject({ ok: false, why: "no nonce" });
  });
});

describe("a passkey’s proof", () => {
  it("proves the vault its key opens", () => {
    const k = passkey();
    expect(readProof(k.sign(), terms)).toEqual({ ok: true, vault: k.account, onChain: null });
  });

  it("refuses another site’s passkey, another origin, a frame, an unverified person, another key", () => {
    const k = passkey();
    expect(readProof(k.sign(ask, { rpId: "evil.example" }), terms)).toMatchObject({ ok: false, why: "another site's passkey" });
    expect(readProof(k.sign(ask, { origin: "https://evil.example" }), terms)).toMatchObject({ ok: false, why: "signed on another page" });
    expect(readProof(k.sign(ask, { crossOrigin: true }), terms)).toMatchObject({ ok: false, why: "signed on another page" });
    expect(readProof(k.sign(ask, { flags: 0x01 }), terms)).toMatchObject({ ok: false, why: "the person was not verified" });
    const other = passkey();
    expect(readProof({ ...(k.sign() as Extract<VaultProof, { kind: "passkey" }>), key: keyText(other.key) }, terms)).toMatchObject({
      ok: false,
      why: "the signature does not hold",
    });
    expect(readProof(k.sign({ ...ask, text: "Something else entirely" }), terms)).toMatchObject({ ok: false, why: "signed for another job" });
  });

  it("finds the key from what this browser knows, from the vault the page named, or from a second touch", () => {
    const k = passkey();
    const hash = proofHash(proofMessage(ask), nonce, "maskwars.xyz");
    const a = k.assert(hash);
    expect(keyOfAssertion(a, { known: keyText(k.key) })).toBe(keyText(k.key));
    // A key from anywhere that did not make this signature is not taken.
    expect(keyOfAssertion(a, { known: keyText(passkey().key) })).toBeNull();
    expect(keyOfAssertion(a, { want: k.account })).toBe(keyText(k.key));
    expect(keyOfAssertion(a, { want: passkey().account })).toBeNull();
    expect(keyOfAssertion(a, {})).toBeNull();
    expect(keyFromTwo(a, k.assert(new Uint8Array(32).fill(7)))).toBe(keyText(k.key));
  });
});

describe("the vault window’s answer to the checkout", () => {
  it("is taken only for this checkout’s relay, marked and shaped", () => {
    const relay = "a".repeat(64);
    const proof = passkey().sign();
    expect(proofOf({ maskwarsHireProof: 1, relay, proof, vault: "0xabc" }, relay)).toEqual({ proof, vault: "0xabc" });
    expect(proofOf({ maskwarsHireProof: 1, relay: "b".repeat(64), proof, vault: "0xabc" }, relay)).toBeNull();
    expect(proofOf({ maskwarsHire: 1, relay, proof, vault: "0xabc" }, relay)).toBeNull();
    expect(proofOf("hello", relay)).toBeNull();
  });
});
