import { base58, fromBase58, fromBase64 } from "./codec.ts";
import type { Nep413Payload, SignedNep413 } from "./oneclick.ts";

/** What a NEAR wallet's `signMessage` returns (NEAR Connect, NEP-413). */
export interface WalletSignature {
  readonly accountId: string;
  /** `ed25519:` + base58 */
  readonly publicKey: string;
  /** base64 in NEP-413; some wallets give base58 or `ed25519:` + base58 */
  readonly signature: string;
}

/** The 32-byte nonce a wallet's `signMessage` takes, from 1Click's NEP-413 payload. */
export function nonceBytes(p: Nep413Payload): Uint8Array {
  const n = fromBase64(p.nonce);
  if (!n || n.length !== 32) throw new Error("nonce is not 32 bytes");
  return n;
}

function signatureBytes(s: string): Uint8Array | null {
  const bare = s.startsWith("ed25519:") ? s.slice(8) : s;
  if (!s.startsWith("ed25519:")) {
    const b64 = fromBase64(bare);
    if (b64?.length === 64) return b64;
  }
  const b58 = fromBase58(bare);
  return b58?.length === 64 ? b58 : null;
}

/** The signed intent NEAR Intents accepts from a NEAR wallet's NEP-413 signature over `payload`. */
export function signedNep413(payload: Nep413Payload, w: WalletSignature): SignedNep413 {
  const sig = signatureBytes(w.signature);
  if (!sig) throw new Error("the wallet's signature is not 64 bytes");
  const key = w.publicKey.startsWith("ed25519:") ? fromBase58(w.publicKey.slice(8)) : null;
  if (key?.length !== 32) throw new Error("the wallet's key is not an ed25519 key");
  return { standard: "nep413", payload, public_key: w.publicKey, signature: `ed25519:${base58(sig)}` };
}
