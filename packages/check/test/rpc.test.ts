import { describe, expect, it } from "vitest";
import { ChainError, ChainReader, blockTime } from "../src/rpc.ts";
import { CODE_A, FakeNode, HEAD } from "./chain.ts";

describe("ChainReader", () => {
  it("reads a block header with its exact nanosecond time", async () => {
    const n = new FakeNode();
    const head = await new ChainReader({ fetch: n.fetch, endpoints: ["https://a.example"] }).head();
    expect(head.height).toBe(HEAD);
    expect(blockTime(head).toISOString()).toBe("2026-11-06T17:00:00.000Z");
    expect(n.calls[0]).toEqual({ jsonrpc: "2.0", id: "maskwars-check", method: "block", params: { finality: "final" } });
  });

  it("returns null for an unknown account and for a garbage-collected block", async () => {
    const n = new FakeNode();
    const r = new ChainReader({ fetch: n.fetch, endpoints: ["https://a.example"] });
    expect(await r.account("nobody.testnet")).toBeNull();
    expect(await r.block(1)).toBeNull();
  });

  it("decodes view_account, and a global contract's hash wins over the zero code hash", async () => {
    const n = new FakeNode().setAccount("c.testnet", 1, { amount: "5", code_hash: CODE_A, storage_usage: 9 });
    const r = new ChainReader({ fetch: n.fetch, endpoints: ["https://a.example"] });
    expect(await r.account("c.testnet")).toMatchObject({ amount: "5", codeHash: CODE_A, storageUsage: 9, blockHeight: HEAD });
    const global = (async () =>
      Response.json({
        jsonrpc: "2.0",
        id: "x",
        result: { amount: "1", locked: "0", code_hash: "11111111111111111111111111111111", global_contract_hash: CODE_A, storage_usage: 1, storage_paid_at: 0, block_height: 7, block_hash: "h" },
      })) as typeof fetch;
    expect((await new ChainReader({ fetch: global, endpoints: ["https://g.example"] }).account("g.testnet"))?.codeHash).toBe(CODE_A);
  });

  it("reads function-call and full-access keys, and null for a missing key", async () => {
    const n = new FakeNode().setAccount("agent.testnet", 1, { amount: "1", code_hash: CODE_A, storage_usage: 1 });
    n.keys.set("agent.testnet/ed25519:fc", { FunctionCall: { allowance: "250000000000000000000000", receiver_id: "agent.testnet", method_names: ["pay"] } });
    n.keys.set("agent.testnet/ed25519:full", "FullAccess");
    const r = new ChainReader({ fetch: n.fetch, endpoints: ["https://a.example"] });
    expect(await r.accessKey("agent.testnet", "ed25519:fc")).toEqual({ kind: "function_call", receiver: "agent.testnet", methods: ["pay"], allowance: "250000000000000000000000" });
    expect(await r.accessKey("agent.testnet", "ed25519:full")).toEqual({ kind: "full_access" });
    expect(await r.accessKey("agent.testnet", "ed25519:none")).toBeNull();
  });

  it("treats a contract panic as an answer, in both the new and the old error shape", async () => {
    for (const legacy of [false, true]) {
      const n = new FakeNode().setAccount("c.testnet", 1, { amount: "1", code_hash: CODE_A, storage_usage: 1 });
      n.legacyErrors = legacy;
      const r = new ChainReader({ fetch: n.fetch, endpoints: ["https://a.example", "https://b.example"] });
      const e = await r.view("c.testnet", "get_safe", { id: "x" }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ChainError);
      expect((e as ChainError).kind).toBe("contract");
      expect(n.calls).toHaveLength(1);
    }
  });

  it("moves to the second endpoint only when the first is down", async () => {
    const good = new FakeNode().setAccount("c.testnet", 1, { amount: "1", code_hash: CODE_A, storage_usage: 1 });
    const seen: string[] = [];
    const fetchBoth = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(String(input));
      if (String(input) === "https://down.example") return new Response("<html>502</html>", { status: 502 });
      return good.fetch(input, init);
    }) as typeof fetch;
    const r = new ChainReader({ fetch: fetchBoth, endpoints: ["https://down.example", "https://up.example"] });
    expect((await r.account("c.testnet"))?.amount).toBe("1");
    expect(seen).toEqual(["https://down.example", "https://up.example"]);
    seen.length = 0;
    expect(await r.account("missing.testnet")).toBeNull();
    expect(seen).toEqual(["https://down.example", "https://up.example"]);
  });

  it("does not ask a second node about an account the first says does not exist", async () => {
    const n = new FakeNode();
    const r = new ChainReader({ fetch: n.fetch, endpoints: ["https://a.example", "https://b.example"] });
    expect(await r.account("missing.testnet")).toBeNull();
    expect(n.calls).toHaveLength(1);
  });

  it("fails with a transport error when every endpoint is down", async () => {
    const n = new FakeNode();
    n.down = 503;
    const r = new ChainReader({ fetch: n.fetch, endpoints: ["https://a.example", "https://b.example"] });
    await expect(r.head()).rejects.toMatchObject({ kind: "server" });
  });
});
