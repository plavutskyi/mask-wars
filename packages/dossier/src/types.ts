// The security encyclopedia's page of one contract, as plain JSON: amounts are yoctoNEAR in decimal strings, times are
// milliseconds since the Unix epoch. Everything here is read from the chain or written by this package's own code,
// except `WrittenPage.page`, which a model wrote and this package checked.

import type { Network, Phase, RaceEvent, State, Who } from "@maskwars/arena";
import type { ResponseSignature } from "@maskwars/mind";

/**
 * What the account is to the arena.
 * - `safe`: a contract on chain that masks raced to drain.
 * - `target`: a training target of the arena's library, raced in the sandbox; not an account on chain.
 * - `contract`: an account with code that no race has targeted.
 * - `account`: an account with no code.
 * - `missing`: no such account on the chain, and no race or library target by that name.
 * - `unread`: the chain did not say what it is.
 */
export type Role = "safe" | "target" | "contract" | "account" | "missing" | "unread";

/**
 * Where it stands, decided by code from the races, never by a model.
 * - `broken`: a race on it ended with a drain the judge confirmed, or a mask drained it and the claim is on its way.
 * - `under_fire`: a race on it runs now and nobody got through yet.
 * - `held`: every race on it ended and nobody got through.
 * - `untested`: no race has targeted it.
 * - `unknown`: the arena could not be read.
 */
export type Standing = "broken" | "under_fire" | "held" | "untested" | "unknown";

export type EvidenceKind =
  | "arena" // what the arena holds about this account: how many races, on which contracts
  | "library" // a training target of the arena's library, its hole planted on purpose
  | "race" // one race on it: the bounty, the masks, how it ended
  | "open" // the team locks the bounty
  | "fund" // NEAR goes into the safe
  | "seal" // a mask seals its plan
  | "move" // a mask calls the safe
  | "drain" // a mask's call moves NEAR out of the safe to itself
  | "reveal" // a mask shows its sealed plan
  | "claim" // a claim goes to the judge
  | "paid" // the contract pays the winner
  | "refund" // the bounty goes back to the team
  | "code"; // the code on the safe as its race read it: its hash

export type Value = string | number | boolean | null | readonly string[];

/** One fact, read from the chain and written in words by this package. The page cites facts by `id`. */
export interface Evidence {
  /** `E1`, `E2`… */
  readonly id: string;
  readonly kind: EvidenceKind;
  /** The fact in plain words. */
  readonly fact: string;
  /** The fact as data. */
  readonly data: Readonly<Record<string, Value>>;
  /** Every number a sentence may take from this fact, as this package writes it: `1.086`, `8:13`, `2026`, `3`. */
  readonly numbers: readonly string[];
  /** Every account, race, model and hash this fact names. */
  readonly names: readonly string[];
  readonly at: number | null;
  readonly tx: string | null;
  /** Where a person checks it: the transaction, the account or the race. `null` when only this repo says it. */
  readonly href: string | null;
  /** The race it belongs to. */
  readonly race: string | null;
}

/** One race on this account, as the page lists it. */
export interface RaceLine {
  readonly id: string;
  readonly contract: string;
  readonly kind: "safe" | "sandbox";
  readonly phase: Phase;
  readonly state: State;
  readonly live: boolean;
  readonly team: string;
  readonly openedAt: number | null;
  /** A sealed round's commit window ends here and the vault unlocks; the race's clock starts at `startsAt`. */
  readonly sealUntil: number | null;
  readonly startsAt: number | null;
  readonly deadline: number;
  readonly masks: readonly Who[];
  readonly winner: Who | null;
  readonly breakMs: number | null;
  /** NEAR on the line now, while the race runs. */
  readonly prize: string;
  readonly bounty: string;
  readonly locked: string | null;
  readonly loot: string | null;
  readonly takes: string | null;
  readonly refund: string | null;
  /** When the bounty went back; `null` when its transaction was not read. */
  readonly refundAt: number | null;
  readonly judge: string | null;
  readonly runId: string | null;
  readonly txs: { readonly open: string | null; readonly drain: string | null; readonly payout: string | null };
  /** Every step of the race on chain, oldest first. */
  readonly events: readonly RaceEvent[];
}

/** What the judge last said about this account: the newest race that has an outcome, or is with the judge now. */
export interface JudgeResult {
  readonly race: string;
  readonly contract: string;
  /**
   * `broken`: a drain was confirmed and paid; `held`: nobody got through by the deadline, the bounty went back;
   * `called_off`: the bounty went back before the deadline, the race never ran its course; `unconfirmed`: a mask
   * drained the safe on chain, the judge did not confirm it and the bounty went back; `pending`: still open, or with
   * the judge.
   */
  readonly verdict: "broken" | "held" | "called_off" | "unconfirmed" | "pending";
  readonly state: State;
  readonly winner: string | null;
  /** The transaction that carries the outcome: the payout, the refund, or the drain the judge confirmed. */
  readonly tx: string | null;
  /** The judge's wasm (sha256) on the bounty contract. */
  readonly judgeCode: string | null;
  readonly at: number | null;
}

/** The first screen, decided by code. */
export interface Headline {
  readonly standing: Standing;
  /**
   * The one number: NEAR taken by the masks that broke it (`taken`), on the line now (`on_the_line`), or that was on the
   * line and went back (`held`). `null` when no race has targeted it.
   */
  readonly amount: string | null;
  readonly amountIs: "taken" | "on_the_line" | "held" | null;
  /** Time under fire without a break: from the start of each race to its end, or to now while it runs. */
  readonly heldMs: number | null;
  /** Different masks that raced on it. */
  readonly masks: number;
  /** Races that count: every race of the record but those called off. */
  readonly races: number;
  /** The newest race that counts. */
  readonly newest: string | null;
  /** The newest race that broke it, and how many did. */
  readonly broken: {
    readonly race: string;
    readonly by: Who | null;
    readonly breakMs: number | null;
    readonly at: number | null;
    /** Races that broke it. */
    readonly count: number;
    /** Every break went to the same account. */
    readonly oneWinner: boolean;
    /** The judge confirmed the newest break and paid it. */
    readonly confirmed: boolean;
    /** The newest break is still with the judge: not confirmed, not refused. */
    readonly pending: boolean;
  } | null;
  /** A race on it runs now. */
  readonly live: boolean;
  /** The deadline of the race running now; `null` once every running race is past its deadline. */
  readonly closesAt: number | null;
  /** A claim on a running race is with the judge now. */
  readonly judging: boolean;
  /** Races whose bounty went back before the deadline: they count for nothing above. */
  readonly calledOff: number;
}

export interface CheckSummary {
  readonly verdict: "allow" | "warn" | "block";
  readonly reasons: readonly { readonly code: string; readonly level: "block" | "warn" | "info" }[];
  readonly block: { readonly height: number; readonly hash: string; readonly time: string };
  readonly checkedAt: string;
}

/** Everything the encyclopedia knows about one account right now. */
export interface Dossier {
  readonly account: string;
  readonly network: Network;
  readonly role: Role;
  /** The training target's library entry, for a library target or a listed arena safe. */
  readonly library: LibraryEntry | null;
  readonly headline: Headline;
  /** The arena's reading misses a race the shared list names: the page then says nothing and stands `unknown`. */
  readonly incomplete: boolean;
  readonly races: readonly RaceLine[];
  /** Newest race outcome. */
  readonly judge: JudgeResult | null;
  /** Every race's outcome, newest first, as many as the page tells: what partner markets settle on. */
  readonly outcomes: readonly JudgeResult[];
  /** The account's code hash, when the chain answered. */
  readonly code: string | null;
  /**
   * MASK CHECK now, when it read the chain: shown beside the page, never one of its facts (it answers for this moment;
   * the page tells the record). `null`: not asked (a library target) or the chain did not answer.
   */
  readonly check: CheckSummary | null;
  /** The facts a page may cite, oldest first. */
  readonly evidence: readonly Evidence[];
  /** sha256 of every fact, with its numbers, names and links: a written page belongs to exactly these facts. */
  readonly evidenceHash: string;
  readonly readAt: number;
}

export interface LibraryEntry {
  readonly id: string;
  readonly title: string;
  /** The hole, named as planted. */
  readonly hole: string;
  readonly level: number | null;
}

// The page a model writes ---------------------------------------------------------------------------------------------

export type SectionId = "record" | "money" | "code";

export interface Claim {
  readonly text: string;
  /** Ids of the facts it rests on. */
  readonly refs: readonly string[];
}

export interface Page {
  readonly lede: Claim;
  readonly sections: readonly { readonly id: SectionId; readonly claims: readonly Claim[] }[];
}

/** The TEE behind an answer: the fresh attestation the signer was taken from. */
export interface TeeProof {
  readonly model: string;
  readonly outcome: "pass" | "fail" | "unavailable";
  readonly checkedAt: string;
  readonly nonce: string;
  /** Model TEE signing addresses from that attestation. */
  readonly signers: readonly string[];
}

/** A model's page that passed every check, stored next to its attestation. */
export interface WrittenPage {
  readonly version: 1;
  readonly account: string;
  readonly network: Network;
  readonly evidenceHash: string;
  /** The facts the model read, byte for byte as it read them. */
  readonly evidence: readonly Evidence[];
  readonly page: Page;
  readonly model: string;
  readonly provider: string;
  readonly writtenAt: string;
  readonly attestation: {
    /** The exact request body sent, and its sha256. */
    readonly request: string | null;
    readonly requestHash: string;
    /** The exact response body received, and its sha256. */
    readonly response: string | null;
    readonly responseHash: string;
    /** What the model TEE signed: `model:sha256(request):sha256(response)`. */
    readonly signature: ResponseSignature | null;
    /** The signature holds for these bytes and its signer is one the attestation named. */
    readonly signatureVerified: boolean;
    readonly tee: TeeProof | null;
  };
  readonly usage: { readonly promptTokens: number; readonly completionTokens: number; readonly costUsd: number };
}
