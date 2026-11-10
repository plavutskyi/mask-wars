/** What the Rust runner reports for one attempt. Field names match its JSON. */
import { z } from "zod";

export const Verdict = z.enum(["breach", "held", "invalid", "timeout", "error"]);
export type Verdict = z.infer<typeof Verdict>;

export const StepReport = z.object({
  index: z.number().int(),
  method: z.string(),
  ok: z.boolean(),
  logs: z.array(z.string()).optional(),
  value: z.string().optional(),
  error: z.string().optional(),
});
export type StepReport = z.infer<typeof StepReport>;

export const Outcome = z.object({
  challenge: z.string(),
  verdict: Verdict,
  reason: z.string(),
  vault_before: z.string(),
  vault_after: z.string(),
  attacker_before: z.string(),
  attacker_after: z.string(),
  stolen: z.string(),
  steps: z.array(StepReport),
  elapsed_ms: z.number().int().nonnegative(),
});
export type Outcome = z.infer<typeof Outcome>;

/** An outcome that never reached the sandbox (bad plan, aborted, runner missing). */
export function localOutcome(challenge: string, verdict: Verdict, reason: string): Outcome {
  return {
    challenge,
    verdict,
    reason,
    vault_before: "0",
    vault_after: "0",
    attacker_before: "0",
    attacker_after: "0",
    stolen: "0",
    steps: [],
    elapsed_ms: 0,
  };
}

const ONE_NEAR = 10n ** 24n;

/** `90.000 NEAR`, rounded down to three decimals. */
export function nearString(yocto: string | bigint): string {
  const milli = BigInt(yocto) / (ONE_NEAR / 1000n);
  return `${milli / 1000n}.${String(milli % 1000n).padStart(3, "0")} NEAR`;
}
