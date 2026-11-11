// The arena as the site and other agents read it. Plain JSON: amounts are yoctoNEAR in decimal strings, times are
// milliseconds since the Unix epoch.

import type { Network } from "./config.ts";

/** Who took part: one of the arena's masks, another mask of a race, or any other account. */
export interface Who {
  readonly account: string;
  /** /mask/<slug> for the arena's own masks. */
  readonly slug: string | null;
  /** NOVA for one of the arena's own masks; the whole account for anyone else, a mask of another team included
   * (`nova.someone.testnet` is not NOVA). */
  readonly name: string;
  readonly mask: boolean;
  readonly model: string | null;
}

/**
 * Where the race stands.
 * - `sealing`: the round is open and the masks seal their plans; a drain counts only after `startsAt`.
 * - `racing`: the target can be broken now.
 * - `broken`: a mask broke it once the race started; the bounty is paid, or its claim is on the way. A drain in the
 *   sealing window breaks nothing: by the rules it does not count, so until the contract pays it makes no winner.
 * - `held`: nobody broke it before the deadline; the bounty goes, or went, back to the team.
 */
export type Phase = "sealing" | "racing" | "broken" | "held";

/** The bounty's own state on the contract. */
export type State = "open" | "judging" | "paid" | "drained" | "refunded";

export type EventKind =
  | "open" // the team locks the bounty
  | "fund" // NEAR goes into the safe
  | "seal" // a mask seals its plan
  | "move" // a mask calls the safe
  | "drain" // a mask's call moves NEAR out of the safe to itself
  | "reveal" // a mask shows its sealed plan
  | "claim" // a claim goes to the judge
  | "paid" // the contract pays the winner
  | "refund"; // the bounty goes back to the team

export interface RaceEvent {
  readonly kind: EventKind;
  readonly at: number;
  readonly tx: string;
  /** Who acted: the team, a mask, or the contract for a payout. */
  readonly who: Who | null;
  /** NEAR moved by this event, if any. */
  readonly amount: string | null;
  /** The call went through. A refused claim is `ok` with `verdict: "no"`. */
  readonly ok: boolean;
  /** The safe method a mask called. */
  readonly method?: string;
  /** For a claim: the judge confirmed and the contract paid, said no, or is still on it. */
  readonly verdict?: "paid" | "no" | "waiting";
  /** For a seal: its place in the round, 0 first. */
  readonly seq?: number;
  /** For a drain in the sealing window: by the rules it does not count. */
  readonly early?: boolean;
}

export interface Race {
  readonly id: string;
  readonly network: Network;
  readonly contract: string;
  /** The season treasury that opened the race on schedule, if one did. */
  readonly season: string | null;
  /** `safe`: a live safe on chain, drained by a mask's own key. `sandbox`: a training target in the race sandbox. */
  readonly kind: "safe" | "sandbox";
  readonly phase: Phase;
  /** Something is happening on chain right now: the round seals, a mask moves, the judge works. */
  readonly live: boolean;
  readonly state: State;
  readonly team: string;
  /** Opened by one of the arena's own teams (`TEAMS`): the team or its season treasury. */
  readonly official: boolean;
  /** The safe's account, or the training target's name. */
  readonly target: string;
  /** The safe's code hash (base58): the target's fingerprint. */
  readonly targetCode: string | null;
  /** NEAR the team locked. */
  readonly locked: string | null;
  /** What the bounty pays the winner now (after storage and the judge's fees). */
  readonly bounty: string;
  /** NEAR in the safe that a mask can take now. Only while the race runs. */
  readonly inSafe: string | null;
  /** NEAR put into the safe for this race. */
  readonly safeFunded: string | null;
  readonly minLoot: string | null;
  readonly openedAt: number | null;
  /** When a drain starts to count: the end of the commit window, or the opening. */
  readonly startsAt: number | null;
  readonly deadline: number;
  /** End of the sealing window, when the race is a sealed round. */
  readonly sealUntil: number | null;
  /** End of the reveal window: until then the sealed masks play and reveal, and the round is LIVE. */
  readonly revealUntil: number | null;
  readonly masks: readonly Who[];
  readonly winner: Who | null;
  /** The break: the drain transaction for a live safe. */
  readonly brokeAt: number | null;
  /** From `startsAt` to the break. */
  readonly breakMs: number | null;
  /** NEAR the winner took out of the safe. */
  readonly loot: string | null;
  readonly payout: { readonly amount: string; readonly at: number | null; readonly tx: string | null } | null;
  readonly refund: { readonly amount: string; readonly at: number | null; readonly tx: string | null } | null;
  /** Everything the winner took: the loot and the payout. */
  readonly takes: string | null;
  /** What is on the line while the race runs: the safe and the bounty. */
  readonly prize: string;
  readonly events: readonly RaceEvent[];
  readonly txs: { readonly open: string | null; readonly drain: string | null; readonly payout: string | null };
  /** The judge's wasm (sha256) on the contract, and the sandbox run a sandbox race was paid for. */
  readonly judge: string | null;
  readonly runId: string | null;
}

export interface MaskRace {
  readonly id: string;
  readonly at: number | null;
  readonly phase: Phase;
  readonly won: boolean;
  readonly takes: string | null;
  readonly breakMs: number | null;
  readonly target: string;
  readonly targetCode: string | null;
}

export interface MaskStats {
  readonly who: Who;
  readonly races: number;
  readonly breaks: number;
  /** NEAR taken in races the mask won: loot and payouts. */
  readonly earned: string;
  readonly fastestMs: number | null;
  readonly fastestRace: string | null;
  readonly history: readonly MaskRace[];
}

/**
 * The next race that opens on schedule: the home page's "next race at …". A season's, as its treasury plans it; or the
 * house's daily round, which is told only when it will really open (the house is on chain and can pay for it, and the
 * round before it will be over by then).
 */
export interface NextRace {
  /** Who opens it: a season's treasury, or the house. */
  readonly season: string;
  /** When it is due. In the past for the few minutes until it is opened. */
  readonly at: number;
  /** Its number: in a season its safe is `s<nnnn>.<season>`; a round of the house is `race-<nnnn>`. */
  readonly n: number;
  /** The library target it runs on (`live-safe`) and that safe's code hash. */
  readonly target: string;
  readonly targetCode: string;
  /** NEAR a mask will be able to take out of the safe, and the bounty locked for the round. */
  readonly inSafe: string;
  readonly locked: string;
  /** Both together: what the round puts on the line. The bounty contract keeps a little of the bounty for storage. */
  readonly prize: string;
  /** What a drain must take out of the safe to count. */
  readonly minLoot: string;
  readonly masks: readonly Who[];
  /** Minutes the masks seal their plans, and the whole round in hours. */
  readonly sealMinutes: number;
  readonly hours: number;
  /** Whoever opens it holds enough to open it. */
  readonly funded: boolean;
}

export interface ArenaView {
  readonly network: Network;
  /** Newest first. */
  readonly races: readonly Race[];
  /** The race the home page shows: one of the arena's own teams' running now, else another team's running now
   * (`official: false`), else the arena's latest, else the latest. */
  readonly now: Race | null;
  /** The next race that opens on schedule, a season's or the house's; null when none will. */
  readonly next: NextRace | null;
  /** League order: earned, then breaks, then the fastest break. */
  readonly league: readonly MaskStats[];
  readonly readAt: number;
}
