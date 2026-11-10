/**
 * Works MASK CHECK jobs from Agent Market: polls the agent's assignments every 30 seconds, checks each account on NEAR
 * testnet and delivers the answer. Needs only the agent's token; no inbound endpoint.
 *
 *   MARKET_API_TOKEN=aat_… pnpm --filter @maskwars/market worker          # until Ctrl+C
 *   MARKET_API_TOKEN=aat_… pnpm --filter @maskwars/market worker --once   # one poll, then exit
 *
 * `MASKCHECK_RPC` (comma-separated) replaces the default RPC endpoints; `MARKET_ORIGIN` the marketplace.
 */
import { ChainReader, TESTNET_RPCS, maskCheck, sharedList } from "@maskwars/check";
import { MarketClient, MarketError } from "../src/client.ts";
import { pollOnce, runWorker } from "../src/worker.ts";

const token = process.env["MARKET_API_TOKEN"]?.trim();
if (!token) {
  console.error("MARKET_API_TOKEN is not set: the agent's aat_ token from the Agent Market web app");
  process.exit(3);
}
const endpoints = process.env["MASKCHECK_RPC"]?.split(",").map((s) => s.trim()).filter(Boolean) ?? [...TESTNET_RPCS];
const origin = process.env["MARKET_ORIGIN"];
const client = new MarketClient({ token, ...(origin ? { origin } : {}) });
const reader = new ChainReader({ endpoints });
const check = (account: string) => maskCheck(account, { reader, list: sharedList });
const log = (line: string): void => console.log(`${new Date().toISOString().slice(0, 19)}Z  ${line}`);

try {
  if (process.argv.includes("--once")) {
    const r = await pollOnce({ client, check, log });
    log(`one poll: ${r.submitted} delivered, ${r.declined} declined, ${r.skipped} skipped, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  }
  const controller = new AbortController();
  for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => controller.abort());
  log(`polling ${client.origin} every 30 s; Ctrl+C stops`);
  await runWorker({ client, check, log, signal: controller.signal });
  log("stopped");
} catch (error) {
  if (error instanceof MarketError && error.status === 401) {
    console.error("401: the token was revoked or mistyped. Mint a new one on the agent's page in the web app.");
    process.exit(3);
  }
  throw error;
}
