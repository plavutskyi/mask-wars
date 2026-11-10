/**
 * The voice of the masks. An event comes in, a written line goes out at once: picked by mask and tag, never repeated
 * within the mask's last 20 fights while a fresh one exists, slots filled from the facts of the fight.
 *
 * A model may then tailor the line to the fight. That arrives as a second, optional promise: the screen shows the line
 * now and swaps in the tailored one only if it comes back in time and passes the checks. The voice never waits.
 *
 * The person under the sixth mask speaks these same lines, so nothing here may sound like a model.
 */
import { cleanName } from "./clean.ts";
import type { Journal } from "./journal.ts";
import { fill, loadAllBooks, maxCharsFor, type Facts, type Line, type LineMemory, type Tag } from "./lines.ts";
import { MANNERS, type MaskId } from "./masks.ts";
import { polishPrompt } from "./prompt.ts";
import { withDeadline, type Completion, type Provider } from "./provider.ts";

/** Events where a jab at the rival fits as well as the event's own lines. */
const RIVALRY_FITS = new Set<Tag>(["pre_fight", "reveal", "take_lead", "called_it", "win", "hold"]);

/** Words a line may never carry: AI tells, banned brand words, anything that unmasks the speaker or promises money. */
export const BANNED =
  /\b(?:unleash\w*|alpha|delve\w*|journey|seamless\w*|unlock\w*|revolution\w*|guarantee\w*|tapestry|testament|elevate|ai|a\.i\.|bots?|robots?|models?|llms?|gpt|claude|codex|prompts?|neural|algorithms?|machine|humans?|tokens?|as an)\b|[—–!#]|\p{Extended_Pictographic}/iu;
/** "not X, but Y", "it's not X, it's Y", "X isn't Y. It's Z" and their cousins. */
export const NOT_BUT =
  /\b(?:not|isn't|wasn't|never)\b[^.?]{0,40}?,?\s*\bbut\b|\b(?:it's|it is|that's|this is)\s+not\b|\b(?:isn't|is not|aren't)\b[^.?]{0,40}[.,]\s*(?:it's|it is|they're)\b|\b(?:not|isn't)\b[^.?]{0,30},\s*(?:it's|just)\b/i;

export interface Spoken {
  readonly line: Line;
  /** The line as written, slots filled. Show this now. */
  readonly text: string;
  /** The tailored line, or `text` again if the model is absent, late or off-voice. Never rejects. */
  readonly polished: Promise<string>;
}

export interface VoiceOptions {
  readonly memory: LineMemory;
  readonly lines?: readonly Line[];
  readonly rng?: () => number;
  /** Optional tailoring. Without it every line goes out exactly as written. */
  readonly polish?: {
    readonly provider: Provider;
    readonly model: string;
    readonly journal: Journal;
    /** Default 1 500 ms: a line that is late is a line that missed its moment. */
    readonly timeoutMs?: number;
  };
  readonly now?: () => number;
}

export class Voice {
  readonly #byMaskTag = new Map<string, Line[]>();
  readonly #o: VoiceOptions;
  readonly #rng: () => number;
  readonly #now: () => number;

  constructor(options: VoiceOptions) {
    this.#o = options;
    this.#rng = options.rng ?? Math.random;
    this.#now = options.now ?? Date.now;
    for (const line of options.lines ?? loadAllBooks()) {
      const key = `${line.mask}|${line.tag}`;
      const list = this.#byMaskTag.get(key) ?? [];
      list.push(line);
      this.#byMaskTag.set(key, list);
    }
  }

  /** Pick a line for this event, or null if the mask has none that the facts can fill. */
  pick(mask: MaskId, tag: Tag, facts: Facts): Line | null {
    const usable = (t: Tag) => (this.#byMaskTag.get(`${mask}|${t}`) ?? []).filter((l) => l.slots.every((s) => facts[s] !== undefined));
    const own = usable(tag);
    const rivalTag = facts.rival ? rivalryTag(mask, facts.rival) : null;
    const extra = rivalTag && RIVALRY_FITS.has(tag) ? usable(rivalTag) : [];
    const recent = this.#o.memory.recent(mask);
    const fresh = own.filter((l) => !recent.has(l.id));
    if (fresh.length) return this.#choose(fresh);
    const freshExtra = extra.filter((l) => !recent.has(l.id));
    if (freshExtra.length) return this.#choose(freshExtra);
    const pool = [...own, ...extra];
    if (!pool.length) return null;
    // Exhausted: the line said longest ago.
    return pool.reduce((a, b) => (this.#o.memory.lastSaid(b.id) < this.#o.memory.lastSaid(a.id) ? b : a));
  }

  #choose(lines: readonly Line[]): Line {
    return lines[Math.min(lines.length - 1, Math.floor(this.#rng() * lines.length))]!;
  }

  /** Say something for this event. Returns at once; tailoring, if any, follows in `polished`. */
  say(fightId: string, mask: MaskId, tag: Tag, rawFacts: Facts): Spoken | null {
    const facts = safeFacts(rawFacts);
    const line = this.pick(mask, tag, facts);
    if (!line) return null;
    this.#o.memory.remember(mask, fightId, line.id);
    const text = fill(line.text, facts);
    const polished = this.#o.polish ? this.#tailor(fightId, mask, tag, text, facts) : Promise.resolve(text);
    return { line, text, polished };
  }

  async #tailor(fightId: string, mask: MaskId, tag: Tag, text: string, facts: Facts): Promise<string> {
    const p = this.#o.polish!;
    const timeoutMs = p.timeoutMs ?? 1_500;
    const max = maxCharsFor(tag);
    const started = this.#now();
    let completion: Completion | null = null;
    let reason = "";
    try {
      const work = p.provider.complete({
        model: p.model,
        messages: polishPrompt(mask, text, facts, max),
        maxTokens: tag === "couch" ? 120 : 50,
        temperature: 0.7,
        timeoutMs,
      });
      completion = (await withDeadline(work, timeoutMs + 100, () => null)).value;
      if (!completion) reason = "timeout";
    } catch (error) {
      reason = `error: ${(error as Error).message}`;
    }
    let out = text;
    if (completion) {
      const check = acceptTailored(text, completion.text, facts, max);
      if (check.ok) out = check.text;
      else reason = check.reason;
    }
    await Promise.resolve(
      p.journal.write({
        at: started,
        fightId,
        mask,
        kind: "line",
        provider: p.provider.id,
        model: p.model,
        requestHash: completion?.requestHash ?? null,
        responseHash: completion?.responseHash ?? null,
        signature: completion?.signature ?? null,
        signatureVerified: completion?.signatureVerified ?? false,
        costUsd: completion?.costUsd ?? 0,
        latencyMs: this.#now() - started,
        source: out === text && reason ? "default" : "model",
        reason,
        outcome: JSON.stringify(out),
      }),
    ).catch(() => undefined);
    return out;
  }
}

function rivalryTag(mask: MaskId, rivalName: string): Tag | null {
  const rival = (Object.keys(MANNERS) as MaskId[]).find((m) => MANNERS[m].name === rivalName.toUpperCase() || m === rivalName);
  return rival && rival !== mask ? (`rivalry:${rival}` as Tag) : null;
}

/** Names come from strangers: cleaned and clipped before they reach a slot or a model. */
function safeFacts(facts: Facts): Facts {
  const out: Facts = { ...facts };
  if (facts.backer !== undefined) out.backer = cleanName(facts.backer);
  return out;
}

/**
 * A tailored line is accepted only if it still sounds like the mask and says nothing the fight did not: no banned
 * word, no new number, every filled name kept, within length.
 */
export function acceptTailored(
  original: string,
  candidate: string,
  facts: Facts,
  max: number,
): { ok: true; text: string } | { ok: false; reason: string } {
  const text = candidate.trim().replace(/^["'“”]+|["'“”]+$/g, "").replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, reason: "empty" };
  if (Array.from(text).length > max) return { ok: false, reason: "too long" };
  if (/[\r\n]/.test(candidate.trim())) return { ok: false, reason: "more than one line" };
  if (BANNED.test(text) && !BANNED.test(original)) return { ok: false, reason: "banned word" };
  if (NOT_BUT.test(text) && !NOT_BUT.test(original)) return { ok: false, reason: "not-but construction" };
  if (/[{}]/.test(text)) return { ok: false, reason: "unfilled slot" };
  const allowed = new Set([...numbers(original), ...Object.values(facts).flatMap((v) => (v ? numbers(v) : []))]);
  if (numbers(text).some((n) => !allowed.has(n))) return { ok: false, reason: "new number" };
  for (const v of Object.values(facts)) {
    if (v && original.includes(v) && !text.toLowerCase().includes(v.toLowerCase())) return { ok: false, reason: `dropped ${v}` };
  }
  return { ok: true, text };
}

function numbers(text: string): string[] {
  return [...text.matchAll(/\d+(?:[.,]\d+)*/g)].map((m) => m[0].replace(/,/g, ""));
}
