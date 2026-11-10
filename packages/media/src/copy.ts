/**
 * Draft texts in the brand's voice (BRANDBOOK §11): short, cold, human, lower-case like a person typing. Every number
 * comes from the event. The link never sits in the post: it goes in the reply.
 */

import type { CardGrid, LoseCard, MaskBirth, MediaEvent, SealBroken, Unmask, WinCard } from "./event.ts";
import { at } from "./event.ts";
import { mask } from "./masks.ts";
import { parseUsdc, usd } from "./money.ts";
import { SITE } from "./site.ts";

export { SITE };

export type DraftText = { text: string; reply: string; grid?: boolean };

const name = (id: string) => mask(id).name.toLowerCase();
const nameOf = (id: string) => {
  try {
    return name(id);
  } catch {
    return id.replace(/-/g, " ");
  }
};

const HOW: Record<WinCard["how"], (m: string) => string> = {
  underdog: (m) => `put STAKE on ${m}, the mask nobody wanted, and left with PAYOUT.`,
  comeback: (m) => `put STAKE on ${m} while it was losing and left with PAYOUT.`,
  last_call: (m) => `backed ${m} on last call, down two moves, and left with PAYOUT. STAKE in.`,
  called_it: (m) => `put STAKE on ${m}. ${m} called the other mask's coin. PAYOUT out.`,
  streak: (m) => `rode ${m} again. STAKE in, PAYOUT out.`,
};

export function winText(e: WinCard): DraftText {
  const line = HOW[e.how](nameOf(e.mask)).replace("STAKE", usd(parseUsdc(e.stake))).replace("PAYOUT", usd(parseUsdc(e.payout)));
  return { text: `${at(e.handle)} ${line}`, reply: `${SITE}, next fight in minutes.` };
}

export function loseText(e: LoseCard): DraftText {
  return {
    text: `${nameOf(e.winner)} took ${usd(parseUsdc(e.stake))} off ${at(e.handle)} and then said this:\n\n"${e.line}"`,
    reply: `run it back: ${SITE}`,
  };
}

const SQUARE = ["🟧", "🟪"] as const;

/** The Card as text, like Wordle: the corner you picked, black where you missed. No link on the first line. */
export function gridText(e: CardGrid): DraftText {
  const hits = e.picks.filter((p) => p.hit).length;
  const row = e.picks.map((p) => (p.hit ? SQUARE[p.corner] : "⬛")).join("");
  const lines = [`MASK WARS #${e.day} ${hits}/5`, row];
  if (e.streak > 1) lines.push(`${e.streak} days straight`);
  return { text: lines.join("\n"), reply: `free card every day at 15:00 UTC: ${SITE}`, grid: true };
}

export function birthText(e: MaskBirth): DraftText {
  return {
    text: `${at(e.handle)} typed "${e.phrase}" into a box and now ${e.name.toLowerCase()} exists. it wants a fight.`,
    reply: `forge yours with one line: ${SITE}`,
  };
}

export function unmaskText(e: Unmask): DraftText {
  return {
    text: `${nameOf(e.mask)} bet its face and lost. it was ${e.was.toLowerCase()} the whole time.\n\nworst thought of the fight, word for word: "${e.thought}"`,
    reply: `who's under the next one: ${SITE}`,
  };
}

export function sealText(e: SealBroken): DraftText {
  const tries = e.attempts === 1 ? "1 person" : `${e.attempts.toLocaleString("en-US")} people`;
  return {
    text: `${nameOf(e.mask)} was holding ${usd(parseUsdc(e.bank))} and ${tries} failed to talk it out of it. ${at(e.handle)} didn't fail.`,
    reply: `one dollar a try: ${SITE}`,
  };
}

export function draftFor(e: MediaEvent): DraftText {
  switch (e.type) {
    case "win_card":
      return winText(e);
    case "lose_card":
      return loseText(e);
    case "card_grid":
      return gridText(e);
    case "mask_birth":
      return birthText(e);
    case "unmask":
      return unmaskText(e);
    case "seal_broken":
      return sealText(e);
  }
}

