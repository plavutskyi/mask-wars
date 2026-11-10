import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountOf, authDataOf, authFlags, base64url, concat, utf8 } from "../src/index.ts";
import { createVault, PasskeyError } from "../src/webauthn.ts";

// The DER head of an ES256 SubjectPublicKeyInfo, as getPublicKey() returns it.
const SPKI = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01,
  0x07, 0x03, 0x42, 0x00, 0x04,
]);
const buf = (b: Uint8Array) => b.slice().buffer as ArrayBuffer;
const authData = (flags: number) => concat(sha256(utf8("maskwars.xyz")), Uint8Array.of(flags), new Uint8Array(4));

/** A CBOR attestation object {fmt: "none", attStmt: {}, authData: <bytes>}, the way an authenticator writes one. */
function attestationObject(data: Uint8Array): Uint8Array {
  const text = (t: string) => concat(Uint8Array.of(0x60 + t.length), utf8(t));
  const bytes = data.length < 256 ? concat(Uint8Array.of(0x58, data.length), data) : concat(Uint8Array.of(0x59, data.length >> 8, data.length & 0xff), data);
  return concat(Uint8Array.of(0xa3), text("fmt"), text("none"), text("attStmt"), Uint8Array.of(0xa0), text("authData"), bytes);
}

/** A browser whose authenticator makes one passkey with the given flags, and records what the page asked for. */
function browser(o: { flags: number; helper?: boolean; refuse?: string }) {
  const key = p256.getPublicKey(p256.utils.randomSecretKey(), false).slice(1);
  const rawId = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
  const asked: CredentialCreationOptions[] = [];
  const forgotten: unknown[] = [];
  class FakeCredential {
    static signalUnknownCredential = async (x: unknown) => void forgotten.push(x);
  }
  const data = authData(o.flags);
  const create = async (opts: CredentialCreationOptions) => {
    asked.push(opts);
    if (o.refuse) throw Object.assign(new Error(o.refuse), { name: o.refuse });
    return {
      rawId: buf(rawId),
      response: {
        getPublicKey: () => buf(concat(SPKI, key)),
        getPublicKeyAlgorithm: () => -7,
        ...(o.helper === false ? {} : { getAuthenticatorData: () => buf(data) }),
        attestationObject: buf(attestationObject(data)),
      },
    };
  };
  vi.stubGlobal("PublicKeyCredential", FakeCredential);
  vi.stubGlobal("window", { PublicKeyCredential: FakeCredential });
  vi.stubGlobal("navigator", { credentials: { create } });
  return { key, id: base64url(rawId), asked, forgotten };
}

describe("authenticator data", () => {
  it("reads the backup flags of a synced passkey and of one bound to its device", () => {
    expect(authFlags(authData(0x1d))).toEqual({ up: true, uv: true, be: true, bs: true });
    expect(authFlags(authData(0x05))).toEqual({ up: true, uv: true, be: false, bs: false });
    expect(authFlags(new Uint8Array(36))).toBeNull();
  });

  it("is found inside the CBOR attestation object when the browser has no helper for it", () => {
    const data = concat(authData(0x5d), new Uint8Array(200).fill(7));
    expect(authDataOf(attestationObject(data))).toEqual(data);
    expect(authDataOf(attestationObject(authData(0x1d)))).toEqual(authData(0x1d));
    expect(authDataOf(Uint8Array.of(0xa1, 0x63, 0x66, 0x6d, 0x74))).toBeNull();
    expect(authDataOf(new Uint8Array())).toBeNull();
  });
});

describe("making a vault", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("takes a passkey that syncs to the person's other devices", async () => {
    const b = browser({ flags: 0x1d });
    const v = await createVault({ rpId: "maskwars.xyz", name: "kira@mail.com" });
    expect(v).toEqual({ id: b.id, key: expect.stringMatching(/^p256:/), account: accountOf(b.key) });
    expect(b.forgotten).toEqual([]);
    const pk = b.asked[0]!.publicKey!;
    expect(pk.rp.id).toBe("maskwars.xyz");
    expect(pk.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
    expect(pk.authenticatorSelection!.authenticatorAttachment).toBeUndefined();
  });

  it("refuses a passkey that lives on this device only, and has the browser forget it", async () => {
    const b = browser({ flags: 0x05 });
    const err = await createVault({ rpId: "maskwars.xyz", name: "kira@mail.com" }).catch((e) => e);
    expect(err).toBeInstanceOf(PasskeyError);
    expect(err.problem).toBe("local");
    expect(b.forgotten).toEqual([{ rpId: "maskwars.xyz", credentialId: b.id }]);
  });

  it("reads the flags from the attestation object where the browser has no getAuthenticatorData", async () => {
    browser({ flags: 0x05, helper: false });
    expect((await createVault({ rpId: "maskwars.xyz", name: "a@b.co" }).catch((e) => e)).problem).toBe("local");
    browser({ flags: 0x19, helper: false });
    expect((await createVault({ rpId: "maskwars.xyz", name: "a@b.co" })).account).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("never makes a second vault on an authenticator that already holds one the page knows", async () => {
    const b = browser({ flags: 0x1d, refuse: "InvalidStateError" });
    const known = base64url(Uint8Array.of(9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9));
    const err = await createVault({ rpId: "maskwars.xyz", name: "kira@mail.com", exclude: [known] }).catch((e) => e);
    expect(err.problem).toBe("exists");
    const ex = b.asked[0]!.publicKey!.excludeCredentials!;
    expect(ex).toHaveLength(1);
    expect(base64url(new Uint8Array(ex[0]!.id as ArrayBuffer))).toBe(known);
  });

  it("asks for another device: a phone through its QR code", async () => {
    const b = browser({ flags: 0x1d });
    await createVault({ rpId: "maskwars.xyz", name: "kira@mail.com", elsewhere: true });
    const pk = b.asked[0]!.publicKey! as PublicKeyCredentialCreationOptions & { hints?: string[] };
    expect(pk.authenticatorSelection!.authenticatorAttachment).toBe("cross-platform");
    expect(pk.hints).toEqual(["hybrid"]);
  });

  it("says the person cancelled when the dialog was closed", async () => {
    browser({ flags: 0x1d, refuse: "NotAllowedError" });
    expect((await createVault({ rpId: "maskwars.xyz", name: "a@b.co" }).catch((e) => e)).problem).toBe("cancelled");
  });
});
