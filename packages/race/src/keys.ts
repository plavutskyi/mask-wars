/**
 * A mask's race keys, all from one secret seed. NEAR gives a function-call key exactly one receiver, and every round of
 * a season races on a new safe (contracts/season): a mask needs a key on each. So the secret `MASK_KEYS`, which lives
 * only in the `live-race` environment (the `guard` job of `Live race` stops a run that finds it in the repository),
 * holds one seed per mask, and the key for receiver `R` is the ed25519 key whose 32-byte seed is
 * HMAC-SHA256(seed, "maskwars-race-key:" + R). The owner's script (`scripts/testnet/season-keys.ps1`) derives the same
 * public halves and adds them to each mask ahead of time: one on the bounty contract, one on each of the season's next
 * safes, any method there and never any NEAR. Neither the season nor the race ever needs a mask's full key.
 *
 * `MASK_KEYS` from before seasons holds the two keys themselves (`safe`, `claim`); they still work for the one safe
 * the `safe` key was made for.
 */
import { createHmac } from "node:crypto";
import { base58Encode, NearKey } from "./near-tx.ts";

/** One mask's entry in `MASK_KEYS`. */
export interface MaskSecret {
  /** 32 bytes in hex: every race key of the mask comes from it. */
  readonly seed?: string;
  /** Keys from before seasons: on one safe (`set_owner`, `sweep`) and on the bounty contract. */
  readonly safe?: string;
  readonly claim?: string;
}

export const KEY_LABEL = "maskwars-race-key:";

/** The mask's key for `receiver`, from its seed. */
export function raceKey(seedHex: string, receiver: string): NearKey {
  if (!/^[0-9a-f]{64}$/.test(seedHex)) throw new Error("a mask's seed is 32 bytes in lowercase hex");
  const seed = createHmac("sha256", Buffer.from(seedHex, "hex")).update(KEY_LABEL + receiver, "utf8").digest();
  return new NearKey(`ed25519:${base58Encode(seed)}`);
}

/**
 * The keys a mask plays one round with: on the round's safe and on the bounty contract. `anyMethod` says whether its
 * key on the safe reaches every method there (a seed's key does; an old `safe` key only `set_owner` and `sweep`).
 */
export function roundKeys(secret: MaskSecret, safe: string, bountyContract: string): { safeKey: NearKey; claimKey: NearKey; anyMethod: boolean } {
  if (secret.seed) {
    return { safeKey: raceKey(secret.seed, safe), claimKey: raceKey(secret.seed, bountyContract), anyMethod: true };
  }
  if (secret.safe && secret.claim) {
    return { safeKey: new NearKey(secret.safe), claimKey: new NearKey(secret.claim), anyMethod: false };
  }
  throw new Error("MASK_KEYS: a mask needs a seed, or both a safe and a claim key");
}

/**
 * The mask's key on the bounty contract alone: the race job seals the winning finding for its public half (the
 * repository variable `MASK_CLAIM_KEYS`), and the drain job opens the box with it before it knows the round's safe.
 */
export function claimKeyOf(secret: MaskSecret, bountyContract: string): NearKey {
  if (secret.seed) return raceKey(secret.seed, bountyContract);
  if (secret.claim) return new NearKey(secret.claim);
  throw new Error("MASK_KEYS: a mask needs a seed, or a claim key");
}

/** Every secret string in `MASK_KEYS`, so a job log never shows one. */
export function secretsOf(keys: Record<string, MaskSecret>): string[] {
  return Object.values(keys).flatMap((k) => [k.seed, k.safe, k.claim].filter((s): s is string => typeof s === "string" && s !== ""));
}
