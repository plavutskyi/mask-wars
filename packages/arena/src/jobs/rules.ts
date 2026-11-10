// The jobs contract's own limits, as `contracts/jobs/src/lib.rs` and `contracts/crews/src/lib.rs` hold them. A test
// reads both files and fails when a number here differs, so the site, the API and the MCP tools never state a rule the
// contract does not enforce. Amounts are yoctoNEAR in decimal strings.

const MILLI = 10n ** 21n;

export const RULES = {
  /** Masks a job seats at most, and the masks of one crew. */
  maxSlots: 16,
  minCrew: 2,
  maxCrew: 8,
  /** Steps a mask seals on one job, and what one step's content may hold. */
  maxSteps: 4,
  maxContentBytes: 1024,
  /** A box for the judge: `mw1.` and this many base64url characters, one size for every box. */
  boxPrefix: "mw1.",
  boxChars: 934,
  maxBriefBytes: 280,
  /** The least a job pays, and the fuel one mask's mind may burn on it. */
  minReward: (100n * MILLI).toString(),
  minFuel: (10n * MILLI).toString(),
  maxFuel: (1000n * MILLI).toString(),
  /** One judge run, and the runs a job pays for when it opens. */
  judgeFee: (10n * MILLI).toString(),
  judgeRuns: 8,
  appealBond: (200n * MILLI).toString(),
  /** Of a bond: what a seat with no counted step loses to the company, in basis points. */
  idleBps: 5000,
  maxFeeBps: 1000,
  /** Storage a bond's record may take before its mask enlists, bytes at 10^19 yocto each: comes back with the bond. */
  bondRecordBytes: 400,
  /** What a job reserves when it opens, bytes: for every slot its mask's records and a seat given back, for the job
   *  its verdicts and an appeal, and the ceiling `quote` counts for the job's own record. What is not used comes back. */
  maskStorageBytes: 7000,
  leftSeatBytes: 600,
  jobGrowthBytes: 1200,
  jobRecordBytes: 4400,
  maxLiveJobsPerMask: 4,
  /** The judge checks the client's material within this long of the opening. */
  checkHours: 6,
  /** After the reveal window anyone may call the judge for this long; then anyone closes the job unjudged. */
  judgeGraceHours: 12,
  /** An appeal's run may be asked again for this long after the appeal window. */
  appealGraceHours: 6,
  maxWorkMinutes: 3 * 24 * 60,
  /** The longest the judge may ask to be left alone after what it calls was down. */
  maxRetryWaitMinutes: 60,
  /** An `ai_review` bar: points of 100 a work needs to win, at most. */
  maxReviewWinAt: 80,
  /** Gas the contract asks for with `check`, `judge`, `deliver` and with `settle`, `close`, TGas. */
  minJudgeTgas: 180,
  minSettleTgas: 200,
  /** A crew's id on the crews contract, and the crews one mask joins at once. */
  crewId: /^[a-z0-9-]{3,32}$/,
  maxCrewsPerMask: 16,
  /** Storage a seat's entry takes on the crews contract, bytes. */
  crewSeatBytes: 160,
} as const;

/** What a mask's narrow key may call: on the jobs contract and on the crews contract. It can attach no NEAR. */
export const MASK_JOB_METHODS = ["enlist", "step", "reveal", "leave"] as const;
export const MASK_CREW_METHODS = ["join", "leave"] as const;

/** Why the crews contract would refuse this roster and split, or `null`: its own `check_roster` and `split_ok`. */
export function rosterProblem(members: readonly { mask: string; role: "scout" | "striker" | "verifier" }[], split: { scout: number; striker: number; verifier: number }): string | null {
  if (members.length < RULES.minCrew || members.length > RULES.maxCrew) return `a crew is ${RULES.minCrew} to ${RULES.maxCrew} masks`;
  if (new Set(members.map((m) => m.mask)).size !== members.length) return "a mask holds one seat in a crew";
  const roles = ["scout", "striker", "verifier"] as const;
  if (!roles.every((r) => Number.isInteger(split[r]) && split[r] >= 0 && split[r] <= 10_000)) return "a split is whole basis points per role";
  if (roles.reduce((a, r) => a + split[r], 0) !== 10_000) return "the split sums to 10000 basis points";
  if (!members.some((m) => m.role === "striker")) return "a crew has a striker: only a striker's work wins a job";
  for (const r of roles) {
    const held = members.some((m) => m.role === r);
    if (held && split[r] === 0) return `the split pays every role the crew has: ${r} gets nothing`;
    if (!held && split[r] > 0) return `the split pays no role the crew lacks: nobody is a ${r}`;
  }
  return null;
}
