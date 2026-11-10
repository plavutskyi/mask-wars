import { describe, expect, it } from "vitest";
import { BTC, USDC } from "../src/assets.ts";
import { NearRpc, RpcError } from "../src/rpc.ts";

type Handler = (url: string, body: { params: Record<string, unknown> }) => Response | Promise<Response>;

function mockFetch(handler: Handler) {
  const calls: { url: string; params: Record<string, unknown> }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as { params: Record<string, unknown> };
    calls.push({ url, params: body.params });
    return handler(url, body);
  }) as typeof fetch;
  return { fn, calls };
}

const ok = (value: unknown, height = 100) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result: { result: [...Buffer.from(JSON.stringify(value))], block_height: height, logs: [] } }));

describe("NearRpc", () => {
  it("mt_balance_of decodes bytes and sends the right call", async () => {
    const { fn, calls } = mockFetch(() => ok("1234567"));
    const rpc = new NearRpc({ fetch: fn });
    const res = await rpc.mtBalanceOf("abc.near", USDC);
    expect(res.value).toBe("1234567");
    expect(calls[0]?.url).toBe("https://free.rpc.fastnear.com");
    expect(calls[0]?.params).toMatchObject({ request_type: "call_function", finality: "final", account_id: "intents.near", method_name: "mt_balance_of" });
    const args = JSON.parse(Buffer.from(String(calls[0]?.params["args_base64"]), "base64").toString());
    expect(args).toEqual({ account_id: "abc.near", token_id: USDC });
  });

  it("mt_batch_balance_of returns values in order", async () => {
    const { fn } = mockFetch(() => ok(["1", "2"]));
    const res = await new NearRpc({ fetch: fn }).mtBatchBalanceOf("abc.near", [USDC, BTC]);
    expect(res.value).toEqual(["1", "2"]);
  });

  it("fails over to the second RPC on transport or server errors", async () => {
    const { fn, calls } = mockFetch((url) => {
      if (url.includes("fastnear")) throw new TypeError("fetch failed");
      return ok("7");
    });
    const res = await new NearRpc({ fetch: fn }).mtBalanceOf("abc.near", USDC);
    expect(res).toMatchObject({ value: "7", endpoint: "https://near.drpc.org" });
    expect(calls).toHaveLength(2);
  });

  it("fails over on HTTP 503 too, and reports both when all fail", async () => {
    const { fn } = mockFetch(() => new Response("busy", { status: 503 }));
    await expect(new NearRpc({ fetch: fn }).mtBalanceOf("abc.near", USDC)).rejects.toBeInstanceOf(AggregateError);
  });

  it("does not fail over on a deterministic handler error", async () => {
    const { fn, calls } = mockFetch(
      () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" }, message: "no account" } })),
    );
    await expect(new NearRpc({ fetch: fn }).mtBalanceOf("nobody.near", USDC)).rejects.toMatchObject({ kind: "handler" });
    expect(calls).toHaveLength(1);
  });

  it("contract panic is not retried elsewhere", async () => {
    const { fn, calls } = mockFetch(() => new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result: { error: "wasm execution failed", block_height: 1, logs: [] } })));
    await expect(new NearRpc({ fetch: fn }).view("arena.near", "get", {})).rejects.toBeInstanceOf(RpcError);
    expect(calls).toHaveLength(1);
  });

  it("crossCheck reads the same block on the second RPC and refuses disagreement", async () => {
    const { fn, calls } = mockFetch((url) => (url.includes("fastnear") ? ok("10", 555) : ok("11", 555)));
    await expect(new NearRpc({ fetch: fn, crossCheck: true }).mtBalanceOf("abc.near", USDC)).rejects.toMatchObject({ kind: "mismatch" });
    expect(calls[1]?.params).toMatchObject({ block_id: 555 });
    const same = mockFetch(() => ok("10", 555));
    expect((await new NearRpc({ fetch: same.fn, crossCheck: true }).mtBalanceOf("abc.near", USDC)).value).toBe("10");
  });
});
