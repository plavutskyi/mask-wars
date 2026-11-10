// The arena engine's contract. It owns no data: every number, name and state comes in through these props,
// so the simulator, a live race or a recorded clip drive the same scene.

import type { ReactNode } from 'react';

/**
 * - `idle`: before the start. Masks wait in the dark, eyes low; the vault shows its sum and the countdown.
 * - `live`: the masks are out and working; each new attempt clicks the lock.
 * - `breach`: the vault cracks along its seam, splits, and the sum lifts out of it.
 * - `paid`: one pulse of money runs from the vault to the winning mask; one number.
 * - `held`: the vault held; it locks, the masks go back to the dark.
 */
export type ArenaState = 'idle' | 'live' | 'breach' | 'paid' | 'held';

export type MaskSlot = 0 | 1 | 2;

export interface ArenaMask {
  /** Look in the mask catalog: onyx, nova, oracle, wraith, ronin, volt. Unknown ids get the default obsidian look. */
  id: string;
  name: string;
  /** A forged mask brings its own look over the catalog's: the silhouette never changes (BRANDBOOK §5). */
  look?: ArenaMaskLook | undefined;
}

/** One material, one eye colour, one modifier. */
export interface ArenaMaskLook {
  finish?: 'matte' | 'gloss' | 'lacquer' | 'satin' | 'porcelain' | undefined;
  /** Eye light, hex. */
  eyes?: string | undefined;
  modifier?: 'none' | 'cracks' | 'seams' | 'brow' | 'stripe' | undefined;
}

export type MoneyUnit = 'NEAR' | 'USD';

export interface ArenaMoney {
  amount: number;
  unit: MoneyUnit;
  /** The digits exactly as the page writes them elsewhere (`near()` never rounds up). Without it, from `amount`. */
  text?: string | undefined;
}

export interface ArenaProps {
  state: ArenaState;
  /** What the vault holds; `null` when there is no race to show a sum for. */
  vault: ArenaMoney | null;
  /** The target, shown under the sum while the race is live: “Live safe”, “Lending pool”. */
  target?: string | undefined;
  /** Left, middle, right. Left is the Ember corner, right the Violet one. */
  masks: readonly [ArenaMask, ArenaMask, ArenaMask];
  /** Attempts per mask. Each increase is one strike on the lock. */
  attempts?: readonly [number, number, number] | undefined;
  /**
   * The line under each mask's name, in the page's words: “Sealed #1”, “3 tries”, “Plan shown”. Without it a live
   * race counts the tries; `null` leaves a mask with its name alone.
   */
  notes?: readonly [string | null, string | null, string | null] | undefined;
  /** The mask that broke the vault; required for `paid`, optional for `breach`. */
  winner?: MaskSlot | null | undefined;
  /** What the contract paid the winner. Defaults to the vault sum. */
  payout?: ArenaMoney | undefined;
  /** Race start, epoch ms: `idle` counts down to it. */
  startsAt?: number | undefined;
  /** How long the race ran when it ended, ms: “Broken in 3:12”, “Held 24 hours”. */
  elapsed?: number | undefined;
  /** The line under the sum, in place of the state's own: the page's words and numbers, as written elsewhere. */
  line?: string | undefined;
  /** That line is an account, not a name: set as an account reads, never in the word face. */
  lineIsAccount?: boolean | undefined;
  /** With no sum to show, what the door says in its place, at the size of a name: “Vault held”, “No race yet”. */
  headline?: string | undefined;
  /** Something quiet beside that line: the page's «i» with the race's details. */
  aside?: ReactNode;
  /** Freeze the clock at this epoch ms (previews, stills). Without it the countdown ticks on its own. */
  now?: number | undefined;
  /** Space the page keeps for its own interface over the arena, px. The scene composes inside the rest. */
  insets?: { top?: number; bottom?: number } | undefined;
  /** `auto` measures the device and steps down to the simplified scene when frames run slow. */
  quality?: ArenaQuality | undefined;
  /** Sound from the page: the arena plays through it and shows no button of its own. */
  audio?: ArenaAudioOut | undefined;
  /** The first frame of the scene is on screen. */
  onReady?: (() => void) | undefined;
  /**
   * The scene cannot run here: no WebGL 2, the engine failed, or frames stay slow on the simplest tier. With it the
   * page shows its own fallback; without it the arena falls back to the brand frames.
   */
  onFail?: (() => void) | undefined;
  className?: string | undefined;
}

/** What the arena needs from a sound player: the page's `ArenaAudio`. */
export interface ArenaAudioOut {
  play(s: ArenaSound, gain?: number): void;
}

export type ArenaQuality = 'auto' | 'high' | 'mid' | 'low';

/** Screen anchors the engine projects every frame, px inside the arena box. */
export interface Anchors {
  /** Vault centre and the radius of its door. */
  vault: { x: number; y: number; r: number };
  /** Where the sum goes when it lifts out of a broken vault. */
  lift: { x: number; y: number };
  masks: readonly [MaskAnchor, MaskAnchor, MaskAnchor];
}

export interface MaskAnchor {
  x: number;
  /** Top and bottom of the mask on screen. */
  top: number;
  bottom: number;
  /** Half the mask's width on screen. */
  half: number;
}

/** What the engine asks the page to play. */
export type ArenaSound = 'click' | 'bolt' | 'hit' | 'lock';
