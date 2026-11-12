import { describe, expect, it } from "vitest";
import { type CheckResult, InvalidAccountError, maskCheck } from "../src/check.ts";
import { type SharedList, parseList } from "../src/list.ts";
import { ChainReader, NO_CODE } from "../src/rpc.ts";
import listJson from "../list.json" with { type: "json" };
import { CODE_A, CODE_B, FakeNode, HEAD, NEAR } from "./chain.ts";

const BOUNTY = "tinygif8324.testnet";
const SAFE = "safe-0001.tinygif8324.testnet";
const MASKS = ["nova.tinygif8324.testnet", "onyx.tinygif8324.testnet", "oracle.tinygif8324.testnet"];
const DRAIN_TX = "9fWpu8aYc4ZbbGAfRRaRjP8dsRj3wvJZXzW7dG8u4nyH";
/** 24 h back at 0.6 s a block. */
const DAY = 144_000;

const list: SharedList = parseList({
  network: "testnet",
  about: "test",
  arena: [{ contract: BOUNTY, race: "race-0003", safe: SAFE, owner_at_open: SAFE, note: "planted hole" }],
  reports: [],
});

function node(): FakeNode {
  return new FakeNode()
    .setAccount(BOUNTY, 1, { amount: (4n * NEAR).toString(), code_hash: CODE_A, storage_usage: 180_000 })
    .setAccount("old-plain.testnet", 1, { amount: NEAR.toString(), code_hash: NO_CODE, storage_usage: 182 });
}

function bounty(state: Record<string, unknown>) {
  return { owner: BOUNTY, amount: (NEAR / 10n).toString(), target: SAFE, deadline_ns: "1762707600000000000", status: state };
}

/** The safe and race-0003 as they stand on chain after `safe-deploy` and `open-safe`, `days` ago. */
function arena(n: FakeNode, status: Record<string, unknown>, owner = SAFE): FakeNode {
  return n
    .setAccount(SAFE, HEAD - 3 * DAY, { amount: (3n * NEAR).toString(), code_hash: CODE_B, storage_usage: 90_000 })
    .view(BOUNTY, "get", (a) => (a["id"] === "race-0003" ? bounty(status) : null))
    .view(BOUNTY, "get_safe", (a) => (a["id"] === "race-0003" ? { safe: SAFE, masks: MASKS, min_loot: NEAR.toString(), opened_ns: "1762448400000000000" } : null))
    .view(SAFE, "get_owner", () => owner);
}

async function check(n: FakeNode, account: string, l = list): Promise<CheckResult> {
  return maskCheck(account, { reader: new ChainReader({ fetch: n.fetch, endpoints: ["https://a.example"] }), list: l, now: () => new Date("2026-11-06T17:00:05Z") });
}

const codes = (r: CheckResult) => r.reasons.map((x) => x.code);

describe("maskCheck", () => {
  it("allows an old plain account and says only that nothing was found", async () => {
    const r = await check(node(), "old-plain.testnet");
    expect(r.verdict).toBe("allow");
    expect(r.summary).toBe("No signals against this account were found.");
    expect(codes(r)).toEqual(["account_age", "plain_account"]);
    expect(r.block).toEqual({ height: HEAD, hash: expect.any(String), time: "2026-11-06T17:00:00Z" });
    expect(JSON.stringify(r).toLowerCase()).not.toContain("safe to");
  });

  it("blocks a safe a mask drained on the arena, with the drain transaction", async () => {
    const r = await check(arena(node(), { state: "drained", winner: MASKS[0], tx_hash: DRAIN_TX }, MASKS[0]), SAFE);
    expect(r.verdict).toBe("block");
    expect(r.reasons[0]).toMatchObject({
      code: "arena_drained",
      level: "block",
      evidence: { contract: BOUNTY, race: "race-0003", winner: MASKS[0], tx_hash: DRAIN_TX, tx: `https://testnet.nearblocks.io/txns/${DRAIN_TX}` },
    });
    expect(r.summary).toMatch(/^BLOCK: Drained on the MASK WARS arena/);
    expect(r.reasons[0]?.text).toContain("planted hole");
  });

  it("blocks a safe taken over through the hole before the drain is judged", async () => {
    const r = await check(arena(node(), { state: "open" }, MASKS[1]), SAFE);
    expect(r.verdict).toBe("block");
    expect(codes(r).slice(0, 2)).toEqual(["arena_taken_over", "arena_target"]);
    expect(r.reasons[0]?.evidence).toMatchObject({ owner: MASKS[1], owner_at_open: SAFE });
  });

  it("warns about a safe in an open race that nobody has taken yet", async () => {
    const r = await check(arena(node(), { state: "open" }), SAFE);
    expect(r.verdict).toBe("warn");
    expect(codes(r)[0]).toBe("arena_target");
    expect(r.reasons[0]?.text).toContain("3 masks");
  });

  it("notes a safe that withstood its race, without warning", async () => {
    const r = await check(arena(node(), { state: "refunded" }), SAFE);
    expect(r.verdict).toBe("allow");
    expect(codes(r)).toContain("arena_withstood");
  });

  it("never claims a drain the chain does not show: the race is not open yet", async () => {
    const n = node().setAccount(SAFE, HEAD - 3 * DAY, { amount: (3n * NEAR).toString(), code_hash: CODE_B, storage_usage: 90_000 }).view(BOUNTY, "get", () => null);
    const r = await check(n, SAFE);
    expect(r.verdict).toBe("allow");
    expect(codes(r)).toContain("arena_pending");
    expect(codes(r)).not.toContain("arena_drained");
  });

  it("reads a bounty contract that has no get_safe yet as unreadable, not as a drain", async () => {
    const n = node()
      .setAccount(SAFE, HEAD - 3 * DAY, { amount: (3n * NEAR).toString(), code_hash: CODE_B, storage_usage: 90_000 })
      .view(BOUNTY, "get", () => bounty({ state: "open" }));
    n.legacyErrors = true;
    const r = await check(n, SAFE);
    expect(codes(r)).toContain("arena_unreadable");
    expect(r.reasons.find((x) => x.code === "arena_unreadable")?.text).toContain("MethodNotFound");
  });

  it("blocks a named account that does not exist", async () => {
    const r = await check(node(), "nobody-here.testnet");
    expect(r.verdict).toBe("block");
    expect(codes(r)).toEqual(["no_account"]);
  });

  it("warns on an implicit account nobody used yet", async () => {
    const r = await check(node(), "a".repeat(64));
    expect(r.verdict).toBe("warn");
    expect(codes(r)).toEqual(["unused_implicit"]);
  });

  it("warns on an account younger than the window, naming the block it was missing at", async () => {
    const r = await check(node().setAccount("fresh.testnet", HEAD - 1000, { amount: "1", code_hash: NO_CODE, storage_usage: 100 }), "fresh.testnet");
    expect(r.verdict).toBe("warn");
    expect(r.reasons[0]).toMatchObject({ code: "young_account", evidence: { block_height: HEAD - DAY, block_time: "2026-11-05T17:00:00Z" } });
  });

  it("warns when the contract's code changed inside the window", async () => {
    const n = node()
      .setAccount("swap.testnet", 1, { amount: "1", code_hash: CODE_A, storage_usage: 100 })
      .setAccount("swap.testnet", HEAD - 500, { amount: "1", code_hash: CODE_B, storage_usage: 100 });
    const r = await check(n, "swap.testnet");
    expect(r.verdict).toBe("warn");
    expect(r.reasons[0]).toMatchObject({ code: "code_changed", evidence: { code_hash_before: CODE_A, code_hash_now: CODE_B } });
  });

  it("warns when a contract appeared on an old account inside the window", async () => {
    const n = node()
      .setAccount("was-plain.testnet", 1, { amount: "1", code_hash: NO_CODE, storage_usage: 100 })
      .setAccount("was-plain.testnet", HEAD - 10, { amount: "1", code_hash: CODE_A, storage_usage: 100 });
    expect(codes(await check(n, "was-plain.testnet"))[0]).toBe("code_deployed");
  });

  it("walks past skipped heights to the nearest block", async () => {
    const n = node();
    n.skipped.add(HEAD - DAY);
    n.skipped.add(HEAD - 10_000);
    const r = await check(n, "old-plain.testnet");
    expect(r.reasons[0]).toMatchObject({ code: "account_age", evidence: { block_height: HEAD - DAY - 1 } });
  });

  it("says plainly when no node keeps the window's start", async () => {
    const n = node();
    n.gcBelow = HEAD - 50_000;
    const r = await check(n, "old-plain.testnet");
    // Testnet is read from one node at a time: there the missing window is said, and no more.
    expect(r.verdict).toBe("allow");
    expect(r.reasons.find((x) => x.code === "history_unavailable")).toMatchObject({ level: "info" });
  });

  it("warns and checks nothing on chain when no RPC answers", async () => {
    const n = node();
    n.down = 503;
    const r = await check(n, "old-plain.testnet");
    expect(r.verdict).toBe("warn");
    expect(codes(r)).toEqual(["chain_unreadable"]);
    expect(r.block).toBeNull();
  });

  it("returns a report from the shared list with its evidence, even when the chain is down", async () => {
    const l = parseList({
      ...list,
      reports: [{ account: "drainer.testnet", level: "block", reason: "Swept a faucet.", evidence: [{ kind: "tx", hash: DRAIN_TX }], reported_by: "maskwars", added: "2026-11-06" }],
    });
    const n = node();
    n.down = 502;
    const r = await check(n, "drainer.testnet", l);
    expect(r.verdict).toBe("block");
    expect(r.reasons[0]).toMatchObject({ code: "reported", evidence: { evidence: [{ kind: "tx", hash: DRAIN_TX }] } });
  });

  it("refuses ids that cannot be accounts, and mainnet names", async () => {
    await expect(check(node(), "Not An Account")).rejects.toBeInstanceOf(InvalidAccountError);
    await expect(check(node(), "alice.near")).rejects.toBeInstanceOf(InvalidAccountError);
  });

  it("reads every signal at the same final block", async () => {
    const n = arena(node(), { state: "open" });
    await check(n, SAFE);
    const viewHeights = n.calls.filter((c) => c.params["request_type"] === "call_function").map((c) => c.params["block_id"]);
    expect(new Set(viewHeights)).toEqual(new Set([HEAD]));
  });
});

describe("the house's vault: an arena target by design, told by the chain", () => {
  const HOUSE = "house.tinygif8324.testnet";
  const VAULT = "vault.house.tinygif8324.testnet";
  const HOUSE_BOUNTY = "bounty.tinygif8324.testnet";
  const RACE = "race-0009";
  /** The safe code the bounty contract lists, which the vault runs. */
  const SAFE_CODE = CODE_B;
  const vaultList = parseList({ network: "testnet", about: "test", vault: { contract: HOUSE_BOUNTY, safe: VAULT, house: HOUSE }, arena: [], reports: [] });
  const DESIGN = `Only the house funds it; only the masks of its round (${MASKS.join(", ")}) can open it; after the round, retire sends the rest home to ${HOUSE}.`;
  const EXPECTED = " Expected here: the house makes its vault again under the same name for every round.";
  const BASE = {
    contract: HOUSE_BOUNTY,
    race: RACE,
    state: "open",
    house: HOUSE,
    masks: MASKS.join(", "),
    code_hash: SAFE_CODE,
    code: "https://github.com/plavutskyi/mask-wars/blob/main/contracts/challenges/live-safe/src/lib.rs",
    explorer: `https://testnet.nearblocks.io/address/${VAULT}`,
  };

  /**
   * The house's day on chain: the house made `account` two hours ago, funded it and opened `RACE` on it, as the house's
   * steps do (packages/race/src/house.ts). `status` is the round's on the bounty contract; `null`: no round yet.
   */
  function house(status: Record<string, unknown> | null, o: { account?: string; team?: string; owner?: string; codes?: string[] } = {}): FakeNode {
    const at = o.account ?? VAULT;
    return node()
      .setAccount(HOUSE_BOUNTY, 1, { amount: (5n * NEAR).toString(), code_hash: CODE_A, storage_usage: 400_000 })
      .setAccount(at, HEAD - 12_000, { amount: ((193n * NEAR) / 100n).toString(), code_hash: SAFE_CODE, storage_usage: 160_000 })
      .view(HOUSE_BOUNTY, "governance", () => ({ admin: "tinygif8324.testnet", safe_codes: o.codes ?? [CODE_A, SAFE_CODE], live: 1 }))
      .view(at, "team", () => o.team ?? HOUSE)
      .view(at, "arbiter", () => HOUSE_BOUNTY)
      .view(at, "masks", () => MASKS)
      .view(at, "get_round", () => (status ? { arbiter: HOUSE_BOUNTY, bounty: RACE, opens_ns: "1793981700000000000", armed_ns: "1793977200000000000" } : null))
      .view(at, "get_owner", () => o.owner ?? at)
      .view(HOUSE_BOUNTY, "get", (a) =>
        a["id"] === RACE && status ? { owner: HOUSE, amount: ((2n * NEAR) / 10n).toString(), target: at, deadline_ns: "1793991600000000000", status } : null,
      )
      .view(HOUSE_BOUNTY, "get_safe", (a) =>
        a["id"] === RACE && status ? { safe: at, masks: MASKS, min_loot: (NEAR / 10n).toString(), opened_ns: "1793977200000000000" } : null,
      );
  }

  const ask = (n: FakeNode, account = VAULT) => check(n, account, vaultList);

  it("reads the vault in an open round as an arena target by design: warn, led by the design, never by a hole", async () => {
    const r = await ask(house({ state: "open" }));
    expect(r.verdict).toBe("warn");
    const text = `Arena target, by design: the MASK WARS house's vault, live in ${RACE} right now. ${DESIGN} Bounty 0.2 NEAR. Do not send NEAR here.`;
    expect(r.summary).toBe(`WARN: ${text}`);
    expect(r.reasons).toEqual([
      { code: "arena_target", level: "warn", text, evidence: { ...BASE, deadline: "2026-11-06T19:00:00Z" } },
      {
        code: "young_account",
        level: "info",
        text: `New account: it did not exist 24 h ago (block ${HEAD - DAY}, 2026-11-05T17:00:00Z).${EXPECTED}`,
        evidence: { block_height: HEAD - DAY, block_time: "2026-11-05T17:00:00Z" },
      },
      { code: "contract", level: "info", text: `A contract, code hash ${SAFE_CODE}.`, evidence: { code_hash: SAFE_CODE } },
    ]);
    expect(r.summary.toLowerCase()).not.toMatch(/hole|critical|vulnerab|exploit/);
  });

  it("says a new code on the vault made again over yesterday's, without warning", async () => {
    const n = house({ state: "open" })
      .setAccount(VAULT, HEAD - 3 * DAY, { amount: NEAR.toString(), code_hash: CODE_A, storage_usage: 150_000 })
      .setAccount(VAULT, HEAD - 12_010, null);
    const r = await ask(n);
    expect(r.verdict).toBe("warn");
    expect(r.reasons.map((x) => [x.code, x.level])).toEqual([
      ["arena_target", "warn"],
      ["code_changed", "info"],
      ["account_age", "info"],
      ["contract", "info"],
    ]);
    expect(r.reasons[1]?.text).toBe(`The contract's code changed within the last 24 h.${EXPECTED}`);
  });

  it("blocks the vault a mask drained, framed as the arena, with the drain transaction", async () => {
    const r = await ask(house({ state: "drained", winner: MASKS[0], tx_hash: DRAIN_TX }, { owner: MASKS[0]! }));
    expect(r.verdict).toBe("block");
    const text = `Drained on the MASK WARS arena, by design: mask ${MASKS[0]} won ${RACE} on the house's vault, and the judge confirmed the drain on chain. ${DESIGN} Do not send NEAR here.`;
    expect(r.summary).toBe(`BLOCK: ${text}`);
    expect(r.reasons[0]).toEqual({
      code: "arena_drained",
      level: "block",
      text,
      evidence: { ...BASE, state: "drained", winner: MASKS[0], tx_hash: DRAIN_TX, tx: `https://testnet.nearblocks.io/txns/${DRAIN_TX}` },
    });
    expect(codes(r)).not.toContain("arena_target");
  });

  it("blocks the vault a mask took over in its open round, and still says it is the arena's target", async () => {
    const r = await ask(house({ state: "open" }, { owner: MASKS[1]! }));
    expect(r.verdict).toBe("block");
    expect(codes(r).slice(0, 2)).toEqual(["arena_taken_over", "arena_target"]);
    expect(r.reasons[0]?.evidence).toMatchObject({ owner: MASKS[1], owner_at_open: VAULT, race: RACE });
  });

  it("never allows the vault: after a round nobody broke it is still the arena's target, and says it withstood", async () => {
    const r = await ask(house({ state: "refunded" }));
    expect(r.verdict).toBe("warn");
    const text = `Arena target, by design: the MASK WARS house's vault; ${RACE} ended with no break, and retire sends everything it holds home to ${HOUSE}. Do not send NEAR here.`;
    expect(r.summary).toBe(`WARN: ${text}`);
    expect(r.reasons.slice(0, 2)).toEqual([
      { code: "arena_target", level: "warn", text, evidence: { ...BASE, state: "refunded" } },
      {
        code: "arena_withstood",
        level: "info",
        text: `Withstood ${RACE} on the MASK WARS arena: no mask drained the house's vault before the deadline. ${DESIGN} Do not send NEAR here.`,
        evidence: { ...BASE, state: "refunded" },
      },
    ]);
  });

  it("never allows the vault, whatever its round", async () => {
    const rounds = [{ state: "open" }, { state: "judging", claimant: MASKS[2] }, { state: "drained", winner: MASKS[0], tx_hash: DRAIN_TX }, { state: "refunded" }, { state: "paid", winner: MASKS[0] }, null];
    for (const status of rounds) expect((await ask(house(status))).verdict, JSON.stringify(status)).not.toBe("allow");
  });

  it("reads the vault before its round opens as waiting for today's round: warn", async () => {
    const r = await ask(house(null));
    expect(r.verdict).toBe("warn");
    const text = `Arena target, by design: the MASK WARS house's vault, waiting for today's round to open. ${DESIGN} Do not send NEAR here.`;
    expect(r.summary).toBe(`WARN: ${text}`);
    expect(r.reasons[0]).toEqual({ code: "arena_target", level: "warn", text, evidence: { ...BASE, race: null, state: null } });
  });

  it("never gives the label to a look-alike that says all the same on chain", async () => {
    const lookalike = "vault-house.tinygif8324.testnet";
    const n = house({ state: "open" }, { account: lookalike });
    const r = await ask(n, lookalike);
    expect(r.verdict).toBe("warn");
    expect(codes(r)).toEqual(["young_account", "contract"]);
    expect(r.reasons[0]).toMatchObject({ level: "warn", text: `New account: it did not exist 24 h ago (block ${HEAD - DAY}, 2026-11-05T17:00:00Z).` });
    expect(JSON.stringify(r)).not.toMatch(/by design|house's vault|Expected here/);
    // The name is not the vault's, so nothing of the vault is even asked.
    expect(n.calls.filter((c) => c.params["request_type"] === "call_function")).toEqual([]);
  });

  it("never gives the label to the vault's name when the chain does not confirm it is the house's", async () => {
    for (const not of [{ team: "eve.testnet" }, { codes: [CODE_A] }]) {
      const r = await ask(house({ state: "open" }, not));
      expect(r.verdict).toBe("warn");
      expect(codes(r)).toEqual(["young_account", "contract"]);
      expect(r.reasons[0]?.level).toBe("warn");
      expect(JSON.stringify(r)).not.toContain("by design");
    }
  });
});

describe("the shared list in the repo", () => {
  it("parses and lists the race-0003 safe", () => {
    const l = parseList(listJson);
    expect(l.arena.map((a) => a.safe)).toContain(SAFE);
  });

  it("rejects a report without evidence", () => {
    expect(() => parseList({ ...list, reports: [{ account: "x.testnet", level: "block", reason: "trust me", evidence: [], reported_by: "anon", added: "2026-11-06" }] })).toThrow();
  });
});
