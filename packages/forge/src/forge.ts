/** One forge: what the person chose, the transaction the wallet signs, and what the deposit buys. */

import { YOCTO } from "./near.ts";

export interface Draft {
  readonly look: string;
  readonly model: string;
  readonly style: string;
  /** The sealed box, never the line itself. A copy carries none: it plays its author's. */
  readonly strategy: string | null;
  readonly name: string;
  /** yoctoNEAR. */
  readonly fuel: bigint;
  /** The author's mask name, when this forge is a copy of it. */
  readonly copyOf?: string | null;
  /** The author's share the person saw and agrees to, basis points: the factory forges the copy only at this share. */
  readonly copyBps?: number | null;
}

/** What the forge call may burn: the account, the mask code, `init` and the factory's callback fit in 100 TGas. */
export const FORGE_GAS = "100000000000000";
/** Fuel a person picks from, NEAR. */
export const FUEL_CHOICES = [1, 2, 5] as const;
export const DEFAULT_FUEL = 2;
/**
 * The most the mask's record costs to store: the record with the longest name, a sealed strategy and its races
 * (0.01574 NEAR, measured on the factory).
 */
export const RECORD_STORAGE = YOCTO / 1000n * 16n;

/** The wallet's action: `forge` on the factory with the deposit attached. A copy forges with `copy_of`, the share the
 * person agreed to (`copy_bps`) and no strategy of its own: it plays its author's, sealed in a TEE. */
export function forgeAction(d: Draft) {
  if (d.copyOf && !d.copyBps) throw new Error("a copy names the author's share it agrees to");
  return {
    type: "FunctionCall" as const,
    params: {
      methodName: "forge",
      args: {
        name: d.name,
        look: d.look,
        model: d.model,
        style: d.style,
        strategy: d.copyOf ? null : d.strategy,
        race_limit: null,
        copy_of: d.copyOf ?? null,
        copy_bps: d.copyOf ? d.copyBps : null,
      },
      gas: FORGE_GAS,
      deposit: d.fuel.toString(),
    },
  };
}

/**
 * The least the tank holds after forging and how many races that pays for at the least: the deposit, less the mask's
 * own account (`mask_fund`) and the record's storage, at `race_limit` a race at most.
 */
export function tank(fuel: bigint, maskFund: bigint, raceLimit: bigint): { brain: bigint; races: number } {
  const brain = fuel - maskFund - RECORD_STORAGE;
  if (brain <= 0n || raceLimit <= 0n) return { brain: 0n, races: 0 };
  return { brain, races: Number(brain / raceLimit) };
}

/**
 * Whose a name is, for the person who just signed its forge or came back from their wallet: `mine` once their mask
 * is forged, `forging` while its account is on the way, `theirs` when someone else holds the name (their own forge
 * was refused and the deposit went back), `none` when no mask has it.
 */
export type Outcome = "mine" | "forging" | "theirs" | "none";

export function outcome(mask: { readonly owner: string; readonly state: string } | null, account: string): Outcome {
  if (!mask) return "none";
  if (mask.owner !== account) return "theirs";
  return mask.state === "forging" ? "forging" : "mine";
}

/** A forge the page waits for across a wallet redirect: the name and who signed it. */
export interface PendingForge {
  readonly name: string;
  readonly account: string;
}

export function readPending(text: string | null): PendingForge | null {
  if (!text) return null;
  try {
    const p = JSON.parse(text) as Partial<PendingForge>;
    return typeof p.name === "string" && typeof p.account === "string" && p.account ? { name: p.name, account: p.account } : null;
  } catch {
    return null;
  }
}
