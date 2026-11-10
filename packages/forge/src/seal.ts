/**
 * Seals a strategy line in the browser for the mind's key, which lives only inside the mind's TEE on OutLayer
 * (`services/brain`). The site never sees the line, the factory keeps only the box, and the box opens only for that
 * mind and that mask:
 *
 *   v1. + base64url( eph_pub (32) | nonce (12) | AES-256-GCM(key, nonce, line | 0x80 | 0x00…, aad = mask) (512 + 16) )
 *   key = HKDF-SHA256(ikm = X25519(eph, mind), salt = eph_pub | mind_pub, info = "maskwars:strategy:v1")
 *
 * Web Crypto only: no library, nothing leaves the page. `services/brain/vector.json` pins the bytes for both sides.
 */

export const PADDED = 512;
export const SEALED_LENGTH = 3 + 763;
export const MAX_CHARS = 160;
const INFO = new TextEncoder().encode("maskwars:strategy:v1");
const PKCS8_X25519 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);

/** One line: 1 to 160 characters, at most 511 bytes, no line breaks or other control characters. */
export function lineOk(line: string): boolean {
  const chars = [...line].length;
  return chars >= 1 && chars <= MAX_CHARS && new TextEncoder().encode(line).length < PADDED && !/\p{Cc}/u.test(line);
}

/** `x25519:<64 hex>` to the key's 32 bytes. */
export function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const m = /^x25519:([0-9a-f]{64})$/.exec(key);
  if (!m) throw new Error("the mind's key is x25519:<64 hex>");
  return Uint8Array.from(m[1]!.match(/../g)!.map((h) => parseInt(h, 16)));
}

/** Whether this browser can seal: X25519 in Web Crypto. */
export async function canSeal(): Promise<boolean> {
  try {
    await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
    return true;
  } catch {
    return false;
  }
}

/** Fixed bytes for the test vector only; a real seal always uses fresh random ones. */
export interface Fixed {
  readonly ephemeral: Uint8Array<ArrayBuffer>;
  readonly nonce: Uint8Array<ArrayBuffer>;
}

export async function seal(mindKey: string, mask: string, line: string, fixed?: Fixed): Promise<string> {
  if (!lineOk(line)) throw new Error("a strategy is one line of 1 to 160 characters");
  const subtle = crypto.subtle;
  const mindRaw = keyBytes(mindKey);
  const mind = await subtle.importKey("raw", mindRaw, { name: "X25519" }, false, []);
  const eph = fixed ? await fixedPair(fixed.ephemeral) : ((await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair);
  const shared = await subtle.deriveBits({ name: "X25519", public: mind }, eph.privateKey, 256);
  const ephRaw = new Uint8Array(await subtle.exportKey("raw", eph.publicKey));
  const ikm = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const aes = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: concat(ephRaw, mindRaw), info: INFO },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const nonce = fixed ? fixed.nonce : crypto.getRandomValues(new Uint8Array(12));
  const text = new TextEncoder().encode(line);
  const padded = new Uint8Array(PADDED);
  padded.set(text);
  padded[text.length] = 0x80;
  const box = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(mask) }, aes, padded));
  return `v1.${base64url(concat(ephRaw, nonce, box))}`;
}

async function fixedPair(secret: Uint8Array<ArrayBuffer>): Promise<CryptoKeyPair> {
  const privateKey = await crypto.subtle.importKey("pkcs8", concat(PKCS8_X25519, secret), { name: "X25519" }, true, ["deriveBits"]);
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  const publicKey = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "X25519", x: jwk.x! }, { name: "X25519" }, true, []);
  return { privateKey, publicKey };
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function base64url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, bytes.length - i + 1);
    for (let j = 0; j < chars; j++) out += B64[(n >> (18 - 6 * j)) & 63];
  }
  return out;
}
