// Jobs from outside: drains on our rounds that none of our own accounts opened, posted by people on /jobs or by
// agents. The arena's masks take them, and the house locks the masks' bonds on them, only within the network's
// `limits.jobs` (packages/network). What a job's own terms say against those limits is read here once, so the masks'
// plan (packages/race/src/work.ts), the house (packages/race/src/sponsor.ts) and the site (apps/web/app/jobs/round.ts,
// apps/web/lib/jobs-tick.ts) all refuse the same jobs: a job the plan would never take holds no place anywhere.
import { JOBS_TICK_LEAD_MINUTES, revealTicks, yocto, type Network } from "@maskwars/network";
import { near } from "../format.ts";
import type { Job } from "./types.ts";

const MINUTE = 60_000;

/** The shortest reveal window a mask takes any job with: two quarter hours, so a run that is late still finds it open. */
export const MIN_REVEAL_MS = 30 * MINUTE;
/** A run of the site's clock counts for a reveal window only when it starts this long before the window ends. */
export const REVEAL_RUN_MS = JOBS_TICK_LEAD_MINUTES * MINUTE;

/** The limits on jobs from outside that our masks take: the network's `limits.jobs`, as amounts and times. */
export interface OutsideRules {
  /** The least reward of such a job, yoctoNEAR. */
  readonly minReward: bigint;
  /** The most a mask's bond on such a job may be, yoctoNEAR: the house locks it. */
  readonly maxBond: bigint;
  /** Such jobs our masks, or the house's bonds for them, hold on one round. */
  readonly perRound: number;
  /** Such jobs of one client they hold at once. */
  readonly perClient: number;
  /** Such jobs one mask holds at once: the rest of its four places stay for our own jobs. */
  readonly seats: number;
  /** The most the house has out in bonds on such jobs at one time, yoctoNEAR: waiting for a mask, or on its seat. */
  readonly maxOut: bigint;
  /** The longest work window of such a job, ms: a bond of the house waits for its mask no longer. */
  readonly maxWorkMs: number;
  /** The longest reveal window of such a job, ms. */
  readonly maxRevealMs: number;
  /** The longest appeal window of such a job, minutes. */
  readonly maxAppealMinutes: number;
  /**
   * Runs of the site's clock that must fall inside such a job's reveal window (`revealRuns`). 0 where no clock is
   * counted on: a local chain, whose passes a test or a recording makes by hand.
   */
  readonly revealRuns: number;
  /** The house's slot, which the site's clock counts its runs from (`round` of packages/network). */
  readonly clock: { readonly first_minute: number; readonly every_minutes: number };
}

/** The network's limits on jobs from outside, as the plan reads them. */
export function outsideRules(n: Pick<Network, "limits" | "round">): OutsideRules {
  const j = n.limits.jobs;
  return {
    minReward: yocto(j.min_reward),
    maxBond: yocto(j.max_bond),
    perRound: j.per_round,
    perClient: j.per_client,
    seats: j.seats,
    maxOut: yocto(j.max_out),
    maxWorkMs: j.max_work_minutes * MINUTE,
    maxRevealMs: j.max_reveal_minutes * MINUTE,
    maxAppealMinutes: j.max_appeal_minutes,
    revealRuns: j.reveal_runs,
    clock: { first_minute: n.round.first_minute, every_minutes: n.round.every_minutes },
  };
}

/**
 * The runs of the site's clock that are sure to reveal a job's steps: those that start inside its reveal window, at
 * least `REVEAL_RUN_MS` before it ends. GitHub's own schedule may come as well; it is not counted on.
 */
export function revealRuns(job: Pick<Job, "workUntil" | "revealUntil">, clock: OutsideRules["clock"]): number[] {
  return revealTicks(clock, job.workUntil, job.revealUntil);
}

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const minutes = (ms: number) => Math.round(ms / MINUTE);

/**
 * Why our masks take no job from outside with these terms, whoever of them and whatever else is on the board, or null:
 * its reward, the bond it asks, and its windows. Terms never change once a job is open, so a job barred here is never
 * taken and the house never locks a bond on it.
 * - The work window: a bond of the house waits for its mask through it at most, so it is short.
 * - The reveal window: long enough for a late run, short enough to end, and with our own runs inside it: a seat that
 *   reveals nothing loses half its bond.
 */
export function outsideTermsBar(job: Pick<Job, "reward" | "bond" | "openedAt" | "workUntil" | "revealUntil" | "appealMinutes">, o: OutsideRules): string | null {
  if (BigInt(job.reward) < o.minReward) {
    return `a job from outside with ${near(job.reward)} NEAR of reward: our masks take one from ${near(o.minReward)} NEAR`;
  }
  if (BigInt(job.bond) > o.maxBond) {
    return `a job from outside that asks a bond of ${near(job.bond)} NEAR a mask: the house locks ${near(o.maxBond)} at most`;
  }
  const work = job.workUntil - job.openedAt;
  if (work > o.maxWorkMs) {
    return `a job from outside with a work window of ${minutes(work)} min: the house's bond waits for a mask ${minutes(o.maxWorkMs)} min at most`;
  }
  const reveal = job.revealUntil - job.workUntil;
  if (reveal < MIN_REVEAL_MS || reveal > o.maxRevealMs) {
    return `a job from outside with a reveal window of ${minutes(reveal)} min: our masks take one with ${minutes(MIN_REVEAL_MS)} to ${minutes(o.maxRevealMs)} min`;
  }
  if (job.appealMinutes > o.maxAppealMinutes) {
    return `a job from outside with an appeal window of ${job.appealMinutes} min: our masks take one with ${o.maxAppealMinutes} min at most`;
  }
  if (o.revealRuns > 0) {
    const runs = revealRuns(job, o.clock).length;
    if (runs < o.revealRuns) {
      return `a job from outside whose steps are revealed from ${hhmm(job.workUntil)} to ${hhmm(job.revealUntil)} UTC: the site's clock runs ${runs} time${runs === 1 ? "" : "s"} then, and our masks take one only with ${o.revealRuns} runs of ours sure to reveal`;
    }
  }
  return null;
}
