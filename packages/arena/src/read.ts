// The arena read from the chain with no keys: the bounty contracts' races (`get`, `get_safe`, `get_round`), the
// safes, every move a mask made, the drain, the winner and the payout. The list of races comes from the contracts'
// transactions in the public indexer; the state of each race comes from the contract itself over RPC. One round can
// be read alone by its id (`round`), without the rest of the arena.

import { ChainError, ChainReader } from "@maskwars/check";
import { ACTIVE_MS, CONTRACTS, FACTORY, MASKS, type MaskProfile, NETWORK, type Network, personOf, RPCS, SEASONS, TEAMS } from "./config.ts";
import { type AccountTx, type Call, Indexer, type Tx } from "./indexer.ts";
import type { ArenaView, MaskRace, MaskStats, NextRace, Phase, Race, RaceEvent, State, Who } from "./types.ts";

interface BountyView {
  owner: string;
  amount: string;
  target: string;
  deadline_ns: string;
  status: { state: State; winner?: string; tx_hash?: string; run_id?: string; claimant?: string };
}

interface SafeView {
  safe: string;
  masks: string[];
  min_loot: string;
  opened_ns: string;
}

interface SealView {
  mask: string;
  seq: number;
  at_ns: string;
  state: string;
}

interface RoundView {
  commit_until: string;
  reveal_until?: string | null;
  deadline_ns: string;
  seals: SealView[];
  judging?: string[];
}

/** A round a season treasury opened (`latest`). */
interface SeasonRoundView {
  id: string;
  safe: string;
  challenge: string;
}

/** The treasury's next round (`next`). */
interface NextView {
  at_ns: string;
  n: number;
  challenge: string;
  code_hash: string;
  prize: string;
  safe_fund: string;
  min_loot: string;
  masks: string[];
  hours: number;
  commit_minutes: number;
  funded: boolean;
}

/** A season treasury as the arena reads it: the bounty contract it opens rounds on, its rounds by id, its next one. */
interface SeasonState {
  season: string;
  bounty: string;
  rounds: Set<string>;
  next: NextView | null;
}

const OPEN = new Set(["open", "open_safe"]);
const CLAIM = new Set(["claim", "claim_drain", "settle"]);
const FINAL: ReadonlySet<State> = new Set(["paid", "drained", "refunded"]);
/** After the deadline a live safe's masks may still claim a drain made before it. */
const GRACE_MS = 12 * 60 * 60 * 1000;
/** How long one reading of a season treasury serves. */
const SEASON_TTL_MS = 60_000;
/** A round read alone takes the transactions from this long before it opened: its funding and its opening. */
const BEFORE_OPEN_MS = 60 * 60 * 1000;

/** What the bounty contract says about one race. */
interface RaceState {
  bounty: BountyView | null;
  safe: SafeView | null;
  round: RoundView | null;
}

const nsToMs = (ns: string | null | undefined): number | null => (ns && /^\d+$/.test(ns) ? Number(BigInt(ns) / 1_000_000n) : null);
const sum = (xs: readonly bigint[]) => xs.reduce((a, b) => a + b, 0n);

export interface ArenaOptions {
  /** The network the reader reads: the process's own (MASKWARS_NETWORK) unless given. */
  network?: Network;
  rpc?: ChainReader;
  indexer?: Indexer;
  contracts?: readonly string[];
  /** Season treasuries whose rounds and next race to read; none to read none. By default the arena's own, when the
   * reader reads one of the arena's own bounty contracts. */
  seasons?: readonly string[];
  masks?: readonly MaskProfile[];
  /** The arena's own teams: their races come first on the home page. */
  teams?: readonly string[];
  /** The mask factory whose direct sub-accounts are people's masks, named by their own name. */
  factory?: string;
  now?: () => number;
  /** How long one reading of the arena is reused, ms. Finished races are read once. */
  ttlMs?: number;
}

interface Cached<T> {
  at: number;
  value: Promise<T>;
}

interface ContractCall {
  tx: Tx;
  call: Call;
}

export class Arena {
  readonly #network: Network;
  readonly #rpc: ChainReader;
  readonly #indexer: Indexer;
  readonly #contracts: readonly string[];
  readonly #seasons: readonly string[];
  readonly #masks: readonly MaskProfile[];
  readonly #teams: readonly string[];
  readonly #factory: string;
  readonly #now: () => number;
  readonly #ttl: number;
  readonly #txs = new Map<string, Tx>();
  readonly #lists = new Map<string, Cached<AccountTx[]>>();
  readonly #final = new Map<string, Race>();
  readonly #seasonState = new Map<string, Cached<SeasonState | null>>();
  /** When a reading of the whole arena last went on without a treasury that did not answer. */
  readonly #seasonSkipped = new Map<string, number>();
  #view: Cached<ArenaView> | null = null;
  #lastGood: ArenaView | null = null;

  constructor(options: ArenaOptions = {}) {
    this.#network = options.network ?? NETWORK;
    this.#rpc = options.rpc ?? new ChainReader({ endpoints: RPCS });
    this.#indexer = options.indexer ?? new Indexer();
    this.#contracts = options.contracts ?? CONTRACTS;
    // The season treasuries open their rounds on the arena's own bounty contracts: a reader of other contracts reads
    // none of them unless it names some.
    const own = this.#contracts.some((c) => (CONTRACTS as readonly string[]).includes(c));
    this.#seasons = options.seasons ?? (own ? SEASONS : []);
    this.#masks = options.masks ?? MASKS;
    this.#teams = options.teams ?? TEAMS;
    this.#factory = options.factory ?? FACTORY;
    this.#now = options.now ?? Date.now;
    this.#ttl = options.ttlMs ?? 5_000;
  }

  /** The whole arena. Reused for `ttlMs`; when a fresh reading fails, the last good one is served. */
  async view(): Promise<ArenaView> {
    const now = this.#now();
    if (this.#view && now - this.#view.at < this.#ttl) return this.#view.value;
    const value = this.#build().then(
      (v) => {
        this.#lastGood = v;
        return v;
      },
      (error: unknown) => {
        this.#view = null;
        if (this.#lastGood) return this.#lastGood;
        throw error;
      },
    );
    this.#view = { at: now, value };
    return value;
  }

  async race(id: string): Promise<Race | null> {
    return (await this.view()).races.find((r) => r.id === id) ?? null;
  }

  /**
   * One round by its id, read alone: its state on the bounty contract, and only the transactions since it opened. Any
   * id the contract holds is read, a season's round however old and a round opened by hand alike. Null when no bounty
   * contract of the arena holds the id. A chain or an indexer that does not answer throws its own error (`ChainError`,
   * `IndexerError`): nothing is skipped and nothing is served from an earlier reading.
   */
  async round(id: string): Promise<Race | null> {
    const now = this.#now();
    for (const contract of this.#contracts) {
      const state = await this.#state(contract, id);
      if (!state.bounty) continue;
      const opened = nsToMs(state.safe?.opened_ns);
      const since = opened === null ? 0 : opened - BEFORE_OPEN_MS;
      const about = (c: ContractCall) => c.call.args?.["id"] === id;
      const calls: ContractCall[] = (await this.#accountTxs(contract, true, since))
        .filter((tx) => tx.receiver === contract)
        .flatMap((tx) => tx.calls.map((call) => ({ tx, call })))
        .filter(about);
      // The treasury that opened it is the bounty's owner on the contract: no list of the treasury's is asked.
      const season = this.#seasons.includes(state.bounty.owner) ? state.bounty.owner : null;
      if (season) calls.push(...(await this.#seasonOpens({ season, bounty: contract, rounds: new Set([id]), next: null }, since, true)).filter(about));
      return this.#race(contract, id, calls, () => this.#judge(contract), now, season, state);
    }
    return null;
  }

  /**
   * The next race a season opens on schedule, as its treasury says now; null when no treasury is on chain or none plans
   * one. A treasury that cannot be read throws.
   */
  async next(): Promise<NextRace | null> {
    const seasons = (await Promise.all(this.#seasons.map((season) => this.#season(season)))).filter((x): x is SeasonState => x !== null);
    return this.#soonest(seasons);
  }

  /** A mask by its page name (`nova`) or its account. */
  async mask(slugOrAccount: string): Promise<MaskStats | null> {
    const key = slugOrAccount.toLowerCase();
    return (await this.view()).league.find((m) => m.who.slug === key || m.who.account === key) ?? null;
  }

  // ---------------------------------------------------------------------------------------------------------------

  async #build(): Promise<ArenaView> {
    const now = this.#now();
    const seen = new Set<string>();
    const jobs: Promise<Race | null>[] = [];
    // The whole arena reads on without a treasury that does not answer this time, as it does without one that is not
    // on chain: the races on the bounty contracts are still told, and the treasury is asked again at the next reading.
    // `next` and `round` pass the failure on as it is.
    const seasons = (await Promise.all(this.#seasons.map((season) => this.#seasonOrSkip(season)))).filter((x): x is SeasonState => x !== null);
    for (const contract of this.#contracts) {
      // Only the transactions that called the contract: its account may also be a person's, with other business.
      const txs = await this.#accountTxs(contract, true);
      const calls: ContractCall[] = txs
        .filter((tx) => tx.receiver === contract)
        .flatMap((tx) => tx.calls.map((call) => ({ tx, call })));
      // A season's treasury opens its rounds from its own transactions: `open_safe` is a receipt of `open_next`.
      const mine = seasons.filter((x) => x.bounty === contract);
      for (const x of mine) calls.push(...(await this.#seasonOpens(x)));
      const opened = calls
        .filter((c) => c.tx.ok && OPEN.has(c.call.method) && typeof c.call.args?.["id"] === "string")
        .sort((a, b) => b.tx.at - a.tx.at);
      // A round the treasury lists whose opening the indexer has not shown yet is read all the same.
      const listed = mine.flatMap((x) => [...x.rounds].filter((id) => !opened.some((o) => o.call.args?.["id"] === id)));
      let judge: Promise<string | null> | null = null;
      const judgeOnce = () => (judge ??= this.#judge(contract));
      const ids = [...opened.map((o) => o.call.args?.["id"] as string), ...listed];
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const own = calls.filter((c) => c.call.args?.["id"] === id);
        const season = mine.find((x) => x.rounds.has(id))?.season ?? null;
        const done = this.#final.get(`${contract}/${id}`);
        jobs.push(done ? Promise.resolve(done) : this.#race(contract, id, own, judgeOnce, now, season));
      }
    }
    const races = (await Promise.all(jobs))
      .filter((r): r is Race => r !== null)
      .sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0) || b.id.localeCompare(a.id));
    for (const r of races) if (FINAL.has(r.state)) this.#final.set(`${r.contract}/${r.id}`, r);
    const next = this.#soonest(seasons);
    return { network: this.#network, races, now: pickNow(races), next, league: this.#league(races), readAt: now };
  }

  /**
   * A season treasury: its bounty contract, its latest rounds and its next one. One that is not on chain is skipped;
   * an RPC that fails is an error, never "no treasury": `next` passes it on, the whole arena reads on without the
   * treasury (`#build`). The treasury changes once a slot, so one reading of it serves
   * for `SEASON_TTL_MS`: the arena's own readings every few seconds read the race lists again, not the treasury.
   */
  #season(season: string): Promise<SeasonState | null> {
    const now = this.#now();
    const cached = this.#seasonState.get(season);
    if (cached && now - cached.at < SEASON_TTL_MS) return cached.value;
    const value = this.#readSeason(season);
    const entry = { at: now, value };
    this.#seasonState.set(season, entry);
    // A reading that failed is not kept: the next one asks the chain again.
    value.catch(() => {
      if (this.#seasonState.get(season) === entry) this.#seasonState.delete(season);
    });
    return value;
  }

  /**
   * The treasury for a reading of the whole arena: one that does not answer is skipped, and not asked again for
   * `SEASON_TTL_MS`, so a node that is down is not asked at every reading of the race lists.
   */
  async #seasonOrSkip(season: string): Promise<SeasonState | null> {
    const now = this.#now();
    const skipped = this.#seasonSkipped.get(season);
    if (skipped !== undefined && now - skipped < SEASON_TTL_MS) return null;
    try {
      const state = await this.#season(season);
      this.#seasonSkipped.delete(season);
      return state;
    } catch {
      this.#seasonSkipped.set(season, now);
      return null;
    }
  }

  async #readSeason(season: string): Promise<SeasonState | null> {
    try {
      const [state, latest, next] = await Promise.all([
        this.#rpc.view<{ bounty?: unknown } | null>(season, "season", {}),
        this.#rpc.view<SeasonRoundView[] | null>(season, "latest", { limit: 50 }),
        this.#rpc.view<NextView | null>(season, "next", {}),
      ]);
      if (!state || typeof state.bounty !== "string") return null;
      return { season, bounty: state.bounty, rounds: new Set((latest ?? []).map((r) => r.id)), next: next ?? null };
    } catch (error) {
      // Not on chain yet (no account, or no treasury code on it): the arena reads on without it. Anything else is the
      // RPC failing, and it is said as that: a round is never told as "no treasury opened it" because a node was down.
      if (error instanceof ChainError && (error.kind === "unknown_account" || error.kind === "contract")) return null;
      throw error;
    }
  }

  /** The `open_safe` calls the treasury made, each with the transaction that made it (the scheduler's `open_next`). */
  async #seasonOpens(x: SeasonState, since = 0, strict = false): Promise<ContractCall[]> {
    const read = this.#accountTxs(x.season, true, since);
    // The whole arena reads on when the treasury's history is late; one round read alone says the indexer failed.
    const txs = await (strict ? read : read.catch(() => [] as Tx[]));
    return txs.flatMap((tx) =>
      tx.receipts
        .filter((r) => r.from === x.season && r.to === x.bounty && r.ok)
        // The opening is when the receipt ran, after the safe was made in the same transaction.
        .flatMap((r) => r.calls.filter((c) => c.method === "open_safe").map((call) => ({ tx: { ...tx, at: r.at || tx.at, ok: tx.ok && r.ok }, call }))),
    );
  }

  /** The soonest next race of any season. */
  #soonest(seasons: readonly SeasonState[]): NextRace | null {
    const all = seasons.flatMap((x): NextRace[] => {
      const n = x.next;
      const at = nsToMs(n?.at_ns);
      if (!n || at === null) return [];
      const maskSet = new Set(n.masks);
      return [
        {
          season: x.season,
          at,
          n: n.n,
          target: n.challenge,
          targetCode: n.code_hash,
          inSafe: n.safe_fund,
          locked: n.prize,
          prize: (BigInt(n.safe_fund) + BigInt(n.prize)).toString(),
          minLoot: n.min_loot,
          masks: n.masks.map((m) => this.#who(m, maskSet)),
          sealMinutes: n.commit_minutes,
          hours: n.hours,
          funded: n.funded,
        },
      ];
    });
    return all.sort((a, b) => a.at - b.at)[0] ?? null;
  }

  /** An account's transactions with their receipts; the ones from before `since` are left out, unread. */
  async #accountTxs(account: string, callsOnly = false, since = 0): Promise<Tx[]> {
    const now = this.#now();
    let list = this.#lists.get(account);
    if (!list || now - list.at >= this.#ttl * 2) {
      const value = this.#indexer.accountTxs(account);
      const prev = list;
      list = { at: now, value: value.catch((e: unknown) => (prev ? prev.value : Promise.reject(e))) };
      this.#lists.set(account, list);
    }
    const hashes = (await list.value).filter((t) => (!callsOnly || t.call) && (t.at === 0 || t.at >= since)).map((t) => t.hash);
    const missing = hashes.filter((h) => !this.#txs.has(h));
    if (missing.length) for (const tx of await this.#indexer.transactions(missing)) this.#txs.set(tx.hash, tx);
    return hashes.flatMap((h) => {
      const tx = this.#txs.get(h);
      return tx ? [tx] : [];
    });
  }

  async #judge(contract: string): Promise<string | null> {
    const j = await this.#rpc.view<{ version?: unknown } | null>(contract, "judge", {}).catch(() => null);
    return typeof j?.version === "string" ? j.version : null;
  }

  async #viewOrNull<T>(contract: string, method: string, args: unknown): Promise<T | null> {
    try {
      return await this.#rpc.view<T | null>(contract, method, args);
    } catch (error) {
      // A contract from before sealed rounds has no `get_round`: that race simply has no round.
      if (error instanceof ChainError && error.kind === "contract") return null;
      throw error;
    }
  }

  /** A race's own state on its contract: the bounty, and the safe and the sealed round when it has them. */
  async #state(contract: string, id: string): Promise<RaceState> {
    const [bounty, safe, round] = await Promise.all([
      this.#rpc.view<BountyView | null>(contract, "get", { id }),
      this.#viewOrNull<SafeView>(contract, "get_safe", { id }),
      this.#viewOrNull<RoundView>(contract, "get_round", { id }),
    ]);
    return { bounty, safe, round };
  }

  #who(account: string, inRace: ReadonlySet<string>): Who {
    const p = this.#masks.find((m) => m.account === account);
    if (p) return { account, slug: p.slug, name: p.name, mask: true, model: p.model };
    // A person's mask from the factory goes by its own name: `kira.masks.tinygif8324.testnet` is KIRA.
    const person = personOf(account, this.#factory);
    if (person) return { account, slug: person, name: person.toUpperCase(), mask: true, model: null };
    // Another team's mask goes by its whole account: `nova.someone.testnet` is not the arena's NOVA.
    return { account, slug: null, name: account, mask: inRace.has(account), model: null };
  }

  async #race(
    contract: string,
    id: string,
    calls: ContractCall[],
    judge: () => Promise<string | null>,
    now: number,
    season: string | null = null,
    read?: RaceState,
  ): Promise<Race | null> {
    const { bounty, safe, round } = read ?? (await this.#state(contract, id));
    if (!bounty) return null;
    // A round the treasury no longer lists (`latest` gives its newest only) is still its own: it owns the bounty.
    season ??= this.#seasons.includes(bounty.owner) ? bounty.owner : null;
    const state = bounty.status.state;
    const final = FINAL.has(state);
    const maskSet = new Set(safe?.masks ?? []);
    const who = (a: string) => this.#who(a, maskSet);
    const team = bounty.owner;
    const deadline = nsToMs(bounty.deadline_ns) ?? 0;
    const openCall = calls.filter((c) => c.tx.ok && OPEN.has(c.call.method)).sort((a, b) => a.tx.at - b.tx.at)[0] ?? null;
    const openedAt = nsToMs(safe?.opened_ns) ?? openCall?.tx.at ?? null;
    const sealUntil = nsToMs(round?.commit_until);
    const startsAt = sealUntil ?? openedAt;
    const events: RaceEvent[] = [];

    if (openCall) {
      events.push({ kind: "open", at: openCall.tx.at, tx: openCall.tx.hash, who: who(team), amount: openCall.call.deposit.toString(), ok: true });
    }

    // The safe: what went in, every move of a mask, every drain.
    let targetCode: string | null = null;
    let inSafe: string | null = null;
    let funded: bigint | null = null;
    const drains: { mask: string; amount: bigint; at: number; tx: string; early: boolean }[] = [];
    if (safe) {
      const [account, available, safeTxs] = await Promise.all([
        this.#rpc.account(safe.safe).catch(() => null),
        final ? Promise.resolve(null) : this.#rpc.view<string>(safe.safe, "available", {}).catch(() => null),
        this.#accountTxs(safe.safe),
      ]);
      targetCode = account?.codeHash ?? null;
      inSafe = typeof available === "string" && /^\d+$/.test(available) ? available : null;
      const from = (openedAt ?? 0) - 60 * 60 * 1000;
      const until = deadline + GRACE_MS;
      for (const tx of [...safeTxs].sort((a, b) => a.at - b.at)) {
        if (tx.at > until) continue;
        const inflow = sum(tx.receipts.filter((r) => r.to === safe.safe && r.from !== "system" && !maskSet.has(r.from) && r.ok).map((r) => r.transfer));
        if (inflow > 0n && tx.at >= from) {
          funded = (funded ?? 0n) + inflow;
          // The team funds the safe itself, or its treasury does in the round's own transaction.
          const byTeam = tx.signer === safe.safe || tx.receipts.some((r) => r.to === safe.safe && r.from === team && r.transfer > 0n);
          events.push({ kind: "fund", at: tx.at, tx: tx.hash, who: who(byTeam ? team : tx.signer), amount: inflow.toString(), ok: true });
        }
        if (tx.receiver !== safe.safe || !maskSet.has(tx.signer) || openedAt === null || tx.at < openedAt) continue;
        const out = tx.receipts.filter((r) => r.from === safe.safe && r.to === tx.signer && r.ok && r.transfer > 0n);
        const taken = sum(out.map((r) => r.transfer));
        const method = tx.calls.map((c) => c.method).join(", ") || "call";
        if (taken > 0n) {
          const at = out[0]?.at ?? tx.at;
          // A drain in the sealing window: by the rules it does not count, whoever made it.
          const early = startsAt !== null && tx.at < startsAt;
          drains.push({ mask: tx.signer, amount: taken, at: tx.at, tx: tx.hash, early });
          const drain: RaceEvent = { kind: "drain", at: Math.min(at, tx.at), tx: tx.hash, who: who(tx.signer), amount: taken.toString(), ok: true, method };
          events.push(early ? { ...drain, early } : drain);
        } else {
          events.push({ kind: "move", at: tx.at, tx: tx.hash, who: who(tx.signer), amount: null, ok: tx.ok, method });
        }
      }
    }

    // The winner: the contract's word once it paid; before that, the first mask that drained the safe once the race
    // started. A drain in the sealing window makes no winner: the round has none until a counted drain or a payout.
    const s = bounty.status;
    const counted = drains.filter((d) => !d.early);
    const paidTo = state === "paid" || state === "drained" ? (s.winner ?? null) : null;
    const pending = !paidTo && state !== "refunded" ? (counted[0]?.mask ?? null) : null;
    const winnerAccount = paidTo ?? pending;

    // Seals, reveals, claims, payout and refund, from the contract's own transactions.
    for (const seal of round?.seals ?? []) {
      const commit = calls.find((c) => c.call.method === "commit" && c.tx.signer === seal.mask && c.tx.ok);
      events.push({ kind: "seal", at: nsToMs(seal.at_ns) ?? commit?.tx.at ?? 0, tx: commit?.tx.hash ?? "", who: who(seal.mask), amount: null, ok: true, seq: seal.seq });
    }
    let payout: Race["payout"] = null;
    let refund: Race["refund"] = null;
    for (const c of [...calls].sort((a, b) => a.tx.at - b.tx.at)) {
      const m = c.call.method;
      if (m === "reveal") {
        events.push({ kind: "reveal", at: c.tx.at, tx: c.tx.hash, who: who(c.tx.signer), amount: null, ok: c.tx.ok });
      } else if (CLAIM.has(m)) {
        const pay = winnerAccount ? c.tx.receipts.find((r) => r.from === contract && r.to === winnerAccount && r.transfer > 0n && r.ok) : undefined;
        if (pay && !payout) {
          payout = { amount: pay.transfer.toString(), at: pay.at, tx: c.tx.hash };
        }
        if (m === "settle" && !pay) continue;
        if (!c.tx.ok && m !== "settle") {
          events.push({ kind: "claim", at: c.tx.at, tx: c.tx.hash, who: who(c.tx.signer), amount: null, ok: false, verdict: "no" });
          continue;
        }
        const judged = c.tx.receipts.some((r) => r.calls.some((x) => x.method === "on_judged"));
        const verdict = pay ? "paid" : judged || final ? "no" : "waiting";
        events.push({ kind: "claim", at: c.tx.at, tx: c.tx.hash, who: who(c.tx.signer), amount: null, ok: true, verdict });
        if (pay && winnerAccount) events.push({ kind: "paid", at: pay.at, tx: c.tx.hash, who: who(winnerAccount), amount: pay.transfer.toString(), ok: true });
      } else if (m === "refund" && c.tx.ok) {
        const back = c.tx.receipts.find((r) => r.from === contract && r.to === team && r.transfer > 0n && r.ok);
        if (back) {
          refund = { amount: back.transfer.toString(), at: back.at, tx: c.tx.hash };
          events.push({ kind: "refund", at: back.at, tx: c.tx.hash, who: who(team), amount: back.transfer.toString(), ok: true });
        }
      }
    }
    if (!payout && paidTo) payout = { amount: bounty.amount, at: null, tx: null };
    if (!refund && state === "refunded") refund = { amount: bounty.amount, at: null, tx: null };
    events.sort((a, b) => a.at - b.at);

    // What the winner's drains took: the counted ones, or for a payout the contract made, any it made.
    const theirs = (counted.some((d) => d.mask === winnerAccount) ? counted : drains).filter((d) => d.mask === winnerAccount);
    const winnerDrain = winnerAccount ? theirs[0] : undefined;
    const loot = winnerAccount ? sum(theirs.map((d) => d.amount)) : 0n;
    const brokeAt = winnerDrain?.at ?? null;
    const takes = winnerAccount ? loot + (payout ? BigInt(payout.amount) : 0n) : null;
    const amount = BigInt(bounty.amount);

    let phase: Phase;
    if (winnerAccount) phase = "broken";
    else if (state === "refunded" || now >= deadline) phase = "held";
    else if (sealUntil !== null && now < sealUntil) phase = "sealing";
    else phase = "racing";

    const lastMove = Math.max(0, ...events.filter((e) => e.who?.mask && e.kind !== "paid").map((e) => e.at));
    const waiting = events.some((e) => e.verdict === "waiting");
    const revealUntil = nsToMs(round?.reveal_until ?? null);
    // By the round's rule the sealed masks play and reveal until the reveal window ends, a drain or not: the round is
    // on until then.
    const inRound = sealUntil !== null && revealUntil !== null && now < revealUntil;
    const live =
      !final &&
      now < deadline + (safe ? GRACE_MS : 0) &&
      (phase === "sealing" ||
        inRound ||
        state === "judging" ||
        waiting ||
        (round?.judging?.length ?? 0) > 0 ||
        (lastMove > 0 && now - lastMove < ACTIVE_MS));

    const locked = openCall ? openCall.call.deposit.toString() : null;
    const prize = phase === "broken" && takes !== null ? takes : amount + (inSafe ? BigInt(inSafe) : 0n);

    return {
      id,
      network: this.#network,
      contract,
      season,
      kind: safe ? "safe" : "sandbox",
      phase,
      live,
      state,
      team,
      official: this.#teams.includes(team),
      target: bounty.target,
      targetCode,
      locked,
      bounty: bounty.amount,
      inSafe: final ? null : inSafe,
      safeFunded: funded === null ? null : funded.toString(),
      minLoot: safe?.min_loot ?? null,
      openedAt,
      startsAt,
      deadline,
      sealUntil,
      revealUntil,
      masks: (safe?.masks ?? []).map(who),
      winner: winnerAccount ? who(winnerAccount) : null,
      brokeAt,
      // A break counts from the start of the race: a drain the contract paid for that came before it has no time.
      breakMs: brokeAt !== null && startsAt !== null && brokeAt >= startsAt ? brokeAt - startsAt : null,
      loot: winnerAccount && loot > 0n ? loot.toString() : null,
      payout,
      refund,
      takes: takes === null ? null : takes.toString(),
      prize: prize.toString(),
      events,
      txs: { open: openCall?.tx.hash ?? null, drain: winnerDrain?.tx ?? s.tx_hash ?? null, payout: payout?.tx ?? null },
      judge: await judge(),
      runId: s.run_id ?? null,
    };
  }

  #league(races: readonly Race[]): MaskStats[] {
    const people = new Map<string, Who>();
    for (const m of this.#masks) people.set(m.account, { account: m.account, slug: m.slug, name: m.name, mask: true, model: m.model });
    for (const r of races) {
      for (const m of r.masks) if (!people.has(m.account)) people.set(m.account, m);
      if (r.winner?.mask && !people.has(r.winner.account)) people.set(r.winner.account, r.winner);
    }
    const rows = [...people.values()].map((who): MaskStats => {
      const mine = races.filter((r) => r.masks.some((m) => m.account === who.account) || r.winner?.account === who.account);
      const history = mine.map((r): MaskRace => {
        const won = r.phase === "broken" && FINAL.has(r.state) && r.winner?.account === who.account;
        return { id: r.id, at: r.openedAt, phase: r.phase, won, takes: won ? r.takes : null, breakMs: won ? r.breakMs : null, target: r.target, targetCode: r.targetCode };
      });
      const wins = history.filter((h) => h.won);
      const timed = wins.filter((h) => h.breakMs !== null).sort((a, b) => a.breakMs! - b.breakMs!);
      return {
        who,
        races: history.length,
        breaks: wins.length,
        earned: sum(wins.map((h) => BigInt(h.takes ?? "0"))).toString(),
        fastestMs: timed[0]?.breakMs ?? null,
        fastestRace: timed[0]?.id ?? null,
        history,
      };
    });
    return rows.sort((a, b) => {
      const e = BigInt(b.earned) - BigInt(a.earned);
      if (e !== 0n) return e > 0n ? 1 : -1;
      if (b.breaks !== a.breaks) return b.breaks - a.breaks;
      const fa = a.fastestMs ?? Number.POSITIVE_INFINITY;
      const fb = b.fastestMs ?? Number.POSITIVE_INFINITY;
      return fa - fb || a.who.name.localeCompare(b.who.name);
    });
  }
}

/**
 * The race for the home page: one running now, the arena's own teams' first (LIVE, then racing, then sealing, then the
 * newest), another team's only after them and with `official: false` for the page to say so; with none running, the
 * arena's latest race, else the latest of all.
 */
export function pickNow(races: readonly Race[]): Race | null {
  const running = races.filter((r) => r.live || r.phase === "sealing" || r.phase === "racing");
  const rank = (r: Race) => (r.official ? 0 : 4) + (r.live ? 0 : r.phase === "racing" ? 1 : r.phase === "sealing" ? 2 : 3);
  running.sort((a, b) => rank(a) - rank(b) || (b.openedAt ?? 0) - (a.openedAt ?? 0));
  return running[0] ?? races.find((r) => r.official) ?? races[0] ?? null;
}
