// The shared list: a plain file in the repo per network, `list.json` (testnet) and `list.mainnet.json`. Two kinds of
// entry.
// - `arena`: a live safe on the arena. The file only says where to look; what happened to the safe is read from the
//   chain on every check, so an entry can never claim a drain the chain does not show.
// - `reports`: an account someone reported, with the evidence attached. A report goes in by pull request and is
//   returned with its evidence as is.
import { z } from "zod";
import { accountOk, isMainnetName, isTestnetName } from "./account.ts";

const account = z.string().refine(accountOk, "not a NEAR account id");

export const ArenaEntry = z.object({
  /** The bounty contract that holds the race. */
  contract: account,
  race: z.string().min(1),
  /** The live safe the race is on. */
  safe: account,
  /** Who owned the safe when the race opened; anyone else owning it means a mask took it over. */
  owner_at_open: account,
  note: z.string(),
});

export const Evidence = z.union([
  z.object({ kind: z.literal("tx"), hash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/), note: z.string().optional() }),
  z.object({ kind: z.literal("url"), url: z.url(), note: z.string().optional() }),
]);

export const Report = z.object({
  account,
  level: z.enum(["block", "warn"]),
  reason: z.string().min(1),
  evidence: z.array(Evidence).min(1),
  reported_by: z.string().min(1),
  added: z.iso.date(),
});

export const SharedList = z
  .object({
    network: z.enum(["testnet", "mainnet"]),
    about: z.string(),
    arena: z.array(ArenaEntry),
    reports: z.array(Report),
  })
  .superRefine((list, ctx) => {
    // A list names accounts of its own network only: a testnet safe in the mainnet list would read as no account.
    const foreign = list.network === "mainnet" ? isTestnetName : isMainnetName;
    const named = [
      ...list.arena.flatMap((e, i) => [e.contract, e.safe, e.owner_at_open].map((a) => ({ a, path: ["arena", i] }))),
      ...list.reports.map((r, i) => ({ a: r.account, path: ["reports", i, "account"] })),
    ];
    for (const { a, path } of named) {
      if (foreign(a)) ctx.addIssue({ code: "custom", path, message: `${a} is not a ${list.network} account` });
    }
  });

export type ArenaEntry = z.infer<typeof ArenaEntry>;
export type Evidence = z.infer<typeof Evidence>;
export type Report = z.infer<typeof Report>;
export type SharedList = z.infer<typeof SharedList>;

export function parseList(raw: unknown): SharedList {
  return SharedList.parse(raw);
}

/** A live safe's round, as the season treasury (`rounds`) or the bounty contract (`get_safe`) names it. */
export interface OpenedRound {
  /** The bounty contract the round opened on. */
  readonly contract: string;
  readonly race: string;
  readonly safe: string;
  /** `season` for a round the treasury opened, `hand` for one the team opened. */
  readonly by: "season" | "hand";
}

/**
 * The list with every round not in it yet appended, in the order given (the order they opened), and the entries added.
 * A round is the same when its contract and id are. Every safe of the arena owns itself when its round opens (the
 * bounty contract refuses one that does not), so that is its owner at the opening. The result is checked like any list.
 */
export function withArena(list: SharedList, rounds: readonly OpenedRound[]): { list: SharedList; added: ArenaEntry[] } {
  const known = new Set(list.arena.map((e) => `${e.contract}/${e.race}`));
  const added: ArenaEntry[] = [];
  for (const r of rounds) {
    const key = `${r.contract}/${r.race}`;
    if (known.has(key)) continue;
    known.add(key);
    const who = r.by === "season" ? "the season's round" : "a round the team opened";
    added.push({
      contract: r.contract,
      race: r.race,
      safe: r.safe,
      owner_at_open: r.safe,
      note: `Live safe of ${r.race}, ${who}: a training target with a planted hole, open to the round's masks only.`,
    });
  }
  return { list: parseList({ ...list, arena: [...list.arena, ...added] }), added };
}
