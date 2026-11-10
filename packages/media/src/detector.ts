/**
 * The detector: one moment gives the jobs the media machine runs: a card and a draft.
 * A win under ×3 gives nothing: the card is for the moments people brag about.
 */

import type { DraftText } from "./copy.ts";
import { draftFor } from "./copy.ts";
import type { MediaEvent } from "./event.ts";
import { parseEvent } from "./event.ts";
import { multiple, parseUsdc } from "./money.ts";

export const WIN_CARD_MIN_MULTIPLE = 3;

export type CardKind = "win" | "lose" | "unmask" | "birth" | "seal";

export type MediaJob =
  | { kind: "card"; key: string; card: CardKind; event: MediaEvent }
  | { kind: "draft"; key: string; draft: DraftText; media: string | null; source: MediaEvent["source"] };

/** The one name of this moment: the same moment twice gives the same key, and the queue keeps it once. */
export function momentKey(e: MediaEvent): string {
  switch (e.type) {
    case "win_card":
      return `win:${e.fightId}:${e.handle.replace(/^@/, "").toLowerCase()}`;
    case "lose_card":
      return `lose:${e.fightId}:${e.handle.replace(/^@/, "").toLowerCase()}`;
    case "card_grid":
      return `grid:${e.day}:${e.handle.replace(/^@/, "").toLowerCase()}`;
    case "mask_birth":
      return `birth:${e.mask}`;
    case "unmask":
      return `unmask:${e.mask}`;
    case "seal_broken":
      return `seal:${e.mask}:${e.at}`;
  }
}

const CARD: Partial<Record<MediaEvent["type"], CardKind>> = {
  win_card: "win",
  lose_card: "lose",
  unmask: "unmask",
  mask_birth: "birth",
  seal_broken: "seal",
};

export function winMultiple(e: Extract<MediaEvent, { type: "win_card" }>): number {
  return multiple(parseUsdc(e.stake), parseUsdc(e.payout));
}

/** Accepts the raw JSON too: an event that does not read cleanly gives an error, never a guess. */
export function fromFightEvent(input: unknown): MediaJob[] {
  const event = parseEvent(input);
  if (event.type === "win_card" && winMultiple(event) < WIN_CARD_MIN_MULTIPLE) return [];
  const key = momentKey(event);
  const jobs: MediaJob[] = [];
  const card = CARD[event.type];
  if (card) jobs.push({ kind: "card", key: `${key}:card`, card, event });
  const media = card ? `${key}:card` : null;
  jobs.push({ kind: "draft", key, draft: draftFor(event), media, source: event.source });
  return jobs;
}
