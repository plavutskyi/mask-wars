// The numbers of a sentence. The cited facts' names (accounts, races, hashes) are set aside first; then every run of
// digits left is a number, and it must be a number a cited fact writes. A run glued to a letter (`x2`, `1k`, `2NEAR`)
// is no number, a time or a date is never an amount, and a count is never a length of time in words. The facts' own
// numbers and amounts are read the same way, so what a fact writes is exactly what a sentence may quote.

import { normNumber, withoutNames } from "./numbers.ts";

export interface Found {
  /** Normalised: `1.086`, `8:13`, `2026-11-06`, `3`. */
  readonly n: string;
  /** Glued to a letter or a sign: not a number a page may write. */
  readonly glued: boolean;
  /** A time, a duration or a date: `8:13`, `18:34:44`, `2026-11-06`. */
  readonly clock: boolean;
  /** `race 2`, `safe no. 2`, `race #2`: the number is a race's or a safe's name. */
  readonly numbered: "race" | "safe" | null;
  /** An amount of NEAR. */
  readonly amount: boolean;
  /** Written as a length of time in words: `3 minutes`, `2 full days`, `a 2-minute run`. */
  readonly span: boolean;
  /**
   * What a count may count: the words after it or the label before it, as stems (`masks` → `mask`); empty for anything
   * but a plain count.
   */
  readonly counts: readonly string[];
  /** What an amount or a time is for, read from the words around it: `lock`, `pay`, `take`, `fund`, `back` for an amount; `open`, `deadline`, `fund`, `move`, `drain`, `claim`, `paid`, `refund` for a time. */
  readonly role: string | null;
}

/** Words after a number that say nothing about what it counts. */
const NOT_NOUN = new Set(["of", "in", "on", "at", "and", "or", "to", "the", "a", "an", "after", "before", "from", "for", "by", "with", "utc", "is", "was", "were", "are", "near"]);

/** `masks` → `mask`, `races` → `race`, `moves` → `move`: what a count counts, whatever its number. */
export const stem = (w: string) => w.toLowerCase().replace(/(?<=[a-z]{2}[^s])s$/, "");

/** Words that say what an amount of NEAR is for. Read after the amount first (`… back`, `… from the bounty`), then before it. */
const AMOUNT_AFTER: readonly [RegExp, string][] = [
  [/^[^.;!?\d]{0,24}?\bback\b/i, "back"],
  [/^\s*nears?\s+from\s+the\s+bounty\b/i, "pay"],
  [/^\s*nears?\s+(?:in\s+all|in\s+total|out\s+of|from\s+the\s+safe)\b/i, "take"],
];
const AMOUNT_BEFORE: readonly [RegExp, string][] = [
  [/\b(lock(?:ed|s|ing)?)\b/gi, "lock"],
  [/\b(paid|pays?|paying|payout)\b/gi, "pay"],
  [/\b(took|takes?|taking|drain(?:ed|s|ing)?|swe(?:pt|eps?)|won|wins?|broke|stole|grabbed|pulled)\b/gi, "take"],
  [/\b(put|puts|load(?:ed|s)?|fund(?:ed|s)?|deposit(?:ed|s)?)\b/gi, "fund"],
  [/\b(back|refund(?:ed|s)?|return(?:ed|s)?)\b/gi, "back"],
];
/** Words that say what moment a time is. Read before the time first, then after it. */
const TIME_WORDS: readonly [RegExp, string][] = [
  [/\bdeadline\b/gi, "deadline"],
  [/\b(open(?:ed|s)?|lock(?:ed|s)?)\b/gi, "open"],
  [/\b(put|puts|load(?:ed|s)?|fund(?:ed|s)?)\b/gi, "fund"],
  [/\b(set_owner|took\s+(?:the\s+safe\s+)?over|moves?|moved)\b/gi, "move"],
  [/\b(drain(?:ed|s|ing)?|swe(?:pt|eps?)|broke|breaks?|the\s+break)\b/gi, "drain"],
  [/\b(claim(?:ed|s)?|confirm(?:ed|s)?|refused|judge)\b/gi, "claim"],
  [/\b(paid|pays?|payout)\b/gi, "paid"],
  [/\b(back|refund(?:ed|s)?|return(?:ed|s)?)\b/gi, "refund"],
];

/** The role word nearest to a number: the last one before it in its clause, else the first after it. */
function nearestRole(words: readonly [RegExp, string][], before: string, after: string): string | null {
  const clause = before.slice(Math.max(before.lastIndexOf("."), before.lastIndexOf(";"), before.lastIndexOf("!"), before.lastIndexOf("?")) + 1);
  let best: { at: number; role: string } | null = null;
  for (const [re, role] of words) for (const m of clause.matchAll(re)) if (!best || m.index + m[0].length > best.at) best = { at: m.index + m[0].length, role };
  if (best) return best.role;
  const ahead = after.slice(0, Math.max(0, after.search(/[.;!?]|$/)));
  let first: { at: number; role: string } | null = null;
  for (const [re, role] of words) for (const m of ahead.matchAll(re)) if (!first || m.index < first.at) first = { at: m.index, role };
  return first?.role ?? null;
}

function roleOf(f: { amount: boolean; clock: boolean }, before: string, after: string): string | null {
  if (f.amount) {
    for (const [re, role] of AMOUNT_AFTER) if (re.test(after)) return role;
    return nearestRole(AMOUNT_BEFORE, before, "");
  }
  return f.clock ? nearestRole(TIME_WORDS, before, after) : null;
}

/** NEAR the network, not NEAR the unit: `on NEAR testnet`; but `NEAR testnet tokens` are NEAR. */
const NETWORK = /^\s*(testnet|mainnet|ai|intents|cloud|protocol|chain|blockchain|network|ecosystem|foundation)\b(?!\s+(tokens?|coins?)\b)/i;
const RUN = /(?:(?<![\p{L}\p{N}])[-−–](?=\d))?\d+(?:[.,:-]\d+)*/gu;
const MARK = "§";

/** NEAR a few words away inside the same clause, and not the unit of another number. */
function nearBefore(before: string): boolean {
  if (/\bnears?\s*[:=]?\s*$/i.test(before) && !/\d[\d.,]*\s*nears?\s*[:=]?\s*$/i.test(before)) return true;
  // The clause back to the last number or full stop; a NEAR right after that number is its unit, not this one's.
  const cut = Math.max(before.search(/[\d.;!?][^\d.;!?]*$/), -1);
  const seg = cut >= 0 ? before.slice(cut + 1).slice(-48).replace(/^\s*nears?\b/i, "") : before.slice(-48);
  const m = /\bnears?\b/i.exec(seg);
  return m !== null && !NETWORK.test(seg.slice(m.index + m[0].length));
}

function nearAfter(after: string): boolean {
  if (/^\s*nears?\b/i.test(after)) return true;
  const stop = after.search(/[\d.;!?]/);
  const seg = (stop >= 0 ? after.slice(0, stop) : after).slice(0, 48);
  const m = /\bnears?\b/i.exec(seg);
  return m !== null && !NETWORK.test(after.slice(m.index + m[0].length));
}

/** Every number of a text once the given names are set aside. */
export function findNumbers(text: string, names: readonly string[]): Found[] {
  const t = withoutNames(text, names.filter((n) => /[.\d]/.test(n)), MARK);
  const out: Found[] = [];
  for (const m of t.matchAll(RUN)) {
    const at = m.index;
    const end = at + m[0].length;
    const before = t.slice(0, at);
    const after = t.slice(end);
    const raw = m[0];
    // Glued to a letter or a sign, or a bare decimal point in front (`.1 NEAR` reads as 0.1).
    const glued = /[\p{L}×%‰]$/u.test(before) || /^[\p{L}×%‰]/u.test(after) || /(^|[^\d])[.,]$/u.test(before);
    const clock = /\d[:]\d|\d-\d/.test(raw);
    const directNear = /^\s*nears?\b/i.test(after);
    const amount = directNear || (!clock && (nearBefore(before) || nearAfter(after)));
    // A length of time in words, a word or a hyphen away: never for a time of day (`18:34 UTC that day`).
    const span = !clock && /^(?:-|\s+(?:[\p{L}]+\s+){0,2})?(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|months?|years?|blocks?)\b/iu.test(after);
    const plainCount = !clock && !amount && /^\d+$/.test(raw);
    // What a plain count counts: the next two words (`3 masks`, `3 AI masks`), the noun of `3 of the moves`, or the
    // label of `Moves on the safe: 3` / `Masks were 3`.
    const next = (/^\s+((?:[\p{L}_]+\s+){0,2})/u.exec(`${after} `)?.[1] ?? "").split(/\s+/).filter(Boolean);
    const partitive = /^\s+of\s+(?:the\s+|its\s+|their\s+)?([\p{L}]+)/iu.exec(after)?.[1];
    const label = /(?:^|[.;!?,(]\s*)([\p{L}]+)[^.;!?\d:]{0,30}?(?::|\s(?:was|were|is|are|came\s+to|total(?:l?ed)?))\s*$/iu.exec(before)?.[1];
    const counts = plainCount
      ? [...(partitive ? [partitive] : next.filter((w) => !NOT_NOUN.has(w.toLowerCase()))), ...(label ? [label] : [])].map(stem)
      : [];
    // A race's or a safe's number only when it is neither an amount, a length of time nor a count of something.
    const numbered =
      plainCount && !span && !counts.length ? ((/\b(race|safe)\s+(?:(?:number|no\.?|nr\.?)\s+)?#?$/i.exec(before)?.[1]?.toLowerCase() as "race" | "safe" | undefined) ?? null) : null;
    out.push({ n: normNumber(raw), glued, clock, numbered, amount, span, counts: numbered ? [] : counts, role: roleOf({ amount, clock }, before, after) });
  }
  return out;
}

/**
 * Every number a text writes that is no race's or safe's name, every amount of NEAR among them, and every count with
 * what it counts (`2 move`, `3 mask`).
 */
export function numbersOf(
  text: string,
  names: readonly string[],
): { numbers: string[]; amounts: string[]; counts: string[]; roles: string[] } {
  const found = findNumbers(text, names).filter((f) => !f.numbered && !f.glued);
  return {
    numbers: found.map((f) => f.n),
    amounts: found.filter((f) => f.amount).map((f) => f.n),
    counts: found.flatMap((f) => f.counts.map((c) => `${f.n} ${c}`)),
    // An amount or a time with what it is for: `0.1 lock`, `18:34:44 drain`. A time's short form shares its role.
    roles: found.flatMap((f) => (f.role ? [`${f.n} ${f.role}`, ...(/^\d{2}:\d{2}:\d{2}$/.test(f.n) ? [`${f.n.slice(0, 5)} ${f.role}`] : [])] : [])),
  };
}
