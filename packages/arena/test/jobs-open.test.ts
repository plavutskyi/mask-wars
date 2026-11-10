import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type OpenInput, RULES, nearCliCommand, openAction, openArgs, openCost, openProblems, openableKinds, sealWork } from "../src/jobs/index.ts";
import { readRecording, replayJobs } from "../src/jobs/fixture.ts";

// The `open` call a client signs, checked against the contract's own source and against the settings the sandbox
// world's contract answered with (`fixtures/jobs-sandbox.json`).
const jobsRs = readFileSync(new URL("../../../contracts/jobs/src/lib.rs", import.meta.url), "utf8");
const recording = readRecording(new URL("./fixtures/jobs-sandbox.json", import.meta.url));
const market = (await replayJobs(recording).board()).market!;

const NEAR = 10n ** 24n;
const milli = (n: number) => ((BigInt(n) * NEAR) / 1000n).toString();
const CLIENT = "dao.test.near";
const CLIENT_KEY = "x25519:42575d5c8a93833255e09f04054a4f6246d36ed163c1c7f80c1fc9a58a0e912d";
const reviewJudge = market.judges.find((j) => j.kind === "ai_review")!;
const reference = sealWork(reviewJudge.key, "jobs.test.near", "audit-0042", CLIENT, { kind: "text", text: "reference review: the refund path pays once." });

const review: OpenInput = {
  id: "audit-0042",
  kind: "ai_review",
  brief: "Audit the refund path by the rubric: can an order be refunded twice?",
  spec: "a".repeat(64),
  rubric: "b".repeat(64),
  bar: { winAt: 60, reference },
  reward: (2n * NEAR).toString(),
  fuelPerMask: milli(50),
  slots: 4,
  workMinutes: 120,
  revealMinutes: 30,
  appealMinutes: 30,
  clientKey: CLIENT_KEY,
};

describe("what opening a job takes", () => {
  it("counts the deposit by the contract's own rule: reward, fuel a slot, eight judge runs, the reserve, the record", () => {
    // The rule as the contract states it: a change there fails here.
    expect(jobsRs).toContain("cost_of(u64::from(slots) * (MASK_STORAGE_BYTES + LEFT_SEAT_BYTES) + JOB_GROWTH_BYTES)");
    expect(jobsRs).toContain("let judge = JUDGE_FEE.as_yoctonear() * JUDGE_RUNS;");
    expect(jobsRs).toContain("let record = cost_of(JOB_RECORD_BYTES);");
    expect(jobsRs).toContain("total: U128(reward.0 + fuel + judge + reserve + record),");
    const cost = openCost((2n * NEAR).toString(), milli(50), 4, market.judgeFee);
    expect(cost).toEqual({
      reward: (2n * NEAR).toString(),
      fuel: milli(200),
      judge: milli(80),
      // (4 × (7000 + 600) + 1200) bytes at 10^19 yocto a byte.
      reserve: milli(316),
      record: milli(44),
      total: milli(2640),
    });
    expect(openCost(RULES.minReward, RULES.minFuel, 1).total).toBe(milli(100 + 10 + 80 + 88 + 44));
  });

  it("opens only the kinds the contract can judge now", () => {
    expect(openableKinds(market)).toEqual(["drain", "tee_tests", "ai_review"]);
    expect(openableKinds({ judges: [], bounties: [], changing: false })).toEqual([]);
    expect(openableKinds({ judges: [], bounties: ["bounty.test.near"], changing: false })).toEqual(["drain"]);
    expect(openableKinds({ ...market, changing: true })).toEqual([]);
  });
});

describe("the open call for the client's own wallet", () => {
  it("builds the contract's arguments, pins the contract's judge and attaches the quoted deposit", () => {
    expect(openProblems(review, market, CLIENT)).toEqual([]);
    const a = openAction("jobs.test.near", CLIENT, review, market);
    expect(a).toMatchObject({ signer_id: CLIENT, receiver_id: "jobs.test.near", method_name: "open", deposit: milli(2640), gas: "100000000000000" });
    expect(a.args).toEqual({
      id: "audit-0042",
      kind: "ai_review",
      brief: review.brief,
      spec: review.spec,
      rubric: review.rubric,
      judge_version: reviewJudge.version,
      round: null,
      secrets: null,
      bar: { win_at: 60, cases: null, fuel: null, reference },
      reward: (2n * NEAR).toString(),
      fuel_per_mask: milli(50),
      slots: 4,
      open_to: { who: "anyone" },
      work_minutes: 120,
      reveal_minutes: 30,
      appeal_minutes: 30,
      bond: null,
      client_key: CLIENT_KEY,
    });
    // Every argument of the contract's `open`, and no other.
    const params = /pub fn open\(\s*&mut self,([\s\S]*?)\) -> JobView/.exec(jobsRs)![1]!;
    expect(Object.keys(a.args)).toEqual([...params.matchAll(/(\w+): /g)].map((m) => m[1]));
    const cli = nearCliCommand("testnet", a);
    expect(cli).toMatch(/^near contract call-function as-transaction jobs\.test\.near open json-args '\{"id":"audit-0042",/);
    expect(cli).toMatch(/ prepaid-gas '100 Tgas' attached-deposit '2\.64 NEAR' sign-as dao\.test\.near network-config testnet sign-with-keychain send$/);
  });

  it("builds a drain job on a round of a bounty contract the jobs contract follows, with a test set for tee_tests", () => {
    const drain: OpenInput = { id: "drain-0042", kind: "drain", brief: "Drain the safe of round live-0009.", spec: "c".repeat(64), round: { bounty: market.bounties[0]!, id: "live-0009" }, reward: (5n * NEAR).toString(), fuelPerMask: milli(100), slots: 6, workMinutes: 60, revealMinutes: 10, appealMinutes: 10, openTo: { who: "masks", masks: ["nova.test.near"] } };
    expect(openProblems(drain, market, CLIENT)).toEqual([]);
    expect(openArgs(drain, market, CLIENT)).toMatchObject({ judge_version: null, round: { bounty: market.bounties[0], id: "live-0009" }, bar: null, client_key: null, secrets: null, open_to: { who: "masks", masks: ["nova.test.near"] } });
    const tests: OpenInput = { ...review, id: "bench-0042", kind: "tee_tests", secretsProfile: "bench-0042", bar: { winAt: 3, cases: 4, fuel: "1000000", reference } };
    expect(openProblems(tests, market, CLIENT)).toEqual([]);
    expect(openArgs(tests, market, CLIENT)).toMatchObject({ judge_version: market.judges.find((j) => j.kind === "tee_tests")!.version, secrets: { profile: "bench-0042", account_id: CLIENT }, bar: { win_at: 3, cases: 4, fuel: "1000000", reference } });
  });

  it("says why the contract would refuse, before any gas is spent", () => {
    const why = (patch: Partial<OpenInput>, m = market) => openProblems({ ...review, ...patch }, m, CLIENT).join(" | ");
    expect(why({ id: "Audit 42" })).toMatch(/^id: 1 to 64 lowercase/);
    expect(why({ brief: "x".repeat(281) })).toMatch(/brief: 1 to 280 bytes/);
    expect(why({ spec: "not-a-hash" })).toMatch(/spec: the sha256/);
    expect(why({ reward: milli(50) })).toMatch(/the reward is at least 0\.1 NEAR/);
    expect(why({ fuelPerMask: milli(5) })).toMatch(/fuel_per_mask: 0\.01 to 1 NEAR/);
    expect(why({ slots: 17 })).toMatch(/slots: 1 to 16 masks/);
    expect(why({ reward: milli(150), fuelPerMask: milli(50), slots: 4 })).toMatch(/fuel for all the slots is at most the reward/);
    expect(why({ bond: milli(10) })).toMatch(/bond: from fuel_per_mask up to the reward/);
    expect(why({ workMinutes: 4 })).toMatch(/work_minutes/);
    expect(why({ appealMinutes: 5 })).toMatch(/appeal_minutes/);
    expect(why({ rubric: null })).toMatch(/publish the rubric or test set first/);
    expect(why({ bar: null })).toMatch(/set the bar a work must clear/);
    expect(why({ bar: { winAt: 60, reference: "plain text" } })).toMatch(/bar\.reference: your own reference work sealed/);
    expect(why({ bar: { winAt: 81, reference } })).toMatch(/win_at 0 to 80 points/);
    expect(why({ clientKey: null })).toMatch(/client_key: your X25519 key/);
    expect(why({ round: { bounty: "bounty.test.near", id: "live-0001" } })).toMatch(/only a drain follows a round/);
    expect(why({ openTo: { who: "masks", masks: [CLIENT] } })).toMatch(/the client is not one of its own job's masks/);
    expect(why({ kind: "tee_tests" })).toMatch(/secrets_profile/);
    expect(why({}, { ...market, judges: [] })).toMatch(/no judge serves this kind yet/);
    expect(why({}, { ...market, changing: true })).toMatch(/^new code is waiting to apply/);
    expect(why({ kind: "drain", rubric: null, bar: null, clientKey: null })).toMatch(/a drain job names the round it follows/);
    expect(why({ kind: "drain", rubric: null, round: { bounty: "other.near", id: "live-1" } })).toMatch(/round\.bounty: a bounty contract this contract follows .*it sets no bar.*it takes no client key/);
  });
});
