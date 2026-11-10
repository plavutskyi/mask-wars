/** NEAR amounts: yoctoNEAR as bigint inside, plain words outside. */

export const YOCTO = 10n ** 24n;

/** Whole or decimal NEAR, as a person types it, to yoctoNEAR. `null` for anything else. */
export function parseNear(text: string): bigint | null {
  const m = /^(\d{1,9})(?:\.(\d{1,24}))?$/.exec(text.trim());
  if (!m) return null;
  return BigInt(m[1]!) * YOCTO + BigInt((m[2] ?? "").padEnd(24, "0"));
}

/** `2`, `0.05`, `1.68`: rounded down to `digits` decimals, trailing zeros dropped. */
export function nearText(yocto: bigint | string, digits = 2): string {
  const y = BigInt(yocto);
  const unit = 10n ** BigInt(24 - digits);
  const units = y / unit;
  const whole = units / 10n ** BigInt(digits);
  const frac = (units % 10n ** BigInt(digits)).toString().padStart(digits, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
