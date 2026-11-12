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
export function stakeOf(bytes: number): string;
export function setField(text: string, key: string, value: string): string;
