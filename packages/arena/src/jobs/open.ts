// The one call that opens a job: `open` on the jobs contract, with what the contract checks before it takes the
// deposit. Nothing here signs or sends: the site and the MCP tools hand the call to the client, whose own wallet signs.
import { BOX, KEY } from "./box.ts";
import { RULES } from "./rules.ts";
import { ACCOUNT_ID, HEX64, JOB_ID } from "./seal.ts";
import type { Kind, Market } from "./types.ts";

/** NEAR's storage price, yoctoNEAR a byte. */
const BYTE = 10n ** 19n;
const TGAS = 10n ** 12n;
/** Gas for `open`: it writes the job's record and sends back what the deposit does not use. */
export const OPEN_TGAS = 100;

/** What a client decides about its job. Amounts are yoctoNEAR in decimal strings. */
export interface OpenInput {
  readonly id: string;
  readonly kind: Kind;
  /** One line anyone can read: what to do. */
  readonly brief: string;
  /** sha256 (hex) of the full spec, published before the job opens. */
  readonly spec: string;
  /** sha256 of the rubric (`ai_review`) or of the private test set (`tee_tests`). */
  readonly rubric?: string | null;
  /** `drain`: the sealed round the job follows. */
  readonly round?: { readonly bounty: string; readonly id: string } | null;
  /** `tee_tests`: the profile of the client's own OutLayer secrets that holds the test set. */
  readonly secretsProfile?: string | null;
  /** What a work needs to win, with the client's reference work sealed for the judge's key (box.mjs). */
  readonly bar?: { readonly winAt: number; readonly cases?: number | null; readonly fuel?: string | null; readonly reference: string } | null;
  readonly reward: string;
  readonly fuelPerMask: string;
  readonly slots: number;
  /** Who may take it: any mask, masks of the contract's factories, or these accounts only. */
  readonly openTo?: { readonly who: "anyone" } | { readonly who: "registered" } | { readonly who: "masks"; readonly masks: readonly string[] };
  readonly workMinutes: number;
  readonly revealMinutes: number;
  readonly appealMinutes: number;
  /** What each mask locks to take the job; `fuelPerMask` when left out. */
  readonly bond?: string | null;
  /** `tee_tests`, `ai_review`: the client's X25519 key the winning work is sealed for. */
  readonly clientKey?: string | null;
}

/** What opening a job takes, as the contract's `quote` counts it. `record` is a ceiling: `open` charges the real size. */
export interface OpenCost {
  readonly reward: string;
  /** `fuelPerMask` for every slot. */
  readonly fuel: string;
  /** The judge runs the job pays for when it opens. */
  readonly judge: string;
  /** Storage the masks and the verdict may take: what is not used comes back when the job ends. */
  readonly reserve: string;
  /** The job's own record, at most. */
  readonly record: string;
  /** Attach this much: anything over what `open` takes is sent back at once. */
  readonly total: string;
}

/** The deposit `open` asks for, by the contract's own rule (`quote`). `judgeFee` is the contract's, from its config. */
export function openCost(reward: string, fuelPerMask: string, slots: number, judgeFee: string = RULES.judgeFee): OpenCost {
  const fuel = BigInt(fuelPerMask) * BigInt(slots);
  const judge = BigInt(judgeFee) * BigInt(RULES.judgeRuns);
  const reserve = BYTE * (BigInt(slots) * BigInt(RULES.maskStorageBytes + RULES.leftSeatBytes) + BigInt(RULES.jobGrowthBytes));
  const record = BYTE * BigInt(RULES.jobRecordBytes);
  return {
    reward,
    fuel: fuel.toString(),
    judge: judge.toString(),
    reserve: reserve.toString(),
    record: record.toString(),
    total: (BigInt(reward) + fuel + judge + reserve + record).toString(),
  };
}

const yocto = (v: string | null | undefined): bigint | null => (typeof v === "string" && /^\d{1,40}$/.test(v) ? BigInt(v) : null);
const whole = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;

/** The kinds a job can open with on this contract now: a drain needs a bounty contract to follow, the others a judge. */
export function openableKinds(market: Pick<Market, "judges" | "bounties" | "changing">): Kind[] {
  if (market.changing) return [];
  const kinds: Kind[] = [];
  if (market.bounties.length > 0) kinds.push("drain");
  for (const k of ["tee_tests", "ai_review"] as const) if (market.judges.some((j) => j.kind === k)) kinds.push(k);
  return kinds;
}

/**
 * Why the contract would refuse this `open` from `client`, in its own order; empty when it would take it. What only the
 * chain knows at the moment of the call (the id is free, the round exists) is not checked here.
 */
export function openProblems(input: OpenInput, market: Pick<Market, "judges" | "bounties" | "factories" | "changing">, client: string): string[] {
  const out: string[] = [];
  const reward = yocto(input.reward);
  const fuel = yocto(input.fuelPerMask);
  const bond = input.bond == null ? fuel : yocto(input.bond);
  if (market.changing) out.push("new code is waiting to apply on the contract: no job opens until it has");
  if (!JOB_ID.test(input.id)) out.push("id: 1 to 64 lowercase letters, digits, - or _");
  const briefBytes = Buffer.byteLength(input.brief, "utf8");
  if (briefBytes < 1 || briefBytes > RULES.maxBriefBytes) out.push(`brief: 1 to ${RULES.maxBriefBytes} bytes`);
  if (!HEX64.test(input.spec)) out.push("spec: the sha256 of the published spec, 64 hex digits");
  if (input.rubric != null && !HEX64.test(input.rubric)) out.push("rubric: the sha256 of the published rubric or test set, 64 hex digits");
  if (reward === null || reward < BigInt(RULES.minReward)) out.push("the reward is at least 0.1 NEAR");
  if (fuel === null || fuel < BigInt(RULES.minFuel) || fuel > BigInt(RULES.maxFuel)) out.push("fuel_per_mask: 0.01 to 1 NEAR");
  if (!whole(input.slots, 1, RULES.maxSlots)) out.push(`slots: 1 to ${RULES.maxSlots} masks`);
  if (reward !== null && fuel !== null && whole(input.slots, 1, RULES.maxSlots)) {
    if (fuel * BigInt(input.slots) > reward) out.push("fuel for all the slots is at most the reward");
    if (bond === null || bond < fuel || bond > reward) out.push("bond: from fuel_per_mask up to the reward");
  }
  if (!whole(input.workMinutes, 5, RULES.maxWorkMinutes)) out.push("work_minutes: 5 minutes to 3 days");
  if (!whole(input.revealMinutes, 5, 24 * 60)) out.push("reveal_minutes: 5 minutes to a day");
  if (!whole(input.appealMinutes, 10, 24 * 60)) out.push("appeal_minutes: 10 minutes to a day");

  if (input.kind === "drain") {
    if (!input.round) out.push("a drain job names the round it follows");
    else {
      if (!market.bounties.includes(input.round.bounty)) out.push(`round.bounty: a bounty contract this contract follows (${market.bounties.join(", ") || "none yet"})`);
      if (!JOB_ID.test(input.round.id)) out.push("round.id: 1 to 64 lowercase letters, digits, - or _");
    }
    if (input.secretsProfile != null) out.push("a drain is read from the chain: it takes no secrets");
    if (input.bar != null) out.push("a drain is won by its round: it sets no bar");
    if (input.clientKey != null) out.push("a drain's plan is on chain: it takes no client key");
  } else {
    if (input.round != null) out.push("only a drain follows a round");
    if (input.rubric == null) out.push("tee_tests and ai_review publish the rubric or test set first: its sha256");
    if (!market.judges.some((j) => j.kind === input.kind)) out.push("no judge serves this kind yet");
    if (input.kind === "ai_review" && input.secretsProfile != null) out.push("only tee_tests read secrets");
    if (input.kind === "tee_tests" && (input.secretsProfile == null || !/^[A-Za-z0-9_-]{1,64}$/.test(input.secretsProfile))) {
      out.push("secrets_profile: the profile of your OutLayer secrets that holds the test set, 1 to 64 letters, digits, - or _");
    }
    const bar = input.bar;
    if (!bar) out.push("tee_tests and ai_review set the bar a work must clear");
    else if (!BOX.test(bar.reference)) out.push("bar.reference: your own reference work sealed for the judge's key with box.mjs (mw1. and 934 characters)");
    else if (input.kind === "ai_review") {
      if (!whole(bar.winAt, 0, RULES.maxReviewWinAt) || bar.cases != null || bar.fuel != null) out.push(`bar: win_at 0 to ${RULES.maxReviewWinAt} points, no cases or fuel`);
    } else {
      const cases = bar.cases ?? 0;
      const caseFuel = yocto(bar.fuel);
      if (!whole(cases, 1, 64) || !whole(bar.winAt, 1, cases) || caseFuel === null || caseFuel <= 0n || caseFuel >= 2n ** 64n) out.push("bar: 1 to 64 cases, win_at 1 to cases, fuel a case");
    }
    if (input.clientKey == null || !KEY.test(input.clientKey)) out.push("client_key: your X25519 key, x25519:<64 hex digits>: the winning work is sealed for it");
  }

  const to = input.openTo ?? { who: "anyone" };
  if (to.who === "registered" && market.factories.length === 0) out.push("no factory registers masks here yet");
  if (to.who === "masks") {
    if (to.masks.length < 1 || to.masks.length > RULES.maxSlots || new Set(to.masks).size !== to.masks.length || !to.masks.every((m) => ACCOUNT_ID.test(m))) out.push(`masks: 1 to ${RULES.maxSlots} accounts, no repeats`);
    else if (to.masks.includes(client)) out.push("the client is not one of its own job's masks");
  }
  return out;
}

/** The arguments of `open`, in the contract's own names. The judge is the contract's for the kind, at its exact wasm. */
export function openArgs(input: OpenInput, market: Pick<Market, "judges">, client: string): Record<string, unknown> {
  const judge = input.kind === "drain" ? null : (market.judges.find((j) => j.kind === input.kind) ?? null);
  const to = input.openTo ?? { who: "anyone" };
  return {
    id: input.id,
    kind: input.kind,
    brief: input.brief,
    spec: input.spec,
    rubric: input.rubric ?? null,
    judge_version: judge?.version ?? null,
    round: input.round ? { bounty: input.round.bounty, id: input.round.id } : null,
    secrets: input.secretsProfile != null ? { profile: input.secretsProfile, account_id: client } : null,
    bar: input.bar ? { win_at: input.bar.winAt, cases: input.bar.cases ?? null, fuel: input.bar.fuel ?? null, reference: input.bar.reference } : null,
    reward: input.reward,
    fuel_per_mask: input.fuelPerMask,
    slots: input.slots,
    open_to: to.who === "masks" ? { who: "masks", masks: [...to.masks] } : { who: to.who },
    work_minutes: input.workMinutes,
    reveal_minutes: input.revealMinutes,
    appeal_minutes: input.appealMinutes,
    bond: input.bond ?? null,
    client_key: input.clientKey ?? null,
  };
}

/** One function call for a wallet to sign. */
export interface CallAction {
  readonly signer_id: string;
  readonly receiver_id: string;
  readonly method_name: string;
  readonly args: Record<string, unknown>;
  /** yoctoNEAR to attach. */
  readonly deposit: string;
  readonly gas: string;
}

/** The `open` call for `client`'s own wallet: the arguments, the deposit by the contract's rule and the gas. */
export function openAction(contract: string, client: string, input: OpenInput, market: Pick<Market, "judges" | "judgeFee">): CallAction {
  return {
    signer_id: client,
    receiver_id: contract,
    method_name: "open",
    args: openArgs(input, market, client),
    deposit: openCost(input.reward, input.fuelPerMask, input.slots, market.judgeFee).total,
    gas: (BigInt(OPEN_TGAS) * TGAS).toString(),
  };
}

/** yoctoNEAR as the NEAR CLI takes a deposit: exact, with no trailing zeros. */
function nearExact(yoctoNear: string): string {
  const v = BigInt(yoctoNear);
  const frac = (v % 10n ** 24n).toString().padStart(24, "0").replace(/0+$/, "");
  return `${v / 10n ** 24n}${frac ? `.${frac}` : ""}`;
}

/** The same call as one NEAR CLI command (near-cli-rs), signed from the caller's own keychain. */
export function nearCliCommand(network: string, a: CallAction): string {
  const args = `'${JSON.stringify(a.args).replace(/'/g, "'\\''")}'`;
  return `near contract call-function as-transaction ${a.receiver_id} ${a.method_name} json-args ${args} prepaid-gas '${BigInt(a.gas) / TGAS} Tgas' attached-deposit '${nearExact(a.deposit)} NEAR' sign-as ${a.signer_id} network-config ${network} sign-with-keychain send`;
}
