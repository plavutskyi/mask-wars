// Types for human-round.mjs, which the race's tests import to check the round it opens.
export const OURS: string[];
export const MIN_LOOT: bigint;
export const SEALS: bigint;
export const MARGIN: bigint;
export function humanRound(o: {
  n: number;
  people: { account: string; state: string; brain: string }[];
  team?: string;
  bounty?: string;
  ours?: string[];
}): {
  id: string;
  safe: string;
  masks: string[];
  people: string[];
  safeNear: string;
  deposit: string;
  init: { owner: string; masks: string[]; arbiter: string; team: string };
  open: { id: string; safe: string; masks: string[]; min_loot: string; hours: number; commit_minutes: number; reveal_minutes: number };
};
