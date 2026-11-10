import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  accountOf,
  base58,
  concat,
  equal,
  fromBase58,
  fromBase64,
  fromBase64url,
  hex,
  keyBytes,
  keyText,
  recoverKeys,
  signedBy,
  utf8,
  vaultAccountOk,
  type Assertion,
} from "@maskwars/pay";

/**
 * Proof that the person paying holds the vault the money goes to. A deposit address pays into one NEAR Intents
 * account, and the page around the checkout names that account; without this proof a stranger's page could name its
 * own account under our name and take a payer's money. So before any address goes out, the payer signs one line about
 * the job with the vault's own key: its passkey, or the NEAR wallet that owns the account. The money can then only
 * land in a vault the payer has just shown they hold.
 *
 * Both ways sign the same 32 bytes, the NEP-413 hash of the line: a NEAR wallet signs it as NEP-413 asks, and a passkey
 * takes it as its WebAuthn challenge. Nothing here moves money or spends anything; a leaked proof only lets someone
 * pay into the signer's own vault, for this job, for half an hour.
 */

/** What the payer signs about: the job's words and contract, the page that asked, and when. */
export interface ProofAsk {
  readonly text: string;
  readonly target: string;
  /** The page around the checkout, as the browser named it; `null` where it would not say. */
  readonly page: string | null;
  /** ISO time, to the second. */
  readonly at: string;
}

/** The line the payer's wallet shows and signs. One line per field, so a wallet's message view reads it as it is. */
export function proofMessage(a: ProofAsk): string {
  return [
    "MASK WARS: fund my vault for this job.",
    `Job: ${a.text}`,
    `Contract: ${a.target}`,
    `Asked by: ${a.page ?? "a page that did not say"}`,
    `At: ${a.at}`,
  ].join("\n");
}

/** NEP-413's tag, 2^31 + 413: a signed message can never be read as a transaction. */
export const NEP413_TAG = 2_147_484_061;

const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const borshString = (s: string) => {
  const bytes = utf8(s);
  return concat(u32(bytes.length), bytes);
};

/**
 * The 32 bytes both ways sign: sha256 of the NEP-413 tag and the borsh payload `{ message, nonce, recipient,
 * callbackUrl: None }`, exactly as NEAR wallets hash a `signMessage`.
 */
export function proofHash(message: string, nonce: Uint8Array, recipient: string): Uint8Array {
  if (nonce.length !== 32) throw new Error("a NEP-413 nonce is 32 bytes");
  return sha256(concat(u32(NEP413_TAG), borshString(message), nonce, borshString(recipient), Uint8Array.of(0)));
}

/** A proof as it travels from the vault window to the checkout and the server. Bytes are base64 (nonce) or base64url. */
export type VaultProof =
  | {
      readonly kind: "near";
      readonly ask: ProofAsk;
      /** base64, 32 bytes */
      readonly nonce: string;
      readonly recipient: string;
      readonly account: string;
      /** `ed25519:` + base58 */
      readonly publicKey: string;
      /** base64 as NEP-413 gives it; base58 and `ed25519:` + base58 are read too */
      readonly signature: string;
    }
  | {
      readonly kind: "passkey";
      readonly ask: ProofAsk;
      readonly nonce: string;
      readonly recipient: string;
      /** `p256:` + base58: the passkey's public key, whose account is the vault. */
      readonly key: string;
      readonly authenticatorData: string;
      readonly clientDataJSON: string;
      /** DER, as WebAuthn gives it */
      readonly signature: string;
    };

/** What the server checks a proof against: its own names for the site, and the job the address would be for. */
export interface ProofTerms {
  readonly text: string;
  readonly target: string;
  readonly page: string | null;
  /** NEP-413 recipient: this site's host, `maskwars.xyz`. */
  readonly recipient: string;
  /** The passkey's domain, `maskwars.xyz`. */
  readonly rpId: string;
  /** Where a passkey may have signed: this site's own origin(s). */
  readonly origins: readonly string[];
  readonly now?: number;
}

/** How long a proof opens addresses for, and how far a clock may run ahead. */
export const PROOF_MS = 30 * 60_000;
const SKEW_MS = 2 * 60_000;

export type ProofCheck =
  | {
      readonly ok: true;
      readonly vault: string;
      /** A named NEAR account whose key the chain must still vouch for (a full-access key, or one NEAR Intents knows). */
      readonly onChain: { readonly account: string; readonly publicKey: string } | null;
    }
  | { readonly ok: false; readonly why: string };

const no = (why: string): ProofCheck => ({ ok: false, why });

function signatureBytes(s: string): Uint8Array | null {
  const bare = s.startsWith("ed25519:") ? s.slice(8) : s;
  if (!s.startsWith("ed25519:")) {
    const b64 = fromBase64(bare);
    if (b64?.length === 64) return b64;
  }
  const b58 = fromBase58(bare);
  return b58?.length === 64 ? b58 : null;
}

/**
 * Reads a proof: the line is the one this job and page make, signed within the last half hour, for this site, and the
 * signature holds. Returns the vault it proves. A NEAR wallet's key is checked here only as a signature: whether that
 * key belongs to the account is the chain's to say (`onChain`), except for an implicit account, whose name is its key.
 */
export function readProof(p: VaultProof, t: ProofTerms): ProofCheck {
  if (!p || typeof p !== "object" || !p.ask || typeof p.ask !== "object") return no("not a proof");
  const ask = p.ask;
  if (ask.text !== t.text || ask.target !== t.target) return no("signed for another job");
  if ((ask.page ?? null) !== (t.page ?? null)) return no("signed for another page");
  const at = typeof ask.at === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(ask.at) ? Date.parse(ask.at) : NaN;
  const now = t.now ?? Date.now();
  if (!(at <= now + SKEW_MS) || now - at > PROOF_MS) return no("too old");
  if (p.recipient !== t.recipient) return no("signed for another site");
  const nonce = typeof p.nonce === "string" ? fromBase64(p.nonce) : null;
  if (nonce?.length !== 32) return no("no nonce");
  const hash = proofHash(proofMessage(ask), nonce, p.recipient);

  if (p.kind === "near") {
    if (typeof p.account !== "string" || !vaultAccountOk(p.account) || p.account.startsWith("0x")) return no("not a NEAR account");
    const key = typeof p.publicKey === "string" && p.publicKey.startsWith("ed25519:") ? fromBase58(p.publicKey.slice(8)) : null;
    const sig = typeof p.signature === "string" ? signatureBytes(p.signature) : null;
    if (key?.length !== 32 || !sig) return no("not an ed25519 signature");
    let ok = false;
    try {
      ok = ed25519.verify(sig, hash, key);
    } catch {
      ok = false;
    }
    if (!ok) return no("the signature does not hold");
    const publicKey = `ed25519:${base58(key)}`;
    // An implicit account is its key in hex: nobody else can sign for it, and no chain lookup is needed.
    if (/^[0-9a-f]{64}$/.test(p.account)) return hex(key) === p.account ? { ok: true, vault: p.account, onChain: null } : no("not this account's key");
    return { ok: true, vault: p.account, onChain: { account: p.account, publicKey } };
  }

  if (p.kind === "passkey") {
    const key = typeof p.key === "string" ? keyBytes(p.key) : null;
    const authenticatorData = typeof p.authenticatorData === "string" ? fromBase64url(p.authenticatorData) : null;
    const clientDataJSON = typeof p.clientDataJSON === "string" ? fromBase64url(p.clientDataJSON) : null;
    const signature = typeof p.signature === "string" ? fromBase64url(p.signature) : null;
    if (!key || !authenticatorData || !clientDataJSON || !signature) return no("not a passkey signature");
    if (authenticatorData.length < 37 || !equal(authenticatorData.subarray(0, 32), sha256(utf8(t.rpId)))) return no("another site's passkey");
    const flags = authenticatorData[32]!;
    if ((flags & 0x01) === 0 || (flags & 0x04) === 0) return no("the person was not verified");
    let c: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
    try {
      c = JSON.parse(new TextDecoder().decode(clientDataJSON));
    } catch {
      return no("client data is not JSON");
    }
    if (c.type !== "webauthn.get" || typeof c.challenge !== "string") return no("not a passkey assertion");
    const challenge = fromBase64url(c.challenge);
    if (!challenge || !equal(challenge, hash)) return no("signed something else");
    if (typeof c.origin !== "string" || !t.origins.includes(c.origin) || c.crossOrigin === true) return no("signed on another page");
    if (!signedBy({ authenticatorData, clientDataJSON, signature }, key)) return no("the signature does not hold");
    return { ok: true, vault: accountOf(key), onChain: null };
  }
  return no("not a proof");
}

/**
 * The passkey's key from its assertion, where the browser does not hand it over: a key this browser or the site
 * already knows for the credential (used only if the signature holds for it), else the one recovered key whose vault
 * is `want`. `null` when neither settles it: a second touch does (`keyFromTwo`).
 */
export function keyOfAssertion(a: Assertion, o: { known?: string | null; want?: string | null }): string | null {
  const k = o.known ? keyBytes(o.known) : null;
  if (k && signedBy(a, k)) return keyText(k);
  if (!o.want) return null;
  const hit = recoverKeys(a).find((x) => accountOf(x) === o.want);
  return hit ? keyText(hit) : null;
}

/** The one key two assertions by the same passkey share: what a device that never saw this vault learns in two touches. */
export function keyFromTwo(a: Assertion, b: Assertion): string | null {
  const x = recoverKeys(a);
  const both = recoverKeys(b).filter((k) => x.some((y) => equal(y, k)));
  return both.length === 1 ? keyText(both[0]!) : null;
}

/** The message the vault window sends the checkout that opened it: a proof, marked and versioned like host events. */
export interface ProofMessage {
  readonly maskwarsHireProof: 1;
  readonly relay: string;
  readonly proof: VaultProof;
  readonly vault: string;
}

export function proofEnvelope(relay: string, proof: VaultProof, vault: string): ProofMessage {
  return { maskwarsHireProof: 1, relay, proof, vault };
}

/** Whether a message is the vault window's answer for this checkout's `relay`. Everything else is ignored. */
export function proofOf(data: unknown, relay: string): { proof: VaultProof; vault: string } | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Partial<ProofMessage>;
  if (m.maskwarsHireProof !== 1 || m.relay !== relay || !m.proof || typeof m.proof !== "object" || typeof m.vault !== "string") return null;
  return { proof: m.proof, vault: m.vault };
}

/** A relay id: 32 random bytes in hex, made by the checkout and known only to it and the window it opens. */
export const relayOk = (r: unknown): r is string => typeof r === "string" && /^[0-9a-f]{64}$/.test(r);

/** The time a proof is made at, to the second, as `ProofAsk.at` takes it. */
export const proofTime = (d = new Date()): string => `${d.toISOString().slice(0, 19)}Z`;
