/**
 * The finding crosses from the race job of `Live race` to the drain job sealed (A3): the race job holds no mask key,
 * and the drain job runs no model, no sandbox and no team code. Only the winning mask's own key on the bounty contract
 * opens the box, so an artifact of the run shows nothing of the plan before the mask reveals it, and no new secret is
 * needed: the race job takes that key's public half off the chain.
 *
 * An ed25519 key converts to X25519 the way libsodium's `crypto_sign_ed25519_pk_to_curve25519` does (RFC 7748's map
 * u = (1 + y) / (1 − y)). A one-time X25519 key agrees a secret with it, HKDF-SHA256 makes the AES-256-GCM key, and the
 * mask's account is the associated data.
 */
import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { base58Decode, type NearKey } from "./near-tx.ts";

/** A sealed finding, as the race job uploads it. Everything but `ct` is public anyway. */
export interface FindingBox {
  readonly v: 1;
  /** The winning mask's name in the race and its account. */
  readonly mask: string;
  readonly account: string;
  /** The mask's key the box is sealed for, `ed25519:…`. */
  readonly to: string;
  readonly epk: string;
  readonly iv: string;
  readonly ct: string;
  readonly tag: string;
}

const P = 2n ** 255n - 19n;
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");
const INFO = Buffer.from("maskwars-finding-v1", "utf8");

function pow(base: bigint, exp: bigint): bigint {
  let r = 1n;
  let b = base % P;
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
  }
  return r;
}

/** The X25519 public key of an ed25519 public key (32 bytes each). */
export function x25519OfEd25519(ed: Uint8Array): KeyObject {
  if (ed.length !== 32) throw new Error("an ed25519 public key is 32 bytes");
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? ed[i]! & 0x7f : ed[i]!);
  const u = ((1n + y) * pow((1n - y + P) % P, P - 2n)) % P;
  const raw = Buffer.alloc(32);
  for (let i = 0, v = u; i < 32; i++, v >>= 8n) raw[i] = Number(v & 0xffn);
  return createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: "der", type: "spki" });
}

function aeadKey(shared: Buffer, epk: Buffer, to: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([epk, to]), INFO, 32));
}

function rawPublic(k: KeyObject): Buffer {
  return k.export({ format: "der", type: "spki" }).subarray(12);
}

/** Seals `text` for the mask whose key on the bounty contract is `to` (`ed25519:…`). */
export function sealFinding(text: string, o: { mask: string; account: string; to: string }): FindingBox {
  const [curve, body] = o.to.split(":");
  if (curve !== "ed25519" || !body) throw new Error("the mask's key is ed25519:<base58>");
  const recipient = x25519OfEd25519(base58Decode(body));
  const eph = generateKeyPairSync("x25519");
  const epk = rawPublic(eph.publicKey);
  const key = aeadKey(diffieHellman({ privateKey: eph.privateKey, publicKey: recipient }), epk, rawPublic(recipient));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(Buffer.from(o.account, "utf8"));
  const ct = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const b64 = (b: Buffer) => b.toString("base64");
  return { v: 1, mask: o.mask, account: o.account, to: o.to, epk: b64(epk), iv: b64(iv), ct: b64(ct), tag: b64(cipher.getAuthTag()) };
}

/** Opens a box with the mask's key; refuses a box sealed for another key or tampered with. */
export function openFinding(box: FindingBox, key: NearKey): string {
  if (box.v !== 1) throw new Error("an unknown finding box");
  if (box.to !== key.publicKeyText) throw new Error("the finding is sealed for another key");
  const mine = key.x25519();
  const epk = Buffer.from(box.epk, "base64");
  const theirs = createPublicKey({ key: Buffer.concat([SPKI_X25519, epk]), format: "der", type: "spki" });
  const k = aeadKey(diffieHellman({ privateKey: mine, publicKey: theirs }), epk, rawPublic(createPublicKey(mine)));
  const decipher = createDecipheriv("aes-256-gcm", k, Buffer.from(box.iv, "base64"))
    .setAAD(Buffer.from(box.account, "utf8"))
    .setAuthTag(Buffer.from(box.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(box.ct, "base64")), decipher.final()]).toString("utf8");
}

/** An access key as NEAR lists it (`view_access_key_list`). */
export interface ListedKey {
  readonly public_key: string;
  readonly access_key: { readonly permission: { readonly FunctionCall?: { readonly receiver_id: string } } | string };
}

/**
 * The keys a finding may be sealed for: the mask's function-call keys on the bounty contract that are also on the
 * published list (`MASK_CLAIM_KEYS`, a repository variable of public halves). A key that is on chain but not on the
 * list, such as an old key a rotation left behind or one added by whoever holds the mask's full key, gets no box: the
 * plan opens only for the key the drain job holds today.
 */
export function sealableKeys(onChain: readonly ListedKey[], contract: string, published: readonly string[]): string[] {
  return onChain
    .filter((k) => typeof k.access_key.permission === "object" && k.access_key.permission.FunctionCall?.receiver_id === contract)
    .map((k) => k.public_key)
    .filter((k) => published.includes(k));
}
