/**
 * The tour, the timeline: everything MASK WARS does and how to use each thing, in 2:30 of the live site. 1920×1080,
 * 30 frames a second, no voice, cut on the beats of the long film's track played whole (`audio/promo-150.mp3`, 128 BPM,
 * 80 bars). Ten chapters; each opens with a card (its number and its name) and then shows the real page being used,
 * with one short line under it for each step.
 *
 * Pure: the bars, what the film does on each page and when, what it may press, and the words. Every number in the
 * words is read from one file, `data.json` (the site's own API and what its pages said when they were filmed), so a
 * new round is another argument and nothing here holds a sum or a winner. The pictures and the type are the demo
 * film's (`demo/Demo.tsx`); its forge reel is this film's second chapter.
 */

import { near } from "@maskwars/arena/format";
import type { DemoData, LeagueRow, Race, Rect, Tap, Tint } from "../demo/plan.ts";
import { barFrame, FORGE_WORDS, story } from "../demo/plan.ts";

export const TOUR = { id: "Tour", width: 1920, height: 1080, fps: 30, bpm: 128, bars: 80 } as const;
export const DURATION = barFrame(TOUR.bars);
/** A chapter's card: three beats, 1.4 s. */
export const CARD = 0.75;
/** The first film frame of a beat of a part that starts at bar `at` (a beat is a quarter of a bar). */
export const beatFrame = (at: number, beat: number): number => barFrame(at + beat / 4) - barFrame(at);
/** The longest line a caption bar holds at 56 px and more (Hubot 800 capitals are about .84 em wide). */
export const MAX_HEAD = 32;

// ——— The chapters ———

export type ReelName = "watch" | "race" | "forge" | "mask" | "copy" | "league" | "jobs" | "near" | "swap" | "check" | "market" | "connect" | "github";

/**
 * Where each chapter starts, in bars. The track's first drop (bar 17) lands on the forge's card, its second (bar 53)
 * on the swap's, its finale (bar 72) on the last chapter's and its last hit (bar 76) on the end card; the two silent
 * bars (16 and 52) hold what a round paid and what a person gets.
 */
export const CHAPTERS: readonly { no: number; at: number; name: string; tag: string; reels: readonly ReelName[] }[] = [
  { no: 1, at: 2.5, name: "Watch and call\nthe round", tag: "Watch and call the round", reels: ["watch", "race"] },
  { no: 2, at: 17, name: "Forge your\nown mask", tag: "Forge your own mask", reels: ["forge", "mask"] },
  { no: 3, at: 28.5, name: "Copy a mask", tag: "Copy a mask", reels: ["copy"] },
  { no: 4, at: 33, name: "The league", tag: "The league", reels: ["league"] },
  { no: 5, at: 39, name: "Hire the masks\nfor a job", tag: "Hire the masks for a job", reels: ["jobs"] },
  { no: 6, at: 46.5, name: "Get NEAR from\nany network", tag: "Get NEAR from any network", reels: ["near"] },
  { no: 7, at: 53, name: "Swap anything\ninto anything", tag: "Swap anything into anything", reels: ["swap"] },
  { no: 8, at: 58, name: "Ask before you pay:\nMASK CHECK", tag: "Ask before you pay: MASK CHECK", reels: ["check", "market"] },
  { no: 9, at: 67, name: "Plug your own\nagent in", tag: "Plug your own agent in", reels: ["connect"] },
  { no: 10, at: 72, name: "Open source", tag: "Open source", reels: ["github"] },
];
export const HOOK = { at: 0, len: 2.5, second: 1.5 } as const;
export const END = { at: 76, len: TOUR.bars - 76 } as const;

/** Where each reel plays, in bars: a chapter's reels follow its card end to end, the last one up to the next card. */
export const REEL_AT: Record<ReelName, { at: number; len: number }> = {
  watch: { at: 3.25, len: 5.25 },
  race: { at: 8.5, len: 8.5 },
  forge: { at: 17.75, len: 8 },
  mask: { at: 25.75, len: 2.75 },
  copy: { at: 29.25, len: 3.75 },
  league: { at: 33.75, len: 5.25 },
  jobs: { at: 39.75, len: 6.75 },
  near: { at: 47.25, len: 5.75 },
  swap: { at: 53.75, len: 4.25 },
  check: { at: 58.75, len: 4.75 },
  market: { at: 63.5, len: 3.5 },
  connect: { at: 67.75, len: 4.25 },
  github: { at: 72.75, len: 3.25 },
};
export const reelFrames = (name: ReelName): number => barFrame(REEL_AT[name].at + REEL_AT[name].len) - barFrame(REEL_AT[name].at);
export const reelBeats = (name: ReelName): number => REEL_AT[name].len * 4;

// ——— What the film does on a page ———

/** Something on a page: the first thing `css` matches that is on screen and, with `has`, whose words match it. */
export type Sel = {
  css: string;
  /** A pattern its words must match, case ignored. */
  has?: string;
  /** Every match as one box, for a group of things. */
  union?: boolean;
  /** The last match in place of the first: the innermost of nested things. */
  last?: boolean;
};

/** What a press is for. The film presses nothing else: see `mayPress`. */
export type PressKind = "picker" | "tab" | "sheet" | "close";

export type Act =
  /** A press on a control, on its beat. */
  | { beat: number; tap: Sel; kind: PressKind }
  /** The page glides until the thing stands `top` px of the page under the window's top, over `over` beats. */
  | { beat: number; scroll: Sel | "top"; top?: number; over: number }
  /** A field is emptied and its own words typed back into it, a letter every `every` frames. */
  | { beat: number; retype: Sel; every: number }
  /** Enter, in the field the film typed into. */
  | { beat: number; enter: Sel }
  /** The film stands still until the page has its answer; the wait is not on film. `fail`: the page refused. */
  | { beat: number; wait: { there?: string; gone?: string; fail?: string } };

/** A box of the page measured on a beat, in px of the reel: where a line points. */
export type Measure = { name: string; sel: Sel; beat: number };
/** Words read off the page when its reel ends: `match`'s first group, of the thing's words or of its attribute. */
export type Read = { name: string; sel: Sel; attr?: string; match?: string };

export type Reel = {
  name: ReelName;
  url: string;
  /** The width of what is filmed, in px of the page; it is drawn 1920 wide. A page with small type is filmed closer. */
  width: number;
  /**
   * The window's own width when it is wider than what is filmed: the page lays itself out for that window, and the
   * film takes the band of it that `center` stands in the middle of. For a page with a column beside its words.
   */
  layout?: number;
  center?: Sel;
  /** The page has the 3D arena: it is filmed from the arena's first drawn frame. */
  arena?: boolean;
  /** A long page of someone else's: it is walked once before filming, so every picture on it has arrived. */
  prime?: boolean;
  /** The page is ready when this is on it. */
  ready?: string;
  acts: Act[];
  measures: Measure[];
  reads: Read[];
};

export const VIEW = 1512;
const ROWS = ["fund", "open", "seal", "unlock", "move", "drain", "reveal", "claim", "paid", "refund"] as const;
const COURSE = 'section[aria-labelledby="course"]';
const CHECK = 'section[aria-label="MASK CHECK"]';
const PICKER = '[role="dialog"]';
/** A quote is on the page: the picker is shut and the sum is not dimmed. */
const QUOTED = { gone: `${PICKER}, [data-dim], [data-moving]` } as const;

/**
 * Every reel but the forge's (that one is the demo film's, `demo/capture.ts`): the page, and what is done on it on
 * which beat. Nothing here signs, sends, hires or posts: a pick on the home page is never tapped, the forge stops at
 * the name, a job's sheet is opened and shut, and no form is sent but the check's own question.
 */
export function reels(site: string, round: string, mask: string): Reel[] {
  const base = site.replace(/\/$/, "");
  const person = encodeURIComponent(mask.toLowerCase());
  return [
    {
      name: "watch",
      url: `${base}/`,
      width: VIEW,
      arena: true,
      acts: [],
      measures: [
        { name: "clock", beat: 0, sel: { css: "main > header > div" } },
        { name: "vault", beat: 5, sel: { css: 'main section[data-masks] > div[aria-hidden="true"]' } },
        { name: "masks", beat: 10, sel: { css: 'ol[aria-label="Masks of the arena"] > li', union: true } },
        { name: "picks", beat: 15, sel: { css: "main > footer > div[data-mode]" } },
      ],
      reads: [{ name: "vault", sel: { css: 'main section[data-masks] [role="status"] > span' }, match: "^([\\d.,]+)\\s*NEAR" }],
    },
    {
      name: "race",
      url: `${base}/race/${encodeURIComponent(round)}`,
      width: VIEW,
      ready: `${COURSE} ol > li[data-kind]`,
      acts: [
        { beat: 5, scroll: { css: COURSE }, top: 16, over: 3 },
        { beat: 28, scroll: "top", over: 2 },
      ],
      measures: [
        ...ROWS.map((kind) => ({ name: `row:${kind}`, beat: 8, sel: { css: `${COURSE} ol > li[data-kind="${kind}"]` } })),
        { name: "row:break", beat: 8, sel: { css: `${COURSE} ol > li[data-kind]`, has: "the break" } },
      ],
      reads: [],
    },
    {
      name: "mask",
      url: `${base}/mask/${person}`,
      width: VIEW,
      ready: "main section h1",
      acts: [],
      measures: [{ name: "state", beat: 5, sel: { css: "main section p[data-state]" } }],
      reads: [
        { name: "title", sel: { css: "main section h1" } },
        { name: "forged", sel: { css: "main section p", has: "^forged\\b" } },
        { name: "state", sel: { css: "main section p[data-state] > span" } },
      ],
    },
    {
      name: "copy",
      url: `${base}/mask/${person}`,
      width: VIEW,
      ready: 'section[aria-labelledby="copy"]',
      acts: [{ beat: 0, scroll: { css: 'section[aria-labelledby="copy"]' }, top: 210, over: 3 }],
      measures: [
        { name: "split", beat: 5, sel: { css: 'section[aria-labelledby="copy"] dl > div:nth-child(-n+2)', union: true } },
        { name: "button", beat: 10, sel: { css: 'section[aria-labelledby="copy"] a[href*="copy="]' } },
      ],
      reads: [
        { name: "keep", sel: { css: 'section[aria-labelledby="copy"] dl > div:nth-child(1) dd' }, match: "^(\\d+\\s*%)$" },
        { name: "take", sel: { css: 'section[aria-labelledby="copy"] dl > div:nth-child(2) dd' }, match: "^(\\d+\\s*%)$" },
        { name: "price", sel: { css: 'section[aria-labelledby="copy"] a[href*="copy="] span' }, match: "^([\\d.,]+\\s*NEAR)$" },
      ],
    },
    {
      name: "league",
      url: `${base}/league`,
      width: VIEW,
      ready: 'section[aria-label="League table"] ol > li',
      acts: [
        { beat: 4, scroll: { css: 'section[aria-labelledby="forged"]' }, top: 40, over: 3 },
        { beat: 11, scroll: { css: 'section[aria-labelledby="callers"]' }, top: 230, over: 3 },
      ],
      measures: [
        { name: "table", beat: 0, sel: { css: 'section[aria-label="League table"] ol' } },
        { name: "forged", beat: 7, sel: { css: 'section[aria-labelledby="forged"]' } },
        { name: "callers", beat: 14, sel: { css: 'section[aria-labelledby="callers"]' } },
      ],
      reads: [],
    },
    {
      name: "jobs",
      url: `${base}/jobs`,
      width: VIEW,
      ready: 'main section button[aria-haspopup="dialog"]',
      acts: [
        { beat: 5, tap: { css: 'main section button[aria-haspopup="dialog"]', has: "^post a job$" }, kind: "sheet" },
        { beat: 14, tap: { css: `${PICKER} button[aria-label="Close"]` }, kind: "close" },
        { beat: 15, scroll: { css: 'section[aria-labelledby="ways"]' }, top: 16, over: 2 },
      ],
      measures: [],
      reads: [],
    },
    {
      name: "near",
      url: `${base}/near`,
      width: VIEW,
      ready: 'form button[aria-haspopup="dialog"]',
      acts: [
        { beat: 0, wait: QUOTED },
        { beat: 2, tap: { css: 'form button[aria-haspopup="dialog"]' }, kind: "picker" },
        { beat: 4, tap: { css: `${PICKER} nav button`, has: "^Ethereum$" }, kind: "picker" },
        { beat: 6, tap: { css: `${PICKER} li > button:not([aria-label])`, has: "^ETH\\s*Ethereum" }, kind: "picker" },
        { beat: 6, wait: QUOTED },
        { beat: 10, tap: { css: 'form button[aria-haspopup="dialog"]' }, kind: "picker" },
        { beat: 12, tap: { css: `${PICKER} li > button:not([aria-label])`, has: "^USDC\\s*Arbitrum" }, kind: "picker" },
        { beat: 12, wait: QUOTED },
        { beat: 15, tap: { css: '[role="radiogroup"][aria-label="Amount"] [role="radio"]', has: "^\\$50$" }, kind: "picker" },
        { beat: 15, wait: QUOTED },
      ],
      measures: [{ name: "get", beat: 19, sel: { css: 'section > div[aria-live="polite"]' } }],
      reads: [
        { name: "networks", sel: { css: "section > p", has: "networks" }, match: "(\\d+)\\s+networks" },
        { name: "get", sel: { css: 'section > div[aria-live="polite"]' }, match: "(\\d[\\d.,]*)\\s*NEAR" },
      ],
    },
    {
      name: "swap",
      url: `${base}/swap`,
      width: VIEW,
      ready: 'button[aria-haspopup="dialog"][aria-label^="Receive"]',
      acts: [
        { beat: 0, wait: QUOTED },
        { beat: 3, tap: { css: 'button[aria-haspopup="dialog"][aria-label^="Receive"]' }, kind: "picker" },
        { beat: 6, tap: { css: `${PICKER} li > button:not([aria-label])`, has: "^BTC\\s*Bitcoin" }, kind: "picker" },
        { beat: 6, wait: QUOTED },
        { beat: 8, scroll: { css: 'section > div[aria-live="polite"]' }, top: 300, over: 3 },
      ],
      measures: [{ name: "get", beat: 11, sel: { css: 'section > div[aria-live="polite"]' } }],
      reads: [
        { name: "pay", sel: { css: 'button[aria-haspopup="dialog"][aria-label^="Pay"]' }, attr: "aria-label", match: "^Pay (\\S+) on" },
        { name: "get", sel: { css: 'button[aria-haspopup="dialog"][aria-label^="Receive"]' }, attr: "aria-label", match: "^Receive (\\S+) on" },
      ],
    },
    {
      name: "check",
      url: `${base}/check`,
      width: VIEW,
      ready: `${CHECK} form input`,
      acts: [
        { beat: 1, retype: { css: `${CHECK} form input` }, every: 2 },
        { beat: 6, enter: { css: `${CHECK} form input` } },
        { beat: 6, wait: { there: `${CHECK} [role="status"][data-phase="answer"]`, fail: `${CHECK} [role="status"][data-phase="refused"]` } },
        { beat: 12, tap: { css: `${CHECK} summary`, has: "^details$" }, kind: "sheet" },
        { beat: 12, scroll: { css: `${CHECK} [role="status"]` }, top: 40, over: 3 },
      ],
      measures: [
        { name: "field", beat: 0, sel: { css: `${CHECK} form input` } },
        { name: "verdict", beat: 7, sel: { css: `${CHECK} [role="status"]` } },
        { name: "reasons", beat: 15, sel: { css: `${CHECK} details ul` } },
      ],
      reads: [{ name: "verdict", sel: { css: `${CHECK} [role="status"] [data-verdict]` }, attr: "data-verdict" }],
    },
    {
      name: "market",
      url: "https://market.near.ai/a/maskwars",
      width: 1248,
      prime: true,
      ready: "h1",
      acts: [{ beat: 4, scroll: { css: "div, p, span", has: "^\\$[\\d.]+\\s*/\\s*call$", last: true }, top: 150, over: 3 }],
      measures: [{ name: "price", beat: 7, sel: { css: "div, p, span", has: "^\\$[\\d.]+\\s*/\\s*call$", last: true } }],
      reads: [{ name: "price", sel: { css: "div, p, span", has: "^\\$[\\d.]+\\s*/\\s*call$", last: true }, match: "^(\\$[\\d.]+)" }],
    },
    {
      name: "connect",
      url: `${base}/mcp/connect`,
      width: VIEW,
      ready: "#connect-way [data-text]",
      acts: [
        { beat: 5, tap: { css: '[role="tab"]', has: "^codex$" }, kind: "tab" },
        { beat: 6, tap: { css: '[role="tab"]', has: "^any client$" }, kind: "tab" },
        { beat: 8, tap: { css: '[role="tab"]', has: "^claude code$" }, kind: "tab" },
        { beat: 9, scroll: { css: 'section[aria-label="Connect"] > ul' }, top: 150, over: 2 },
      ],
      measures: [
        { name: "line", beat: 0, sel: { css: "#connect-way code" } },
        { name: "tabs", beat: 5, sel: { css: '[role="tablist"]' } },
        { name: "tools", beat: 11, sel: { css: 'section[aria-label="Connect"] > ul' } },
      ],
      reads: [{ name: "tools", sel: { css: 'section[aria-label="Connect"] > p', has: "tools" }, match: "(\\d+)\\s+tools" }],
    },
    {
      name: "github",
      url: "https://github.com/plavutskyi/mask-wars",
      width: 936,
      layout: 1296,
      center: { css: "article" },
      prime: true,
      ready: "article h1",
      acts: [
        { beat: 0, scroll: { css: "article h1" }, top: 78, over: 3 },
        { beat: 6, scroll: { css: "article h2, article h3", has: "^rounds on mainnet$" }, top: 78, over: 3 },
      ],
      measures: [{ name: "badge", beat: 3, sel: { css: 'article img[alt="CI"]' } }],
      reads: [],
    },
  ];
}

// ——— What the film may press ———

/** A control as the page describes it, read before it is pressed. */
export type Pressed = {
  tag: string;
  role: string;
  type: string;
  /** Its words, and its `aria-label`. */
  text: string;
  label: string;
  href: string;
  /** `aria-haspopup`. */
  popup: string;
  /** Where it stands: in a dialog, in its list of networks, in its list of coins, in a group of choices and its name. */
  inDialog: boolean;
  inNav: boolean;
  inList: boolean;
  group: string;
};

/** Words of a control that sends, signs, pays, hires or copies: never pressed, whatever it is said to be. */
const SENDS = /\b(get near|deposit|copy|hire|sign|connect|forge|take it out|manage|buy|send|confirm|approve|withdraw|cash out|use my own|opens at|check|pay now)\b/i;

/**
 * Why the film will not press a control, or null when it may. It presses four kinds of thing and nothing else: a
 * picker (the coin button, a network and a coin in its list, an amount), a tab, a sheet that only opens (Post a job,
 * Details) and that sheet's Close. A button that submits a form is refused whatever it is called; so is a link (the
 * film goes to a page by its address) and any control whose words send, sign, hire or copy.
 */
export function mayPress(d: Pressed, kind: PressKind): string | null {
  const said = d.text.replace(/\s+/g, " ").trim();
  if (d.type.toLowerCase() === "submit") return `«${said}» submits a form`;
  if (d.href) return `«${said}» is a link`;
  if (SENDS.test(said)) return `«${said}» sends, signs, hires or copies`;
  switch (kind) {
    case "tab":
      return d.role === "tab" ? null : `«${said}» is not a tab`;
    case "close":
      return d.inDialog && /^close$/i.test(d.label) ? null : `«${said}» is not a sheet's Close`;
    case "sheet":
      if (d.tag === "summary" && /^details$/i.test(said)) return null;
      if (d.tag === "button" && d.popup === "dialog" && /^post a job$/i.test(said)) return null;
      return `«${said}» is not a sheet the film opens`;
    case "picker":
      if (d.tag !== "button") return `«${said}» is not a picker`;
      if (d.popup === "dialog" && !d.inDialog && !/job|wallet/i.test(`${said} ${d.label}`)) return null;
      if (d.inDialog && (d.inNav || d.inList) && !/^about\b/i.test(d.label)) return null;
      if (d.role === "radio" && /^amount$/i.test(d.group)) return null;
      return `«${said}» is not a picker`;
  }
}

/** A field as the page describes it. The film types into two: a picker's search and the check's question. */
export type Field = { tag: string; label: string; inCheck: boolean };
export const mayType = (f: Field): string | null => (f.tag === "input" && (f.inCheck || /^search\b/i.test(f.label)) ? null : "the film types only into a search or the check's field");
/** Enter is pressed in one place: the check's field, where it asks the question a person would ask. */
export const mayEnter = (f: Field): string | null => (f.tag === "input" && f.inCheck ? null : "Enter is pressed only in the check's field");

// ——— The data: one file ———

export type Filmed = {
  frames: number;
  /** The presses as they landed, in px of the 1920×880 reel, and the frame of each. */
  taps: Tap[];
  /** The measured boxes, in px of the reel; null when the page had no such thing. */
  boxes: Record<string, Rect | null>;
  /** What was read off the page; null when it was not there. */
  facts: Record<string, string | null>;
};

export type TourData = {
  /** The round of chapter 1, the person's mask of chapters 2 and 3, the site, and when it was filmed. */
  round: string;
  mask: string;
  site: string;
  capturedAt: number;
  race: Race;
  league: LeagueRow[];
  reels: Record<Exclude<ReelName, "forge">, Filmed>;
  /** The demo film's forge reel, and the frames of the home page's reel under the first words and the last. */
  forge: { frames: number; taps: Tap[] };
  home: { frames: number };
};

/** The latest round that has ended, in the order the site lists its rounds (newest first). */
export function latestFinished(races: readonly Pick<Race, "id" | "phase">[]): string | null {
  return races.find((r) => r.phase === "broken" || r.phase === "held")?.id ?? null;
}

// ——— The words ———

export type Line = {
  beat: number;
  head: string;
  /** The small line above; the chapter's own when left out. */
  kicker?: string;
  tint?: Tint | undefined;
  /** The measured box the line points at. */
  spot?: string | undefined;
};

const two = (n: number): string => String(n).padStart(2, "0");
export const tagOf = (no: number): string => `${two(no)} · ${CHAPTERS[no - 1]!.tag}`;

/** The round as the demo film tells it: the same words for the same data. */
const told = (d: TourData) => {
  const f = d.reels.mask.facts;
  return story({ id: d.round, mask: d.mask, site: d.site, capturedAt: d.capturedAt, race: d.race, league: d.league, maskPage: { forged: f["forged"] ?? null, state: f["state"] ?? null } } as DemoData);
};

/** The round's page, row by row: what went in, who sealed, how it ended, what the contract paid, what the winner took. */
function roundLines(d: TourData): Line[] {
  const s = told(d);
  const r = d.race;
  const lines: Line[] = [
    { beat: 0, head: "Every round keeps its page" },
    { beat: 8, head: s.loaded.head, spot: `row:${s.loaded.row}` },
    { beat: 13, head: s.sealed.head, spot: `row:${s.sealed.row}` },
    { beat: 18, head: s.result.head, tint: "amber", spot: s.outcome === "broken" ? "row:break" : s.outcome === "held" ? "row:unlock" : undefined },
  ];
  const last = s.after[s.after.length - 1]!;
  if (s.outcome === "broken") {
    if (r.payout) lines.push({ beat: 24, head: `+${near(r.payout.amount)} NEAR from the contract`, tint: "money", spot: "row:paid" });
    lines.push({ beat: 30, head: last.head, tint: "money" });
  } else if (s.outcome === "held") {
    lines.push({ beat: 24, head: s.after[0]!.head, spot: "row:unlock" }, { beat: 30, head: last.head });
  } else {
    lines.push({ beat: 30, head: `${near(r.prize)} NEAR on the line`, tint: "money" });
  }
  return lines;
}

const VERDICT: Record<string, Line["tint"]> = { allow: "money", warn: "amber", block: "amber" };

/** The lines under a reel, from the data: a line with a number says it only when the page or the API gave one. */
export function lines(name: ReelName, d: TourData): Line[] {
  if (name === "forge") return FORGE_WORDS.map((w) => ({ beat: w.beat, kicker: `02 · ${w.kicker}`, head: w.head }));
  const f = d.reels[name].facts;
  const person = d.mask.toUpperCase();
  switch (name) {
    case "watch":
      return [
        { beat: 0, head: "A new round every day", spot: "clock" },
        { beat: 5, head: f["vault"] ? `${f["vault"]} NEAR in the vault` : "Real NEAR in the vault", tint: "money", spot: "vault" },
        { beat: 10, head: "AI masks race to break it", spot: "masks" },
        { beat: 15, head: "Call the winner. It's free.", spot: "picks" },
      ];
    case "race":
      return roundLines(d);
    case "mask":
      return [
        { beat: 0, head: "Sign once. The mask is yours." },
        { beat: 5, head: told(d).mask.head, spot: "state" },
      ];
    case "copy":
      return [
        { beat: 0, head: "Like a mask? Copy it." },
        { beat: 5, head: f["keep"] && f["take"] ? `You keep ${f["keep"]}. Its owner ${f["take"]}.` : `You share what ${person} wins`, spot: "split" },
        { beat: 10, head: f["price"] ? `Copy it for ${f["price"]}` : "One tap copies it", spot: "button" },
      ];
    case "league": {
      const top = d.league.filter((m) => m.breaks > 0).sort((a, b) => (BigInt(b.earned) > BigInt(a.earned) ? 1 : BigInt(b.earned) < BigInt(a.earned) ? -1 : 0))[0];
      return [
        top ? { beat: 0, head: `${top.who.name.toUpperCase()} took ${near(top.earned)} NEAR`, tint: "money", spot: "table" } : { beat: 0, head: "The arena's masks, ranked", spot: "table" },
        { beat: 7, head: "Masks forged by people", spot: "forged" },
        { beat: 14, head: "Who called the round right", spot: "callers" },
      ];
    }
    case "jobs":
      return [
        { beat: 0, head: "Put NEAR on a job" },
        { beat: 5, head: "Name the job. Set the reward." },
        { beat: 11, head: "Your own wallet signs it" },
        { beat: 17, head: "Or send your agent to work" },
      ];
    case "near":
      return [
        { beat: 0, head: f["networks"] ? `Any coin on ${f["networks"]} networks` : "Any coin, any network" },
        { beat: 2, head: "Pick the coin you hold" },
        { beat: 15, head: "Set the amount" },
        { beat: 19, head: f["get"] ? `You get ${f["get"]} NEAR` : "See what you get", tint: "money", spot: "get" },
      ];
    case "swap":
      return [
        { beat: 0, head: "Any coin into any coin" },
        { beat: 6, head: f["pay"] && f["get"] ? `${f["pay"]} in. ${f["get"]} out.` : "Pick what you receive" },
        { beat: 11, head: "Straight to your own wallet", spot: "get" },
      ];
    case "check": {
      const v = (f["verdict"] ?? "").toLowerCase();
      return [
        { beat: 0, head: "Type any NEAR account", spot: "field" },
        { beat: 6, head: v in VERDICT ? `Verdict: ${v.toUpperCase()}` : "One clear verdict", tint: VERDICT[v], spot: "verdict" },
        { beat: 12, head: "Every reason, read from NEAR", spot: "reasons" },
      ];
    }
    case "market":
      return [
        { beat: 0, head: "Agents hire it on Agent Market" },
        { beat: 7, head: f["price"] ? `${f["price"]} a call` : "Paid by the call", tint: "money", spot: "price" },
      ];
    case "connect":
      return [
        { beat: 0, head: "One line plugs your agent in", spot: "line" },
        { beat: 5, head: "Claude Code, Codex, any client", spot: "tabs" },
        { beat: 11, head: f["tools"] ? `${f["tools"]} tools. No keys, ever.` : "Read-only tools. No keys.", spot: "tools" },
      ];
    case "github":
      return [
        { beat: 0, head: "The code is open", spot: "badge" },
        { beat: 9, head: "Every mainnet round, listed" },
      ];
  }
}

// ——— The cut ———

export type Spot = { rect: Rect; from: number; to: number };
export type Segment =
  | { kind: "hook"; at: number; len: number }
  | { kind: "card"; at: number; len: number; no: number; name: string; poster: ReelName }
  | { kind: "reel"; at: number; len: number; reel: ReelName; no: number; lines: Line[]; taps: Tap[]; spots: Spot[] }
  | { kind: "end"; at: number; len: number };

/**
 * The beat each measured box is taken on, and the beats the page starts to glide on: a line's box is lit from the
 * beat it was measured, once the page has stopped, and goes out when the page moves again.
 */
function moves(name: ReelName, d: TourData): { on: Record<string, number>; glides: number[] } {
  if (name === "forge") return { on: {}, glides: [] };
  const reel = reels(d.site, d.round, d.mask).find((r) => r.name === name)!;
  return { on: Object.fromEntries(reel.measures.map((m) => [m.name, m.beat])), glides: reel.acts.filter((a) => "scroll" in a).map((a) => a.beat) };
}

/** The whole film, part after part with no gap: the first words, ten chapters (a card, then its reels), the end card. */
export function cut(d: TourData): Segment[] {
  const out: Segment[] = [{ kind: "hook", at: HOOK.at, len: HOOK.len }];
  for (const ch of CHAPTERS) {
    out.push({ kind: "card", at: ch.at, len: CARD, no: ch.no, name: ch.name, poster: ch.reels[0]! });
    for (const name of ch.reels) {
      const { at, len } = REEL_AT[name];
      const said = lines(name, d);
      const { on, glides } = moves(name, d);
      const boxes = name === "forge" ? {} : d.reels[name].boxes;
      const spots: Spot[] = [];
      said.forEach((line, i) => {
        const rect = line.spot ? boxes[line.spot] : null;
        if (!rect) return;
        const lit = Math.max(line.beat, on[line.spot!] ?? line.beat);
        const until = Math.min(said[i + 1]?.beat ?? len * 4, ...glides.filter((g) => g >= lit));
        if (until > lit) spots.push({ rect, from: beatFrame(at, lit), to: beatFrame(at, until) });
      });
      out.push({ kind: "reel", at, len, reel: name, no: ch.no, lines: said, taps: name === "forge" ? d.forge.taps : d.reels[name].taps, spots });
    }
  }
  out.push({ kind: "end", at: END.at, len: END.len });
  return out;
}
