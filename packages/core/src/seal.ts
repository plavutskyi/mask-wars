/**
 * Seal: hashes that commit to a hidden choice (packages/core/README.md, "Seal"). Fields are UTF-8 strings joined by one `0x00` byte;
 * `salt32` is 32 random bytes written as 64 lower-case hex characters and hashed as that text.
 *
 *   seal     = sha256("maskwars.seal.v1"     00 fight_id 00 mask_id 00 primary 00 backup 00 call 00 salt32)
 *   identity = sha256("maskwars.identity.v1" 00 mask_id 00 identity 00 salt32)
 *   strategy = sha256("maskwars.strategy.v1" 00 mask_id 00 text 00 salt32)
 */

import { CoreError } from "./errors.ts";
import { assertFightId, assertMaskId, assertSalt32 } from "./ids.ts";
import { sha256Hex, toHex, utf8 } from "./sha256.ts";

export const SEAL_DOMAIN = {
  seal: "maskwars.seal.v1",
  identity: "maskwars.identity.v1",
  strategy: "maskwars.strategy.v1",
} as const;

/** The exact bytes that are hashed: the parts joined by `0x00`. A part may not contain `0x00` itself. */
export function preimage(parts: readonly string[]): Uint8Array {
  for (const part of parts) if (part.includes("\u0000")) throw new CoreError("bad_move", "a sealed field may not contain 0x00");
  const encoded = parts.map(utf8);
  const out = new Uint8Array(encoded.reduce((n, p) => n + p.length, 0) + encoded.length - 1);
  let at = 0;
  encoded.forEach((p, i) => {
    if (i > 0) out[at++] = 0;
    out.set(p, at);
    at += p.length;
  });
  return out;
}

/** The fight seal over a discipline's move fields (Market Duel: primary, backup, call). */
export function fightSeal(fightId: string, maskId: string, fields: readonly string[], salt32: string): string {
  assertFightId(fightId);
  assertMaskId(maskId);
  assertSalt32(salt32);
  return sha256Hex(preimage([SEAL_DOMAIN.seal, fightId, maskId, ...fields, salt32]));
}

export function identitySeal(maskId: string, identity: string, salt32: string): string {
  assertMaskId(maskId);
  assertSalt32(salt32);
  return sha256Hex(preimage([SEAL_DOMAIN.identity, maskId, identity, salt32]));
}

export function strategySeal(maskId: string, text: string, salt32: string): string {
  assertMaskId(maskId);
  assertSalt32(salt32);
  return sha256Hex(preimage([SEAL_DOMAIN.strategy, maskId, text, salt32]));
}

/** Constant-shape comparison of two hex digests; a malformed seal never matches. */
export function sealMatches(expected: string, actual: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(expected) || expected.length !== actual.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return diff === 0;
}

export const verifyFightSeal = (seal: string, fightId: string, maskId: string, fields: readonly string[], salt32: string): boolean =>
  sealMatches(seal, fightSeal(fightId, maskId, fields, salt32));

export const verifyIdentitySeal = (seal: string, maskId: string, identity: string, salt32: string): boolean =>
  sealMatches(seal, identitySeal(maskId, identity, salt32));

export const verifyStrategySeal = (seal: string, maskId: string, text: string, salt32: string): boolean =>
  sealMatches(seal, strategySeal(maskId, text, salt32));

/** 32 bytes of salt from a source of randomness the caller passes in (the core has no randomness of its own). */
export function makeSalt32(randomBytes: (n: number) => Uint8Array): string {
  const bytes = randomBytes(32);
  if (bytes.length !== 32) throw new CoreError("bad_salt", "the source gave not 32 bytes");
  return toHex(bytes);
}
