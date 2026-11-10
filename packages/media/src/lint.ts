/**
 * lintPost: every text checked before it enters the queue, when it is approved and right before it goes out.
 * Answers the reasons it may not go out; empty means fine. Voice: BRANDBOOK §11.
 */

/**
 * `post`: a post that opens on its own, never with a link. `reply`: the reply that carries the post's one link.
 * `thread`: a post inside a thread, after the first; it may carry the links to the transactions it talks about.
 */
export type PostRole = "post" | "reply" | "thread";

export type LintOptions = {
  role?: PostRole;
  /** The Card's grid: the only text allowed its coloured squares. */
  grid?: boolean;
  /** Longest post in X's own count (a link is 23). 280 unless the account posts long (X Premium). */
  max?: number;
  /** When set, every @handle in the text must be one of these. */
  handles?: readonly string[];
};

/** Words that read as a machine or a pitch. */
const AI_WORDS = [
  "unleash", "unleashed", "alpha", "delve", "delves", "journey", "seamless", "seamlessly", "unlock", "unlocks", "revolutionary",
  "revolutionize", "game-changer", "game changer", "elevate", "embark", "tapestry", "supercharge", "next-level", "cutting-edge",
  "harness the power", "in the world of", "dive into", "buckle up", "let that sink in", "web3 revolution", "powered by ai",
];

/** Profit promises: we never say a person will make money. */
const PROMISES: RegExp[] = [
  /\bguarantee[ds]?\b/i,
  /\brisk[- ]?free\b/i,
  /\bno[- ]loss\b/i,
  /\bcan'?t lose\b/i,
  /\bfree money\b/i,
  /\beasy money\b/i,
  /\bpassive income\b/i,
  /\bget rich\b/i,
  /\b(?:\d+x|x\d+|\d+×)\b(?! on| off)/i, // "100x" as a promise; a real multiple is written ×8.2 with a decimal or "×N on"
  /\bwill (?:make|earn|win|pay) you\b/i,
  /\b(?:sure|safe) (?:bet|win|thing)\b/i,
  /\bprofits?\b/i,
  /\breturns?\b(?! it)/i,
];

const PARALLEL: RegExp[] = [
  /[—–]/, // dash-parallelism: the machine's favourite beat
  /\bnot (?:just |only |merely )?[\w$'’ -]{1,30}[,;]? but\b/i,
  /\bit'?s not [^.]{1,40}[,;] it'?s\b/i,
  /\bisn'?t (?:just )?[^.]{1,30}[,;] it'?s\b/i,
  /\bno [\w-]+, no [\w-]+, (?:no|just) [\w-]+/i,
];

/** The one hashtag we ever use, on the hackathon demo post. */
const HASHTAGS_OK = new Set(["#nearhackathon"]);

const LINK = /\bhttps?:\/\/\S+|\b(?:[a-z0-9-]+\.)+(?:xyz|com|io|gg|fi|org|net|app|dev|co|ai)\b(?:\/\S*)?/gi;
const GRID_SQUARES = /[🟧🟪⬛]/u;
const EMOJI = /\p{Extended_Pictographic}|[\u{1F7E0}-\u{1F7EB}\u{2B1B}\u{2B1C}]/u;

export function linksIn(text: string): string[] {
  return text.match(LINK) ?? [];
}

/** X counts a link as 23 and most of Latin, punctuation and digits as 1; everything else (emoji, CJK) as 2. */
export const X_LINK = 23;
const LIGHT: [number, number][] = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];

export function xLength(text: string): number {
  let n = 0;
  for (const ch of text.replace(LINK, "")) {
    const c = ch.codePointAt(0)!;
    n += LIGHT.some(([a, b]) => c >= a && c <= b) ? 1 : 2;
  }
  return n + linksIn(text).length * X_LINK;
}

export function lintPost(text: string, opts: LintOptions = {}): string[] {
  const role = opts.role ?? "post";
  const out: string[] = [];
  const t = text.trim();
  if (t === "") return ["empty"];
  const max = opts.max ?? 280;
  if (xLength(t) > max) out.push(`over ${max} characters`);

  const lower = t.toLowerCase();
  for (const w of AI_WORDS) {
    const re = new RegExp(`(?<![\\w-])${w.replace(/[-\s]/g, "[-\\s]")}(?![\\w-])`, "i");
    if (re.test(lower)) out.push(`AI word: ${w}`);
  }
  for (const re of PARALLEL) if (re.test(t)) out.push("AI pattern: dash or not-X-but-Y parallelism");
  for (const re of PROMISES) if (re.test(t)) out.push(`profit promise: ${t.match(re)![0]}`);

  const tags = t.match(/(?<![\w&])#[\p{L}_][\p{L}\p{N}_]*/gu) ?? [];
  if (tags.length > 1) out.push("junk hashtags: one at most");
  for (const tag of tags) if (!HASHTAGS_OK.has(tag.toLowerCase())) out.push(`junk hashtag: ${tag}`);

  const links = linksIn(t);
  if (role === "post" && links.length > 0) out.push("a link in the post: it goes in the reply");
  if (role === "reply" && links.length !== 1) out.push("the reply carries exactly one link");

  if (opts.handles) {
    const allowed = new Set(opts.handles.map((h) => h.toLowerCase()));
    for (const h of t.replace(LINK, " ").match(/(?<![\w@])@[A-Za-z0-9_]+/g) ?? []) {
      if (!allowed.has(h.toLowerCase())) out.push(`a tag that is not on the list: ${h}`);
    }
  }

  if (/!/.test(t)) out.push("an exclamation mark");
  if (opts.grid) {
    const rest = t.replace(new RegExp(GRID_SQUARES.source, "gu"), "");
    if (EMOJI.test(rest)) out.push("an emoji outside the grid");
  } else if (EMOJI.test(t)) out.push("an emoji");

  // Inside a thread a link may point at a transaction or an account: only the words around it are checked.
  const words = role === "thread" ? t.replace(LINK, " ") : t;
  if (/\b0x[0-9a-f]{6,}/i.test(words)) out.push("an address");
  if (/\b[0-9a-f]{40,}\b/i.test(words) || /\b[1-9A-HJ-NP-Za-km-z]{43,44}\b/.test(words)) out.push("a hash or tx id");
  if (/\b[a-z0-9_-]{2,64}\.(?:near|testnet)\b/i.test(words)) out.push("an account id");
  if (/\bf-[0-9a-z]+-[0-9]+\b/.test(words)) out.push("a fight id");

  return [...new Set(out)];
}
