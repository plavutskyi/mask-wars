/**
 * The writer port: a model may only offer other wordings of a draft, never facts. Every variant must keep every
 * number and handle of the original and pass lintPost, or it is dropped. OpenRouter is one implementation; it needs
 * a key the owner sets, and nothing in this package calls it on its own. Tests use a fake.
 */

import { lintPost } from "./lint.ts";

export interface Writer {
  variants(text: string, n: number): Promise<string[]>;
}

/** Numbers, money, multiples and handles: what a rewrite must keep exactly. */
export const factsOf = (t: string): string[] => (t.match(/@[A-Za-z0-9_]+|[$×]?\d[\d,.]*/g) ?? []).map((x) => x.replace(/[.,]$/, ""));

export function keepsFacts(original: string, variant: string): boolean {
  const have = new Set(factsOf(variant));
  return factsOf(original).every((f) => have.has(f)) && factsOf(variant).every((f) => factsOf(original).includes(f));
}

/** Asks the writer and keeps only what is safe to show the owner. */
export async function safeVariants(w: Writer, text: string, n = 3): Promise<string[]> {
  let raw: string[] = [];
  try {
    raw = await w.variants(text, n);
  } catch {
    return [];
  }
  return [...new Set(raw.map((v) => v.trim()))].filter((v) => v !== text && keepsFacts(text, v) && lintPost(v).length === 0).slice(0, n);
}

const PROMPT = `You rewrite one post for X in the voice of MASK WARS: short, cold, cocky, lower-case, like a person typing.
Keep every number, $ amount, ×multiple and @handle exactly. No emoji, no hashtags, no links, no dashes, no exclamation marks,
no "not X but Y". Never promise money. Answer with one rewrite per line, nothing else.`;

export type OpenRouterOptions = { apiKey: string; model: string; fetch?: typeof fetch };

export function openRouterWriter(o: OpenRouterOptions): Writer {
  const f = o.fetch ?? fetch;
  return {
    async variants(text, n) {
      const r = await f("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${o.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: o.model, messages: [{ role: "system", content: PROMPT }, { role: "user", content: `${n} rewrites of:\n${text}` }] }),
      });
      if (!r.ok) throw new Error(`openrouter ${r.status}`);
      const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
      return (j.choices?.[0]?.message?.content ?? "").split("\n").map((l) => l.replace(/^\s*(?:\d+[.)]|-)\s*/, "")).filter(Boolean);
    },
  };
}
