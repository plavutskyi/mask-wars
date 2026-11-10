/**
 * The public indexer the jobs reader reads on testnet (FastNEAR explorer API, `tx.test.fastnear.com`), stood in for the
 * local sandbox, which has none. It follows the sandbox's final blocks from genesis, takes every transaction in them
 * with every receipt it set off, and answers the two requests the reader makes, in FastNEAR's own shapes:
 *
 *   POST /v0/account       {"account_id", "max_block_height"?}  → an account's transactions, newest first
 *   POST /v0/transactions  {"tx_hashes": [...]}                  → each transaction with its receipts, logs and status
 *
 * It also stands in for the judge projects' public storage on OutLayer, which the world's stand-in judge writes to a
 * folder next to `world.json`: the client fetches the winning work sealed for its key from there.
 *
 *   GET /storage?project=<owner/project>&key=<key>                → the value, as the judge kept it
 *
 *   node jobs-world/indexer.ts <world.json> [port=3031] [store.json]
 *
 * Every answer comes from the sandbox's own JSON-RPC (`block`, `chunk`, `EXPERIMENTAL_tx_status`); nothing is made up.
 * A transaction is kept once it is final, so a node that later drops old blocks loses nothing here.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { Rpc } from "./near.ts";

const [worldPath, portArg, storeArg] = process.argv.slice(2);
if (!worldPath) throw new Error("usage: node jobs-world/indexer.ts <world.json> [port] [store.json]");
const port = Number(portArg ?? 3031);
const storePath = storeArg ?? worldPath.replace(/\.json$/, "") + ".index.json";

type Json = Record<string, unknown>;

interface Stored {
  hash: string;
  height: number;
  /** ns, decimal. */
  timestamp: string;
  /** Every account the transaction touched, and whether it got a function call in it. */
  accounts: Record<string, { call: boolean; signer: boolean; receiver: boolean; predecessor: boolean }>;
  ok: boolean;
  tx: Json;
}

interface Store {
  lastHeight: number;
  txs: Stored[];
  pending: { hash: string; sender: string; height: number; timestamp: string }[];
}

const EMPTY_ROOT = "11111111111111111111111111111111";

function waitForWorld(): Promise<{ rpc: string; storage: string | null }> {
  return new Promise((done) => {
    const tick = () => {
      try {
        const w = JSON.parse(readFileSync(worldPath!, "utf8")) as { rpc?: string; storage?: string };
        if (w.rpc) return done({ rpc: w.rpc, storage: w.storage ?? null });
      } catch {
        // not written yet
      }
      setTimeout(tick, 300);
    };
    tick();
  });
}

const store: Store = existsSync(storePath) ? (JSON.parse(readFileSync(storePath, "utf8")) as Store) : { lastHeight: 0, txs: [], pending: [] };
const byHash = new Map(store.txs.map((t) => [t.hash, t]));
let dirty = false;

function save() {
  if (!dirty) return;
  writeFileSync(storePath, JSON.stringify(store));
  dirty = false;
}

const { rpc: url, storage } = await waitForWorld();
const rpc = new Rpc(url);
const blocks = new Map<string, { height: number; timestamp: string }>();

interface Block {
  header: { height: number; hash: string; prev_hash: string; timestamp_nanosec: string };
  chunks: { chunk_hash: string; tx_root: string }[];
}

async function block(id: string | number | null): Promise<Block> {
  return rpc.call<Block>("block", id === null ? { finality: "final" } : { block_id: id });
}

async function blockInfo(hash: string) {
  let b = blocks.get(hash);
  if (!b) {
    const full = await block(hash);
    b = { height: full.header.height, timestamp: full.header.timestamp_nanosec };
    blocks.set(hash, b);
  }
  return b;
}

/** New final blocks since the last one seen, oldest first: walked back by parent hash, so skipped heights cost nothing. */
async function follow() {
  const head = await block(null);
  if (head.header.height <= store.lastHeight) return;
  const fresh: Block[] = [];
  let cur: Block | null = head;
  while (cur && cur.header.height > store.lastHeight) {
    fresh.push(cur);
    if (cur.header.height === 0 || /^1+$/.test(cur.header.prev_hash)) break;
    cur = await block(cur.header.prev_hash).catch(() => null);
  }
  for (const b of fresh.reverse()) {
    blocks.set(b.header.hash, { height: b.header.height, timestamp: b.header.timestamp_nanosec });
    for (const c of b.chunks) {
      if (c.tx_root === EMPTY_ROOT) continue;
      const chunk = await rpc.call<{ transactions: { hash: string; signer_id: string }[] }>("chunk", { chunk_id: c.chunk_hash });
      for (const t of chunk.transactions) {
        if (byHash.has(t.hash) || store.pending.some((p) => p.hash === t.hash)) continue;
        store.pending.push({ hash: t.hash, sender: t.signer_id, height: b.header.height, timestamp: b.header.timestamp_nanosec });
      }
    }
  }
  store.lastHeight = head.header.height;
  dirty = true;
}

interface TxStatus {
  final_execution_status: string;
  status: { Failure?: unknown };
  transaction: Json & { hash: string; signer_id: string; receiver_id: string; actions: Json[] };
  transaction_outcome: { block_hash: string; id: string; outcome: Json };
  receipts_outcome: { block_hash: string; id: string; outcome: Json & { executor_id: string } }[];
  receipts: { predecessor_id: string; receiver_id: string; receipt_id: string; receipt: Json; priority?: number }[];
}

const hasCall = (actions: unknown) => Array.isArray(actions) && actions.some((a) => typeof a === "object" && a !== null && "FunctionCall" in a);

/** A transaction in FastNEAR's shape, once every receipt it set off has run and is final. */
async function settle(p: Store["pending"][number]): Promise<Stored | null> {
  let r: TxStatus;
  try {
    r = await rpc.call<TxStatus>("EXPERIMENTAL_tx_status", { tx_hash: p.hash, sender_account_id: p.sender, wait_until: "FINAL" }, 2_500);
  } catch {
    return null; // still running (a judge's yield waits for its answer), or not final yet
  }
  if (r.final_execution_status !== "FINAL") return null;
  const t = r.transaction;
  const accounts: Stored["accounts"] = {};
  const touch = (account: string, what: Partial<Stored["accounts"][string]>) => {
    if (!account || account === "system") return;
    const a = (accounts[account] ??= { call: false, signer: false, receiver: false, predecessor: false });
    Object.assign(a, Object.fromEntries(Object.entries(what).filter(([, v]) => v)));
  };
  touch(t.signer_id, { signer: true });
  touch(t.receiver_id, { receiver: true, call: hasCall(t.actions) });
  const own = await blockInfo(r.transaction_outcome.block_hash);
  const receipts: Json[] = [];
  for (const ro of r.receipts_outcome) {
    const at = await blockInfo(ro.block_hash);
    const body = r.receipts.find((x) => x.receipt_id === ro.id);
    const predecessor = body?.predecessor_id ?? (ro.id === (r.transaction_outcome.outcome["receipt_ids"] as string[] | undefined)?.[0] ? t.signer_id : "system");
    const receiver = body?.receiver_id ?? ro.outcome.executor_id;
    const receipt = body?.receipt ?? { Action: { signer_id: t.signer_id, actions: t.actions } };
    const action = (receipt as { Action?: { actions?: unknown } }).Action;
    touch(predecessor, { predecessor: true });
    touch(receiver, { receiver: true, call: hasCall(action?.actions) });
    receipts.push({
      execution_outcome: { block_hash: ro.block_hash, block_height: at.height, block_timestamp: Number(at.timestamp), id: ro.id, outcome: ro.outcome },
      receipt: {
        block_height: at.height,
        block_hash: ro.block_hash,
        block_timestamp: Number(at.timestamp),
        predecessor_id: predecessor,
        receiver_id: receiver,
        receipt_id: ro.id,
        receipt,
        priority: body?.priority ?? 0,
      },
    });
  }
  return {
    hash: t.hash,
    height: own.height,
    timestamp: own.timestamp,
    accounts,
    ok: !r.status.Failure,
    tx: {
      transaction: t,
      execution_outcome: {
        block_hash: r.transaction_outcome.block_hash,
        block_height: own.height,
        block_timestamp: Number(own.timestamp),
        id: r.transaction_outcome.id,
        outcome: r.transaction_outcome.outcome,
      },
      receipts,
    },
  };
}

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    await follow();
    const done = await Promise.all(store.pending.map(settle));
    store.pending = store.pending.filter((_, i) => {
      const s = done[i];
      if (!s) return true;
      store.txs.push(s);
      byHash.set(s.hash, s);
      return false;
    });
    if (done.some(Boolean)) dirty = true;
    save();
  } catch (error) {
    console.error(`indexer: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    busy = false;
  }
}
setInterval(tick, 400);
await tick();

const PAGE = 200;

function account(body: Json): Json {
  const id = String(body["account_id"] ?? "");
  const max = typeof body["max_block_height"] === "number" ? body["max_block_height"] : Number.POSITIVE_INFINITY;
  const all = store.txs.filter((t) => t.accounts[id]).sort((a, b) => b.height - a.height || b.hash.localeCompare(a.hash));
  const rows = all
    .filter((t) => t.height <= max)
    .slice(0, PAGE)
    .map((t) => {
      const a = t.accounts[id]!;
      return {
        account_id: id,
        transaction_hash: t.hash,
        tx_block_height: t.height,
        tx_block_timestamp: t.timestamp,
        tx_index: 0,
        is_signer: a.signer,
        is_predecessor: a.predecessor,
        is_receiver: a.receiver,
        is_function_call: a.call,
        is_success: t.ok,
      };
    });
  return { account_txs: rows, txs_count: all.length };
}

/** FastNEAR leaves the gas profile out of every outcome (`gas_profile: null`); so does this. */
function plain(outcome: unknown): unknown {
  if (!outcome || typeof outcome !== "object") return outcome;
  const o = outcome as Json;
  const metadata = o["metadata"] && typeof o["metadata"] === "object" ? { ...(o["metadata"] as Json), gas_profile: null } : o["metadata"];
  return { ...o, metadata };
}

function shaped(tx: Json): Json {
  const own = tx["execution_outcome"] as Json;
  const receipts = (tx["receipts"] as Json[]).map((r) => {
    const eo = r["execution_outcome"] as Json;
    return { ...r, execution_outcome: { ...eo, outcome: plain(eo["outcome"]) } };
  });
  return { ...tx, execution_outcome: { ...own, outcome: plain(own["outcome"]) }, receipts };
}

function transactions(body: Json): Json {
  const hashes = Array.isArray(body["tx_hashes"]) ? body["tx_hashes"].map(String) : [];
  return { transactions: hashes.flatMap((h) => (byHash.has(h) ? [shaped(byHash.get(h)!.tx)] : [])) };
}

/** A value of a judge project's public storage: the folder the stand-in judge keeps, one file a key. */
function stored(url: URL): string | null {
  const project = url.searchParams.get("project") ?? "";
  const key = url.searchParams.get("key") ?? "";
  if (!storage || !/^[\w.-]+\/[\w.-]+$/.test(project) || !/^[\w./-]{1,200}$/.test(key) || key.includes("..")) return null;
  const file = join(storage, project.replaceAll("/", "%2F"), key.replaceAll("/", "%2F"));
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

createServer((req, res) => {
  if (req.method === "GET" && req.url?.startsWith("/storage")) {
    const value = stored(new URL(req.url, "http://localhost"));
    if (value === null) res.writeHead(404, { "content-type": "text/plain" }).end("no such key");
    else res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" }).end(value);
    return;
  }
  let raw = "";
  req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
  req.on("end", () => {
    let body: Json = {};
    try {
      body = raw ? (JSON.parse(raw) as Json) : {};
    } catch {
      res.writeHead(400).end("not JSON");
      return;
    }
    const answer = req.url === "/v0/account" ? account(body) : req.url === "/v0/transactions" ? transactions(body) : null;
    if (!answer) {
      res.writeHead(404).end("unknown path");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
  });
}).listen(port, "127.0.0.1", () => console.log(`sandbox indexer on http://127.0.0.1:${port}, following ${url}`));
