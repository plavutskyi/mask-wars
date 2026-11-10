// A stand-in for market.near.ai built from the fixtures: `recorded/` holds live answers of the real API, `docs/` the
// token-gated answers as the API's own schema and docs give them. Every request is kept for the test to read.
import { readFileSync } from "node:fs";
import type { CheckResult, Verdict } from "@maskwars/check";
import { MarketClient } from "../src/client.ts";

export const TOKEN = "aat_00000000000000000000000000000000";

export interface Fixture {
  status: number;
  body: unknown;
}

export function fixture(path: string): Fixture {
  const f = JSON.parse(readFileSync(new URL(`./fixtures/${path}.json`, import.meta.url), "utf8")) as { status?: number; body: unknown };
  return { status: f.status ?? 200, body: f.body };
}

export interface Seen {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}

export type Route = Fixture | ((seen: Seen) => Fixture);

/** A client whose fetch answers from `routes`, keyed `"<METHOD> <path without query>"`. Anything else is a 404. */
export function fakeMarket(routes: Record<string, Route>, token: string | null = TOKEN): { client: MarketClient; seen: Seen[] } {
  const seen: Seen[] = [];
  const fake: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    const s: Seen = {
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      auth: headers.get("authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    seen.push(s);
    const route = routes[`${s.method} ${url.pathname}`];
    const f = typeof route === "function" ? route(s) : (route ?? { status: 404, body: { error: "not_found", message: "not found" } });
    return new Response(JSON.stringify(f.body), { status: f.status, headers: { "content-type": "application/json" } });
  };
  return { client: new MarketClient({ fetch: fake, ...(token ? { token } : {}) }), seen };
}

export function result(account: string, verdict: Verdict, block: CheckResult["block"] = { height: 245_000_000, hash: "BlockHash111", time: "2026-11-07T23:10:02Z" }): CheckResult {
  const reasons: CheckResult["reasons"] =
    verdict === "block"
      ? [
          {
            code: "arena_drained",
            level: "block",
            text: "Drained on the MASK WARS arena: mask nova.tinygif8324.testnet took the safe through its planted hole in race-0003.",
            evidence: {
              contract: "tinygif8324.testnet",
              race: "race-0003",
              winner: "nova.tinygif8324.testnet",
              tx_hash: "8pvCJFDwUW1XXBUKHVMo973Kp1WMkWc4DDpHoHVr2uqg",
              tx: "https://testnet.nearblocks.io/txns/8pvCJFDwUW1XXBUKHVMo973Kp1WMkWc4DDpHoHVr2uqg",
            },
          },
          { code: "account_age", level: "info", text: "The account already existed 24 h ago (block 244900000, 2026-11-06T23:10:00Z)." },
        ]
      : verdict === "warn"
        ? [{ code: "young_account", level: "warn", text: "New account: it did not exist 24 h ago." }]
        : [{ code: "plain_account", level: "info", text: "A plain account: no contract code." }];
  return {
    account,
    network: "testnet",
    verdict,
    summary: verdict === "allow" ? "No signals against this account were found." : `${verdict.toUpperCase()}: ${reasons[0]?.text ?? ""}`,
    reasons,
    block,
    checked_at: "2026-11-07T23:10:02Z",
    rpc: ["https://rpc.testnet.fastnear.com"],
  };
}
