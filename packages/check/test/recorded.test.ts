// MASK CHECK on real accounts, from what mainnet and testnet RPC answered (test/recorded/*.json): the same verdicts
// and reasons as live, and what happens when one mainnet provider is down, rate-limited or lies.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { type Guard, guardedPay } from "../src/agent.ts";
import { type CheckResult, maskCheck } from "../src/check.ts";
import { sharedLists } from "../src/index.ts";
import { type Network, readerFor } from "../src/network.ts";
import { type Recording, bodyOf, replayFetch } from "./replay.ts";

const load = (network: Network) => JSON.parse(readFileSync(new URL(`./recorded/${network}.json`, import.meta.url), "utf8")) as Recording;
const RECORDED = { mainnet: load("mainnet"), testnet: load("testnet") };

const FASTNEAR = "https://rpc.mainnet.fastnear.com";
const DRPC = "https://near.drpc.org";
const ARCHIVAL = "https://archival-rpc.mainnet.fastnear.com";
const UNUSED = "be330f9965ff38d722a9ddfa3dafb4435308677b95906023165cfda10bb66925";

/** One check over the recording; `wrap` changes what the network answers. */
async function check(network: Network, account: string, wrap?: (f: typeof fetch) => typeof fetch) {
  const rec = RECORDED[network];
  const replay = replayFetch(rec);
  const reader = readerFor(network, { fetch: wrap ? wrap(replay.fetch) : replay.fetch });
  const r = await maskCheck(account, { network, reader, list: sharedLists[network], now: () => new Date(rec.recorded_at) });
  return { r, requests: replay.requests };
}

const codes = (r: CheckResult) => r.reasons.map((x) => x.code);

/** The height every recorded check read at: the lowest final head the providers gave. */
const pinned = (network: Network) =>
  Math.min(
    ...RECORDED[network].exchanges
      .filter((e) => e.method === "block" && (e.params as Record<string, unknown>)["finality"] === "final")
      .map((e) => (e.response as { result: { header: { height: number } } }).result.header.height),
  );

describe.each(["mainnet", "testnet"] as const)("the recorded %s", (network) => {
  it.each(RECORDED[network].checks.map((c) => [c.account, c] as const))("%s: the same answer as live", async (account, live) => {
    const { r } = await check(network, account);
    expect(r.network).toBe(network);
    expect(r.verdict).toBe(live.verdict);
    expect(codes(r)).toEqual(live.codes);
    expect(r.block?.height).toBe(pinned(network));
  });
});

describe("mainnet, real accounts", () => {
  it("allows NEAR Intents: a contract with its code hash, older than a day, both providers agreeing on every read", async () => {
    const { r, requests } = await check("mainnet", "intents.near");
    expect(r.verdict).toBe("allow");
    expect(r.summary).toBe("No signals against this account were found.");
    expect(r.reasons.find((x) => x.code === "contract")?.evidence).toEqual({ code_hash: "BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk" });
    expect(r.reasons.find((x) => x.code === "rpc_agree")).toMatchObject({
      level: "info",
      text: "Two independent RPC providers, rpc.mainnet.fastnear.com and near.drpc.org, gave the same answer to all 5 reads.",
      evidence: { rpc: "rpc.mainnet.fastnear.com, near.drpc.org", reads: 5, cross_checked: 5 },
    });
    expect(r.rpc).toEqual([FASTNEAR, DRPC]);
    // Every read went to both providers with the same params, at fixed heights.
    const asked = (url: string) => requests.filter((q) => q.url === url).map((q) => JSON.stringify(q.params));
    expect(asked(FASTNEAR).filter((p) => !p.includes("finality"))).toEqual(asked(DRPC).filter((p) => !p.includes("finality")));
    expect(requests.filter((q) => q.method === "query").every((q) => typeof q.params["block_id"] === "number")).toBe(true);
    // The day-old block is gone from FastNEAR's regular node: its archival node answered for it.
    expect(requests.some((q) => q.url === ARCHIVAL)).toBe(true);
  });

  it("allows Tether USD on mainnet the same way", async () => {
    const { r } = await check("mainnet", "usdt.tether-token.near");
    expect(r.verdict).toBe("allow");
    expect(codes(r)).toEqual(["account_age", "contract", "rpc_agree"]);
  });

  it("blocks a lookalike that does not exist: a payment cannot arrive", async () => {
    const { r } = await check("mainnet", "treasury.intents.near");
    expect(r.verdict).toBe("block");
    expect(r.summary).toBe("BLOCK: No such account on mainnet: a payment cannot arrive.");
    expect(codes(r)).toEqual(["no_account", "rpc_agree"]);
  });

  it("warns on an implicit account nobody used", async () => {
    const { r } = await check("mainnet", UNUSED);
    expect(r.verdict).toBe("warn");
    expect(codes(r)).toEqual(["unused_implicit", "rpc_agree"]);
  });

  it("stops and warns when one provider lies about an account", async () => {
    const lie = (f: typeof fetch) =>
      (async (input: string | URL | Request, init?: RequestInit) => {
        const res = await f(input, init);
        const { params } = bodyOf(init);
        if (String(input) !== DRPC || (params as Record<string, unknown>)["request_type"] !== "view_account") return res;
        const body = (await res.json()) as { result?: { amount?: string } };
        if (body.result) body.result.amount = "1";
        return Response.json(body, { status: res.status });
      }) as typeof fetch;
    const { r } = await check("mainnet", "intents.near", lie);
    expect(r.verdict).toBe("warn");
    expect(codes(r)).toEqual(["rpc_disagree"]);
    expect(r.reasons[0]?.text).toMatch(/^Two RPC providers gave different answers to the same read, so the check stopped there and nothing after it was read: view_account intents\.near at block \d+: rpc\.mainnet\.fastnear\.com .* vs near\.drpc\.org /);
    expect(r.block).not.toBeNull();
  });

  it("one dishonest provider cannot buy an allow by naming a final head the other has not reached", async () => {
    // dRPC wants `allow` for a lookalike that does not exist. It names a head 100 000 blocks past the chain's and is
    // ready to say, at that height, that the account is an old contract. FastNEAR, honest, has no such block.
    const AHEAD = 100_000;
    const fake = pinned("mainnet") + AHEAD;
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id: "maskwars-check", result });
    const header = (h: number) => ({ height: h, hash: `Fake${h}`.padEnd(44, "A"), timestamp_nanosec: String(BigInt(Date.parse(RECORDED.mainnet.recorded_at)) * 1_000_000n - BigInt(fake - h) * 600_000_000n) });
    const lie = (f: typeof fetch) =>
      (async (input: string | URL | Request, init?: RequestInit) => {
        const { method, params } = bodyOf(init) as { method: string; params: Record<string, unknown> };
        const h = params["block_id"];
        if (String(input) === DRPC) {
          if (method === "block" && params["finality"] === "final") return ok({ header: header(fake) });
          if (typeof h === "number" && h > pinned("mainnet") - 200_000) {
            if (method === "block") return ok({ header: header(h) });
            return ok({ amount: "1000000000000000000000000000", locked: "0", code_hash: "8JLoDp5bYW3HbvwdjqLM6QiXEeNs7fWkuAHMCw3D7Xyn", storage_usage: 5000, block_height: h, block_hash: header(h).hash });
          }
        } else if (typeof h === "number" && h > pinned("mainnet")) {
          return Response.json({ jsonrpc: "2.0", id: "maskwars-check", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK", info: {} }, code: -32000, message: "Server error", data: `DB Not Found Error: BLOCK HEIGHT: ${h}` } });
        }
        return f(input, init);
      }) as typeof fetch;
    const { r, requests } = await check("mainnet", "treasury.intents.near", lie);
    expect(r.verdict).toBe("warn");
    expect(codes(r)).toEqual(["rpc_disagree"]);
    expect(r.reasons[0]?.text).toBe(
      `Two RPC providers gave different answers to the same read, so the check stopped there and nothing after it was read: final head: rpc.mainnet.fastnear.com ${pinned("mainnet")} vs near.drpc.org ${fake}, ${AHEAD} blocks apart`,
    );
    expect(r.block).toBeNull();
    // Nothing was read at the height one provider chose alone.
    expect(requests.filter((q) => "block_id" in q.params)).toEqual([]);
  });

  it("reads on with one provider when the other is down, warns that nothing was cross-checked, and asks the down one once", async () => {
    let drpcCalls = 0;
    const down = (f: typeof fetch) =>
      (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input) === DRPC) {
          drpcCalls++;
          return new Response("<html>502 Bad Gateway</html>", { status: 502 });
        }
        return f(input, init);
      }) as typeof fetch;
    const { r } = await check("mainnet", "intents.near", down);
    // One provider alone never makes an allow: it could have made every answer up.
    expect(r.verdict).toBe("warn");
    expect(codes(r)).toEqual(["rpc_single", "account_age", "contract"]);
    expect(r.reasons[0]).toMatchObject({ level: "warn", text: "5 of 5 reads came from one RPC provider only and were not cross-checked (near.drpc.org: HTTP 502, invalid JSON)." });
    expect(r.summary).toBe(`WARN: ${r.reasons[0]?.text}`);
    expect(drpcCalls).toBe(1);
  });

  it("reads a provider's rate limit as the provider being down, not as a disagreement", async () => {
    const limited = (f: typeof fetch) =>
      (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input) === FASTNEAR || String(input) === ARCHIVAL) {
          return Response.json({ jsonrpc: "2.0", id: "1", error: { code: -429, message: "Rate limits exceeded. For higher rate limits get a subscription at https://fastnear.com" } }, { status: 429 });
        }
        return f(input, init);
      }) as typeof fetch;
    const { r } = await check("mainnet", "treasury.intents.near", limited);
    expect(r.verdict).toBe("block");
    expect(codes(r)).toEqual(["no_account", "rpc_single"]);
    expect(r.reasons.at(-1)).toMatchObject({ level: "warn" });
    expect(r.reasons.at(-1)?.text).toContain("rpc.mainnet.fastnear.com: HTTP 429: Rate limits exceeded");
  });

  it("warns and reads nothing when neither provider answers", async () => {
    const { r } = await check("mainnet", "intents.near", () => (async () => new Response("", { status: 503 })) as typeof fetch);
    expect(r.verdict).toBe("warn");
    expect(codes(r)).toEqual(["chain_unreadable"]);
    expect(r.block).toBeNull();
  });

  it("the wrapper refuses an injected payee on mainnet and never calls the signer", async () => {
    const sign = vi.fn(async () => "tx");
    const call = (payee: string) => ({
      payee,
      amount: "1",
      call: { contract: "agent-wallet.example.near", method: "pay", args: { receiver: payee, amount: "1" }, deposit: "0", gas: "30000000000000" },
      why: "invoice",
    });
    const guard: Guard = {
      key: { kind: "function_call", receiver: "agent-wallet.example.near", methods: ["pay"], allowance: null },
      check: async (account: string) => (await check("mainnet", account)).r,
      askHuman: async () => false,
      sign,
    };
    expect(await guardedPay(call("treasury.intents.near"), guard)).toMatchObject({ status: "refused", by: "block" });
    expect(sign).not.toHaveBeenCalled();
    expect(await guardedPay(call("intents.near"), guard)).toMatchObject({ status: "signed", verdict: "allow" });
    expect(sign).toHaveBeenCalledTimes(1);
  });
});

describe("testnet, real accounts, as before", () => {
  it("blocks the arena's drained safe, with the drain on testnet's explorer", async () => {
    const { r } = await check("testnet", "safe-0001.tinygif8324.testnet");
    expect(r.verdict).toBe("block");
    expect(r.reasons[0]).toMatchObject({ code: "arena_drained", evidence: { race: "race-0003", winner: "nova.tinygif8324.testnet", tx: expect.stringMatching(/^https:\/\/testnet\.nearblocks\.io\/txns\//) } });
    expect(r.rpc).toEqual(["https://rpc.testnet.fastnear.com", "https://rpc.testnet.near.org"]);
    expect(codes(r).some((c) => c.startsWith("rpc_"))).toBe(false);
  });

  it("asks testnet's second node only when the first is down", async () => {
    const { requests } = await check("testnet", "nova.tinygif8324.testnet");
    expect(requests.every((q) => q.url === "https://rpc.testnet.fastnear.com")).toBe(true);
  });
});
