/**
 * One race, told once: the facts the clip, the cards and the thread all use, derived from the record and nothing
 * else. If a number is on screen or in a post, it comes from here, so the three can never disagree.
 */

import { SITE } from "../site.ts";
import type { Mask } from "../masks.ts";
import { SEASON_0 } from "../masks.ts";
import { addNear, near } from "./near.ts";
import type { RaceRecord } from "./record.ts";
import { parseRace } from "./record.ts";

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

export type RaceStory = {
  record: RaceRecord;
  /** 3 for race-0003. */
  no: number;
  /** `NEAR testnet` or `NEAR`. */
  chain: string;
  simulated: boolean;
  winner: StoryMask;
  /** Everyone else in the race, in the order they entered. */
  rivals: StoryMask[];
  masks: StoryMask[];
  breach: {
    attempt: number;
    firstTry: boolean;
    /** `first try`, `third try`, `try 12`. */
    tryWords: string;
    ms: number;
    /** `01:04`: the race clock. */
    clock: string;
    /** `1 min 4 s`. */
    words: string;
    /** The time as one number and its unit, for a scoreboard: `64` SECONDS, or `41` MINUTES past two minutes. */
    short: { n: string; unit: "SECONDS" | "MINUTES" };
  };
  bounty: string;
  hours: number;
  drained: string;
  paid: string;
  /** What the winner took in all: the drain and the bounty paid on top. */
  total: string;
  judge: { seconds: string; cost: string };
  links: { drain: string; payout: string; run: string };
  /** `Nov 6`. */
  day: string;
};

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

/** `1.1`, `12`, `0.4`: one decimal under ten seconds, whole seconds above. Never an exponent. */
export const secondsText = (x: number): string => (x >= 10 ? Math.round(x).toFixed(0) : Math.max(0.1, Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, ""));

function storyMask(r: RaceRecord, name: string): StoryMask {
  const m = SEASON_0.find((x) => x.name === name)!;
  const model = r.masks.find((x) => x.name === name)?.model;
  return { ...m, model: model ? modelName(model) : null };
}

/** Accepts the raw JSON too: a record that does not read cleanly gives an error, never a guess. */
export function raceStory(input: unknown): RaceStory {
  const r = parseRace(input);
  const hit = r.sandbox.board.find((b) => b.verdict === "breach")!;
  const masks = r.masks.map((m) => storyMask(r, m.name));
  const sweep = r.drain.txs[r.drain.txs.length - 1]!;
  return {
    record: r,
    no: Number(r.id.slice(5)),
    chain: r.network === "testnet" ? "NEAR testnet" : "NEAR",
    simulated: r.source === "SIMULATED",
    winner: storyMask(r, r.winner),
    rivals: masks.filter((m) => m.name !== r.winner),
    masks,
    breach: {
      attempt: hit.attempt,
      firstTry: hit.attempt === 1,
      tryWords: hit.attempt <= ORDINAL.length ? `${ORDINAL[hit.attempt - 1]} try` : `try ${hit.attempt}`,
      ms: hit.atMs,
      clock: clock(hit.atMs),
      words: words(hit.atMs),
      short: hit.atMs < 120_000 ? { n: String(Math.floor(hit.atMs / 1000)), unit: "SECONDS" } : { n: String(Math.floor(hit.atMs / 60_000)), unit: "MINUTES" },
    },
    bounty: near(r.bounty),
    hours: r.hours,
    drained: near(r.drain.amount),
    paid: near(r.payout.amount),
    total: addNear(r.drain.amount, r.payout.amount),
    judge: { seconds: secondsText(r.judge.seconds), cost: near(r.judge.cost) },
    links: {
      drain: explorer(r.network, sweep.hash),
      payout: explorer(r.network, r.payout.tx),
      run: `https://github.com/${r.sandbox.repo}/actions/runs/${r.sandbox.run}`,
    },
    day: new Date(r.drain.at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
  };
}

/** `ONYX, NOVA and ORACLE`. */
export function listNames(ms: readonly { name: string }[]): string {
  const n = ms.map((m) => m.name);
  return n.length <= 1 ? (n[0] ?? "") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}
