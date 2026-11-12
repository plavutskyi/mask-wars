import { createHash } from "node:crypto";
import { ChainReader } from "@maskwars/check";
import { Indexer } from "../src/index.ts";
import { describe, expect, it } from "vitest";
import { NETWORKS } from "@maskwars/network";
import { BOARD_JOBS, BOARD_TXS, FRESH_MS, Jobs, isFresh, jobsConfigFromEnv, jobsConfigOf, nextDeadline, plainJobId, sealWork, shares, stepHash } from "../src/jobs/index.ts";
import { readRecording, replayJobs } from "../src/jobs/fixture.ts";

// What the sandbox world's RPC and its indexer answered for one reading of the board: the jobs and crews contracts of
// this repository in a local NEAR sandbox (`jobs-world/`), recorded by `scripts/jobs-record.ts`. Every mask's work
// there is a real box sealed for its judge's key with the judges' own code.
const recording = readRecording(new URL("./fixtures/jobs-sandbox.json", import.meta.url));

const NEAR = 10n ** 24n;
const milli = (n: number) => (BigInt(n) * NEAR) / 1000n;
const micro = (n: number) => (BigInt(n) * NEAR) / 1_000_000n;
const KIRA = "kira.masks.test.near";
const NOVA = "nova.test.near";
const ONYX = "onyx.test.near";
const FARM = "farm.test.near";
const ROOK = "rook.test.near";
/** The judges' keys in the sandbox: the public halves of their sandbox seeds (contracts/jobs/sandbox). */
const TESTS_KEY = "x25519:6c8fed6f2acd4093f45f4921108f6234ab86cf6b1b4ef2c1c8668b8ba1f53864";
const REVIEW_KEY = "x25519:7c8a393f8708112b7cd720c8f66296a659ccb3a5c7594692a5599a76dd47514d";
const CLIENT_KEY = "x25519:42575d5c8a93833255e09f04054a4f6246d36ed163c1c7f80c1fc9a58a0e912d";

/** The recording with the `open_to` of some jobs changed in the contract's `list` answer, and nothing else. */
function withOpenTo(change: Record<string, unknown>): typeof recording {
  const exchanges = recording.exchanges.map((e) => {
    const req = e.request as { params?: { method_name?: string } } | null;
    if (req?.params?.method_name !== "list") return e;
    const res = e.response as { result: { result: number[] } };
    const jobs = JSON.parse(Buffer.from(res.result.result).toString("utf8")) as { id: string; terms: { open_to: unknown } }[];
    for (const j of jobs) if (j.id in change) j.terms.open_to = change[j.id];
    return { ...e, response: { ...res, result: { ...res.result, result: [...Buffer.from(JSON.stringify(jobs))] } } };
  });
  return { ...recording, exchanges };
}

function counting(opts: { ttlMs?: number; now?: () => number } = {}) {
  const calls: string[] = [];
  let down: RegExp | null = null;
  const jobs = replayJobs(recording, {
    ...opts,
    wrap: (base) =>
      (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        calls.push(`${url} ${typeof init?.body === "string" ? init.body : ""}`);
        if (down?.test(url)) throw new TypeError("fetch failed");
        return base(input, init);
      }) as typeof fetch,
  });
  return {
    jobs,
    calls,
    breakIt: (what: RegExp | null) => {
      down = what;
    },
  };
}

describe("the jobs board of the sandbox world, from recorded answers", () => {
  it("lists every job: the ones masks can take first, by reward, then the rest by phase and age", async () => {
    const board = await replayJobs(recording).board();
    expect(board.deployed).toBe(true);
    expect(board.contract).toBe("jobs.test.near");
    expect(board.jobs.map((j) => [j.id, j.kind, j.phase])).toEqual([
      ["audit-0006", "ai_review", "enlisting"],
      ["drain-0007", "drain", "enlisting"],
      ["review-0009", "ai_review", "checking"],
      ["tests-0005", "tee_tests", "revealing"],
      ["review-0010", "ai_review", "waiting"],
      ["review-0004", "ai_review", "decided"],
      ["bench-0002", "tee_tests", "cancelled"],
      ["review-0003", "ai_review", "closed"],
      ["drain-0001", "drain", "paid"],
      ["review-0001", "ai_review", "paid"],
    ]);
    expect(board.jobs.every((j) => j.history)).toBe(true);
  });

  it("adds up what waits for masks now and what the contract paid them, from the chain only", async () => {
    const board = await replayJobs(recording).board();
    expect(board.open).toBe(2);
    expect(board.waiting).toBe((17n * NEAR).toString());
    // audit-0006: 0.2 × 8; drain-0007: 0.1 × 6.
    expect(board.waitingFuel).toBe(milli(2200).toString());
    expect(board.biggest?.id).toBe("audit-0006");
    // review-0001: 0.855 + 1.995; drain-0001: 0.57 + 1.33.
    expect(board.paid).toBe(milli(4750).toString());
    // review-0001: KIRA 0.03 + NOVA 0.04 (ONYX's step did not count); drain-0001: NOVA 0.02.
    expect(board.fuelPaid).toBe(milli(90).toString());
    expect(board.readAt).toBe(recording.recordedAt);
  });

  it("keeps the work private: no box and no word of any private work is anywhere in the board", async () => {
    const board = await replayJobs(recording).board();
    const all = JSON.stringify(board);
    expect(all).not.toContain("mw1.");
    expect(all).not.toMatch(/quorum check runs|abstentions|refund path/);
    for (const j of board.jobs.filter((j) => j.private)) {
      expect(j.steps.every((s) => s.content === null && s.boxed === s.revealed)).toBe(true);
    }
    // A drain's plan is on chain, as its round shows it: it reads as the plan.
    const drain = board.jobs.find((j) => j.id === "drain-0001")!;
    expect(drain.private).toBe(false);
    expect(drain.steps.map((s) => [s.boxed, s.content])).toEqual([
      [false, "recon: set_owner on the safe is open to any mask of the round"],
      [false, "plan: set_owner to self, then sweep 1 NEAR"],
    ]);
  });

  it("rebuilds a paid review from its events: the duo's split, the seals, the bonds, the payout to the yocto and the delivery", async () => {
    const j = (await replayJobs(recording).job("review-0001"))!;
    expect(j.judge).toEqual({ by: "outlayer", project: "maskwars.testnet/review", version: "5048c29063c3c1f3b5ac86e66f8153eb0f28083b671fe33967a29e8512b808b0", key: REVIEW_KEY, outlayer: "outlayer.test.near" });
    expect(j).toMatchObject({ clientKey: CLIENT_KEY, bar: { winAt: 60, cases: null }, bond: milli(50).toString(), checked: true });
    expect(j.entrants.map((e) => [e.crew, e.version, e.split, e.won])).toEqual([
      ["duo", 1, { scout: 3000, striker: 7000, verifier: 0 }, true],
      [null, 0, { scout: 0, striker: 10000, verifier: 0 }, false],
    ]);
    expect(j.entrants.flatMap((e) => e.members).map((m) => [m.mask.name, m.role, m.burned, m.covered, m.payout, m.bond])).toEqual([
      ["KIRA", "scout", milli(30).toString(), milli(30).toString(), milli(855).toString(), { amount: milli(50).toString(), by: "ann.test.near", lost: "0", why: null }],
      [NOVA, "striker", milli(40).toString(), milli(40).toString(), milli(1995).toString(), { amount: milli(50).toString(), by: "test.near", lost: "0", why: null }],
      // ONYX's three words scored zero on two seeds: not counted, not fake, half its bond to the company.
      [ONYX, "striker", milli(50).toString(), "0", null, { amount: milli(50).toString(), by: "test.near", lost: milli(25).toString(), why: "idle" }],
    ]);
    expect(j.steps.map((s) => [s.seq, s.mask.account, s.role, s.revealed, s.boxed, s.counted, s.fake, s.copyOf])).toEqual([
      [0, KIRA, "scout", true, true, true, false, null],
      [1, NOVA, "striker", true, true, true, false, null],
      [2, ONYX, "striker", true, true, false, false, null],
    ]);
    expect(j.steps.every((s) => s.sealTx && s.revealTx && s.revealedAt! > s.sealedAt && /^[0-9a-f]{64}$/.test(s.digest!))).toBe(true);
    expect(j.settlement).toMatchObject({ state: "paid", fee: milli(150).toString(), toTreasury: milli(70).toString(), forfeit: milli(25).toString(), bondsBack: milli(125).toString() });
    expect(BigInt(j.settlement!.back!)).toBeGreaterThan(milli(400));
    expect(j.delivery).toMatchObject({ at: "delivery/jobs.test.near/review-0001", key: CLIENT_KEY, project: "maskwars.testnet/review" });
    expect(j.delivery!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(j.events.map((e) => e.kind)).toEqual([
      "open", "check", "bond", "bond", "enlist", "bond", "enlist", "seal", "seal", "seal", "burn", "burn", "burn", "reveal", "reveal", "reveal", "judge", "verdict", "settle", "deliver",
    ]);
    expect(j.txs.open).toBeTruthy();
    expect(j.txs.settle).toBe(j.settlement!.tx);
  });

  it("follows a drain job's round: a judge call that decides nothing while the round runs, then the round's word", async () => {
    const j = (await replayJobs(recording).job("drain-0001"))!;
    expect(j.judge).toEqual({ by: "round", bounty: "bounty.test.near", round: "live-0007", state: null, winner: null });
    expect(j).toMatchObject({ bar: null, clientKey: null, delivery: null });
    const judged = j.events.filter((e) => e.kind === "judge");
    expect(judged.map((e) => e.note ?? null)).toEqual(["the round is not over", null]);
    expect(j.verdict).toMatchObject({ winner: 0, counted: [0, 1], fake: [], final: true, shared: false, undecided: false, appealUntil: null });
    expect(j.settlement!.payouts.map((p) => [p.mask.name, p.role, p.amount])).toEqual([
      ["KIRA", "scout", milli(570).toString()],
      [NOVA, "striker", milli(1330).toString()],
    ]);
    const live = (await replayJobs(recording).job("drain-0007"))!;
    expect(live.judge).toMatchObject({ by: "round", round: "live-0008", state: "open" });
  });

  it("reads a job nobody won: the fake box's whole bond to the company, the mask that left paying for its seconds", async () => {
    const j = (await replayJobs(recording).job("review-0003"))!;
    expect(j.verdict).toMatchObject({ winner: null, counted: [], fake: [0] });
    expect(j.settlement).toMatchObject({ state: "closed", payouts: [], fee: "0", toTreasury: "0", forfeit: milli(20).toString() });
    expect(BigInt(j.settlement!.back!)).toBeGreaterThan(NEAR);
    const [farm, rook] = j.entrants.flatMap((e) => e.members);
    expect([farm!.mask.account, farm!.left, farm!.bond]).toEqual([FARM, false, { amount: milli(20).toString(), by: "test.near", lost: milli(20).toString(), why: "fake" }]);
    // ROOK held a slot for seconds of the five-minute window: a sliver of half its bond, the rest back at once.
    expect([rook!.mask.account, rook!.left, rook!.bond.why, rook!.bond.amount]).toEqual([ROOK, true, "left", milli(20).toString()]);
    expect(BigInt(rook!.bond.lost!)).toBeGreaterThan(0n);
    expect(BigInt(rook!.bond.lost!)).toBeLessThan(micro(200));
    expect(j.left).toBe(1);
    const leave = j.events.find((e) => e.kind === "leave")!;
    expect(leave).toMatchObject({ who: { account: ROOK }, lost: rook!.bond.lost });
    expect(j.steps.map((s) => [s.seq, s.revealed, s.fake, s.counted])).toEqual([[0, true, true, false]]);
  });

  it("reads a job the judge refused at its check: no mask started, everything back to the client", async () => {
    const j = (await replayJobs(recording).job("bench-0002"))!;
    expect(j).toMatchObject({ phase: "cancelled", checked: false, entrants: [], steps: [], bar: { winAt: 10, cases: 12, fuel: "1000000" }, secrets: { profile: "vault-tests", account: "dao.test.near" } });
    expect(j.events.map((e) => [e.kind, e.note ?? null])).toEqual([
      ["open", null],
      ["refuse", "the client's own solution passes 8 of 12 cases, below win_at 10"],
      ["settle", "cancelled"],
    ]);
  });

  it("shows what a decided job will pay by the contract's own rule, where every bond will go, and until when it may be appealed", async () => {
    const j = (await replayJobs(recording).job("review-0004"))!;
    expect(j.verdict).toMatchObject({ winner: 0, counted: [0, 1, 2], fake: [3], final: false });
    expect(j.verdict!.appealUntil).toBe(j.verdict!.at + 24 * 60 * 60_000);
    // 4 NEAR less 5%: 3.8 NEAR split 20/60/20 between the trio. FARM's box opens for nobody: fake.
    expect(j.settlement).toMatchObject({ state: "due", fee: milli(200).toString(), back: null, tx: null, forfeit: milli(80).toString(), bondsBack: milli(240).toString() });
    expect(j.settlement!.payouts.map((p) => [p.mask.name, p.role, p.amount])).toEqual([
      ["JUNO", "scout", milli(760).toString()],
      ["HEX", "striker", milli(2280).toString()],
      [ROOK, "verifier", milli(760).toString()],
    ]);
    expect(j.steps.find((s) => s.mask.account === FARM)).toMatchObject({ counted: false, fake: true });
    // Fuel the job will cover: the trio's 0.025 + 0.06 + 0.03; FARM burned 0.08 for nothing and its own tank pays.
    expect(j.settlement!.toTreasury).toBe(milli(115).toString());
    expect(j.entrants[1]!.members[0]).toMatchObject({ burned: milli(80).toString(), covered: "0", payout: null, bond: { lost: milli(80).toString(), why: "fake", by: "test.near" } });
    expect(j.entrants[0]!.members.map((m) => [m.mask.name, m.bond.by, m.bond.lost])).toEqual([
      ["JUNO", "bob.test.near", "0"],
      ["HEX", "bob.test.near", "0"],
      [ROOK, "test.near", "0"],
    ]);
    expect(nextDeadline(j)).toEqual({ at: j.verdict!.appealUntil, what: "appeals close" });
  });

  it("keeps sealed steps sealed, shows revealed ones as boxes, and keeps each job's own bond and bar", async () => {
    const board = await replayJobs(recording).board();
    const audit = board.jobs.find((j) => j.id === "audit-0006")!;
    expect(audit).toMatchObject({ takes: true, slots: 8, masks: 5, reward: (12n * NEAR).toString(), bond: milli(500).toString(), bonds: [] });
    expect(audit.steps.every((s) => !s.revealed && s.content === null && /^[0-9a-f]{64}$/.test(s.hash) && s.counted === null)).toBe(true);
    expect(audit.entrants.flatMap((e) => e.members).every((m) => m.bond.amount === milli(500).toString() && m.bond.lost === null)).toBe(true);
    const tests = board.jobs.find((j) => j.id === "tests-0005")!;
    expect(tests).toMatchObject({ secrets: { profile: "vault-tests", account: "dao.test.near" }, bond: milli(200).toString(), bar: { winAt: 10, cases: 12 } });
    expect(tests.judge).toMatchObject({ by: "outlayer", project: "maskwars.testnet/tests", key: TESTS_KEY });
    expect(tests.steps.map((s) => [s.revealed, s.boxed])).toEqual([
      [true, true],
      [true, true],
      [false, false],
    ]);
    expect(nextDeadline(tests)).toEqual({ at: tests.revealUntil, what: "reveals close" });
  });

  it("reads a job the judge has not checked yet, and one whose judge asked to be run again later", async () => {
    const board = await replayJobs(recording).board();
    const unchecked = board.jobs.find((j) => j.id === "review-0009")!;
    expect(unchecked).toMatchObject({ phase: "checking", checked: false, takes: false, masks: 0, bond: milli(300).toString() });
    expect(unchecked.checkUntil).toBe(unchecked.openedAt + 6 * 3_600_000);
    expect(nextDeadline(unchecked)).toEqual({ at: unchecked.checkUntil, what: "the judge's check ends" });
    const held = board.jobs.find((j) => j.id === "review-0010")!;
    expect(held.phase).toBe("waiting");
    expect(held.retryAt).toBeGreaterThan(board.readAt);
    expect(held.retryAt! - board.readAt).toBeLessThan(25 * 60_000);
    expect(held.events.filter((e) => e.kind === "judge").map((e) => e.note)).toEqual(["the judge could not judge: NEAR AI answered 503: 1 of 1 entrants waits for its back-off"]);
  });

  it("counts a job as open to an outside agent only when it is: one limited to its client's listed masks is not", async () => {
    // The same reading, with the two open jobs limited by their client: audit-0006 to three listed masks, drain-0007 to
    // the masks of a factory. Nothing else in the chain's answers changes.
    const limited = withOpenTo({
      "audit-0006": { who: "masks", masks: [NOVA, ONYX, ROOK] },
      "drain-0007": { who: "registered", factories: ["masks.test.near"] },
    });
    const board = await replayJobs(limited).board();
    const audit = board.jobs.find((j) => j.id === "audit-0006")!;
    const drain = board.jobs.find((j) => j.id === "drain-0007")!;
    // audit-0006 still has room for its listed masks, and nobody else may take it.
    expect(audit).toMatchObject({ phase: "enlisting", room: true, takes: false, openTo: { who: "masks", masks: [NOVA, ONYX, ROOK] } });
    expect(drain).toMatchObject({ phase: "enlisting", room: true, takes: true, openTo: { who: "registered", factories: ["masks.test.near"] } });
    // What waits for outside agents is drain-0007's alone, and it is the biggest open job.
    expect(board.open).toBe(1);
    expect(board.waiting).toBe((5n * NEAR).toString());
    expect(board.waitingFuel).toBe(milli(600).toString());
    expect(board.biggest?.id).toBe("drain-0007");
    // The board lists the job outside agents can take first; audit-0006 stands with the other running jobs.
    expect(board.jobs[0]!.id).toBe("drain-0007");
    // On a network whose mask factory is not on chain yet nobody has a forged mask: the same job is offered to nobody.
    const unforged = await replayJobs(limited, { forge: false }).board();
    expect(unforged.jobs.find((j) => j.id === "drain-0007")).toMatchObject({ room: true, takes: false });
    expect(unforged).toMatchObject({ open: 0, biggest: null });
  });

  it("reads the factory's presence from the network: mainnet has it on chain, testnet has none, and each config says so", () => {
    expect(jobsConfigOf(NETWORKS.mainnet).forge).toBe(NETWORKS.mainnet.sections.forge);
    expect(jobsConfigOf(NETWORKS.mainnet).forge).toBe(true);
    expect(jobsConfigOf(NETWORKS.testnet).forge).toBe(false);
    expect(jobsConfigFromEnv({ MASKWARS_NETWORK: "mainnet" }).forge).toBe(true);
    expect(jobsConfigFromEnv({ MASKWARS_JOBS_CONTRACT: "jobs.test.near" }).forge).toBe(true);
  });

  it("has nothing open when every job with room is for its client's listed masks, or names no factory", async () => {
    const board = await replayJobs(
      withOpenTo({
        "audit-0006": { who: "masks", masks: [NOVA] },
        "drain-0007": { who: "registered", factories: [] },
      }),
    ).board();
    expect(board.jobs.filter((j) => j.room).map((j) => j.id).sort()).toEqual(["audit-0006", "drain-0007"]);
    expect(board.jobs.some((j) => j.takes)).toBe(false);
    expect(board).toMatchObject({ open: 0, waiting: "0", waitingFuel: "0", biggest: null });
  });

  it("names a factory's mask by its name and anyone else by the whole account, so nobody passes for another", async () => {
    const j = (await replayJobs(recording).job("review-0004"))!;
    const names = j.entrants.flatMap((e) => e.members.map((m) => [m.mask.name, m.mask.forged]));
    expect(names).toEqual([
      ["JUNO", true],
      ["HEX", true],
      [ROOK, false],
      [FARM, false],
    ]);
  });
});

describe("the seal, the box and the split, by the contract's own rules", () => {
  it("hashes a step exactly as the contract sealed it on chain", async () => {
    const j = (await replayJobs(recording).job("drain-0001"))!;
    const kira = j.steps[0]!;
    // The sandbox masks salt with `salt-<account with dashes>`, as the contracts' harness does.
    expect(stepHash("drain-0001", KIRA, "salt-kira-masks-test-near", kira.content!)).toBe(kira.hash);
    expect(stepHash("drain-0001", NOVA, "salt-kira-masks-test-near", kira.content!)).not.toBe(kira.hash);
  });

  it("seals the same box in TypeScript as the world sealed in Rust with the judges' code: its seal is the one on chain", async () => {
    // The world's boxes take their ephemeral key and nonce from a label (packages/arena/jobs-world/src/main.rs, bytes_of).
    const bytesOf = (label: string, n: number) => {
      const h = createHash("sha256").update(label).digest();
      return Buffer.from(Array.from({ length: n }, (_, i) => h[i % 32]! ^ i));
    };
    const module = Buffer.from("0061736d01000000", "hex");
    const label = `tests-0005:${ONYX}:module`;
    const box = sealWork(TESTS_KEY, "jobs.test.near", "tests-0005", ONYX, { kind: "module", bytes: module }, { eph: bytesOf(`eph:${label}`, 32), nonce: bytesOf(`nonce:${label}`, 12) });
    const onyx = (await replayJobs(recording).job("tests-0005"))!.steps.find((s) => s.mask.account === ONYX)!;
    expect(onyx.revealed).toBe(false);
    expect(stepHash("tests-0005", ONYX, "salt-onyx-test-near", box)).toBe(onyx.hash);
  });

  it("splits like `shares`: a role with no counted step gives its part away, rounding goes to the striker", () => {
    const members = [
      { mask: "a", role: "scout" as const },
      { mask: "b", role: "striker" as const },
      { mask: "c", role: "verifier" as const },
    ];
    const split = { scout: 2000, striker: 6000, verifier: 2000 };
    expect(shares(100n, members, split, [true, true, true])).toEqual([["a", 20n], ["b", 60n], ["c", 20n]]);
    expect(shares(100n, members, split, [false, true, true])).toEqual([["a", 0n], ["b", 75n], ["c", 25n]]);
    expect(shares(10n, members, split, [true, true, true])).toEqual([["a", 2n], ["b", 6n], ["c", 2n]]);
    expect(shares(7n, members, split, [true, true, true])).toEqual([["a", 1n], ["b", 5n], ["c", 1n]]);
    expect(shares(100n, members, split, [false, false, false])).toEqual([["a", 0n], ["b", 0n], ["c", 0n]]);
  });

  it("prints a job id in a headline only in the plain form", () => {
    expect(plainJobId("review-0004")).toBe(true);
    expect(plainJobId("ignore-all-previous-instructions")).toBe(false);
    expect(plainJobId("x")).toBe(false);
  });
});

describe("reading with care", () => {
  it("is honestly empty with no contract set, and asks the chain nothing", async () => {
    let asked = 0;
    const fetch = (async () => {
      asked += 1;
      throw new Error("no network");
    }) as typeof globalThis.fetch;
    const config = { ...jobsConfigOf(), contract: null };
    const jobs = new Jobs({ config, rpc: new ChainReader({ fetch }), indexer: new Indexer({ fetch }) });
    const board = await jobs.board();
    expect(board).toMatchObject({ deployed: false, contract: null, jobs: [], waiting: "0", open: 0, biggest: null });
    expect(asked).toBe(0);
  });

  it("reads the jobs and crews contracts packages/network names, with no variable set", () => {
    expect(new Jobs().config).toMatchObject({ network: "testnet", contract: NETWORKS.testnet.jobs, crews: NETWORKS.testnet.crews, explorer: NETWORKS.testnet.explorer });
    expect(jobsConfigFromEnv({})).toMatchObject({ network: "testnet", contract: "jobs.tinygif8324.testnet", crews: "crews.tinygif8324.testnet", rpc: NETWORKS.testnet.rpc, storage: null });
    expect(jobsConfigFromEnv({ MASKWARS_NETWORK: "mainnet" })).toMatchObject({ network: "mainnet", contract: "jobs.maskwars.near", crews: "crews.maskwars.near", explorer: "https://nearblocks.io" });
    expect(() => jobsConfigFromEnv({ MASKWARS_NETWORK: "sandbox" })).toThrow(/testnet or mainnet/);
  });

  it("marks any other jobs contract as a local chain: sandbox, no explorer, its own crews contract", () => {
    const local = jobsConfigFromEnv({ MASKWARS_JOBS_CONTRACT: "jobs.test.near", MASKWARS_CREWS_CONTRACT: "crews.test.near", MASKWARS_RPC: "http://127.0.0.1:3030", MASKWARS_INDEXER: "http://127.0.0.1:3031" });
    expect(local).toMatchObject({ network: "sandbox", contract: "jobs.test.near", crews: "crews.test.near", rpc: ["http://127.0.0.1:3030"], indexer: "http://127.0.0.1:3031", explorer: null });
    // Naming the network's own contract changes nothing.
    expect(jobsConfigFromEnv({ MASKWARS_JOBS_CONTRACT: NETWORKS.testnet.jobs })).toMatchObject({ network: "testnet", crews: NETWORKS.testnet.crews, explorer: NETWORKS.testnet.explorer });
  });

  it("is honestly empty when the contract's account is not on chain yet", async () => {
    const fetch = (async (_: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      if (body.method === "block") {
        return Response.json({ jsonrpc: "2.0", id: 1, result: { header: { height: 7, hash: "h", timestamp_nanosec: "1800000000000000000" } } });
      }
      return Response.json({ jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } });
    }) as typeof globalThis.fetch;
    const config = { network: "testnet", contract: "jobs.maskwars.testnet", crews: null, rpc: ["https://rpc.example"], indexer: "https://idx.example", explorer: null };
    const board = await new Jobs({ config, rpc: new ChainReader({ endpoints: config.rpc, fetch }), indexer: new Indexer({ fetch }) }).board();
    expect(board).toMatchObject({ deployed: false, contract: "jobs.maskwars.testnet", jobs: [], block: { height: 7 } });
  });

  it("reads once for many callers, and keeps the jobs that are over after the first reading", async () => {
    let now = recording.recordedAt;
    const { jobs, calls } = counting({ now: () => now });
    await Promise.all([jobs.board(), jobs.board(), jobs.job("review-0001")]);
    const first = calls.length;
    expect(calls.filter((c) => c.includes('"method":"block"')).length).toBe(1);
    await jobs.board();
    expect(calls.length).toBe(first);
    now += 6_000;
    await jobs.board();
    const second = calls.slice(first);
    // The second reading asks for the live jobs again, never for a job that is over.
    const asked = (id: string) => second.filter((c) => c.includes(Buffer.from(JSON.stringify({ id })).toString("base64").slice(0, 12))).length;
    expect(second.some((c) => c.includes("/v0/transactions"))).toBe(false);
    expect(asked("audit-0006")).toBeGreaterThan(0);
  });

  it("reads a paid private job again until its work is delivered: the delivery comes after the payout", async () => {
    // The recording with review-0001's deliver event left out of its transaction: paid, not delivered yet.
    const withoutDelivery = (base: typeof fetch) =>
      (async (input: string | URL | Request, init?: RequestInit) => {
        const res = await base(input, init);
        if (!String(input instanceof Request ? input.url : input).includes("/v0/transactions")) return res;
        const text = await res.text();
        return new Response(text.replace(/"EVENT_JSON:[^"\\]*(?:\\.[^"\\]*)*"/g, (log) => (log.includes('\\"event\\":\\"deliver\\"') ? '"delivered elsewhere"' : log)), { status: res.status, headers: res.headers });
      }) as typeof fetch;
    let now = recording.recordedAt;
    const jobs = replayJobs(recording, { now: () => now, wrap: withoutDelivery });
    const first = await jobs.board();
    const review = first.jobs.find((j) => j.id === "review-0001")!;
    expect(review).toMatchObject({ phase: "paid", private: true, delivery: null });
    now += 6_000;
    const second = await jobs.board();
    // Read again, not kept: the next reading would show the delivery. A drain that is paid has nothing more to come.
    expect(second.jobs.find((j) => j.id === "review-0001")).not.toBe(review);
    expect(second.jobs.find((j) => j.id === "drain-0001")).toBe(first.jobs.find((j) => j.id === "drain-0001"));
    // With its delivery on chain, a paid review is kept like any job that is over.
    const full = replayJobs(recording, { now: () => now });
    const once = (await full.job("review-0001"))!;
    now += 6_000;
    expect(await full.job("review-0001")).toBe(once);
  });

  it("serves the last good reading when the chain stops answering, marked stale and never as happening now", async () => {
    let now = recording.recordedAt;
    const { jobs, breakIt } = counting({ now: () => now });
    const good = await jobs.board();
    expect(good.stale).toBe(false);
    expect(isFresh(good, jobs.clock())).toBe(true);
    breakIt(/./);
    now += 10_000;
    const kept = await jobs.board();
    // The same jobs, with the time of the block they were read at: only the mark changes.
    expect(kept).toEqual({ ...good, stale: true });
    expect(kept.readAt).toBe(good.readAt);
    expect(isFresh(kept, jobs.clock())).toBe(false);
    // A deadline is the chain's: a countdown against the reader's clock keeps running down while the chain is silent.
    const before = good.jobs.find((j) => j.id === "audit-0006")!.workUntil;
    const audit = kept.jobs.find((j) => j.id === "audit-0006")!;
    expect(audit.workUntil).toBe(before);
    expect(audit.workUntil - jobs.clock()).toBe(before - recording.recordedAt - 10_000);
    // The chain answers again: the next reading is a fresh one.
    breakIt(null);
    now += 6_000;
    const back = await jobs.board();
    expect(back.stale).toBe(false);
    expect(isFresh(back, jobs.clock())).toBe(true);
  });

  it("does not call a reading fresh once its block is older than the bound, even when every request answered", async () => {
    let now = recording.recordedAt;
    const { jobs } = counting({ now: () => now });
    const board = await jobs.board();
    expect(isFresh(board, board.readAt + FRESH_MS)).toBe(true);
    expect(isFresh(board, board.readAt + FRESH_MS + 1)).toBe(false);
    // An RPC node stuck on an old block answers every request with that block: the reading is not stale, and not fresh.
    now += FRESH_MS + 30_000;
    const stuck = await jobs.board();
    expect(stuck.stale).toBe(false);
    expect(stuck.readAt).toBe(board.readAt);
    expect(isFresh(stuck, jobs.clock())).toBe(false);
  });

  it("reads the newest jobs and the newest transactions only, however many the contract holds", async () => {
    const JOBS = 130;
    const TXS = 3_000;
    const HEIGHT = 9_000_000;
    const at = Date.UTC(2026, 10, 10, 12, 0, 0);
    const ns = (ms: number) => `${BigInt(ms) * 1_000_000n}`;
    const rawJob = (i: number) => ({
      id: `old-${String(i).padStart(4, "0")}`,
      client: "client.test.near",
      terms: {
        kind: "ai_review",
        brief: "A job that was taken back.",
        spec: "0".repeat(64),
        rubric: "1".repeat(64),
        judge: { kind: "ai_review", project: "maskwars.testnet/review", version: "2".repeat(64), key: REVIEW_KEY },
        round: null,
        secrets: null,
        bar: null,
        reward: NEAR.toString(),
        fee_bps: 500,
        fee_to: "fee.test.near",
        fuel_per_mask: milli(10).toString(),
        slots: 1,
        bond: milli(10).toString(),
        client_key: CLIENT_KEY,
        open_to: { who: "anyone" },
        meter: "meter.test.near",
        treasury: "treasury.test.near",
        outlayer: "outlayer.test.near",
        crews: "crews.test.near",
        opened_ns: ns(at - (JOBS - i) * 60_000),
        work_until: ns(at),
        reveal_until: ns(at),
        judge_until: ns(at),
        appeal_minutes: 10,
      },
      status: { state: "cancelled" },
      masks: 0,
      entrants: 0,
      steps: 0,
      runs: 0,
      verdict: null,
      prior: null,
      appeal: null,
      checked: false,
      left: 0,
      retry_at: "0",
      phase: "cancelled",
    });
    const lists: { from_index: number; limit: number }[] = [];
    const asked = new Set<string>();
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.endsWith("/v0/account")) {
        // 200 rows a page, newest first, as the indexer pages an account's history.
        const top = typeof body["max_block_height"] === "number" ? body["max_block_height"] : HEIGHT;
        const rows = [];
        for (let h = top; h > HEIGHT - TXS && rows.length < 200; h--) rows.push({ transaction_hash: `tx${h}`, tx_block_height: h, tx_block_timestamp: ns(at), is_function_call: true });
        return json({ account_txs: rows, txs_count: TXS });
      }
      if (url.endsWith("/v0/transactions")) {
        for (const h of body["tx_hashes"] as string[]) asked.add(h);
        return json({ transactions: [] });
      }
      const ok = (result: unknown) => json({ jsonrpc: "2.0", id: body["id"] ?? "x", result });
      if (body["method"] === "block") return ok({ header: { height: HEIGHT, hash: "h", timestamp_nanosec: ns(at) } });
      const params = body["params"] as Record<string, unknown>;
      const view = (value: unknown) => ok({ result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: HEIGHT, block_hash: "h" });
      if (params["request_type"] === "view_account") return ok({ amount: "1", locked: "0", code_hash: "7oJRkGfNcAkz5ZnzBnDiKaeNAYA6k28TF7UFWcoPkGCG", storage_usage: 1, storage_paid_at: 0, block_height: HEIGHT, block_hash: "h" });
      if (params["method_name"] === "config") {
        return view({ meter: "m", treasury: "t", outlayer: "o", crews: "c", judges: [], bounties: [], factories: [], fee_bps: 500, fee_to: "f", jobs: JOBS, live: 0, pending: null, judge_fee: "1", appeal_bond: "1", max_slots: 16, max_steps: 4 });
      }
      if (params["method_name"] === "list") {
        const args = JSON.parse(Buffer.from(String(params["args_base64"]), "base64").toString("utf8")) as { from_index: number; limit: number };
        lists.push(args);
        return view(Array.from({ length: Math.max(0, Math.min(args.limit, JOBS - args.from_index)) }, (_, k) => rawJob(args.from_index + k)));
      }
      throw new Error(`not asked for in this test: ${JSON.stringify(params)}`);
    }) as typeof globalThis.fetch;
    const config = { network: "sandbox", contract: "jobs.test.near", crews: null, rpc: ["http://rpc.test"], indexer: "http://indexer.test", explorer: null };
    const board = await new Jobs({ config, rpc: new ChainReader({ endpoints: config.rpc, fetch }), indexer: new Indexer({ base: config.indexer, fetch }), now: () => at }).board();
    expect(lists).toEqual([
      { from_index: JOBS - BOARD_JOBS, limit: 50 },
      { from_index: JOBS - BOARD_JOBS + 50, limit: 50 },
    ]);
    expect(board.total).toBe(JOBS);
    expect(board.jobs.length).toBe(BOARD_JOBS);
    // Newest first; the oldest job the board holds is the first of the window, and nothing before it was asked for.
    expect(board.jobs[0]!.id).toBe(`old-${String(JOBS - 1).padStart(4, "0")}`);
    expect(board.jobs.at(-1)!.id).toBe(`old-${String(JOBS - BOARD_JOBS).padStart(4, "0")}`);
    expect(asked.size).toBe(BOARD_TXS);
    expect(asked.has(`tx${HEIGHT}`)).toBe(true);
    expect(asked.has(`tx${HEIGHT - BOARD_TXS}`)).toBe(false);
  });

  it("still reads live jobs from their views when the indexer is down, and says the history is missing", async () => {
    const { jobs, breakIt } = counting();
    breakIt(/:3031\//);
    const board = await jobs.board();
    const audit = board.jobs.find((j) => j.id === "audit-0006")!;
    expect(audit.history).toBe(false);
    expect(audit.entrants.length).toBe(3);
    expect(audit.events).toEqual([]);
    const paid = board.jobs.find((j) => j.id === "review-0001")!;
    expect(paid).toMatchObject({ phase: "paid", history: false, entrants: [], delivery: null });
    expect(paid.verdict?.winner).toBe(0);
  });
});
