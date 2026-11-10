/**
 * EIP-191 personal_sign recovery: NEAR AI TEEs sign completions with an Ethereum-style ECDSA key, and attestation
 * reports name that key by its address.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

export function personalMessageHash(message: string): Uint8Array {
  const body = utf8ToBytes(message);
  const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${body.length}`);
  return keccak_256(concatBytes(prefix, body));
}

export function addressOf(uncompressedPublicKey: Uint8Array): string {
  return `0x${bytesToHex(keccak_256(uncompressedPublicKey.slice(1)).slice(-20))}`;
}

/** The address that signed `message`, or null if the signature does not parse. Lower-case hex with 0x. */
export function recoverAddress(message: string, signatureHex: string): string | null {
  try {
    const sig = hexToBytes(signatureHex.replace(/^0x/i, ""));
    if (sig.length !== 65) return null;
    const v = sig[64]!;
    const recovery = v >= 27 ? v - 27 : v;
    if (recovery !== 0 && recovery !== 1) return null;
    const recovered = concatBytes(Uint8Array.of(recovery), sig.slice(0, 64));
    const pub = secp256k1.recoverPublicKey(recovered, personalMessageHash(message), { prehash: false });
    const full = secp256k1.Point.fromBytes(pub).toBytes(false);
    return addressOf(full);
  } catch {
    return null;
  }
}

/** Sign like a TEE would. Tests only: lets the verifier be tested without the network. */
export function signPersonal(message: string, secretKey: Uint8Array): string {
  const rec = secp256k1.sign(personalMessageHash(message), secretKey, { prehash: false, format: "recovered" });
  const out = concatBytes(rec.slice(1), Uint8Array.of(rec[0]! + 27));
  return `0x${bytesToHex(out)}`;
}

export function addressOfSecret(secretKey: Uint8Array): string {
  return addressOf(secp256k1.getPublicKey(secretKey, false));
}
