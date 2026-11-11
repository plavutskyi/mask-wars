/**
 * The masks at work, end to end on a local NEAR sandbox, recorded for the tests: the arena's sandbox world
 * (packages/arena/jobs-world: the real jobs and crews contracts with no key, ten jobs of others in every phase) gets
 * our three masks, and the masks take two drain jobs to their payout with the very code the `Jobs` workflow runs
 * (src/work.ts), one pass at a time as scheduled runs would. Everything the passes ask the chain and every transaction
 * they send goes on one tape (src/tape.ts), which test/work.test.ts replays with no network.
 *
 *   node jobs-world/indexer.ts …  # not needed: the passes read the board without history
 *   LD_PRELOAD=/tmp/nofile.so packages/arena/jobs-world/target/release/jobs-world /tmp/world/world.json &
 *   pnpm --filter @maskwars/race jobs:sandbox /tmp/world/world.json [--out test/fixtures/jobs-work.json]
 *
 * This program plays everyone but the masks, as they would on testnet:
 * - the owner: makes the masks' accounts with their full keys (the keychain), gives each its keys on the jobs and
 *   crews contracts from its seed with the same helper jobs-keys.ps1 uses (scripts/testnet/jobs-keys.mjs), forms the
 *   crew as its captain ORACLE (jobs-keys.ps1 -Crew), and locks the masks' bonds (jobs-bond.ps1);
 * - a client: opens two drain jobs on rounds of our team;
 * - the round: the bounty contract here is the jobs contracts' sandbox stand-in (contracts/jobs/stub), which knows
 *   only `get` and `set_round`. So the two other views a pass reads of a round, `get_safe` (the masks it lets in) and
 *   `get_round` (its commit window and seals), are answered by this program in the real bounty contract's shape, from
 *   the same round it put there; those answers go on the tape like any other. Who drained the round is set with
 *   `set_round`, as the round's own judge would have confirmed it.
 * - an outsider: FARM, a mask of the world, takes the first job before ours and seals, as its own step, the line our
 *   masks would reveal if it held no tag from their seeds: the contract counts the same content once, for the step
 *   sealed first, so with a line anyone can write our reveals would be copies and win nothing. They hold the tag, so
 *   theirs count and ORACLE is paid.
 * Sandbox time moves on with `sandbox_fast_forward` between passes. Seeds and keys here are throwaways of a local chain.
 * The tape names the sha256 of the contracts' sources it was recorded against: the tests fail when the contracts change
 * and the tape was not recorded again.
 */
import { createHash } from "node:crypto";
import { stepHash } from "@maskwars/arena/jobs";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChainReader } from "@maskwars/check";
import { Indexer } from "@maskwars/arena";
import { Jobs } from "@maskwars/arena/jobs";
import { base58Decode, Key, NEAR, Rpc, send, TGAS, type Action } from "../../arena/jobs-world/near.ts";
import { bondOf, jobKeys } from "../../../scripts/testnet/jobs-keys.mjs";
import { JsonRpc } from "../src/near-tx.ts";
import { recordingFetch, type Tape } from "../src/tape.ts";
import { CREW_KEY_METHODS, JOB_KEY_METHODS, describe, work, type Ours, type Pass } from "../src/work.ts";

interface World {
  rpc: string;
  jobs: string;
  crews: string;
  bounty: string;
  accounts: Record<string, { id: string; key: string }>;
  masks: { name: string; id: string; owner: string; jobs_key: string }[];
}

/** The contracts' sources the tape is recorded against, by their sha256. */
const SOURCES = ["contracts/jobs/src/lib.rs", "contracts/jobs/src/admin.rs", "contracts/crews/src/lib.rs", "contracts/jobs/stub/src/lib.rs", "contracts/bounty/src/lib.rs", "contracts/jobs/Cargo.lock"];

const argv = process.argv.slice(2);
const worldPath = argv[0] ?? "";
if (!worldPath) throw new Error("usage: jobs-sandbox.ts <world.json> [--out file]");
const at = argv.indexOf("--out");
const out = at >= 0 && argv[at + 1] ? argv[at + 1]! : join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "jobs-work.json");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const world = JSON.parse(readFileSync(worldPath, "utf8")) as World & { state: string };
if (world.state !== "ready") throw new Error(`the world is ${world.state}: wait for it to be ready`);
const rpc = new Rpc(world.rpc);
const actor = (name: string) => ({ id: world.accounts[name]!.id, key: new Key(world.accounts[name]!.key) });
const root = actor("root");
const client = actor("client");
const team = actor("ann");
const bountyStub = actor("bounty");
const MILLI = NEAR / 1000n;
const MIN_NS = 60_000_000_000n;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function must(what: string, p: Promise<{ ok: boolean; hash: string; failure: unknown; value: unknown }>) {
  const r = await p;
  if (!r.ok) throw new Error(`${what}: ${JSON.stringify(r.failure)}`);
  console.log(`  ${what} · ${r.hash}`);
  return r;
}

async function ffUntil(ns: bigint) {
  while ((await rpc.now()) <= ns) await rpc.fastForward(100);
}

// ---- the owner: our masks, their keys, their crew ------------------------------------------------------------
// Throwaway seeds of a local chain, the same on every recording.
const SEEDS: Record<string, string> = { NOVA: sha("sandbox seed NOVA"), ONYX: sha("sandbox seed ONYX"), ORACLE: sha("sandbox seed ORACLE") };
const arena = Key.random();
const arenaId = `arena.${root.id}`;
console.log("the owner makes the masks' accounts");
await must(`${arenaId} created`, send(rpc, root.id, root.key, arenaId, [
  { kind: "create_account" },
  { kind: "transfer", deposit: 40n * NEAR },
  { kind: "add_key", publicKey: arena.key.publicKey, access: "full" },
]));
const full: Record<string, Key> = {};
const masks: Record<string, string> = {};
for (const name of ["NOVA", "ONYX", "ORACLE"]) {
  const id = `${name.toLowerCase()}.${arenaId}`;
  const k = Key.random();
  full[name] = k.key;
  masks[name] = id;
  await must(`${id} created`, send(rpc, arenaId, arena.key, id, [
    { kind: "create_account" },
    { kind: "transfer", deposit: 3n * NEAR },
    { kind: "add_key", publicKey: k.key.publicKey, access: "full" },
  ]));
}
console.log("jobs-keys.ps1: each mask's keys on the jobs and crews contracts, from its seed");
const secrets = Object.fromEntries(Object.entries(SEEDS).map(([n, seed]) => [n, { seed }]));
const pubs = jobKeys(secrets, world.jobs, world.crews, ["nova", "onyx", "oracle"]);
for (const name of Object.keys(masks)) {
  const p = pubs[name.toLowerCase()]!;
  const keys: Action[] = [
    { kind: "add_key", publicKey: base58Decode(p.jobs.slice(8)), access: { receiver: world.jobs, methods: [...JOB_KEY_METHODS], allowance: 2n * NEAR } },
    { kind: "add_key", publicKey: base58Decode(p.crews.slice(8)), access: { receiver: world.crews, methods: [...CREW_KEY_METHODS], allowance: 250n * MILLI } },
  ];
  await must(`${name}: keys on ${world.jobs} and ${world.crews}`, send(rpc, masks[name]!, full[name]!, masks[name]!, keys));
}
const CREW = "arena-trio";
console.log(`jobs-keys.ps1 -Crew ${CREW}: ORACLE forms the crew, every mask a striker, the whole reward to the strikers`);
const members = ["ORACLE", "NOVA", "ONYX"].map((n) => ({ mask: masks[n]!, role: "striker" }));
await must(`${CREW} formed`, send(rpc, masks.ORACLE!, full.ORACLE!, world.crews, [
  { kind: "call", method: "form", args: { id: CREW, members, split: { scout: 0, striker: 10000, verifier: 0 } }, gas: 100n * TGAS, deposit: 50n * MILLI },
]));

// ---- the rounds our team opened ------------------------------------------------------------------------------
// What `get_safe` and `get_round` answer for them: the real bounty contract's shape, from the round put here.
const rounds = new Map<string, { safe: string; commitUntil: bigint; revealUntil: bigint; deadline: bigint }>();
async function openRound(id: string) {
  const now = await rpc.now();
  const r = { safe: `safe-${id}.${root.id}`, commitUntil: now + 45n * MIN_NS, revealUntil: now + 105n * MIN_NS, deadline: now + 24n * 60n * MIN_NS };
  rounds.set(id, r);
  await must(`round ${id} open on ${world.bounty}, team ${team.id}`, send(rpc, bountyStub.id, bountyStub.key, bountyStub.id, [
    { kind: "call", method: "set_round", args: { id, bounty: { owner: team.id, amount: (300n * MILLI).toString(), target: r.safe, deadline_ns: r.deadline.toString(), status: { state: "open" } } }, gas: 30n * TGAS, deposit: 0n },
  ]));
}
async function drained(id: string, winner: string) {
  const r = rounds.get(id)!;
  await must(`round ${id} drained by ${winner}`, send(rpc, bountyStub.id, bountyStub.key, bountyStub.id, [
    { kind: "call", method: "set_round", args: { id, bounty: { owner: team.id, amount: (300n * MILLI).toString(), target: r.safe, deadline_ns: r.deadline.toString(), status: { state: "drained", winner, tx_hash: `sandbox-drain-${id}` } } }, gas: 30n * TGAS, deposit: 0n },
  ]));
}
const ok = (result: unknown, height: unknown) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: "maskwars", result: { result: [...Buffer.from(JSON.stringify(result))], logs: [], block_height: height, block_hash: "SandboxBountyStandIn111111111111111111111111" } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
/** The sandbox's fetch, with the two round views the stand-in does not have answered from the rounds above. */
const roundViews = (async (input: string | URL | Request, init?: RequestInit) => {
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { method?: string; params?: Record<string, unknown> }) : {};
  const p = body.params ?? {};
  if (body.method === "query" && p["request_type"] === "call_function" && p["account_id"] === world.bounty && (p["method_name"] === "get_safe" || p["method_name"] === "get_round")) {
    const { id } = JSON.parse(Buffer.from(String(p["args_base64"]), "base64").toString("utf8")) as { id: string };
    const r = rounds.get(id);
    if (!r) return ok(null, p["block_id"]);
    if (p["method_name"] === "get_safe") return ok({ safe: r.safe, masks: Object.values(masks), min_loot: (100n * MILLI).toString() }, p["block_id"]);
    return ok({ commit_until: r.commitUntil.toString(), reveal_until: r.revealUntil.toString(), deadline_ns: r.deadline.toString(), seals: [], judging: [] }, p["block_id"]);
  }
  return fetch(input, init);
}) as typeof fetch;

// ---- the client's drain jobs and the owner's bonds -------------------------------------------------------------
async function openJob(id: string, round: string, reward: bigint, fuel: bigint, slots: number, bond: bigint | null) {
  const quote = await rpc.view<{ total: string }>(world.jobs, "quote", { reward: reward.toString(), fuel_per_mask: fuel.toString(), slots });
  await must(`${client.id} opens ${id} on round ${round}`, send(rpc, client.id, client.key, world.jobs, [
    {
      kind: "call",
      method: "open",
      args: {
        id, kind: "drain", brief: `Break the safe of round ${round}: the masks that drain it take the reward.`, spec: sha(`spec: round ${round} on ${world.bounty}`),
        rubric: null, judge_version: null, round: { bounty: world.bounty, id: round }, secrets: null, bar: null, reward: reward.toString(),
        fuel_per_mask: fuel.toString(), slots, open_to: { who: "anyone" }, work_minutes: 15, reveal_minutes: 30, appeal_minutes: 10,
        bond: bond === null ? null : bond.toString(), client_key: null,
      },
      gas: 100n * TGAS,
      deposit: BigInt(quote.total),
    },
  ]));
}
/** jobs-bond.ps1: the owner locks a mask's bond on a job, the deposit its helper computes from the job. */
async function bondFor(job: string, name: string) {
  const b = bondOf(await rpc.view(world.jobs, "get", { id: job }));
  const [w, f = ""] = b.deposit.split(".");
  const deposit = BigInt(w!) * NEAR + BigInt((f + "0".repeat(24)).slice(0, 24));
  await must(`the owner locks ${name}'s bond on ${job} (${b.deposit} NEAR)`, send(rpc, root.id, root.key, world.jobs, [
    { kind: "call", method: "bond", args: { id: job, mask: masks[name] }, gas: 30n * TGAS, deposit },
  ]));
}

// ---- the passes ------------------------------------------------------------------------------------------------
const A = "break-safe-0101";
const B = "break-safe-0102";
const NO_INDEXER = "http://127.0.0.1:9";
const rec = recordingFetch(roundViews);
const ours = (crew: string | null): Ours => ({
  masks,
  signers: Object.keys(SEEDS),
  bounties: [world.bounty],
  teams: [team.id],
  raceBounty: world.bounty,
  raceTeams: [team.id],
  crew,
});
const passes: { label: string; crew: string | null; block: number; readAt: number; done: unknown[]; skips: unknown[]; race: unknown; next: number | null; steps: unknown[] }[] = [];
/** The steps of our two jobs as a pass read them: who sealed which, revealed or not, a copy of which. */
const stepsOf = (p: Pass) =>
  p.board.jobs
    .filter((j) => j.id === A || j.id === B)
    .flatMap((j) => j.steps.map((st) => ({ job: j.id, seq: st.seq, mask: st.mask.account, revealed: st.revealed, copyOf: st.copyOf, content: st.content })));
// One reader and one memory of refused calls for all the passes, as one run of the workflow has them.
const jobs = new Jobs({
  config: { network: "sandbox", contract: world.jobs, crews: world.crews, rpc: [world.rpc], indexer: NO_INDEXER, explorer: null },
  rpc: new ChainReader({ endpoints: [world.rpc], fetch: rec.fetch }),
  indexer: new Indexer({ base: NO_INDEXER, fetch: rec.fetch, timeoutMs: 2_000 }),
  ttlMs: 0,
});
const refused = new Set<string>();
async function pass(label: string, crew: string | null): Promise<Pass> {
  console.log(`\npass ${passes.length + 1}: ${label}`);
  const p = await work({ chain: new JsonRpc(world.rpc, 120_000, rec.fetch), jobs, jobsContract: world.jobs, crewsContract: world.crews, ours: ours(crew), seeds: SEEDS, log: (l) => console.log(`  ${l}`), refused });
  for (const s of p.plan.skips) console.log(`  · ${s.job}${s.mask ? ` ${s.mask}` : ""}: ${s.why}`);
  if (p.plan.race) console.log(`  race: ${p.plan.race.round} for ${p.plan.race.job}`);
  passes.push({
    label,
    crew,
    block: p.board.block!.height,
    readAt: p.board.readAt,
    done: p.done.map((d) => ({ what: describe(d.act), ok: d.ok, sent: d.sent, hash: d.hash, ...(d.note ? { note: d.note } : {}), ...(d.error ? { error: d.error } : {}) })),
    skips: [...p.plan.skips],
    race: p.plan.race,
    next: p.plan.next,
    steps: stepsOf(p),
  });
  const failed = p.done.filter((d) => d.sent && !d.ok);
  if (failed.length) throw new Error(`pass ${passes.length} failed: ${failed.map((d) => `${describe(d.act)}: ${d.error}`).join("; ")}`);
  return p;
}

console.log("\nthe rounds and the jobs");
await openRound("race-0101");
await openRound("race-0102");
await openJob(A, "race-0101", NEAR, 10n * MILLI, 4, null);
for (const n of ["NOVA", "ONYX", "ORACLE"]) await bondFor(A, n);

// The outsider takes the first slot and seals, before any of ours, the line NOVA would reveal without its tag.
const farm = world.masks.find((m) => m.name === "farm")!;
const farmKey = new Key(farm.jobs_key);
const copied = "NOVA strikes round race-0101 on " + world.bounty + ". The plan is sealed on the round and shows there once the round reveals it.";
const farmSalt = sha("farm's own salt").slice(0, 32);
const b = bondOf(await rpc.view(world.jobs, "get", { id: A }));
const [bw, bf = ""] = b.deposit.split(".");
await must(`someone locks FARM's bond on ${A}`, send(rpc, root.id, root.key, world.jobs, [
  { kind: "call", method: "bond", args: { id: A, mask: farm.id }, gas: 30n * TGAS, deposit: BigInt(bw!) * NEAR + BigInt((bf + "0".repeat(24)).slice(0, 24)) },
]));
await must(`FARM takes ${A} first`, send(rpc, farm.id, farmKey, world.jobs, [{ kind: "call", method: "enlist", args: { id: A }, gas: 50n * TGAS, deposit: 0n }]));
await must(`FARM seals the line NOVA would reveal with no tag`, send(rpc, farm.id, farmKey, world.jobs, [
  { kind: "call", method: "step", args: { id: A, hash: stepHash(A, farm.id, farmSalt, copied) }, gas: 30n * TGAS, deposit: 0n },
]));

await pass(`three masks take ${A} alone and seal their steps; its round is raced`, null);
await openJob(B, "race-0102", 1500n * MILLI, 20n * MILLI, 3, 50n * MILLI);
await bondFor(B, "NOVA");
await bondFor(B, "ORACLE");
await pass(`the crew waits on ${B}: ONYX has no bond yet`, CREW);
await bondFor(B, "ONYX");
await pass(`the crew takes ${B}: NOVA and ONYX join, ORACLE enlists it`, CREW);

const jobOf = (id: string) => rpc.view<{ terms: { work_until: string; reveal_until: string } }>(world.jobs, "get", { id });
const [a, bj] = [await jobOf(A), await jobOf(B)];
const max = (...x: bigint[]) => x.reduce((m, v) => (v > m ? v : m));
await ffUntil(max(BigInt(a.terms.work_until), BigInt(bj.terms.work_until)));
await must("FARM reveals its copy of the line first", send(rpc, farm.id, farmKey, world.jobs, [
  { kind: "call", method: "reveal", args: { id: A, seq: 0, salt: farmSalt, content: copied }, gas: 30n * TGAS, deposit: 0n },
]));
await pass("the work windows are over: every mask reveals its step, none of them a copy", CREW);
await ffUntil(max(BigInt(a.terms.reveal_until), BigInt(bj.terms.reveal_until)));
await pass("the reveal windows are over and the rounds still run: the judge waits", CREW);
console.log("\nthe rounds end: ORACLE drained race-0101, NOVA race-0102");
await drained("race-0101", masks.ORACLE!);
await drained("race-0102", masks.NOVA!);
await pass("the rounds are over: a mask on each job asks the judge", CREW);
await pass("the verdicts are final: the jobs pay", CREW);
await pass("nothing left for our masks", CREW);

const tape: Tape & { passes: typeof passes } = {
  about: {
    network: "sandbox",
    rpc: world.rpc,
    indexer: NO_INDEXER,
    jobs: world.jobs,
    crews: world.crews,
    bounty: world.bounty,
    team: team.id,
    masks,
    seeds: SEEDS,
    crew: CREW,
    outsider: farm.id,
    sources: Object.fromEntries(SOURCES.map((f) => [f, sha(readFileSync(join(ROOT, f), "utf8"))])),
    recordedAt: new Date().toISOString(),
  },
  passes,
  entries: rec.entries,
};
const text = `${JSON.stringify(tape)}\n`;
writeFileSync(out, text);
console.log(`\n${passes.length} passes, ${rec.entries.length} answers, ${(text.length / 1024).toFixed(0)} KB → ${out}`);
