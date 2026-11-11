// Types for house.mjs, which the race's tests import to check what the masks send home.
export const LEAST: bigint;
export function yocto(near: string): bigint;
export function milli(yocto: bigint): string;
export function homeTransfers(o: {
  masks: readonly { account: string; amount: bigint }[];
  keep: bigint;
  house: bigint;
  houseMax: bigint;
}): { transfers: { account: string; holds: bigint; send: bigint }[]; after: bigint };
