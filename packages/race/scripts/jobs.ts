/**
 * The masks at work on the jobs market (src/work.ts): one pass reads the board, decides and acts with each mask's own
 * function-call keys on the jobs and crews contracts, both from its seed in `MASK_KEYS`. Run by the `Jobs` workflow on
 * schedule and by hand; any pass picks up where the last one stopped, since everything it needs is on chain.
 *
 *   MASK_KEYS='{"NOVA":{"seed":"<64 hex>"},…}' node scripts/jobs.ts
 *
 * Optional:
 * - `MASK_ACCOUNTS`: our masks by name, by default the network's own (packages/network `masks`);
 * - `JOBS_CREW`: the crew our masks take jobs with, on the network's crews contract (scripts/testnet/jobs-keys.ps1
 *   -Crew forms it); without it each mask takes a job alone;
 * - `BOUNTY_TEAM`: the teams whose rounds our masks play, comma-separated, by default the network's admin and season;
 * - `RACE=1`: when a job our masks are on follows a hand round of ours that nobody sealed in yet, write `bounty` and
 *   `challenge` (`RACE_CHALLENGE`, by default live-safe) to $GITHUB_OUTPUT, so the workflow races it now;
 * - `WAIT_MINUTES`: after a pass that moved a job on, pass again at once (a settle after the verdict); after one that
 *   did not, wait for the next deadline of a job our masks are on if it comes within this long (a reveal window that
 *   opens) and pass again, until nothing comes that soon;
 * - `FOLLOW_ROUND`: the round this run raced; while it is open, or a job our masks are on waits for its round's
 *   outcome, pass every 3 minutes within `WAIT_MINUTES`: steps are revealed in a reveal window that opens while the
 *   race runs, and the judge is called as soon as the round is drained;
 * - `NEAR_RPC`: another endpoint, tried first.
 * The network is MASKWARS_NETWORK (packages/network): its jobs, crews and bounty contracts, its RPC.
 *
 * Exits 1 when a transaction a mask sent failed, so the run shows it; a job the masks leave alone, and why, is a line in
 * the log and the summary, not a failure.
 */
import { appendFile } from "node:fs/promises";
import { Jobs, jobsConfigOf } from "@maskwars/arena/jobs";
import { NET, bountyContracts, teams } from "@maskwars/network";
import { maskAccounts, onThisNetwork } from "../src/net.ts";
import { type MaskSecret, secretsOf } from "../src/keys.ts";
import { FailoverRpc, JsonRpc } from "../src/near-tx.ts";
import { describe, keepWorking, work, type Ours } from "../src/work.ts";

const fail = (why: string): never => {
  console.error(why);
  process.exit(1);
};

const keys = (() => {
  try {
    return JSON.parse(process.env.MASK_KEYS || "{}") as Record<string, MaskSecret>;
  } catch {
    return fail("MASK_KEYS: not JSON");
  }
})();
for (const secret of secretsOf(keys)) console.log(`::add-mask::${secret}`);
const masks = maskAccounts(process.env.MASK_ACCOUNTS);
const seeds: Record<string, string> = {};
for (const name of Object.keys(masks)) {
  const seed = keys[name]?.seed;
  if (seed && /^[0-9a-f]{64}$/.test(seed)) seeds[name] = seed;
  else console.log(`${name}: no seed in MASK_KEYS, so no key on the jobs contract: it sits the jobs out`);
}
if (Object.keys(seeds).length === 0) fail("MASK_KEYS: no mask has a seed: the secret of the live-race environment");

const crew = (process.env.JOBS_CREW ?? "").trim() || null;
if (crew && !/^[a-z0-9-]{3,32}$/.test(crew)) fail("JOBS_CREW: a crew id, 3 to 32 lowercase letters, digits or -");
const challenge = process.env.RACE_CHALLENGE || "live-safe";
if (!/^[a-z0-9-]{1,40}$/.test(challenge)) fail("RACE_CHALLENGE: a target of the library");
const waitMinutes = Number(process.env.WAIT_MINUTES || "0");
if (!Number.isFinite(waitMinutes) || waitMinutes < 0 || waitMinutes > 240) fail("WAIT_MINUTES: 0 to 240");
const team = process.env.BOUNTY_TEAM ? process.env.BOUNTY_TEAM.split(",").map((t) => t.trim()).filter(Boolean) : [...teams(NET)];
for (const t of team) onThisNetwork("BOUNTY_TEAM", t);

const rpcs = [process.env.NEAR_RPC, ...NET.rpc].filter((u): u is string => Boolean(u));
const chain = new FailoverRpc(rpcs.map((u) => new JsonRpc(u)));
const follow = (process.env.FOLLOW_ROUND ?? "").trim() || null;
if (follow && !/^[A-Za-z0-9_-]{1,64}$/.test(follow)) fail("FOLLOW_ROUND: a round's id on the bounty contract");
const ours: Ours = {
  masks,
  signers: Object.keys(seeds),
  bounties: bountyContracts(NET),
  teams: team,
  // The workflow races only the owner's hand rounds on the contract `Live race` plays: the season races its own.
  raceBounty: NET.bounty,
  raceTeams: [NET.admin],
  crew,
  follow,
};
const options = { chain, jobsContract: NET.jobs, crewsContract: NET.crews, ours, seeds, log: (line: string) => console.log(line) };
// One reader for the whole run, read afresh on every pass: the transactions it fetched stay with it.
const jobs = new Jobs({ config: { ...jobsConfigOf(NET), rpc: rpcs }, ttlMs: 0 });
const refused = new Set<string>();

const summary: string[] = [`### Masks at work on ${NET.id}`, ""];
let red = false;
let raced = false;

await keepWorking({
  pass: () => work({ ...options, jobs, refused }),
  waitMinutes,
  ...(follow ? { pollMs: 3 * 60_000 } : {}),
  log: (line) => console.log(line),
  onPass: async (pass, n) => {
    const at = new Date(pass.board.readAt).toISOString().slice(0, 16).replace("T", " ");
    console.log(`pass ${n} at block ${pass.board.block?.height ?? "-"} (${at} UTC): ${pass.plan.acts.length} moves, ${pass.board.open} job(s) open`);
    for (const s of pass.plan.skips) console.log(`  ${s.job}${s.mask ? ` ${s.mask}` : ""}: ${s.why}`);
    summary.push(`Pass ${n}, block ${pass.board.block?.height ?? "-"}, ${at} UTC`, "");
    for (const d of pass.done) summary.push(`- ${d.ok ? "✓" : "✗"} ${describe(d.act)}${d.note ? ` (${d.note})` : ""}${d.hash ? `: \`${d.hash}\`` : ""}${d.ok ? "" : ` — ${d.error}`}`);
    for (const s of pass.plan.skips) summary.push(`- ${s.job}${s.mask ? ` · ${s.mask}` : ""}: ${s.why}`);
    if (pass.done.length === 0 && pass.plan.skips.length === 0) summary.push("- nothing for our masks to do");
    summary.push("");
    if (pass.done.some((d) => d.sent && !d.ok)) red = true;
    if (process.env.RACE === "1" && !raced && pass.plan.race) {
      raced = true;
      const r = pass.plan.race;
      console.log(`race: ${r.round} on ${r.bounty}, the round job ${r.job} follows; nobody sealed in it yet`);
      summary.push(`Race: \`${r.round}\` (${challenge}) for job \`${r.job}\``, "");
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `bounty=${r.round}\nchallenge=${challenge}\njob=${r.job}\n`);
    }
  },
}).catch((e: Error) => {
  summary.push(`The chain did not answer: ${e.message}`);
  red = true;
  console.error(e.message);
});

if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary.join("\n")}\n`);
if (red) process.exit(1);
