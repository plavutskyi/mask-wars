// Types for forge.mjs, which the race's tests import to check what the owner sends to make the forge on mainnet.
export const NEAR: bigint;
export const BYTE: bigint;
export const GLOBAL_BYTE: bigint;
export const ACCOUNT_BYTES: bigint;
export const KEEPER_KEY_BYTES: bigint;
export const KEEPER_METHODS: string;
export const OUTLAYER_CREDENTIALS: string;
export const BRAIN_DEPOSIT: bigint;
export const RUNS_TOPUP_USD: number;
export const USDC_ON_NEAR: string;
export const USDC_STORAGE: bigint;
export function runsLine(admin: string): string;
export const GAS: { readonly brain: bigint; readonly deploy: bigint; readonly publish: bigint; readonly key: bigint };
export function yocto(near: string): bigint;
export function nearUp(yocto: bigint, digits?: number): string;
export function sha256Hex(bytes: Uint8Array): string;
export function readJson(name: string): unknown;
export function brainBuild(): { readonly url: string; readonly hash: string; readonly bytes: number };
export interface Budget {
  readonly stake: bigint;
  readonly publish: bigint;
  readonly fund: bigint;
  readonly margin: bigint;
  readonly gas: bigint;
  readonly key: bigint;
  readonly brain: bigint;
  readonly keeperFloat: bigint;
  readonly total: bigint;
}
export function budget(o: { factoryBytes: number; maskBytes: number; stateBytes: number; fund: bigint; keeperFloat: bigint }): Budget;
export interface Step {
  readonly what: string;
  readonly cli: string;
  readonly check: string;
}
export function commands(o: {
  net: { readonly admin: string; readonly factory: string; readonly outlayer: { readonly contract: string } };
  wasmDir: string;
  initFile: string;
  fund: bigint;
  brainFile: string;
}): Step[];
