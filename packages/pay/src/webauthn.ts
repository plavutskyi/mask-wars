import { base64url, equal, fromBase64url } from "./codec.ts";
import type { SignedWebauthn } from "./oneclick.ts";
import { accountOf, authDataOf, authFlags, challengeOf, keyBytes, keyFromSpki, keyText, recoverKeys, signedBy, signedWebauthn, type Assertion } from "./passkey.ts";

/**
 * The passkey ceremonies in the browser: make a vault, open it on any device the passkey syncs to, sign an intent.
 * The passkey is bound to the site's domain for good (`PASSKEY_RP_ID`), so the same vault opens only on maskwars.xyz.
 */

export interface PasskeyVault {
  /** The credential id, base64url. */
  readonly id: string;
  /** `p256:` + base58 */
  readonly key: string;
  /** The vault's account in NEAR Intents. */
  readonly account: string;
}

/**
 * Why a ceremony did not give a vault. `local`: the passkey was made but lives on this device only (no BE flag), so a lost
 * or wiped device would lock the money for good; no vault is made from it. `exists`: this device already holds a vault
 * passkey the page knows, so no second one is made.
 */
export type PasskeyProblem = "cancelled" | "unsupported" | "domain" | "local" | "exists" | "unknown";

export class PasskeyError extends Error {
  readonly problem: PasskeyProblem;

  constructor(problem: PasskeyProblem) {
    super(problem);
    this.name = "PasskeyError";
    this.problem = problem;
  }
}

function problemOf(error: unknown): PasskeyError {
  if (error instanceof PasskeyError) return error;
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "AbortError") return new PasskeyError("cancelled");
  if (name === "SecurityError") return new PasskeyError("domain");
  if (name === "NotSupportedError") return new PasskeyError("unsupported");
  if (name === "InvalidStateError") return new PasskeyError("exists");
  return new PasskeyError("unknown");
}

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const buffer = (b: Uint8Array) => b.slice().buffer as ArrayBuffer;

export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function" && !!navigator.credentials;
}

/** Whether the browser can offer this site's passkeys in the email field's autofill. */
export async function autofillSupported(): Promise<boolean> {
  try {
    return passkeysSupported() && (await PublicKeyCredential.isConditionalMediationAvailable?.()) === true;
  } catch {
    return false;
  }
}

/**
 * Tells the browser's passkey manager that a credential is not a vault here, so it stops offering it: a passkey made
 * on one device only is cleaned up instead of lingering in autofill. Supported where the WebAuthn Signal API is.
 */
export async function forgetPasskey(rpId: string, id: string): Promise<void> {
  try {
    const signal = (PublicKeyCredential as unknown as { signalUnknownCredential?: (o: { rpId: string; credentialId: string }) => Promise<void> })
      .signalUnknownCredential;
    await signal?.call(PublicKeyCredential, { rpId, credentialId: id });
  } catch {
    /* not supported, or the manager declined: nothing else to do */
  }
}

/** The authenticator data of a new passkey, from the browser's helper or, without it, from the attestation object. */
function createdAuthData(res: AuthenticatorAttestationResponse): Uint8Array | null {
  if (typeof res.getAuthenticatorData === "function") return new Uint8Array(res.getAuthenticatorData());
  return res.attestationObject ? authDataOf(new Uint8Array(res.attestationObject)) : null;
}

/**
 * A new passkey, and with it a new vault. `name` is what the passkey is saved under: the person's email. A vault is made
 * only from a passkey that can sync to the person's other devices (BE): one that lives on this device alone is
 * forgotten again and refused as `local`. `exclude` lists vault passkeys this browser already knows, so the same
 * authenticator never makes a second, empty vault (`exists`). `elsewhere` asks for the passkey on another device: a
 * phone through its QR code, or a security key.
 */
export async function createVault(o: { rpId: string; name: string; exclude?: readonly string[]; elsewhere?: boolean }): Promise<PasskeyVault> {
  if (!passkeysSupported()) throw new PasskeyError("unsupported");
  let cred: PublicKeyCredential | null;
  try {
    const publicKey: PublicKeyCredentialCreationOptions & { hints?: string[] } = {
      rp: { id: o.rpId, name: "MASK WARS" },
      user: { id: buffer(random(16)), name: o.name, displayName: o.name },
      challenge: buffer(random(32)),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
        ...(o.elsewhere ? { authenticatorAttachment: "cross-platform" as const } : {}),
      },
      excludeCredentials: (o.exclude ?? []).flatMap((id) => {
        const raw = fromBase64url(id);
        return raw ? [{ type: "public-key" as const, id: buffer(raw) }] : [];
      }),
      ...(o.elsewhere ? { hints: ["hybrid"] } : {}),
      attestation: "none",
      timeout: 180_000,
    };
    cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  } catch (error) {
    throw problemOf(error);
  }
  if (!cred) throw new PasskeyError("cancelled");
  const id = base64url(new Uint8Array(cred.rawId));
  const res = cred.response as AuthenticatorAttestationResponse;
  if (typeof res.getPublicKey !== "function" || res.getPublicKeyAlgorithm() !== -7) throw new PasskeyError("unsupported");
  const flags = authFlags(createdAuthData(res) ?? new Uint8Array());
  if (!flags) throw new PasskeyError("unsupported");
  if (!flags.be) {
    await forgetPasskey(o.rpId, id);
    throw new PasskeyError("local");
  }
  const spki = res.getPublicKey();
  const key = spki ? keyFromSpki(new Uint8Array(spki)) : null;
  if (!key) throw new PasskeyError("unsupported");
  return { id, key: keyText(key), account: accountOf(key) };
}

async function assert(o: {
  rpId: string;
  challenge: Uint8Array;
  allow?: readonly string[];
  mediation?: CredentialMediationRequirement;
  signal?: AbortSignal;
}): Promise<{ id: string; assertion: Assertion }> {
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.get({
      publicKey: {
        challenge: buffer(o.challenge),
        rpId: o.rpId,
        allowCredentials: (o.allow ?? []).map((id) => ({ type: "public-key" as const, id: buffer(fromBase64url(id) ?? new Uint8Array()) })),
        userVerification: "required",
        timeout: 180_000,
      },
      ...(o.mediation ? { mediation: o.mediation } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
    })) as PublicKeyCredential | null;
  } catch (error) {
    throw problemOf(error);
  }
  if (!cred) throw new PasskeyError("cancelled");
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: base64url(new Uint8Array(cred.rawId)),
    assertion: { authenticatorData: new Uint8Array(r.authenticatorData), clientDataJSON: new Uint8Array(r.clientDataJSON), signature: new Uint8Array(r.signature) },
  };
}

/**
 * Opens a vault with a passkey the person already has. `known` gives the key this device or the site's index kept for a
 * credential; it is used only if the passkey's own signature holds for it. Otherwise the key is recovered from the
 * signature itself, which takes a second touch on a device that has never seen this vault.
 */
export async function openVault(o: {
  rpId: string;
  known: (id: string) => Promise<string | null>;
  mediation?: CredentialMediationRequirement;
  signal?: AbortSignal;
}): Promise<PasskeyVault & { recovered: boolean }> {
  if (!passkeysSupported()) throw new PasskeyError("unsupported");
  const first = await assert({ rpId: o.rpId, challenge: random(32), ...(o.mediation ? { mediation: o.mediation } : {}), ...(o.signal ? { signal: o.signal } : {}) });
  const hint = await o.known(first.id).catch(() => null);
  const hinted = hint ? keyBytes(hint) : null;
  if (hinted && signedBy(first.assertion, hinted)) return { id: first.id, key: keyText(hinted), account: accountOf(hinted), recovered: false };

  const a = recoverKeys(first.assertion);
  const second = await assert({ rpId: o.rpId, challenge: random(32), allow: [first.id] });
  if (second.id !== first.id) throw new PasskeyError("unknown");
  const b = recoverKeys(second.assertion);
  const both = a.filter((k) => b.some((x) => equal(x, k)));
  if (both.length !== 1) throw new PasskeyError("unknown");
  const key = both[0]!;
  return { id: first.id, key: keyText(key), account: accountOf(key), recovered: true };
}

/** Signs a NEAR Intents payload with the vault's passkey: one touch, verified here before it goes anywhere. */
export async function signWithPasskey(vault: PasskeyVault, payload: string, rpId: string): Promise<SignedWebauthn> {
  const key = keyBytes(vault.key);
  if (!key) throw new PasskeyError("unknown");
  const { assertion } = await assert({ rpId, challenge: challengeOf(payload), allow: [vault.id] });
  const signed = signedWebauthn(payload, key, assertion);
  if (!signed) throw new PasskeyError("unknown");
  return signed;
}
