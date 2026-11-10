/**
 * Records what NEAR RPC answers MASK CHECK about real accounts, so the tests check real chain data without a network:
 *
 *   pnpm --filter @maskwars/check record [testnet|mainnet]
 *
 * Writes test/recorded/<network>.json. Every distinct request goes to the network once and its answer is kept: the
 * checks after the first read the same final block, so the recording is one consistent moment of the chain. A block
 * answer keeps the header fields the reader reads; its chunks are dropped. A provider's rate limit or outage is
 * retried a few times, then recorded as it was.
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { type Network, isNetwork, maskCheck, readerFor, sharedLists } from "../src/index.ts";
import { type Exchange, type Recording, bodyOf, keyOf } from "../test/replay.ts";

/** A 64-hex implicit id nobody holds a key for: sha256 of a sentence. */
export const UNUSED_IMPLICIT = createHash("sha256").update("maskwars season 0: an implicit account nobody used").digest("hex");

const ACCOUNTS: Record<Network, string[]> = {
  // NEAR Intents, Tether USD, a lookalike under intents.near that does not exist, and an implicit id nobody used.
  mainnet: ["intents.near", "usdt.tether-token.near", "treasury.intents.near", UNUSED_IMPLICIT],
  // The arena's drained safe, its old bounty contract, a mask, and a vendor name that does not exist.
  testnet: ["safe-0001.tinygif8324.testnet", "tinygif8324.testnet", "nova.tinygif8324.testnet", "acme-hosting-4471.testnet"],
};

const HEADER_KEYS = ["height", "prev_height", "hash", "prev_hash", "timestamp", "timestamp_nanosec", "epoch_id"];

function trim(method: string, response: unknown): unknown {
  const r = response as { result?: { header?: Record<string, unknown>; author?: unknown } } | null;
  if (method !== "block" || !r?.result?.header) return response;
  const header = Object.fromEntries(HEADER_KEYS.filter((k) => k in r.result!.header!).map((k) => [k, r.result!.header![k]]));
  return { ...r, result: { author: r.result.author, header, chunks: [] } };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function recordingFetch(): { fetch: typeof fetch; kept: Map<string, Exchange> } {
  const kept = new Map<string, Exchange>();
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const { method, params } = bodyOf(init);
    const key = keyOf(url, method, params);
    let e = kept.get(key);
    if (!e) {
      let res: Response | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        res = await fetch(input, init);
        if (res.status !== 429 && res.status < 500) break;
        await sleep(1_000 * 2 ** attempt);
      }
      const text = await res!.text();
      let response: unknown;
      try {
        response = JSON.parse(text);
      } catch {
        response = text;
      }
      e = { url, method, params, status: res!.status, response: trim(method, response) };
      kept.set(key, e);
    }
    return new Response(JSON.stringify(e.response), { status: e.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, kept };
}

async function record(network: Network): Promise<void> {
  const { fetch: f, kept } = recordingFetch();
  const reader = readerFor(network, { fetch: f });
  const recordedAt = new Date();
  const checks: Recording["checks"] = [];
  for (const account of ACCOUNTS[network]) {
    const r = await maskCheck(account, { network, reader, list: sharedLists[network], now: () => recordedAt });
    checks.push({ account: r.account, verdict: r.verdict, codes: r.reasons.map((x) => x.code) });
    console.log(`${r.verdict.toUpperCase().padEnd(5)} ${r.account}  (${network}, block ${r.block?.height ?? "unread"})`);
    for (const x of r.reasons) console.log(`      ${x.level.padEnd(5)} ${x.code}: ${x.text}`);
    await sleep(400);
  }
  const out: Recording = {
    network,
    recorded_at: recordedAt.toISOString(),
    about: `What NEAR ${network} RPC answered MASK CHECK about ${ACCOUNTS[network].length} real accounts, recorded by scripts/record.ts. Block answers keep the header fields the reader reads; chunks are dropped.`,
    endpoints: [...reader.endpoints],
    checks,
    exchanges: [...kept.values()],
  };
  const file = new URL(`../test/recorded/${network}.json`, import.meta.url);
  await writeFile(file, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`${out.exchanges.length} answers → ${file.pathname}`);
}

const only = process.argv[2];
if (only !== undefined && !isNetwork(only)) {
  console.error("usage: record [testnet|mainnet]");
  process.exit(3);
}
for (const network of only ? [only] : (["mainnet", "testnet"] as const)) await record(network);
