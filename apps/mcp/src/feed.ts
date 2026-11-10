// The arena as the tools read it: one reading of the chain at a time, the last good one served while the next one runs.
// The shared reader (@maskwars/arena) reuses a reading for a few seconds and falls back to its last good one only when
// a reading fails. On a slow chain every call after those seconds would start a new full reading and wait for it, and
// the readings would pile up. The feed keeps one reading in flight, answers from the last good one meanwhile, and when
// the chain is too slow serves that one with its time. Races past their deadline and the claim grace are read rarely,
// and one reading holds only a few requests open at once.
import { Arena, type ArenaView, Indexer } from "@maskwars/arena";
import { type At, ChainError, ChainReader } from "@maskwars/check";
import type { ArenaConfig } from "./config.ts";

/** How long a tool waits for a reading when the last good one is too old to serve at once. */
export const ARENA_TIMEOUT_MS = 20_000;
/** A reading this young answers every call as it is: no new reading starts. */
export const ARENA_FRESH_MS = 5_000;
/** A reading up to this old answers at once while the next one is read. An older one only when the chain is slow. */
export const ARENA_SERVE_MS = 60_000;
/** Requests one reading holds open at once, to the RPC and to the indexer each. */
export const ARENA_PARALLEL = 6;
/** The claim grace after the deadline (CLAIM_GRACE_HOURS on the bounty contract): no claim comes after it. */
export const CLAIM_GRACE_MS = 12 * 3_600_000;
/** A race that is over is read again this rarely, for a refund. */
export const ENDED_REFRESH_MS = 10 * 60_000;

/** A reading and whether it is old: the chain did not answer in time, so the tools serve the last good one. */
export interface Reading {
  readonly view: ArenaView;
  readonly stale: boolean;
}

/** The arena could not be read in time, or at all, and there is no good reading to serve. */
export class ArenaReadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ArenaReadError";
  }
}

export interface FeedOptions {
  /** The clock: when a reading came, how old it is. Default `Date.now`. */
  now?: () => number;
  freshMs?: number;
  serveMs?: number;
  /** How long a call waits for a reading by default. */
  timeoutMs?: number;
  /** Each new good reading, as it comes. */
  onView?: (view: ArenaView) => void;
  /**
   * Each reading as it starts. A host that may freeze the process once a response is sent (a serverless function)
   * keeps it running here: the reading behind an answer served at once must land.
   */
  keepAlive?: (reading: Promise<unknown>) => void;
}

/** One reading of the arena in flight at a time; the last good one answers while it runs. */
export class ArenaFeed {
  readonly #arena: Arena;
  readonly #now: () => number;
  readonly #fresh: number;
  readonly #serve: number;
  readonly #timeout: number;
  readonly #onView: ((view: ArenaView) => void) | undefined;
  readonly #keepAlive: ((reading: Promise<unknown>) => void) | undefined;
  #good: { view: ArenaView; at: number } | null = null;
  #reading: Promise<ArenaView> | null = null;
  #started = 0;

  constructor(arena: Arena, options: FeedOptions = {}) {
    this.#arena = arena;
    this.#now = options.now ?? Date.now;
    this.#fresh = options.freshMs ?? ARENA_FRESH_MS;
    this.#serve = options.serveMs ?? ARENA_SERVE_MS;
    this.#timeout = options.timeoutMs ?? ARENA_TIMEOUT_MS;
    this.#onView = options.onView;
    this.#keepAlive = options.keepAlive;
  }

  /** Readings started so far. */
  get readings(): number {
    return this.#started;
  }

  /** Once no reading is in flight. */
  async settled(): Promise<void> {
    while (this.#reading) await this.#reading.then(noop, noop);
  }

  /**
   * The arena now. A good reading under `freshMs` answers as it is. One under `serveMs` answers at once while the next
   * one is read. Older, or none: the call waits for the reading in flight up to `timeoutMs`, then gets the last good
   * reading marked stale, or an ArenaReadError when there is none yet. The reading goes on and serves the next call.
   */
  async read(timeoutMs = this.#timeout): Promise<Reading> {
    const good = this.#good;
    const age = good ? this.#now() - good.at : Number.POSITIVE_INFINITY;
    if (good && age < this.#fresh) return { view: good.view, stale: false };
    const next = this.#next();
    if (good && age < this.#serve) return { view: good.view, stale: false };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<{ slow: true }>((resolve) => {
      timer = setTimeout(() => resolve({ slow: true }), timeoutMs);
    });
    try {
      const got = await Promise.race([next.then((view) => ({ view }), (error: unknown) => ({ error })), slow]);
      const last = this.#good;
      if ("view" in got && last && last.view === got.view && this.#now() - last.at < this.#serve) return { view: got.view, stale: false };
      if (last) return { view: last.view, stale: true };
      if ("slow" in got) throw new ArenaReadError("the chain is slow to answer right now");
      const error = "error" in got ? got.error : null;
      throw new ArenaReadError(`the chain could not be read: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  /** The reading in flight, or a new one. The reader hands back its last good reading when a new one fails: no news. */
  #next(): Promise<ArenaView> {
    if (this.#reading) return this.#reading;
    this.#started += 1;
    const before = this.#good?.view ?? null;
    const reading = this.#arena.view().then((view) => {
      if (view !== before) {
        this.#good = { view, at: this.#now() };
        this.#onView?.(view);
      }
      return view;
    });
    this.#reading = reading;
    // Whoever was served the last good reading does not wait for this one; it must not fail unseen.
    const landed = reading.then(
      () => this.#done(reading),
      () => this.#done(reading),
    );
    try {
      this.#keepAlive?.(landed);
    } catch {
      // Outside a request the host has nothing to keep alive: the reading runs all the same.
    }
    return reading;
  }

  #done(reading: Promise<ArenaView>): void {
    if (this.#reading === reading) this.#reading = null;
  }
}

/** At most `max` calls at once; the rest wait their turn in order. */
export function limiter(max: number): <T>(run: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(run: () => Promise<T>): Promise<T> => {
    if (active < max) active += 1;
    // The slot passes straight from the call that ends to the next in line.
    else await new Promise<void>((resolve) => queue.push(resolve));
    try {
      return await run();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

const noop = () => {};

const RACE_VIEWS = new Set(["get", "get_safe", "get_round"]);

/**
 * Races that are over, from the last good reading: past the deadline and the claim grace, nobody drained the safe, no
 * claim waits for the judge. Only a refund can follow (a drain could still be settled and paid, so a race with one is
 * read every time). Their answers (the contract's views of the race, the safe's account, what it holds and its
 * transactions) are kept and read again only every `ENDED_REFRESH_MS`.
 *
 * A safe is kept only while no other race runs on it, and never one of the arena's own accounts: anyone may name any
 * account as a race's safe, the bounty contract itself included, and its transactions are where new races show up.
 */
export class EndedRaces {
  readonly #now: () => number;
  readonly #own: ReadonlySet<string>;
  #races = new Set<string>();
  #safes = new Set<string>();
  readonly #kept = new Map<string, { at: number; value: unknown } | { at: number; error: unknown }>();

  /** `own`: the accounts the arena reads as its own (its bounty contracts, its teams): never kept as a safe. */
  constructor(now: () => number = Date.now, own: readonly string[] = []) {
    this.#now = now;
    this.#own = new Set(own);
  }

  /** From a good reading: which races are over. */
  mark(view: ArenaView): void {
    const races = new Set<string>();
    const over = new Set<string>();
    const running = new Set<string>();
    for (const r of view.races) {
      const waiting = r.events.some((e) => e.kind === "claim" && e.verdict === "waiting");
      const ended = r.deadline > 0 && view.readAt >= r.deadline + CLAIM_GRACE_MS && r.state === "open" && r.phase === "held" && !waiting;
      if (ended) races.add(`${r.contract}/${r.id}`);
      if (r.kind === "safe") (ended ? over : running).add(r.target);
    }
    for (const safe of [...running, ...this.#own]) over.delete(safe);
    this.#races = races;
    this.#safes = over;
  }

  /** A race read now runs on this safe: it is read fresh from now on, until a reading says it is over again. */
  running(safe: string): void {
    this.#safes.delete(safe);
  }

  isRace(contract: string, id: string): boolean {
    return this.#races.has(`${contract}/${id}`);
  }

  isSafe(account: string): boolean {
    return this.#safes.has(account);
  }

  /**
   * The answer kept for `key` while `ended` and recent enough; else read and kept. A contract's own error is an answer
   * too (a contract from before sealed rounds has no `get_round`); a failed request is not, and is read again.
   */
  async through<T>(key: string, ended: boolean, read: () => Promise<T>): Promise<T> {
    const kept = this.#kept.get(key);
    if (ended && kept && this.#now() - kept.at < ENDED_REFRESH_MS) {
      if ("error" in kept) throw kept.error;
      return kept.value as T;
    }
    try {
      const value = await read();
      this.#kept.set(key, { at: this.#now(), value });
      return value;
    } catch (error) {
      if (error instanceof ChainError && error.kind === "contract") this.#kept.set(key, { at: this.#now(), error });
      throw error;
    }
  }
}

/** The arena's RPC: a few requests at once, the answers of races that are over kept. Only what the arena reads. */
class ArenaChain extends ChainReader {
  readonly #inner: ChainReader;
  readonly #ended: EndedRaces;
  readonly #slot: <T>(run: () => Promise<T>) => Promise<T>;

  constructor(inner: ChainReader, ended: EndedRaces, parallel: number) {
    super({ endpoints: inner.endpoints });
    this.#inner = inner;
    this.#ended = ended;
    this.#slot = limiter(parallel);
  }

  override view<T>(contractId: string, method: string, args: unknown, at?: At): Promise<T> {
    const read = () => this.#slot(() => this.#inner.view<T>(contractId, method, args, at));
    const id = (args as { id?: unknown } | null)?.id;
    if (at === undefined && RACE_VIEWS.has(method) && typeof id === "string") {
      const ended = this.#ended.isRace(contractId, id);
      const answer = this.#ended.through(`view ${contractId} ${method} ${id}`, ended, read);
      if (method !== "get_safe" || ended) return answer;
      // A race that runs names its safe before the arena reads the safe: a safe an old race left is read fresh.
      return answer.then((value) => {
        const safe = (value as { safe?: unknown } | null)?.safe;
        if (typeof safe === "string") this.#ended.running(safe);
        return value;
      });
    }
    if (at === undefined && method === "available") return this.#ended.through(`view ${contractId} available`, this.#ended.isSafe(contractId), read);
    return read();
  }

  override account(accountId: string, at?: At): ReturnType<ChainReader["account"]> {
    const read = () => this.#slot(() => this.#inner.account(accountId, at));
    if (at !== undefined) return read();
    return this.#ended.through(`account ${accountId}`, this.#ended.isSafe(accountId), read);
  }
}

/** The arena's indexer: a few requests at once, the transactions of a safe whose races are over kept. */
class ArenaIndexer extends Indexer {
  readonly #inner: Indexer;
  readonly #ended: EndedRaces;
  readonly #slot: <T>(run: () => Promise<T>) => Promise<T>;

  constructor(inner: Indexer, ended: EndedRaces, parallel: number) {
    super({ base: inner.base });
    this.#inner = inner;
    this.#ended = ended;
    this.#slot = limiter(parallel);
  }

  override accountTxs(account: string): ReturnType<Indexer["accountTxs"]> {
    return this.#ended.through(`txs ${account}`, this.#ended.isSafe(account), () => this.#slot(() => this.#inner.accountTxs(account)));
  }

  override transactions(hashes: readonly string[]): ReturnType<Indexer["transactions"]> {
    return this.#slot(() => this.#inner.transactions(hashes));
  }
}

export interface ArenaFeedOptions {
  /** Every request to the RPC and the indexer. Default `fetch`. */
  fetch?: typeof fetch;
  /** The RPC and the indexer themselves, instead of this config's over `fetch`. */
  rpc?: ChainReader;
  indexer?: Indexer;
  now?: () => number;
  parallel?: number;
  timeoutMs?: number;
  keepAlive?: (reading: Promise<unknown>) => void;
}

/** The arena on this config's contracts, read over its RPC and its indexer, through a feed. */
export function arenaFeed(config: ArenaConfig, options: ArenaFeedOptions = {}): ArenaFeed {
  const now = options.now ?? Date.now;
  const parallel = options.parallel ?? ARENA_PARALLEL;
  const ended = new EndedRaces(now, [...config.contracts, ...config.teams]);
  const fetcher = options.fetch;
  const rpc = options.rpc ?? new ChainReader({ endpoints: config.rpc, ...(fetcher ? { fetch: fetcher } : {}) });
  const indexer = options.indexer ?? new Indexer({ base: config.indexer, ...(fetcher ? { fetch: fetcher } : {}) });
  const arena = new Arena({ rpc: new ArenaChain(rpc, ended, parallel), indexer: new ArenaIndexer(indexer, ended, parallel), contracts: config.contracts, now });
  return new ArenaFeed(arena, {
    now,
    onView: (view) => ended.mark(view),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.keepAlive ? { keepAlive: options.keepAlive } : {}),
  });
}

/** One reading of the arena for a tool: see `ArenaFeed.read`. */
export function readArena(feed: ArenaFeed, timeoutMs?: number): Promise<Reading> {
  return feed.read(timeoutMs);
}
