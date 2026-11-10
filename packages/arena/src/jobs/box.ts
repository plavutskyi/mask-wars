// Work sealed for the judge's key, and the winning work sealed again for the client's. The same boxes the judges open
// in their TEE (`services/judge-tests/src/sealed.rs`): a mask builds its box on its own machine, so its work never
// passes through anyone, this site and its MCP server included. Only node:crypto.
//
// A work box, the content of a revealed step of a `tee_tests` or `ai_review` job: `mw1.` and base64url (no padding) of
//
//   eph_pub (32) || nonce (12) || AES-256-GCM(key, nonce, padded, aad) (640 + 16)
//   key    = HKDF-SHA256(ikm = X25519(eph, judge), salt = eph_pub || judge_pub, info = "maskwars:work:v1")
//   aad    = "maskwars:work:v1:<contract>:<job>:<mask>"
//   padded = kind || work || 0x80 || 0x00…   (640 bytes: every box has one size)
//
// The contract, the job and the mask are the associated data: a box copied onto another mask or another job does not
// open, and the judge calls it fake. The kind byte is 1 for a Wasm module (`tee_tests`), 2 for UTF-8 text.
//
// A delivery, the winner's work for the client once the job is paid: `mwd1.` and base64url of
//
//   eph_pub (32) || nonce (12) || AES-256-GCM(key, nonce, work, aad) (len + 16)
//   key = HKDF-SHA256(ikm = X25519(eph, client), salt = eph_pub || client_pub, info = "maskwars:delivery:v1")
//   aad = "maskwars:delivery:v1:<contract>:<job>:<client>"
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomBytes } from "node:crypto";

export const BOX_PREFIX = "mw1.";
export const DELIVERY_PREFIX = "mwd1.";
/** The kind byte of what a box holds. */
export const MODULE = 1;
export const TEXT = 2;
export const PADDED = 640;
export const BOX_BYTES = 32 + 12 + PADDED + 16;
/** `mw1.` and 934 base64url characters: what the contract takes as a revealed step of a private job. */
export const BOX_CHARS = 934;
/** The longest module or text a box carries: the kind byte and the end marker take two of the 640. */
export const MAX_WORK_BYTES = PADDED - 2;
/** `x25519:` and 64 lowercase hex digits: a judge's key in its TEE, or a client's. */
export const KEY = /^x25519:[0-9a-f]{64}$/;
export const BOX = /^mw1\.[A-Za-z0-9_-]{934}$/;
/** The info each judge derives its X25519 key from its TEE seed under. */
export const JUDGE_KEY_INFO = { tee_tests: "maskwars:judge-tests:x25519:v1", ai_review: "maskwars:judge-review:x25519:v1" } as const;

const WORK_INFO = "maskwars:work:v1";
const DELIVERY_INFO = "maskwars:delivery:v1";
const PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI = Buffer.from("302a300506032b656e032100", "hex");

export type Work = { kind: "module"; bytes: Uint8Array } | { kind: "text"; text: string };

export const workAad = (contract: string, job: string, mask: string) => `maskwars:work:v1:${contract}:${job}:${mask}`;
export const deliveryAad = (contract: string, job: string, client: string) => `maskwars:delivery:v1:${contract}:${job}:${client}`;

function keyBytes(key: string): Buffer {
  if (!KEY.test(key)) throw new Error("a key is x25519: and 64 lowercase hex digits");
  return Buffer.from(key.slice(7), "hex");
}

export const keyText = (pub: Uint8Array) => `x25519:${Buffer.from(pub).toString("hex")}`;

const privateKey = (secret: Uint8Array) => createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(secret)]), format: "der", type: "pkcs8" });
const publicKey = (pub: Uint8Array) => createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(pub)]), format: "der", type: "spki" });

/** The public half of an X25519 secret. */
export function publicOf(secret: Uint8Array): Buffer {
  return Buffer.from(createPublicKey(privateKey(secret)).export({ format: "der", type: "spki" })).subarray(-32);
}

/** X25519, refusing a key that gives no shared secret. */
function shared(secret: Uint8Array, pub: Uint8Array): Buffer {
  let out: Buffer;
  try {
    out = diffieHellman({ privateKey: privateKey(secret), publicKey: publicKey(pub) });
  } catch {
    throw new Error("not a usable key");
  }
  if (out.every((b) => b === 0)) throw new Error("not a usable key");
  return out;
}

function aesKey(secret: Buffer, ephPub: Uint8Array, peerPub: Uint8Array, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.concat([ephPub, peerPub]), info, 32));
}

/** A judge's X25519 secret from the seed OutLayer generates in its TEE: what the judge module derives. */
export function judgeSecret(seed: Uint8Array, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", seed, "maskwars", info, 32));
}

/**
 * Seals a work for the judge's key, for one mask on one job of one contract. Text is UTF-8, up to 638 bytes; a module
 * is the Wasm bytes. `eph` and `nonce` are fresh random bytes unless given (a test vector pins them).
 */
export function sealWork(judgeKey: string, contract: string, job: string, mask: string, work: Work, fixed: { eph?: Uint8Array; nonce?: Uint8Array } = {}): string {
  const payload = work.kind === "text" ? Buffer.from(work.text, "utf8") : Buffer.from(work.bytes);
  if (payload.length === 0 || payload.length > MAX_WORK_BYTES) throw new Error(`a work is 1 to ${MAX_WORK_BYTES} bytes; this one is ${payload.length}`);
  const padded = Buffer.alloc(PADDED);
  padded[0] = work.kind === "text" ? TEXT : MODULE;
  payload.copy(padded, 1);
  padded[1 + payload.length] = 0x80;
  const judge = keyBytes(judgeKey);
  const eph = Buffer.from(fixed.eph ?? randomBytes(32));
  const nonce = Buffer.from(fixed.nonce ?? randomBytes(12));
  const ephPub = publicOf(eph);
  const key = aesKey(shared(eph, judge), ephPub, judge, WORK_INFO);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(workAad(contract, job, mask), "utf8"));
  const sealed = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);
  return BOX_PREFIX + Buffer.concat([ephPub, nonce, sealed]).toString("base64url");
}

/** Opens a work box with the judge's secret: only the judge in its TEE holds it. The sandbox's stand-in judge uses it. */
export function openWork(judge: Uint8Array, contract: string, job: string, mask: string, box: string): Work {
  if (!BOX.test(box)) throw new Error("the work is not sealed for the judge");
  const bytes = Buffer.from(box.slice(BOX_PREFIX.length), "base64url");
  if (bytes.length !== BOX_BYTES) throw new Error("a box has one size");
  const ephPub = bytes.subarray(0, 32);
  const key = aesKey(shared(judge, ephPub), ephPub, publicOf(judge), WORK_INFO);
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(32, 44));
  decipher.setAAD(Buffer.from(workAad(contract, job, mask), "utf8"));
  decipher.setAuthTag(bytes.subarray(-16));
  let padded: Buffer;
  try {
    padded = Buffer.concat([decipher.update(bytes.subarray(44, -16)), decipher.final()]);
  } catch {
    throw new Error("the box is not for this judge, job and mask");
  }
  let end = padded.length - 1;
  while (end > 0 && padded[end] === 0) end -= 1;
  if (padded[end] !== 0x80 || end < 2) throw new Error("the box holds no work");
  const body = padded.subarray(1, end);
  if (padded[0] === MODULE) return { kind: "module", bytes: new Uint8Array(body) };
  if (padded[0] === TEXT) return { kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(body) };
  throw new Error("the box holds no work");
}

/** The ephemeral key and nonce of a delivery: from the judge's secret, the job and the work, as the judge derives them. */
function deliveryEph(judge: Uint8Array, contract: string, job: string, client: string, work: Uint8Array): { eph: Buffer; nonce: Buffer } {
  const context = `${contract}:${job}:${client}:${createHash("sha256").update(work).digest("hex")}`;
  const eph = Buffer.from(hkdfSync("sha256", judge, context, "maskwars:delivery-eph:v1", 32));
  const nonce = Buffer.from(hkdfSync("sha256", judge, context, "maskwars:delivery-nonce:v1", 12));
  return { eph, nonce };
}

/** Seals the winner's work for the client's key: what the judge does once the job is paid. */
export function sealDelivery(judge: Uint8Array, clientKey: string, contract: string, job: string, client: string, work: Uint8Array): string {
  const clientPub = keyBytes(clientKey);
  const { eph, nonce } = deliveryEph(judge, contract, job, client, work);
  const ephPub = publicOf(eph);
  const key = aesKey(shared(eph, clientPub), ephPub, clientPub, DELIVERY_INFO);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(deliveryAad(contract, job, client), "utf8"));
  const sealed = Buffer.concat([cipher.update(work), cipher.final(), cipher.getAuthTag()]);
  return DELIVERY_PREFIX + Buffer.concat([ephPub, nonce, sealed]).toString("base64url");
}

/** Opens a delivery with the client's secret: what the client does on its own machine. */
export function openDelivery(clientSecret: Uint8Array, contract: string, job: string, client: string, text: string): Buffer {
  if (!text.startsWith(DELIVERY_PREFIX)) throw new Error("not a delivery");
  const bytes = Buffer.from(text.slice(DELIVERY_PREFIX.length).trim(), "base64url");
  if (bytes.length < 32 + 12 + 16) throw new Error("a delivery is too short");
  const ephPub = bytes.subarray(0, 32);
  const key = aesKey(shared(clientSecret, ephPub), ephPub, publicOf(clientSecret), DELIVERY_INFO);
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(32, 44));
  decipher.setAAD(Buffer.from(deliveryAad(contract, job, client), "utf8"));
  decipher.setAuthTag(bytes.subarray(-16));
  try {
    return Buffer.concat([decipher.update(bytes.subarray(44, -16)), decipher.final()]);
  } catch {
    throw new Error("the delivery is not for this key, job and client");
  }
}

/** What a delivery holds once opened: the winner's steps, each its text or its module, and for a review why it won. */
export interface Delivered {
  job: string;
  contract: string;
  entrant: number;
  work: { seq: number; mask: string; role: string; text?: string; module?: string }[];
  why?: string;
}
