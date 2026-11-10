// Moments, ms from the state change. The scene and the HUD read the same clock, so the sum lifts when the vault
// opens and the payout number lands with the pulse, with or without WebGL.

export const T = {
  /** Masks come out one by one: left, right, then the middle. */
  entranceStagger: [0, 180, 360] as const,
  entrance: 1100,
  /** Seam flash and bolts, then cracks, then the halves part and the sum lifts. */
  breachCrack: 120,
  breachSplit: 560,
  breach: 1800,
  /** From the open vault to the winner. */
  payoutFlight: 820,
  payout: 1700,
  /** When `paid` arrives without a broken vault first, the break plays before the payout. */
  payoutAfterBreach: 1150,
  lock: 900,
  /** Reduced motion: every change is a 200 ms fade (BRANDBOOK §9). */
  reduced: 200,
} as const;
