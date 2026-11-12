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
 * Then the jobs from outside, with no owner's step at all: six people open drains on the house's round, as /jobs
 * opens them from their own wallets, and the Jobs workflow's sponsor (src/sponsor.ts, signing as the house) locks the
 * masks' bonds on the ones the limits let through, before the masks' own passes take them: the crew takes the first,
 * NOVA and ONYX the second alone (an outside mask took a slot first, so the crew no longer fits and the house takes
 * ORACLE's bond back once the work window is over), and the masks refuse the rest, each for its own limit: a reward
 * under the least, a second job of one client, a third job on one round, a client MASK CHECK blocks.
 *
 * This program plays everyone but the masks and the house, as they would on testnet:
 * - the owner: makes the masks' accounts with their full keys (the keychain), gives each its keys on the jobs and
 *   crews contracts from its seed with the same helper jobs-keys.ps1 uses (scripts/testnet/jobs-keys.mjs), forms the
 *   crew as its captain ORACLE (jobs-keys.ps1 -Crew), and locks the masks' bonds on our team's own jobs (jobs-bond.ps1);
 *   it also makes the house's account, as house.ps1 does, and gives the sponsor its full key (HOUSE_KEY);
 * - our team: opens two drain jobs of its own on its rounds;
 * - people: open drain jobs on the house's round with their own accounts, nothing else;
 * - MASK CHECK: a stand-in that blocks one of them, MALLORY, and lets the others through;
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
import { NearKey } from "../src/near-tx.ts";
import { describeSponsor, sponsor, type SponsorPass } from "../src/sponsor.ts";
import { recordingFetch, type Tape } from "../src/tape.ts";
import { outsideRules } from "@maskwars/arena/jobs";
import { NETWORKS } from "@maskwars/network";
import { CREW_KEY_METHODS, JOB_KEY_METHODS, describe, work, type Ours, type OutsideRules, type Pass, type Verdict } from "../src/work.ts";

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
const rounds = new Map<string, { safe: string; owner: string; commitUntil: bigint; revealUntil: bigint; deadline: bigint }>();
async function openRound(id: string, owner = team.id) {
  const now = await rpc.now();
  const r = { safe: `safe-${id}.${root.id}`, owner, commitUntil: now + 45n * MIN_NS, revealUntil: now + 105n * MIN_NS, deadline: now + 24n * 60n * MIN_NS };
  rounds.set(id, r);
  await must(`round ${id} open on ${world.bounty}, team ${owner}`, send(rpc, bountyStub.id, bountyStub.key, bountyStub.id, [
    { kind: "call", method: "set_round", args: { id, bounty: { owner, amount: (300n * MILLI).toString(), target: r.safe, deadline_ns: r.deadline.toString(), status: { state: "open" } } }, gas: 30n * TGAS, deposit: 0n },
  ]));
}
async function drained(id: string, winner: string) {
  const r = rounds.get(id)!;
  await must(`round ${id} drained by ${winner}`, send(rpc, bountyStub.id, bountyStub.key, bountyStub.id, [
    { kind: "call", method: "set_round", args: { id, bounty: { owner: r.owner, amount: (300n * MILLI).toString(), target: r.safe, deadline_ns: r.deadline.toString(), status: { state: "drained", winner, tx_hash: `sandbox-drain-${id}` } } }, gas: 30n * TGAS, deposit: 0n },
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

// ---- the drain jobs: our team's with the owner's bonds, and people's ---------------------------------------------
type Actor = { id: string; key: Key; secret?: string };
async function openJob(id: string, round: string, reward: bigint, fuel: bigint, slots: number, bond: bigint | null, by: Actor = team, work = 15, reveal = 30) {
  const quote = await rpc.view<{ total: string }>(world.jobs, "quote", { reward: reward.toString(), fuel_per_mask: fuel.toString(), slots });
  await must(`${by.id} opens ${id} on round ${round}`, send(rpc, by.id, by.key, world.jobs, [
    {
      kind: "call",
      method: "open",
      args: {
        id, kind: "drain", brief: `Break the safe of round ${round}: the masks that drain it take the reward.`, spec: sha(`spec: round ${round} on ${world.bounty}`),
        rubric: null, judge_version: null, round: { bounty: world.bounty, id: round }, secrets: null, bar: null, reward: reward.toString(),
        fuel_per_mask: fuel.toString(), slots, open_to: { who: "anyone" }, work_minutes: work, reveal_minutes: reveal, appeal_minutes: 10,
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
// The house of this chain: its own account, made by the owner below, and one of our teams (its round is the day's).
const HOUSE = `house.${root.id}`;
// The network's limits.jobs, as on mainnet: 0.5 NEAR at least, a bond of 0.1 at most, two a round, one of a client, two
// places of each mask, 0.624 NEAR out at most, windows of an hour at most. But for the site's clock: a sandbox has
// none, its passes are made here by hand, so no run of the clock is asked inside a reveal window.
const OUTSIDE: OutsideRules = { ...outsideRules(NETWORKS.mainnet), revealRuns: 0 };
const ours = (crew: string | null): Ours => ({
  masks,
  signers: Object.keys(SEEDS),
  bounties: [world.bounty],
  teams: [team.id, HOUSE],
  // The owner who locks the bonds here (bondFor) is the sandbox's root account; the house locks them on jobs from outside.
  owners: [root.id, team.id, HOUSE],
  raceBounty: world.bounty,
  // The house's rounds are raced by the season's run, not by the Jobs workflow: as on mainnet.
  raceTeams: [team.id],
  crew,
  outside: OUTSIDE,
});
/** MASK CHECK's stand-in: it blocks MALLORY's account and lets every other through. */
const BLOCKED = [`mallory.${root.id}`];
const check = async (account: string): Promise<Verdict> => (BLOCKED.includes(account) ? "block" : "allow");
const passes: { label: string; who?: "house"; crew: string | null; block: number; readAt: number; done: unknown[]; skips: unknown[]; race: unknown; next: number | null; steps: unknown[] }[] = [];
// The jobs from outside on the house's round, by who opened them and why.
const C = "race-0103-ivy001"; // IVY's, from /jobs: the crew takes it with the house's bonds
const D = "race-0103-dana01"; // DANA's: a reward under the least
const E = "race-0103-ivy002"; // IVY's second: one live job of a client at a time
const F = "race-0103-erin01"; // ERIN's: the round's second, three slots; an outside mask takes one first
const G = "race-0103-finn01"; // FINN's: the round's third, past two a round
const H = "race-0103-mal001"; // MALLORY's: MASK CHECK blocks the client
const OURS = [A, B, C, D, E, F, G, H];
/** The steps of our jobs as a pass read them: who sealed which, revealed or not, a copy of which. */
const stepsOf = (p: Pass) =>
  p.board.jobs
    .filter((j) => OURS.includes(j.id))
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
  const p = await work({ chain: new JsonRpc(world.rpc, 120_000, rec.fetch), jobs, jobsContract: world.jobs, crewsContract: world.crews, ours: ours(crew), seeds: SEEDS, check, log: (l) => console.log(`  ${l}`), refused });
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

/** One pass of the Jobs workflow's sponsor: the house reads the board and locks, or takes back, the masks' bonds. */
let houseKey: NearKey | null = null;
async function sponsorPass(label: string, crew: string | null): Promise<SponsorPass> {
  console.log(`\npass ${passes.length + 1}, the house: ${label}`);
  const p = await sponsor({
    chain: new JsonRpc(world.rpc, 120_000, rec.fetch),
    jobs,
    jobsContract: world.jobs,
    crewsContract: world.crews,
    ours: ours(crew),
    house: HOUSE,
    key: houseKey!,
    keeps: HOUSE_KEEPS,
    check,
    houseSealUntil: async () => Number((rounds.get("race-0103")?.commitUntil ?? 0n) / 1_000_000n) || null,
    // This chain keeps no daily slot: the house's day never signs here.
    round: { live: false, first_minute: 0, every_minutes: 1440 },
    log: (l) => console.log(`  ${l}`),
  });
  for (const s of p.plan.skips) console.log(`  · ${s.job}: ${s.why}`);
  passes.push({
    label,
    who: "house",
    crew,
    block: p.board.block!.height,
    readAt: p.board.readAt,
    done: p.done.map((d) => ({ what: describeSponsor(d.act), ok: d.ok, sent: true, hash: d.hash, ...(d.error ? { error: d.error } : {}) })),
    skips: [...p.plan.skips],
    race: null,
    next: null,
    steps: [],
  });
  const failed = p.done.filter((d) => !d.ok);
  if (failed.length) throw new Error(`the house's pass failed: ${failed.map((d) => `${describeSponsor(d.act)}: ${d.error}`).join("; ")}`);
  return p;
}
/** What the house keeps here whatever it locks: on mainnet its next round's deposit, gas and guests (`houseKeeps`). */
const HOUSE_KEEPS = NEAR;

console.log("\nthe rounds and our team's jobs");
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

// ---- jobs from outside: people post, the house bonds, the masks take; nobody's hand ------------------------------
console.log("\nthe house, and people who post jobs on its round");
const made = async (name: string, deposit: bigint): Promise<Actor> => {
  const id = `${name}.${root.id}`;
  const k = Key.random();
  await must(`${id} created`, send(rpc, root.id, root.key, id, [
    { kind: "create_account" },
    { kind: "transfer", deposit },
    { kind: "add_key", publicKey: k.key.publicKey, access: "full" },
  ]));
  return { id, key: k.key, secret: k.secret };
};
// house.ps1: the house's account with its full key; the sponsor signs with it (HOUSE_KEY).
const house = await made("house", 3n * NEAR);
houseKey = new NearKey(house.secret!);
const houseBefore = await rpc.call<{ amount: string }>("query", { request_type: "view_account", finality: "final", account_id: HOUSE });
const people: Record<string, Actor> = {};
for (const n of ["ivy", "dana", "erin", "finn", "mallory"]) people[n] = await made(n, 10n * NEAR);
// An agent from outside with a mask of its own on the market: it locks FARM's bond itself.
const rival = await made("rival", 2n * NEAR);
await openRound("race-0103", HOUSE);
// As /jobs opens them: 4 slots at 0.05 NEAR of fuel, the bond left to the contract (the fuel), 20 minutes to work, 30
// to reveal. F asks 3 slots: an agent's own numbers.
const FUEL = 50n * MILLI;
await openJob(C, "race-0103", NEAR, FUEL, 4, null, people.ivy!, 20);
await openJob(D, "race-0103", 200n * MILLI, FUEL, 4, null, people.dana!, 20);
await openJob(E, "race-0103", NEAR, FUEL, 4, null, people.ivy!, 20);
await openJob(F, "race-0103", NEAR, FUEL, 3, null, people.erin!, 20);
await openJob(G, "race-0103", NEAR, FUEL, 4, null, people.finn!, 20);
await openJob(H, "race-0103", NEAR, FUEL, 4, null, people.mallory!, 20);

await sponsorPass(`the house locks the masks' bonds on ${C} and ${F}, and on nothing else`, CREW);
// An outside mask takes one of F's three slots before our masks' pass: the crew of three no longer fits.
const fb = bondOf(await rpc.view(world.jobs, "get", { id: F }));
const [fw, ff = ""] = fb.deposit.split(".");
await must(`${rival.id} locks FARM's bond on ${F}`, send(rpc, rival.id, rival.key, world.jobs, [
  { kind: "call", method: "bond", args: { id: F, mask: farm.id }, gas: 30n * TGAS, deposit: BigInt(fw!) * NEAR + BigInt((ff + "0".repeat(24)).slice(0, 24)) },
]));
await must(`FARM takes ${F} first`, send(rpc, farm.id, farmKey, world.jobs, [{ kind: "call", method: "enlist", args: { id: F }, gas: 50n * TGAS, deposit: 0n }]));
await pass(`the crew takes ${C} on the house's bonds; on ${F} NOVA and ONYX go alone; the rest is refused`, CREW);
await sponsorPass("the house has nothing more to lock: ORACLE's bond on F waits while the work window is open", CREW);
const outsideJobs = await Promise.all([C, F].map(jobOf));
await ffUntil(max(...outsideJobs.map((j) => BigInt(j.terms.work_until))));
await sponsorPass(`the work windows are over: the house takes back ORACLE's bond on ${F}, which no mask took`, CREW);
await pass("every mask of ours reveals its step", CREW);
await ffUntil(max(...outsideJobs.map((j) => BigInt(j.terms.reveal_until))));
await pass("the round still runs: the judge waits", CREW);
console.log("\nthe house's round ends: NOVA drained race-0103");
await drained("race-0103", masks.NOVA!);
await pass("the round is over: a mask on each job asks the judge", CREW);
await pass("the verdicts are final: the jobs pay by role", CREW);
await pass("nothing left for our masks", CREW);
await sponsorPass("nothing left for the house", CREW);
const houseAfter = await rpc.call<{ amount: string }>("query", { request_type: "view_account", finality: "final", account_id: HOUSE });
console.log(`\nthe house: ${houseBefore.amount} yocto before, ${houseAfter.amount} after: every bond came back, less the gas`);

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
    house: HOUSE,
    // The seed of the house's throwaway key, in hex as the masks' seeds are: the replay makes the key from it
    // (test/jobs-tape.ts), and no secret key is written out in the fixture.
    houseSeed: Buffer.from(base58Decode(house.secret!.slice("ed25519:".length))).subarray(0, 32).toString("hex"),
    houseBefore: houseBefore.amount,
    houseAfter: houseAfter.amount,
    houseKeeps: HOUSE_KEEPS.toString(),
    blocked: BLOCKED,
    people: Object.fromEntries(Object.entries(people).map(([n, a]) => [n, a.id])),
    sources: Object.fromEntries(SOURCES.map((f) => [f, sha(readFileSync(join(ROOT, f), "utf8"))])),
    recordedAt: new Date().toISOString(),
  },
  passes,
  entries: rec.entries,
};
const text = `${JSON.stringify(tape)}\n`;
writeFileSync(out, text);
console.log(`\n${passes.length} passes, ${rec.entries.length} answers, ${(text.length / 1024).toFixed(0)} KB → ${out}`);
