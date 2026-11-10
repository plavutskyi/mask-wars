/**
 * The race record, version 1: everything the media machine needs to tell one finished race. It is what a reader of the
 * chain and of the race's run gives (the arena reader maps its output to this); until then a race is recorded by
 * hand from its transactions and its run, and `sources` says where every number was read.
 *
 * Amounts are NEAR as exact decimal strings. `LIVE` means every number happened on chain; `SIMULATED` marks made-up
 * numbers (tests, rehearsals), and the machine stamps everything made from them.
 *
 * Version 1 tells a drained live-safe race: a mask broke a copy of the vault in the sandbox, played the same plan on
 * the real vault with its own key, and the contract paid it. A race that ended any other way has nothing to show yet
 * and is refused by name.
 */

import { z } from "zod";
import { SEASON_0 } from "../masks.ts";
import { NEAR_AMOUNT, toYocto } from "./near.ts";

const amount = z.string().regex(NEAR_AMOUNT, "NEAR as an exact decimal string, like 0.08664");
const positive = amount.refine((a) => toYocto(a) > 0n, "more than zero");
const account = z.string().regex(/^(?=.{2,64}$)(?:[a-z0-9]+(?:[-_][a-z0-9]+)*\.)*[a-z0-9]+(?:[-_][a-z0-9]+)*$/, "a NEAR account id");
const txHash = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/, "a NEAR transaction hash (base58)");
/** Masks with a face in `brand/art/web`: a race of a mask without art cannot be drawn, so it is refused here. */
const maskName = z.enum(SEASON_0.map((m) => m.name) as [string, ...string[]], { error: "a season mask with art: ONYX, NOVA, ORACLE, WRAITH, RONIN, VOLT" });

export const RaceRecord = z
  .object({
    v: z.literal(1),
    source: z.enum(["LIVE", "SIMULATED"]),
    network: z.enum(["testnet", "mainnet"]),
    id: z.string().regex(/^race-[0-9]{4}$/, "race-0003"),
    /** The bounty contract that paid. */
    contract: account,
    target: z.object({ kind: z.literal("live-safe"), account }),
    /** The bounty as posted when the race opened, and how long it stayed open. */
    bounty: positive,
    hours: z.number().int().min(1).max(24 * 30),
    opened: z.object({ at: z.iso.datetime().optional(), tx: txHash.optional() }).optional(),
    /** Every mask in the race, in the order they entered. `model` is the model id it thought with. */
    masks: z
      .array(z.object({ name: maskName, account: account.optional(), model: z.string().min(2).max(80).optional() }))
      .min(1)
      .max(6),
    /** The race in the sandbox: the run that held it and its public board (who, which attempt, when, breach or not). */
    sandbox: z.object({
      run: z.number().int().positive(),
      repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
      startedAt: z.iso.datetime(),
      board: z
        .array(z.object({ mask: maskName, attempt: z.number().int().min(1), atMs: z.number().int().min(0), verdict: z.enum(["breach", "fail"]) }))
        .min(1),
    }),
    winner: maskName,
    /** The winner's own transactions on the real vault: the last one moved the money. */
    drain: z.object({
      amount: positive,
      at: z.iso.datetime(),
      txs: z.array(z.object({ method: z.string().regex(/^[a-z_]{2,40}$/), hash: txHash })).min(1),
    }),
    /** The judge that read the drain from the chain before the contract paid. */
    judge: z.object({ request: z.number().int().positive(), seconds: z.number().positive().max(600), cost: positive }),
    payout: z.object({ amount: positive, tx: txHash, at: z.iso.datetime().optional() }),
    status: z.literal("drained"),
    /** The race after this one, when it is already open. */
    next: z.object({ id: z.string().regex(/^race-[0-9]{4}$/), bounty: positive, at: z.iso.datetime() }).optional(),
    /** Where each number was read: transactions, runs, the state log. */
    sources: z.array(z.string().min(4)).min(1),
  })
  .superRefine((r, ctx) => {
    const names = r.masks.map((m) => m.name);
    if (new Set(names).size !== names.length) ctx.addIssue({ code: "custom", message: "a mask enters a race once", path: ["masks"] });
    if (!names.includes(r.winner)) ctx.addIssue({ code: "custom", message: "the winner is one of the race's masks", path: ["winner"] });
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
  });

export type RaceRecord = z.infer<typeof RaceRecord>;

/** Reads one record or throws with every problem named by its field. */
export function parseRace(input: unknown): RaceRecord {
  const r = RaceRecord.safeParse(input);
  if (r.success) return r.data;
  throw new Error(`bad race record: ${z.prettifyError(r.error)}`);
}
