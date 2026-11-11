/**
 * The masks at work on the jobs market, checked on a real chain with no network: `fixtures/jobs-work.json` is a tape of
 * everything eight passes of src/work.ts asked a local NEAR sandbox (the arena's jobs world: the real jobs and crews
 * contracts with no key, ten jobs of others in every phase) and what it answered, recorded by scripts/jobs-sandbox.ts.
 * Between the passes the owner, a client and the round did their part on that chain, as they would on testnet. The
 * replay runs the same passes, signs the same transactions byte for byte and must decide exactly what the recording
 * did: three masks take a drain alone and ORACLE is paid 0.95 NEAR, then the crew of three takes one and every striker
 * is paid 0.475 NEAR.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ChainReader } from "@maskwars/check";
import { Indexer } from "@maskwars/arena";
import { Jobs, SALT, type JobBoard } from "@maskwars/arena/jobs";
import { bondOf, jobKeys, nearOf } from "../../../scripts/testnet/jobs-keys.mjs";
import { racePublicKey } from "../../../scripts/testnet/season-keys.mjs";
import { raceKey } from "../src/keys.ts";
import { FailoverRpc, JsonRpc, RpcError } from "../src/near-tx.ts";
import { packed, replayingFetch, unpacked, type Tape } from "../src/tape.ts";
import { actKey, CREW_KEY_METHODS, describe as say, drainContent, JOB_KEY_METHODS, jobSalt, jobTag, keepWorking, MAX_FAILED_PASSES, MAX_PASSES, MIN_REVEAL_MS, plan, readFacts, RACE_MIN_MS, RETRY_MS, STEP_MARGIN_MS, work, type Facts, type Ours, type Pass } from "../src/work.ts";

interface Recorded {
  label: string;
  crew: string | null;
  block: number;
  readAt: number;
  done: { what: string; ok: boolean; sent: boolean; hash: string | null; note?: string; error?: string }[];
  skips: { job: string; mask?: string; why: string }[];
  race: { job: string; bounty: string; round: string } | null;
  next: number | null;
  steps: { job: string; seq: number; mask: string; revealed: boolean; copyOf: number | null; content: string | null }[];
}
interface About {
  rpc: string;
  indexer: string;
  jobs: string;
  crews: string;
  bounty: string;
  team: string;
  masks: Record<string, string>;
  seeds: Record<string, string>;
  crew: string;
  outsider: string;
  sources: Record<string, string>;
}

const tape = JSON.parse(readFileSync(new URL("./fixtures/jobs-work.json", import.meta.url), "utf8")) as Tape & { passes: Recorded[]; about: About };
const about = tape.about;
const A = "break-safe-0101";
const B = "break-safe-0102";

const ours = (crew: string | null): Ours => ({
  masks: about.masks,
  signers: Object.keys(about.seeds),
  bounties: [about.bounty],
  teams: [about.team],
  raceBounty: about.bounty,
  raceTeams: [about.team],
  crew,
});

/** The chain as the tape has it: a reader and a signer over one replay, as one pass of the workflow has them. */
function replay(f: typeof fetch) {
  const jobs = new Jobs({
    config: { network: "sandbox", contract: about.jobs, crews: about.crews, rpc: [about.rpc], indexer: about.indexer, explorer: null },
    rpc: new ChainReader({ endpoints: [about.rpc], fetch: f }),
    indexer: new Indexer({ base: about.indexer, fetch: f, timeoutMs: 2_000 }),
    ttlMs: 0,
  });
  return { jobs, chain: new JsonRpc(about.rpc, 60_000, f) };
}

describe("the masks at work, replayed from the sandbox", () => {
  it("was recorded against the contracts as they are: a change to them records the tape again", () => {
    for (const [file, sha] of Object.entries(about.sources)) {
      const now = createHash("sha256").update(readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8")).digest("hex");
      expect(now, `${file} changed since the tape was recorded: pnpm --filter @maskwars/race jobs:sandbox`).toBe(sha);
    }
    expect(Object.keys(about.sources)).toContain("contracts/jobs/src/lib.rs");
  });

  it("decides and signs, pass by pass, exactly what the recording did, and asks the chain nothing more", async () => {
    const r = replayingFetch(tape);
    const seen: Recorded[] = [];
    // One reader and one memory of refused calls for all the passes, as one run of the workflow has them.
    const { jobs, chain } = replay(r.fetch);
    const refused = new Set<string>();
    for (const rec of tape.passes) {
      const p = await work({ chain, jobs, jobsContract: about.jobs, crewsContract: about.crews, ours: ours(rec.crew), seeds: about.seeds, refused });
      seen.push({
        ...rec,
        block: p.board.block!.height,
        readAt: p.board.readAt,
        done: p.done.map((d) => ({ what: say(d.act), ok: d.ok, sent: d.sent, hash: d.hash, ...(d.note ? { note: d.note } : {}), ...(d.error ? { error: d.error } : {}) })),
        skips: [...p.plan.skips],
        race: p.plan.race,
        next: p.plan.next,
        steps: p.board.jobs
          .filter((j) => j.id === A || j.id === B)
          .flatMap((j) => j.steps.map((st) => ({ job: j.id, seq: st.seq, mask: st.mask.account, revealed: st.revealed, copyOf: st.copyOf, content: st.content }))),
      });
    }
    expect(seen).toEqual(tape.passes);
    expect(r.unasked()).toEqual([]);
  }, 30_000);

  it("takes the first job alone, three masks as in break-safe-0004, and races its round", () => {
    const [p1] = tape.passes;
    expect(p1!.done.map((d) => d.what)).toEqual([
      `NOVA takes ${A} alone`,
      `NOVA seals its striker step on ${A}`,
      `ONYX takes ${A} alone`,
      `ONYX seals its striker step on ${A}`,
      `ORACLE takes ${A} alone`,
      `ORACLE seals its striker step on ${A}`,
    ]);
    expect(p1!.done.every((d) => d.ok && d.sent && d.hash)).toBe(true);
    expect(p1!.race).toEqual({ job: A, bounty: about.bounty, round: "race-0101" });
  });

  it("holds the crew until every seat's bond is there, then joins and enlists it with the masks' own keys", () => {
    const [, p2, p3] = tape.passes;
    expect(p2!.done).toEqual([]);
    expect(p2!.skips).toContainEqual({ job: B, why: `crew ${about.crew} waits for the bond of ONYX` });
    expect(p2!.skips).toContainEqual({ job: B, mask: "ONYX", why: `no bond waits for it: the owner locks it (jobs-bond.ps1 -Job ${B})` });
    expect(p3!.done.map((d) => d.what)).toEqual([
      `NOVA joins crew ${about.crew} v1`,
      `ONYX joins crew ${about.crew} v1`,
      `ORACLE enlists crew ${about.crew} (ORACLE, NOVA, ONYX) in ${B}`,
      `ORACLE seals its striker step on ${B}`,
      `NOVA seals its striker step on ${B}`,
      `ONYX seals its striker step on ${B}`,
    ]);
    expect(p3!.done.every((d) => d.ok)).toBe(true);
  });

  it("reveals every step after the work window, waits for the rounds, asks the judge, and the jobs pay", () => {
    const [, , , p4, p5, p6, p7, p8] = tape.passes;
    expect(p4!.done.filter((d) => d.what.includes(" reveals step #") && d.ok)).toHaveLength(6);
    // The outsider sealed first, and revealed first, the line NOVA would reveal with no tag: no step of ours is a copy.
    const onA = p5!.steps.filter((st) => st.job === A);
    const farm = onA.find((st) => st.mask === about.outsider)!;
    expect(farm.seq).toBe(0);
    expect(farm.content).toBe(`NOVA strikes round race-0101 on ${about.bounty}. The plan is sealed on the round and shows there once the round reveals it.`);
    const mine = p5!.steps.filter((st) => Object.values(about.masks).includes(st.mask));
    expect(mine).toHaveLength(6);
    for (const st of mine) {
      expect(st.revealed && st.copyOf === null, `${st.job} #${st.seq}`).toBe(true);
      expect(st.content).toMatch(/ Tag [0-9a-f]{32}\.$/);
    }
    expect(p5!.done).toEqual([]);
    expect(p5!.skips).toEqual(
      expect.arrayContaining([
        { job: A, why: "round race-0101 is still open: the judge waits for its outcome" },
        { job: B, why: "round race-0102 is still open: the judge waits for its outcome" },
      ]),
    );
    // The round's winner moves its job on: ORACLE won race-0101, NOVA race-0102.
    expect(p6!.done.map((d) => [d.what, d.note])).toEqual(
      expect.arrayContaining([
        [`ORACLE asks the judge on ${A}`, "decided"],
        [`NOVA asks the judge on ${B}`, "decided"],
      ]),
    );
    const paid = Object.fromEntries(p7!.done.map((d) => [d.what, d.note]));
    expect(paid[`ORACLE settles ${A}`]).toBe("paid ORACLE 0.95 NEAR · fee 0.05 · back to the client 0.435");
    expect(paid[`NOVA settles ${B}`]).toBe("paid ORACLE 0.475, NOVA 0.475, ONYX 0.475 NEAR · fee 0.075 · back to the client 0.379");
    expect(p8!.done).toEqual([]);
  });

  it("leaves others' work alone and says why: a round of another team, a private job its minds cannot seal yet", () => {
    const p1 = tape.passes[0]!;
    expect(p1.skips).toContainEqual({ job: "drain-0007", why: "round live-0008 was opened by dao.test.near, not by one of our teams" });
    expect(p1.skips.some((s) => /ai_review: the work is sealed for the judge's TEE key/.test(s.why))).toBe(true);
    // Nothing on any job of the world but ours ever sent a transaction.
    for (const p of tape.passes) for (const d of p.done) expect(d.what).toMatch(/break-safe-010[12]|joins crew/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The decisions, on a real board read from the tape and facts changed one at a time
// ---------------------------------------------------------------------------------------------------------------

/** The board and the facts of the first pass, read from the tape. */
async function firstPass(): Promise<{ board: JobBoard; facts: Facts }> {
  const { jobs, chain } = replay(replayingFetch(tape).fetch);
  const board = await jobs.board();
  return { board, facts: await readFacts(chain, board, ours(null), about.crews) };
}

const takes = (p: ReturnType<typeof plan>, job = A) => p.acts.filter((a) => a.kind === "enlist" && a.job === job).map((a) => a.mask);

describe("what a mask takes", () => {
  it("only with a bond locked for it: the key it signs with attaches no NEAR", async () => {
    const { board, facts } = await firstPass();
    expect(takes(plan(board, facts, ours(null)))).toEqual(["NOVA", "ONYX", "ORACLE"]);
    const bonds = new Map(facts.bonds);
    bonds.delete(`${A}/${about.masks.ONYX}`);
    bonds.set(`${A}/${about.masks.NOVA}`, 1n);
    const p = plan(board, { ...facts, bonds }, ours(null));
    expect(takes(p)).toEqual(["ORACLE"]);
    expect(p.skips).toContainEqual({ job: A, mask: "NOVA", why: "the bond waiting for it is less than this job's" });
    expect(p.acts.some((a) => a.kind === "step" && a.mask === "ONYX")).toBe(false);
  });

  it("only on a round of our team that lets it in, still open", async () => {
    const { board, facts } = await firstPass();
    const key = `${about.bounty}/race-0101`;
    const round = facts.rounds.get(key)!;
    const withRound = (r: typeof round) => ({ ...facts, rounds: new Map([...facts.rounds, [key, r]]) });
    expect(takes(plan(board, withRound({ ...round, owner: "mallory.test.near" }), ours(null)))).toEqual([]);
    expect(takes(plan(board, withRound({ ...round, state: "drained" }), ours(null)))).toEqual([]);
    expect(takes(plan(board, withRound({ ...round, masks: [about.masks.ORACLE!] }), ours(null)))).toEqual(["ORACLE"]);
    expect(takes(plan(board, withRound({ ...round, masks: null }), ours(null)))).toEqual([]);
    const elsewhere = plan(board, facts, { ...ours(null), bounties: ["other-bounty.test.near"] });
    expect(takes(elsewhere)).toEqual([]);
    expect(elsewhere.skips).toContainEqual({ job: A, why: `the round is on ${about.bounty}, not a bounty contract of ours. Its bond waits: jobs-bond.ps1 -Job ${A} -Unbond` });
  });

  it("not when the work window closes too soon to seal, nor without its seed, nor past its slots", async () => {
    const { board, facts } = await firstPass();
    const job = board.jobs.find((j) => j.id === A)!;
    const late = { ...board, readAt: job.workUntil - STEP_MARGIN_MS };
    expect(takes(plan(late, facts, ours(null)))).toEqual([]);
    expect(takes(plan(board, facts, { ...ours(null), signers: ["NOVA"] }))).toEqual(["NOVA"]);
    // FARM holds one slot of the four already.
    const tight = { ...board, jobs: board.jobs.map((j) => (j.id === A ? { ...j, slots: 3 } : j)) };
    const p = plan(tight, facts, ours(null));
    expect(takes(p)).toEqual(["NOVA", "ONYX"]);
    expect(p.skips).toContainEqual({ job: A, mask: "ORACLE", why: "no slot left" });
  });

  it("not on a job with a reveal window a scheduled run may miss, nor on a round it can no longer win", async () => {
    const { board, facts } = await firstPass();
    const short = { ...board, jobs: board.jobs.map((j) => (j.id === A ? { ...j, revealUntil: j.workUntil + MIN_REVEAL_MS - 60_000 } : j)) };
    const p = plan(short, facts, ours(null));
    expect(takes(p)).toEqual([]);
    expect(p.skips.some((s) => s.job === A && /reveal window is 29 min/.test(s.why))).toBe(true);
    const key = `${about.bounty}/race-0101`;
    const round = facts.rounds.get(key)!;
    const closed = { ...facts, rounds: new Map([...facts.rounds, [key, { ...round, commitUntil: board.readAt - 1, sealedBy: [about.masks.ORACLE!] }]]) };
    // The commit window is over: only the mask that sealed in it can still win.
    expect(takes(plan(board, closed, ours(null)))).toEqual(["ORACLE"]);
  });

  it("names a mask's bond that waits on a job it will not take, so the owner takes it back", async () => {
    const { board, facts } = await firstPass();
    const p = plan(board, facts, { ...ours(null), signers: ["NOVA", "ORACLE"] });
    expect(p.skips).toContainEqual({ job: A, mask: "ONYX", why: `no seed in MASK_KEYS. Its bond waits: jobs-bond.ps1 -Job ${A} -Unbond` });
  });

  it("races only a hand round of ours nobody sealed in yet, with time left to seal the plan", async () => {
    const { board, facts } = await firstPass();
    const key = `${about.bounty}/race-0101`;
    const round = facts.rounds.get(key)!;
    const withRound = (r: typeof round) => ({ ...facts, rounds: new Map([...facts.rounds, [key, r]]) });
    expect(plan(board, facts, ours(null)).race).toEqual({ job: A, bounty: about.bounty, round: "race-0101" });
    expect(plan(board, withRound({ ...round, seals: 1 }), ours(null)).race).toBeNull();
    expect(plan(board, withRound({ ...round, commitUntil: board.readAt + RACE_MIN_MS - 1 }), ours(null)).race).toBeNull();
    // The season races its own rounds: a round of a team that is ours but not a hand team is taken, not raced.
    const season = plan(board, facts, { ...ours(null), raceTeams: ["season.test.near"] });
    expect(season.race).toBeNull();
    expect(takes(season)).toEqual(["NOVA", "ONYX", "ORACLE"]);
    // A round with a person's mask on its list is raced by hand, with the keeper: the workflow takes it and races nothing.
    const people = plan(board, withRound({ ...round, masks: [...round.masks!, "kira.masks.test.near"] }), ours(null));
    expect(people.race).toBeNull();
    expect(takes(people)).toEqual(["NOVA", "ONYX", "ORACLE"]);
  });

  it("follows the round the run raced while it is open, and drops a judge run that never answered", async () => {
    const { board, facts } = await firstPass();
    expect(plan(board, facts, ours(null)).waits).toBe(false);
    expect(plan(board, facts, { ...ours(null), follow: "race-0101" }).waits).toBe(true);
    expect(plan(board, facts, { ...ours(null), follow: "race-0999" }).waits).toBe(false);
    // A job of ours whose judge run is out past its blocks: the mask on it drops it.
    const nova = { mask: { account: about.masks.NOVA!, name: "NOVA", slug: null, forged: false }, role: "striker" as const, left: false, bond: { amount: "0", by: null, lost: null, why: null }, burned: "0", covered: null, steps: 1, payout: null };
    const judging = { ...board, jobs: board.jobs.map((j) => (j.id === A ? { ...j, phase: "judging" as const, entrants: [{ index: 0, crew: null, version: 0, split: { scout: 0, striker: 10000, verifier: 0 }, won: false, members: [nova] }] } : j)) };
    expect(plan(judging, { ...facts, stuck: new Set([A]) }, ours(null)).acts).toContainEqual({ kind: "unstick", mask: "NOVA", job: A });
    expect(plan(judging, facts, ours(null)).acts.filter((a) => "job" in a && a.job === A)).toEqual([]);
  });
});

describe("the step a mask seals and the keys it signs with", () => {
  const seed = about.seeds.NOVA!;

  it("rebuilds its salt and content from its seed alone, the same on every pass", () => {
    const salt = jobSalt(seed, about.jobs, A);
    expect(salt).toMatch(SALT);
    expect(jobSalt(seed, about.jobs, A)).toBe(salt);
    expect(jobSalt(seed, about.jobs, B)).not.toBe(salt);
    expect(jobSalt(about.seeds.ONYX!, about.jobs, A)).not.toBe(salt);
    const round = { bounty: about.bounty, id: "race-0101" };
    const tag = jobTag(seed, about.jobs, A);
    expect(tag).toMatch(/^[0-9a-f]{32}$/);
    expect(jobTag(seed, about.jobs, B)).not.toBe(tag);
    expect(jobTag(about.seeds.ONYX!, about.jobs, A)).not.toBe(tag);
    const c = drainContent("NOVA", "striker", round, tag);
    expect(Buffer.byteLength(c)).toBeLessThanOrEqual(1024);
    expect(c).toContain(tag);
    // Nobody can seal the mask's line first: without its seed, nobody knows the tag in it.
    expect(drainContent("NOVA", "striker", round, jobTag(about.seeds.ONYX!, about.jobs, A))).not.toBe(c);
    expect(() => drainContent("NOVA", "striker", round, "x")).toThrow("16 bytes");
  });

  it("signs with the keys the owner's script puts on chain: the same seeds, the jobs and crews contracts", () => {
    const keys = jobKeys({ NOVA: { seed } }, about.jobs, about.crews, ["nova"]);
    expect(keys.nova!.jobs).toBe(raceKey(seed, about.jobs).publicKeyText);
    expect(keys.nova!.crews).toBe(raceKey(seed, about.crews).publicKeyText);
    expect(keys.nova!.jobs).toBe(racePublicKey(seed, about.jobs));
    expect(() => jobKeys({}, about.jobs, about.crews, ["onyx"])).toThrow("no seed");
  });

  it("locks the job's bond with its record's storage, and near.exe gets it in NEAR", () => {
    const b = bondOf({ id: A, phase: "enlisting", terms: { kind: "drain", bond: (10n ** 22n).toString() } });
    expect(b).toEqual({ job: A, kind: "drain", phase: "enlisting", bond: "10000000000000000000000", deposit: "0.014" });
    expect(nearOf(5n * 10n ** 22n + 4n * 10n ** 21n)).toBe("0.054");
    expect(nearOf(10n ** 24n)).toBe("1");
    expect(() => bondOf(null)).toThrow("no such job");
  });
});

describe("the tape", () => {
  it("keeps a view's bytes as base64 and gives back exactly the chain's answer", () => {
    const answer = { jsonrpc: "2.0", id: "x", result: { result: [...Buffer.from('{"a":1}')], logs: [], block_height: 7 } };
    const p = packed(answer) as { result: Record<string, unknown> };
    expect(p.result["result_b64"]).toBe(Buffer.from('{"a":1}').toString("base64"));
    expect(p.result["result"]).toBeUndefined();
    expect(unpacked(p)).toEqual(answer);
    expect(packed({ result: { header: { height: 1 } } })).toEqual({ result: { header: { height: 1 } } });
  });
});

describe("one run of the workflow", () => {
  /** A pass as the run sees it: read at `at`, with `moved` acts that went through and the next deadline. */
  const fake = (at: number, moved: number, next: number | null, waits = false): Pass =>
    ({
      board: { readAt: at } as JobBoard,
      plan: { acts: [], skips: [], race: null, next, waits },
      done: Array.from({ length: moved }, () => ({ act: { kind: "settle", mask: "NOVA", job: A } as const, ok: true, sent: true, hash: "h" })),
    }) as Pass;

  /** A clock the run's sleeps move on, and passes read at it. */
  function run(script: { moved: number; next: number | null; waits?: boolean }[], waitMinutes: number, pollMs?: number) {
    let clock = 1_000_000;
    const slept: number[] = [];
    let i = 0;
    return keepWorking({
      pass: async () => {
        const s = script[Math.min(i++, script.length - 1)]!;
        return fake(clock, s.moved, s.next === null ? null : clock + s.next, s.waits);
      },
      waitMinutes,
      ...(pollMs ? { pollMs } : {}),
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    }).then((passes) => ({ passes: passes.length, slept }));
  }

  it("makes one pass with no time to wait: the take job, before the race", async () => {
    expect(await run([{ moved: 3, next: 60_000 }], 0)).toEqual({ passes: 1, slept: [] });
  });

  it("passes again at once after a pass that moved, waits for a window that comes in time, and stops when none does", async () => {
    const r = await run(
      [
        { moved: 6, next: 5 * 60_000 }, // reveals
        { moved: 0, next: 5 * 60_000 }, // the reveal window is still open: wait for its end
        { moved: 1, next: null }, // the judge answered
        { moved: 1, next: null }, // settled
        { moved: 0, next: null }, // nothing left
      ],
      12,
    );
    expect(r).toEqual({ passes: 5, slept: [5 * 60_000 + 20_000] });
  });

  it("leaves a window past its time for a later run", async () => {
    expect(await run([{ moved: 0, next: 13 * 60_000 }], 12)).toEqual({ passes: 1, slept: [] });
  });

  it("in a run that raced, asks again every little while for the round's outcome, and calls the judge once it is over", async () => {
    const r = await run(
      [
        { moved: 0, next: 37 * 60 * 60_000, waits: true }, // the reveal window is over, the round still runs
        { moved: 0, next: 37 * 60 * 60_000, waits: true },
        { moved: 1, next: null }, // drained: the judge answered
        { moved: 1, next: null }, // settled
        { moved: 0, next: null },
      ],
      100,
      2 * 60_000,
    );
    expect(r).toEqual({ passes: 5, slept: [120_000, 120_000] });
    // Without a race of its own the run does not poll: the round's end comes to a later run.
    expect(await run([{ moved: 0, next: 37 * 60 * 60_000, waits: true }], 12)).toEqual({ passes: 1, slept: [] });
  });

  it("tries a pass the chain did not answer again a minute later, a few times, and only with time to wait", async () => {
    let clock = 0;
    let calls = 0;
    const slept: number[] = [];
    const flaky = (failing: number, waitMinutes: number) =>
      keepWorking({
        pass: async () => {
          calls += 1;
          if (calls <= failing) throw new Error("every endpoint failed");
          return fake(clock, 0, null);
        },
        waitMinutes,
        now: () => clock,
        sleep: async (ms) => {
          slept.push(ms);
          clock += ms;
        },
      });
    expect((await flaky(2, 12)).length).toBe(1);
    expect(slept).toEqual([RETRY_MS, 2 * RETRY_MS]);
    calls = 0;
    await expect(flaky(MAX_FAILED_PASSES, 12)).rejects.toThrow("every endpoint failed");
    calls = 0;
    await expect(flaky(1, 0)).rejects.toThrow("every endpoint failed");
  });

  it("never makes more than MAX_PASSES passes, whatever keeps moving", async () => {
    expect((await run([{ moved: 1, next: null }], 120)).passes).toBe(MAX_PASSES);
  });
});

describe("calls that cost a key's allowance for nothing", () => {
  it("are not sent again in a run once the chain refused them, and a crew refused on a job lets its masks go alone", async () => {
    const { board, facts } = await firstPass();
    // The crews contract waits for new code: no crew enlists, so the masks go alone.
    const changing = plan(board, { ...facts, crew: { id: about.crew, captain: about.masks.ORACLE!, version: 1, seats: Object.values(about.masks).map((m) => ({ mask: m, role: "striker" as const, joined: true })) }, crewsChanging: true }, ours(about.crew));
    expect(takes(changing)).toEqual(["NOVA", "ONYX", "ORACLE"]);
    expect(changing.skips.some((s) => s.job === A && /new code waits on/.test(s.why))).toBe(true);
    const refusedCrew = plan(board, { ...facts, crew: { id: about.crew, captain: about.masks.ORACLE!, version: 1, seats: Object.values(about.masks).map((m) => ({ mask: m, role: "striker" as const, joined: true })) }, crewRefused: new Set([A]) }, ours(about.crew));
    expect(takes(refusedCrew)).toEqual(["NOVA", "ONYX", "ORACLE"]);
    expect(actKey({ kind: "enlist_crew", mask: "ORACLE", crew: about.crew, job: A, members: [] })).toBe(`enlist_crew/${A}/ORACLE`);
    expect(actKey({ kind: "join", mask: "NOVA", crew: about.crew, version: 1 })).toBe(`join/${about.crew}/NOVA`);
  });

  it("keep the owner's key script and the workflow on the same methods", () => {
    const ps1 = readFileSync(new URL("../../../scripts/testnet/jobs-keys.ps1", import.meta.url), "utf8");
    expect(ps1).toContain(`'--function-names', '${JOB_KEY_METHODS.join(", ")}'`);
    expect(ps1).toContain(`'--function-names', '${CREW_KEY_METHODS.join(", ")}'`);
  });
});

describe("several RPCs", () => {
  it("asks the next endpoint only when one does not answer, never when the chain answered with an error", async () => {
    const asked: string[] = [];
    const down = { rpc: async () => { asked.push("down"); throw new TypeError("fetch failed"); } };
    const refuses = { rpc: async () => { asked.push("refuses"); throw new RpcError("query: UNKNOWN_ACCOUNT"); } };
    const up = { rpc: async () => { asked.push("up"); return { ok: true }; } };
    expect(await new FailoverRpc([down, up]).rpc("block", {})).toEqual({ ok: true });
    await expect(new FailoverRpc([refuses, up]).rpc("query", {})).rejects.toThrow("UNKNOWN_ACCOUNT");
    await expect(new FailoverRpc([down, down]).rpc("block", {})).rejects.toThrow("fetch failed");
    expect(asked).toEqual(["down", "up", "refuses", "down", "down"]);
  });
});
