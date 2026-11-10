// Every job read from the chain with no keys. The state of each job comes from the jobs contract's views over JSON-RPC
// (`config`, `list`, `entrants`, `steps`, `fuel`), all at one final block; its history comes from the contract's
// transactions in the public indexer: every `open`, `enlist`, `step`, `reveal`, `burn`, `verdict`, `settle` event the
// contract logged. Once a job is paid, closed or cancelled the contract clears its masks, steps and seats: then its
// events are the record, and the reader rebuilds the job from them.

import type { MaskProfile } from "../config.ts";
import { Indexer, type Tx } from "../indexer.ts";
import { type At, ChainError, ChainReader, NO_CODE } from "@maskwars/check";
import { ARENA_MASKS, type JobsConfig, jobsConfigOf } from "./config.ts";
import { shares } from "./split.ts";
import {
  type Bar,
  type BondLine,
  type Crew,
  type Delivery,
  type Entrant,
  type EventKind,
  type Job,
  type JobBoard,
  type JobEvent,
  type JudgeRef,
  type Kind,
  type Lost,
  type Market,
  type Mask,
  type Member,
  OVER,
  type OpenTo,
  type Payout,
  type Phase,
  type Role,
  type Settlement,
  type Split,
  type Step,
  type Verdict,
} from "./types.ts";

// ---- What the contract answers ----------------------------------------------------------------------------------

interface RawTerms {
  kind: Kind;
  brief: string;
  spec: string;
  rubric: string | null;
  judge: { kind: Kind; project: string; version: string; key: string } | null;
  round: { bounty: string; id: string } | null;
  secrets: { profile: string; account_id: string } | null;
  bar: { win_at: number; cases: number | null; fuel: string | null; reference: string | null } | null;
  reward: string;
  fee_bps: number;
  fee_to: string;
  fuel_per_mask: string;
  slots: number;
  bond: string;
  client_key: string | null;
  open_to: { who: "anyone" } | { who: "registered"; factories?: string[] } | { who: "masks"; masks: string[] };
  meter: string;
  treasury: string;
  outlayer: string;
  crews: string;
  opened_ns: string;
  work_until: string;
  reveal_until: string;
  judge_until: string;
  appeal_minutes: number;
}

interface RawVerdict {
  winner: number | null;
  counted: number[];
  fake?: number[];
  at_ns: string;
  final: boolean;
  shared?: boolean;
  undecided?: boolean;
}

interface RawJob {
  id: string;
  client: string;
  terms: RawTerms;
  status: { state: string; winner?: number };
  masks: number;
  entrants: number;
  steps: number;
  runs: number;
  verdict: RawVerdict | null;
  prior: RawVerdict | null;
  appeal: { by: string; bond: string } | null;
  checked: boolean;
  left: number;
  retry_at: string;
  phase: Phase;
}

interface RawMember {
  mask: string;
  role: Role;
}

interface RawEntrant {
  crew: string | null;
  version: number;
  members: RawMember[];
  split: Split;
}

interface RawStep {
  seq: number;
  entrant: number;
  mask: string;
  role: Role;
  hash: string;
  at_ns: string;
  content: string | null;
  digest: string | null;
  copy_of: number | null;
}

interface RawFuel {
  mask: string;
  entrant: number;
  role: Role;
  burned: string;
  steps: number;
  covered: string | null;
}

interface RawConfig {
  meter: string;
  treasury: string;
  outlayer: string;
  crews: string;
  judges: { kind: Kind; project: string; version: string; key: string }[];
  bounties: string[];
  factories: string[];
  fee_bps: number;
  fee_to: string;
  jobs: number;
  live: number;
  pending: unknown;
  judge_fee: string;
  appeal_bond: string;
  max_slots: number;
  max_steps: number;
}

interface RawCrew {
  id: string;
  captain: string;
  seats: { mask: string; role: Role; joined: boolean }[];
  split: Split;
  version: number;
  ready: boolean;
  formed_ns: string;
  jobs: number;
}

interface RawSettle {
  status: { state: string; winner?: number };
  payouts: { mask: string; amount: string }[];
  fee: string;
  fuel: { mask: string; burned: string; covered: string }[];
  bonds?: { mask: string; bond: string; lost: string; why: "fake" | "idle" | null }[];
  forfeit?: string;
  back: string;
}

/** One event the jobs contract logged, with the transaction it happened in. */
interface Logged {
  event: string;
  data: Record<string, unknown>;
  at: number;
  tx: string;
  signer: string;
}

/** What one job's transactions say, beyond its events. */
interface History {
  events: Logged[];
  /** Judge calls and appeals: who asked, and what the contract said when nothing was decided. */
  asks: { at: number; tx: string; signer: string; method: string; note: string | null }[];
  /** The crews' tickets as the crews contract handed them over: version and split. */
  tickets: Map<number, { version: number; split: Split }>;
}

// ---- Helpers ------------------------------------------------------------------------------------------------------

const ms = (ns: string | null | undefined): number => (ns && /^\d+$/.test(ns) ? Number(BigInt(ns) / 1_000_000n) : 0);
const big = (v: unknown): bigint => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : 0n);
const sum = (xs: readonly bigint[]) => xs.reduce((a, b) => a + b, 0n);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const SOLO: Split = { scout: 0, striker: 10_000, verifier: 0 };
/** The judge checks the client's material within this long of the opening (`CHECK_HOURS`). */
const CHECK_MS = 6 * 3_600_000;
/** Half of a bond, as the contract takes it from a seat with no counted step (`IDLE_BPS`). */
const idlePart = (bond: bigint) => (bond * 5_000n) / 10_000n;
const NOTHING = /^job (\S+): (.+); (?:nothing is decided|ask again)$/;
/** Calls that ask the judge something: their transaction says who asked, and the contract's note when nothing came of it. */
const ASKS = new Set(["judge", "appeal", "check", "deliver"]);
const LIST_PAGE = 50;
const STEPS_PAGE = 64;
/** Jobs one reading of the board holds at most: the newest the contract opened. `JobBoard.total` counts them all. */
export const BOARD_JOBS = 60;
/** Transactions of the contract one reading keeps at most, the newest: a job older than them shows without its course. */
export const BOARD_TXS = 1_200;
/** How old the block of a reading may be, by the reader's own clock, and still be shown as happening now, ms. */
export const FRESH_MS = 90_000;

/**
 * The board is a reading of the chain as it is now: the last reading did not fail, and its block is at most
 * `FRESH_MS` behind `now` (the reader's clock: `Jobs.clock()`). Anything marked LIVE asks this first.
 */
export function isFresh(board: Pick<JobBoard, "stale" | "readAt">, now: number): boolean {
  return !board.stale && now - board.readAt <= FRESH_MS;
}
/** Requests one reading holds open at once. */
const PARALLEL = 6;

async function pool<T, R>(items: readonly T[], width: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await run(items[i]!);
    }
  });
  await Promise.all(lanes);
  return out;
}

/**
 * A job that will not change again, so one reading of it is kept: it is over and its history was read. A paid private
 * job still changes once after its payout, when the judge delivers the winning work to the client: until then it is
 * read again like a live one.
 */
function settled(job: Job): boolean {
  return OVER.has(job.phase) && job.history && !(job.private && job.phase === "paid" && job.delivery === null);
}

export class JobsReadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JobsReadError";
  }
}

export interface JobsOptions {
  config?: JobsConfig;
  rpc?: ChainReader;
  indexer?: Indexer;
  /** The arena's own masks: they keep their names and faces on a job. */
  masks?: readonly MaskProfile[];
  /** The wall clock, for the cache only: a job's phase and windows run by the chain's clock. */
  now?: () => number;
  /** How long one reading of the board is reused, ms. Jobs that are over are read once. */
  ttlMs?: number;
}

interface Cached<T> {
  at: number;
  value: Promise<T>;
}

export class Jobs {
  readonly config: JobsConfig;
  readonly #rpc: ChainReader;
  readonly #indexer: Indexer;
  readonly #masks: readonly MaskProfile[];
  readonly #now: () => number;
  readonly #ttl: number;
  readonly #txs = new Map<string, Tx>();
  #list: Cached<string[]> | null = null;
  readonly #over = new Map<string, Job>();
  #board: Cached<JobBoard> | null = null;
  readonly #crews = new Map<string, Cached<Crew | null>>();
  #lastGood: JobBoard | null = null;

  constructor(options: JobsOptions = {}) {
    this.config = options.config ?? jobsConfigOf();
    this.#rpc = options.rpc ?? new ChainReader({ endpoints: this.config.rpc });
    this.#indexer = options.indexer ?? new Indexer({ base: this.config.indexer });
    this.#masks = options.masks ?? ARENA_MASKS;
    this.#now = options.now ?? Date.now;
    this.#ttl = options.ttlMs ?? 5_000;
  }

  /** The reader's wall clock: what a deadline on chain is counted down against, and a reading's age is measured by. */
  clock(): number {
    return this.#now();
  }

  /**
   * The newest `BOARD_JOBS` jobs. One reading at a time, reused for `ttlMs`; when a fresh reading fails, the last good
   * one is served marked `stale`, with the time of its block in `readAt`: it is never shown as happening now.
   */
  async board(): Promise<JobBoard> {
    const now = this.#now();
    if (this.#board && now - this.#board.at < this.#ttl) return this.#board.value;
    const value = this.#read().then(
      (b) => {
        this.#lastGood = b;
        return b;
      },
      (error: unknown) => {
        this.#board = null;
        if (this.#lastGood) return { ...this.#lastGood, stale: true };
        throw error instanceof JobsReadError ? error : new JobsReadError(`the jobs could not be read: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      },
    );
    this.#board = { at: now, value };
    return value;
  }

  async job(id: string): Promise<Job | null> {
    return (await this.board()).jobs.find((j) => j.id === id) ?? null;
  }

  /**
   * A crew as the crews contract holds it at the latest final block: its captain, every seat and whether it joined, its
   * split and version. `null` when no such crew is there, or no crews contract is. `contract` is the crews contract a
   * job opened with (`Job.crews`); the default is this network's. One reading per crew is reused for `ttlMs`.
   */
  async crew(id: string, contract: string | null = this.config.crews): Promise<Crew | null> {
    if (!contract) return null;
    const key = `${contract}/${id}`;
    const now = this.#now();
    const kept = this.#crews.get(key);
    if (kept && now - kept.at < this.#ttl) return kept.value;
    const value = (async (): Promise<Crew | null> => {
      try {
        const c = await this.#rpc.view<RawCrew | null>(contract, "get_crew", { id });
        if (!c) return null;
        return { id: c.id, contract, captain: c.captain, seats: c.seats.map((s) => ({ mask: s.mask, role: s.role, joined: s.joined })), split: c.split, version: c.version, ready: c.ready, formedAt: ms(c.formed_ns), jobs: c.jobs };
      } catch (error) {
        this.#crews.delete(key);
        // No crews contract on chain yet, or an account with other code: there is no such crew.
        if (error instanceof ChainError && (error.kind === "contract" || error.kind === "unknown_account")) return null;
        throw new JobsReadError(`the crew could not be read: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    })();
    this.#crews.set(key, { at: now, value });
    if (this.#crews.size > 256) this.#crews.delete(this.#crews.keys().next().value!);
    return value;
  }

  // ---------------------------------------------------------------------------------------------------------------

  async #read(): Promise<JobBoard> {
    const { contract, network } = this.config;
    const empty = (deployed: boolean, block: JobBoard["block"]): JobBoard => ({
      network,
      contract,
      deployed,
      market: null,
      jobs: [],
      total: 0,
      waiting: "0",
      waitingFuel: "0",
      open: 0,
      biggest: null,
      paid: "0",
      fuelPaid: "0",
      block,
      readAt: block?.at ?? this.#now(),
      stale: false,
    });
    if (!contract) return empty(false, null);

    const head = await this.#rpc.head();
    const at: At = { block_id: head.height };
    const block = { height: head.height, at: Number(head.timestampNs / 1_000_000n) };
    const account = await this.#rpc.account(contract, at);
    if (!account || account.codeHash === NO_CODE) return empty(false, block);
    let config: RawConfig;
    try {
      config = await this.#rpc.view<RawConfig>(contract, "config", {}, at);
    } catch (error) {
      // An account with other code is not a jobs contract.
      if (error instanceof ChainError && error.kind === "contract") return empty(false, block);
      throw error;
    }

    const market: Market = {
      feeBps: config.fee_bps,
      feeTo: config.fee_to,
      meter: config.meter,
      treasury: config.treasury,
      outlayer: config.outlayer,
      crews: config.crews,
      judges: (config.judges ?? []).map((j) => ({ kind: j.kind, project: j.project, version: j.version, key: j.key })),
      bounties: config.bounties ?? [],
      factories: config.factories ?? [],
      judgeFee: config.judge_fee,
      appealBond: config.appeal_bond,
      maxSlots: config.max_slots,
      maxSteps: config.max_steps,
      jobs: config.jobs,
      live: config.live,
      changing: config.pending !== null && config.pending !== undefined,
    };

    // The newest jobs only: the contract lists them in the order they opened, so the window ends at the last one.
    const raw: RawJob[] = [];
    for (let from = Math.max(0, config.jobs - BOARD_JOBS); from < config.jobs; from += LIST_PAGE) {
      raw.push(...(await this.#rpc.view<RawJob[]>(contract, "list", { from_index: from, limit: LIST_PAGE }, at)));
    }
    const listed = new Set(raw.map((j) => j.id));
    for (const id of this.#over.keys()) if (!listed.has(id)) this.#over.delete(id);

    // The history: every transaction that called the contract. Without the indexer, live jobs still read from their
    // views and jobs that are over keep their verdict, with no timeline.
    let histories: Map<string, History> | null = null;
    try {
      histories = this.#histories(await this.#contractTxs(contract), contract, block.at);
    } catch {
      histories = null;
    }

    const factories = new Set(config.factories);
    for (const j of raw) if (j.terms.open_to.who === "registered") for (const f of j.terms.open_to.factories ?? []) factories.add(f);
    const name = (account: string) => this.#mask(account, factories);

    const jobs = await pool(raw, PARALLEL, async (j) => {
      const kept = this.#over.get(j.id);
      if (kept && OVER.has(j.phase) && kept.history) return kept;
      const job = await this.#job(contract, j, at, histories?.get(j.id) ?? null, histories !== null, name);
      if (settled(job)) this.#over.set(job.id, job);
      return job;
    });

    const rank = (j: Job) =>
      j.takes ? 0 : j.phase === "enlisting" || j.phase === "checking" ? 1 : j.phase === "revealing" ? 2 : j.phase === "waiting" || j.phase === "judging" ? 3 : j.phase === "decided" || j.phase === "appealing" ? 4 : 5;
    jobs.sort((a, b) => {
      const r = rank(a) - rank(b);
      if (r !== 0) return r;
      if (rank(a) === 0) {
        const d = BigInt(b.reward) - BigInt(a.reward);
        if (d !== 0n) return d > 0n ? 1 : -1;
      }
      return b.openedAt - a.openedAt || b.id.localeCompare(a.id);
    });
    const open = jobs.filter((j) => j.takes);
    const paid = jobs.flatMap((j) => (j.settlement && j.settlement.state !== "due" ? j.settlement.payouts.map((p) => BigInt(p.amount)) : []));
    const fuelPaid = jobs.map((j) => (j.settlement && j.settlement.state !== "due" ? BigInt(j.settlement.toNearAi) : 0n));
    return {
      network,
      contract,
      deployed: true,
      market,
      jobs,
      total: config.jobs,
      waiting: sum(open.map((j) => BigInt(j.reward))).toString(),
      waitingFuel: sum(open.map((j) => BigInt(j.fuelPool))).toString(),
      open: open.length,
      biggest: open[0] ?? null,
      paid: sum(paid).toString(),
      fuelPaid: sum(fuelPaid).toString(),
      block,
      readAt: block.at,
      stale: false,
    };
  }

  /**
   * The newest `BOARD_TXS` transactions that called the contract, oldest first. Transactions are final: each is
   * fetched once, and one that fell out of the window is forgotten.
   */
  async #contractTxs(contract: string): Promise<Tx[]> {
    const now = this.#now();
    if (!this.#list || now - this.#list.at >= this.#ttl) {
      const prev = this.#list;
      // The indexer answers newest first.
      const value = this.#indexer.accountTxs(contract).then((rows) => rows.filter((r) => r.call).slice(0, BOARD_TXS).map((r) => r.hash));
      this.#list = { at: now, value: value.catch((e: unknown) => (prev ? prev.value : Promise.reject(e))) };
    }
    const hashes = await this.#list.value;
    if (this.#txs.size > hashes.length) {
      const kept = new Set(hashes);
      for (const h of this.#txs.keys()) if (!kept.has(h)) this.#txs.delete(h);
    }
    const missing = hashes.filter((h) => !this.#txs.has(h));
    if (missing.length) for (const tx of await this.#indexer.transactions(missing)) this.#txs.set(tx.hash, tx);
    return hashes.flatMap((h) => (this.#txs.has(h) ? [this.#txs.get(h)!] : [])).sort((a, b) => a.at - b.at || a.height - b.height);
  }

  /** Each job's events and judge calls, out of the contract's own receipts: logs another contract wrote never count. */
  #histories(txs: readonly Tx[], contract: string, until: number): Map<string, History> {
    const out = new Map<string, History>();
    const of = (id: string) => {
      let h = out.get(id);
      if (!h) {
        h = { events: [], asks: [], tickets: new Map() };
        out.set(id, h);
      }
      return h;
    };
    for (const tx of txs) {
      if (tx.at > until) continue;
      const notes = new Map<string, string>();
      for (const r of tx.receipts) {
        if (r.to !== contract || !r.ok || r.at > until) continue;
        for (const log of r.logs) {
          const nothing = NOTHING.exec(log);
          if (nothing) notes.set(nothing[1]!, nothing[2]!);
          if (!log.startsWith("EVENT_JSON:")) continue;
          let e: unknown;
          try {
            e = JSON.parse(log.slice("EVENT_JSON:".length));
          } catch {
            continue;
          }
          if (!isObj(e) || e["standard"] !== "maskwars_jobs" || typeof e["event"] !== "string" || !isObj(e["data"])) continue;
          const data = e["data"];
          const id = typeof data["id"] === "string" ? data["id"] : null;
          if (!id) continue;
          of(id).events.push({ event: e["event"], data, at: r.at, tx: tx.hash, signer: tx.signer });
        }
        // A crew's ticket: the version and split every member agreed to, as the crews contract handed them over.
        for (const call of r.calls) {
          if (call.method !== "enlist_crew" || !isObj(call.args) || typeof call.args["id"] !== "string") continue;
          const ticket = call.args["ticket"];
          const entrant = r.value;
          if (!isObj(ticket) || typeof entrant !== "number") continue;
          const split = ticket["split"];
          if (!isObj(split)) continue;
          of(call.args["id"]).tickets.set(entrant, {
            version: typeof ticket["version"] === "number" ? ticket["version"] : 0,
            split: { scout: Number(split["scout"] ?? 0), striker: Number(split["striker"] ?? 0), verifier: Number(split["verifier"] ?? 0) },
          });
        }
      }
      if (tx.receiver !== contract) continue;
      for (const call of tx.calls) {
        if (!ASKS.has(call.method) || !isObj(call.args) || typeof call.args["id"] !== "string") continue;
        const id = call.args["id"];
        of(id).asks.push({ at: tx.at, tx: tx.hash, signer: tx.signer, method: call.method, note: tx.ok ? (notes.get(id) ?? null) : "refused" });
      }
    }
    return out;
  }

  #mask(account: string, factories: ReadonlySet<string>): Mask {
    const arena = this.#masks.find((m) => m.account === account);
    if (arena) return { account, name: arena.name, slug: arena.slug, forged: false };
    for (const f of factories) {
      const label = account.endsWith(`.${f}`) ? account.slice(0, -f.length - 1) : null;
      if (label && !label.includes(".")) return { account, name: label.toUpperCase(), slug: null, forged: true };
    }
    return { account, name: account, slug: null, forged: false };
  }

  async #job(contract: string, j: RawJob, at: At, history: History | null, read: boolean, mask: (a: string) => Mask): Promise<Job> {
    const t = j.terms;
    const over = OVER.has(j.phase);
    const events = history?.events ?? [];
    const pick = (name: string) => events.filter((e) => e.event === name);
    const boxed = t.kind !== "drain";

    // The judge: a drain reads its round on the bounty contract, the others run on OutLayer at the pinned wasm, with
    // the X25519 key the judge holds in its TEE: every mask seals its work for that key.
    let judge: JudgeRef;
    if (t.kind === "drain" && t.round) {
      const round = over ? null : await this.#rpc.view<{ status?: { state?: string; winner?: string } } | null>(t.round.bounty, "get", { id: t.round.id }, at).catch(() => null);
      judge = { by: "round", bounty: t.round.bounty, round: t.round.id, state: round?.status?.state ?? null, winner: round?.status?.winner ?? null };
    } else {
      judge = { by: "outlayer", project: t.judge?.project ?? "", version: t.judge?.version ?? "", key: t.judge?.key ?? "", outlayer: t.outlayer };
    }

    // Who is on the job and what they did: the views while it is live, its events once it is cleared.
    let rawEntrants: RawEntrant[];
    let rawSteps: RawStep[];
    let fuel: RawFuel[];
    if (!over) {
      const reads: [Promise<RawEntrant[]>, Promise<RawStep[]>, Promise<RawFuel[]>] = [
        this.#rpc.view<RawEntrant[]>(contract, "entrants", { id: j.id }, at),
        this.#steps(contract, j.id, j.steps, at),
        this.#rpc.view<RawFuel[]>(contract, "fuel", { id: j.id }, at),
      ];
      [rawEntrants, rawSteps, fuel] = await Promise.all(reads);
    } else {
      rawEntrants = pick("enlist")
        .map((e) => {
          const index = Number(e.data["entrant"]);
          const ticket = history?.tickets.get(index);
          const members = Array.isArray(e.data["members"]) ? (e.data["members"] as RawMember[]) : [];
          const crew = typeof e.data["crew"] === "string" ? e.data["crew"] : null;
          return { index, crew, version: ticket?.version ?? 0, members, split: ticket?.split ?? (crew ? { scout: 0, striker: 0, verifier: 0 } : SOLO) };
        })
        .sort((a, b) => a.index - b.index)
        .map(({ crew, version, members, split }) => ({ crew, version, members, split }));
      const bySeq = new Map<number, RawStep>();
      for (const e of [...pick("step"), ...pick("reveal")]) {
        const s = e.data["step"];
        if (isObj(s) && typeof s["seq"] === "number") bySeq.set(s["seq"], { ...(bySeq.get(s["seq"]) ?? {}), ...(s as unknown as RawStep) });
      }
      rawSteps = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
      fuel = [];
    }

    // The same reveal counts once, for the step sealed first: a later reveal can make an earlier-revealed step a copy.
    const first = new Map<string, number>();
    for (const s of rawSteps) if (s.digest && (first.get(s.digest) ?? Infinity) > s.seq) first.set(s.digest, s.seq);
    const copyOf = (s: RawStep) => (s.digest && first.get(s.digest)! < s.seq ? first.get(s.digest)! : null);

    const settleEvent = pick("settle").at(-1);
    const settled = settleEvent ? (settleEvent.data as unknown as RawSettle) : null;
    const verdict = this.#verdict(j.verdict, t.appeal_minutes);
    const counted = new Set(verdict?.counted ?? []);
    const fakeSteps = new Set(verdict?.fake ?? []);
    const countedMasks = new Set(rawSteps.filter((s) => counted.has(s.seq)).map((s) => s.mask));
    const fakeMasks = new Set(rawSteps.filter((s) => fakeSteps.has(s.seq)).map((s) => s.mask));
    const leaves = new Map(pick("leave").map((e) => [String(e.data["mask"]), e] as const));
    // Who locked each mask's bond: the last `bond` event for it on this job, before the mask took its seat.
    const backers = new Map<string, string>();
    for (const e of pick("bond")) backers.set(String(e.data["mask"]), String(e.data["by"]));
    const burnedEvents = new Map<string, string>();
    for (const e of pick("burn")) burnedEvents.set(String(e.data["mask"]), String(e.data["burned"] ?? "0"));
    const fuelOf = (account: string) => {
      const live = fuel.find((f) => f.mask === account);
      const line = settled?.fuel.find((f) => f.mask === account);
      return {
        burned: line?.burned ?? live?.burned ?? burnedEvents.get(account) ?? "0",
        covered: line ? line.covered : (live?.covered ?? null),
      };
    };
    const winner = verdict?.winner ?? (j.status.state === "paid" ? (j.status.winner ?? null) : null);

    // What a decided job will pay when settled, by the contract's own rule (`finish`): the reward to the winner, or in
    // equal parts to every counted strike under a shared verdict, each split by its crew's rule among its masks with a
    // counted step, less the fee; nothing when nobody won.
    let due: Map<string, bigint> | null = null;
    let dueFee = 0n;
    if (j.phase === "decided" && verdict) {
      const reward = BigInt(t.reward);
      let parts: [number, bigint][] = [];
      if (verdict.shared) {
        const strikers: number[] = [];
        for (const s of [...rawSteps].sort((a, b) => a.seq - b.seq)) if (counted.has(s.seq) && s.role === "striker" && !strikers.includes(s.entrant)) strikers.push(s.entrant);
        const n = BigInt(strikers.length);
        if (n > 0n) parts = strikers.map((e, i) => [e, i === 0 ? reward - (reward / n) * (n - 1n) : reward / n]);
      } else if (winner !== null) parts = [[winner, reward]];
      due = new Map();
      for (const [e, part] of parts) {
        const entrant = rawEntrants[e];
        if (!entrant) continue;
        const take = (part * BigInt(t.fee_bps)) / 10_000n;
        const split = shares(part - take, entrant.members, entrant.split, entrant.members.map((m) => countedMasks.has(m.mask)));
        if (sum(split.map(([, a]) => a)) === 0n) continue;
        dueFee += take;
        for (const [account, amount] of split) if (amount > 0n) due.set(account, (due.get(account) ?? 0n) + amount);
      }
    }
    const paidOf = (account: string): string | null => {
      if (settled) {
        const p = settled.payouts.find((x) => x.mask === account);
        return p ? p.amount : null;
      }
      const d = due?.get(account);
      return d ? d.toString() : null;
    };

    // Every mask's bond: the job's `bond`, locked by its owner or keeper. A mask that left settled its own; the settle
    // event says where every other went; a decided job shows what settling it will take.
    const bondOf = (account: string): BondLine => {
      const by = backers.get(account) ?? null;
      const leave = leaves.get(account);
      if (leave) {
        const lost = String(leave.data["lost"] ?? "0");
        const back = String(leave.data["back"] ?? "0");
        return { amount: (big(back) + big(lost)).toString(), by, lost, why: big(lost) > 0n ? "left" : null };
      }
      const line = settled?.bonds?.find((b) => b.mask === account);
      if (line) return { amount: line.bond, by, lost: line.lost, why: line.why };
      if (settled) return { amount: t.bond, by, lost: "0", why: null };
      if (j.phase === "decided" && verdict) {
        const bond = BigInt(t.bond);
        const why: Lost | null = fakeMasks.has(account) ? "fake" : countedMasks.has(account) ? null : "idle";
        const lost = why === "fake" ? bond : why === "idle" ? idlePart(bond) : 0n;
        return { amount: t.bond, by, lost: lost.toString(), why };
      }
      return { amount: t.bond, by, lost: null, why: null };
    };

    const stepsBy = new Map<string, number>();
    for (const s of rawSteps) stepsBy.set(s.mask, (stepsBy.get(s.mask) ?? 0) + 1);
    const entrants: Entrant[] = rawEntrants.map((e, index) => ({
      index,
      crew: e.crew,
      version: e.version,
      split: e.split,
      won: winner === index,
      members: e.members.map((m): Member => {
        const f = fuelOf(m.mask);
        return {
          mask: mask(m.mask),
          role: m.role,
          left: leaves.has(m.mask),
          bond: bondOf(m.mask),
          burned: f.burned,
          covered: f.covered,
          steps: fuel.find((x) => x.mask === m.mask)?.steps ?? stepsBy.get(m.mask) ?? 0,
          payout: paidOf(m.mask),
        };
      }),
    }));

    const sealTx = new Map(pick("step").map((e) => [Number((e.data["step"] as RawStep | undefined)?.seq), e] as const));
    const revealTx = new Map(pick("reveal").map((e) => [Number((e.data["step"] as RawStep | undefined)?.seq), e] as const));
    const steps: Step[] = rawSteps.map((s) => {
      const revealed = typeof s.content === "string";
      return {
        seq: s.seq,
        entrant: s.entrant,
        mask: mask(s.mask),
        role: s.role,
        hash: s.hash,
        sealedAt: ms(s.at_ns),
        sealTx: sealTx.get(s.seq)?.tx ?? null,
        revealedAt: revealTx.get(s.seq)?.at ?? null,
        revealTx: revealTx.get(s.seq)?.tx ?? null,
        revealed,
        boxed: boxed && revealed,
        // A box is ciphertext only the judge opens: no text of it is ever shown. A drain's plan is public on chain.
        content: !boxed && revealed ? s.content : null,
        digest: s.digest ?? null,
        copyOf: copyOf(s),
        counted: verdict ? counted.has(s.seq) : null,
        fake: verdict ? fakeSteps.has(s.seq) : null,
      };
    });

    const roleOf = (account: string): Role | null => rawEntrants.flatMap((e) => e.members).find((m) => m.mask === account)?.role ?? null;
    let settlement: Settlement | null = null;
    if (settled && settleEvent) {
      const state = settled.status.state === "paid" ? "paid" : settled.status.state === "shared" ? "shared" : settled.status.state === "cancelled" ? "cancelled" : "closed";
      settlement = {
        state,
        payouts: settled.payouts.map((p): Payout => ({ mask: mask(p.mask), role: roleOf(p.mask), amount: p.amount })),
        fee: settled.fee,
        toNearAi: sum(settled.fuel.map((f) => big(f.covered))).toString(),
        forfeit: settled.forfeit ?? sum((settled.bonds ?? []).map((b) => big(b.lost))).toString(),
        bondsBack: sum((settled.bonds ?? []).map((b) => big(b.bond) - big(b.lost))).toString(),
        back: settled.back,
        at: settleEvent.at,
        tx: settleEvent.tx,
      };
    } else if (j.phase === "decided") {
      const seated = entrants.flatMap((e) => e.members).filter((m) => !m.left);
      settlement = {
        state: "due",
        payouts: [...(due ?? new Map<string, bigint>())].map(([account, amount]): Payout => ({ mask: mask(account), role: roleOf(account), amount: amount.toString() })),
        fee: dueFee.toString(),
        toNearAi: sum(fuel.map((f) => big(f.covered))).toString(),
        forfeit: sum(seated.map((m) => big(m.bond.lost))).toString(),
        bondsBack: sum(seated.map((m) => big(m.bond.amount) - big(m.bond.lost))).toString(),
        back: null,
        at: null,
        tx: null,
      };
    }

    const delivered = pick("deliver").at(-1);
    const delivery: Delivery | null =
      delivered && judge.by === "outlayer"
        ? { at: String(delivered.data["at"] ?? ""), sha256: String(delivered.data["sha256"] ?? ""), key: String(delivered.data["key"] ?? t.client_key ?? ""), project: judge.project, when: delivered.at, tx: delivered.tx }
        : null;

    // Bonds waiting for their masks: locked, not taken back, and the mask not on the job yet.
    const seated = new Set(rawEntrants.flatMap((e) => e.members.map((m) => m.mask)));
    const waiting = new Map<string, { mask: string; by: string; amount: string }>();
    if (!over) {
      for (const e of [...pick("bond"), ...pick("unbond")].sort((a, b) => a.at - b.at)) {
        const m = String(e.data["mask"]);
        if (e.event === "bond") waiting.set(m, { mask: m, by: String(e.data["by"]), amount: String(e.data["amount"] ?? t.bond) });
        else waiting.delete(m);
      }
      for (const m of seated) waiting.delete(m);
    }

    const fuelPool = BigInt(t.fuel_per_mask) * BigInt(t.slots);
    const burned = settled ? sum(settled.fuel.map((f) => big(f.burned))) : fuel.length ? sum(fuel.map((f) => big(f.burned))) : sum([...burnedEvents.values()].map(big));
    const openTo: OpenTo = t.open_to.who === "registered" ? { who: "registered", factories: t.open_to.factories ?? [] } : t.open_to.who === "masks" ? { who: "masks", masks: t.open_to.masks } : { who: "anyone" };
    const openEvent = pick("open")[0];
    const bar: Bar | null = t.bar ? { winAt: t.bar.win_at, cases: t.bar.cases ?? null, fuel: t.bar.fuel ?? null } : null;
    const retryAt = ms(j.retry_at);

    return {
      id: j.id,
      network: this.config.network,
      contract,
      client: j.client,
      kind: t.kind,
      brief: t.brief,
      spec: t.spec,
      rubric: t.rubric,
      judge,
      secrets: t.secrets ? { profile: t.secrets.profile, account: t.secrets.account_id } : null,
      bar,
      clientKey: t.client_key ?? null,
      private: boxed,
      reward: t.reward,
      feeBps: t.fee_bps,
      feeTo: t.fee_to,
      fuelPerMask: t.fuel_per_mask,
      bond: t.bond,
      fuelPool: fuelPool.toString(),
      fuelBurned: burned.toString(),
      slots: t.slots,
      masks: j.masks,
      left: j.left ?? 0,
      openTo,
      meter: t.meter,
      treasury: t.treasury,
      crews: t.crews,
      openedAt: ms(t.opened_ns),
      checked: j.checked,
      checkUntil: ms(t.opened_ns) + CHECK_MS,
      workUntil: ms(t.work_until),
      revealUntil: ms(t.reveal_until),
      judgeUntil: ms(t.judge_until),
      appealMinutes: t.appeal_minutes,
      phase: j.phase,
      takes: j.phase === "enlisting" && j.masks < t.slots,
      runs: j.runs,
      retryAt: retryAt > 0 ? retryAt : null,
      entrants,
      steps,
      verdict,
      prior: this.#verdict(j.prior, t.appeal_minutes),
      appeal: j.appeal,
      settlement,
      delivery,
      bonds: [...waiting.values()],
      events: this.#timeline(j, history, mask),
      history: read && (!over || events.length > 0),
      txs: { open: openEvent?.tx ?? null, settle: settleEvent?.tx ?? null },
    };
  }

  async #steps(contract: string, id: string, count: number, at: At): Promise<RawStep[]> {
    const out: RawStep[] = [];
    for (let from = 0; from < count; from += STEPS_PAGE) {
      out.push(...(await this.#rpc.view<RawStep[]>(contract, "steps", { id, from_index: from, limit: STEPS_PAGE }, at)));
    }
    return out;
  }

  #verdict(v: RawVerdict | null, appealMinutes: number): Verdict | null {
    if (!v) return null;
    const at = ms(v.at_ns);
    return {
      winner: v.winner,
      counted: v.counted,
      fake: v.fake ?? [],
      at,
      final: v.final,
      shared: v.shared ?? false,
      undecided: v.undecided ?? false,
      appealUntil: v.final ? null : at + appealMinutes * 60_000,
    };
  }

  /** The job's course, step by step, from its events and judge calls. */
  #timeline(j: RawJob, history: History | null, mask: (a: string) => Mask): JobEvent[] {
    if (!history) return [];
    const out: JobEvent[] = [];
    const push = (kind: EventKind, e: { at: number; tx: string }, who: Mask | null, amount: string | null, extra: Partial<JobEvent> = {}) =>
      out.push({ kind, at: e.at, tx: e.tx, who, amount, ok: true, ...extra });
    for (const e of history.events) {
      const d = e.data;
      const step = isObj(d["step"]) ? (d["step"] as unknown as RawStep) : null;
      switch (e.event) {
        case "open":
          push("open", e, mask(j.client), j.terms.reward);
          break;
        case "check":
          push("check", e, null, null);
          break;
        case "refuse":
          push("refuse", e, null, null, { note: String(d["why"] ?? "") });
          break;
        case "bond":
          push("bond", e, mask(String(d["mask"])), String(d["amount"] ?? "0"));
          break;
        case "unbond":
          push("unbond", e, mask(String(d["mask"])), String(d["amount"] ?? "0"));
          break;
        case "enlist": {
          const members = Array.isArray(d["members"]) ? (d["members"] as RawMember[]) : [];
          const crew = typeof d["crew"] === "string" ? d["crew"] : null;
          const lead = members.find((m) => m.role === "striker") ?? members[0];
          push("enlist", e, lead ? mask(lead.mask) : null, null, { entrant: Number(d["entrant"]), crew });
          break;
        }
        case "leave":
          push("leave", e, mask(String(d["mask"])), String(d["back"] ?? "0"), { lost: String(d["lost"] ?? "0") });
          break;
        case "step":
          if (step) push("seal", e, mask(step.mask), null, { seq: step.seq, entrant: step.entrant });
          break;
        case "reveal":
          if (step) push("reveal", e, mask(step.mask), null, { seq: step.seq, entrant: step.entrant });
          break;
        case "burn":
          push("burn", e, mask(String(d["mask"])), String(d["amount"] ?? "0"));
          break;
        case "verdict": {
          const v = isObj(d["verdict"]) ? (d["verdict"] as unknown as RawVerdict) : null;
          push("verdict", e, null, null, { winner: v?.winner ?? null, ...(v?.shared ? { note: "shared" } : v?.undecided ? { note: "undecided" } : {}) });
          break;
        }
        case "appeal":
          push("appeal", e, mask(String(d["by"])), null);
          break;
        case "settle": {
          const s = d as unknown as RawSettle;
          const paid = sum((s.payouts ?? []).map((p) => big(p.amount)));
          const state = s.status?.state;
          // A close or a cancel logs its own event too; the settle line carries the money.
          push("settle", e, null, paid > 0n ? paid.toString() : null, { winner: state === "paid" ? (s.status.winner ?? null) : null, note: state ?? "" });
          break;
        }
        case "close":
          push("close", e, null, null);
          break;
        case "cancel":
          push("cancel", e, mask(j.client), null);
          break;
        case "deliver":
          push("deliver", e, null, null);
          break;
      }
    }
    for (const a of history.asks) {
      // An appeal logs its own event: the call adds nothing to it.
      if (a.method === "appeal" && history.events.some((x) => x.event === "appeal" && x.tx === a.tx)) continue;
      // A check the judge passed or refused logs its own event; one that decided nothing keeps the contract's note.
      if (a.method === "check" && history.events.some((x) => (x.event === "check" || x.event === "refuse") && x.tx === a.tx)) continue;
      // A delivery logs its own event when the judge answered.
      if (a.method === "deliver" && history.events.some((x) => x.event === "deliver" && x.tx === a.tx)) continue;
      const note = a.note && a.note !== "refused" ? { note: a.note } : {};
      const kind: EventKind = a.method === "appeal" ? "appeal" : a.method === "deliver" ? "deliver" : a.method === "check" ? "check" : "judge";
      out.push({ kind, at: a.at, tx: a.tx, who: mask(a.signer), amount: null, ok: a.note !== "refused", ...note });
    }
    return out.sort((a, b) => a.at - b.at || order(a.kind) - order(b.kind));
  }
}

/** Within one moment: a judge call before its verdict, a verdict before the payout, the payout before the delivery. */
function order(kind: EventKind): number {
  return ["open", "check", "refuse", "bond", "unbond", "enlist", "leave", "seal", "burn", "reveal", "judge", "appeal", "verdict", "settle", "close", "cancel", "deliver"].indexOf(kind);
}
