// The reader in cross-check mode, as mainnet uses it: every read goes to two independent nodes at one block and counts
// only when both answer alike.
import { describe, expect, it } from "vitest";
import { ChainError, ChainReader, MAX_LAG_BLOCKS } from "../src/rpc.ts";
import { CODE_A, CODE_B, FakeNode, HEAD, NEAR } from "./chain.ts";

const A = "https://a.example";
const B = "https://b.example";
const ARCHIVE = "https://archive-a.example";

function nodes() {
  const make = () =>
    new FakeNode()
      .setAccount("pay.near", 1, { amount: NEAR.toString(), code_hash: CODE_A, storage_usage: 300 })
      .setAccount("plain.near", 1, { amount: "7", code_hash: "11111111111111111111111111111111", storage_usage: 182 });
  const a = make();
  const b = make();
  const archive = make();
  archive.gcBelow = 0;
  const seen: string[] = [];
  const route = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    const node = url === A ? a : url === B ? b : url === ARCHIVE ? archive : null;
    if (!node) throw new TypeError("fetch failed");
    return node.fetch(input, init);
  }) as typeof fetch;
  const reader = new ChainReader({ endpoints: [A, B], crossCheck: true, archival: { [A]: ARCHIVE }, fetch: route }).tracked();
  return { a, b, archive, seen, reader };
}

const heights = (n: FakeNode) => n.calls.map((c) => c.params["block_id"] ?? c.params["finality"]);

describe("cross-check", () => {
  it("asks both nodes every read, at one block, and counts the read when they agree", async () => {
    const { a, b, reader } = nodes();
    expect(await reader.account("pay.near")).toMatchObject({ amount: NEAR.toString(), codeHash: CODE_A, blockHeight: HEAD });
    expect(heights(a)).toEqual(["final", HEAD]);
    expect(heights(b)).toEqual(["final", HEAD]);
    expect(reader.tally).toMatchObject({ reads: 1, agreed: 1 });
  });

  it("reads at the lower of two final heads, which both nodes have", async () => {
    const { a, b, reader } = nodes();
    b.head = HEAD - 3;
    const head = await reader.head();
    expect(head.height).toBe(HEAD - 3);
    expect(a.calls.at(-1)?.params).toEqual({ block_id: HEAD - 3 });
    expect(reader.tally).toMatchObject({ reads: 1, agreed: 1 });
  });

  it("does not wait for a node far behind: it sits the read out and the tally says so", async () => {
    const { b, reader } = nodes();
    b.head = HEAD - MAX_LAG_BLOCKS - 400;
    expect((await reader.head()).height).toBe(HEAD);
    expect(reader.tally?.agreed).toBe(0);
    expect(reader.tally?.reads).toBe(1);
    expect(reader.tally?.missing.get(B)).toContain("UNKNOWN_BLOCK");
  });

  it("refuses the answer when the nodes disagree, naming both", async () => {
    const { b, reader } = nodes();
    b.setAccount("pay.near", HEAD - 5, { amount: (1000n * NEAR).toString(), code_hash: CODE_A, storage_usage: 300 });
    const e = await reader.account("pay.near").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ChainError);
    expect((e as ChainError).kind).toBe("disagree");
    expect((e as ChainError).message).toMatch(/view_account pay\.near at block 230000000: a\.example .* vs b\.example /);
  });

  it("refuses a different code hash just the same", async () => {
    const { b, reader } = nodes();
    b.setAccount("pay.near", HEAD - 5, { amount: NEAR.toString(), code_hash: CODE_B, storage_usage: 300 });
    await expect(reader.account("pay.near")).rejects.toMatchObject({ kind: "disagree" });
  });

  it("refuses when one node says the account exists and the other says it does not", async () => {
    const { b, reader } = nodes();
    b.setAccount("pay.near", HEAD - 5, null);
    await expect(reader.account("pay.near")).rejects.toMatchObject({ kind: "disagree" });
  });

  it("takes an answer both nodes give alike: no such account", async () => {
    const { reader } = nodes();
    expect(await reader.account("nobody.near")).toBeNull();
    expect(reader.tally).toMatchObject({ reads: 1, agreed: 1 });
  });

  it("goes on with one node when the other is down, and stops asking the down one", async () => {
    const { a, b, reader } = nodes();
    b.down = 503;
    expect((await reader.account("pay.near"))?.amount).toBe(NEAR.toString());
    expect((await reader.account("plain.near"))?.amount).toBe("7");
    expect(b.calls).toHaveLength(1);
    expect(a.calls.length).toBeGreaterThan(2);
    expect(reader.tally).toMatchObject({ reads: 2, agreed: 0 });
    expect(reader.tally?.missing.get(B)).toContain("HTTP 503");
  });

  it("asks the same provider's archival node for a block its regular node no longer keeps", async () => {
    const { a, archive, reader } = nodes();
    a.gcBelow = HEAD - 1_000;
    expect(await reader.account("pay.near", { block_id: HEAD - 5_000 })).toMatchObject({ amount: NEAR.toString(), blockHeight: HEAD - 5_000 });
    expect(archive.calls).toHaveLength(1);
    expect(reader.tally).toMatchObject({ reads: 1, agreed: 1 });
  });

  it("reads a provider's rate limit as an outage, not as an answer that disagrees", async () => {
    const { reader, b } = nodes();
    const limited = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === B) {
        return Response.json({ jsonrpc: "2.0", id: "1", error: { code: -429, message: "Rate limits exceeded. For higher rate limits get a subscription" } }, { status: 429 });
      }
      return nodes().a.fetch(input, init);
    }) as typeof fetch;
    const r = new ChainReader({ endpoints: [A, B], crossCheck: true, fetch: limited }).tracked();
    expect((await r.account("pay.near"))?.amount).toBe(NEAR.toString());
    expect(r.tally?.missing.get(B)).toContain("Rate limits exceeded");
    expect(b.calls).toHaveLength(0);
  });

  it("fails as an outage when neither node answers", async () => {
    const { a, b, reader } = nodes();
    a.down = 502;
    b.down = 503;
    await expect(reader.head()).rejects.toMatchObject({ kind: "server" });
  });

  it("reads the agent's key the same way, and refuses a key the nodes disagree on", async () => {
    const { a, b, reader } = nodes();
    const fc = { FunctionCall: { allowance: "250000000000000000000000", receiver_id: "pay.near", method_names: ["pay"] } };
    a.keys.set("pay.near/ed25519:k", fc);
    b.keys.set("pay.near/ed25519:k", fc);
    expect(await reader.accessKey("pay.near", "ed25519:k")).toEqual({ kind: "function_call", receiver: "pay.near", methods: ["pay"], allowance: "250000000000000000000000" });
    b.keys.set("pay.near/ed25519:k", "FullAccess");
    await expect(reader.accessKey("pay.near", "ed25519:k")).rejects.toMatchObject({ kind: "disagree" });
  });

  it("keeps a tally per check: a tracked reader starts from zero", async () => {
    const { reader } = nodes();
    await reader.head();
    expect(reader.tally?.reads).toBe(1);
    expect(reader.tracked().tally).toMatchObject({ reads: 0, agreed: 0 });
    expect(new ChainReader().tally).toBeNull();
  });
});

describe("failover, as testnet reads", () => {
  it("moves past a provider's own error without a name, as it does past a 5xx", async () => {
    const good = new FakeNode().setAccount("c.testnet", 1, { amount: "1", code_hash: CODE_A, storage_usage: 1 });
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === A) return Response.json({ jsonrpc: "2.0", id: "1", error: { code: -429, message: "WARNING! THIS ENDPOINT IS DEPRECATED!" } }, { status: 429 });
      return good.fetch(input, init);
    }) as typeof fetch;
    const r = new ChainReader({ endpoints: [A, B], fetch: f });
    expect((await r.account("c.testnet"))?.amount).toBe("1");
  });
});
