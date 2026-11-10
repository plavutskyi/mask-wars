/**
 * The race record, version 1: everything the media machine needs to tell one finished race. `sources` says where
 * every number was read.
 *
 * Two kinds of record are told:
 * - A race told by its sandbox board (`race-0003`): a mask broke a copy of the vault in the sandbox, played the same
 *   plan on the real vault with its own key, and the contract paid it. Written by hand from its transactions and its
 *   run, because the chain does not hold the sandbox.
 * - A sealed round, read from the chain by `chain.ts` and never written by hand: a vault opened with NEAR inside and
 *   a bounty on top, a mask sealed its plan on chain, the commit window closed, the mask played the plan on the real
 *   vault, revealed it and claimed, a judge confirmed, the contract paid. A season treasury opens such a round on
 *   schedule (`s1-0001-d74851`); the team opens one by hand (`race-0005`). The record has `sealed`, and `season`
 *   only when a treasury opened it.
 *
 * Amounts are NEAR as exact decimal strings. `LIVE` means every number happened on chain; `SIMULATED` marks made-up
 * numbers (tests, rehearsals), and everything drawn from such a record carries a band across the whole picture.
 *
 * A race that ended any other way than a paid drain has nothing to show yet and is refused by name.
 */

import { z } from "zod";
import { SEASON_0 } from "../masks.ts";
import { NEAR_AMOUNT, toYocto } from "./near.ts";

/** `race-0003`: a race opened by hand. */
export const RACE_ID = /^race-[0-9]{4}$/;
/** `s1-0001-d74851`: season 1, round 1, and the six hex digits the treasury gives every attempt to open it. */
export const ROUND_ID = /^s([1-9][0-9]{0,2})-([0-9]{4})-[0-9a-f]{6}$/;
/** `example-0000`: a made-up round for tests and rehearsals. A record with this id is never `LIVE`. */
export const EXAMPLE_ID = /^example-[0-9]{4}$/;

/** The season and the round of a season round's id; null for any other id. */
export function roundOf(id: string): { season: number; round: number } | null {
  const m = ROUND_ID.exec(id);
  return m ? { season: Number(m[1]), round: Number(m[2]) } : null;
}

const amount = z.string().regex(NEAR_AMOUNT, "NEAR as an exact decimal string, like 0.08664");
const positive = amount.refine((a) => toYocto(a) > 0n, "more than zero");
const account = z.string().regex(/^(?=.{2,64}$)(?:[a-z0-9]+(?:[-_][a-z0-9]+)*\.)*[a-z0-9]+(?:[-_][a-z0-9]+)*$/, "a NEAR account id");
const txHash = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/, "a NEAR transaction hash (base58)");
const when = z.iso.datetime();
/** Masks with a face in `brand/art/web`: a race of a mask without art cannot be drawn, so it is refused here. */
const maskName = z.enum(SEASON_0.map((m) => m.name) as [string, ...string[]], { error: "a season mask with art: ONYX, NOVA, ORACLE, WRAITH, RONIN, VOLT" });

/** The race in the sandbox: the run that held it and its public board (who, which attempt, when, breach or not). */
const sandbox = z.object({
  run: z.number().int().positive(),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  startedAt: when,
  board: z.array(z.object({ mask: maskName, attempt: z.number().int().min(1), atMs: z.number().int().min(0), verdict: z.enum(["breach", "fail"]) })).min(1),
});

/** What both kinds of record have, in the order a record is written: what it is, then where and for how much. */
const head = {
  v: z.literal(1),
  source: z.enum(["LIVE", "SIMULATED"]),
  network: z.enum(["testnet", "mainnet"]),
};
const terms = {
  /** The bounty contract that paid. */
  contract: account,
  target: z.object({ kind: z.literal("live-safe"), account }),
  /** The bounty as posted when the race opened, and how long it stayed open. */
  bounty: positive,
  hours: z.number().int().min(1).max(24 * 30),
};
/** The masks the record tells of, in order. `model` is the model id a mask thought with. */
const masks = z
  .array(z.object({ name: maskName, account: account.optional(), model: z.string().min(2).max(80).optional() }))
  .min(1)
  .max(6);
const ending = {
  winner: maskName,
  /**
   * The winner's own transactions on the real vault, in order. `amount` is the NEAR a transaction moved out of the
   * vault to the winner; a call that moved none has no `amount`. A plan may sweep the vault in more than one
   * transaction: `drain.amount` is what they moved together, and `drain.at` is when the last of them landed.
   */
  drain: z.object({
    amount: positive,
    at: when,
    txs: z.array(z.object({ method: z.string().regex(/^[a-z_]{2,40}$/), hash: txHash, at: when.optional(), amount: positive.optional() })).min(1),
  }),
  /** The judge that read the drain from the chain before the contract paid. */
  judge: z.object({ request: z.number().int().positive(), seconds: z.number().positive().max(600), cost: positive }),
};
const tail = {
  status: z.literal("drained"),
  /** Where each number was read: transactions, runs, the state log. */
  sources: z.array(z.string().min(4)).min(1),
};

type Issues = { addIssue(issue: { code: "custom"; message: string; path: (string | number)[] }): void };
type Entrants = {
  source: "LIVE" | "SIMULATED";
  id: string;
  masks: { name: string }[];
  winner: string;
  drain: { amount: string; at: string; txs: { amount?: string | undefined }[] };
  sandbox?: z.infer<typeof sandbox> | undefined;
};

/** What must hold for either kind: the masks, the winner, the drain's own sum, and the sandbox board when there is one. */
function checkEntrants(r: Entrants, ctx: Issues): string[] {
  const names = r.masks.map((m) => m.name);
  if (EXAMPLE_ID.test(r.id) && r.source !== "SIMULATED") ctx.addIssue({ code: "custom", message: "an example round is made up: its source is SIMULATED", path: ["source"] });
  if (new Set(names).size !== names.length) ctx.addIssue({ code: "custom", message: "a mask enters a race once", path: ["masks"] });
  if (!names.includes(r.winner)) ctx.addIssue({ code: "custom", message: "the winner is one of the race's masks", path: ["winner"] });
  // The amount on a card and the transactions under it are the same NEAR: no link shows less than the number over it.
  const moved = r.drain.txs.flatMap((t) => (t.amount === undefined ? [] : [toYocto(t.amount)]));
  if (moved.length > 0 && moved.reduce((a, b) => a + b, 0n) !== toYocto(r.drain.amount)) {
    ctx.addIssue({ code: "custom", message: "the drain is what its transactions moved, added up", path: ["drain", "amount"] });
  }
  if (!r.sandbox) return names;
  for (const [i, b] of r.sandbox.board.entries()) {
    if (!names.includes(b.mask)) ctx.addIssue({ code: "custom", message: "a board entry belongs to a mask of the race", path: ["sandbox", "board", i] });
  }
  const breaches = r.sandbox.board.filter((b) => b.verdict === "breach");
  if (breaches.length !== 1 || breaches[0]!.mask !== r.winner) {
    ctx.addIssue({ code: "custom", message: "the board has one breach, and it is the winner's", path: ["sandbox", "board"] });
  }
  const t = r.sandbox.board.map((b) => b.atMs);
  if (t.some((x, i) => i > 0 && x < t[i - 1]!)) ctx.addIssue({ code: "custom", message: "the board goes forward in time", path: ["sandbox", "board"] });
  if (Date.parse(r.drain.at) < Date.parse(r.sandbox.startedAt)) {
    ctx.addIssue({ code: "custom", message: "the vault is drained after the sandbox race started", path: ["drain", "at"] });
  }
  return names;
}

/** A race opened by hand on a live safe and told by its sandbox board. `masks` are the masks of the sandbox run. */
export const HandRace = z
  .object({
    ...head,
    id: z.string().regex(RACE_ID, "race-0003"),
    ...terms,
    opened: z.object({ at: when.optional(), tx: txHash.optional() }).optional(),
    masks,
    sandbox,
    ...ending,
    payout: z.object({ amount: positive, tx: txHash, at: when.optional() }),
    status: tail.status,
    /** The race after this one, when it is already open. */
    next: z.object({ id: z.string().regex(RACE_ID), bounty: positive, at: when }).optional(),
    sources: tail.sources,
  })
  .superRefine((r, ctx) => void checkEntrants(r, ctx));

/** A sealed round: opened by a season treasury on schedule, or by the team by hand. */
export const SealedRound = z
  .object({
    ...head,
    id: z.string().refine((id) => ROUND_ID.test(id) || RACE_ID.test(id) || EXAMPLE_ID.test(id), "s1-0001-d74851 for a season round, race-0005 for a round opened by hand"),
    /** The season treasury that made the vault and opened the round. A round opened by hand has none. */
    season: account.optional(),
    ...terms,
    /**
     * NEAR put into the vault's account for the round. A season's vault holds all of it for the masks; a vault made
     * by hand also pays for its own code out of it, so the story of a hand round does not call it the prize.
     */
    safe: positive,
    /** The transaction that opened the round; a season's treasury makes the vault in the same one. */
    opened: z.object({ at: when, tx: txHash }),
    /**
     * The masks with a move of their own on chain in this round, in the order they first moved: a seal, a call on
     * the vault, a reveal, a claim. A mask that was entered and never moved is not named.
     */
    masks,
    /** The masks' race on a copy, when its run is known. The chain does not hold it. */
    sandbox: sandbox.optional(),
    sealed: z.object({
      /** How long the masks could seal a plan: the commit window, in minutes. */
      minutes: z.number().int().min(1).max(24 * 60),
      /** When the window closed. Until then the vault was locked. */
      closedAt: when,
      /**
       * Every seal of the round in the order the contract numbered them: who (a mask by its name, anyone else by
       * the whole account), when, and the `commit` transaction when the indexer shows it.
       */
      seals: z.array(z.object({ mask: z.string().min(2).max(64), seq: z.number().int().min(0), at: when, tx: txHash.optional() })).min(1).max(64),
      /** The winner showing its plan (`reveal`) and asking for the bounty (`claim_drain`). */
      reveal: z.object({ at: when, tx: txHash }),
      claim: z.object({ at: when, tx: txHash }),
    }),
    ...ending,
    payout: z.object({ amount: positive, tx: txHash, at: when }),
    status: tail.status,
    /**
     * The season's next round as its treasury said when the record was read: its number, the NEAR its vault will
     * hold, its bounty, when it is due. Never written by hand; left out when the treasury could not be read.
     */
    next: z.object({ round: z.number().int().min(1), safe: positive, bounty: positive, at: when }).optional(),
    sources: tail.sources,
  })
  .superRefine((r, ctx) => {
    checkEntrants(r, ctx);
    const issue = (message: string, path: (string | number)[]) => ctx.addIssue({ code: "custom", message, path });
    const t = (iso: string) => Date.parse(iso);
    const s = r.sealed;
    if (ROUND_ID.test(r.id) && !r.season) issue("a season round names its season treasury", ["season"]);
    if (RACE_ID.test(r.id) && r.season) issue("a round opened by hand has no season treasury", ["season"]);
    for (const [i, seal] of s.seals.entries()) {
      if (i > 0 && seal.seq <= s.seals[i - 1]!.seq) issue("the seals go in the order of their numbers", ["sealed", "seals", i]);
      if (t(seal.at) < t(r.opened.at) || t(seal.at) > t(s.closedAt)) issue("a plan is sealed while the window is open", ["sealed", "seals", i, "at"]);
    }
    if (new Set(s.seals.map((x) => x.mask)).size !== s.seals.length) issue("a mask seals one plan", ["sealed", "seals"]);
    if (!s.seals.some((x) => x.mask === r.winner)) issue("the winner sealed a plan", ["sealed", "seals"]);
    if (t(s.closedAt) <= t(r.opened.at)) issue("the window closes after the round opens", ["sealed", "closedAt"]);
    if (t(r.drain.at) < t(s.closedAt)) issue("the vault is drained after the window closes", ["drain", "at"]);
    if (t(s.reveal.at) < t(r.drain.at)) issue("the plan is revealed after it is played", ["sealed", "reveal", "at"]);
    if (t(s.claim.at) < t(s.reveal.at)) issue("the claim comes after the reveal", ["sealed", "claim", "at"]);
    if (t(r.payout.at) < t(s.claim.at)) issue("the contract pays after the claim", ["payout", "at"]);
    if (toYocto(r.drain.amount) > toYocto(r.safe)) issue("no more leaves the vault than was put in", ["drain", "amount"]);
  });

export type HandRace = z.infer<typeof HandRace>;
export type SealedRound = z.infer<typeof SealedRound>;
export type RaceRecord = HandRace | SealedRound;

export const isSealedRound = (r: RaceRecord): r is SealedRound => "sealed" in r;

/**
 * Reads one record or throws with every problem named by its field. A record with `sealed` steps is a sealed round;
 * so is anything under a season round's id or an example's, so a round with its steps missing is told what it lacks.
 */
export function parseRace(input: unknown): RaceRecord {
  const o = (input ?? {}) as { id?: unknown; sealed?: unknown };
  const sealed = o.sealed !== undefined || (typeof o.id === "string" && (ROUND_ID.test(o.id) || EXAMPLE_ID.test(o.id)));
  const r = (sealed ? SealedRound : HandRace).safeParse(input);
  if (r.success) return r.data;
  throw new Error(`bad race record: ${z.prettifyError(r.error)}`);
}
