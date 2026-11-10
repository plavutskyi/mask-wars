// The vectors every implementation of MASK CHECK must answer alike (test/vectors.json). A vector is one check with
// everything it depends on written down: the account, the network, the shared list, the time, how the reader is set
// up, and every answer the RPC nodes gave. Its `expect` is what `maskCheck` answers. This package's tests replay the
// file (vectors.test.ts), and so does the module that runs the same check inside a TEE (services/check, `cargo test`):
// the two cannot drift apart without one of them failing.
//
//   pnpm --filter @maskwars/check vectors      writes test/vectors.json again after the check changes
//
// The scenarios come from what the other tests already use: the real answers of mainnet and testnet RPC
// (test/recorded/*.json) and the node in memory (test/chain.ts).
import { readFileSync } from "node:fs";
import { type CheckResult, InvalidAccountError, maskCheck } from "../src/check.ts";
import { type SharedList, parseList } from "../src/list.ts";
import { NETWORK, type Network } from "../src/network.ts";
import { ChainReader, MAX_LAG_BLOCKS, NO_CODE } from "../src/rpc.ts";
import { sharedLists } from "../src/index.ts";
import { CODE_A, CODE_B, FakeNode, HEAD, NEAR } from "./chain.ts";
import { type Recording, bodyOf, keyOf, replayFetch } from "./replay.ts";

/** One request and what came back: a JSON answer, a body that is not JSON, or no answer at all. */
export type VectorExchange = { url: string; method: string; params: unknown } & ({ status: number; response: unknown } | { status: number; body: string } | { fail: string });

export interface VectorReader {
  endpoints: string[];
  crossCheck: boolean;
  archival: Record<string, string>;
}

export interface Vector {
  name: string;
  network: Network;
  account: string;
  /** `"repo"`: the list of that network in this repo; otherwise the list itself. */
  list: "repo" | unknown;
  now_ms: number;
  window_hours: number;
  reader: VectorReader;
  exchanges: VectorExchange[];
  expect: CheckResult | { throws: "InvalidAccountError"; message: string };
}

export interface VectorFile {
  about: string;
  vectors: Vector[];
}

interface Scenario {
  name: string;
  network: Network;
  account: string;
  list?: unknown;
  nowMs: number;
  windowHours?: number;
  reader: VectorReader;
  fetch: typeof fetch;
}

type Fetch = typeof fetch;
type Wrap = (f: Fetch) => Fetch;

const load = (network: Network) => JSON.parse(readFileSync(new URL(`./recorded/${network}.json`, import.meta.url), "utf8")) as Recording;

function listOf(v: Pick<Vector, "list" | "network">): SharedList {
  return v.list === "repo" ? sharedLists[v.network] : parseList(v.list);
}

function readerOf(r: VectorReader, f: Fetch): ChainReader {
  return new ChainReader({ endpoints: r.endpoints, crossCheck: r.crossCheck, archival: r.archival, fetch: f });
}

async function answerOf(v: Pick<Vector, "account" | "network" | "list" | "now_ms" | "window_hours" | "reader">, f: Fetch): Promise<Vector["expect"]> {
  try {
    return await maskCheck(v.account, { network: v.network, reader: readerOf(v.reader, f), list: listOf(v), windowHours: v.window_hours, now: () => new Date(v.now_ms) });
  } catch (error) {
    if (error instanceof InvalidAccountError) return { throws: "InvalidAccountError", message: error.message };
    throw error;
  }
}

/** A fetch that writes down every request and what came back. The same request twice must get the same answer. */
function recording(inner: Fetch): { fetch: Fetch; kept: Map<string, VectorExchange> } {
  const kept = new Map<string, VectorExchange>();
  const keep = (e: VectorExchange) => {
    const key = keyOf(e.url, e.method, e.params);
    const before = kept.get(key);
    if (before && JSON.stringify(before) !== JSON.stringify(e)) throw new Error(`a vector needs one answer per request, got two for ${key}`);
    kept.set(key, e);
  };
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const { method, params } = bodyOf(init);
    let res: Response;
    try {
      res = await inner(input, init);
    } catch (error) {
      keep({ url, method, params, fail: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    const text = await res.clone().text();
    try {
      keep({ url, method, params, status: res.status, response: JSON.parse(text) as unknown });
    } catch {
      keep({ url, method, params, status: res.status, body: text });
    }
    return res;
  }) as Fetch;
  return { fetch: f, kept };
}

/** A fetch that answers from a vector's exchanges, and the requests the vector does not hold. */
export function vectorFetch(v: Pick<Vector, "exchanges">): { fetch: Fetch; unexpected: string[] } {
  const answers = new Map(v.exchanges.map((e) => [keyOf(e.url, e.method, e.params), e]));
  const unexpected: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const { method, params } = bodyOf(init);
    const key = keyOf(url, method, params);
    const hit = answers.get(key);
    if (!hit) {
      unexpected.push(key);
      throw new TypeError(`not in the vector: ${key}`);
    }
    if ("fail" in hit) throw new TypeError(hit.fail);
    const body = "body" in hit ? hit.body : JSON.stringify(hit.response);
    return new Response(body, { status: hit.status, headers: { "content-type": "application/json" } });
  }) as Fetch;
  return { fetch: f, unexpected };
}

/** What `maskCheck` answers a vector, read from the vector's own exchanges. */
export async function replay(v: Vector): Promise<{ got: Vector["expect"]; unexpected: string[] }> {
  const { fetch: f, unexpected } = vectorFetch(v);
  return { got: await answerOf(v, f), unexpected };
}

// --- the worlds ---

const FASTNEAR = "https://rpc.mainnet.fastnear.com";
const DRPC = "https://near.drpc.org";
const ARCHIVAL = "https://archival-rpc.mainnet.fastnear.com";
const A = "https://a.example";
const B = "https://b.example";
const ARCHIVE = "https://archive-a.example";

const BOUNTY = "tinygif8324.testnet";
const SAFE = "safe-0001.tinygif8324.testnet";
const MASKS = ["nova.tinygif8324.testnet", "onyx.tinygif8324.testnet", "oracle.tinygif8324.testnet"];
const DRAIN_TX = "9fWpu8aYc4ZbbGAfRRaRjP8dsRj3wvJZXzW7dG8u4nyH";
/** 24 h back at 0.6 s a block. */
const DAY = 144_000;
/** 2026-11-06T17:00:05Z, five seconds after the node's head. */
const NOW = 1_793_984_405_000;

const arenaList = {
  network: "testnet",
  about: "The arena's race-0003 safe, for the vectors.",
  arena: [{ contract: BOUNTY, race: "race-0003", safe: SAFE, owner_at_open: SAFE, note: "planted hole" }],
  reports: [],
};

const emptyMainnet = { network: "mainnet", about: "No arena safes and no reports, for the vectors.", arena: [], reports: [] };

const report = (account: string, level: "block" | "warn") => ({
  account,
  level,
  reason: level === "block" ? "Swept a faucet." : "Asked for payment under a name it does not hold.",
  evidence: [level === "block" ? { kind: "tx", hash: DRAIN_TX, note: "the sweep" } : { kind: "url", url: "https://example.com/report/17" }],
  reported_by: "maskwars",
  added: "2026-11-06",
});

function node(): FakeNode {
  return new FakeNode()
    .setAccount(BOUNTY, 1, { amount: (4n * NEAR).toString(), code_hash: CODE_A, storage_usage: 180_000 })
    .setAccount("old-plain.testnet", 1, { amount: NEAR.toString(), code_hash: NO_CODE, storage_usage: 182 });
}

function bounty(status: Record<string, unknown>, amount = NEAR / 10n) {
  return { owner: BOUNTY, amount: amount.toString(), target: SAFE, deadline_ns: "1762707600000000000", status };
}

function safeOn(n: FakeNode): FakeNode {
  return n.setAccount(SAFE, HEAD - 3 * DAY, { amount: (3n * NEAR).toString(), code_hash: CODE_B, storage_usage: 90_000 });
}

/** The safe and race-0003 as they stand on chain after the race opened. */
function arena(n: FakeNode, status: Record<string, unknown>, owner: string | null = SAFE, amount?: bigint): FakeNode {
  safeOn(n)
    .view(BOUNTY, "get", (a) => (a["id"] === "race-0003" ? bounty(status, amount) : null))
    .view(BOUNTY, "get_safe", (a) => (a["id"] === "race-0003" ? { safe: SAFE, masks: MASKS, min_loot: NEAR.toString(), opened_ns: "1762448400000000000" } : null));
  return owner === null ? n : n.view(SAFE, "get_owner", () => owner);
}

const failover = (endpoints = [A]): VectorReader => ({ endpoints, crossCheck: false, archival: {} });

function onTestnet(name: string, account: string, n: FakeNode, more: Partial<Scenario> = {}): Scenario {
  return { name, network: "testnet", account, list: arenaList, nowMs: NOW, reader: failover(), fetch: n.fetch, ...more };
}

/** Two nodes of one chain and an archival node of the first, as mainnet is read. */
function pair(tune: (nodes: { a: FakeNode; b: FakeNode; archive: FakeNode }) => void = () => {}): Fetch {
  const make = () =>
    new FakeNode()
      .setAccount("pay.near", 1, { amount: NEAR.toString(), code_hash: CODE_A, storage_usage: 300 })
      .setAccount("plain.near", 1, { amount: "7", code_hash: NO_CODE, storage_usage: 182 });
  const nodes = { a: make(), b: make(), archive: make() };
  nodes.archive.gcBelow = 0;
  tune(nodes);
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const n = url === A ? nodes.a : url === B ? nodes.b : url === ARCHIVE ? nodes.archive : null;
    if (!n) throw new TypeError("fetch failed");
    return n.fetch(input, init);
  }) as Fetch;
}

const crossCheck: VectorReader = { endpoints: [A, B], crossCheck: true, archival: { [A]: ARCHIVE } };

function onPair(name: string, account: string, f: Fetch, more: Partial<Scenario> = {}): Scenario {
  return { name, network: "mainnet", account, list: emptyMainnet, nowMs: NOW, reader: crossCheck, fetch: f, ...more };
}

/** Changes what one endpoint answers; every other request goes through. */
const at = (urls: string[], answer: (input: string | URL | Request, init: RequestInit | undefined, f: Fetch) => Promise<Response>): Wrap => {
  return (f) => (async (input: string | URL | Request, init?: RequestInit) => (urls.includes(String(input)) ? answer(input, init, f) : f(input, init))) as Fetch;
};

const lieAboutBalance = at([DRPC], async (input, init, f) => {
  const res = await f(input, init);
  if ((bodyOf(init).params as Record<string, unknown>)["request_type"] !== "view_account") return res;
  const body = (await res.json()) as { result?: { amount?: string } };
  if (body.result) body.result.amount = "1";
  return Response.json(body, { status: res.status });
});

/** One provider names a final head 100 000 blocks past the chain's: the other has no such block and would sit it out. */
const headAhead = at([DRPC], async (input, init, f) => {
  const res = await f(input, init);
  const { method, params } = bodyOf(init) as { method: string; params: Record<string, unknown> };
  if (method !== "block" || params["finality"] !== "final") return res;
  const body = (await res.json()) as { result: { header: { height: number } } };
  body.result.header.height += 100_000;
  return Response.json(body, { status: res.status });
});

const badGateway = at([DRPC], async () => new Response("<html>502 Bad Gateway</html>", { status: 502 }));

const rateLimited = at([FASTNEAR, ARCHIVAL], async () =>
  Response.json({ jsonrpc: "2.0", id: "1", error: { code: -429, message: "Rate limits exceeded. For higher rate limits get a subscription at https://fastnear.com" } }, { status: 429 }),
);

const unavailable: Wrap = () => (async () => new Response("", { status: 503 })) as Fetch;

/** The node answers 200 with the JSON `null`: a body, and no answer. */
const answersNull = (urls: string[]): Wrap => at(urls, async () => new Response("null", { status: 200, headers: { "content-type": "application/json" } }));

const unreachable = (urls: string[]): Wrap => at(urls, async () => Promise.reject(new TypeError("connect ECONNREFUSED")));

/** The state of an old block is gone from the node while the block itself is still there. */
const stateGone = (f: Fetch): Fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const { method, params } = bodyOf(init) as { method: string; params: Record<string, unknown> };
    const h = params["block_id"];
    if (method === "query" && typeof h === "number" && h < HEAD - 1_000) {
      const data = `The data for block #${h} is garbage collected on this node, use an archival node to fetch historical data`;
      return Response.json({ jsonrpc: "2.0", id: "maskwars-check", error: { name: "HANDLER_ERROR", cause: { name: "GARBAGE_COLLECTED_BLOCK", info: { block_height: h } }, code: -32000, message: "Server error", data } });
    }
    return f(input, init);
  }) as Fetch;

/** The bounty contract's `get` answers bytes that are no JSON. */
const garbled = (f: Fetch): Fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await f(input, init);
    if ((bodyOf(init).params as Record<string, unknown>)["method_name"] !== "get") return res;
    const body = (await res.json()) as { result: { result: number[] } };
    body.result.result = [...Buffer.from("not json")];
    return Response.json(body);
  }) as Fetch;

function recordedScenarios(network: Network): Scenario[] {
  const rec = load(network);
  const c = NETWORK[network];
  const reader: VectorReader = { endpoints: [...rec.endpoints], crossCheck: c.crossCheck, archival: { ...c.archival } };
  const world = (wrap?: Wrap) => (wrap ? wrap(replayFetch(rec).fetch) : replayFetch(rec).fetch);
  const one = (name: string, account: string, wrap?: Wrap): Scenario => ({ name, network, account, nowMs: Date.parse(rec.recorded_at), reader, fetch: world(wrap) });
  const live = rec.checks.map((check) => one(`${network}, as recorded: ${check.account}`, check.account));
  if (network === "testnet") return live;
  return [
    ...live,
    one("mainnet, as recorded: one provider lies about the balance of intents.near", "intents.near", lieAboutBalance),
    one("mainnet, as recorded: one provider names a final head far ahead of the chain to answer alone", "treasury.intents.near", headAhead),
    one("mainnet, as recorded: dRPC is down, FastNEAR answers alone", "intents.near", badGateway),
    one("mainnet, as recorded: FastNEAR is rate-limited, dRPC answers alone", "treasury.intents.near", rateLimited),
    one("mainnet, as recorded: neither provider answers", "intents.near", unavailable),
    one("mainnet, as recorded: neither provider can be reached", "usdt.tether-token.near", unreachable([FASTNEAR, DRPC, ARCHIVAL])),
  ];
}

function scenarios(): Scenario[] {
  const skipped = node();
  skipped.skipped.add(HEAD - DAY);
  skipped.skipped.add(HEAD - 10_000);
  const collected = node();
  collected.gcBelow = HEAD - 50_000;
  const down = node();
  down.down = 503;
  const downToo = node();
  downToo.down = 502;
  const legacy = safeOn(node()).view(BOUNTY, "get", () => bounty({ state: "open" }));
  legacy.legacyErrors = true;
  const noGetSafe = safeOn(node()).view(BOUNTY, "get", () => bounty({ state: "open" }));
  const reported = (level: "block" | "warn") => ({ ...arenaList, reports: [report("drainer.testnet", level)] });

  return [
    ...recordedScenarios("mainnet"),
    ...recordedScenarios("testnet"),

    onTestnet("an old plain account: allow", "old-plain.testnet", node()),
    onTestnet("the id is trimmed and lowercased", "  Old-Plain.TESTNET ", node()),
    onTestnet("the id is trimmed as JavaScript trims: a byte-order mark, a no-break space and a paragraph end go", "\uFEFF\u00A0old-plain.testnet\u2029 ", node()),
    onTestnet("a next-line character is no white space: with it the id is no account", "old-plain.testnet\u0085", node()),
    onTestnet("a safe a mask drained on the arena: block, with the drain transaction", SAFE, arena(node(), { state: "drained", winner: MASKS[0], tx_hash: DRAIN_TX }, MASKS[0])),
    onTestnet(
      "a drained race whose contract names no bounty, no deadline and no masks: block all the same",
      SAFE,
      safeOn(node())
        .view(BOUNTY, "get", () => ({ owner: BOUNTY, target: SAFE, status: { state: "drained", winner: MASKS[0], tx_hash: DRAIN_TX } }))
        .view(BOUNTY, "get_safe", () => ({ safe: SAFE })),
    ),
    onTestnet("a drained race whose winner is null: block, and the answer says null", SAFE, arena(node(), { state: "drained", winner: null, tx_hash: null })),
    onTestnet("a drained race that names no winner and no transaction: block, nothing to link", SAFE, arena(node(), { state: "drained" })),
    onTestnet("a safe whose get_owner answers something that is no account id: block, said as it came", SAFE, arena(node(), { state: "open" }, null).view(SAFE, "get_owner", () => ({ account: MASKS[1] }))),
    onTestnet("a safe taken over through the hole before the drain is judged: block and warn", SAFE, arena(node(), { state: "open" }, MASKS[1])),
    onTestnet("a safe in an open race nobody has taken yet: warn", SAFE, arena(node(), { state: "open" })),
    onTestnet("a safe whose race is being judged, bounty 1.234 NEAR: warn", SAFE, arena(node(), { state: "judging", claimant: MASKS[2] }, SAFE, 1_234_999_999_999_999_999_999_999n)),
    onTestnet("a safe that withstood its race: allow", SAFE, arena(node(), { state: "refunded" })),
    onTestnet("a safe whose race was paid by the judge of the sandbox: nothing about the arena", SAFE, arena(node(), { state: "paid", winner: MASKS[0] })),
    onTestnet("a safe with no get_owner: the open race still warns", SAFE, arena(node(), { state: "open" }, null)),
    onTestnet("a listed race that is not open on chain yet", SAFE, safeOn(node()).view(BOUNTY, "get", () => null)),
    onTestnet(
      "a race on chain that is on another safe",
      SAFE,
      safeOn(node())
        .view(BOUNTY, "get", () => bounty({ state: "open" }))
        .view(BOUNTY, "get_safe", () => ({ safe: "safe-0009.tinygif8324.testnet", masks: MASKS, min_loot: "1", opened_ns: "1" })),
    ),
    onTestnet("a bounty contract with no get_safe, as older nodes say it", SAFE, legacy),
    onTestnet("a bounty contract with no get_safe, as nodes say it now", SAFE, noGetSafe),
    onTestnet("a bounty contract whose answer is not JSON", SAFE, node(), { fetch: garbled(arena(node(), { state: "open" }).fetch) }),
    onTestnet("a named account that does not exist: block", "nobody-here.testnet", node()),
    onTestnet("an implicit account nobody used: warn", "a".repeat(64), node()),
    onTestnet("an Ethereum-style implicit account nobody used: warn", `0x${"b".repeat(40)}`, node(), { network: "mainnet", list: emptyMainnet }),
    onTestnet("an account younger than a day: warn", "fresh.testnet", node().setAccount("fresh.testnet", HEAD - 1000, { amount: "1", code_hash: NO_CODE, storage_usage: 100 })),
    onTestnet(
      "a contract whose code changed within a day: warn",
      "swap.testnet",
      node()
        .setAccount("swap.testnet", 1, { amount: "1", code_hash: CODE_A, storage_usage: 100 })
        .setAccount("swap.testnet", HEAD - 500, { amount: "1", code_hash: CODE_B, storage_usage: 100 }),
    ),
    onTestnet(
      "a contract that appeared on an old account within a day: warn",
      "was-plain.testnet",
      node()
        .setAccount("was-plain.testnet", 1, { amount: "1", code_hash: NO_CODE, storage_usage: 100 })
        .setAccount("was-plain.testnet", HEAD - 10, { amount: "1", code_hash: CODE_A, storage_usage: 100 }),
    ),
    onTestnet(
      "a contract whose code was removed within a day: warn",
      "was-contract.testnet",
      node()
        .setAccount("was-contract.testnet", 1, { amount: "1", code_hash: CODE_A, storage_usage: 100 })
        .setAccount("was-contract.testnet", HEAD - 10, { amount: "1", code_hash: NO_CODE, storage_usage: 100 }),
    ),
    onTestnet(
      "a window of one hour: the code changed before it",
      "swap.testnet",
      node()
        .setAccount("swap.testnet", 1, { amount: "1", code_hash: CODE_A, storage_usage: 100 })
        .setAccount("swap.testnet", HEAD - 7_000, { amount: "1", code_hash: CODE_B, storage_usage: 100 }),
      { windowHours: 1 },
    ),
    onTestnet("skipped heights: the nearest block below is read", "old-plain.testnet", skipped),
    onTestnet("no node keeps the block from a day ago", "old-plain.testnet", collected),
    onTestnet("the block from a day ago is there, its state is not", "old-plain.testnet", node(), { fetch: stateGone(node().fetch) }),
    onTestnet("no RPC answers: warn, nothing on chain read", "old-plain.testnet", down),
    onTestnet("the only RPC cannot be reached: warn", "old-plain.testnet", node(), { fetch: unreachable([A])(node().fetch) }),
    onTestnet("the only RPC answers null: an outage, not an answer", "old-plain.testnet", node(), { fetch: answersNull([A])(node().fetch) }),
    onTestnet("failover: the first node answers null, the second answers every read", "old-plain.testnet", node(), { reader: failover([B, A]), fetch: answersNull([B])(node().fetch) }),
    onTestnet("a report from the shared list, with its evidence, while the chain is down: block", "drainer.testnet", downToo, { list: reported("block") }),
    onTestnet("a report that warns, on an account that exists", "drainer.testnet", node().setAccount("drainer.testnet", 1, { amount: "1", code_hash: NO_CODE, storage_usage: 100 }), { list: reported("warn") }),
    onTestnet("failover: the first node cannot be reached, the second answers every read", "old-plain.testnet", node(), { reader: failover([B, A]), fetch: unreachable([B])(node().fetch) }),
    onTestnet("failover: the first node answers with its own error, the second answers every read", SAFE, arena(node(), { state: "open" }), {
      reader: failover([B, A]),
      fetch: at([B], async () => Response.json({ jsonrpc: "2.0", id: "1", error: { code: -429, message: "WARNING! THIS ENDPOINT IS DEPRECATED!" } }, { status: 429 }))(arena(node(), { state: "open" }).fetch),
    }),
    onTestnet("an id that cannot be an account", "Not An Account", node()),
    onTestnet("a mainnet name asked on testnet", "alice.near", node()),
    onTestnet("a testnet name asked on mainnet", "alice.testnet", node(), { network: "mainnet", list: emptyMainnet }),

    onPair("two nodes agree on a contract: allow", "pay.near", pair()),
    onPair("two nodes agree that an account does not exist: block", "nobody.near", pair()),
    onPair("the second node is a few blocks behind: both read at its head", "plain.near", pair(({ b }) => void (b.head = HEAD - 3))),
    onPair("the first node is a few blocks behind: both read at its head", "plain.near", pair(({ a }) => void (a.head = HEAD - 7))),
    onPair(`the second node is ${MAX_LAG_BLOCKS} blocks behind, the most that is one head: both read at its head`, "pay.near", pair(({ b }) => void (b.head = HEAD - MAX_LAG_BLOCKS))),
    onPair(`the second node is ${MAX_LAG_BLOCKS + 1} blocks behind: no common head, warn, the check stops`, "pay.near", pair(({ b }) => void (b.head = HEAD - MAX_LAG_BLOCKS - 1))),
    onPair("the second node is far behind: no common head, warn, the check stops", "pay.near", pair(({ b }) => void (b.head = HEAD - 500))),
    onPair("a node behind: the first one serves a chain hours old, the second does not take its word: warn", "pay.near", pair(({ a }) => void (a.head = HEAD - 100_000))),
    onPair("a node ahead: the first one names a final head the chain has not reached, alone: warn, never allow", "pay.near", pair(({ a }) => void (a.head = HEAD + 100_000))),
    onPair("a node ahead: the second one names a final head the chain has not reached, alone: warn, never allow", "plain.near", pair(({ b }) => void (b.head = HEAD + 100_000))),
    onPair(
      "a node ahead by less than the limit: both read at the honest head, where the liar must answer alike",
      "pay.near",
      pair(({ b }) => void (b.head = HEAD + MAX_LAG_BLOCKS)),
    ),
    onPair("the first node no longer keeps the day-old block: its archival node answers", "pay.near", pair(({ a }) => void (a.gcBelow = HEAD - 1_000))),
    onPair("the second node no longer keeps the day-old block and has no archival node: one source for the history, warn", "pay.near", pair(({ b }) => void (b.gcBelow = HEAD - 1_000))),
    onPair("no node keeps the block from a day ago, on a network read from two: warn", "pay.near", pair(({ a, b, archive }) => void (a.gcBelow = b.gcBelow = archive.gcBelow = HEAD - 50_000))),
    onPair("the block from a day ago is there on both nodes, its state on neither: warn", "plain.near", stateGone(pair())),
    onPair("the nodes disagree on the balance: warn, the check stops", "pay.near", pair(({ b }) => void b.setAccount("pay.near", HEAD - 5, { amount: (1000n * NEAR).toString(), code_hash: CODE_A, storage_usage: 300 }))),
    onPair("the nodes disagree on the code: warn, the check stops", "pay.near", pair(({ b }) => void b.setAccount("pay.near", HEAD - 5, { amount: NEAR.toString(), code_hash: CODE_B, storage_usage: 300 }))),
    onPair("one node says the account exists, the other that it does not: warn", "pay.near", pair(({ b }) => void b.setAccount("pay.near", HEAD - 5, null))),
    onPair("the second node is down: the first answers alone, and says so", "pay.near", pair(({ b }) => void (b.down = 503))),
    onPair("the first node cannot be reached: the second answers alone", "plain.near", unreachable([A, ARCHIVE])(pair())),
    onPair("both nodes are down: warn, nothing on chain read", "pay.near", pair(({ a, b }) => void ((a.down = 502), (b.down = 503)))),
    onPair("one provider only: nothing is cross-checked, and the answer says so", "pay.near", pair(), { reader: { endpoints: [A], crossCheck: true, archival: {} } }),
  ];
}

/** Every scenario run once against its world, with what the nodes answered written down. */
export async function buildVectors(): Promise<VectorFile> {
  const vectors: Vector[] = [];
  for (const s of scenarios()) {
    const { fetch: f, kept } = recording(s.fetch);
    const v = { name: s.name, network: s.network, account: s.account, list: s.list ?? "repo", now_ms: s.nowMs, window_hours: s.windowHours ?? 24, reader: s.reader };
    const expect = await answerOf(v, f);
    vectors.push({ ...v, exchanges: [...kept.values()], expect });
  }
  const names = new Set(vectors.map((v) => v.name));
  if (names.size !== vectors.length) throw new Error("two vectors share a name");
  return {
    about:
      "What MASK CHECK answers, with every RPC answer it read: the TypeScript check (packages/check) and the module that runs the same check inside a TEE (services/check) both replay this file and must give `expect`. Written by `pnpm --filter @maskwars/check vectors`; not edited by hand.",
    vectors,
  };
}

/** The file as it is written: one exchange a line, everything else indented. */
export function format(file: VectorFile): string {
  const lines: string[] = [];
  const body = JSON.stringify(
    file,
    (key, value: unknown) => {
      if (key !== "exchanges" || !Array.isArray(value)) return value;
      return value.map((e) => `@@${lines.push(JSON.stringify(e)) - 1}@@`);
    },
    1,
  );
  const text = body.replace(/"@@(\d+)@@"/g, (_, i: string) => lines[Number(i)]!);
  // A character nobody can see is written as its escape: the file says the same and shows everything it holds.
  return `${text.replace(UNSEEN, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}\n`;
}

/** White space past ASCII, zero-width and direction marks, and the byte-order mark. */
const UNSEEN = /[\u0080-\u00a0\u1680\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff]/g;

export const VECTORS_FILE = new URL("./vectors.json", import.meta.url);
