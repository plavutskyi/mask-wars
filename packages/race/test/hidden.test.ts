/**
 * Nothing anyone opens hides a job from the passes that answer for it. The board is the contract's newest sixty jobs,
 * and opening a job is cheap (its deposit comes back when it is cancelled): sixty of them pushed a job off the board
 * while our masks still sat on it with steps to reveal, or while the house's bonds still waited on it. Both passes now
 * read past the board, by each job's place in the contract's own list (`Jobs.older`, `wholeBoard`).
 *
 * The chain here is a stand-in that answers the jobs contract's views from a list of jobs written out below, in the
 * contract's own shapes: no recording holds more than sixty jobs.
 */
import { describe, expect, it } from "vitest";
import { ChainReader } from "@maskwars/check";
import { Indexer } from "@maskwars/arena";
import { BOARD_JOBS, Jobs } from "@maskwars/arena/jobs";
import { NETWORKS } from "@maskwars/network";
import { JsonRpc, NearKey, base58Encode } from "../src/near-tx.ts";
import { sponsor } from "../src/sponsor.ts";
import { JOB_LOOKBACK_MS, oursOn, plan, readFacts, wholeBoard, work } from "../src/work.ts";

const NET = NETWORKS.mainnet;
const RPC = "https://rpc.stand-in.example/";
const INDEXER = "https://indexer.stand-in.example";
const HEIGHT = 500;
const HASH = "11111111111111111111111111111111";
const BOND = (5n * 10n ** 22n).toString();
const MIN = 60_000;
const utc = (hh: number, mm: number, day = 13) => Date.UTC(2026, 10, day, hh, mm);
const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
const MASKS = Object.values(NET.masks);
const NAMES = Object.keys(NET.masks);
const X = "race-0200-ivy001";

interface Raw {
  id: string;
  client: string;
  phase: string;
  masks: number;
  entrants: number;
  steps: number;
  terms: { opened_ns: string } & Record<string, unknown>;
  [k: string]: unknown;
}

/** A drain on the house's round as the contract's `list` gives it. */
function drain(id: string, client: string, openedAt: number, o: { phase: string; work?: number; masks?: number; entrants?: number; steps?: number }): Raw {
  const work = o.work ?? 39;
  return {
    id,
    client,
    terms: {
      kind: "drain",
      brief: "Drain the house vault.",
      spec: "0".repeat(64),
      rubric: null,
      judge: null,
      round: { bounty: NET.bounty, id: "race-0200" },
      secrets: null,
      bar: null,
      reward: (10n ** 24n).toString(),
      fee_bps: 500,
      fee_to: NET.admin,
      fuel_per_mask: BOND,
      slots: 4,
      bond: BOND,
      client_key: null,
      open_to: { who: "anyone" },
      meter: NET.admin,
      treasury: NET.admin,
      outlayer: NET.outlayer.contract,
      crews: NET.crews,
      opened_ns: ns(openedAt),
      work_until: ns(openedAt + work * MIN),
      reveal_until: ns(openedAt + (work + 30) * MIN),
      judge_until: ns(openedAt + 37 * 60 * MIN),
      appeal_minutes: 10,
    },
    status: { state: o.phase === "cancelled" ? "cancelled" : "open" },
    masks: o.masks ?? 0,
    entrants: o.entrants ?? 0,
    steps: o.steps ?? 0,
    runs: 0,
    verdict: null,
    prior: null,
    appeal: null,
    checked: true,
    left: 0,
    retry_at: "0",
    phase: o.phase,
  };
}

/** `n` jobs somebody opened after `from` and cancelled at once, a few seconds apart: what hiding a job costs. */
const spam = (n: number, from: number) => Array.from({ length: n }, (_, i) => drain(`junk-${String(i).padStart(4, "0")}`, "spam.near", from + (i + 1) * 5_000, { phase: "cancelled" }));

interface World {
  now: number;
  /** In the order they opened, as the contract lists them. */
  jobs: Raw[];
  entrants?: Record<string, unknown[]>;
  steps?: Record<string, unknown[]>;
  /** `<job>/<mask>` → what `bond_of` answers. */
  bonds?: Record<string, { by: string; amount: string; enlisted: boolean }>;
}

/** The chain's answers, from `world`. Whatever it is not written to answer throws: a pass that asks more shows it. */
function standIn(world: World) {
  const lists: { from_index: number; limit: number }[] = [];
  const sent: string[] = [];
  const json = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result }), { status: 200, headers: { "content-type": "application/json" } });
  const view = (value: unknown) => json({ result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: HEIGHT, block_hash: HASH });
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(INDEXER)) throw new TypeError("fetch failed");
    const body = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> };
    const p = body.params;
    if (body.method === "block") return json({ header: { height: HEIGHT, hash: HASH, timestamp_nanosec: ns(world.now) } });
    if (body.method === "send_tx") {
      sent.push(String(p["signed_tx_base64"]));
      return json({ status: { SuccessValue: "" }, receipts_outcome: [] });
    }
    const account = String(p["account_id"]);
    if (p["request_type"] === "view_account") {
      return json({ amount: (3n * 10n ** 24n).toString(), locked: "0", code_hash: account === NET.jobs ? "3jYwLq7vDNsVK3UecrBgXJ9yWvDqfvFNrhoXyYhxvAvD" : HASH, storage_usage: 200, block_height: HEIGHT, block_hash: HASH });
    }
    if (p["request_type"] === "view_access_key") return json({ nonce: 7, permission: "FullAccess", block_height: HEIGHT, block_hash: HASH });
    const args = JSON.parse(Buffer.from(String(p["args_base64"]), "base64").toString("utf8")) as Record<string, unknown>;
    const method = String(p["method_name"]);
    if (account === NET.bounty) {
      if (method === "get") return view({ owner: NET.house, status: { state: "open" } });
      if (method === "get_safe") return view({ masks: MASKS });
      if (method === "get_round") return view({ commit_until: ns(utc(18, 49)), seals: [] });
    }
    if (account === NET.jobs) {
      const id = String(args["id"]);
      if (method === "config") {
        return view({ meter: NET.admin, treasury: NET.admin, outlayer: NET.outlayer.contract, crews: NET.crews, judges: [], bounties: [NET.bounty], factories: [], fee_bps: 500, fee_to: NET.admin, jobs: world.jobs.length, live: 1, pending: null, judge_fee: "10000000000000000000000", appeal_bond: "200000000000000000000000", max_slots: 16, max_steps: 4 });
      }
      if (method === "list") {
        const page = { from_index: Number(args["from_index"]), limit: Number(args["limit"]) };
        lists.push(page);
        return view(world.jobs.slice(page.from_index, page.from_index + Math.min(page.limit, 50)));
      }
      if (method === "entrants") return view(world.entrants?.[id] ?? []);
      if (method === "steps") return view(world.steps?.[id] ?? []);
      if (method === "fuel") return view([]);
      if (method === "bond_of") return view(world.bonds?.[`${id}/${String(args["mask"])}`] ?? null);
    }
    throw new Error(`the stand-in has no answer for ${account}.${method}`);
  }) as typeof fetch;
  const jobs = new Jobs({
    config: { network: "mainnet", contract: NET.jobs, crews: NET.crews, rpc: [RPC], indexer: INDEXER, explorer: null },
    rpc: new ChainReader({ endpoints: [RPC], fetch: f }),
    indexer: new Indexer({ base: INDEXER, fetch: f, timeoutMs: 1_000 }),
    ttlMs: 0,
  });
  return { jobs, chain: new JsonRpc(RPC, 10_000, f), lists, sent };
}

const ours = oursOn(NET, { masks: NET.masks, signers: NAMES, crew: null });
const seeds = Object.fromEntries(NAMES.map((n, i) => [n, String(i + 1).repeat(64)]));

describe("a job our masks sit on, pushed off the board by newer jobs", () => {
  // IVY's job, posted on /jobs at 18:05: our three masks took it and sealed their steps. It reveals from 18:44 to 19:14.
  const seated = drain(X, "ivy.near", utc(18, 5), { phase: "revealing", masks: 3, entrants: 3, steps: 3 });
  const world: World = {
    now: utc(18, 50),
    jobs: [seated, ...spam(130, utc(18, 6))],
    entrants: { [X]: MASKS.map((mask) => ({ crew: null, version: 0, members: [{ mask, role: "striker" }], split: { scout: 0, striker: 10_000, verifier: 0 } })) },
    steps: { [X]: MASKS.map((mask, seq) => ({ seq, entrant: seq, mask, role: "striker", hash: "ab".repeat(32), at_ns: ns(utc(18, 10)), content: null, digest: null, copy_of: null })) },
  };

  it("is not on the board, and is read all the same: every mask's step is revealed", async () => {
    const { jobs, chain, lists } = standIn(world);
    const newest = await jobs.board();
    expect([newest.total, newest.jobs.length]).toEqual([131, BOARD_JOBS]);
    expect(newest.jobs.some((j) => j.id === X)).toBe(false);
    // On the board alone, the plan knows nothing of the job: no step is revealed, and each seat loses half its bond.
    const blind = plan(newest, await readFacts(chain, newest, ours, NET.crews), ours);
    expect(blind.acts).toEqual([]);

    lists.length = 0;
    const pass = await work({ chain, jobs, jobsContract: NET.jobs, crewsContract: NET.crews, ours, seeds });
    expect(pass.board.jobs).toHaveLength(131);
    expect(pass.board.jobs.find((j) => j.id === X)).toMatchObject({ phase: "revealing", client: "ivy.near", masks: 3 });
    expect(pass.plan.acts).toEqual(NAMES.map((mask, seq) => ({ kind: "reveal", mask, job: X, seq, role: "striker", round: { bounty: NET.bounty, id: "race-0200" } })));
    expect(pass.plan.next).toBe(utc(19, 14));
    // Read by its place in the contract's list: the board's sixty, then page by page back to the first job.
    expect(lists).toEqual([
      { from_index: 71, limit: 50 },
      { from_index: 121, limit: 50 },
      { from_index: 21, limit: 50 },
      { from_index: 0, limit: 21 },
    ]);
  });

  it("looks back a week and no further: a job older than any job lives is not read", async () => {
    const { jobs } = standIn(world);
    const newest = await jobs.board();
    expect((await wholeBoard(jobs, newest)).jobs).toHaveLength(131);
    expect((await jobs.older(newest, utc(18, 5))).map((j) => j.id)[0]).toBe(X);
    // Opened a millisecond before the span: not in it, and the scan stops at the page that starts before the span.
    expect((await jobs.older(newest, utc(18, 5) + 1)).some((j) => j.id === X)).toBe(false);
    const old = standIn({ ...world, jobs: [drain(X, "ivy.near", world.now - JOB_LOOKBACK_MS - 1, { phase: "revealing" }), ...spam(130, utc(18, 6))] });
    const b = await old.jobs.board();
    expect((await wholeBoard(old.jobs, b)).jobs.some((j) => j.id === X)).toBe(false);
    // A board that holds every job asks nothing more.
    const small = standIn({ ...world, jobs: world.jobs.slice(0, BOARD_JOBS) });
    const all = await small.jobs.board();
    small.lists.length = 0;
    expect(await wholeBoard(small.jobs, all)).toBe(all);
    expect(small.lists).toEqual([]);
  });
});

describe("a bond of the house that waits, pushed off the board by newer jobs", () => {
  // The same job at 18:20: the house locked its masks' bonds, and four masks of somebody else took its four slots
  // before ours enlisted. Then sixty jobs were opened and cancelled.
  const sybils = [1, 2, 3, 4].map((n) => `sybil${n}.near`);
  const world: World = {
    now: utc(18, 20),
    jobs: [drain(X, "ivy.near", utc(18, 5), { phase: "enlisting", masks: 4, entrants: 4 }), ...spam(60, utc(18, 6))],
    entrants: { [X]: sybils.map((mask) => ({ crew: null, version: 0, members: [{ mask, role: "striker" }], split: { scout: 0, striker: 10_000, verifier: 0 } })) },
    bonds: Object.fromEntries(MASKS.map((mask) => [`${X}/${mask}`, { by: NET.house, amount: BOND, enlisted: false }])),
  };

  it("is found by the house's pass and taken back at once, all three in one transaction", async () => {
    const { jobs, chain, sent } = standIn(world);
    const newest = await jobs.board();
    expect(newest.jobs.some((j) => j.id === X)).toBe(false);
    const pass = await sponsor({
      chain,
      jobs,
      jobsContract: NET.jobs,
      crewsContract: NET.crews,
      ours,
      house: NET.house,
      key: new NearKey(`ed25519:${base58Encode(Buffer.alloc(32, 7))}`),
      keeps: 503n * 10n ** 21n,
      check: async () => "allow",
      houseSealUntil: async () => utc(18, 49),
      round: NET.round,
      nonceRetryMs: 0,
    });
    expect(pass.waiting).toEqual(MASKS.map((mask) => ({ job: X, mask, amount: BigInt(BOND) })));
    expect(pass.plan.acts).toEqual([{ kind: "unbond", job: X, masks: NAMES, back: 3n * BigInt(BOND) }]);
    expect(pass.done.map((d) => d.ok)).toEqual([true]);
    expect(sent).toHaveLength(1);
    // The job holds its place meanwhile: 0.162 NEAR out, and no other bond locked in this pass.
    expect(pass.plan.out).toBe(3n * (BigInt(BOND) + 4n * 10n ** 21n));
  });
});
