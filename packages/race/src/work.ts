/**
 * The arena's masks at work on the jobs market (contracts/jobs, contracts/crews, docs/spec/jobs.md). One pass reads
 * the board through the arena's own reader (`@maskwars/arena/jobs`), decides what each of our masks does on each job
 * now, and does it with the mask's own function-call keys, both from the seed it races with (`MASK_KEYS`, src/keys.ts):
 * its key on the jobs contract (`enlist`, `step`, `reveal`, `leave`, `judge`, `settle`, `close`) and its key on the
 * crews contract (`join`, `leave`, `enlist`). Neither key attaches NEAR, so no pass ever moves a mask's money: the bond
 * a mask takes a job with is locked for it beforehand by whoever answers for it (`jobs.bond`, the owner's
 * scripts/testnet/jobs-bond.ps1), and a mask with no bond waiting for it does not enlist.
 *
 * A pass is idempotent and reads everything from the chain: run it on a schedule and every job our masks are on moves
 * one window further each time its clock allows.
 * - enlisting: a mask takes a job it may win (alone, or with its crew when `crew` names one) and seals its one step at
 *   once: sha256 of `maskwars-step:<job>:<mask>:<salt>:<content>`, the salt from its seed, the content a line that
 *   names the mask, its role and the round. A pass that died after `enlist` seals in the next one.
 * - revealing: it reveals that step; the salt and the content are rebuilt, and a step whose seal they do not give
 *   (sealed by hand) is left alone and said so.
 * - waiting: once the round of a drain is over, a mask on the job asks the judge (`judge`: the jobs contract reads the
 *   round's outcome from the bounty contract); with no striker's work revealed, or once the time to judge is over, it
 *   closes the job, so every bond goes back.
 * - decided: once the verdict is final (a drain's always is) or its appeal window is over, `settle` pays.
 *
 * The masks take only work they can win and that is ours to race: today a `drain` on a sealed round of one of our
 * bounty contracts, opened by one of our teams, whose safe lets the mask in. A `tee_tests` or `ai_review` job needs
 * work sealed for its judge's TEE key, which the masks' minds do not write yet: it is left with that reason.
 *
 * Every decision runs by the chain's clock, the time of the block the board was read at, never by the runner's.
 */
import { createHash, createHmac } from "node:crypto";
import { near } from "@maskwars/arena";
import { LIVE, OVER, stepHash, type Job, type JobBoard, type Jobs, type Role } from "@maskwars/arena/jobs";
import { raceKey } from "./keys.ts";
import { call, type CallResult, type Chain, type NearKey } from "./near-tx.ts";

/** The methods of a mask's key on the jobs contract: its own moves, and the calls anyone may make to move a job on. */
export const JOB_KEY_METHODS = ["enlist", "step", "reveal", "leave", "judge", "settle", "close", "unstick"] as const;
/** The methods of a mask's key on the crews contract: its yes to a crew, and the captain's enlisting. */
export const CREW_KEY_METHODS = ["join", "leave", "enlist"] as const;

/** Gas each call carries, TGas: at least what the contract asks (`MIN_JUDGE_GAS` 180, `MIN_SETTLE_GAS` 200). */
export const GAS = { enlist: 50, step: 30, reveal: 30, judge: 250, settle: 300, close: 300, unstick: 30, join: 30, enlistCrew: 150 } as const;

/** A mask seals no step this close to the end of the work window: the transaction must land inside it. */
export const STEP_MARGIN_MS = 2 * 60_000;
/** A round is raced only with this long left to seal in: the race itself takes a few minutes, often a quarter hour. */
export const RACE_MIN_MS = 20 * 60_000;
/** Most live jobs a mask may be on at once: `MAX_LIVE_JOBS_PER_MASK`. */
export const MAX_LIVE = 4;
/** The shortest reveal window a mask takes a job with: two quarter hours of the schedule, so a run that is late still
 * finds it open. A run that raced the job's round follows it the whole time. */
export const MIN_REVEAL_MS = 30 * 60_000;
/** OutLayer answers or fails within 200 blocks; the jobs contract lets anyone drop a judge run after this many. */
export const JUDGE_TIMEOUT_BLOCKS = 600;
/** A change proposed on the crews contract lapses a day after it is ready (`CHANGE_LAPSE_HOURS`). */
export const CREWS_LAPSE_MS = 24 * 3_600_000;

export const SALT_LABEL = "maskwars-job-salt:";
export const TAG_LABEL = "maskwars-job-tag:";

/** The salt of a mask's step on a job: from its seed, so a later pass rebuilds it, and nobody else can. */
export function jobSalt(seedHex: string, jobsContract: string, job: string): string {
  if (!/^[0-9a-f]{64}$/.test(seedHex)) throw new Error("a mask's seed is 32 bytes in lowercase hex");
  return createHmac("sha256", Buffer.from(seedHex, "hex")).update(`${SALT_LABEL}${jobsContract}:${job}`, "utf8").digest("hex");
}

/**
 * A tag only the mask's seed gives, for its step on a job. The contract counts the same content once, for the step
 * sealed first: a line anyone could write would let anyone seal it first and make the mask's own reveal a copy, which
 * wins nothing. With the tag in it, nobody else can seal the mask's content before the mask reveals it.
 */
export function jobTag(seedHex: string, jobsContract: string, job: string): string {
  if (!/^[0-9a-f]{64}$/.test(seedHex)) throw new Error("a mask's seed is 32 bytes in lowercase hex");
  return createHmac("sha256", Buffer.from(seedHex, "hex")).update(`${TAG_LABEL}${jobsContract}:${job}`, "utf8").digest("hex").slice(0, 32);
}

const ROLE_WORD: Readonly<Record<Role, string>> = { striker: "strikes", scout: "scouts", verifier: "verifies" };

/**
 * What a mask reveals on a drain: a line that names it, its role and the round, and its tag (`jobTag`). The plan
 * itself is sealed on the round and shows there once the round reveals it; the job wins by the round's outcome, not by
 * this text.
 */
export function drainContent(name: string, role: Role, round: { bounty: string; id: string }, tag: string): string {
  if (!/^[0-9a-f]{32}$/.test(tag)) throw new Error("a step's tag is 16 bytes in lowercase hex");
  return `${name} ${ROLE_WORD[role]} round ${round.id} on ${round.bounty}. The plan is sealed on the round and shows there once the round reveals it. Tag ${tag}.`;
}

/** A sealed round a drain job follows, as the bounty contract shows it at the board's block. */
export interface RoundFacts {
  readonly bounty: string;
  readonly id: string;
  /** Who opened it: one of our teams, or anyone else. */
  readonly owner: string | null;
  /** `open`, `drained`, `paid`, `refunded`; `null` when the contract has no such round. */
  readonly state: string | null;
  readonly winner: string | null;
  /** The masks the round lets in (`get_safe`); `null` when it is no live race. */
  readonly masks: readonly string[] | null;
  /** The end of the commit window, ms by the chain's clock; `null` when there is no sealed round. */
  readonly commitUntil: number | null;
  /** Seals in the round so far, and the masks that made them. */
  readonly seals: number;
  readonly sealedBy: readonly string[];
}

/** A crew as the crews contract holds it now. */
export interface CrewFacts {
  readonly id: string;
  readonly captain: string;
  readonly seats: readonly { readonly mask: string; readonly role: Role; readonly joined: boolean }[];
  readonly version: number;
}

/** What one pass knows beyond the board, all at the board's block. */
export interface Facts {
  /** `<job>/<mask>` → the bond waiting for the mask to enlist, yoctoNEAR; absent when none waits. */
  readonly bonds: ReadonlyMap<string, bigint>;
  /** `<bounty>/<round>` → the round. */
  readonly rounds: ReadonlyMap<string, RoundFacts>;
  readonly crew: CrewFacts | null;
  /** The crews contract `crew` is on: a job takes crews only from the one it opened with. */
  readonly crewsContract: string;
  /** Jobs of ours whose judge run is out past `JUDGE_TIMEOUT_BLOCKS`: anyone may drop it (`unstick`). */
  readonly stuck: ReadonlySet<string>;
  /** New code waits on the crews contract: no crew enlists until it applies (or lapses). */
  readonly crewsChanging?: boolean;
  /** Jobs whose crew enlist the chain refused earlier in this run: its masks go alone. */
  readonly crewRefused?: ReadonlySet<string>;
}

export interface Ours {
  /** Our masks: name → account. */
  readonly masks: Readonly<Record<string, string>>;
  /** Names of the masks whose seed is in MASK_KEYS: only they can sign. */
  readonly signers: readonly string[];
  /** Bounty contracts whose rounds our masks play, and the teams whose rounds those are. */
  readonly bounties: readonly string[];
  readonly teams: readonly string[];
  /** The rounds a pass may start a race on: only on this bounty contract (the one `Live race` plays) and opened by
   * these teams (the owner's hand rounds: the season races its own). */
  readonly raceBounty: string;
  readonly raceTeams: readonly string[];
  /** The crew our masks take jobs with, when one is named (`JOBS_CREW`). */
  readonly crew: string | null;
  /** The round this run raced (on `raceBounty`): while it is open, the run asks again every little while. */
  readonly follow?: string | null;
}

export type Act =
  | { readonly kind: "join"; readonly mask: string; readonly crew: string; readonly version: number }
  | { readonly kind: "enlist"; readonly mask: string; readonly job: string }
  | { readonly kind: "enlist_crew"; readonly mask: string; readonly crew: string; readonly job: string; readonly members: readonly string[] }
  | { readonly kind: "step"; readonly mask: string; readonly job: string; readonly role: Role; readonly round: RoundRef }
  | { readonly kind: "reveal"; readonly mask: string; readonly job: string; readonly seq: number; readonly role: Role; readonly round: RoundRef }
  | { readonly kind: "judge" | "settle" | "close" | "unstick"; readonly mask: string; readonly job: string };

/** The round a drain job follows: the bounty contract and the round's id. */
export interface RoundRef {
  readonly bounty: string;
  readonly id: string;
}

export interface Skip {
  readonly job: string;
  readonly mask?: string;
  readonly why: string;
}

export interface Plan {
  readonly acts: readonly Act[];
  readonly skips: readonly Skip[];
  /** A round to race now: a hand round of ours on a job our masks are on, nobody sealed in yet. */
  readonly race: { readonly job: string; readonly bounty: string; readonly round: string } | null;
  /** The next moment a job our masks are on can move, ms by the chain's clock; `null` when nothing waits. */
  readonly next: number | null;
  /** A job our masks are on waits for its round's outcome, or the round this run raced is still open: neither has a
   * deadline to wait for, so a run that raced asks again every little while (`RunOptions.pollMs`). */
  readonly waits: boolean;
}

const roundKey = (r: { bounty: string; id: string }) => `${r.bounty}/${r.id}`;
const bondKey = (job: string, mask: string) => `${job}/${mask}`;

/** Our mask's name for an account, or null. */
function nameOf(ours: Ours, account: string): string | null {
  for (const [name, a] of Object.entries(ours.masks)) if (a === account) return name;
  return null;
}

/** The masks seated on a job (not those that left), by account. */
function seated(job: Job): Map<string, { role: Role; entrant: number }> {
  const out = new Map<string, { role: Role; entrant: number }>();
  for (const e of job.entrants) for (const m of e.members) if (!m.left) out.set(m.mask.account, { role: m.role, entrant: e.index });
  return out;
}

/** Every mask that ever took a seat on the job: one that left does not come back. */
function everSeated(job: Job): Set<string> {
  return new Set(job.entrants.flatMap((e) => e.members.map((m) => m.mask.account)));
}

/** Why a mask may not take this drain job now, or null when it may. */
function drainBar(job: Job, round: RoundFacts | undefined, ours: Ours, account: string, now: number): string | null {
  if (job.judge.by !== "round") return "no round named";
  if (!ours.bounties.includes(job.judge.bounty)) return `the round is on ${job.judge.bounty}, not a bounty contract of ours`;
  if (!round || round.state === null) return `round ${job.judge.round} is not on ${job.judge.bounty}`;
  if (!round.owner || !ours.teams.includes(round.owner)) return `round ${round.id} was opened by ${round.owner ?? "nobody"}, not by one of our teams`;
  if (round.state !== "open") return `round ${round.id} is ${round.state}`;
  if (!round.masks) return `round ${round.id} is no live race`;
  if (!round.masks.includes(account)) return `round ${round.id} does not let ${account} in`;
  if (round.commitUntil !== null && round.commitUntil <= now && !round.sealedBy.includes(account)) {
    return `round ${round.id} takes no more seals and this mask sealed none: it cannot win the job`;
  }
  return null;
}

/** Why this job does not take the mask by its own terms, or null. */
function termsBar(job: Job, account: string, now: number, live: ReadonlyMap<string, number>): string | null {
  if (job.client === account) return "the client is not one of its own job's masks";
  if (everSeated(job).has(account)) return "on the job already, or left it";
  if (job.openTo.who === "masks" && !job.openTo.masks.includes(account)) return "the job takes only its listed masks";
  if (job.openTo.who === "registered" && !job.openTo.factories.some((f) => account.endsWith(`.${f}`) && !account.slice(0, -f.length - 1).includes("."))) {
    return "the job takes only masks forged by a known factory";
  }
  if ((live.get(account) ?? 0) >= MAX_LIVE) return `on ${MAX_LIVE} live jobs already`;
  if (now >= job.workUntil - STEP_MARGIN_MS) return "the work window closes too soon to seal a step";
  if (job.revealUntil - job.workUntil < MIN_REVEAL_MS) {
    return `its reveal window is ${Math.round((job.revealUntil - job.workUntil) / 60_000)} min, shorter than the ${MIN_REVEAL_MS / 60_000} a scheduled run is sure to find open`;
  }
  return null;
}

/**
 * What our masks do now, from one reading of the board and the facts at its block. Pure: the same reading gives the
 * same plan, so a pass can be replayed and checked.
 */
export function plan(board: JobBoard, facts: Facts, ours: Ours): Plan {
  const now = board.readAt;
  const acts: Act[] = [];
  const skips: Skip[] = [];
  const nexts: number[] = [];
  let race: Plan["race"] = null;
  let waits = false;
  const accounts = new Set(Object.values(ours.masks));
  const signs = (name: string) => ours.signers.includes(name);
  // A seat joins a crew's version once per pass, whatever number of jobs the crew takes in it.
  const joined = new Set<string>();

  // How many live jobs each of our masks holds a seat on now: a mask is on four at most.
  const live = new Map<string, number>();
  for (const j of board.jobs) {
    if (!LIVE.has(j.phase)) continue;
    for (const a of seated(j).keys()) if (accounts.has(a)) live.set(a, (live.get(a) ?? 0) + 1);
  }

  for (const job of board.jobs) {
    if (OVER.has(job.phase)) continue;
    const seats = seated(job);
    const mine = [...seats.keys()].filter((a) => accounts.has(a));
    const ref: RoundRef | null = job.judge.by === "round" ? { bounty: job.judge.bounty, id: job.judge.round } : null;
    const round = ref ? facts.rounds.get(roundKey(ref)) : undefined;
    // Who moves the job on: a mask of ours on it that can sign, the round's winner first (it was paid for the round),
    // else one picked by the job's id, so the gas of judging and settling is spread over the masks.
    const mover = (() => {
      const winner = round?.winner ? nameOf(ours, round.winner) : null;
      if (winner && mine.includes(ours.masks[winner]!) && signs(winner)) return winner;
      const able = mine.map((a) => nameOf(ours, a)!).filter(signs).sort();
      if (able.length === 0) return null;
      return able[createHash("sha256").update(job.id).digest()[0]! % able.length]!;
    })();

    // ---- enlisting: take the job, then seal the one step ------------------------------------------------------
    if (job.phase === "enlisting") {
      if (job.kind !== "drain") {
        skips.push({ job: job.id, why: `${job.kind}: the work is sealed for the judge's TEE key, and the masks' minds do not write it yet` });
      } else {
        // Who may take it: a mask with no bar but its bond waits only for the owner's one transaction (jobs-bond.ps1
        // locks every mask's bond at once), so its crew waits for it; any other bar is the mask's for this job.
        const takers: { name: string; account: string }[] = [];
        const bondless = new Set<string>();
        const barred = new Set<string>();
        for (const [name, account] of Object.entries(ours.masks)) {
          const why = termsBar(job, account, now, live) ?? drainBar(job, round, ours, account, now) ?? (signs(name) ? null : "no seed in MASK_KEYS");
          if (why) {
            barred.add(account);
            // A bond locked for a mask that will not take the job waits for whoever locked it to take it back.
            const waiting = facts.bonds.has(bondKey(job.id, account)) ? ` Its bond waits: jobs-bond.ps1 -Job ${job.id} -Unbond` : "";
            if (!seats.has(account)) skips.push({ job: job.id, mask: name, why: `${why}${waiting ? `.${waiting}` : ""}` });
            continue;
          }
          const bond = facts.bonds.get(bondKey(job.id, account));
          if (bond === undefined || bond < BigInt(job.bond)) {
            bondless.add(account);
            skips.push({
              job: job.id,
              mask: name,
              why: bond === undefined ? `no bond waits for it: the owner locks it (jobs-bond.ps1 -Job ${job.id})` : "the bond waiting for it is less than this job's",
            });
            continue;
          }
          takers.push({ name, account });
        }
        let free = job.slots - job.masks;
        const crew = ours.crew ? facts.crew : null;
        if (ours.crew && !crew) skips.push({ job: job.id, why: `crew ${ours.crew} is not on the crews contract` });
        // The crew takes the job when it can, and waits when only a bond is missing; when it cannot take this job at
        // all (a seat already on it, a round that does not let a seat in, too few slots), its masks go alone.
        let crewHolds = false;
        if (crew) {
          const strangers = crew.seats.filter((s) => !accounts.has(s.mask)).map((s) => s.mask);
          const captain = nameOf(ours, crew.captain);
          const named = (list: readonly string[]) => list.map((a) => nameOf(ours, a) ?? a).join(", ");
          const out = crew.seats.filter((s) => barred.has(s.mask)).map((s) => s.mask);
          const waiting = crew.seats.filter((s) => bondless.has(s.mask)).map((s) => s.mask);
          if (facts.crewsChanging) skips.push({ job: job.id, why: `new code waits on ${facts.crewsContract}: no crew enlists until it applies; the masks go alone` });
          else if (facts.crewRefused?.has(job.id)) skips.push({ job: job.id, why: `the chain refused crew ${crew.id} on this job: its masks go alone` });
          else if (strangers.length) skips.push({ job: job.id, why: `crew ${crew.id} seats ${strangers.join(", ")}: not ours to sign for` });
          else if (!captain || !signs(captain)) skips.push({ job: job.id, why: `crew ${crew.id}: its captain ${crew.captain} cannot sign here` });
          else if (job.crews !== facts.crewsContract) skips.push({ job: job.id, why: `the job takes crews from ${job.crews}, not ${facts.crewsContract}` });
          else if (out.length) {
            // Said only when a seat may still go alone: with every seat barred, each mask's own reason says it all.
            if (out.length < crew.seats.length) skips.push({ job: job.id, why: `crew ${crew.id} cannot take it: ${named(out)} cannot; the others go alone` });
          }
          else if (crew.seats.length > free) skips.push({ job: job.id, why: `crew ${crew.id} needs ${crew.seats.length} slots, the job has ${free}; its masks go alone` });
          else if (waiting.length) {
            crewHolds = true;
            skips.push({ job: job.id, why: `crew ${crew.id} waits for the bond of ${named(waiting)}` });
          } else {
            crewHolds = true;
            for (const s of crew.seats.filter((s) => !s.joined && !joined.has(s.mask))) {
              acts.push({ kind: "join", mask: nameOf(ours, s.mask)!, crew: crew.id, version: crew.version });
              joined.add(s.mask);
            }
            acts.push({ kind: "enlist_crew", mask: captain, crew: crew.id, job: job.id, members: crew.seats.map((s) => nameOf(ours, s.mask)!) });
            for (const s of crew.seats) {
              acts.push({ kind: "step", mask: nameOf(ours, s.mask)!, job: job.id, role: s.role, round: ref! });
              live.set(s.mask, (live.get(s.mask) ?? 0) + 1);
            }
            free -= crew.seats.length;
          }
        }
        // Every other mask goes alone, as its own striker.
        const inCrew = new Set(crewHolds && crew ? crew.seats.map((s) => s.mask) : []);
        for (const t of takers.filter((t) => !inCrew.has(t.account))) {
          if (free < 1) {
            skips.push({ job: job.id, mask: t.name, why: "no slot left" });
            continue;
          }
          acts.push({ kind: "enlist", mask: t.name, job: job.id });
          acts.push({ kind: "step", mask: t.name, job: job.id, role: "striker", round: ref! });
          live.set(t.account, (live.get(t.account) ?? 0) + 1);
          free -= 1;
        }
      }
      // A mask of ours already on the job with no step yet (a pass died after enlist) seals it now.
      for (const account of mine) {
        const name = nameOf(ours, account)!;
        if (job.steps.some((s) => s.mask.account === account)) continue;
        if (!signs(name)) continue;
        if (now >= job.workUntil - STEP_MARGIN_MS) {
          skips.push({ job: job.id, mask: name, why: "on the job with no step, and the work window closes too soon" });
          continue;
        }
        if (ref) acts.push({ kind: "step", mask: name, job: job.id, role: seats.get(account)!.role, round: ref });
      }
      // A hand round of ours that nobody sealed in yet: the masks race it now, so the winner seals inside its window.
      const taking = acts.some((a) => (a.kind === "enlist" || a.kind === "enlist_crew") && a.job === job.id);
      // Only a round of our masks alone: a round with people's masks on its list is raced by hand
      // (scripts/testnet/human-round.ps1), and its keeper arms them for that run.
      const ownMasks = round?.masks?.every((m) => accounts.has(m)) ?? false;
      if (!race && round && ownMasks && (mine.length > 0 || taking) && round.bounty === ours.raceBounty && round.owner && ours.raceTeams.includes(round.owner)) {
        if (round.state === "open" && round.seals === 0 && round.commitUntil !== null && round.commitUntil - now >= RACE_MIN_MS) {
          race = { job: job.id, bounty: round.bounty, round: round.id };
        }
      }
      if (mine.length > 0 || taking) nexts.push(job.workUntil);
      continue;
    }

    if (mine.length === 0) continue;

    // ---- revealing: every step of ours, rebuilt from the seed --------------------------------------------------
    if (job.phase === "revealing") {
      for (const s of job.steps.filter((s) => accounts.has(s.mask.account) && !s.revealed)) {
        const name = nameOf(ours, s.mask.account)!;
        if (!signs(name) || !ref) {
          skips.push({ job: job.id, mask: name, why: !ref ? "only a drain's step is ours to reveal" : "no seed in MASK_KEYS" });
          continue;
        }
        acts.push({ kind: "reveal", mask: name, job: job.id, seq: s.seq, role: s.role, round: ref });
      }
      nexts.push(job.revealUntil);
      continue;
    }

    if (!mover) {
      skips.push({ job: job.id, why: "none of our masks on it can sign" });
      continue;
    }

    // ---- judging: a run that never answered is dropped, and the job waits for its judge again ----------------------
    if (job.phase === "judging") {
      if (facts.stuck.has(job.id)) acts.push({ kind: "unstick", mask: mover, job: job.id });
      continue;
    }

    // ---- waiting: the judge once the round is over, or close ---------------------------------------------------
    if (job.phase === "waiting") {
      const strike = job.steps.some((s) => s.role === "striker" && s.revealed && s.copyOf === null);
      if (!strike) acts.push({ kind: "close", mask: mover, job: job.id });
      else if (now >= job.judgeUntil) acts.push({ kind: "close", mask: mover, job: job.id });
      else if (job.judge.by === "round" && !["drained", "paid", "refunded"].includes(job.judge.state ?? "")) {
        skips.push({ job: job.id, why: `round ${job.judge.round} is still ${job.judge.state ?? "unknown"}: the judge waits for its outcome` });
        nexts.push(job.judgeUntil);
        waits = true;
      } else if (job.judge.by === "round") acts.push({ kind: "judge", mask: mover, job: job.id });
      else skips.push({ job: job.id, why: "its judge runs on OutLayer: anyone with a judge run's fee asks it" });
      continue;
    }

    // ---- decided: pay once the verdict may no longer be appealed -----------------------------------------------
    if (job.phase === "decided" && job.verdict) {
      if (job.verdict.final || (job.verdict.appealUntil !== null && now >= job.verdict.appealUntil)) acts.push({ kind: "settle", mask: mover, job: job.id });
      else if (job.verdict.appealUntil !== null) nexts.push(job.verdict.appealUntil);
      continue;
    }
    // judging, appealing, checking: a run is out, or the client's material waits; nothing of ours to do.
  }

  // The round this run raced, while it still runs: the run follows it to its end.
  if (ours.follow && facts.rounds.get(roundKey({ bounty: ours.raceBounty, id: ours.follow }))?.state === "open") waits = true;
  const next = nexts.filter((t) => t > now).sort((a, b) => a - b)[0] ?? null;
  return { acts, skips: grouped(skips, Object.keys(ours.masks).length), race, next, waits };
}

/** One line for a reason every one of our masks has on a job, instead of one line per mask. */
function grouped(skips: readonly Skip[], masks: number): Skip[] {
  const count = new Map<string, number>();
  for (const s of skips) if (s.mask) count.set(`${s.job}\n${s.why}`, (count.get(`${s.job}\n${s.why}`) ?? 0) + 1);
  const out: Skip[] = [];
  const said = new Set<string>();
  for (const s of skips) {
    const k = `${s.job}\n${s.why}`;
    if (s.mask && masks > 1 && count.get(k) === masks) {
      if (!said.has(k)) out.push({ job: s.job, why: s.why });
      said.add(k);
    } else out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Reading the facts
// ---------------------------------------------------------------------------------------------------------------

/** A view at one block: the board's. `null` for a view the contract does not have or that panicked. */
export async function viewAt<T>(chain: Chain, contract: string, method: string, args: object, height: number): Promise<T> {
  const r = (await chain.rpc("query", {
    request_type: "call_function",
    block_id: height,
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  })) as { result?: number[]; error?: string };
  if (!r.result) throw new Error(`${contract}.${method}: ${r.error ?? "no result"}`);
  return JSON.parse(Buffer.from(r.result).toString("utf8")) as T;
}

interface RawBounty {
  readonly owner: string;
  readonly status: { readonly state?: string; readonly winner?: string };
}

const nsToMs = (ns: string | number) => Number(BigInt(ns) / 1_000_000n);

/** The facts a plan needs, all at the board's block. */
export async function readFacts(
  chain: Chain,
  board: JobBoard,
  ours: Ours,
  crewsContract: string,
): Promise<Facts> {
  const height = board.block?.height;
  if (height === undefined || height === null) throw new Error("the board was read at no block");
  const accounts = Object.values(ours.masks);
  const bonds = new Map<string, bigint>();
  const rounds = new Map<string, RoundFacts>();
  const stuck = new Set<string>();
  for (const job of board.jobs) {
    if (OVER.has(job.phase)) continue;
    if (job.judge.by === "round" && !rounds.has(roundKey({ bounty: job.judge.bounty, id: job.judge.round }))) {
      const r = { bounty: job.judge.bounty, id: job.judge.round };
      rounds.set(roundKey(r), ours.bounties.includes(r.bounty) ? await readRound(chain, r, height) : { ...r, owner: null, state: null, winner: null, masks: null, commitUntil: null, seals: 0, sealedBy: [] });
    }
    // A judge run of a job of ours that never answered: its status names the block it went out at.
    if (job.phase === "judging" && job.entrants.some((e) => e.members.some((m) => accounts.includes(m.mask.account)))) {
      const raw = await viewAt<{ status?: { state?: string; height?: string } } | null>(chain, board.contract!, "get", { id: job.id }, height);
      const out = Number(raw?.status?.height ?? NaN);
      if (raw?.status?.state === "judging" && Number.isFinite(out) && height >= out + JUDGE_TIMEOUT_BLOCKS) stuck.add(job.id);
    }
    if (job.phase !== "enlisting" || job.kind !== "drain") continue;
    const onIt = everSeated(job);
    for (const account of accounts) {
      if (onIt.has(account) || job.client === account) continue;
      const b = await viewAt<{ amount: string; enlisted: boolean } | null>(chain, board.contract!, "bond_of", { id: job.id, mask: account }, height);
      if (b && !b.enlisted) bonds.set(bondKey(job.id, account), BigInt(b.amount));
    }
  }
  let crew: CrewFacts | null = null;
  let crewsChanging = false;
  if (ours.crew) {
    // A code change waiting on the crews contract stops every crew's enlist until it applies or lapses (a day past
    // its ready time): the crews contract's own `pending_code`.
    const pending = await viewAt<{ change?: { kind?: string }; ready_ns?: string } | null>(chain, crewsContract, "pending", {}, height).catch(() => null);
    crewsChanging = pending?.change?.kind === "code" && board.readAt < nsToMs(pending.ready_ns ?? "0") + CREWS_LAPSE_MS;
    const c = await viewAt<{ id: string; captain: string; seats: { mask: string; role: Role; joined: boolean }[]; version: number } | null>(
      chain,
      crewsContract,
      "get_crew",
      { id: ours.crew },
      height,
    ).catch(() => null);
    crew = c ? { id: c.id, captain: c.captain, seats: c.seats, version: c.version } : null;
  }
  return { bonds, rounds, crew, crewsContract, stuck, crewsChanging };
}

async function readRound(chain: Chain, r: { bounty: string; id: string }, height: number): Promise<RoundFacts> {
  const bounty = await viewAt<RawBounty | null>(chain, r.bounty, "get", { id: r.id }, height);
  if (!bounty) return { ...r, owner: null, state: null, winner: null, masks: null, commitUntil: null, seals: 0, sealedBy: [] };
  const safe = await viewAt<{ masks: string[] } | null>(chain, r.bounty, "get_safe", { id: r.id }, height);
  const sealed = safe ? await viewAt<{ commit_until: string; seals: { mask: string }[] } | null>(chain, r.bounty, "get_round", { id: r.id }, height) : null;
  return {
    ...r,
    owner: bounty.owner,
    state: bounty.status.state ?? null,
    winner: bounty.status.winner ?? null,
    masks: safe ? safe.masks : null,
    commitUntil: sealed ? nsToMs(sealed.commit_until) : null,
    seals: sealed ? sealed.seals.length : 0,
    sealedBy: sealed ? [...new Set(sealed.seals.map((x) => x.mask))] : [],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Doing it
// ---------------------------------------------------------------------------------------------------------------

export interface WorkOptions {
  readonly chain: Chain;
  readonly jobs: Jobs;
  readonly jobsContract: string;
  readonly crewsContract: string;
  readonly ours: Ours;
  /** Name → seed (MASK_KEYS): every key of the mask comes from it. */
  readonly seeds: Readonly<Record<string, string>>;
  readonly log?: (line: string) => void;
  /**
   * The acts the chain refused earlier in this run, shared by its passes: one is not sent again in the same run, since a
   * refused call still spends its key's allowance. A crew the chain refused on a job lets its masks go alone. A call
   * the network lost is not in it: it goes again.
   */
  readonly refused?: Set<string>;
}

export interface Done {
  readonly act: Act;
  readonly ok: boolean;
  /** A transaction went out (or was tried): a failure here is the chain's or the network's, worth a red run. */
  readonly sent: boolean;
  readonly hash: string | null;
  readonly error?: string;
  /** What the contract answered, when it is worth a line: a step's number, a judge call that decided nothing. */
  readonly note?: string;
}

export interface Pass {
  readonly board: JobBoard;
  readonly plan: Plan;
  readonly done: readonly Done[];
}

const short = (e: string | undefined) => (e ?? "").replace(/\s+/g, " ").slice(0, 300);

/** One pass: read, decide, act. A failed act stops the acts that need it (a step after a failed enlist) and no other. */
export async function work(o: WorkOptions): Promise<Pass> {
  const log = o.log ?? (() => {});
  const board = await o.jobs.board();
  if (!board.deployed) {
    log(`${board.contract ?? "no jobs contract"}: not deployed, no job to take`);
    return { board, plan: { acts: [], skips: [], race: null, next: null, waits: false }, done: [] };
  }
  if (board.stale) throw new Error("the board could not be read fresh: no mask acts on an old reading");
  const read = await readFacts(o.chain, board, o.ours, o.crewsContract);
  const refused = o.refused ?? new Set<string>();
  const crewRefused = new Set([...refused].filter((k) => k.startsWith("enlist_crew/")).map((k) => k.split("/")[1]!));
  const facts: Facts = { ...read, crewRefused };
  const p = plan(board, facts, o.ours);
  /** A mask's step on a drain job: its salt and its content, both rebuilt from its seed on every pass. */
  const stepOf = (act: { mask: string; job: string; role: Role; round: RoundRef }) => {
    const seed = o.seeds[act.mask]!;
    return { salt: jobSalt(seed, o.jobsContract, act.job), content: drainContent(act.mask, act.role, act.round, jobTag(seed, o.jobsContract, act.job)) };
  };
  const keys = new Map<string, NearKey>();
  const keyOf = (name: string, receiver: string) => {
    const k = `${name}/${receiver}`;
    if (!keys.has(k)) keys.set(k, raceKey(o.seeds[name]!, receiver));
    return keys.get(k)!;
  };
  // What failed, so the acts that need it do not go: a step after its enlist, a crew's enlist after a seat's join.
  const failed = new Set<string>();
  const needs = (act: Act): string[] => {
    switch (act.kind) {
      case "step":
        return [`${act.job}/${act.mask}`];
      case "enlist_crew":
        return [`crew/${act.crew}`];
      default:
        return [];
    }
  };
  const done: Done[] = [];
  for (const act of p.acts) {
    const account = o.ours.masks[act.mask]!;
    if (refused.has(actKey(act))) {
      done.push({ act, ok: false, sent: false, hash: null, error: "refused by the chain earlier in this run: not sent again" });
      log(`not again ${describe(act)}: the chain refused it earlier in this run`);
      if (act.kind === "enlist") failed.add(`${act.job}/${act.mask}`);
      continue;
    }
    if (needs(act).some((n) => failed.has(n))) {
      done.push({ act, ok: false, sent: false, hash: null, error: "skipped: what it needs failed" });
      log(`skipped ${describe(act)}: what it needs failed`);
      // What it would have made possible does not go either: a crew's steps after its enlist was skipped.
      if (act.kind === "enlist_crew") for (const m of act.members) failed.add(`${act.job}/${m}`);
      continue;
    }
    let r: CallResult = { hash: "", ok: false, error: "no call" };
    const onJobs = (method: string, args: object, gas: number) => call(o.chain, account, keyOf(act.mask, o.jobsContract), o.jobsContract, method, args, gas);
    try {
      switch (act.kind) {
        case "join":
          r = await call(o.chain, account, keyOf(act.mask, o.crewsContract), o.crewsContract, "join", { id: act.crew, version: act.version }, GAS.join);
          break;
        case "enlist_crew":
          r = await call(o.chain, account, keyOf(act.mask, o.crewsContract), o.crewsContract, "enlist", { id: act.crew, jobs: o.jobsContract, job: act.job }, GAS.enlistCrew);
          // The crews contract's callback says whether the job took the crew: `null` when it did not.
          if (r.ok && (r.value === null || r.value === undefined)) r = { ...r, ok: false, error: r.error ?? "the job did not take the crew" };
          break;
        case "enlist":
          r = await onJobs("enlist", { id: act.job }, GAS.enlist);
          break;
        case "step": {
          const { salt, content } = stepOf(act);
          r = await onJobs("step", { id: act.job, hash: stepHash(act.job, account, salt, content) }, GAS.step);
          break;
        }
        case "reveal": {
          const { salt, content } = stepOf(act);
          const job = board.jobs.find((j) => j.id === act.job)!;
          const sealed = job.steps.find((s) => s.seq === act.seq)!;
          if (stepHash(act.job, account, salt, content) !== sealed.hash) {
            done.push({ act, ok: false, sent: false, hash: null, error: "the seal on chain is not what this mask's seed gives: sealed by hand, left as it is" });
            log(`left ${describe(act)}: the seal on chain is not what its seed gives (sealed by hand)`);
            continue;
          }
          r = await onJobs("reveal", { id: act.job, seq: act.seq, salt, content }, GAS.reveal);
          break;
        }
        case "judge":
          r = await onJobs("judge", { id: act.job }, GAS.judge);
          break;
        case "settle":
          r = await onJobs("settle", { id: act.job }, GAS.settle);
          break;
        case "close":
          r = await onJobs("close", { id: act.job }, GAS.close);
          break;
        case "unstick":
          r = await onJobs("unstick", { id: act.job }, GAS.unstick);
          break;
      }
    } catch (e) {
      r = { hash: "", ok: false, error: (e as Error).message };
    }
    const note = noteOf(act, r, (a) => nameOf(o.ours, a) ?? a);
    done.push({ act, ok: r.ok, sent: true, hash: r.hash || null, ...(r.ok ? {} : { error: short(r.error) }), ...(note ? { note } : {}) });
    log(`${r.ok ? "ok" : "failed"} ${describe(act)}${note ? ` (${note})` : ""}${r.hash ? ` ${r.hash}` : ""}${r.ok ? "" : `: ${short(r.error)}`}`);
    // The chain refused it (a transaction with a hash that failed): not again in this run.
    if (!r.ok && r.hash) refused.add(actKey(act));
    if (!r.ok) {
      if (act.kind === "join") failed.add(`crew/${act.crew}`);
      else if (act.kind === "enlist_crew") for (const m of act.members) failed.add(`${act.job}/${m}`);
      else failed.add(`${act.job}/${act.mask}`);
    }
  }
  return { board, plan: p, done };
}

/** What an act is, for the run's memory of what the chain refused: its kind, its job (or crew) and its mask. */
export function actKey(act: Act): string {
  return act.kind === "join" ? `join/${act.crew}/${act.mask}` : `${act.kind}/${act.job}/${act.mask}`;
}

/** The contract's own `settle` event in a call's logs: who was paid what. */
export function settleEvent(logs: readonly string[] | undefined): { payouts: { mask: string; amount: string }[]; fee: string; back: string } | null {
  for (const line of logs ?? []) {
    if (!line.startsWith("EVENT_JSON:")) continue;
    try {
      const e = JSON.parse(line.slice("EVENT_JSON:".length)) as { standard?: string; event?: string; data?: { payouts?: { mask: string; amount: string }[]; fee?: string; back?: string } };
      if (e.standard === "maskwars_jobs" && e.event === "settle" && e.data) return { payouts: e.data.payouts ?? [], fee: e.data.fee ?? "0", back: e.data.back ?? "0" };
    } catch {
      // not an event
    }
  }
  return null;
}

function noteOf(act: Act, r: CallResult, name: (account: string) => string): string | undefined {
  if (act.kind === "settle" && r.ok) {
    const e = settleEvent(r.logs);
    if (e) {
      const paid = e.payouts.map((p) => `${name(p.mask)} ${near(p.amount)}`).join(", ");
      return `${paid ? `paid ${paid} NEAR` : "nobody paid"} · fee ${near(e.fee)} · back to the client ${near(e.back)}`;
    }
  }
  const v = r.value as { seq?: number; phase?: string; status?: { state?: string } } | number | null | undefined;
  if (act.kind === "step" && v && typeof v === "object" && typeof v.seq === "number") return `step #${v.seq}`;
  if (act.kind === "enlist" && typeof v === "number") return `entrant #${v}`;
  if (act.kind === "enlist_crew" && typeof v === "number") return `entrant #${v}`;
  if ((act.kind === "judge" || act.kind === "settle" || act.kind === "close") && v && typeof v === "object" && typeof v.phase === "string") return v.phase;
  return undefined;
}

export function describe(act: Act): string {
  switch (act.kind) {
    case "join":
      return `${act.mask} joins crew ${act.crew} v${act.version}`;
    case "enlist":
      return `${act.mask} takes ${act.job} alone`;
    case "enlist_crew":
      return `${act.mask} enlists crew ${act.crew} (${act.members.join(", ")}) in ${act.job}`;
    case "step":
      return `${act.mask} seals its ${act.role} step on ${act.job}`;
    case "reveal":
      return `${act.mask} reveals step #${act.seq} on ${act.job}`;
    case "judge":
      return `${act.mask} asks the judge on ${act.job}`;
    case "settle":
      return `${act.mask} settles ${act.job}`;
    case "close":
      return `${act.mask} closes ${act.job}`;
    case "unstick":
      return `${act.mask} drops the judge run of ${act.job} that never answered`;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// One run: pass after pass while the jobs move
// ---------------------------------------------------------------------------------------------------------------

/** Passes one run makes at most, whatever moves: enough to follow a raced round for the race's whole time. */
export const MAX_PASSES = 100;
/** A pass that could not read the chain is tried again after this long, doubling each time up to 5 minutes, while the
 * run has time and at most this many times in a row. */
export const RETRY_MS = 60_000;
export const MAX_FAILED_PASSES = 10;

export interface RunOptions {
  /** One pass with a fresh reading of the board. */
  readonly pass: () => Promise<Pass>;
  /** How long the run may wait for the next window, minutes: 0 makes one pass. */
  readonly waitMinutes: number;
  /** In a run that raced a round: while a job our masks are on waits for its round's outcome, pass again this often. */
  readonly pollMs?: number;
  /** Called after every pass, before the run decides what is next. */
  readonly onPass?: (pass: Pass, n: number) => void | Promise<void>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (line: string) => void;
}

/**
 * Passes until nothing more can move within the run's time. A pass that moved a job on (the judge answered, a crew
 * took its seats) is followed by another at once, since what it made possible, a settle after a verdict, needs no later
 * run. One that moved nothing waits for the next deadline of a job our masks are on, when it comes within the time left
 * (a reveal window that opens), a little past it so the block that crosses it is final; with `pollMs`, a job waiting for
 * its round's outcome is asked about again that often, so the judge is called as soon as the round is drained. A pass
 * that cannot read the chain is tried again a minute later, then two, four, up to five minutes apart, while the run has
 * time; one pass with no time to wait fails at once. Returns the passes made.
 */
export async function keepWorking(o: RunOptions): Promise<Pass[]> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = o.log ?? (() => {});
  const started = now();
  const out: Pass[] = [];
  let failures = 0;
  for (let n = 1; n <= MAX_PASSES; n++) {
    let pass: Pass;
    try {
      pass = await o.pass();
      failures = 0;
    } catch (e) {
      failures += 1;
      const left = o.waitMinutes * 60_000 - (now() - started);
      const pause = Math.min(RETRY_MS * 2 ** (failures - 1), 5 * RETRY_MS);
      if (o.waitMinutes <= 0 || failures >= MAX_FAILED_PASSES || left <= pause) throw e;
      log(`the chain did not answer (${(e as Error).message}): trying again in ${pause / 60_000} min`);
      await sleep(pause);
      continue;
    }
    out.push(pass);
    await o.onPass?.(pass, n);
    const left = o.waitMinutes * 60_000 - (now() - started);
    if (o.waitMinutes <= 0 || left <= 0) break;
    if (pass.done.some((d) => d.ok)) continue;
    const next = pass.plan.next;
    const due = next === null ? null : Math.max(next - pass.board.readAt, 0) + 20_000;
    const poll = o.pollMs && pass.plan.waits ? o.pollMs : null;
    const ms = [due, poll].filter((x): x is number => x !== null && x <= left).sort((a, b) => a - b)[0];
    if (ms === undefined) {
      if (next !== null) log(`next: ${new Date(next).toISOString().slice(0, 16).replace("T", " ")} UTC, for a later run`);
      break;
    }
    log(ms === poll ? `the round is not over: asking again in ${Math.ceil(ms / 60_000)} min` : `waiting ${Math.ceil(ms / 60_000)} min for the next window`);
    await sleep(ms);
  }
  return out;
}
