/**
 * The keeper's two moves around a sealed round with the people's masks (src/keeper.ts), in the `arm` and `settle` jobs
 * of `Live race`, which run in the `live-race` environment, the only place `KEEPER_SEED` lives.
 *
 *   BOUNTY=h0001-… KEEPER_SEED=<64 hex> node scripts/keeper.ts arm
 *   BOUNTY=h0001-… KEEPER_SEED=<64 hex> COSTS=brain-costs.json node scripts/keeper.ts settle
 *
 * `arm` arms every person's mask on the round's list for this round and writes `humans=<JSON>` to `$GITHUB_OUTPUT`:
 * each armed mask's name, account, model and style, all public on the factory, for the race job. A round with none of
 * the people's masks needs no seed and writes `humans=[]`: the season's rounds run as before.
 *
 * `settle` settles each armed mask with what its mind spent in the race (`COSTS`, written by the race job), turned into
 * NEAR at the price 1Click shows for NEAR right now (`NEAR_USD` if set), rounded down, never more than the race held.
 * The costs file names its round, and a file of another round settles nothing. A mask whose sealed plan is still in
 * play keeps its keys for as long as the bounty contract would take its claim (open, and the claim grace not over);
 * run `settle` again after that (the `Keeper` workflow), or anyone releases the hold after the factory's
 * `release_minutes`, and then the mind pays nothing.
 *
 * Optional: `MASK_FACTORY`, `KEEPER_ACCOUNT` (the factory's keeper), `BOUNTY_CONTRACT`, `BOUNTY_TEAM` (comma-separated)
 * and `NEAR_RPC`; by default the factory, the admin, the bounty contract, the admin and the RPC of MASKWARS_NETWORK
 * (packages/network).
 */
import { appendFile, readFile } from "node:fs/promises";
import { armHumans, costsFor, costYocto, humansOf, settleHumans, stillInPlay, keeperKey, type KeeperOptions } from "../src/keeper.ts";
import { JsonRpc, view } from "../src/near-tx.ts";
import { NET } from "@maskwars/network";
import { onThisNetwork } from "../src/net.ts";

const fail = (why: string): never => {
  console.error(why);
  process.exit(1);
};
const output = async (line: string) => {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${line}\n`);
};
const summary = async (lines: string[]) => {
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
};

const move = process.argv[2];
if (move !== "arm" && move !== "settle") fail("usage: keeper.ts arm|settle");
const bountyId = process.env.BOUNTY ?? "";
if (!/^[A-Za-z0-9_-]{8,64}$/.test(bountyId)) fail("BOUNTY: the round's id");
const factory = onThisNetwork("MASK_FACTORY", process.env.MASK_FACTORY || NET.factory);
const bountyContract = onThisNetwork("BOUNTY_CONTRACT", process.env.BOUNTY_CONTRACT || NET.bounty);
const chain = new JsonRpc(process.env.NEAR_RPC || NET.rpc[0]!);

const race = await view<{ masks: string[] } | null>(chain, bountyContract, "get_safe", { id: bountyId });
if (!race) fail(`${bountyId} is not a live race on ${bountyContract}`);
const humans = humansOf(race!.masks, factory);
if (humans.length === 0) {
  console.log(`${bountyId} lists none of the people's masks: nothing for the keeper`);
  if (move === "arm") await output("humans=[]");
  process.exit(0);
}
const seed = (process.env.KEEPER_SEED ?? "").trim();
if (!/^[0-9a-f]{64}$/.test(seed)) fail(`${bountyId} lists ${humans.length} of the people's masks: KEEPER_SEED (64 hex) is needed`);
console.log(`::add-mask::${seed}`);

const o: KeeperOptions = {
  chain,
  factory,
  keeper: onThisNetwork("KEEPER_ACCOUNT", process.env.KEEPER_ACCOUNT || NET.admin),
  seed,
  bountyContract,
  bountyId,
  team: (process.env.BOUNTY_TEAM || NET.admin).split(",").map((t) => t.trim()).filter(Boolean),
  log: (line) => console.log(line),
};
console.log(`keeper ${o.keeper}, its key ${keeperKey(seed, factory).publicKeyText} on ${factory}`);

if (move === "arm") {
  const armed = await armHumans(o).catch((e: Error) => fail(e.message));
  const ready = armed.filter((a) => a.armed && a.model && a.style);
  await output(`humans=${JSON.stringify(ready.map((a) => ({ name: a.name, account: a.account, model: a.model, style: a.style })))}`);
  await summary([`### The people's masks in ${bountyId}`, "", ...armed.map((a) => `- \`${a.account}\`: ${a.armed ? "armed" : "not armed"}, ${a.note}`)]);
  // A mask that could not be armed sits this round out; the round goes on.
  process.exit(0);
}

// settle
const costsFile = process.env.COSTS ?? "";
let spentUsd: Map<string, number>;
try {
  spentUsd = costsFor((costsFile && (await readFile(costsFile, "utf8").catch(() => ""))) || "", bountyId);
} catch (e) {
  fail((e as Error).message);
}
let nearUsd = Number(process.env.NEAR_USD ?? "");
if (!(nearUsd > 0)) {
  // 1Click's live token list, the same NEAR Intents price the site shows (packages/pay).
  const tokens = (await fetch("https://1click.chaindefuser.com/v0/tokens", { signal: AbortSignal.timeout(20_000) })
    .then((r) => r.json())
    .catch(() => [])) as { assetId?: string; blockchain?: string; price?: number }[];
  nearUsd = tokens.find((t) => t.assetId === "nep141:wrap.near" && t.blockchain === "near")?.price ?? 0;
}
if (!(nearUsd > 0)) fail("no NEAR price from 1Click and no NEAR_USD: nothing settled, the holds wait for the next run");
console.log(`NEAR at $${nearUsd}`);
const costs = new Map([...spentUsd!].map(([account, usd]) => [account, costYocto(usd, nearUsd)]));
const keep = await stillInPlay(o);
const settled = await settleHumans(o, costs, keep);
await summary([`### The keeper settles ${bountyId}`, "", ...settled.map((s) => `- \`${s.account}\`: ${s.note}`)]);
if (settled.some((s) => !s.settled && s.note.startsWith("settle failed"))) process.exit(1);
