/**
 * A sealed plan (RULES.md): before anyone can see it, a mask puts only the hash of its plan on chain. The plan is the
 * list of calls it will send the safe, as JSON text; the seal is sha256 of `maskwars-commit:<id>:<mask>:<salt>:<plan>`
 * in lowercase hex. The bounty contract computes the same hash when the mask reveals the plan and the salt.
 */
import { createHash, randomBytes } from "node:crypto";

/** What can sign: a mask's key. Ed25519 signs deterministically, so the same key always gives the same salt. */
export interface Signer {
  sign(message: Uint8Array): Uint8Array;
}

/** One call of a plan on the safe, in the order the mask sends it. */
export interface SealedCall {
  readonly method: string;
  readonly args: Record<string, unknown>;
}

/** The plan's text, exactly as it is hashed and later revealed. */
export function planText(calls: readonly SealedCall[]): string {
  return JSON.stringify(calls.map((c) => ({ method: c.method, args: c.args })));
}

export function sealHash(id: string, mask: string, salt: string, plan: string): string {
  return createHash("sha256").update(`maskwars-commit:${id}:${mask}:${salt}:${plan}`, "utf8").digest("hex");
}

/** 32 random bytes in hex: nobody guesses the plan from its seal. */
export function newSalt(): string {
  return randomBytes(32).toString("hex");
}

/**
 * The salt of a mask's seal in round `id`: sha256 of the mask's own signature over `maskwars-salt:<id>:<mask>`, in
 * hex. Only the mask's key gives it, so nobody guesses the plan from its seal; and the same key gives it again, so a
 * job that died between commit and reveal can still reveal.
 */
export function sealSalt(key: Signer, id: string, mask: string): string {
  const signature = key.sign(Buffer.from(`maskwars-salt:${id}:${mask}`, "utf8"));
  return createHash("sha256").update(signature).digest("hex");
}
