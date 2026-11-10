// A local stand-in for the FastNEAR indexer over a NEAR sandbox, to look at the arena with real local chain data and
// nothing made up: every transaction it serves is one the sandbox ran. It reads each block of the sandbox once, takes
// every transaction with its receipts from the sandbox's own RPC, and answers /v0/account and /v0/transactions in the
// shape packages/arena/src/indexer.ts reads.
//
// Usage: node apps/web/scripts/sandbox-indexer.mjs <sandbox rpc> [port]
//   then run the site with ARENA_RPC=<sandbox rpc> ARENA_INDEXER=http://127.0.0.1:<port> ARENA_CONTRACTS=<bounty>.
import http from 'node:http';

const [RPC, PORT = '3939'] = process.argv.slice(2);
if (!RPC) throw new Error('usage: sandbox-indexer.mjs <sandbox rpc> [port]');

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'indexer', method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error).slice(0, 300)}`);
  return body.result;
}

const blocks = new Map();
const blockOf = async (id) => {
  if (!blocks.has(id)) blocks.set(id, await rpc('block', { block_id: id }));
  return blocks.get(id);
};

/** hash → the transaction as FastNEAR shows it; account → hash → its row in /v0/account. */
const txs = new Map();
const byAccount = new Map();
let scanned = 0;

function touch(account, row, call) {
  if (!account || account === 'system') return;
  const rows = byAccount.get(account) ?? new Map();
  const had = rows.get(row.transaction_hash);
  rows.set(row.transaction_hash, { ...row, is_function_call: call || had?.is_function_call === true });
  byAccount.set(account, rows);
}

const hasCall = (actions) => (actions ?? []).some((a) => a && typeof a === 'object' && 'FunctionCall' in a);

async function add(hash, signer, height, at) {
  const st = await rpc('EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: signer, wait_until: 'FINAL' });
  const receipts = [];
  for (const r of st.receipts ?? []) {
    const o = (st.receipts_outcome ?? []).find((x) => x.id === r.receipt_id);
    const b = o ? await blockOf(o.block_hash) : null;
    receipts.push({
      receipt: { receipt_id: r.receipt_id, predecessor_id: r.predecessor_id, receiver_id: r.receiver_id, receipt: r.receipt },
      execution_outcome: {
        id: r.receipt_id,
        block_timestamp: b?.header.timestamp_nanosec ?? at,
        outcome: { status: o?.outcome.status ?? {}, logs: o?.outcome.logs ?? [] },
      },
    });
  }
  txs.set(hash, {
    transaction: { hash, signer_id: st.transaction.signer_id, receiver_id: st.transaction.receiver_id, actions: st.transaction.actions },
    execution_outcome: { block_timestamp: at, block_height: height, outcome: { status: st.transaction_outcome.outcome.status } },
    receipts,
  });
  const row = { transaction_hash: hash, tx_block_height: height, tx_block_timestamp: at };
  touch(st.transaction.signer_id, row, false);
  touch(st.transaction.receiver_id, row, hasCall(st.transaction.actions));
  for (const r of st.receipts ?? []) {
    touch(r.receiver_id, row, hasCall(r.receipt?.Action?.actions));
    touch(r.predecessor_id, row, false);
  }
}

let scanning = null;
async function scan() {
  scanning ??= (async () => {
    const head = (await rpc('block', { finality: 'final' })).header.height;
    for (let h = scanned + 1; h <= head; h++) {
      let block;
      try {
        block = await rpc('block', { block_id: h });
      } catch {
        continue;
      }
      for (const c of block.chunks) {
        if (c.height_included !== h) continue;
        const chunk = await rpc('chunk', { chunk_id: c.chunk_hash });
        for (const t of chunk.transactions) await add(t.hash, t.signer_id, h, block.header.timestamp_nanosec);
      }
    }
    scanned = head;
  })().finally(() => (scanning = null));
  return scanning;
}

const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const answer = (status, json) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(json));
  };
  try {
    const q = body ? JSON.parse(body) : {};
    await scan();
    if (req.url === '/v0/account') {
      const rows = [...(byAccount.get(q.account_id)?.values() ?? [])]
        .filter((r) => q.max_block_height == null || r.tx_block_height <= q.max_block_height)
        .sort((a, b) => b.tx_block_height - a.tx_block_height);
      return answer(200, { account_txs: rows, txs_count: byAccount.get(q.account_id)?.size ?? 0 });
    }
    if (req.url === '/v0/transactions') {
      return answer(200, { transactions: (q.tx_hashes ?? []).map((h) => txs.get(h)).filter(Boolean) });
    }
    answer(404, { error: 'no such path' });
  } catch (e) {
    answer(500, { error: String(e) });
  }
});

await scan();
server.listen(Number(PORT), '127.0.0.1', () => console.log(`indexer on http://127.0.0.1:${PORT}: ${txs.size} transactions, ${byAccount.size} accounts`));
