/**
 * One race, told once: the facts the clip, the cards and the thread all use, derived from the record and nothing
 * else. If a number is on screen or in a post, it comes from here, so the three can never disagree.
 *
 * A race written by hand (`kind: "race"`) is told by its sandbox board. A sealed round (`kind: "round"`) is told by
 * its own steps on chain and by nothing else: the vault opens, a mask seals its plan, the window closes, the plan is
 * played, revealed and claimed, the judge confirms, the contract pays. A season treasury opens such a round on
 * schedule (`SEASON 1 · ROUND 1`), or the team opens it by hand (`RACE 5`): the story says which, by the record.
 */

import { SITE } from "../site.ts";
import type { Mask } from "../masks.ts";
import { SEASON_0 } from "../masks.ts";
import { addNear, nearShort } from "./near.ts";
import type { HandRace, RaceRecord, SealedRound } from "./record.ts";
import { EXAMPLE_ID, isSealedRound, parseRace, roundOf } from "./record.ts";

export { SITE };

/** How a model id reads in a post. Unknown ids read as their last segment. */
const MODEL_NAMES: Record<string, string> = {
  "z-ai/glm-5.3-flash": "GLM 5.3 Flash",
  "deepseek-ai/DeepSeek-V4.1-Flash-1017": "DeepSeek V4.1 Flash",
  "Qwen/Qwen3.8-27B": "Qwen3.8 27B",
};
export const modelName = (id: string): string => MODEL_NAMES[id] ?? id.split("/").pop()!;

const ORDINAL = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

export type StoryMask = Mask & { model: string | null };

/** A stretch of time, in the forms the machine shows it. */
export type Lapse = {
  ms: number;
  /** `01:04`: a clock. */
  clock: string;
  /** `1 min 4 s`. */
  words: string;
  /** One number and its unit, for a scoreboard: `64` SECONDS, or `41` MINUTES past two minutes. */
  short: { n: string; unit: "SECONDS" | "MINUTES" };
};

/** The break of the copy in the sandbox, off its public board. */
export type Breach = Lapse & {
  attempt: number;
  firstTry: boolean;
  /** `first try`, `third try`, `try 12`. */
  tryWords: string;
};

type Told = {
  /** 3 for race-0003; the round's number for a season round. */
  no: number;
  /** `RACE 3`, `SEASON 1 · ROUND 1`, `EXAMPLE ROUND`: the line over every card and scene. */
  title: string;
  /** The title and the network: `RACE 3 · NEAR TESTNET`, `SEASON 1 · ROUND 1 · TESTNET`. */
  kicker: string;
  /** In a sentence: `race 3`, `round 1`, `the example round`. */
  name: string;
  /** As a heading: `Race 3`, `Season 1 · Round 1`, `Example round`. */
  heading: string;
  /** `NEAR testnet` or `NEAR`. */
  chain: string;
  simulated: boolean;
  winner: StoryMask;
  /** The other masks the record names, in its order. */
  rivals: StoryMask[];
  /** The masks the record names: a sealed round names only those with a move of their own on chain. */
  masks: StoryMask[];
  bounty: string;
  hours: number;
  drained: string;
  /** A link to every transaction that moved the drained NEAR: together they moved exactly `drained`. */
  drainLinks: string[];
  paid: string;
  /** What the winner took in all: the drain and the bounty paid on top. */
  total: string;
  judge: { seconds: string; cost: string };
  /** `Nov 6`. */
  day: string;
};

export type HandStory = Told & {
  kind: "race";
  record: HandRace;
  breach: Breach;
  links: { drain: string; payout: string; run: string };
};

export type RoundStory = Told & {
  kind: "round";
  record: SealedRound;
  /** Who opened it: a season treasury on its schedule, or the team by hand. */
  opener: "season" | "hand";
  /** The season and the round a season round's id gives; null for a round opened by hand and for an example. */
  season: number | null;
  round: number | null;
  /** At the start of a sentence: `Season 1, round 1`, `Race 5`, `An example round`. */
  where: string;
  /** NEAR put into the vault for the round. Shown for a season's vault only: one made by hand pays for its own code out of it. */
  safe: string;
  /** Minutes the masks had to seal a plan. */
  sealMinutes: number;
  /** How many masks sealed a plan, and the winner's place among them: 1 is the earliest seal. */
  seals: number;
  sealPlace: number;
  /** From the round's opening to the winner's seal. */
  sealed: Lapse;
  /** From the window's close to the drain. */
  played: Lapse;
  /** The break of the copy, when the record carries the sandbox board. */
  breach: Breach | null;
  /** `seal` is null when the indexer did not show the winner's `commit` transaction. */
  links: { open: string; seal: string | null; drain: string; reveal: string; claim: string; payout: string; run: string | null };
};

export type RaceStory = HandStory | RoundStory;

export function explorer(network: RaceRecord["network"], hash: string): string {
  return `https://${network === "testnet" ? "testnet." : ""}nearblocks.io/txns/${hash}`;
}

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function words(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  if (m > 0) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  return s > 0 ? `${s} s` : "under a second";
}

function span(ms: number): Lapse {
  return {
    ms,
    clock: clock(ms),
    words: words(ms),
    short: ms < 120_000 ? { n: String(Math.floor(ms / 1000)), unit: "SECONDS" } : { n: String(Math.floor(ms / 60_000)), unit: "MINUTES" },
  };
}

/** `1.1`, `12`, `0.4`: one decimal under ten seconds, whole seconds above. Never an exponent. */
export const secondsText = (x: number): string => (x >= 10 ? Math.round(x).toFixed(0) : Math.max(0.1, Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, ""));

function storyMask(r: RaceRecord, name: string): StoryMask {
  const m = SEASON_0.find((x) => x.name === name)!;
  const model = r.masks.find((x) => x.name === name)?.model;
  return { ...m, model: model ? modelName(model) : null };
}

function breachOf(board: NonNullable<RaceRecord["sandbox"]>["board"]): Breach {
  const hit = board.find((b) => b.verdict === "breach")!;
  return {
    ...span(hit.atMs),
    attempt: hit.attempt,
    firstTry: hit.attempt === 1,
    tryWords: hit.attempt <= ORDINAL.length ? `${ORDINAL[hit.attempt - 1]} try` : `try ${hit.attempt}`,
  };
}

const runUrl = (s: NonNullable<RaceRecord["sandbox"]>): string => `https://github.com/${s.repo}/actions/runs/${s.run}`;

/** Accepts the raw JSON too: a record that does not read cleanly gives an error, never a guess. */
export function raceStory(input: unknown): RaceStory {
  const r = parseRace(input);
  const masks = r.masks.map((m) => storyMask(r, m.name));
  const sweep = r.drain.txs[r.drain.txs.length - 1]!;
  // The transactions that moved the NEAR, each named with its amount; a record without amounts has the last one.
  const moved = r.drain.txs.filter((t) => t.amount !== undefined);
  const chain = r.network === "testnet" ? "NEAR testnet" : "NEAR";
  const link = (hash: string) => explorer(r.network, hash);
  const told = {
    chain,
    simulated: r.source === "SIMULATED",
    winner: storyMask(r, r.winner),
    rivals: masks.filter((m) => m.name !== r.winner),
    masks,
    bounty: nearShort(r.bounty),
    hours: r.hours,
    drained: nearShort(r.drain.amount),
    drainLinks: (moved.length ? moved : [sweep]).map((t) => link(t.hash)),
    paid: nearShort(r.payout.amount),
    total: nearShort(addNear(r.drain.amount, r.payout.amount)),
    judge: { seconds: secondsText(r.judge.seconds), cost: nearShort(r.judge.cost) },
    day: new Date(r.drain.at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
  };

  if (!isSealedRound(r)) {
    const no = Number(r.id.slice(5));
    return {
      ...told,
      kind: "race",
      record: r,
      no,
      title: `RACE ${no}`,
      kicker: `RACE ${no} · ${chain.toUpperCase()}`,
      name: `race ${no}`,
      heading: `Race ${no}`,
      breach: breachOf(r.sandbox.board),
      links: { drain: link(sweep.hash), payout: link(r.payout.tx), run: runUrl(r.sandbox) },
    };
  }

  // What the round is called comes from its id alone: a season round by its season and number, a round opened by
  // hand by its race number, a made-up one as an example. A hand round never carries a season's round number.
  const of = roundOf(r.id);
  const no = of ? of.round : EXAMPLE_ID.test(r.id) ? 0 : Number(r.id.slice(5));
  const called = of
    ? { title: `SEASON ${of.season} · ROUND ${of.round}`, name: `round ${of.round}`, heading: `Season ${of.season} · Round ${of.round}`, where: `Season ${of.season}, round ${of.round}` }
    : EXAMPLE_ID.test(r.id)
      ? { title: "EXAMPLE ROUND", name: "the example round", heading: "Example round", where: "An example round" }
      : { title: `RACE ${no}`, name: `race ${no}`, heading: `Race ${no}`, where: `Race ${no}` };
  const s = r.sealed;
  const seal = s.seals.find((x) => x.mask === r.winner)!;
  return {
    ...told,
    kind: "round",
    record: r,
    opener: r.season ? "season" : "hand",
    no,
    season: of?.season ?? null,
    round: of?.round ?? null,
    ...called,
    // The amount under this line already says NEAR, so the network takes one word.
    kicker: `${called.title} · ${r.network === "testnet" ? "TESTNET" : "NEAR"}`,
    safe: nearShort(r.safe),
    sealMinutes: s.minutes,
    seals: s.seals.length,
    sealPlace: s.seals.indexOf(seal) + 1,
    sealed: span(Date.parse(seal.at) - Date.parse(r.opened.at)),
    played: span(Date.parse(r.drain.at) - Date.parse(s.closedAt)),
    breach: r.sandbox ? breachOf(r.sandbox.board) : null,
    links: {
      open: link(r.opened.tx),
      seal: seal.tx ? link(seal.tx) : null,
      drain: link(sweep.hash),
      reveal: link(s.reveal.tx),
      claim: link(s.claim.tx),
      payout: link(r.payout.tx),
      run: r.sandbox ? runUrl(r.sandbox) : null,
    },
  };
}

/** `ONYX, NOVA and ORACLE`. */
export function listNames(ms: readonly { name: string }[]): string {
  const n = ms.map((m) => m.name);
  return n.length <= 1 ? (n[0] ?? "") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}

/** `Nov 11`, in UTC. */
export const dayOf = (iso: string): string => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
/** `18:00`, in UTC. */
export const timeOf = (iso: string): string => new Date(iso).toISOString().slice(11, 16);
