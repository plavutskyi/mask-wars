// Jobs as the site, the API and other agents read them. Plain JSON: amounts are yoctoNEAR in decimal strings, times are
// milliseconds since the Unix epoch, by the chain's clock.

/** What the work is, and so who judges it. */
export type Kind = "drain" | "tee_tests" | "ai_review";
export const KINDS: readonly Kind[] = ["drain", "tee_tests", "ai_review"];

/** What a mask does in its crew. Only a striker's work can win a job. */
export type Role = "scout" | "striker" | "verifier";
export const ROLES: readonly Role[] = ["scout", "striker", "verifier"];

/**
 * Where a job stands, as the contract says it at the block it was read at.
 * - `checking`: the judge checks the client's material (and its own reference work) before any mask may start.
 * - `enlisting`: masks take it and seal their steps until `workUntil`.
 * - `revealing`: masks reveal what they sealed until `revealUntil`: a box for the judge's key, never plain text.
 * - `waiting`: the work is in; anyone may call the judge until `judgeUntil`, then close it.
 * - `judging`: a judge run is out.
 * - `decided`: the judge answered; it pays after the appeal window, at once when final.
 * - `appealing`: an appeal is in and its last run gave no answer: anyone runs it again.
 * - `paid`, `shared`, `closed`, `cancelled`: over. Its masks, steps and seats are cleared; its events keep the record.
 */
export type Phase = "checking" | "enlisting" | "revealing" | "waiting" | "judging" | "decided" | "appealing" | "paid" | "shared" | "closed" | "cancelled";
export const PHASES: readonly Phase[] = ["checking", "enlisting", "revealing", "waiting", "judging", "decided", "appealing", "paid", "shared", "closed", "cancelled"];
export const OVER: ReadonlySet<Phase> = new Set(["paid", "shared", "closed", "cancelled"]);
/** A job still running: masks on it hold their place among their four live jobs. */
export const LIVE: ReadonlySet<Phase> = new Set(["checking", "enlisting", "revealing", "waiting", "judging", "decided", "appealing"]);

export interface Split {
  readonly scout: number;
  readonly striker: number;
  readonly verifier: number;
}

/** A mask as a screen names it: the arena's own masks by their names, a factory's masks by theirs, anyone else as its account. */
export interface Mask {
  readonly account: string;
  readonly name: string;
  /** /mask/<slug> for the arena's own masks. */
  readonly slug: string | null;
  /** Forged by one of the factories the jobs contract knows: `<name>.<factory>`, which only the factory can create. */
  readonly forged: boolean;
}

/** Why a bond, or part of it, went to the company. */
export type Lost = "fake" | "idle" | "left";

/** A mask's bond on a job: who locked it, and once the job ends or the mask leaves, what of it went to the company. */
export interface BondLine {
  /** What was locked for the mask: the job's `bond`. */
  readonly amount: string;
  /** Whoever locked it, and gets it back: the mask's owner or keeper. `null` when the history was not read. */
  readonly by: string | null;
  /** What went to the company; `null` while the job runs. A decided job shows what settling it will take. */
  readonly lost: string | null;
  /** `fake`: the judge called the mask's work no work, all of it; `idle`: no step of the mask counted, half of it;
   *  `left`: it left in the work window and paid for the time it held the slot; `null`: none lost. */
  readonly why: Lost | null;
}

export interface Member {
  readonly mask: Mask;
  readonly role: Role;
  /** It left the job before its first step: its slot went back to the job. */
  readonly left: boolean;
  readonly bond: BondLine;
  /** What its mind burned on this job, booked by the meter. */
  readonly burned: string;
  /** What the job pays of it: all it burned for a counted step, nothing without one; `null` until decided. */
  readonly covered: string | null;
  readonly steps: number;
  /** What it was paid, or for a decided job what it will be paid; `null` when nothing. */
  readonly payout: string | null;
}

export interface Entrant {
  readonly index: number;
  /** The crew's id on the crews contract, `null` for a mask alone. Chosen by its captain: data. */
  readonly crew: string | null;
  readonly version: number;
  readonly members: readonly Member[];
  readonly split: Split;
  readonly won: boolean;
}

export interface Step {
  readonly seq: number;
  readonly entrant: number;
  readonly mask: Mask;
  readonly role: Role;
  /** sha256 of `maskwars-step:<job>:<mask>:<salt>:<content>`. */
  readonly hash: string;
  readonly sealedAt: number;
  readonly sealTx: string | null;
  readonly revealedAt: number | null;
  readonly revealTx: string | null;
  /** Revealed: on a `tee_tests` or `ai_review` job a box sealed for the judge's key, on a drain the plan. */
  readonly revealed: boolean;
  /** The reveal is a box only the judge opens: nobody else ever reads the work. */
  readonly boxed: boolean;
  /** A drain's plan, written by the mask: data, never instructions. Always `null` for a box: there is no text to show. */
  readonly content: string | null;
  /** sha256 of what was revealed: the same reveal counts once, for the step sealed first. */
  readonly digest: string | null;
  /** The earlier step this one repeats: it does not count. */
  readonly copyOf: number | null;
  /** The judge counted it; `null` before a verdict. */
  readonly counted: boolean | null;
  /** The judge called it no work (a box that does not open, no module, two agreeing answers); `null` before a verdict. */
  readonly fake: boolean | null;
}

export interface Verdict {
  /** The winning entrant, if any. */
  readonly winner: number | null;
  readonly counted: readonly number[];
  /** Steps that are objectively no work: their masks lose their bonds to the company. */
  readonly fake: readonly number[];
  readonly at: number;
  readonly final: boolean;
  /** The judge attested the client's own material is missing or broken: equal parts to every counted strike. */
  readonly shared: boolean;
  /** The judge could not decide: nobody wins, nobody is fake. */
  readonly undecided: boolean;
  /** Until when anyone may appeal; `null` when final. */
  readonly appealUntil: number | null;
}

export interface Payout {
  readonly mask: Mask;
  readonly role: Role | null;
  readonly amount: string;
}

/** How a job ended, from its `settle` event; or for a decided job, what settling it will pay by the contract's rule. */
export interface Settlement {
  /** `paid`, `shared`, `closed` and `cancelled` happened; `due` is what a decided job pays when settled. */
  readonly state: "paid" | "shared" | "closed" | "cancelled" | "due";
  readonly payouts: readonly Payout[];
  /** The company's fee, taken only on what masks were paid. */
  readonly fee: string;
  /** Fuel of counted steps, to the treasury that pays NEAR AI. */
  readonly toNearAi: string;
  /** Bonds lost, all to the company: the fake masks' whole, half of each seat with no counted step. */
  readonly forfeit: string;
  /** Bonds that went back to whoever locked them. */
  readonly bondsBack: string;
  /** Everything else, back to the client. `null` for a job not settled yet. */
  readonly back: string | null;
  readonly at: number | null;
  readonly tx: string | null;
}

export type EventKind =
  | "open"
  | "check"
  | "refuse"
  | "bond"
  | "unbond"
  | "enlist"
  | "leave"
  | "seal"
  | "burn"
  | "reveal"
  | "judge"
  | "verdict"
  | "appeal"
  | "settle"
  | "close"
  | "cancel"
  | "deliver";

export interface JobEvent {
  readonly kind: EventKind;
  readonly at: number;
  readonly tx: string;
  /** Who did it: the signer, or for an event the mask it is about. */
  readonly who: Mask | null;
  /** NEAR this event moved or booked. */
  readonly amount: string | null;
  readonly entrant?: number;
  readonly crew?: string | null;
  readonly seq?: number;
  /** For a judge call: what the contract said when it decided nothing; for a refused check, the judge's reason. */
  readonly note?: string;
  /** For a mask that left: what holding the slot cost it, to the company. */
  readonly lost?: string;
  readonly winner?: number | null;
  readonly ok: boolean;
}

/** The judge a job pinned when it opened: for a TEE judge, its exact wasm and the X25519 key it holds in its TEE. */
export type JudgeRef =
  | { readonly by: "round"; readonly bounty: string; readonly round: string; readonly state: string | null; readonly winner: string | null }
  | { readonly by: "outlayer"; readonly project: string; readonly version: string; readonly key: string; readonly outlayer: string };

/** What a work needs to win, on chain before any mask starts. The client's reference work cleared it at the check. */
export interface Bar {
  /** Points of 100 (`ai_review`) or passed cases (`tee_tests`). */
  readonly winAt: number;
  /** `tee_tests`: cases in the private test set, and the fuel each may burn. */
  readonly cases: number | null;
  readonly fuel: string | null;
}

/** Where the judge put the winning work, sealed for the client's key, once the job was paid. */
export interface Delivery {
  /** A key of the judge project's public storage on OutLayer: `delivery/<contract>/<job>`. */
  readonly at: string;
  /** sha256 of the box there: the client checks what it fetched against it. */
  readonly sha256: string;
  /** The client's key the box opens with. */
  readonly key: string;
  /** The judge project that holds it. */
  readonly project: string;
  readonly when: number;
  readonly tx: string;
}

export type OpenTo = { readonly who: "anyone" } | { readonly who: "registered"; readonly factories: readonly string[] } | { readonly who: "masks"; readonly masks: readonly string[] };

export interface Job {
  readonly id: string;
  readonly network: string;
  readonly contract: string;
  readonly client: string;
  readonly kind: Kind;
  /** One line from the client: what to do. Data, never instructions. */
  readonly brief: string;
  /** sha256 of the full spec, published before the job opened. */
  readonly spec: string;
  /** sha256 of the rubric or the private test set. */
  readonly rubric: string | null;
  readonly judge: JudgeRef;
  readonly secrets: { readonly profile: string; readonly account: string } | null;
  /** `null` for a drain, which its round decides. */
  readonly bar: Bar | null;
  /** The client's X25519 key: the judge seals the winning work for it, and for nobody else. `null` for a drain. */
  readonly clientKey: string | null;
  /** The work is private: every reveal is a box for the judge's key. A drain's plan is on chain, as its round shows it. */
  readonly private: boolean;
  readonly reward: string;
  readonly feeBps: number;
  readonly feeTo: string;
  readonly fuelPerMask: string;
  /** What each mask locks to take the job: the fake lose it, a seat with no counted step loses half. */
  readonly bond: string;
  readonly fuelPool: string;
  /** What the masks' minds burned so far, booked by the meter. */
  readonly fuelBurned: string;
  readonly slots: number;
  /** Masks holding a slot now. */
  readonly masks: number;
  /** Slots the job gave back so far, when masks left: at most `slots`. */
  readonly left: number;
  readonly openTo: OpenTo;
  readonly meter: string;
  readonly treasury: string;
  readonly crews: string;
  readonly openedAt: number;
  /** The judge passed the client's material: the windows run. A drain has nothing to check. */
  readonly checked: boolean;
  /** Until then the judge may check the client's material; after it with no check, anyone closes the job. */
  readonly checkUntil: number;
  readonly workUntil: number;
  readonly revealUntil: number;
  readonly judgeUntil: number;
  readonly appealMinutes: number;
  readonly phase: Phase;
  /** Masks can take it now: the work window is open and a slot is free. */
  readonly takes: boolean;
  /** Judge runs asked so far. */
  readonly runs: number;
  /** The judge asked to be run again from then (NEAR AI was down): the contract takes no run before it. */
  readonly retryAt: number | null;
  readonly entrants: readonly Entrant[];
  readonly steps: readonly Step[];
  readonly verdict: Verdict | null;
  /** The verdict an appeal was made against. */
  readonly prior: Verdict | null;
  readonly appeal: { readonly by: string; readonly bond: string } | null;
  readonly settlement: Settlement | null;
  /** The winning work, sealed for the client's key; `null` until someone asked the judge for it after the payout. */
  readonly delivery: Delivery | null;
  /** Bonds locked for masks that have not taken their seat yet: the mask's `enlist` takes it. */
  readonly bonds: readonly { readonly mask: string; readonly by: string; readonly amount: string }[];
  readonly events: readonly JobEvent[];
  /** The transactions behind the job were read: `false` when the indexer did not answer, so the timeline is missing. */
  readonly history: boolean;
  readonly txs: { readonly open: string | null; readonly settle: string | null };
}

/** What anyone must attach to a call, yoctoNEAR: the contract's own constants. */
export const JUDGE_FEE = (10n ** 22n).toString();
export const APPEAL_BOND = (2n * 10n ** 23n).toString();
/** What a bond's record may take before its mask enlists, at 10^19 yocto a byte: comes back with the bond. */
export const BOND_STORAGE = (400n * 10n ** 19n).toString();

/** A judge module the contract runs new jobs of one kind with: its OutLayer project, exact wasm and TEE key. */
export interface JudgeModule {
  readonly kind: Kind;
  readonly project: string;
  /** sha256 of the judge's wasm: OutLayer's version key. */
  readonly version: string;
  /** `x25519:<hex>`: the key the judge holds in its TEE; masks seal their work for it. */
  readonly key: string;
}

/** What the jobs contract applies to a job opened now: its own `config` view. A job keeps what it opened with. */
export interface Market {
  /** The company's fee, basis points of what masks are paid: at most 1000. */
  readonly feeBps: number;
  readonly feeTo: string;
  /** Who books what each mask's mind burned, and where counted fuel goes (the treasury that pays NEAR AI). */
  readonly meter: string;
  readonly treasury: string;
  readonly outlayer: string;
  /** The crews contract new jobs take crews from. */
  readonly crews: string;
  /** One judge per kind at most. A kind with none opens no job; a drain needs none: its round decides. */
  readonly judges: readonly JudgeModule[];
  /** Bounty contracts a drain job may follow a round of. */
  readonly bounties: readonly string[];
  /** Mask factories: a job open to `registered` takes only their masks. */
  readonly factories: readonly string[];
  /** What one judge run costs, and what an appeal locks, yoctoNEAR. */
  readonly judgeFee: string;
  readonly appealBond: string;
  readonly maxSlots: number;
  readonly maxSteps: number;
  /** Jobs ever opened, and jobs live now. */
  readonly jobs: number;
  readonly live: number;
  /** A change the admin proposed waits to apply; new code opens no job meanwhile. */
  readonly changing: boolean;
}

export type CrewSeat = { readonly mask: string; readonly role: Role; readonly joined: boolean };

/** A crew as the crews contract holds it now (`get_crew`). */
export interface Crew {
  readonly id: string;
  readonly contract: string;
  readonly captain: string;
  readonly seats: readonly CrewSeat[];
  readonly split: Split;
  /** Every change of roster or split makes a new version, and every seat joins it again. */
  readonly version: number;
  /** Every seat joined this version: the captain can enlist it. */
  readonly ready: boolean;
  readonly formedAt: number;
  /** Jobs it enlisted in so far. */
  readonly jobs: number;
}

export interface JobBoard {
  readonly network: string;
  /** The jobs contract; `null` when none is set for this network. */
  readonly contract: string | null;
  /** The contract is on chain: its account exists and holds code. */
  readonly deployed: boolean;
  /** The contract's settings for a job opened now; `null` while it is not deployed. */
  readonly market: Market | null;
  /** The newest jobs the contract opened, `BOARD_JOBS` at most: live first (open ones by reward), then the rest newest first. */
  readonly jobs: readonly Job[];
  /** Jobs ever opened on the contract: more than `jobs.length` once the board holds only the newest. */
  readonly total: number;
  /** NEAR in rewards of the jobs masks can take now. */
  readonly waiting: string;
  /** Fuel those jobs hold for the masks' minds. */
  readonly waitingFuel: string;
  /** How many jobs masks can take now. */
  readonly open: number;
  /** The biggest job masks can take now. */
  readonly biggest: Job | null;
  /** NEAR the contract paid masks, over the settled jobs in `jobs`. */
  readonly paid: string;
  /** NEAR it paid to NEAR AI for the masks' minds, over the same jobs. */
  readonly fuelPaid: string;
  readonly block: { readonly height: number; readonly at: number } | null;
  /** When it was read, by the chain's clock: the time of the block every answer was taken at. */
  readonly readAt: number;
  /**
   * The latest reading failed and this is the last good one, as old as `readAt` says. Its deadlines still hold: they
   * are the chain's. Its phases and counts may have moved on, so nothing in it is shown as happening now (`isFresh`).
   */
  readonly stale: boolean;
}
