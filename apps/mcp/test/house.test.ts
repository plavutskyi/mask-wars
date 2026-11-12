// The house's daily round over MCP, on a chain of fakes: the round on the vault as the bounty contract holds it, the
// sign-ups the site keeps, the message an agent signs, and every call of a round in order, the seal's hash computed as
// the contract computes it.
import { createHash } from "node:crypto";
import { JOIN_SCRIPT, JOIN_SCRIPT_SHA256, agentsClosed, fillingSlot, signupMessage, signupNonce } from "@maskwars/arena/guests";
import { ChainReader, mainnetList, sharedList } from "@maskwars/check";
import { NETWORKS } from "@maskwars/network";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { ArenaFeed, BUDGETS, HOUSE_TOOL_NAMES, type HouseTools, TESTNET, TOOL_NAMES, createBudget, createServer, houseInstructionsFor, houseRoundOf, instructionsFor, joinOf, planProblems, playOf, sealHash } from "../src/index.ts";
import { ENDPOINT, data, recordedArena, text } from "./helpers.ts";

const NET = NETWORKS.testnet;
const MS = 1_000_000n;
const OPENED = Date.UTC(2026, 10, 12, 18, 4);
const NOW = OPENED + 10 * 60_000;
const COMMIT_UNTIL = BigInt(OPENED + 45 * 60_000) * MS;
const REVEAL_UNTIL = COMMIT_UNTIL + 60n * 60_000n * MS;
const DEADLINE = BigInt(OPENED + 4 * 3_600_000) * MS;
const AGENT = "agent.testnet";
const PERSON = `kira.${NET.factory}`;
const NOVA = NET.masks.NOVA!;
const SITE = "https://maskwars.example";

interface World {
  nowMs: number;
  vault: boolean;
  round: boolean;
  accounts: Record<string, string>;
  signups: { account: string; at: number }[] | null;
  seals: { mask: string; seq: number; state: string; txs: string[] }[];
  status: { state: string; winner?: string };
}

function world(o: Partial<World> = {}): World {
  return { nowMs: NOW, vault: true, round: true, accounts: { [AGENT]: String(10n ** 24n) }, signups: [{ account: AGENT, at: NOW - 60_000 }], seals: [], status: { state: "open" }, ...o };
}

/** One fetch for the RPC and the site. */
function fetchOf(w: World): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(SITE)) {
      if (w.signups === null) return new Response("down", { status: 503 });
      return Response.json({ network: "testnet", slot: 0, signups: w.signups });
    }
    const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: Record<string, string> };
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id: 1, result });
    const unknown = () => Response.json({ jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } });
    if (method === "block") return ok({ header: { height: 100, hash: "Hblock", timestamp_nanosec: String(BigInt(w.nowMs) * MS) } });
    if (params.request_type === "view_account") {
      const id = params.account_id!;
      const amount = id === NET.vault ? (w.vault ? String(19n * 10n ** 23n) : null) : (w.accounts[id] ?? null);
      return amount === null ? unknown() : ok({ amount, locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 182, block_height: 100, block_hash: "Hblock" });
    }
    const args = JSON.parse(Buffer.from(params.args_base64!, "base64").toString("utf8")) as Record<string, string>;
    const view = (v: unknown) => ok({ result: [...Buffer.from(JSON.stringify(v))], logs: [], block_height: 100, block_hash: "Hblock" });
    const at = `${params.account_id} ${params.method_name}`;
    if (at === `${NET.vault} get_round`) return view(w.round ? { arbiter: NET.bounty, bounty: "race-0007", opens_ns: String(COMMIT_UNTIL), armed_ns: String(BigInt(OPENED) * MS) } : null);
    if (at === `${NET.vault} available`) return view(String(28n * 10n ** 22n));
    if (at === `${NET.bounty} get` && args.id === "race-0007") return view({ owner: NET.house, amount: String(11n * 10n ** 22n), target: NET.vault, deadline_ns: String(DEADLINE), status: w.status });
    if (at === `${NET.bounty} get_safe`) return view({ safe: NET.vault, masks: [NOVA, PERSON, AGENT], min_loot: String(10n ** 23n), opened_ns: String(BigInt(OPENED) * MS) });
    if (at === `${NET.bounty} get_round`) return view({ commit_until: String(COMMIT_UNTIL), reveal_until: String(REVEAL_UNTIL), deadline_ns: String(DEADLINE), seals: w.seals });
    throw new Error(`not in the fake chain: ${at}`);
  }) as typeof fetch;
}

const toolsOf = (w: World): HouseTools => ({
  reader: new ChainReader({ endpoints: ["https://rpc.testnet.example"], fetch: fetchOf(w) }),
  net: NET,
  site: SITE,
  fetch: fetchOf(w),
  limit: createBudget({ perCaller: 100, perInstance: 1000, windowMs: 60_000 }),
  now: () => w.nowMs,
});

describe("get_house_round", () => {
  it("reads the round on the vault: its phase, windows, bounty, masks by kind, and who signed up for the next slot", async () => {
    const v = await houseRoundOf(toolsOf(world()));
    expect(v.round).toMatchObject({
      id: "race-0007",
      phase: "sealing",
      bounty_near: "0.11",
      vault_pays_out_near: "0.28",
      min_loot_near: "0.1",
      masks: [
        { account: NOVA, kind: "ours" },
        { account: PERSON, kind: "person" },
        { account: AGENT, kind: "agent" },
      ],
    });
    expect(v.round!.commit_until).toBe(new Date(OPENED + 45 * 60_000).toISOString());
    expect(v.next_slot.ms).toBe(fillingSlot(NET, NOW));
    expect(v.guests).toEqual({ people_masks: NET.guests.masks, agents: NET.guests.agents });
    expect(v.signups).toEqual([{ account: AGENT, place: 1, at: new Date(NOW - 60_000).toISOString() }]);
    expect(v.headline).toBe("House round race-0007 is sealing until 18:49 UTC: 3 masks (1 outside agent), 0.11 NEAR bounty.");
  });

  it("with no round on the vault names the next slot; with the site down, sign-ups are unknown, never empty", async () => {
    const v = await houseRoundOf(toolsOf(world({ round: false, signups: null })));
    expect(v.round).toBeNull();
    expect(v.signups).toBeNull();
    expect(v.headline).toMatch(/^No house round on the vault right now\. The next one opens at 2026-11-13 18:00 UTC/);
    expect((await houseRoundOf(toolsOf(world({ vault: false })))).round).toBeNull();
  });

  it("follows the round by chain time: playing after the commit window, claims after the reveal window", async () => {
    const playing = await houseRoundOf(toolsOf(world({ nowMs: OPENED + 50 * 60_000 })));
    expect(playing.round!.phase).toBe("playing");
    const claims = await houseRoundOf(toolsOf(world({ nowMs: OPENED + 120 * 60_000 })));
    expect(claims.round!.phase).toBe("claims");
  });
});

describe("how_to_join_round", () => {
  it("gives the exact message for the next slot, its nonce, join.mjs and the one command", async () => {
    const j = await joinOf(toolsOf(world()), AGENT);
    const slot = fillingSlot(NET, NOW);
    expect(j.message).toBe(signupMessage("testnet", slot, AGENT));
    expect(j.nonce_hex).toBe(signupNonce(j.message).toString("hex"));
    expect(j.recipient).toBe("maskwars.xyz");
    expect(j.ready).toBe(true);
    expect(j.signed_up).toBe(true);
    expect(j.script).toEqual({ file: "join.mjs", sha256: JOIN_SCRIPT_SHA256, url: `${SITE}/api/round/join.mjs`, text: JOIN_SCRIPT });
    expect(j.run).toBe(`NEAR_ACCOUNT_ID=${AGENT} NEAR_PRIVATE_KEY=ed25519:<a full-access key of ${AGENT}> node join.mjs ${SITE} testnet ${slot}`);
    expect(j.endpoint.url).toBe(`${SITE}/api/round/join`);
  });

  it("says plainly what keeps an account out: not on chain, too poor for gas, one of the arena's own", async () => {
    expect((await joinOf(toolsOf(world()), "ghost.testnet")).problems).toEqual(["ghost.testnet is not on NEAR testnet: create it first"]);
    const poor = await joinOf(toolsOf(world({ accounts: { [AGENT]: String(10n ** 21n) } })), AGENT);
    expect(poor.ready).toBe(false);
    expect(poor.problems[0]).toMatch(/holds 0.001 NEAR: keep at least 0.05 NEAR/);
    const ours = await joinOf(toolsOf(world({ accounts: { [NOVA]: String(10n ** 24n) } })), NOVA);
    expect(ours.problems).toEqual([`${NOVA} is one of the arena's own accounts: it is never a guest`]);
  });
});

describe("how_to_play_round", () => {
  const plan = JSON.stringify([
    { method: "set_owner", args: { new_owner: AGENT } },
    { method: "sweep", args: { to: AGENT, amount: String(15n * 10n ** 22n) } },
  ]);
  const salt = "0123456789abcdef0123";

  it("computes the seal as the contract does and gives every call in order, for the agent's own wallet", async () => {
    const p = await playOf(toolsOf(world()), AGENT, plan, salt);
    if ("none" in p) throw new Error(p.none);
    const want = createHash("sha256").update(`maskwars-commit:race-0007:${AGENT}:${salt}:${plan}`).digest("hex");
    expect(p.seal.hash).toBe(want);
    expect(sealHash("race-0007", AGENT, salt, plan)).toBe(want);
    expect(p.on_list).toBe(true);
    expect(p.steps.map((s) => [s.step, s.action.receiver_id, s.action.method_name])).toEqual([
      ["commit", NET.bounty, "commit"],
      ["move", NET.vault, "set_owner"],
      ["move", NET.vault, "sweep"],
      ["reveal", NET.bounty, "reveal"],
      ["claim_drain", NET.bounty, "claim_drain"],
    ]);
    expect(p.steps[0]!.action.args).toEqual({ id: "race-0007", hash: want });
    expect(p.steps[2]!.action.args).toEqual({ to: AGENT, amount: String(15n * 10n ** 22n) });
    expect(p.steps[3]!.action.args).toEqual({ id: "race-0007", plan, salt, txs: ["<tx hash of call 1>", "<tx hash of call 2>"] });
    expect(p.steps.map((s) => BigInt(s.action.gas) / 10n ** 12n)).toEqual([30n, 15n, 15n, 30n, 200n]);
    for (const s of p.steps) {
      expect(s.action.signer_id).toBe(AGENT);
      expect(s.action.deposit).toBe("0");
      expect(s.near_cli).toMatch(new RegExp(`^near contract call-function as-transaction ${s.action.receiver_id.replace(/\./g, "\\.")} ${s.action.method_name} json-args '`));
      expect(s.near_cli).toContain(`sign-as ${AGENT} network-config testnet`);
    }
    expect(p.vault.your_turn_view).toBe(`near contract call-function as-read-only ${NET.vault} waits_for json-args '{"account_id":"${AGENT}"}' network-config testnet now`);
  });

  it("without a plan gives the formula and the calls with blanks; an account off the list is told so", async () => {
    const p = await playOf(toolsOf(world()), "other.testnet");
    if ("none" in p) throw new Error(p.none);
    expect(p.on_list).toBe(false);
    expect(p.seal.hash).toBeNull();
    expect(p.seal.formula).toBe('sha256("maskwars-commit:race-0007:other.testnet:" + salt + ":" + plan), lowercase hex; plan is the JSON text of your calls exactly as you will reveal it');
    expect(p.headline).toMatch(/is not a mask of house round race-0007/);
  });

  it("shows a seal the agent already made, and refuses a plan or salt the contract would refuse", async () => {
    const p = await playOf(toolsOf(world({ seals: [{ mask: AGENT, seq: 0, state: "sealed", txs: [] }] })), AGENT, "[]", "short");
    if ("none" in p) throw new Error(p.none);
    expect(p.sealed).toEqual({ seq: 0, state: "sealed" });
    expect(p.seal.hash).toBeNull();
    expect(p.seal.problems).toEqual(["plan: 1 to 12 calls", "salt: 16 to 128 letters, digits, - or _"]);
    expect(planProblems("not json").problems[0]).toMatch(/a JSON array/);
    expect(planProblems(JSON.stringify(Array.from({ length: 13 }, () => ({ method: "sweep", args: {} })))).problems).toEqual(["plan: 1 to 12 calls"]);
    expect(planProblems(JSON.stringify([{ method: "sweep", args: { x: "y".repeat(2100) } }])).problems[0]).toBe("plan: at most 2048 bytes");
  });

  it("once the contract paid another seal, offers nothing to send: no reveal or claim it would refuse", async () => {
    // As in the testnet rehearsal: the earliest seal was confirmed and paid while this agent still had its turn.
    const p = await playOf(toolsOf(world({ status: { state: "drained", winner: PERSON }, seals: [{ mask: PERSON, seq: 0, state: "confirmed", txs: [] }, { mask: AGENT, seq: 1, state: "sealed", txs: [] }] })), AGENT, plan, salt);
    if ("none" in p) throw new Error(p.none);
    expect(p.round.phase).toBe("over");
    expect(p.steps).toEqual([]);
    expect(p.headline).toBe(`House round race-0007 is over: the bounty went to ${PERSON}. Nothing is left to send; whatever your own moves took from the vault is yours. Sign up for the next one with how_to_join_round.`);
  });

  it("with no round on the vault says when the next one opens", async () => {
    const p = await playOf(toolsOf(world({ round: false })), AGENT);
    expect(p).toEqual({ none: "No round on the vault right now. The next one opens at 2026-11-13 18:00 UTC: sign up with how_to_join_round." });
  });
});

describe("on mainnet, whose round seats no outside agent yet", () => {
  const MAIN = NETWORKS.mainnet;
  const onMainnet = (w: World): HouseTools => ({ ...toolsOf(w), net: MAIN });

  it("offers no joining: the instructions watch the round, and an empty round says to watch the next", async () => {
    expect(MAIN.guests.agents).toBe(0);
    const line = houseInstructionsFor(MAIN);
    expect(line).toContain("get_house_round");
    expect(line).not.toContain("how_to_join_round");
    expect(line).toContain("come back with an entry stake");
    expect(instructionsFor("mainnet")).toContain(line);
    expect(instructionsFor("testnet")).toContain("how_to_join_round gives the one message to sign");
    const asked: string[] = [];
    const t = onMainnet(world({ round: false }));
    const f = t.fetch;
    const v = await houseRoundOf({ ...t, fetch: (async (u: string | URL | Request, i?: RequestInit) => (asked.push(String(u)), f(u, i))) as typeof fetch });
    expect(v.guests).toEqual({ people_masks: 3, agents: 0 });
    expect(v.signups).toEqual([]);
    expect(asked.filter((u) => u.startsWith(SITE))).toEqual([]);
    expect(v.headline).toMatch(/: watch it with get_house_round\.$/);
    expect(await playOf(t, "agent.near")).toEqual({ none: expect.stringMatching(/: watch it with get_house_round\.$/) });
  });

  it("how_to_join_round answers why, as an error, and gives nothing to sign", async () => {
    const feed = new ArenaFeed(recordedArena().arena);
    const limits = { check: createBudget(BUDGETS.check), race: createBudget(BUDGETS.race), arena: createBudget(BUDGETS.arena) };
    const reader = new ChainReader();
    const house = onMainnet(world());
    const handler = createMcpHandler(() => createServer({ config: TESTNET, reader, feed, list: sharedList, mainnet: { reader, list: mainnetList }, limits, caller: "203.0.113.10", house }), { maxSubscriptions: 0 });
    const client = new Client({ name: "outside-agent", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(ENDPOINT), { fetch: (url, init) => handler.fetch(new Request(url, init)) }));
    try {
      const { tools } = await client.listTools();
      expect(tools.find((x) => x.name === "how_to_join_round")!.description).toMatch(/^The house's daily round on NEAR mainnet seats no outside agents yet/);
      const join = await client.callTool({ name: "how_to_join_round", arguments: { account: "agent.near" } });
      expect(join.isError).toBe(true);
      expect(text(join)).toBe(agentsClosed(MAIN));
      expect(text(join)).not.toContain("join.mjs");
    } finally {
      await client.close();
    }
  });
});

describe("the three tools on the server", () => {
  const clients: Client[] = [];
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
  });

  async function connect(house: HouseTools) {
    const feed = new ArenaFeed(recordedArena().arena);
    const limits = { check: createBudget(BUDGETS.check), race: createBudget(BUDGETS.race), arena: createBudget(BUDGETS.arena) };
    const reader = new ChainReader();
    const handler = createMcpHandler(() => createServer({ config: TESTNET, reader, feed, list: sharedList, mainnet: { reader, list: mainnetList }, limits, caller: "203.0.113.9", house }), { maxSubscriptions: 0 });
    const client = new Client({ name: "outside-agent", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(ENDPOINT), { fetch: (url, init) => handler.fetch(new Request(url, init)) }));
    clients.push(client);
    return client;
  }

  it("are listed after check_account, read only, and answer with structured content", async () => {
    const client = await connect(toolsOf(world()));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual([...TOOL_NAMES]);
    for (const n of HOUSE_TOOL_NAMES) expect(tools.find((t) => t.name === n)!.annotations?.readOnlyHint).toBe(true);
    const round = data<{ round: { id: string } }>(await client.callTool({ name: "get_house_round", arguments: {} }));
    expect(round.round.id).toBe("race-0007");
    const join = data<{ message: string }>(await client.callTool({ name: "how_to_join_round", arguments: { account: AGENT } }));
    expect(join.message).toMatch(/^MASK WARS: agent\.testnet enters the house round of/);
    const bad = await client.callTool({ name: "how_to_join_round", arguments: { account: "Not An Account" } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/is not a NEAR account id/);
  });

  it("say a round is not there as an error the agent reads, and keep each caller within its budget", async () => {
    const t = { ...toolsOf(world({ round: false })), limit: createBudget({ perCaller: 1, perInstance: 10, windowMs: 60_000 }) };
    const client = await connect(t);
    const none = await client.callTool({ name: "how_to_play_round", arguments: { account: AGENT } });
    expect(none.isError).toBe(true);
    expect(text(none)).toMatch(/^No round on the vault right now/);
    const again = await client.callTool({ name: "get_house_round", arguments: {} });
    expect(text(again)).toMatch(/^Too many house round calls/);
  });
});
