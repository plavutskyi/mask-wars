/**
 * Viewer text, cleaned before a model reads it.
 *
 * Viewers throw words at masks and the top backer gets a CORNER line. All of it is someone else's text: it is cleaned
 * here, then handed to the model inside a JSON string as data, never spliced into instructions. Two layers, because
 * either alone leaks:
 *
 * - `cleanViewer` strips what hides or reorders text (zero-width, bidi, controls, tag characters), every markdown and
 *   HTML construct that can carry a payload the reader does not see (comments, links, images, fences, headings,
 *   reference definitions), links and @handles, and role markers that imitate a chat transcript. One line, clipped.
 * - `asData` wraps cleaned items in a JSON array under a fixed key, so the model sees quoted strings, not prose.
 *
 * Based on the foreign-text gate of our other products (docs/reference/clean.ts). Pure: no clock, no network.
 */

export const VIEWER_MAX = 120;

/* Zero-width and joiner characters, the word joiner and invisible operators, the byte-order mark, the soft hyphen. */
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u2060-\u2064\uFEFF]/g;
/* Embeddings, overrides and isolates: they reorder what is shown without changing what is there. */
const BIDI = /[\u202A-\u202E\u2066-\u2069]/g;
/* C0 and C1 controls. Newlines go too: viewer text is one line. */
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;
/* Variation selectors and Unicode tag characters (invisible ASCII look-alikes). */
const MODIFIERS = /[︀-️]|\uDB40[\uDC00-\uDC7F]|[\u{E0000}-\u{E007F}]/gu;
/* Private use areas: no visible meaning, room for smuggled bytes. */
const PRIVATE = /[-]|[\u{F0000}-\u{FFFFD}]|[\u{100000}-\u{10FFFD}]/gu;

const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const MD_COMMENT = /^\s*\[(?:\/\/|comment|_)\]:\s*(?:#|<>)?\s*\(.*?\)\s*$/gim;
const FENCE = /(```|~~~)[\s\S]*?(?:\1|$)/g;
const MD_IMAGE = /!\[[^\]]*\]\([^)]*\)?/g;
const MD_LINK = /\[([^\]]*)\]\([^)]*\)?/g;
const MD_REFDEF = /^\s*\[[^\]]+\]:\s*\S.*$/gm;
const TAGS = /<\/?[a-z!][^>]{0,400}>?/gi;
const LINKS = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.|javascript:|data:)\S*/gi;
const HANDLES = /(^|[^\w])@[A-Za-z0-9_]{2,}/g;
const MD_MARKS = /(^|\s)(?:#{1,6}|>+|[-*+]\s|\d+\.)\s*/g;
const EMPHASIS = /[*_~`|\\]+/g;
/* Words that start a fake transcript turn: "system:", "assistant>", "[INST]", "<|im_start|>". */
const ROLE = /(?:^|\s)(?:system|assistant|developer|user|tool|human|ai)\s*[:>]|\[\/?inst\]|<\|[^|]*\|>/gi;

/** One viewer string, made safe to hand a model: one line, no hidden payload, no markup, at most `max` characters. */
export function cleanViewer(text: unknown, max = VIEWER_MAX): string {
  if (typeof text !== "string" || max < 1) return "";
  const once = text
    .slice(0, 4_096)
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(BIDI, "")
    .replace(MODIFIERS, "")
    .replace(PRIVATE, "")
    .replace(HTML_COMMENT, " ")
    .replace(MD_COMMENT, " ")
    .replace(FENCE, " ")
    .replace(MD_IMAGE, " ")
    .replace(MD_LINK, "$1")
    .replace(MD_REFDEF, " ")
    .replace(TAGS, " ")
    .replace(CONTROL, " ")
    .replace(LINKS, " ")
    .replace(HANDLES, "$1")
    .replace(ROLE, " ")
    .replace(MD_MARKS, "$1")
    .replace(EMPHASIS, "")
    .replace(/[<>{}[\]"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(once);
  if (chars.length <= max) return once;
  return `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/** Cleaned viewer strings as a JSON value the model reads as quoted data. Empty strings are dropped. */
export function asData(items: readonly unknown[], max = VIEWER_MAX): string[] {
  return items.map((t) => cleanViewer(t, max)).filter((t) => t.length > 0);
}

/** A backer's display name: short, no markup, no handles, safe to put in a slot. */
export function cleanName(text: unknown): string {
  // A handle is someone's name here, so keep the name and drop only the @.
  const raw = typeof text === "string" ? text.replace(/@/g, "") : text;
  return cleanViewer(raw, 24).replace(/[^\p{L}\p{N} ._-]/gu, "").trim() || "anon";
}
