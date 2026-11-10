/**
 * The public board of a race: who tried, which attempt, when, and whether it broke through. Never the plan, never the
 * step details: the finding belongs to the team that owns the code.
 */
import type { Verdict } from "./outcome.ts";

export interface JournalEntry {
  readonly attacker: string;
  readonly attempt: number;
  /** `breach` only after the plan broke the vault again in a second clean sandbox. */
  readonly verdict: Verdict;
  /** Milliseconds since the race started. */
  readonly atMs: number;
}

export type Lang = "uk" | "en";

const WORDS = {
  uk: { attempt: "спроба", breach: "злам за", h: "год", m: "хв", s: "с" },
  en: { attempt: "attempt", breach: "breach in", h: "h", m: "m", s: "s" },
} as const;

/** `спроба 4: ×` or `спроба 5: злам за 3 хв 12 с`. */
export function formatEntry(entry: JournalEntry, lang: Lang = "uk"): string {
  const w = WORDS[lang];
  const mark = entry.verdict === "breach" ? `${w.breach} ${duration(entry.atMs, lang)}` : "×";
  return `${w.attempt} ${entry.attempt}: ${mark}`;
}

/** One line per attacker: `ONYX  спроба 1: ×, спроба 2: злам за 41 с`. */
export function formatJournal(entries: readonly JournalEntry[], lang: Lang = "uk"): string[] {
  const byAttacker = new Map<string, JournalEntry[]>();
  for (const e of entries) byAttacker.set(e.attacker, [...(byAttacker.get(e.attacker) ?? []), e]);
  return [...byAttacker].map(([who, list]) => `${who}  ${list.map((e) => formatEntry(e, lang)).join(", ")}`);
}

export function duration(ms: number, lang: Lang = "uk"): string {
  const w = WORDS[lang];
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const join = lang === "uk" ? (n: number, u: string) => `${n} ${u}` : (n: number, u: string) => `${n}${u}`;
  if (h > 0) return `${join(h, w.h)} ${join(m, w.m)}`;
  if (m > 0) return `${join(m, w.m)} ${join(s, w.s)}`;
  return join(s, w.s);
}
