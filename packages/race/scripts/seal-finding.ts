/**
 * Last step of the race job of `Live race` on `live-safe` with a bounty: seals the winning plan for the drain job
 * (finding-box.ts). The race job holds no mask key. It takes the winner's NEAR account from `MASK_ACCOUNTS` and the
 * public half of its key on the bounty contract from `MASK_CLAIM_KEYS` (a repository variable, written by masks.ps1),
 * checks that the key is on chain on the bounty contract, and seals the finding for it alone: only the drain job, which
 * holds that key, opens it. A key on chain that is not on the published list gets no box. Writes `sealed=true` to
 * `$GITHUB_OUTPUT` when there is a box to hand over.
 *
 * A person's mask that won (`HUMAN_MASKS`, from the arm job) has no published list: its key on the bounty contract is
 * the one the factory put on it for this round (`BOUNTY`), and the factory's record names it (`get_mask`). The keeper
 * derived it from `KEEPER_SEED`, so only the drain job opens the box.
 *
 *   FINDING=finding.json BOX=finding-box.json MASK_ACCOUNTS='{"NOVA":"nova.…"}' MASK_CLAIM_KEYS='{"NOVA":"ed25519:…"}'
 *   node scripts/seal-finding.ts
 *
 * Optional: `BOUNTY_CONTRACT`, `MASK_FACTORY` and `NEAR_RPC`, by default those of MASKWARS_NETWORK (packages/network).
 */
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { humanMasksFrom } from "../src/brain.ts";
import { sealableKeys, sealFinding, type ListedKey } from "../src/finding-box.ts";
import type { FactoryMask } from "../src/keeper.ts";
import { JsonRpc, view } from "../src/near-tx.ts";
import { NET } from "@maskwars/network";
import { maskAccounts, onThisNetwork } from "../src/net.ts";

const output = async (line: string) => {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${line}\n`);
};
const findingFile = process.env.FINDING ?? "finding.json";
const text = await readFile(findingFile, "utf8").catch(() => null);
if (!text) {
  console.log("no winner, nothing to seal");
  await output("sealed=false");
  process.exit(0);
}
const finding = JSON.parse(text) as { attacker: string };
const accounts = maskAccounts(process.env.MASK_ACCOUNTS);
// A person's mask that won: its account comes from the arm job (`HUMAN_MASKS`), and the key the box is for is the one
// the factory put on it for this very round, as the factory's own record lists it.
const human = humanMasksFrom(process.env.HUMAN_MASKS).find((h) => h.name.toUpperCase() === finding.attacker);
const account = accounts[finding.attacker] ?? human?.account;
if (!account) {
  console.error(`${finding.attacker} has no NEAR account in MASK_ACCOUNTS or HUMAN_MASKS`);
  process.exit(1);
}
const contract = onThisNetwork("BOUNTY_CONTRACT", process.env.BOUNTY_CONTRACT || NET.bounty);
const chain = new JsonRpc(process.env.NEAR_RPC || NET.rpc[0]!);
const factoryKeys = async (name: string): Promise<string[]> => {
  const m = await view<FactoryMask | null>(chain, onThisNetwork("MASK_FACTORY", process.env.MASK_FACTORY || NET.factory), "get_mask", { name });
  return m?.race && m.race.race === process.env.BOUNTY ? [...m.race.keys] : [];
};
const published = human
  ? await factoryKeys(human.name)
  : [(JSON.parse(process.env.MASK_CLAIM_KEYS || "{}") as Record<string, string | string[]>)[finding.attacker] ?? []].flat();
if (published.length === 0) {
  console.error(`${finding.attacker} has no published key in MASK_CLAIM_KEYS: the finding is sealed for no one`);
  process.exit(1);
}
const list = (await chain.rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: account })) as {
  keys: ListedKey[];
};
// A box only for a published key that the mask holds on the bounty contract right now: the drain job opens it.
const keys = sealableKeys(list.keys, contract, published);
if (keys.length === 0) {
  console.error(`${account} holds none of its published keys on ${contract}: nothing can open the finding`);
  process.exit(1);
}
const boxes = keys.map((k) => sealFinding(text, { mask: finding.attacker, account, to: k }));
await writeFile(process.env.BOX ?? "finding-box.json", JSON.stringify(boxes));
// The plain plan stays nowhere on the runner once it is sealed.
await rm(findingFile, { force: true });
console.log(`the finding of ${finding.attacker} is sealed for ${keys.join(", ")}`);
await output("sealed=true");
