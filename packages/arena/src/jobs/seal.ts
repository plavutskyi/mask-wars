// A step's seal, by the jobs contract's own rule: sha256 of `maskwars-step:<job>:<mask>:<salt>:<content>`, lowercase
// hex. The mask's account is inside the hash, so nobody can seal or reveal another mask's step.
import { createHash, randomBytes } from "node:crypto";

export const STEP_PREFIX = "maskwars-step";
/** What the contract takes, as `contracts/jobs` checks it. */
export const MAX_CONTENT_BYTES = 1024;
export const MAX_STEPS = 4;
export const SALT = /^[A-Za-z0-9_-]{16,128}$/;
export const HEX64 = /^[0-9a-f]{64}$/;
/** A job id on the contract: 1 to 64 lowercase letters, digits, `-` or `_`. */
export const JOB_ID = /^[a-z0-9_-]{1,64}$/;
/** A NEAR account id. */
export const ACCOUNT_ID = /^(?=.{2,64}$)([a-z0-9]+[-_])*[a-z0-9]+(\.([a-z0-9]+[-_])*[a-z0-9]+)*$/;

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The seal of a step, as the contract computes it in `step_hash` and `seal_of`. */
export function stepHash(job: string, mask: string, salt: string, content: string): string {
  return sha256Hex(`${STEP_PREFIX}:${job}:${mask}:${salt}:${content}`);
}

/** A salt the contract takes: 32 letters, digits, `-` or `_`, from 24 random bytes. */
export function newSalt(): string {
  return randomBytes(24).toString("base64url");
}

/** Why the contract would refuse this content or salt, or `null`. */
export function contentProblem(content: string): string | null {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes === 0) return "the content is empty";
  if (bytes > MAX_CONTENT_BYTES) return `the content is ${bytes} bytes; a step holds at most ${MAX_CONTENT_BYTES}`;
  return null;
}

export function saltProblem(salt: string): string | null {
  return SALT.test(salt) ? null : "a salt is 16 to 128 letters, digits, - or _";
}
