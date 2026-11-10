import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { base58, base64url, concat, equal, fromBase58, fromBase64url, hex, utf8 } from "./codec.ts";
import type { SignedWebauthn } from "./oneclick.ts";

/**
 * A passkey is the vault's key. NEAR Intents knows P-256 passkeys natively (its `webauthn` signing standard): the
 * vault's account is derived from the passkey's public key and nothing else, so nobody, this site included, holds a
 * key to it, and there is no account to create first.
 *
 *   account = "0x" + hex(keccak256("p256" ‖ x ‖ y)[12..32])        (near/intents, PublicKey::to_implicit_account_id)
 *
 * Signing an intent is a WebAuthn assertion whose challenge is sha256 of the intent payload; the signature is ECDSA
 * over sha256(authenticatorData ‖ sha256(clientDataJSON)), sent as r‖s in low-S form.
 */

/** The 64-byte uncompressed key (x ‖ y, no SEC-1 tag) as NEAR Intents names it: `p256:` + base58. */
export function keyText(key: Uint8Array): string {
  if (key.length !== 64) throw new Error("a P-256 key is 64 bytes");
  return `p256:${base58(key)}`;
}

export function keyBytes(text: string): Uint8Array | null {
  if (!text.startsWith("p256:")) return null;
  const k = fromBase58(text.slice(5));
  return k?.length === 64 && p256.utils.isValidPublicKey(concat(Uint8Array.of(4), k), false) ? k : null;
}

/** The vault account a passkey's key opens: an implicit account in NEAR Intents, `0x` and 40 hex digits. */
export function accountOf(key: Uint8Array): string {
  if (key.length !== 64) throw new Error("a P-256 key is 64 bytes");
  return `0x${hex(keccak_256(concat(utf8("p256"), key)).subarray(12))}`;
}

/** DER prefix of an ES256 SubjectPublicKeyInfo: ecPublicKey on prime256v1, then the uncompressed point. */
const SPKI_P256 = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01,
  0x07, 0x03, 0x42, 0x00, 0x04,
]);

/** The 64-byte key out of what `AuthenticatorAttestationResponse.getPublicKey()` returns for an ES256 passkey. */
export function keyFromSpki(spki: Uint8Array): Uint8Array | null {
  if (spki.length !== SPKI_P256.length + 64 || !equal(spki.subarray(0, SPKI_P256.length), SPKI_P256)) return null;
  const key = spki.slice(SPKI_P256.length);
  return p256.utils.isValidPublicKey(concat(Uint8Array.of(4), key), false) ? key : null;
}

/** The flags byte of WebAuthn authenticator data: user present, user verified, backup eligible, backed up. */
export interface AuthFlags {
  readonly up: boolean;
  readonly uv: boolean;
  /** BE: the passkey may sync to the person's other devices (iCloud Keychain, Google Password Manager, a password manager). */
  readonly be: boolean;
  /** BS: it is synced right now. */
  readonly bs: boolean;
}

/** The flags of authenticator data (rpIdHash ‖ flags ‖ signCount ‖ …), or `null` when it is too short to have them. */
export function authFlags(authData: Uint8Array): AuthFlags | null {
  if (authData.length < 37) return null;
  const f = authData[32]!;
  return { up: (f & 0x01) !== 0, uv: (f & 0x04) !== 0, be: (f & 0x08) !== 0, bs: (f & 0x10) !== 0 };
}

/**
 * The authenticator data inside a CBOR attestation object, for browsers without `getAuthenticatorData()`. The object is a
 * map of `fmt`, `attStmt` and `authData`; only the `authData` byte string is read, everything else is skipped by its
 * CBOR length. `null` for anything that is not that shape.
 */
export function authDataOf(attestationObject: Uint8Array): Uint8Array | null {
  const b = attestationObject;
  let i = 0;
  const head = (): { major: number; n: number } | null => {
    if (i >= b.length) return null;
    const x = b[i++]!;
    const major = x >> 5;
    const info = x & 0x1f;
    if (info < 24) return { major, n: info };
    const len = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : 0;
    if (!len || i + len > b.length) return null;
    let n = 0;
    for (let k = 0; k < len; k++) n = n * 256 + b[i++]!;
    return { major, n };
  };
  const skip = (depth = 0): boolean => {
    const h = head();
    if (!h || depth > 8) return false;
    if (h.major === 2 || h.major === 3) {
      if (i + h.n > b.length) return false;
      i += h.n;
      return true;
    }
    if (h.major === 0 || h.major === 1 || h.major === 7) return true;
    if (h.major === 4) {
      for (let k = 0; k < h.n; k++) if (!skip(depth + 1)) return false;
      return true;
    }
    if (h.major === 5) {
      for (let k = 0; k < h.n * 2; k++) if (!skip(depth + 1)) return false;
      return true;
    }
    if (h.major === 6) return skip(depth + 1);
    return false;
  };
  const map = head();
  if (!map || map.major !== 5) return null;
  for (let k = 0; k < map.n; k++) {
    const key = head();
    if (!key || key.major !== 3 || i + key.n > b.length) return null;
    const name = new TextDecoder().decode(b.subarray(i, i + key.n));
    i += key.n;
    if (name !== "authData") {
      if (!skip()) return null;
      continue;
    }
    const v = head();
    if (!v || v.major !== 2 || i + v.n > b.length) return null;
    return b.slice(i, i + v.n);
  }
  return null;
}

/** sha256 of a text, hex: a name for a credential id that keeps the id itself out of storage paths. */
export function sha256Hex(text: string): string {
  return hex(sha256(utf8(text)));
}

/** The WebAuthn challenge for an intent: sha256 of its payload, exactly as NEAR Intents hashes it. */
export function challengeOf(payload: string): Uint8Array {
  return sha256(utf8(payload));
}

/** What the authenticator returns from `navigator.credentials.get()`. */
export interface Assertion {
  readonly authenticatorData: Uint8Array;
  readonly clientDataJSON: Uint8Array;
  /** ASN.1 DER, as WebAuthn gives an ES256 signature. */
  readonly signature: Uint8Array;
}

const signedHash = (authenticatorData: Uint8Array, clientDataJSON: Uint8Array) =>
  sha256(concat(authenticatorData, sha256(clientDataJSON)));

/** Checks WebAuthn's own rules that NEAR Intents checks: a `webauthn.get` for `challenge`, the user was present. */
function assertionOk(authenticatorData: Uint8Array, clientDataJSON: string, challenge: Uint8Array): boolean {
  if (authenticatorData.length < 37) return false;
  const flags = authenticatorData[32]!;
  if ((flags & 0x01) === 0) return false; // UP
  if ((flags & 0x08) === 0 && (flags & 0x10) !== 0) return false; // BS without BE
  let c: { type?: unknown; challenge?: unknown };
  try {
    c = JSON.parse(clientDataJSON);
  } catch {
    return false;
  }
  if (c.type !== "webauthn.get" || typeof c.challenge !== "string") return false;
  const got = fromBase64url(c.challenge);
  return got !== null && equal(got, challenge);
}

/**
 * The signed intent NEAR Intents accepts, from a passkey's assertion over `payload`. `null` if the assertion is not for
 * this payload or the signature does not hold for `key`: nothing unverifiable leaves the page.
 */
export function signedWebauthn(payload: string, key: Uint8Array, a: Assertion): SignedWebauthn | null {
  const clientDataJSON = new TextDecoder().decode(a.clientDataJSON);
  if (!assertionOk(a.authenticatorData, clientDataJSON, challengeOf(payload))) return null;
  let sig;
  try {
    sig = p256.Signature.fromBytes(a.signature, "der");
  } catch {
    return null;
  }
  // NEAR Intents rejects high-S signatures; authenticators produce either half, so fold it into the low one.
  if (sig.hasHighS()) sig = new p256.Signature(sig.r, p256.Point.Fn.neg(sig.s));
  const compact = sig.toBytes("compact");
  const signed: SignedWebauthn = {
    standard: "webauthn",
    payload,
    public_key: keyText(key),
    signature: `p256:${base58(compact)}`,
    client_data_json: clientDataJSON,
    authenticator_data: base64url(a.authenticatorData),
  };
  return verifyWebauthn(signed) ? signed : null;
}

/** Verifies a signed WebAuthn intent the way NEAR Intents does: payload, assertion, low-S P-256 signature. */
export function verifyWebauthn(s: SignedWebauthn): boolean {
  const key = keyBytes(s.public_key);
  const sig = s.signature.startsWith("p256:") ? fromBase58(s.signature.slice(5)) : null;
  const authenticatorData = fromBase64url(s.authenticator_data);
  if (!key || sig?.length !== 64 || !authenticatorData) return false;
  if (!assertionOk(authenticatorData, s.client_data_json, challengeOf(s.payload))) return false;
  return p256.verify(sig, signedHash(authenticatorData, utf8(s.client_data_json)), concat(Uint8Array.of(4), key), { prehash: false, lowS: true });
}

/**
 * The keys that could have made an assertion's signature: usually two. A passkey's public key is given only once, when
 * it is created; on another device two assertions over different challenges pin it down (the one key in both lists).
 */
export function recoverKeys(a: Assertion): Uint8Array[] {
  let sig;
  try {
    sig = p256.Signature.fromBytes(a.signature, "der");
  } catch {
    return [];
  }
  const hash = signedHash(a.authenticatorData, a.clientDataJSON);
  const keys: Uint8Array[] = [];
  for (let bit = 0; bit < 4; bit++) {
    try {
      const point = sig.addRecoveryBit(bit).recoverPublicKey(hash);
      const key = point.toBytes(false).slice(1);
      if (!keys.some((k) => equal(k, key))) keys.push(key);
    } catch {
      /* this recovery bit does not give a point on the curve */
    }
  }
  return keys;
}

/** Whether `key` made the assertion's signature: what a key from anywhere but the passkey itself must pass. */
export function signedBy(a: Assertion, key: Uint8Array): boolean {
  try {
    return p256.verify(a.signature, signedHash(a.authenticatorData, a.clientDataJSON), concat(Uint8Array.of(4), key), {
      prehash: false,
      lowS: false,
      format: "der",
    });
  } catch {
    return false;
  }
}
