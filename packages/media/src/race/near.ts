/**
 * NEAR amounts as the chain keeps them: exact decimal strings, up to 24 places (1 NEAR = 10^24 yocto). Sums are done in
 * yocto with bigint, so nothing is ever rounded up and every number on a card equals the one on chain.
 */

const YOCTO_PLACES = 24;
const ONE = 10n ** BigInt(YOCTO_PLACES);

/** A positive amount of NEAR written as a decimal: `1`, `0.1`, `0.08664`. No exponent, no sign, no trailing dot. */
export const NEAR_AMOUNT = /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,24})?$/;

export function toYocto(near: string): bigint {
  if (!NEAR_AMOUNT.test(near)) throw new Error(`not a NEAR amount: ${near}`);
  const [whole, frac = ""] = near.split(".");
  return BigInt(whole!) * ONE + BigInt(frac.padEnd(YOCTO_PLACES, "0"));
}

/** `1000000000000000000000000n` → `1`, `86640000000000000000000n` → `0.08664`. */
export function fromYocto(yocto: bigint): string {
  if (yocto < 0n) throw new Error("negative NEAR");
  const whole = yocto / ONE;
  const frac = (yocto % ONE).toString().padStart(YOCTO_PLACES, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Canonical form of an amount: `1.000` → `1`, `0.10` → `0.1`. */
export const near = (amount: string): string => fromYocto(toYocto(amount));

export const addNear = (...amounts: string[]): string => fromYocto(amounts.reduce((s, a) => s + toYocto(a), 0n));

/** `0.08664 NEAR`. */
export const nearText = (amount: string): string => `${near(amount)} NEAR`;

/**
 * An amount as a card, a clip and a post show it: at most five decimals, cut and never rounded up, so nothing on
 * screen is more than the chain moved. `0.08664` stays `0.08664`; `0.0011183205` reads `0.00111`. An amount too small
 * for five decimals keeps its first two digits.
 */
export function nearShort(amount: string): string {
  const exact = near(amount);
  const [whole, frac = ""] = exact.split(".");
  if (frac.length <= 5) return exact;
  const lead = frac.search(/[1-9]/);
  const cut = frac.slice(0, whole === "0" && lead >= 4 ? lead + 2 : 5).replace(/0+$/, "");
  return cut ? `${whole}.${cut}` : whole!;
}
