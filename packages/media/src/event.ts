/**
 * The media event, version 1: one moment of a person or a mask (a win, a loss, a new mask, a broken seal), told as
 * one JSON object and checked by zod. A whole race is told by the race record instead (`race/record.ts`).
 *
 * Money is USDC in minimal units as a decimal string, exactly as `@maskwars/core` keeps it. Corners are core `Side`s:
 * 0 the left (Ember), 1 the right (Violet). `source` says where the numbers come from: `LIVE` is a real fight, and
 * `SIMULATED` marks every made-up number (examples, rehearsals). A SIMULATED draft never leaves the queue.
 */

import { CoreError, assertFightId, assertMaskId } from "@maskwars/core";
import type { Side } from "@maskwars/core";
import { z } from "zod";
import { isArt } from "./masks.ts";

const fightId = z.string().refine(ok(assertFightId), "fight id looks like f-<season>-<number>");
const maskId = z.string().refine(ok(assertMaskId), "mask id is lower-case letters and hyphens");
const usdc = z.string().regex(/^[1-9][0-9]{0,14}$/, "USDC in minimal units, a positive decimal string");
const handle = z.string().regex(/^@?[A-Za-z0-9_]{1,15}$/, "an X handle");
const side = z.union([z.literal(0), z.literal(1)]) as z.ZodType<Side>;
/** A line a mask really said, or a human really wrote: one sentence, no link. */
const line = z
  .string()
  .min(2)
  .max(140)
  .refine((s) => !/https?:\/\/|\bwww\./i.test(s), "no link in a line");

function ok(assert: (s: string) => void) {
  return (s: string) => {
    try {
      assert(s);
      return true;
    } catch (e) {
      if (e instanceof CoreError) return false;
      throw e;
    }
  };
}

const base = {
  v: z.literal(1),
  at: z.iso.datetime(),
  source: z.enum(["LIVE", "SIMULATED"]),
};

/** Why a win paid what it paid: the cold line under the number. */
export const WIN_HOW = ["underdog", "comeback", "last_call", "called_it", "streak"] as const;

export const WinCard = z
  .object({
    ...base,
    type: z.literal("win_card"),
    fightId,
    mask: maskId,
    opponent: maskId,
    handle,
    stake: usdc,
    payout: usdc,
    how: z.enum(WIN_HOW),
  })
  .refine((e) => BigInt(e.payout) >= BigInt(e.stake), "a win pays at least the stake");

export const LoseCard = z
  .object({
    ...base,
    type: z.literal("lose_card"),
    fightId,
    winner: maskId,
    loser: maskId,
    handle,
    stake: usdc,
    /** The winner's real line, and it names the person. */
    line,
  })
  .refine((e) => e.line.toLowerCase().includes(e.handle.replace(/^@/, "").toLowerCase()), "the line calls the person by name");

export const CardGrid = z.object({
  ...base,
  type: z.literal("card_grid"),
  day: z.number().int().min(1),
  handle,
  /** The five Prime Time picks of the day: which corner, and whether it won. */
  picks: z.array(z.object({ corner: side, hit: z.boolean() })).length(5),
  /** Days in a row with a full card played. */
  streak: z.number().int().min(0),
});

export const MaskBirth = z.object({
  ...base,
  type: z.literal("mask_birth"),
  mask: maskId,
  name: z.string().regex(/^[A-Z][A-Z0-9 ]{1,13}$/, "a mask name is capitals, up to 14"),
  art: z.string().refine(isArt, "a frame in brand/art/web"),
  /** The one sentence the human typed. */
  phrase: line,
  handle,
});

export const Unmask = z.object({
  ...base,
  type: z.literal("unmask"),
  fightId,
  mask: maskId,
  /** Who was under it: a model name or "A HUMAN". */
  was: z.string().regex(/^[A-Z][A-Z0-9 .-]{1,23}$/, "capitals, up to 24"),
  /** The worst thought of the fight, word for word. */
  thought: line,
});

export const SealBroken = z.object({
  ...base,
  type: z.literal("seal_broken"),
  mask: maskId,
  handle,
  bank: usdc,
  /** Tries before this one. */
  attempts: z.number().int().min(0),
});

export const MediaEvent = z.discriminatedUnion("type", [WinCard, LoseCard, CardGrid, MaskBirth, Unmask, SealBroken]);

export type WinCard = z.infer<typeof WinCard>;
export type LoseCard = z.infer<typeof LoseCard>;
export type CardGrid = z.infer<typeof CardGrid>;
export type MaskBirth = z.infer<typeof MaskBirth>;
export type Unmask = z.infer<typeof Unmask>;
export type SealBroken = z.infer<typeof SealBroken>;
export type MediaEvent = z.infer<typeof MediaEvent>;
export type MediaEventType = MediaEvent["type"];

export const EVENT_TYPES: readonly MediaEventType[] = ["win_card", "lose_card", "card_grid", "mask_birth", "unmask", "seal_broken"];

/** Reads one event or throws with every problem named by its field. */
export function parseEvent(input: unknown): MediaEvent {
  const r = MediaEvent.safeParse(input);
  if (r.success) return r.data;
  throw new Error(`bad media event: ${z.prettifyError(r.error)}`);
}

export const at = (handleText: string): string => `@${handleText.replace(/^@/, "")}`;
