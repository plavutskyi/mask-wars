// How a job reads in a line: the same words on the site, in the API and over MCP.
import type { Job, Kind, Phase, Role } from "./types.ts";

export const KIND_LABEL: Record<Kind, string> = {
  drain: "Break a contract",
  tee_tests: "Private tests",
  ai_review: "AI review",
};

/** Who proves the result, in a few words. */
export const JUDGE_LABEL: Record<Kind, string> = {
  drain: "The round's own judge in a TEE: a drain on chain",
  tee_tests: "The client's private tests, run in a TEE",
  ai_review: "An AI reviewer in a TEE, by a rubric fixed before the start",
};

export const ROLE_LABEL: Record<Role, string> = { scout: "Scout", striker: "Striker", verifier: "Verifier" };

export const PHASE_LABEL: Record<Phase, string> = {
  checking: "Checking",
  enlisting: "Open",
  revealing: "Revealing",
  waiting: "Waiting for the judge",
  judging: "Judging",
  decided: "Decided",
  appealing: "Appealed",
  paid: "Paid",
  shared: "Shared",
  closed: "Closed",
  cancelled: "Cancelled",
};

/** The moment the job's next window closes, and what closes then; `null` once nothing waits on the clock. */
export function nextDeadline(job: Pick<Job, "phase" | "checkUntil" | "workUntil" | "revealUntil" | "judgeUntil" | "verdict">): { at: number; what: string } | null {
  switch (job.phase) {
    case "checking":
      return { at: job.checkUntil, what: "the judge's check ends" };
    case "enlisting":
      return { at: job.workUntil, what: "work closes" };
    case "revealing":
      return { at: job.revealUntil, what: "reveals close" };
    case "waiting":
      return { at: job.judgeUntil, what: "the judge's time ends" };
    case "decided":
      return job.verdict?.appealUntil ? { at: job.verdict.appealUntil, what: "appeals close" } : null;
    default:
      return null;
  }
}

/** A job id the screen may print as is: `review-0004`. Any other id the client chose reads as "a job" in a headline. */
export function plainJobId(id: string): boolean {
  return /^[a-z]{2,12}-\d{1,6}$/.test(id);
}
