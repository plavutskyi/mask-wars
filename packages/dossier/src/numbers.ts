// Numbers and names in a sentence. The facts and the check of a model's page read text the same way, so a number a fact
// writes is exactly a number a sentence may quote, and nothing else.

/** `1,000.50` → `1000.5`, `0003` → `3`, `−1` → `-1`; `8:13`, `18:34:44` and `2026-11-06` stay whole. */
export function normNumber(token: string): string {
  let t = token.replace(/^[−–]/, "-");
  const negative = t.startsWith("-");
  if (negative) t = t.slice(1);
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, "");
  if (/^\d+\.\d+$/.test(t)) t = t.replace(/0+$/, "").replace(/\.$/, "");
  if (/^\d+$/.test(t)) t = t.replace(/^0+(?=\d)/, "");
  return negative ? `-${t}` : t;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The text with each given name blanked out where it stands as a whole token, longest first, so the digits inside an
 * account never read as numbers. A name that could read as a number (no letter, or leading digits: `1000.testnet`)
 * is never blanked: its digits are checked as numbers.
 */
export function withoutNames(text: string, names: readonly string[], mark = " "): string {
  // A name that could read as a number (no letter in it, or digits first that end before a letter: `1000.testnet`,
  // `5-000-000`) is never blanked: its digits stay digits. A hash like `8pvCJ…` is a name.
  const sorted = [...new Set(names.filter((n) => n && /\p{L}/u.test(n) && !/^\p{N}+(?![\p{L}\p{N}])/u.test(n)))].sort((a, b) => b.length - a.length);
  let out = text;
  for (const n of sorted) {
    // A base58 hash is blanked only in its own case: another case is another hash.
    const flags = caseMatters(n) ? "gu" : "giu";
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}_.-])${escape(n)}(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}])`, flags), mark);
  }
  return out;
}

/**
 * Every number in a text, normalised: every run of digits, glued to a word or not, with a sign in front of it when it
 * stands alone. Dates, times and durations stay whole (`2026-11-06`, `18:34`, `8:13`). Blank names out first.
 */
export function numbersIn(text: string): string[] {
  return [...text.matchAll(NUMBER)].map((m) => normNumber(m[0]));
}

const NUMBER = /(?:(?<![\p{L}\p{N}])[-−–])?\d+(?:[.,:/-]\d+)*/gu;

/** NEAR the network, not NEAR the unit: `NEAR testnet`, `NEAR AI`, `NEAR Intents`. */
const NOT_UNIT = /^\s*(testnet|mainnet|ai|intents|cloud|protocol|chain|blockchain)\b/i;

/**
 * Every amount of NEAR a text writes: a whole number with NEAR at most three words after it, none of them a number
 * (`3 NEAR`, `3 (testnet) NEAR`, `all 3 of the testnet NEAR`), or right after NEAR (`NEAR 3`, `NEAR: 3`). NEAR the
 * network (`NEAR testnet`) is not a unit.
 */
export function amountsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const after = text.slice(m.index + m[0].length);
    const before = text.slice(0, m.index);
    const unitAfter = /^\s*(?:[^\s\d]+\s+){0,3}?near\b/iu.exec(after);
    const isUnit = unitAfter !== null && !NOT_UNIT.test(after.slice(unitAfter[0].length));
    if (isUnit || /\bnear\s*[:=]?\s*$/iu.test(before)) out.push(normNumber(m[0]));
  }
  return out;
}

/** Money or a share in anything but NEAR, written next to a number: a page counts NEAR only. */
export function otherUnit(text: string): string | null {
  const units = "usd[ct]?|eur|gbp|btc|eth|dollars?|bucks?|cents?|euros?|percent|per\\s*cent|percentage|w-?near|\\p{L}+near|bps";
  const symbol = /[$€£¥₿]/u.exec(text);
  if (symbol) return symbol[0];
  return new RegExp(`\\d[\\d.,]*\\s*(${units})\\b|\\b(${units})\\s*\\d`, "iu").exec(text)?.[0] ?? null;
}

/** Races and safes named by their number: `race 2`, `Race #0003`, `SAFE 0002`, `safe-0001`. */
export function numberedIn(text: string): { kind: "race" | "safe"; n: string; at: number; length: number }[] {
  // `the safe 8:13 after the start` is a time after a word, not a safe's number.
  return [...text.matchAll(/\b(race|safe)[\s#-]*(\d+)\b(?![.:,/-]\d)/giu)].map((m) => ({
    kind: m[1]!.toLowerCase() as "race" | "safe",
    n: normNumber(m[2]!),
    at: m.index,
    length: m[0].length,
  }));
}

/** A number glued to a word or a sign: `1k`, `5M`, `8th`, `50%`, `x2`, `3×`, `×3`. */
export function gluedNumber(text: string): string | null {
  return /\d+[\p{L}%‰×]+|[\p{L}×]+\d+/u.exec(text)?.[0] ?? null;
}

/** Number words a page must not use: every count is written in digits, so the check can see it. */
const WORDS =
  /\b(zero|pair|couple|trio|duo|quartet|quarter|fortnight|decade|century|doubled?|tripled?|quadrupled?|\w+fold|\w+teenth|\w+tieth|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|hundredth|thousandth|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?|billions?|dozens?|twice|thrice|half|double|triple|quadruple|single)\b/i;

/** `one` is a number; `no one`, `the one`, `one of` and `one that` are not counts. */
// `one` as a pronoun (`a new one`, `confirmed one at §`, `the one at §`) is no number.
const ONE = /(?<!\b(no|the|a|later|next|last|this|that|each|every|another|new|first|second|other|same|old|earlier|only) )\bone\b(?!\s+(of|that|which|who|at|on|in|from|by|for|after|before|to)\b|\s*[,.;:]|\s*$)/i;
/** `once` counts (`claimed it once`), except where it opens a clause (`Once it owned the safe…`). */
// `once` that opens a clause (`once the judge confirmed it`) is no count.
const ONCE = /(?<!^|[,;:]\s|^\s)\bonce\b(?!\s+(?:the|a|an|it|its|they|their|[A-Z]{2,})\b)/i;
/** `a minute`, `an hour`: a length of time in words. */
const SPAN = /\b(an?)\s+(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\b/i;

export function numberWord(text: string): string | null {
  const w = WORDS.exec(text);
  if (w) return w[1]!.toLowerCase();
  const span = SPAN.exec(text);
  if (span) return span[0].toLowerCase();
  if (ONCE.test(text)) return "once";
  return ONE.test(text) ? "one" : null;
}

/** A base58 hash: its case is part of it. */
export const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;

/** A long token whose case is part of it: everything but an account and a lower-case hex hash. */
export function caseMatters(token: string): boolean {
  return /^[A-Za-z0-9]{32,64}$/.test(token) && !/^[0-9a-f]+$/.test(token);
}

/** Accounts, races, safes and hashes a sentence names: each must belong to a fact it cites. Base58 keeps its case. */
export function identifiersIn(text: string): string[] {
  const out = new Set<string>();
  const patterns = [
    // Anything shaped like an account: dotted parts, a letter somewhere, the last part at least two characters.
    /(?<![\p{L}\p{N}_.-])(?=[a-z\d_.-]*[a-z])[a-z\d_-]+(?:\.[a-z\d_-]+)*\.[a-z\d_-]{2,}(?![\p{L}\p{N}_-]|\.[a-z\d])/giu,
    // A name with a number: safe-0002, race-0009.
    /(?<![\p{L}\p{N}_.-])[a-z]+-\d+(?![\p{L}\p{N}_-])/giu,
    /(?<![\p{L}\p{N}])0x[0-9a-f]{40}(?![\p{L}\p{N}])/giu,
    /(?<![\p{L}\p{N}])[0-9a-f]{64}(?![\p{L}\p{N}])/giu,
    // Any long run of letters and digits reads as a hash, base58 or not.
    /(?<![\p{L}\p{N}])[A-Za-z0-9]{32,64}(?![\p{L}\p{N}])/gu,
  ];
  for (const p of patterns) for (const m of text.matchAll(p)) out.add(caseMatters(m[0]) ? m[0] : m[0].toLowerCase());
  return [...out];
}

/** `2026-11-06 18:34:44 UTC`, and the ways a sentence may write that moment: `2026-11-06`, `18:34:44`, `18:34`. */
export function moment(ms: number): { text: string; numbers: string[] } {
  const iso = new Date(ms).toISOString();
  const [date, time] = [iso.slice(0, 10), iso.slice(11, 19)];
  return { text: `${date} ${time} UTC`, numbers: [date, time, time.slice(0, 5)] };
}

/** Time from one moment to another as one token: `8:13`, `3:30:12`, `59:43:58`. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
