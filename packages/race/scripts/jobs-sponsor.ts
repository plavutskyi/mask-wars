/**
 * The house locks the arena's masks' bonds on jobs from outside (src/sponsor.ts): a job a person posted on /jobs, or an
 * agent opened, on a round our masks play, within the network's `limits.jobs` and only once MASK CHECK did not block its
 * client. Run by the `Jobs` workflow right before the masks' own pass (`take`), which then takes those jobs with the
 * house's bonds; every bond comes back to the house when the job ends, or with `unbond` as soon as the masks' plan no
 * longer seats its mask there. The house never has more out in bonds at one time than `limits.jobs.max_out`.
 *
 *   HOUSE_KEY=ed25519:… node scripts/jobs-sponsor.ts
 *
 * `HOUSE_KEY` is the house's full key, the secret of the GitHub environment `season-mainnet` (`season` on testnet) that
 * the house's day signs with (scripts/house-open.ts): this script locks bonds only from what the house holds beyond what
 * its next round needs beside the vault (`houseKeeps`), and sends nothing while the house's day may be signing. Without
 * `HOUSE_KEY`, or with a key that is not a full key of the house (the day's function-call key of contracts/house), it
 * signs nothing, says why, and exits 0: our own jobs go on as before, and jobs from outside wait.
 *
 * Optional: `JOBS_CREW` (the crew our masks take jobs with: the house locks a bond for each of its seats at once),
 * `MASK_ACCOUNTS` and `BOUNTY_TEAM` as in scripts/jobs.ts, `NEAR_RPC`. Exits 1 when a transaction it sent failed.
 */
import { appendFile } from "node:fs/promises";
import { Jobs, jobsConfigOf } from "@maskwars/arena/jobs";
import { near } from "@maskwars/arena";
import { maskCheck, readerFor, sharedLists } from "@maskwars/check";
import { houseKeeps, NET, teams } from "@maskwars/network";
import { maskAccounts, onThisNetwork } from "../src/net.ts";
import { FailoverRpc, JsonRpc, NearKey, view } from "../src/near-tx.ts";
import { describeSponsor, sponsor } from "../src/sponsor.ts";
import { oursOn, wordOf } from "../src/work.ts";

const fail = (why: string): never => {
  console.error(why);
  process.exit(1);
};

const summary: string[] = [`### The house's bonds on jobs from outside, ${NET.id}`, ""];
const say = async (line: string) => {
  console.log(line);
  summary.push(line);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary.join("\n")}\n`);
};

const secret = (process.env.HOUSE_KEY ?? "").trim();
if (secret && process.env.GITHUB_ACTIONS === "true") console.log(`::add-mask::${secret}`);
if (!secret) {
  await say("`HOUSE_KEY` is not set in this job's environment: the house locks no bond, and jobs from outside wait for one.");
  process.exit(0);
}
const key = (() => {
  try {
    return new NearKey(secret);
  } catch (e) {
    return fail(`HOUSE_KEY: ${(e as Error).message}`);
  }
})();

const masks = maskAccounts(process.env.MASK_ACCOUNTS);
const crew = (process.env.JOBS_CREW ?? "").trim() || null;
if (crew && !/^[a-z0-9-]{3,32}$/.test(crew)) fail("JOBS_CREW: a crew id, 3 to 32 lowercase letters, digits or -");
const team = process.env.BOUNTY_TEAM ? process.env.BOUNTY_TEAM.split(",").map((t) => t.trim()).filter(Boolean) : [...teams(NET)];
for (const t of team) onThisNetwork("BOUNTY_TEAM", t);
// This job holds no mask's seed: the plan it runs counts every mask as one that signs, as the masks' own pass will.
const ours = oursOn(NET, { masks, signers: Object.keys(masks), crew, teams: team });

const rpcs = [process.env.NEAR_RPC, ...NET.rpc].filter((u): u is string => Boolean(u));
const chain = new FailoverRpc(rpcs.map((u) => new JsonRpc(u)));
const jobs = new Jobs({ config: { ...jobsConfigOf(NET), rpc: rpcs }, ttlMs: 0 });
const checkReader = readerFor(NET.id, { env: process.env });
const check = async (account: string) => {
  const r = await maskCheck(account, { network: NET.id, reader: checkReader, list: sharedLists[NET.id] });
  // A chain MASK CHECK could not read is no answer here, whatever it shows a person: the house locks nothing on it.
  const word = wordOf(r);
  console.log(`MASK CHECK ${account}: ${word ?? "no answer"}, ${r.summary}`);
  return word;
};
/** The end of the seals of the house's latest round: the vault names it, the bounty contract holds its window. */
const houseSealUntil = async (): Promise<number | null> => {
  const lock = await view<{ arbiter?: string; bounty?: string } | null>(chain, NET.vault, "get_round", {}).catch(() => null);
  if (!lock?.bounty || lock.arbiter !== NET.bounty) return null;
  const r = await view<{ commit_until?: string } | null>(chain, NET.bounty, "get_round", { id: lock.bounty }).catch(() => null);
  return r?.commit_until ? Number(BigInt(r.commit_until) / 1_000_000n) : null;
};

const pass = await sponsor({
  chain,
  jobs,
  jobsContract: NET.jobs,
  crewsContract: NET.crews,
  ours,
  house: NET.house,
  key,
  keeps: houseKeeps(NET),
  check,
  houseSealUntil,
  round: NET.round,
  log: (line) => console.log(line),
}).catch((e: Error) => fail(`the chain did not answer: ${e.message}`));

const at = new Date(pass.board.readAt).toISOString().slice(0, 16).replace("T", " ");
summary.push(
  `Block ${pass.board.block?.height ?? "-"}, ${at} UTC: the house has ${near(pass.plan.out)} NEAR out in bonds (${near(ours.outside.maxOut)} at most at one time) and can lock ${near(pass.plan.spare > 0n ? pass.plan.spare : 0n)} NEAR more beyond what its next round needs`,
  "",
);
for (const d of pass.done) summary.push(`- ${d.ok ? "✓" : "✗"} ${describeSponsor(d.act)}${d.hash ? `: \`${d.hash}\`` : ""}${d.ok ? "" : ` — ${d.error}`}`);
for (const s of pass.plan.skips) {
  console.log(`  ${s.job}: ${s.why}`);
  summary.push(`- ${s.job}: ${s.why}`);
}
if (pass.done.length === 0 && pass.plan.skips.length === 0) summary.push("- no job from outside waits for the house's bonds");
console.log(summary.slice(2).join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary.join("\n")}\n`);
if (pass.done.some((d) => !d.ok)) process.exitCode = 1;
