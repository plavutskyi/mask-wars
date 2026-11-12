/**
 * Adds the arena's live safes to the shared list of a network once their rounds are open, in the order they opened, so
 * MASK CHECK answers `arena_target` while a safe races and `arena_drained` once a mask drained it:
 *
 *   pnpm --filter @maskwars/check add-safe --network mainnet                    # every season round not listed yet
 *   pnpm --filter @maskwars/check add-safe --network mainnet --race human-0001  # a round the team opened by hand
 *   pnpm --filter @maskwars/check add-safe --network mainnet --dry              # prints what it would add, writes nothing
 *
 * The season's rounds come from its treasury (`rounds`, oldest first: s0001, s0002, … under the season's account); a
 * round by hand from the bounty contract (`get_safe`). The accounts are the network's (packages/network). The list is
 * checked before it is written; the file never says what happened to a safe, the chain does on every check. Commit the
 * change and open a pull request: the site reads the list from the repository. A round on the house's vault is never
 * added: the list names the vault once (`vault`), and the check reads its round from the vault itself.
 */
import { readFile, writeFile } from "node:fs/promises";
import { NETWORKS } from "@maskwars/network";
import { ChainError, isNetwork, type OpenedRound, parseList, readerFor, withArena } from "../src/index.ts";

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? "") : null;
};
const fail = (why: string): never => {
  console.error(why);
  process.exit(1);
};
const network = flag("--network") ?? process.env["MASKWARS_NETWORK"] ?? "testnet";
if (!isNetwork(network)) {
  console.error(`--network: testnet or mainnet, not ${network}`);
  process.exit(3);
}
const net = NETWORKS[network];
const race = flag("--race");
const file = new URL(network === "mainnet" ? "../list.mainnet.json" : "../list.json", import.meta.url);
const reader = readerFor(network, { env: process.env });

interface SeasonRound {
  id: string;
  safe: string;
  bounty: string;
}

async function opened(): Promise<OpenedRound[]> {
  if (race) {
    const safe = await reader.view<{ safe: string } | null>(net.bounty, "get_safe", { id: race });
    if (!safe) return fail(`${race} is not a live safe's round on ${net.bounty}`);
    return [{ contract: net.bounty, race, safe: safe.safe, by: "hand" }];
  }
  const rounds: OpenedRound[] = [];
  for (let from = 0; ; from += 50) {
    const page = await reader.view<SeasonRound[]>(net.season, "rounds", { from_index: from, limit: 50 });
    rounds.push(...page.map((r): OpenedRound => ({ contract: r.bounty, race: r.id, safe: r.safe, by: "season" })));
    if (page.length < 50) return rounds;
  }
}

const rounds = await opened().catch((error: unknown) => {
  if (error instanceof ChainError && error.kind === "unknown_account") return fail(`${race ? net.bounty : net.season} is not on ${network} yet: nothing to add`);
  if (error instanceof ChainError) return fail(`could not read ${network}: ${error.message}`);
  throw error;
});

const list = parseList(JSON.parse(await readFile(file, "utf8")));
if (race && rounds.some((r) => r.safe === list.vault?.safe)) {
  fail(`${race} is on the house's vault: MASK CHECK reads the vault's round from the vault itself, so it is never listed`);
}
const { list: next, added } = withArena(list, rounds);
for (const e of added) console.log(`+ ${e.race}  ${e.safe}  on ${e.contract}`);
if (added.length === 0) console.log("nothing new: every round is in the list");
else if (argv.includes("--dry")) console.log(`dry run: ${added.length} to add, nothing written`);
else {
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`${added.length} added to ${file.pathname}`);
}
