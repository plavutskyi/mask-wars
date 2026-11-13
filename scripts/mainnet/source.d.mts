// Types for source.mjs, which the race's tests import to check the code that goes to mainnet.
import type { SourceMetadata } from "../../contracts/nep330.mjs";
export const ROUND_WINDOW: { from: string; to: string };
export const CONTRACTS: Record<string, { crate: string; scratch?: string; served?: (sha: string) => string }>;
export interface Built {
  file: string;
  bytes: Uint8Array;
  sha256: string;
  code: string;
  meta: SourceMetadata | null;
  why: string[];
  exports: string[];
}
export function crateVersion(crate: string, root?: string): string;
export function readBuild(dir: string, root?: string): Promise<Record<string, Built>>;
export function vaultFaults(b: Built, net: { round: { safe: string; min_loot: string } }): string[];
export function houseTerms(net: unknown, judge: string, code: string): Record<string, string | number | string[]>;
/** The kinds a live vault comes in, and the calls of each kind's desk. */
export const KINDS: { owner: string[]; limit: string[]; pause: string[] };
/** One step of a round by hand: who signs it, what it is, the commands that send it. */
export interface HandStep {
  who: string;
  what: string;
  commands: string[];
}
/** A round by hand on a fresh vault of `kind` with the code `b`: its account, what it gets, the owner's steps in order. */
export function handRound(
  b: Built,
  net: { admin: string; bounty: string; round: { min_loot: string; deposit: string }; limits: { hand: { safe_max: string } } },
  kind: string,
  id?: string,
  listed?: boolean | null,
  hours?: number,
): { kind: string; id: string; safe: string; fund: string; stake: bigint; bank: bigint; steps: HandStep[] };
export function stakeOf(bytes: number): string;
export function setField(text: string, key: string, value: string): string;
