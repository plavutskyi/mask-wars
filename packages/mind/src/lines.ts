/**
 * The line book: hand-written lines per mask, tagged by event, with slots. The model never writes a line from
 * nothing; it may only tailor one of these (see voice.ts).
 *
 * File format, `voices/<mask>.json`: `{ "<tag>": ["line", ...], ... }`. A line's id is a hash of its text, so cutting
 * or adding lines never shifts the memory of what was said.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { MASKS, type MaskId } from "./masks.ts";
import { sha256Hex } from "./provider.ts";

export const BASE_TAGS = [
  "pre_fight",
  "reveal",
  "called_it",
  "was_called",
  "take_lead",
  "lose_lead",
  "rotate",
  "hold",
  "last_call",
  "win",
  "lose",
  "taunt_backer",
  "thank_backer",
  "insult_loser_card",
  "parry_injection",
  "couch",
  "worst_thought",
] as const;
export type BaseTag = (typeof BASE_TAGS)[number];
export type RivalryTag = `rivalry:${MaskId}`;
export type Tag = BaseTag | RivalryTag;

export const SLOTS = ["rival", "coin", "backer", "points", "amount"] as const;
export type Slot = (typeof SLOTS)[number];
export type Facts = Partial<Record<Slot, string>>;

/** Longest a line may be on screen. `couch` is a short debrief of one to three sentences. */
export const MAX_CHARS = 90;
export const COUCH_MAX_CHARS = 240;
/** Widest a slot may render; names are clipped to this before they go in. */
export const SLOT_WIDTH: Readonly<Record<Slot, number>> = { rival: 6, coin: 4, backer: 12, points: 6, amount: 7 };

export function tagsFor(mask: MaskId): Tag[] {
  return [...BASE_TAGS, ...MASKS.filter((m) => m !== mask).map((m) => `rivalry:${m}` as const)];
}

export function maxCharsFor(tag: Tag): number {
  return tag === "couch" ? COUCH_MAX_CHARS : MAX_CHARS;
}

export interface Line {
  readonly id: string;
  readonly mask: MaskId;
  readonly tag: Tag;
  readonly text: string;
  readonly slots: readonly Slot[];
}

const SLOT_RE = /\{([a-z]+)\}/g;

export function slotsOf(text: string): string[] {
  return [...text.matchAll(SLOT_RE)].map((m) => m[1]!);
}

/** Length of a line with every slot at its widest. */
export function worstLength(text: string): number {
  return Array.from(text.replace(SLOT_RE, (_, s: string) => "x".repeat(SLOT_WIDTH[s as Slot] ?? 0))).length;
}

export const LineFile = z.record(z.string(), z.array(z.string().min(1)));

export interface BookProblem {
  readonly mask: MaskId;
  readonly tag: string;
  readonly text: string;
  readonly problem: string;
}

/** Turn a parsed voice file into lines, collecting every problem instead of stopping at the first. */
export function readBook(mask: MaskId, raw: unknown): { lines: Line[]; problems: BookProblem[] } {
  const parsed = LineFile.safeParse(raw);
  if (!parsed.success) return { lines: [], problems: [{ mask, tag: "", text: "", problem: "not a tag → lines map" }] };
  const allowed = new Set<string>(tagsFor(mask));
  const lines: Line[] = [];
  const problems: BookProblem[] = [];
  const seen = new Set<string>();
  for (const [tag, texts] of Object.entries(parsed.data)) {
    if (!allowed.has(tag)) {
      problems.push({ mask, tag, text: "", problem: "unknown tag" });
      continue;
    }
    for (const text of texts) {
      const bad = slotsOf(text).filter((s) => !(SLOTS as readonly string[]).includes(s));
      if (bad.length) problems.push({ mask, tag, text, problem: `unknown slot ${bad.join(",")}` });
      if (worstLength(text) > maxCharsFor(tag as Tag)) problems.push({ mask, tag, text, problem: "too long" });
      const key = text.toLowerCase();
      if (seen.has(key)) problems.push({ mask, tag, text, problem: "duplicate" });
      seen.add(key);
      lines.push({
        id: sha256Hex(`${mask}\u0000${text}`).slice(0, 12),
        mask,
        tag: tag as Tag,
        text,
        slots: [...new Set(slotsOf(text))] as Slot[],
      });
    }
  }
  return { lines, problems };
}

/** Read `voices/<mask>.json` that ships with this package. */
export function loadBook(mask: MaskId): Line[] {
  const raw: unknown = JSON.parse(readFileSync(new URL(`../voices/${mask}.json`, import.meta.url), "utf8"));
  const { lines, problems } = readBook(mask, raw);
  if (problems.length) throw new Error(`voices/${mask}.json: ${problems.map((p) => `${p.tag} ${p.problem}: ${p.text}`).join("; ")}`);
  return lines;
}

export function loadAllBooks(): Line[] {
  return MASKS.flatMap((m) => loadBook(m));
}

export function fill(text: string, facts: Facts): string {
  return text.replace(SLOT_RE, (whole, s: string) => {
    const v = facts[s as Slot];
    if (v === undefined) return whole;
    const chars = Array.from(v);
    const w = SLOT_WIDTH[s as Slot];
    return chars.length <= w ? v : chars.slice(0, w).join("");
  });
}

/**
 * What each mask said in its last fights. A line used in any of the last `window` fights of that mask is not picked
 * again while an unused one exists; when a tag is exhausted, the line said longest ago goes first.
 */
export class LineMemory {
  readonly window: number;
  /** mask → fight ids, oldest first. */
  readonly #fights = new Map<string, string[]>();
  /** mask → fight id → line ids. */
  readonly #said = new Map<string, Map<string, Set<string>>>();
  /** line id → order it was last said, for least-recently-used fallback. */
  readonly #lastSaid = new Map<string, number>();
  #clock = 0;

  constructor(window = 20) {
    this.window = window;
  }

  remember(mask: string, fightId: string, lineId: string): void {
    const fights = this.#fights.get(mask) ?? [];
    const said = this.#said.get(mask) ?? new Map<string, Set<string>>();
    if (!said.has(fightId)) {
      fights.push(fightId);
      said.set(fightId, new Set());
      while (fights.length > this.window) said.delete(fights.shift()!);
    }
    said.get(fightId)!.add(lineId);
    this.#fights.set(mask, fights);
    this.#said.set(mask, said);
    this.#lastSaid.set(lineId, ++this.#clock);
  }

  /** Line ids this mask said in its last `window` fights, the current one included. */
  recent(mask: string): Set<string> {
    const out = new Set<string>();
    for (const ids of this.#said.get(mask)?.values() ?? []) for (const id of ids) out.add(id);
    return out;
  }

  lastSaid(lineId: string): number {
    return this.#lastSaid.get(lineId) ?? 0;
  }

  /** Plain data, for the engine to persist between restarts. */
  toJSON(): { window: number; masks: Record<string, [string, string[]][]>; last: [string, number][] } {
    const masks: Record<string, [string, string[]][]> = {};
    for (const [mask, fights] of this.#fights) {
      const said = this.#said.get(mask)!;
      masks[mask] = fights.map((f) => [f, [...(said.get(f) ?? [])]]);
    }
    return { window: this.window, masks, last: [...this.#lastSaid] };
  }

  static fromJSON(data: ReturnType<LineMemory["toJSON"]>): LineMemory {
    const memory = new LineMemory(data.window);
    const order = new Map(data.last);
    for (const [mask, fights] of Object.entries(data.masks)) {
      for (const [fight, ids] of fights) for (const id of ids) memory.remember(mask, fight, id);
    }
    for (const [id, n] of order) memory.#lastSaid.set(id, n);
    memory.#clock = Math.max(0, ...order.values());
    return memory;
  }
}
