/**
 * The scheduled show's first step: the scheduler opens the season's round that is due (src/season.ts). It signs one
 * call, `open_next` on the treasury, with its function-call key; the treasury makes the round's safe from global code
 * and opens the sealed round on the bounty contract in that same transaction. The race on it is the next job.
 *
 *   SEASON=season.tinygif8324.testnet SCHEDULER=scheduler.tinygif8324.testnet SCHEDULER_KEY=ed25519:… \
 *     node scripts/season-open.ts
 *
 * Writes `bounty` and `challenge` to $GITHUB_OUTPUT when a round opened, or when one is already open for this slot and
 * still sealing (a run that died after `open_next`, or someone else holding the scheduler's key, opened it): the race
 * takes it as it is. Writes nothing when no round is due. Exits 1 when a slot was due and no round opened for it (the
 * treasury skipped it, or the program has no target that can run), when the treasury cannot pay for the round, or when
 * the call failed and no round for the slot shows up after it: the show must not stop quietly.
 * The network is MASKWARS_NETWORK (packages/network): its treasury, scheduler and RPC unless named. Optional: `NEAR_RPC`.
 */
import { appendFile } from "node:fs/promises";
import { NET } from "@maskwars/network";
import { onThisNetwork } from "../src/net.ts";
import { JsonRpc, NearKey } from "../src/near-tx.ts";
import { collectFinished, openNext, roundSummary } from "../src/season.ts";

const fail = (why: string): never => {
  console.error(why);
  process.exit(1);
};

const season = onThisNetwork("SEASON", process.env.SEASON || NET.season);
const scheduler = onThisNetwork("SCHEDULER", process.env.SCHEDULER || NET.scheduler);
const secret = process.env.SCHEDULER_KEY ?? "";
if (!secret) fail("SCHEDULER_KEY: the scheduler's function-call key for open_next, a repository secret");
console.log(`::add-mask::${secret}`);
const key = (() => {
  try {
    return new NearKey(secret);
  } catch (e) {
    return fail(`SCHEDULER_KEY: ${(e as Error).message}`);
  }
})();

const o = {
  chain: new JsonRpc(process.env.NEAR_RPC || NET.rpc[0]!),
  season,
  scheduler,
  key,
  log: (line: string) => console.log(line),
};
// Finished rounds first: a bounty nobody won goes back to the treasury before the next round needs it.
// A failure here never holds the show back: the next run collects them.
const collected = await collectFinished(o).catch((e: Error) => {
  console.log(`collect: ${e.message}`);
  return 0;
});
if (collected) console.log(`collected ${collected} finished round(s): settled or refunded to the treasury`);
const result = await openNext(o).catch((e: Error) => fail(e.message));

if (result.kind === "waiting" || result.kind === "missed") {
  (result.kind === "missed" ? console.error : console.log)(result.why);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${result.why}\n`);
  process.exit(result.kind === "missed" ? 1 : 0);
}
const { round } = result;
const tx = result.kind === "opened" ? result.tx : `(not this run: ${result.why})`;
console.log(`round ${round.id} is open on ${round.safe}: ${round.challenge}`);
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `bounty=${round.id}\nchallenge=${round.challenge}\n`);
}
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${roundSummary(round, tx).join("\n")}\n`);
