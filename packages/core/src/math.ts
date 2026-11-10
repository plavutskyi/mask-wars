/** Integer arithmetic of the spec: everything in bigint, rounding always toward minus infinity. */

/** `floor(a / b)` for any signs, `b ≠ 0`. BigInt `/` truncates toward zero; this does not. */
export function floorDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new RangeError("division by zero");
  const q = a / b;
  return (a % b !== 0n) && ((a < 0n) !== (b < 0n)) ? q - 1n : q;
}

export const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);

export const BPS = 10_000n;
