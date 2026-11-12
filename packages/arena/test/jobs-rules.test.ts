import { readFileSync } from "node:fs";
import { ChainReader } from "@maskwars/check";
import { NETWORKS } from "@maskwars/network";
import { describe, expect, it } from "vitest";
import { Indexer } from "../src/index.ts";
import { APPEAL_BOND, BOND_STORAGE, BOX, JUDGE_FEE, Jobs, KINDS, MASK_CREW_METHODS, MASK_JOB_METHODS, MAX_CONTENT_BYTES, MAX_STEPS, PHASES, ROLES, RULES, jobsConfigOf, rosterProblem } from "../src/jobs/index.ts";
import { emptyJobs, emptyJobsFetch, readRecording, replayJobs } from "../src/jobs/fixture.ts";

const jobsRs = readFileSync(new URL("../../../contracts/jobs/src/lib.rs", import.meta.url), "utf8");
const crewsRs = readFileSync(new URL("../../../contracts/crews/src/lib.rs", import.meta.url), "utf8");
const recording = readRecording(new URL("./fixtures/jobs-sandbox.json", import.meta.url));

/** A constant of the contract, as its source states it: a number, or yoctoNEAR for a NearToken. */
function constant(source: string, name: string): bigint {
  const m = new RegExp(`const ${name}: [A-Za-z0-9]+ = ([^;]+);`).exec(source);
  if (!m) throw new Error(`${name} is not in the contract`);
  const text = m[1]!.trim();
  const token = /^NearToken::from_(millinear|near)\((\d+)\)$/.exec(text);
  if (token) return BigInt(token[2]!) * (token[1] === "near" ? 10n ** 24n : 10n ** 21n);
  const gas = /^Gas::from_tgas\((\d+)\)$/.exec(text);
  if (gas) return BigInt(gas[1]!);
  if (/^[\d_ *]+$/.test(text)) return text.split("*").reduce((a, x) => a * BigInt(x.replace(/_/g, "").trim()), 1n);
  throw new Error(`${name} = ${text}: not a plain number`);
}

/** The variants of an enum the contract serializes in snake_case. */
function variants(source: string, name: string): string[] {
  const body = new RegExp(`pub enum ${name} \\{([\\s\\S]*?)\\n\\}`).exec(source)?.[1] ?? "";
  return [...body.matchAll(/^ {4}([A-Z][A-Za-z]+)/gm)].map((m) => m[1]!.replace(/[A-Z]/g, (c, i: number) => (i ? "_" : "") + c.toLowerCase()));
}

describe("the rules are the contract's", () => {
  it("states every limit as contracts/jobs holds it", () => {
    const jobs = (name: string) => constant(jobsRs, name);
    expect(BigInt(RULES.maxSlots)).toBe(jobs("MAX_SLOTS"));
    expect(BigInt(RULES.minCrew)).toBe(jobs("MIN_CREW"));
    expect(BigInt(RULES.maxCrew)).toBe(jobs("MAX_CREW"));
    expect(BigInt(RULES.maxSteps)).toBe(jobs("MAX_STEPS"));
    expect(BigInt(MAX_STEPS)).toBe(jobs("MAX_STEPS"));
    expect(BigInt(RULES.maxContentBytes)).toBe(jobs("MAX_CONTENT_BYTES"));
    expect(BigInt(MAX_CONTENT_BYTES)).toBe(jobs("MAX_CONTENT_BYTES"));
    expect(BigInt(RULES.boxChars)).toBe(jobs("BOX_CHARS"));
    expect(jobsRs).toContain(`pub const BOX_PREFIX: &str = "${RULES.boxPrefix}";`);
    expect(BOX.test(RULES.boxPrefix + "A".repeat(RULES.boxChars))).toBe(true);
    expect(BOX.test(RULES.boxPrefix + "A".repeat(RULES.boxChars - 1))).toBe(false);
    expect(BigInt(RULES.maxBriefBytes)).toBe(jobs("MAX_BRIEF_BYTES"));
    expect(BigInt(RULES.minReward)).toBe(jobs("MIN_REWARD"));
    expect(BigInt(RULES.minFuel)).toBe(jobs("MIN_FUEL"));
    expect(BigInt(RULES.maxFuel)).toBe(jobs("MAX_FUEL"));
    expect(BigInt(RULES.judgeFee)).toBe(jobs("JUDGE_FEE"));
    expect(BigInt(JUDGE_FEE)).toBe(jobs("JUDGE_FEE"));
    expect(BigInt(RULES.judgeRuns)).toBe(jobs("JUDGE_RUNS"));
    expect(BigInt(RULES.appealBond)).toBe(jobs("APPEAL_BOND"));
    expect(BigInt(APPEAL_BOND)).toBe(jobs("APPEAL_BOND"));
    expect(BigInt(RULES.idleBps)).toBe(jobs("IDLE_BPS"));
    expect(BigInt(RULES.maxFeeBps)).toBe(jobs("MAX_FEE_BPS"));
    expect(BigInt(RULES.bondRecordBytes)).toBe(jobs("BOND_RECORD_BYTES"));
    expect(BigInt(BOND_STORAGE)).toBe(jobs("BOND_RECORD_BYTES") * 10n ** 19n);
    expect(BigInt(RULES.maskStorageBytes)).toBe(jobs("MASK_STORAGE_BYTES"));
    expect(BigInt(RULES.leftSeatBytes)).toBe(jobs("LEFT_SEAT_BYTES"));
    expect(BigInt(RULES.jobGrowthBytes)).toBe(jobs("JOB_GROWTH_BYTES"));
    expect(BigInt(RULES.jobRecordBytes)).toBe(jobs("JOB_RECORD_BYTES"));
    expect(BigInt(RULES.maxLiveJobsPerMask)).toBe(jobs("MAX_LIVE_JOBS_PER_MASK"));
    expect(BigInt(RULES.checkHours)).toBe(jobs("CHECK_HOURS"));
    expect(BigInt(RULES.judgeGraceHours)).toBe(jobs("JUDGE_GRACE_HOURS"));
    expect(BigInt(RULES.appealGraceHours)).toBe(jobs("APPEAL_GRACE_HOURS"));
    expect(BigInt(RULES.maxWorkMinutes)).toBe(jobs("MAX_WORK_MINUTES"));
    expect(BigInt(RULES.drainRoundHours)).toBe(jobs("DRAIN_ROUND_HOURS"));
    // The longest life of a job, as the contract adds it up from its own windows.
    expect(jobsRs).toContain("pub const MAX_JOB_HOURS: u64 = CHECK_HOURS + 3 * 24 + 24 + JUDGE_GRACE_HOURS + 24 + APPEAL_GRACE_HOURS;");
    expect(RULES.maxJobHours).toBe(RULES.checkHours + 3 * 24 + 24 + RULES.judgeGraceHours + 24 + RULES.appealGraceHours);
    expect(RULES.maxJobHours).toBe(144);
    expect(BigInt(RULES.maxRetryWaitMinutes)).toBe(jobs("MAX_RETRY_WAIT_MINUTES"));
    expect(BigInt(RULES.maxReviewWinAt)).toBe(jobs("MAX_REVIEW_WIN_AT"));
    expect(BigInt(RULES.minJudgeTgas)).toBe(jobs("MIN_JUDGE_GAS"));
    expect(BigInt(RULES.minSettleTgas)).toBe(jobs("MIN_SETTLE_GAS"));
  });

  it("names kinds, roles and phases as the contract serializes them", () => {
    expect(variants(jobsRs, "Kind")).toEqual([...KINDS]);
    expect(variants(jobsRs, "Role")).toEqual([...ROLES]);
    // `phase` in the contract's own words: the comment on JobView lists every one.
    const listed = /pub retry_at: U64,\n((?:\s*\/\/\/.*\n)+)\s*pub phase: String,/.exec(jobsRs)?.[1] ?? "";
    expect([...listed.matchAll(/`([a-z]+)`/g)].map((m) => m[1])).toEqual([...PHASES]);
    for (const phase of PHASES) expect(jobsRs).toContain(`"${phase}"`);
  });

  it("names the methods a mask's narrow key calls, and they are the contracts' own", () => {
    for (const m of MASK_JOB_METHODS) expect(jobsRs).toMatch(new RegExp(`pub fn ${m}\\(&mut self, id: String`));
    for (const m of MASK_CREW_METHODS) expect(crewsRs).toMatch(new RegExp(`pub fn ${m}\\(&mut self, id: String`));
    // A payable method takes NEAR, which a narrow key cannot attach: none of these is one.
    for (const m of MASK_JOB_METHODS) expect(jobsRs).not.toMatch(new RegExp(`#\\[payable\\]\\s+pub fn ${m}\\(`));
    for (const m of ["bond", "open", "appeal", "deliver"]) expect(jobsRs).toMatch(new RegExp(`#\\[payable\\]\\s+(#\\[[^\\]]+\\]\\s+)?pub fn ${m}\\(`));
  });

  it("holds a crew to the crews contract's own roster rule", () => {
    expect(BigInt(RULES.minCrew)).toBe(constant(crewsRs, "MIN_CREW"));
    expect(BigInt(RULES.maxCrew)).toBe(constant(crewsRs, "MAX_CREW"));
    expect(BigInt(RULES.maxCrewsPerMask)).toBe(constant(crewsRs, "MAX_CREWS_PER_MASK"));
    expect(BigInt(RULES.crewSeatBytes)).toBe(constant(crewsRs, "SEAT_BYTES"));
    expect(crewsRs).toContain("(3..=32).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')");
    expect(RULES.crewId.test("trio-7")).toBe(true);
    expect(RULES.crewId.test("ab")).toBe(false);
    expect(RULES.crewId.test("Trio")).toBe(false);
    const duo = [
      { mask: "a.near", role: "scout" as const },
      { mask: "b.near", role: "striker" as const },
    ];
    expect(rosterProblem(duo, { scout: 3000, striker: 7000, verifier: 0 })).toBeNull();
    expect(rosterProblem(duo, { scout: 3000, striker: 6000, verifier: 1000 })).toMatch(/nobody is a verifier/);
    expect(rosterProblem(duo, { scout: 0, striker: 10_000, verifier: 0 })).toMatch(/scout gets nothing/);
    expect(rosterProblem(duo, { scout: 3000, striker: 6000, verifier: 0 })).toMatch(/sums to 10000/);
    expect(rosterProblem([duo[0]!, { mask: "c.near", role: "scout" }], { scout: 10_000, striker: 0, verifier: 0 })).toMatch(/a striker/);
    expect(rosterProblem([duo[1]!], { scout: 0, striker: 10_000, verifier: 0 })).toMatch(/2 to 8 masks/);
    expect(rosterProblem([duo[1]!, duo[1]!], { scout: 0, striker: 10_000, verifier: 0 })).toMatch(/one seat/);
  });
});

describe("the market, as the contract's config says it", () => {
  it("reads the fee, the judges with their TEE keys, the crews contract and the limits", async () => {
    const board = await replayJobs(recording).board();
    expect(board.market).toMatchObject({
      feeBps: 500,
      feeTo: "company.test.near",
      meter: "keeper.test.near",
      treasury: "treasury.test.near",
      outlayer: "outlayer.test.near",
      crews: "crews.test.near",
      bounties: ["bounty.test.near"],
      factories: ["masks.test.near"],
      judgeFee: RULES.judgeFee,
      appealBond: RULES.appealBond,
      maxSlots: RULES.maxSlots,
      maxSteps: RULES.maxSteps,
      jobs: 10,
      live: 6,
      changing: false,
    });
    expect(board.market!.judges.map((j) => j.kind).sort()).toEqual(["ai_review", "tee_tests"]);
    for (const j of board.market!.judges) {
      expect(j.version).toMatch(/^[0-9a-f]{64}$/);
      expect(j.key).toMatch(/^x25519:[0-9a-f]{64}$/);
    }
    // Every live job of a kind runs on the judge the contract holds for it.
    for (const job of board.jobs) {
      if (job.judge.by !== "outlayer") continue;
      const module = board.market!.judges.find((j) => j.kind === job.kind)!;
      expect(job.judge).toMatchObject({ project: module.project, version: module.version, key: module.key });
    }
  });

  it("reads every view of one reading at one final block", () => {
    const blocks = new Set<unknown>();
    let head = 0;
    for (const e of recording.exchanges) {
      const r = e.request as { method?: string; params?: { finality?: string; block_id?: number; method_name?: string } } | null;
      if (!r?.method) continue;
      // A crew is a reading of its own, one view at the final block: the crew tools replay it.
      if (r.params?.method_name === "get_crew") {
        expect(r.params.finality).toBe("final");
        continue;
      }
      if (r.method === "block") {
        expect(r.params?.finality).toBe("final");
        head += 1;
      } else {
        expect(r.params?.finality).toBeUndefined();
        blocks.add(r.params?.block_id);
      }
    }
    expect(head).toBe(1);
    expect(blocks.size).toBe(1);
  });
});

describe("a board with no job", () => {
  it("is not deployed while the network's jobs account does not exist, and says which account it asked", async () => {
    const board = await emptyJobs("undeployed").board();
    expect(board).toMatchObject({ network: "testnet", contract: NETWORKS.testnet.jobs, deployed: false, market: null, jobs: [], open: 0, waiting: "0", paid: "0", biggest: null });
    expect(board.block).not.toBeNull();
    const mainnet = await emptyJobs("undeployed", jobsConfigOf(NETWORKS.mainnet)).board();
    expect(mainnet).toMatchObject({ network: "mainnet", contract: "jobs.maskwars.near", deployed: false, jobs: [] });
  });

  it("is deployed and empty right after the contract is: its settings are read, no job is made up", async () => {
    const board = await emptyJobs("deployed").board();
    expect(board).toMatchObject({ network: "testnet", contract: NETWORKS.testnet.jobs, deployed: true, jobs: [], open: 0, waiting: "0", paid: "0", biggest: null });
    expect(board.market).toMatchObject({ jobs: 0, live: 0, judges: [], crews: NETWORKS.testnet.crews, feeBps: 500 });
  });
});

describe("whether jobs run on a network at all", () => {
  /** The deployed world, with one account asked for answered as if it did not exist. */
  function without(gone: string): typeof fetch {
    const base = emptyJobsFetch("deployed");
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { params?: { account_id?: string } }) : null;
      if (body?.params?.account_id === gone) body.params.account_id = "gone.testnet";
      return base(input, body ? { ...init, body: JSON.stringify(body) } : init);
    }) as typeof fetch;
  }
  const reader = (fetch: typeof globalThis.fetch, config = jobsConfigOf()) => new Jobs({ config, rpc: new ChainReader({ endpoints: config.rpc, fetch }), indexer: new Indexer({ fetch }) });

  it("they do once the jobs contract and the crews contract it names are both on chain and answer", async () => {
    expect(await emptyJobs("deployed").ready()).toBe(true);
  });

  it("they do not before the jobs contract is deployed, on testnet or on mainnet", async () => {
    expect(await emptyJobs("undeployed").ready()).toBe(false);
    expect(await emptyJobs("undeployed", jobsConfigOf(NETWORKS.mainnet)).ready()).toBe(false);
    expect(await reader(emptyJobsFetch("undeployed"), { ...jobsConfigOf(), contract: null }).ready()).toBe(false);
  });

  it("they do not while the crews contract the jobs contract names is missing: no crew could take a job", async () => {
    expect(await reader(without(NETWORKS.testnet.crews)).ready()).toBe(false);
    expect(await reader(without(NETWORKS.testnet.jobs)).ready()).toBe(false);
  });

  it("says nothing when no RPC answers, so a caller keeps to what it knew", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await reader(down).ready()).toBeNull();
    const hung = (() => new Promise<Response>(() => {})) as typeof fetch;
    expect(await reader(hung).ready(50)).toBeNull();
  });
});

describe("a crew, as the sandbox's crews contract answered", () => {
  it("reads TRIO and DUO with every seat joined, and no crew under an id nobody formed", async () => {
    const jobs = replayJobs(recording);
    expect(jobs.config.crews).toBe("crews.test.near");
    const trio = await jobs.crew("trio");
    expect(trio).toMatchObject({ id: "trio", contract: "crews.test.near", version: 1, ready: true, split: { scout: 2000, striker: 6000, verifier: 2000 } });
    expect(trio!.seats.map((s) => [s.role, s.joined])).toEqual([
      ["scout", true],
      ["striker", true],
      ["verifier", true],
    ]);
    // The roster on the job is the crew's: the jobs contract took it from the crews contract's ticket.
    const audit = (await jobs.board()).jobs.find((j) => j.id === "audit-0006")!;
    const entrant = audit.entrants.find((e) => e.crew === "trio")!;
    expect(entrant.members.map((m) => [m.mask.account, m.role])).toEqual(trio!.seats.map((s) => [s.mask, s.role]));
    expect(entrant.split).toEqual(trio!.split);
    expect(entrant.version).toBe(trio!.version);
    expect((await jobs.crew("duo"))!.split).toEqual({ scout: 3000, striker: 7000, verifier: 0 });
    expect(await jobs.crew("nobody-0000")).toBeNull();
  });
});

describe("a crew on the crews contract", () => {
  const config = jobsConfigOf();
  const crew = {
    id: "trio",
    captain: "hex.masks.tinygif8324.testnet",
    seats: [
      { mask: "juno.masks.tinygif8324.testnet", role: "scout", joined: true },
      { mask: "hex.masks.tinygif8324.testnet", role: "striker", joined: true },
      { mask: "rook.testnet", role: "verifier", joined: false },
    ],
    split: { scout: 2000, striker: 6000, verifier: 2000 },
    version: 2,
    ready: false,
    formed_ns: "1794250000000000000",
    jobs: 0,
  };

  function reader(answer: (args: { id: string }) => unknown, calls: string[] = []) {
    const fetch = (async (_: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: unknown; params: { account_id: string; method_name: string; args_base64: string; finality?: string } };
      calls.push(`${body.params.account_id}.${body.params.method_name}`);
      expect(body.params.finality).toBe("final");
      const result = answer(JSON.parse(Buffer.from(body.params.args_base64, "base64").toString()) as { id: string });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { result: [...Buffer.from(JSON.stringify(result))], logs: [], block_height: 9, block_hash: "h" } });
    }) as typeof globalThis.fetch;
    return new Jobs({ config, rpc: new ChainReader({ endpoints: config.rpc, fetch }), indexer: new Indexer({ fetch }), now: () => 1 });
  }

  it("reads its captain, seats, split and version from get_crew at a final block, once for many callers", async () => {
    const calls: string[] = [];
    const jobs = reader((a) => (a.id === "trio" ? crew : null), calls);
    const [a, b] = await Promise.all([jobs.crew("trio"), jobs.crew("trio")]);
    expect(a).toEqual({
      id: "trio",
      contract: NETWORKS.testnet.crews,
      captain: "hex.masks.tinygif8324.testnet",
      seats: crew.seats,
      split: crew.split,
      version: 2,
      ready: false,
      formedAt: 1794250000000,
      jobs: 0,
    });
    expect(b).toBe(a);
    expect(calls).toEqual([`${NETWORKS.testnet.crews}.get_crew`]);
    expect(await jobs.crew("nobody")).toBeNull();
    // A job keeps the crews contract it opened with: the crew is read there.
    await jobs.crew("trio", "crews.other.testnet");
    expect(calls.at(-1)).toBe("crews.other.testnet.get_crew");
  });

  it("has no crew where no crews contract is on chain, and asks nothing with none named", async () => {
    const none = new Jobs({ config, rpc: new ChainReader({ endpoints: config.rpc, fetch: emptyJobsFetch("undeployed") }), indexer: new Indexer({ fetch: emptyJobsFetch("undeployed") }) });
    expect(await none.crew("trio")).toBeNull();
    expect(await reader(() => crew).crew("trio", null)).toBeNull();
  });
});
