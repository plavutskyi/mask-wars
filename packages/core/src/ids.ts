/** Identifiers from the spec: `fight_id` is `f-<season>-<number>`, `mask_id` is lower-case letters and hyphens. */

import { CoreError } from "./errors.ts";

const FIGHT_ID = /^f-[0-9a-z]+-[0-9]+$/;
const MASK_ID = /^[a-z]+(?:-[a-z]+)*$/;
const SALT32 = /^[0-9a-f]{64}$/;

export function assertFightId(id: string): void {
  if (!FIGHT_ID.test(id)) throw new CoreError("bad_id", `fight_id must look like f-<season>-<number>: ${JSON.stringify(id)}`);
}

export function assertMaskId(id: string): void {
  if (!MASK_ID.test(id)) throw new CoreError("bad_id", `mask_id is lower-case letters and hyphens: ${JSON.stringify(id)}`);
}

/** `salt32`: 32 bytes written as 64 lower-case hex characters. */
export function assertSalt32(salt: string): void {
  if (!SALT32.test(salt)) throw new CoreError("bad_salt", "salt32 is 32 bytes as 64 lower-case hex characters");
}

export function assertOpId(id: string): void {
  if (id.length === 0 || id.length > 128) throw new CoreError("bad_id", "op_id is 1 to 128 characters");
}
