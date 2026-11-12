/**
 * The house locks the bonds of the arena's masks on jobs from outside, so a job a person posts on /jobs with their own
 * wallet is taken, judged and paid with nobody's hand on it. A mask's key on the jobs contract attaches no NEAR (src/
 * work.ts), and the contract lets anyone lock a bond for any mask (`bond`), giving it back to whoever locked it when the
 * job ends (`settle`, `close`, `cancel`) or, while the mask has not taken its seat, when that one takes it back
 * (`unbond`). The house is one of our own accounts, so a bond it locked is one our masks take.
 *
 * One pass, before the masks' own (the Jobs workflow's `sponsor`, then `take`):
 * - MASK CHECK on the client of every job from outside that still takes masks, first: the house locks nothing for a
 *   client it blocks or gave no answer about, and a chain MASK CHECK could not read is no answer (`wordOf`);
 * - the masks' own plan (`plan`), run as if the house offered a bond to every mask of ours on every such job: the
 *   masks that plan would seat on a job are the bonds the house locks there, so the house locks exactly what the masks
 *   take, within the same limits (`Ours.outside`: the reward, the bond, short windows with our own runs inside the
 *   reveal, a few a round, one live job a client, a few places of each mask) and the same bars (the round, the slots,
 *   the crew, the work window);
 * - every job a bond of the house waits on holds its place in those limits, whether or not a mask of ours got its
 *   seat: an outsider who fills a job's slots before our masks enlist frees no room, so the house never bonds job
 *   after job on one round;
 * - an absolute cap, counted before anything is signed: with the bonds that wait and the bonds on our masks' seats,
 *   the house never has more than `Ours.outside.maxOut` out at one time (`limits.jobs.max_out`);
 * - all the bonds of one job in one transaction (one `bond` action a mask): a crew takes its seats together or not at
 *   all, so the house never holds half a crew's bonds;
 * - only from what the house holds beyond what its next round needs beside the vault (`houseKeeps`) and the gas of its
 *   transactions: a job the house cannot pay whole waits, and a later one gets the room;
 * - every bond of the house that waits where the masks' plan no longer seats its mask comes back with `unbond` at
 *   once, all of a job's in one transaction: the slots filled up, the client is barred, a limit no longer lets the job
 *   through, the work window is about to close, the job is over or gone from the reading. The house holds a bond that
 *   waits only where it would lock one now.
 *
 * The bonds are found by asking the contract about every job from outside opened within `JOB_LOOKBACK_MS`, a day more
 * than the longest any job lives, on the whole board (`wholeBoard`: the newest jobs and the drains they pushed off
 * it): nothing anyone opens hides a bond of the house from the pass that takes it back.
 *
 * The house's key also signs the house's day (src/house.ts) at the slot: nothing is sent from the slot until the
 * round of that slot is open on chain (an hour at most), so the two never take the same nonce.
 * Every decision runs by the chain's clock, the time of the block the board was read at.
 */
import { near } from "@maskwars/arena";
import { BOND_STORAGE, OVER, type Job, type JobBoard, type Jobs } from "@maskwars/arena/jobs";
import { slotAt, type HouseRound } from "@maskwars/network";
import { functionCall, send, type CallResult, type Chain, type NearKey } from "./near-tx.ts";
import { fromOutside, JOB_LOOKBACK_MS, plan, readFacts, STEP_MARGIN_MS, viewAt, wholeBoard, type Facts, type Ours, type Plan, type Skip, type Verdict } from "./work.ts";

/** Gas each `bond` and `unbond` action carries, TGas: a record written or removed, a transfer back. */
export const BOND_GAS = 30;
/** What the house keeps for the gas of one transaction beside its bonds: NEAR buys gas up front. */
export const TX_GAS_KEEP = 10n ** 22n;
/** The house's day is signed from its slot until its round is open, and never past this long after the slot. */
export const HOUSE_DAY_MS = 60 * 60_000;
/** How often a transaction whose nonce a node read too early is signed again. */
const NONCE_RETRIES = 3;

/** The house as one pass reads it, at the board's block. */
export interface HouseFacts {
  readonly account: string;
  /** Its balance less the stake its storage locks. */
  readonly free: bigint;
  /** The key it signs with is a full key of its own: only such a key attaches NEAR. */
  readonly fullAccess: boolean;
  /** What it keeps whatever it locks (`houseKeeps`). */
  readonly keeps: bigint;
  /** Its day may be signing now: nothing is sent. */
  readonly busy: boolean;
}

/** A bond of the house on a job: for which mask, how much. */
export interface Waiting {
  readonly job: string;
  readonly mask: string;
  readonly amount: bigint;
}

/** The bonds the house has out on jobs from outside: those that wait for their mask, and those on a mask's seat. */
export interface HouseBonds {
  readonly waiting: readonly Waiting[];
  readonly seated: readonly Waiting[];
}

export type SponsorAct =
  /** One transaction: a `bond` for each of these masks (names) on the job, each with its record's storage. */
  | { readonly kind: "bond"; readonly job: string; readonly masks: readonly string[]; readonly each: bigint; readonly deposit: bigint }
  /** One transaction: an `unbond` for each of these masks (names) on the job. */
  | { readonly kind: "unbond"; readonly job: string; readonly masks: readonly string[]; readonly back: bigint };

export interface SponsorPlan {
  readonly acts: readonly SponsorAct[];
  readonly skips: readonly Skip[];
  /** What the house can still lock beyond what it keeps, after the acts. */
  readonly spare: bigint;
  /**
   * What the house has out in bonds with the acts' new ones: waiting for a mask (with their records' storage) or on a
   * seat. Never above `Ours.outside.maxOut`. A bond it takes back now still counts: it is free once that lands.
   */
  readonly out: bigint;
}

const bondKey = (job: string, mask: string) => `${job}/${mask}`;
const nameOf = (ours: Ours, account: string) => Object.entries(ours.masks).find(([, a]) => a === account)?.[0] ?? null;

/** Every seat a job ever had: a mask that left does not come back. */
const everSeated = (job: Job) => new Set(job.entrants.flatMap((e) => e.members.map((m) => m.mask.account)));

/** No mask of ours can take a seat on this job any more: it is over, past enlisting, or its work window is about to close. */
const pastTaking = (job: Job, now: number) => OVER.has(job.phase) || job.phase !== "enlisting" || now >= job.workUntil - STEP_MARGIN_MS;

/** The masks (accounts) a plan seats on each job now: `<job>/<account>`. */
function seatsOf(p: Plan, ours: Ours): Set<string> {
  const out = new Set<string>();
  for (const a of p.acts) {
    if (a.kind === "enlist") out.add(bondKey(a.job, ours.masks[a.mask]!));
    if (a.kind === "enlist_crew") for (const m of a.members) out.add(bondKey(a.job, ours.masks[m]!));
  }
  return out;
}

/** What the house has out in bonds: each that waits with its record's storage, each on a seat as it was locked. */
export function houseOut(waiting: readonly Waiting[], seated: readonly Waiting[]): bigint {
  return waiting.reduce((a, w) => a + w.amount + BigInt(BOND_STORAGE), 0n) + seated.reduce((a, w) => a + w.amount, 0n);
}

/**
 * What the house does now, from one reading of the board, the masks' facts at its block (with MASK CHECK's verdicts),
 * the house's own facts and the bonds it has out: those that wait, and those on our masks' seats. Pure: the same
 * reading gives the same plan.
 */
export function sponsorPlan(board: JobBoard, facts: Facts, ours: Ours, house: HouseFacts, waiting: readonly Waiting[], seated: readonly Waiting[] = []): SponsorPlan {
  const now = board.readAt;
  const acts: SponsorAct[] = [];
  const skips: Skip[] = [];
  let spare = house.free - house.keeps;
  let out = houseOut(waiting, seated);
  if (!ours.owners.includes(house.account)) {
    return { acts, skips: [{ job: "-", why: `${house.account} is not one of our own accounts here: our masks would not take a bond it locked` }], spare, out };
  }
  if (house.busy) return { acts, skips: [{ job: "-", why: "the house's day may be signing now: the house sends nothing until its round of this slot is open" }], spare, out };

  if (!house.fullAccess) {
    skips.push({ job: "-", why: `the key the house signs with here is not a full key of ${house.account}: it attaches no NEAR, so the house locks no bond` });
    return { acts, skips, spare, out };
  }

  // The jobs from outside that still take masks, and the masks of ours the house could offer a bond on each.
  const candidates = board.jobs.filter((j) => j.phase === "enlisting" && fromOutside(j, ours) && !pastTaking(j, now));
  const accounts = Object.values(ours.masks);
  const offer = new Map<string, bigint>();
  for (const job of candidates) {
    const on = everSeated(job);
    for (const a of accounts) {
      const k = bondKey(job.id, a);
      // A bond waits already (ours, or an outsider's that the contract keeps the place of): none of the house's.
      if (on.has(a) || job.client === a || facts.bonds.has(k) || facts.foreignBonds?.has(k)) continue;
      offer.set(k, BigInt(job.bond));
    }
  }

  // The masks' own plan with those offers: whatever it seats on an offered bond is what the house locks. The bonds
  // that already wait hold their places in it (work.ts), offered ones hold none until the plan takes them. A job the
  // house cannot pay whole, or that would take it past its cap, drops out and the plan runs again, so a later job gets
  // its place in the round.
  const dropped = new Set<string>();
  const bonds: SponsorAct[] = [];
  // What the masks' plan seats now, on the bonds that wait and the house's offers together: decided below.
  let takes = new Set<string>();
  for (let round = 0; round <= candidates.length; round++) {
    const offered = new Map([...offer].filter(([k]) => !dropped.has(k.slice(0, k.lastIndexOf("/")))));
    const p = plan(board, { ...facts, offered }, ours);
    const wanted: { job: Job; masks: string[] }[] = [];
    for (const job of [...candidates].sort((a, b) => a.openedAt - b.openedAt || (a.id < b.id ? -1 : 1))) {
      if (dropped.has(job.id)) continue;
      const taken = p.acts.flatMap((a) => (a.kind === "enlist" && a.job === job.id ? [a.mask] : a.kind === "enlist_crew" && a.job === job.id ? [...a.members] : []));
      const masks = taken.filter((n) => offered.has(bondKey(job.id, ours.masks[n]!)));
      if (masks.length > 0) wanted.push({ job, masks });
    }
    let left = spare;
    let locked = out;
    const fit: SponsorAct[] = [];
    let short: { job: Job; why: string } | null = null;
    for (const { job, masks } of wanted) {
      const each = BigInt(job.bond) + BigInt(BOND_STORAGE);
      const deposit = each * BigInt(masks.length);
      if (locked + deposit > ours.outside.maxOut) {
        short = { job, why: `the house has ${near(locked)} NEAR out in bonds and ${near(ours.outside.maxOut)} at most at one time: the bonds of this job take ${near(deposit)} more` };
        break;
      }
      if (deposit + TX_GAS_KEEP > left) {
        short = {
          job,
          why: `the house holds ${near(house.free > 0n ? house.free : 0n)} NEAR free and keeps ${near(house.keeps)} for its next round: the bonds of this job take ${near(deposit)} more than it can lock now`,
        };
        break;
      }
      left -= deposit + TX_GAS_KEEP;
      locked += deposit;
      fit.push({ kind: "bond", job: job.id, masks, each, deposit });
    }
    if (short) {
      dropped.add(short.job.id);
      skips.push({ job: short.job.id, why: short.why });
      continue;
    }
    bonds.push(...fit);
    takes = seatsOf(p, ours);
    spare = left;
    out = locked;
    // Why the masks would not take a job even with the house's bonds: said once, for the job.
    for (const job of candidates) {
      if (dropped.has(job.id) || fit.some((a) => a.job === job.id)) continue;
      // The plan's note about a bond that waits is the masks' own: here the house's acts above say it.
      const why = (p.skips.find((s) => s.job === job.id && !s.mask)?.why ?? p.skips.find((s) => s.job === job.id)?.why)?.replace(/\. Its bond waits: .*$/, "");
      if (why) skips.push({ job: job.id, why: `no bond of the house: ${why}` });
    }
    break;
  }

  // The bonds of the house that wait where that plan seats their mask no more come back, and first: the job is over,
  // gone from the reading or past taking, its slots filled up, its client is barred or MASK CHECK gave no answer, a
  // limit lets it through no longer. The plan is the one with the house's offers in it, so a crew that only waits for
  // the bond the house locks in this very pass keeps the bonds it has. The house holds a waiting bond only where it
  // would lock one now.
  const byJob = new Map<string, Waiting[]>();
  for (const w of waiting) byJob.set(w.job, [...(byJob.get(w.job) ?? []), w]);
  for (const [id, ws] of byJob) {
    const job = board.jobs.find((j) => j.id === id);
    const back = job && !pastTaking(job, now) ? ws.filter((w) => !takes.has(bondKey(id, w.mask))) : ws;
    if (back.length === 0) continue;
    acts.push({ kind: "unbond", job: id, masks: back.map((w) => nameOf(ours, w.mask) ?? w.mask), back: back.reduce((a, w) => a + w.amount, 0n) });
  }
  acts.push(...bonds);
  return { acts, skips, spare, out };
}

/** Whether the house's day may be signing at `now`: from its slot until a round the house opened in that slot seals. */
export function houseDayBusy(round: Pick<HouseRound, "live" | "first_minute" | "every_minutes">, now: number, sealUntil: number | null): boolean {
  if (!round.live) return false;
  const slot = slotAt(round, now);
  if (slot === null || now - slot >= HOUSE_DAY_MS) return false;
  // A round that seals past the slot was opened in it: the house's day is over.
  return !(sealUntil !== null && sealUntil > slot);
}

// ---------------------------------------------------------------------------------------------------------------
// Reading and doing
// ---------------------------------------------------------------------------------------------------------------

/**
 * The bonds the house has out on jobs from outside, asked of the contract for every such job opened within
 * `JOB_LOOKBACK_MS` (a day more than the longest any job lives) and every mask of ours: those that wait for their
 * mask, which the house may have to take back, and those on a mask's seat, which come back when the job ends. Give it
 * the whole board (`wholeBoard`): a job newer ones pushed off the newest sixty is asked about like any other.
 */
export async function readHouseBonds(chain: Chain, board: JobBoard, ours: Ours, house: string): Promise<HouseBonds> {
  const height = board.block?.height;
  if (height === undefined || height === null) throw new Error("the board was read at no block");
  const waiting: Waiting[] = [];
  const seated: Waiting[] = [];
  for (const job of board.jobs) {
    if (!fromOutside(job, ours) || board.readAt - job.openedAt > JOB_LOOKBACK_MS) continue;
    for (const mask of Object.values(ours.masks)) {
      if (job.client === mask) continue;
      const b = await viewAt<{ by: string; amount: string; enlisted: boolean } | null>(chain, board.contract!, "bond_of", { id: job.id, mask }, height);
      if (!b || b.by !== house) continue;
      (b.enlisted ? seated : waiting).push({ job: job.id, mask, amount: BigInt(b.amount) });
    }
  }
  return { waiting, seated };
}

/** The house's balance and storage at the board's block, and whether `key` is a full key of its own. */
export async function readHouseFacts(chain: Chain, house: string, key: NearKey, height: number): Promise<{ free: bigint; fullAccess: boolean }> {
  const account = (await chain.rpc("query", { request_type: "view_account", block_id: height, account_id: house })) as { amount?: string; locked?: string; storage_usage?: number };
  const amount = BigInt(account.amount ?? "0");
  const stake = BigInt(account.storage_usage ?? 0) * 10n ** 19n;
  const access = (await chain.rpc("query", { request_type: "view_access_key", block_id: height, account_id: house, public_key: key.publicKeyText })) as {
    permission?: unknown;
  };
  return { free: amount > stake ? amount - stake : 0n, fullAccess: access.permission === "FullAccess" };
}

export interface SponsorOptions {
  readonly chain: Chain;
  readonly jobs: Jobs;
  readonly jobsContract: string;
  readonly crewsContract: string;
  readonly ours: Ours;
  readonly house: string;
  /** The house's key: a full key of the house's own account. */
  readonly key: NearKey;
  /** What the house keeps whatever it locks (`houseKeeps`). */
  readonly keeps: bigint;
  /** MASK CHECK on an account: asked before the house locks anything for a job of its. */
  readonly check: (account: string) => Promise<Verdict | null>;
  /** The end of the seals of the house's latest round, by the chain's clock, or `null`: whether its day is over. */
  readonly houseSealUntil: () => Promise<number | null>;
  readonly round: Pick<HouseRound, "live" | "first_minute" | "every_minutes">;
  readonly log?: (line: string) => void;
  /** The pause before a transaction whose nonce a node read too early is signed again (2 s; tests pass 0). */
  readonly nonceRetryMs?: number;
}

export interface SponsorDone {
  readonly act: SponsorAct;
  readonly ok: boolean;
  readonly hash: string | null;
  readonly error?: string;
}

export interface SponsorPass {
  readonly board: JobBoard;
  /** What the pass knew, at the board's block; `null` when the contract is not deployed. */
  readonly facts: Facts | null;
  readonly house: HouseFacts | null;
  readonly waiting: readonly Waiting[];
  /** The bonds of the house on our masks' seats: they come back when their job ends. */
  readonly seated: readonly Waiting[];
  readonly plan: SponsorPlan;
  readonly done: readonly SponsorDone[];
}

export function describeSponsor(act: SponsorAct): string {
  return act.kind === "bond"
    ? `the house locks the bonds of ${act.masks.join(", ")} on ${act.job}: ${near(act.deposit)} NEAR`
    : `the house takes back its bonds of ${act.masks.join(", ")} on ${act.job}: ${near(act.back)} NEAR`;
}

/** One pass: read, decide, act. Each act is one transaction; one that fails stops no other. */
export async function sponsor(o: SponsorOptions): Promise<SponsorPass> {
  const log = o.log ?? (() => {});
  const newest = await o.jobs.board();
  if (!newest.deployed) {
    log(`${newest.contract ?? "no jobs contract"}: not deployed, no job to sponsor`);
    return { board: newest, facts: null, house: null, waiting: [], seated: [], plan: { acts: [], skips: [], spare: 0n, out: 0n }, done: [] };
  }
  if (newest.stale) throw new Error("the board could not be read fresh: the house locks nothing on an old reading");
  // With the drains newer jobs pushed off the board: a bond of the house is found whatever anyone opened since.
  const board = await wholeBoard(o.jobs, newest);
  const height = board.block!.height;
  const facts0 = await readFacts(o.chain, board, o.ours, o.crewsContract);
  // MASK CHECK before anything is locked: every client of a job from outside that still takes masks.
  const clients = new Map<string, Verdict | null>();
  for (const j of board.jobs.filter((j) => j.phase === "enlisting" && fromOutside(j, o.ours))) {
    if (clients.has(j.client)) continue;
    const v = await o.check(j.client).catch(() => null);
    clients.set(j.client, v);
  }
  const facts: Facts = { ...facts0, clients };
  const h = await readHouseFacts(o.chain, o.house, o.key, height);
  const busy = houseDayBusy(o.round, board.readAt, await o.houseSealUntil());
  const { waiting, seated } = await readHouseBonds(o.chain, board, o.ours, o.house);
  const house: HouseFacts = { account: o.house, free: h.free, fullAccess: h.fullAccess, keeps: o.keeps, busy };
  const p = sponsorPlan(board, facts, o.ours, house, waiting, seated);
  const done: SponsorDone[] = [];
  for (const act of p.acts) {
    const actions =
      act.kind === "bond"
        ? act.masks.map((n) => functionCall("bond", { id: act.job, mask: o.ours.masks[n] }, BOND_GAS, act.each))
        : act.masks.map((n) => functionCall("unbond", { id: act.job, mask: o.ours.masks[n] ?? n }, BOND_GAS));
    let r: CallResult = { hash: "", ok: false, error: "no call" };
    for (let tries = 0; ; tries++) {
      try {
        r = await send(o.chain, o.house, o.key, o.jobsContract, actions);
        break;
      } catch (e) {
        if (!/InvalidNonce/.test((e as Error).message) || tries >= NONCE_RETRIES) {
          r = { hash: "", ok: false, error: (e as Error).message };
          break;
        }
        await new Promise((ok) => setTimeout(ok, o.nonceRetryMs ?? 2_000));
      }
    }
    const error = r.ok ? undefined : (r.error ?? "").replace(/\s+/g, " ").slice(0, 300);
    done.push({ act, ok: r.ok, hash: r.hash || null, ...(error ? { error } : {}) });
    log(`${r.ok ? "ok" : "failed"} ${describeSponsor(act)}${r.hash ? ` ${r.hash}` : ""}${error ? `: ${error}` : ""}`);
  }
  return { board, facts, house, waiting, seated, plan: p, done };
}
