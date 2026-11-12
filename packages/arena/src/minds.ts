// What a mask's mind cost in a race, and what it earned for it. The race job (packages/race/scripts/race.ts) writes one
// record per race: for every mask, the answers NEAR AI Cloud gave its mind in that race and their price, from NEAR AI's
// own bill for each answer (`POST /v1/billing/costs` by the answer's `inference-id`), and the NEAR price at the race
// from NEAR Intents (1Click). The site keeps the records and shows the price of a mask's thinking beside what it took:
// one number, and the × of the two.
//
// The record says how each mind was priced (`priceState`): every answer on NEAR AI's bill; some answers the bill had
// not priced yet, counted from their tokens at NEAR AI's list price (`≈`); or calls that brought nothing back, which
// NEAR AI may still bill and the price leaves out (`≥`). Only a price wholly from the bill carries a ×. A race without
// a record shows no price and no ×.

import type { MaskStats, Race } from "./types.ts";

/** One mask's mind in one race. */
export interface MindSpend {
  /** The mask's account: `nova.maskwars.near`, or a person's mask from the factory. */
  readonly account: string;
  /** Its name on the board: `NOVA`, `KIRA`. */
  readonly name: string;
  /** The model that answered, as NEAR AI names it. */
  readonly model: string;
  /** Answers NEAR AI gave this mind in the race. */
  readonly answers: number;
  /** Of them, the answers NEAR AI's bill priced one by one; the rest are priced from their tokens at NEAR AI's list price. */
  readonly billed: number;
  /**
   * Calls that brought nothing back to count (out of time, refused, unreachable), the bill included: NEAR AI may well
   * bill a call that ran out of time, and the price leaves it out.
   */
  readonly unanswered: number;
  /**
   * Of the answers, those whose TEE signature was checked against the model's attestation, made with a fresh nonce when
   * the race began. Absent in a record from before the check.
   */
  readonly verified?: number;
  readonly tokens: { readonly prompt: number; readonly completion: number; readonly cached: number };
  /** What the answers cost, in dollars. */
  readonly usd: number;
}

/**
 * How a mind's price stands. `billed`: every answer on NEAR AI's bill and no call lost. `listed`: some answers the bill
 * had not priced, counted from their tokens at the list price. `partial`: calls that brought nothing back, so the real
 * price is higher.
 */
export type PriceState = "billed" | "listed" | "partial";

export function priceState(m: Pick<MindSpend, "answers" | "billed" | "unanswered">): PriceState {
  if (m.unanswered > 0) return "partial";
  return m.billed < m.answers ? "listed" : "billed";
}

/** `$0.0085`, `≈$0.0085` for a price partly from tokens, `≥$0.0085` for one that leaves calls out. */
export function priceText(usd: number, state: PriceState): string {
  return `${state === "partial" ? "≥" : state === "listed" ? "≈" : ""}${usdText(usd)}`;
}

/** The worse of two price states: one mind's part that is not from the bill makes the sum not from the bill. */
const worse = (a: PriceState, b: PriceState): PriceState => (a === "partial" || b === "partial" ? "partial" : a === "listed" || b === "listed" ? "listed" : "billed");

export interface MindRecord {
  readonly v: 1;
  readonly network: "mainnet" | "testnet";
  /** The race: its bounty id on the bounty contract, `race-0003`. */
  readonly race: string;
  /** When the race job wrote it, ms since the epoch. */
  readonly at: number;
  /** NEAR's price when the race ran, from 1Click's token list; null when 1Click did not answer. */
  readonly near: { readonly usd: number; readonly at: string | null } | null;
  readonly masks: readonly MindSpend[];
  /** The workflow run that raced it, added by whoever kept the record: where anyone can read the race's own log. */
  readonly run?: string;
}

const YOCTO = 10n ** 24n;
const MAX_USD = 1_000;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const isCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const isUsd = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n < MAX_USD;

/** A record as the race job wrote it, or null when anything in it is not what a record holds. */
export function parseMindRecord(raw: unknown): MindRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || (r.network !== "mainnet" && r.network !== "testnet")) return null;
  if (typeof r.race !== "string" || !ID.test(r.race) || !isCount(r.at)) return null;
  let near: MindRecord["near"] = null;
  if (r.near !== null) {
    const n = r.near as Record<string, unknown> | undefined;
    if (!n || typeof n !== "object" || !(typeof n.usd === "number" && n.usd > 0 && n.usd < 100_000)) return null;
    if (n.at !== null && typeof n.at !== "string") return null;
    near = { usd: n.usd, at: (n.at as string | null) ?? null };
  }
  if (!Array.isArray(r.masks) || r.masks.length > 64) return null;
  const masks: MindSpend[] = [];
  for (const m of r.masks as unknown[]) {
    const x = m as Record<string, unknown> | null;
    if (!x || typeof x !== "object") return null;
    const t = x.tokens as Record<string, unknown> | undefined;
    if (typeof x.account !== "string" || x.account.length > 64 || !ACCOUNT.test(x.account)) return null;
    if (typeof x.name !== "string" || !/^[A-Z0-9]{1,16}$/.test(x.name)) return null;
    if (typeof x.model !== "string" || x.model.length > 128) return null;
    if (!isCount(x.answers) || !isCount(x.billed) || x.billed > x.answers || !isCount(x.unanswered) || !isUsd(x.usd)) return null;
    if (x.verified !== undefined && (!isCount(x.verified) || x.verified > x.answers)) return null;
    if (!t || !isCount(t.prompt) || !isCount(t.completion) || !isCount(t.cached) || t.cached > t.prompt) return null;
    if (masks.some((y) => y.account === x.account)) return null;
    masks.push({
      account: x.account,
      name: x.name,
      model: x.model,
      answers: x.answers,
      billed: x.billed,
      unanswered: x.unanswered,
      ...(x.verified !== undefined ? { verified: x.verified as number } : {}),
      tokens: { prompt: t.prompt, completion: t.completion, cached: t.cached },
      usd: x.usd,
    });
  }
  if (r.run !== undefined && (typeof r.run !== "string" || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(r.run))) return null;
  return { v: 1, network: r.network, race: r.race, at: r.at, near, masks, ...(typeof r.run === "string" ? { run: r.run } : {}) };
}

/**
 * One round's records from several runs into one: a run that came after the one that opened the round races it again
 * while it still seals, and its minds' answers are paid for all the same. Per mask the answers, tokens and dollars add
 * up; NEAR's price and the run are the first run's. Records of other rounds or networks are left out.
 */
export function mergeRecords(records: readonly MindRecord[]): MindRecord | null {
  const [first, ...rest] = [...records].sort((a, b) => a.at - b.at);
  if (!first) return null;
  const masks = new Map(first.masks.map((m) => [m.account, { ...m, tokens: { ...m.tokens } }]));
  for (const r of rest) {
    if (r.race !== first.race || r.network !== first.network) continue;
    for (const m of r.masks) {
      const had = masks.get(m.account);
      if (!had) {
        masks.set(m.account, { ...m, tokens: { ...m.tokens } });
        continue;
      }
      // An answer of a run from before the check counts as not verified.
      const verified = had.verified !== undefined || m.verified !== undefined ? { verified: (had.verified ?? 0) + (m.verified ?? 0) } : {};
      masks.set(m.account, {
        ...had,
        model: had.model === m.model ? had.model : `${had.model}, ${m.model}`.slice(0, 128),
        answers: had.answers + m.answers,
        billed: had.billed + m.billed,
        unanswered: had.unanswered + m.unanswered,
        ...verified,
        tokens: { prompt: had.tokens.prompt + m.tokens.prompt, completion: had.tokens.completion + m.tokens.completion, cached: had.tokens.cached + m.tokens.cached },
        usd: had.usd + m.usd,
      });
    }
  }
  return { ...first, near: first.near ?? rest.find((r) => r.near)?.near ?? null, masks: [...masks.values()] };
}

/** Dollars from yoctoNEAR at `usd` a NEAR. */
export function nearToUsd(yocto: string | bigint, usd: number): number {
  const y = typeof yocto === "bigint" ? yocto : BigInt(yocto);
  if (y <= 0n || !(usd > 0)) return 0;
  // Whole micro-NEAR are plenty for a price in dollars, and stay exact in a double.
  return (Number(y / 10n ** 18n) / 1e6) * usd;
}

/** Earned ÷ spent, or null when either side is not known or nothing was spent. */
export function timesOf(earnedUsd: number | null, spentUsd: number): number | null {
  if (earnedUsd === null || !(spentUsd > 0)) return null;
  return earnedUsd / spentUsd;
}

/** The counts that say how a price was found, added up over several minds. */
export interface PriceCounts {
  readonly answers: number;
  readonly billed: number;
  readonly unanswered: number;
  /** Answers whose TEE signature was checked; null when no record of them says (from before the check). */
  readonly verified: number | null;
}

const countsOf = (spends: readonly MindSpend[]): PriceCounts => {
  const known = spends.filter((m) => m.verified !== undefined);
  return {
    answers: spends.reduce((a, m) => a + m.answers, 0),
    billed: spends.reduce((a, m) => a + m.billed, 0),
    unanswered: spends.reduce((a, m) => a + m.unanswered, 0),
    verified: known.length > 0 ? known.reduce((a, m) => a + (m.verified ?? 0), 0) : null,
  };
};

/** What the minds cost in one race, and the winner's × on its own mind. */
export interface RaceThought {
  readonly record: MindRecord;
  /** All the race's minds together, and how that sum was priced. */
  readonly usd: number;
  readonly answers: number;
  readonly state: PriceState;
  readonly counts: PriceCounts;
  /**
   * The winner's own mind and its ×: what it took, in dollars at the race's NEAR price, over what its mind cost. The ×
   * only when that cost is wholly NEAR AI's bill (`state` billed): otherwise it is null.
   */
  readonly winner: { readonly spend: MindSpend; readonly state: PriceState; readonly earnedUsd: number | null; readonly x: number | null } | null;
}

export function raceThought(race: Pick<Race, "id" | "winner" | "takes" | "phase">, record: MindRecord | null | undefined): RaceThought | null {
  if (!record || record.race !== race.id || record.masks.length === 0) return null;
  const usd = record.masks.reduce((a, m) => a + m.usd, 0);
  const counts = countsOf(record.masks);
  const spend = race.phase === "broken" && race.winner ? (record.masks.find((m) => m.account === race.winner!.account) ?? null) : null;
  let winner: RaceThought["winner"] = null;
  if (spend) {
    const earnedUsd = record.near && race.takes ? nearToUsd(race.takes, record.near.usd) : null;
    const state = priceState(spend);
    winner = { spend, state, earnedUsd, x: state === "billed" ? timesOf(earnedUsd, spend.usd) : null };
  }
  return { record, usd, answers: counts.answers, state: priceState(counts), counts, winner };
}

/** A mask's mind over every race it ran that has a record: the season. */
export interface SeasonThought {
  readonly usd: number;
  readonly answers: number;
  /** How the season's sum was priced: the worst of its races. */
  readonly state: PriceState;
  readonly counts: PriceCounts;
  /** Races with a record, of `stats.races`. */
  readonly races: number;
  /** What it took in those races, in NEAR and in dollars at each race's own price. */
  readonly earned: string;
  readonly earnedUsd: number | null;
  /** Only when every race's price is wholly NEAR AI's bill. */
  readonly x: number | null;
  /** The models its mind ran on, newest first. */
  readonly models: readonly string[];
}

export function seasonThought(stats: Pick<MaskStats, "who" | "history">, records: ReadonlyMap<string, MindRecord>): SeasonThought | null {
  let usd = 0;
  let races = 0;
  let earned = 0n;
  let earnedUsd: number | null = 0;
  let state: PriceState = "billed";
  const spends: MindSpend[] = [];
  const models: string[] = [];
  for (const h of stats.history) {
    const rec = records.get(h.id);
    const spend = rec?.masks.find((m) => m.account === stats.who.account);
    if (!rec || !spend) continue;
    races += 1;
    usd += spend.usd;
    spends.push(spend);
    state = worse(state, priceState(spend));
    if (!models.includes(spend.model)) models.push(spend.model);
    if (h.won && h.takes) {
      earned += BigInt(h.takes);
      earnedUsd = rec.near && earnedUsd !== null ? earnedUsd + nearToUsd(h.takes, rec.near.usd) : null;
    }
  }
  if (races === 0) return null;
  const counts = countsOf(spends);
  const x = state === "billed" ? timesOf(earnedUsd, usd) : null;
  return { usd, answers: counts.answers, state, counts, races, earned: earned.toString(), earnedUsd, x, models };
}

/**
 * How a price was found, in a line, from its counts: `NEAR AI's bill for each answer`; `NEAR AI's bill for 3 of 4
 * answers, 1 from its tokens at NEAR AI's list price`; and calls that brought nothing back, which the price leaves out.
 */
export function pricedByText(c: Pick<PriceCounts, "answers" | "billed" | "unanswered">): string {
  const n = (k: number, one: string, many: string) => `${k.toLocaleString("en-US")} ${k === 1 ? one : many}`;
  const parts: string[] = [];
  if (c.answers > 0) {
    if (c.billed === c.answers) parts.push(c.answers === 1 ? "NEAR AI's bill for the answer" : "NEAR AI's bill for each answer");
    else if (c.billed === 0) parts.push(`${n(c.answers, "answer", "answers")} from tokens at NEAR AI's list price`);
    else parts.push(`NEAR AI's bill for ${c.billed} of ${n(c.answers, "answer", "answers")}, ${c.answers - c.billed} from tokens at NEAR AI's list price`);
  }
  if (c.unanswered > 0) parts.push(`${n(c.unanswered, "call", "calls")} with nothing back, not in the price`);
  return parts.length > 0 ? parts.join("; ") : "No answers";
}

/** `$0.019`: four decimals below a cent, three below a dollar, two above. Never rounded up. */
export function usdText(usd: number): string {
  if (!(usd > 0)) return "$0";
  const decimals = usd < 0.01 ? 4 : usd < 1 ? 3 : 2;
  const scale = 10 ** decimals;
  const cut = Math.floor(usd * scale + 1e-9) / scale;
  if (cut === 0) return `<$${(1 / scale).toFixed(decimals)}`;
  const [int, dec = ""] = cut.toFixed(decimals).split(".");
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const trimmed = decimals > 2 ? dec.replace(/0+$/, "").padEnd(2, "0") : dec;
  return `$${grouped}.${trimmed}`;
}

/** `×65`, `×1,240`, `×3.4`, `×0.42`. Never rounded up. */
export function timesText(x: number | null): string {
  if (x === null || !Number.isFinite(x) || x < 0) return "×—";
  if (x >= 10) return `×${Math.floor(x).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
  if (x >= 1) return `×${(Math.floor(x * 10) / 10).toString()}`;
  return `×${(Math.floor(x * 100) / 100).toString()}`;
}

/** NEAR in yocto for `n` whole NEAR: for tests and fixtures. */
export const yoctoOf = (n: number): string => (BigInt(Math.round(n * 1e6)) * (YOCTO / 1_000_000n)).toString();
