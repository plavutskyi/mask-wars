// Every fact about one account the encyclopedia may print: read from the arena (`@maskwars/arena`) and MASK CHECK
// (`@maskwars/check`), written in words by this code. A model only ever sees these facts, and every sentence it writes
// must cite them. Names that come from the chain (accounts, method names) are checked against NEAR's own charset before
// they go into a fact, so a fact never carries free text from outside.

import { type ArenaView, CONTRACTS, HOUSE, NETWORK, type Race, type RaceEvent, TEAMS, type Who, accountUrl, txUrl } from "@maskwars/arena";
import { near } from "@maskwars/arena/format";
import { type CheckResult, type SharedList, accountOk, sharedLists } from "@maskwars/check";
import { sha256Hex } from "@maskwars/mind";
import { libraryEntry } from "./library.ts";
import { clock, moment, normNumber } from "./numbers.ts";
import { numbersOf } from "./words.ts";
import type {
  CheckSummary,
  Dossier,
  Evidence,
  EvidenceKind,
  Headline,
  JudgeResult,
  LibraryEntry,
  RaceLine,
  Role,
  Value,
} from "./types.ts";

/** The site: a fact that only the arena's own pages show links there. */
export const SITE = "https://maskwars.xyz";

/** At most this many steps of one kind in one race become facts; the race's own fact counts the moves. */
const PER_KIND = 12;
/** At most this many races, the newest, become facts. */
const RACES_PER_PAGE = 12;

/**
 * The arena's own teams on the network this process reads (packages/network: the admin, the season treasury and the
 * house). Anyone can open a race on the bounty contract, with any target and any masks; only these teams' races are
 * the arena's record of a contract.
 */
export const ARENA_TEAMS: readonly string[] = TEAMS;

const FINAL = new Set(["paid", "drained", "refunded"]);

export interface CollectInput {
  /** The account, or a training target's name. */
  readonly account: string;
  /** The arena as read now; `null` when it could not be read. */
  readonly view: ArenaView | null;
  /** MASK CHECK about the account; `null` when it was not asked. Shown live beside the page; never a fact. */
  readonly check: CheckResult | null;
  /** Whose races count; `ARENA_TEAMS` unless told otherwise. */
  readonly teams?: readonly string[];
  /** The shared list of the reading's network unless told otherwise. */
  readonly list?: SharedList;
  /** The house and its vault, on the reading's network; `HOUSE` unless told otherwise. */
  readonly house?: { readonly account: string; readonly vault: string; readonly target: string };
  readonly now: number;
}

/** A method name as the chain gave it, or a plain word when it is not one a contract could export. */
function method(m: string | undefined): string | null {
  if (!m) return null;
  const names = m.split(", ").filter((x) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(x));
  return names.length ? names.join(", ") : null;
}

/** A mask's short name only when it reads as a name: a letter in it and no digit first. */
const shortName = (w: Who) => (w.name !== w.account && /\p{L}/u.test(w.name) && !/^\p{N}+(?![\p{L}\p{N}])/u.test(w.name) ? w.name : null);

/** NOVA (nova.tinygif8324.testnet); any other account as itself. */
function nameOf(w: Who | null): string {
  if (!w) return "someone";
  if (!accountOk(w.account)) return "an account";
  const short = shortName(w);
  return w.mask && short ? `${short} (${w.account})` : w.account;
}

function namesOf(w: Who | null): string[] {
  if (!w || !accountOk(w.account)) return [];
  const short = shortName(w);
  return short ? [w.account, short] : [w.account];
}

/**
 * The steps of a race that are the race's own: the team's, its masks', the winner's and the contract's. A stranger can
 * call the bounty contract with any race id (a claim, a reveal) or send NEAR to a safe; that is noise, not the race.
 * Each kind of step is cut to the first few.
 */
export function ownSteps(r: Race, cap = PER_KIND): RaceEvent[] {
  const own = new Set([r.team, ...r.masks.map((m) => m.account), ...(r.winner ? [r.winner.account] : [])]);
  const seen = new Map<string, number>();
  return r.events.filter((e) => {
    if (e.who && !own.has(e.who.account)) return false;
    const n = (seen.get(e.kind) ?? 0) + 1;
    seen.set(e.kind, n);
    return n <= cap;
  });
}

interface Draft {
  kind: EvidenceKind;
  fact: string;
  data: Record<string, Value>;
  extra: string[];
  names: string[];
  at: number | null;
  tx: string | null;
  href: string | null;
  race: string | null;
}

function draft(d: Partial<Draft> & Pick<Draft, "kind" | "fact">): Draft {
  return { data: {}, extra: [], names: [], at: null, tx: null, href: null, race: null, ...d };
}

/** The NEAR amount as the page writes it. */
const nearOf = (y: string | bigint | null | undefined) => near(y ?? null);

function raceFact(r: Race, target: string, training: boolean, now: number): Draft {
  const opened = r.openedAt !== null ? moment(r.openedAt) : null;
  const deadline = moment(r.deadline);
  const masks = r.masks.filter((m) => accountOk(m.account));
  const parts: string[] = [];
  const extra: string[] = [...(opened?.numbers ?? []), ...deadline.numbers];
  const data: Record<string, Value> = {
    race: r.id,
    bounty_contract: r.contract,
    kind: r.kind === "safe" ? "a live safe on chain" : "a sandbox run",
    team: r.team,
    opened: opened?.text ?? null,
    opened_date: opened ? opened.text.slice(0, 10) : null,
    opened_time: opened ? opened.text.slice(11) : null,
    deadline: deadline.text,
    deadline_date: deadline.text.slice(0, 10),
    deadline_time: deadline.text.slice(11),
    bounty_locked_near: r.locked ? nearOf(r.locked) : null,
    masks: masks.map((m) => m.account),
    masks_count: masks.length,
    state_on_contract: r.state,
  };
  // How the race ended, as the page's words about it must agree: broken, drained but not confirmed, held, called off, or not yet.
  data["outcome"] =
    r.phase === "broken" ? "broken" : r.events.some((e) => e.kind === "drain") ? "unconfirmed" : calledOff(r, now) ? "called_off" : r.phase === "held" && FINAL.has(r.state) ? "held" : "running";

  const where = r.kind === "safe" ? `on the safe ${target}` : `on the ${training ? "training target" : "target"} ${target} in the race sandbox`;
  parts.push(
    `${r.id} is a race ${where}, run by the bounty contract ${r.contract}.` +
      ` The team ${r.team} opened it${opened ? ` at ${opened.text}` : ""}${r.locked ? ` and locked a bounty of ${nearOf(r.locked)} NEAR` : ""}; the deadline was ${deadline.text}.`,
  );
  if (masks.length) parts.push(`${masks.length} ${masks.length === 1 ? "mask" : "masks"} raced: ${masks.map((m) => nameOf(m)).join(", ")}.`);
  const stepped = ownSteps(r, Number.POSITIVE_INFINITY).filter((e) => e.kind === "move" || e.kind === "drain");
  const moves = stepped.length;
  if (moves) {
    // When one mask made every move, the fact says so: "the masks made 2 moves" is not read as two masks moving.
    const movers = new Map(stepped.filter((e) => e.who).map((e) => [e.who!.account, e.who!]));
    const one = movers.size === 1 && stepped.every((e) => e.who) ? [...movers.values()][0]! : null;
    parts.push(`The masks made ${moves} ${moves === 1 ? "move" : "moves"} on it${one && moves > 1 ? `, all by ${nameOf(one)}` : ""}.`);
    data["moves"] = moves;
  }

  if (r.phase === "broken" && r.winner) {
    const w = r.winner;
    const time = r.breakMs !== null ? clock(r.breakMs) : null;
    data["winner"] = w.account;
    data["winner_name"] = shortName(w);
    data["break_after_start"] = time;
    data["loot_near"] = r.loot ? nearOf(r.loot) : null;
    data["bounty_paid_near"] = r.payout ? nearOf(r.payout.amount) : null;
    data["took_in_all_near"] = r.takes ? nearOf(r.takes) : null;
    if (r.kind === "safe" && r.loot) {
      parts.push(`${nameOf(w)} drained it${time ? ` ${time} after the start` : ""} and took ${nearOf(r.loot)} NEAR out of it.`);
    } else if (r.kind === "sandbox") {
      parts.push(`The judge confirmed a drain of the target${r.runId ? ` in sandbox run ${r.runId}` : ""}.`);
      if (r.runId) data["sandbox_run"] = r.runId;
    }
    if (r.payout) {
      const team = w.account === r.team ? ", the team's own account" : "";
      parts.push(`The bounty contract paid ${nearOf(r.payout.amount)} NEAR to ${nameOf(w)}${team}.`);
    } else if (!FINAL.has(r.state)) {
      parts.push(r.events.some((e) => e.verdict === "waiting") ? "The claim on the bounty is with the judge." : "No claim on the bounty is confirmed yet.");
    }
    if (r.takes && r.loot && r.payout) parts.push(`${nameOf(w)} took ${nearOf(r.takes)} NEAR in all.`);
  } else if (drainsOf(r).length) {
    // A mask drained the safe on chain, and the judge did not confirm it: the safe did not hold, the bounty was not won.
    const first = drainsOf(r)[0]!;
    const back = r.refund?.amount ?? (r.state === "refunded" ? r.bounty : null);
    if (back) data["bounty_back_near"] = nearOf(back);
    parts.push(
      `${nameOf(first.who)} drained it, but the judge did not confirm the drain${back ? `; the bounty of ${nearOf(back)} NEAR went back to the team` : " yet"}.`,
    );
  } else if (calledOff(r, now)) {
    const back = r.refund?.amount ?? r.bounty;
    data["bounty_back_near"] = nearOf(back);
    parts.push(`The bounty of ${nearOf(back)} NEAR went back to the team before the deadline: the race was called off.`);
  } else if (r.phase === "held" && FINAL.has(r.state)) {
    const back = r.refund?.amount ?? r.bounty;
    data["bounty_back_near"] = nearOf(back);
    // When the refund's own transaction was not read, its time is not known: nothing is said about the deadline.
    parts.push(refundUnread(r) ? `Nobody drained it; the bounty of ${nearOf(back)} NEAR went back to the team.` : `Nobody drained it before the deadline; the bounty of ${nearOf(back)} NEAR went back to the team.`);
  } else if (r.phase === "held") {
    parts.push("The deadline passed with no drain confirmed by the judge, and the bounty has not gone back yet.");
  } else {
    // What is in the safe changes with every move: the page's number shows it live, a fact does not carry it.
    parts.push(r.kind === "safe" ? "The race runs until the deadline, and nobody has drained it yet." : "The race runs until the deadline, and the judge has confirmed no drain yet.");
  }
  parts.push(`State on the bounty contract: ${r.state}.`);

  return draft({
    kind: "race",
    fact: parts.join(" "),
    data,
    extra,
    names: [r.id, r.contract, r.team, target, ...masks.flatMap(namesOf), ...namesOf(r.winner)],
    at: r.openedAt,
    tx: r.txs.open,
    href: `${SITE}/race/${r.id}`,
    race: r.id,
  });
}

function eventFact(e: RaceEvent, r: Race, target: string): Draft | null {
  const when = moment(e.at);
  const from = r.startsAt ?? r.openedAt;
  const after = from !== null && e.at >= from && (e.kind === "move" || e.kind === "drain") ? clock(e.at - from) : null;
  const amount = e.amount ? nearOf(e.amount) : null;
  const who = nameOf(e.who);
  const m = method(e.method);
  let text: string;
  switch (e.kind) {
    case "open":
      text = `${who} opened ${r.id} and locked ${amount ?? "its"} NEAR as the bounty`;
      break;
    case "fund":
      text = `${who} put ${amount} NEAR into the safe for ${r.id}`;
      break;
    case "seal":
      text = `${who} sealed its plan for ${r.id}${e.seq !== undefined ? ` as seal number ${e.seq}` : ""}`;
      break;
    case "move":
      text = e.ok ? `${who} called ${m ?? "the safe"} on the safe in ${r.id}` : `${who} called ${m ?? "the safe"} on the safe in ${r.id}, and the call failed`;
      break;
    case "drain":
      text = `${who} called ${m ?? "the safe"} in ${r.id} and the safe sent it ${amount} NEAR`;
      break;
    case "reveal":
      text = e.ok ? `${who} showed its sealed plan for ${r.id}` : `${who} tried to show a plan for ${r.id}, and the contract refused it`;
      break;
    case "claim":
      text =
        e.verdict === "paid"
          ? `${who} claimed the bounty of ${r.id} and the judge confirmed it`
          : e.verdict === "waiting"
            ? `${who} claimed the bounty of ${r.id}; the claim is with the judge`
            : `${who} claimed the bounty of ${r.id} and the claim was refused`;
      break;
    case "paid":
      text = `The bounty contract ${r.contract} paid ${who} ${amount} NEAR for ${r.id}`;
      break;
    case "refund":
      text = `The bounty contract ${r.contract} sent the bounty of ${r.id}, ${amount} NEAR, back to ${who}`;
      break;
    default:
      return null;
  }
  const fact = `${text}, at ${when.text}${after ? `, ${after} after the start` : ""}${e.kind === "drain" ? ": the break" : ""}.`;
  return draft({
    kind: e.kind,
    fact,
    data: {
      race: r.id,
      at: when.text,
      date: when.text.slice(0, 10),
      time: when.text.slice(11),
      ...(e.kind === "seal" && e.seq !== undefined ? { seal_number: e.seq } : {}),
      who: e.who && accountOk(e.who.account) ? e.who.account : null,
      who_name: e.who ? shortName(e.who) : null,
      amount_near: amount,
      method: m,
      after_start: after,
      went_through: e.ok,
      ...(e.verdict ? { verdict: e.verdict } : {}),
      transaction: e.tx || null,
    },
    extra: [...when.numbers],
    names: [r.id, r.contract, target, ...namesOf(e.who), ...(e.tx ? [e.tx] : []), ...(m ? m.split(", ") : [])],
    at: e.at,
    tx: e.tx || null,
    href: e.tx ? txUrl(e.tx) : `${SITE}/race/${r.id}`,
    race: r.id,
  });
}

/** The facts of one race: its own fact, then every step, with long runs of moves cut to the first few. */
function raceDrafts(r: Race, target: string, training: boolean, now: number): Draft[] {
  const out = [raceFact(r, target, training, now)];
  for (const e of ownSteps(r)) {
    const d = eventFact(e, r, target);
    if (d) out.push(d);
  }
  return out;
}

function checkSummary(c: CheckResult | null): CheckSummary | null {
  if (!c || !c.block) return null;
  return {
    verdict: c.verdict,
    reasons: c.reasons.map((r) => ({ code: r.code, level: r.level })),
    block: c.block,
    checkedAt: c.checked_at,
  };
}

function codeFromCheck(c: CheckResult | null): string | null {
  const r = c?.reasons.find((x) => x.code === "contract");
  const h = r?.evidence?.["code_hash"];
  return typeof h === "string" ? h : null;
}

function roleOf(races: readonly Race[], training: boolean, view: ArenaView | null, check: CheckSummary | null, code: string | null): Role {
  const noAccount = check?.reasons.some((r) => r.code === "no_account") ?? false;
  if (races.some((r) => r.kind === "safe")) return "safe";
  if (training) return "target";
  // A sandbox race's target that is no account on chain is a sandbox target; one that is an account stays what it is.
  if (races.length && (!check || noAccount)) return "target";
  if (!view && !check) return "unread";
  if (noAccount) return "missing";
  if (code) return "contract";
  if (check) return "account";
  return "unread";
}

/** The drains a mask of the race made on the safe, on chain, confirmed by the judge or not. */
function drainsOf(r: Race): RaceEvent[] {
  return ownSteps(r, Number.POSITIVE_INFINITY).filter((e) => e.kind === "drain");
}

/** The safe gave up NEAR to a mask: it did not hold, whatever the judge said about the bounty. */
const drained = (r: Race) => r.phase === "broken" || drainsOf(r).length > 0;

/** Refunded, and the refund's own transaction was not read: when it went back is not known. */
const refundUnread = (r: Race) => r.state === "refunded" && r.refund?.at == null;

/**
 * The bounty went back before the deadline, with nothing drained: the race never ran its course. With the refund's time
 * unread, a refund already in while the deadline is still ahead is the same.
 */
function calledOff(r: Race, now: number): boolean {
  if (r.state !== "refunded" || drained(r)) return false;
  return r.refund?.at != null ? r.refund.at < r.deadline : now < r.deadline;
}

/** A race still open, or past its deadline with no word from the judge yet: under fire, not held. */
const unsettled = (r: Race) => !drained(r) && !FINAL.has(r.state);

/** What a mask took in a race: the judge's count when it paid, else the drains on chain. */
function takeOf(r: Race): string {
  return r.takes ?? drainsOf(r).reduce((a, e) => a + BigInt(e.amount ?? "0"), 0n).toString();
}

function headlineOf(races: readonly Race[], view: ArenaView | null, now: number): Headline {
  const none = { amount: null, amountIs: null, heldMs: null, masks: 0, races: 0, newest: null, broken: null, live: false, closesAt: null, judging: false, calledOff: 0 } as const;
  if (!view) return { standing: "unknown", ...none };
  const counted = races.filter((r) => !calledOff(r, now));
  const off = races.length - counted.length;
  // Every race called off: no mask got a full race at it, and the page says so rather than "never raced".
  if (!counted.length) return { standing: "untested", ...none, calledOff: off };

  const maskCount = (rs: readonly Race[]) => new Set(rs.flatMap((r) => r.masks.map((m) => m.account))).size;
  const live = counted.some((r) => r.live);
  const broken = counted.filter(drained);
  const running = counted.filter(unsettled);
  const sum = (xs: readonly (string | null)[]) => xs.reduce((a, x) => a + BigInt(x ?? "0"), 0n).toString();
  // Under fire without a break: from each race's start to its end, or to now while it runs.
  const heldOf = (rs: readonly Race[]) =>
    rs
      .filter((r) => !drained(r))
      .reduce((a, r) => {
        const from = r.startsAt ?? r.openedAt;
        if (from === null) return a;
        // A refund whose time was not read adds nothing: how long it held is not known.
        if (refundUnread(r)) return a;
        const end = unsettled(r) ? Math.min(now, r.deadline) : Math.min(r.refund?.at ?? r.deadline, r.deadline);
        return a + Math.max(0, end - from);
      }, 0);
  // Races come newest first: the newest break is the one the page names.
  const last = broken[0];
  const firstDrain = last ? drainsOf(last)[0] : undefined;
  const from = last ? (last.startsAt ?? last.openedAt) : null;
  const breaks = last
    ? {
        race: last.id,
        by: last.winner ?? firstDrain?.who ?? null,
        breakMs: last.breakMs ?? (firstDrain && from !== null ? firstDrain.at - from : null),
        at: last.brokeAt ?? firstDrain?.at ?? null,
        count: broken.length,
        oneWinner: new Set(broken.map((r) => r.winner?.account ?? drainsOf(r)[0]?.who?.account ?? "")).size === 1,
        confirmed: last.phase === "broken" && FINAL.has(last.state),
        // Still with the judge: neither confirmed nor refused yet.
        pending: !FINAL.has(last.state),
      }
    : null;
  const judging = running.some((r) => r.state === "judging" || r.events.some((e) => e.verdict === "waiting"));

  // A race that runs now comes first: the show is on. It holds since the newest break, against the masks since then.
  if (running.length) {
    const since = counted.filter((r) => !last || (r.openedAt ?? 0) > (last.openedAt ?? 0));
    const open = running.filter((r) => now < r.deadline);
    return {
      standing: "under_fire",
      amount: sum(running.map((r) => (now < r.deadline ? r.prize : r.bounty))),
      amountIs: "on_the_line",
      heldMs: heldOf(since),
      masks: maskCount(since),
      races: counted.length,
      newest: counted[0]!.id,
      broken: breaks,
      live,
      closesAt: open.length ? Math.min(...open.map((r) => r.deadline)) : null,
      judging,
      calledOff: off,
    };
  }
  if (breaks) {
    const held = heldOf(counted);
    return { standing: "broken", amount: sum(broken.map(takeOf)), amountIs: "taken", heldMs: held || null, masks: maskCount(counted), races: counted.length, newest: counted[0]!.id, broken: breaks, live, closesAt: null, judging: false, calledOff: off };
  }
  // With a refund's time unread, how long it held is not known: say nothing rather than a minute.
  const heldMs = heldOf(counted);
  return {
    standing: "held",
    amount: sum(counted.map((r) => r.refund?.amount ?? r.bounty)),
    amountIs: "held",
    heldMs: heldMs > 0 || !counted.some(refundUnread) ? heldMs : null,
    masks: maskCount(counted),
    races: counted.length,
    newest: counted[0]!.id,
    broken: null,
    live: false,
    closesAt: null,
    judging: false,
    calledOff: off,
  };
}

/** How one race ended, as the judge and the bounty contract settled it. */
function judgeOf(r: Race, now: number): JudgeResult {
  const done = FINAL.has(r.state);
  const verdict = calledOff(r, now)
    ? "called_off"
    : r.phase === "broken" && done
      ? "broken"
      : done && drained(r)
        ? "unconfirmed"
        : r.phase === "held" && done && !refundUnread(r)
          ? "held"
          : "pending";
  const back = verdict === "held" || verdict === "called_off" || verdict === "unconfirmed";
  const tx = verdict === "broken" ? (r.txs.payout ?? r.txs.drain) : back ? (r.refund?.tx ?? null) : (r.txs.drain ?? null);
  const at = verdict === "broken" ? (r.payout?.at ?? r.brokeAt) : back ? (r.refund?.at ?? null) : null;
  return { race: r.id, contract: r.contract, verdict, state: r.state, winner: r.winner?.account ?? null, tx, judgeCode: r.judge, at };
}

function line(r: Race): RaceLine {
  return {
    id: r.id,
    contract: r.contract,
    kind: r.kind,
    phase: r.phase,
    state: r.state,
    live: r.live,
    team: r.team,
    openedAt: r.openedAt,
    sealUntil: r.sealUntil ?? null,
    startsAt: r.startsAt,
    deadline: r.deadline,
    masks: r.masks,
    winner: r.winner,
    breakMs: r.breakMs,
    prize: r.prize,
    bounty: r.bounty,
    locked: r.locked,
    loot: r.loot,
    takes: r.takes,
    refund: r.refund?.amount ?? null,
    refundAt: r.refund?.at ?? null,
    judge: r.judge,
    runId: r.runId,
    txs: r.txs,
    events: ownSteps(r),
  };
}

/** What the model reads of the facts, and what their hash is taken over. */
export function forModel(evidence: readonly Evidence[]) {
  return evidence.map((e) => ({ id: e.id, kind: e.kind, fact: e.fact, data: e.data }));
}

/** sha256 of every fact whole: what the model read, and the numbers, names and links the checks and the page use. */
export function hashEvidence(evidence: readonly Evidence[]): string {
  const canonical = evidence.map((e) => [e.id, e.kind, e.fact, e.data, e.numbers, e.names, e.at, e.tx, e.href, e.race]);
  return sha256Hex(JSON.stringify(canonical));
}

/** Everything the encyclopedia knows about one account now. */
export function collect(input: CollectInput): Dossier {
  const account = input.account.trim().toLowerCase();
  const view = input.view;
  const network = view?.network ?? NETWORK;
  const list = input.list ?? sharedLists[network];
  const house = input.house ?? HOUSE;
  // Races come newest first, as the arena lists them. Only the arena's own teams' races count; a sandbox race runs on a
  // training target's name, never on an account.
  const teams = new Set(input.teams ?? ARENA_TEAMS);
  const races = view
    ? view.races.filter((r) => r.target.toLowerCase() === account && teams.has(r.team) && (r.kind === "safe" || !account.includes(".")))
    : [];
  const listed = list.arena.filter((e) => e.safe === account);
  // The shared list names the arena's races on its live safes. One the reading does not show means the reading is not
  // whole (another race under the same id hides it): then the page says nothing rather than something false.
  const incomplete = view !== null && listed.some((e) => !races.some((r) => r.id === e.race && r.contract === e.contract));
  // The house's vault runs the library's live safe in every round the house opens on it; only the house's own races
  // make it one, so the name alone says nothing.
  const vault = account === house.vault && races.some((r) => r.kind === "safe" && r.team === house.account);
  const lib = libraryEntry(account) ?? (listed.length ? libraryEntry("live-safe") : vault ? libraryEntry(house.target) : null);
  const check = checkSummary(input.check);
  // The code a race read off the safe is a fact; what MASK CHECK reads now is shown beside the page, never a fact.
  const raceCode = races.find((r) => r.targetCode)?.targetCode ?? null;
  const code = raceCode ?? codeFromCheck(input.check);
  // A training target is one of the library's own, by name: a race anyone opens cannot make a contract one.
  const training = lib !== null && !account.includes(".") && libraryEntry(account) !== null;
  const role = roleOf(races, training, view, check, code);

  // With no reading of the arena, or not a whole one, there is nothing to say: no fact stands without the chain behind it.
  const drafts: Draft[] = [];
  if (view && !incomplete) {
    const n = races.length;
    drafts.push(
      draft({
        kind: "arena",
        fact: `The MASK WARS arena on NEAR ${view.network} runs its races on the bounty contracts ${CONTRACTS.join(" and ")}. ${n} ${n === 1 ? "race targets" : "races target"} ${account}.`,
        data: { network: view.network, bounty_contracts: [...CONTRACTS], races_on_this_account: n },
        names: [...CONTRACTS, account],
        href: `${SITE}/api/races`,
      }),
    );
  }
  if (view && !incomplete && lib && training) {
    drafts.push(
      draft({
        kind: "library",
        fact: `${account} is a training target of the MASK WARS library: ${lib.title}. Its hole is planted on purpose: ${lib.hole}.${lib.level !== null ? ` Library level ${lib.level} of 5.` : ""}`,
        data: { target: account, title: lib.title, planted_hole: lib.hole, level: lib.level, ...(lib.level !== null ? { levels: 5 } : {}) },
        extra: lib.level !== null ? [String(lib.level), "5"] : [],
        names: [account],
      }),
    );
  }
  if (view && !incomplete && lib && listed.length) {
    const e = listed[0]!;
    drafts.push(
      draft({
        kind: "library",
        fact: `The MASK WARS shared list names ${account} as a live safe of the arena for ${e.race} on ${e.contract}: a training target with a planted hole. The hole: ${lib.hole}.`,
        data: { safe: account, race: e.race, bounty_contract: e.contract, planted_hole: lib.hole },
        extra: [],
        names: [account, e.race, e.contract],
        href: `${SITE}/api/check?account=${account}`,
      }),
    );
  }
  if (view && !incomplete && lib && vault && !listed.length) {
    const n = races.filter((r) => r.team === house.account).length;
    drafts.push(
      draft({
        kind: "library",
        // Only what the chain shows: the house opened races on it. No schedule (the house may stop), nothing said of
        // races another team opened on it, and no number in words: a model that quotes the fact must not trip the gate.
        fact: `${account} is the vault of the house ${house.account}, which opened ${n === 1 ? "a race" : "races"} on it: a live safe with a planted hole. The hole: ${lib.hole}.`,
        data: { safe: account, house: house.account, rounds_by_the_house: n, planted_hole: lib.hole },
        extra: [],
        names: [account, house.account],
        href: accountUrl(house.account),
      }),
    );
  }
  if (view && !incomplete && raceCode && role !== "target") {
    drafts.push(
      draft({
        kind: "code",
        fact: `The code on ${account} has the hash ${raceCode}, the hash of its wasm: the contract's fingerprint.`,
        data: { account, code_hash: raceCode },
        names: [account, raceCode],
        href: accountUrl(account),
      }),
    );
  }
  // The newest races are the page: a long history does not grow the prompt without end.
  if (view && !incomplete) for (const r of races.slice(0, RACES_PER_PAGE).reverse()) drafts.push(...raceDrafts(r, account, training, input.now));

  const evidence: Evidence[] = drafts.map((d, i) => {
    // An arena safe is also called by its first label on the page: SAFE-0001.
    const names = [...new Set(d.names.filter(Boolean).flatMap((n) => {
      const first = n.split(".")[0]!;
      return n.includes(".") && /^[a-z]+-\d+$/.test(first) ? [n, first] : [n];
    }))];
    const strings = Object.values(d.data).flatMap((v) => (typeof v === "string" ? [v] : Array.isArray(v) ? v : typeof v === "number" ? [String(v)] : []));
    // Read word by word, the way the gate reads a sentence: what the fact writes is what a sentence may quote.
    const numbers = new Set([...numbersOf(d.fact, names).numbers, ...strings.flatMap((s) => numbersOf(s, names).numbers), ...d.extra.map(normNumber)]);
    return {
      id: `E${i + 1}`,
      kind: d.kind,
      fact: d.fact,
      data: d.data,
      numbers: [...numbers].sort(),
      names,
      at: d.at,
      tx: d.tx,
      href: d.href,
      race: d.race,
    };
  });

  return {
    account,
    network,
    role,
    library: lib,
    headline: headlineOf(races, incomplete ? null : view, input.now),
    incomplete,
    races: races.map(line),
    judge: incomplete || !races[0] ? null : judgeOf(races[0], input.now),
    // Every race: no model reads these, and a partner's market on an old round still finds its answer and proof.
    outcomes: incomplete ? [] : races.map((r) => judgeOf(r, input.now)),
    code,
    check,
    evidence,
    evidenceHash: hashEvidence(evidence),
    readAt: input.now,
  };
}
