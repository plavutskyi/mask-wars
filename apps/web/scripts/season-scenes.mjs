// A season round in every state the arena shows it, as recordings the site replays (ARENA_FIXTURE): the round opens
// and the masks seal, the window closes and a mask plays its plan, the reveals, the drain and its claim, the payout,
// the vault that held, and the wait for the next round.
//
// The base is the real testnet recording (packages/arena/test/fixtures/testnet.json): the arena's first races stay as
// the chain gave them. On top of it a scripted chain answers for the season: the treasury, the keyless bounty contract
// and the round's safe, in the shapes NEAR RPC and the indexer answer in. The arena's own reader reads that chain and
// every answer is kept, so a scene is a recording like any other. The season's accounts, sums and windows are the ones
// in scripts/testnet/season-args.json; the course of the round is a scenario for the eyes, not a fact of the chain.
//
// Usage: node apps/web/scripts/season-scenes.mjs [out dir]   writes <scene>.json for every scene (default: the temp dir)
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Arena, Indexer, RPCS } from '@maskwars/arena';
import { recordFetch, replayFetch } from '@maskwars/arena/replay';
import { ChainReader } from '@maskwars/check';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = join(here, '..', '..', '..', 'packages', 'arena', 'test', 'fixtures', 'testnet.json');

const TEAM = 'tinygif8324.testnet';
const BOUNTY = `bounty.${TEAM}`;
const SEASON = `season.${TEAM}`;
const SCHEDULER = `scheduler.${TEAM}`;
const NOVA = `nova.${TEAM}`;
const ONYX = `onyx.${TEAM}`;
const ORACLE = `oracle.${TEAM}`;
const MASKS = [NOVA, ONYX, ORACLE];
const OUTLAYER = 'outlayer.testnet';

const MIN = 60_000;
const NEAR = 10n ** 24n;
const milli = (n) => (NEAR * BigInt(n)) / 1000n;
/** season-args.json: 1.5 NEAR in the safe, 0.5 to count, 0.35 locked; the bounty contract keeps storage and fees. */
const SAFE_FUND = milli(1500);
const MIN_LOOT = milli(500);
const LOCKED = milli(350);
const BOUNTY_PAYS = (NEAR * 33664n) / 100000n;
const SAFE_CODE = '7u1QBYjTq4nVx9wKc2mHf8RsLpD3aGeZ6tJyUoNibdZx';
const JUDGE = '1f8e1aca5d0b7c4e93a2f6d81b3c5e7f9a0b2c4d6e8f1a3b5c7d9e0f2a4b6c8d';

const ns = (ms) => (BigInt(ms) * 1_000_000n).toString();
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** A stand-in transaction hash: 44 base58 characters from the label, the same every run. */
function hashOf(label) {
  let n = BigInt(`0x${createHash('sha256').update(label).digest('hex')}`);
  let out = '';
  while (out.length < 44) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out;
}

/** One transaction of the scripted chain: its own call and the receipts it set off. */
function tx(label, signer, receiver, at, method, args, { deposit = 0n, ok = true, receipts = [] } = {}) {
  return { hash: hashOf(label), signer, receiver, at, call: { method, args, deposit }, ok, receipts };
}
const receipt = (from, to, at, { call = null, transfer = 0n, ok = true } = {}) => ({ from, to, at, call, transfer, ok });

/**
 * One round of the season up to `now`: who sealed, who moved, who revealed, how it ended.
 * `course` lists the round's steps as offsets from its opening, in minutes.
 */
function round({ n, id, openedAt, course, now }) {
  const safe = `s${String(n).padStart(4, '0')}.${SEASON}`;
  const at = (min) => openedAt + Math.round(min * MIN);
  const happened = course.filter((s) => at(s.at) <= now);
  const txs = [
    tx(`${id} open_next`, SCHEDULER, SEASON, openedAt - 2000, 'open_next', {}, {
      receipts: [
        receipt(SEASON, safe, openedAt - 1000, { call: { method: 'new', args: { owner: safe }, deposit: 0n }, transfer: SAFE_FUND }),
        receipt(SEASON, BOUNTY, openedAt, {
          call: { method: 'open_safe', args: { id, safe, masks: MASKS, min_loot: MIN_LOOT.toString(), hours: 4, commit_minutes: 45, reveal_minutes: 60 }, deposit: LOCKED },
        }),
      ],
    }),
  ];
  const seals = [];
  let status = { state: 'open' };
  let inSafe = SAFE_FUND;
  for (const s of happened) {
    const t = at(s.at);
    const label = `${id} ${s.do} ${s.who ?? ''} ${s.at}`;
    if (s.do === 'seal') {
      seals.push({ mask: s.who, seq: seals.length, at_ns: ns(t), state: 'sealed' });
      txs.push(tx(label, s.who, BOUNTY, t, 'commit', { id, seal: hashOf(`${label} plan`) }));
    } else if (s.do === 'move') {
      txs.push(tx(label, s.who, safe, t, s.method, s.args ?? {}, { ok: s.ok !== false }));
    } else if (s.do === 'reveal') {
      const seal = seals.find((x) => x.mask === s.who);
      if (seal) seal.state = 'revealed';
      txs.push(tx(label, s.who, BOUNTY, t, 'reveal', { id, salt: hashOf(`${label} salt`).slice(0, 16) }));
    } else if (s.do === 'drain') {
      inSafe -= SAFE_FUND;
      txs.push(tx(label, s.who, safe, t, 'sweep', { to: s.who }, { receipts: [receipt(safe, s.who, t + 1100, { transfer: SAFE_FUND })] }));
    } else if (s.do === 'claim') {
      status = { state: 'judging', claimant: s.who };
      txs.push(tx(label, s.who, BOUNTY, t, 'claim_drain', { id, tx_hash: txs.at(-1).hash }, { receipts: [receipt(BOUNTY, OUTLAYER, t + 1200, { call: { method: 'request_execution', args: {}, deposit: milli(10) } })] }));
    } else if (s.do === 'paid') {
      const claim = txs.findLast((x) => x.call.method === 'claim_drain');
      const drain = txs.findLast((x) => x.call.method === 'sweep' && x.receipts.length);
      status = { state: 'drained', winner: claim.signer, tx_hash: drain.hash };
      claim.receipts.push(
        receipt(OUTLAYER, BOUNTY, t - 900, { call: { method: 'on_judged', args: { id }, deposit: 0n } }),
        receipt(BOUNTY, claim.signer, t, { transfer: BOUNTY_PAYS }),
      );
    } else if (s.do === 'collect') {
      // The scheduler's `collect`: the treasury takes the bounty of a round nobody broke back.
      status = { state: 'refunded' };
      txs.push(
        tx(label, SCHEDULER, SEASON, t - 2000, 'collect', {}, {
          receipts: [receipt(SEASON, BOUNTY, t - 1000, { call: { method: 'refund', args: { id }, deposit: 0n } }), receipt(BOUNTY, SEASON, t, { transfer: BOUNTY_PAYS })],
        }),
      );
    }
  }
  return {
    id,
    safe,
    txs,
    views: {
      get: { owner: SEASON, amount: BOUNTY_PAYS.toString(), target: safe, deadline_ns: ns(at(240)), status },
      get_safe: { safe, masks: MASKS, min_loot: MIN_LOOT.toString(), opened_ns: ns(openedAt) },
      get_round: { commit_until: ns(at(45)), reveal_until: ns(at(105)), deadline_ns: ns(at(240)), seals, judging: status.state === 'judging' ? [status.claimant] : [] },
    },
    available: inSafe.toString(),
  };
}

// The season's days, UTC: round 1 opened at 10:24 on 10 Nov and held; round 2 opens on schedule at 18:00.
const R1_OPEN = Date.UTC(2026, 10, 10, 10, 24, 11);
const R2_OPEN = Date.UTC(2026, 10, 10, 18, 0, 24);
const NEXT = Date.UTC(2026, 10, 11, 18, 0, 0);

const R1 = [
  { at: 5.2, do: 'seal', who: ORACLE },
  { at: 9.6, do: 'seal', who: NOVA },
  { at: 17.3, do: 'seal', who: ONYX },
  { at: 47.4, do: 'move', who: ORACLE, method: 'set_owner', args: { new_owner: ORACLE }, ok: false },
  { at: 52.9, do: 'move', who: NOVA, method: 'pause' },
  { at: 58.1, do: 'move', who: ONYX, method: 'sweep', args: { to: ONYX }, ok: false },
  { at: 247, do: 'collect' },
];

/** Round 2 up to the reveals; the two endings follow. */
const R2 = [
  { at: 6.4, do: 'seal', who: ONYX },
  { at: 13.8, do: 'seal', who: NOVA },
  { at: 33.5, do: 'seal', who: ORACLE },
  { at: 46.2, do: 'move', who: ONYX, method: 'set_owner', args: { new_owner: ONYX }, ok: false },
  { at: 47.9, do: 'move', who: ONYX, method: 'pause' },
  { at: 50.6, do: 'move', who: ONYX, method: 'sweep', args: { to: ONYX }, ok: false },
  { at: 52.3, do: 'reveal', who: ONYX },
  { at: 54.1, do: 'move', who: NOVA, method: 'request_exit' },
  { at: 55.7, do: 'move', who: NOVA, method: 'check_exit' },
  { at: 56.4, do: 'reveal', who: NOVA },
  { at: 58.8, do: 'move', who: ORACLE, method: 'book' },
  { at: 60.2, do: 'move', who: ORACLE, method: 'set_owner', args: { new_owner: ORACLE } },
];
const R2_BROKEN = [...R2, { at: 61.4, do: 'drain', who: ORACLE }, { at: 62.1, do: 'reveal', who: ORACLE }, { at: 62.6, do: 'claim', who: ORACLE }, { at: 64.9, do: 'paid' }];
const R2_HELD = [...R2.slice(0, -1), { at: 61.0, do: 'move', who: ORACLE, method: 'sweep', args: { to: ORACLE }, ok: false }, { at: 63.3, do: 'reveal', who: ORACLE }, { at: 246, do: 'collect' }];

/**
 * Every state of the round the arena shows, in the order a round passes them. `now` is the moment the scene is read
 * at: the site's reader and the browser's clock both stand there.
 */
export const SCENES = [
  { name: '1-sealing', title: 'The round is open, the masks seal their plans', now: R2_OPEN + 31 * MIN, course: R2 },
  { name: '2-playing', title: 'The window closed, a mask plays its plan', now: R2_OPEN + 51 * MIN, course: R2 },
  { name: '3-reveal', title: 'The masks reveal their plans', now: R2_OPEN + 57 * MIN, course: R2 },
  { name: '4-claim', title: 'A mask drained the safe, the judge is on its claim', now: R2_OPEN + 63.5 * MIN, course: R2_BROKEN },
  { name: '5-paid', title: 'The drain is confirmed and paid', now: R2_OPEN + 68 * MIN, course: R2_BROKEN },
  { name: '6-held', title: 'Nobody broke it: the vault held, the NEAR goes back', now: R2_OPEN + 251 * MIN, course: R2_HELD },
  { name: '7-between', title: 'Between rounds: the last break, the next round on the clock', now: Date.UTC(2026, 10, 11, 9, 12, 40), course: R2_BROKEN },
];

/** The scripted chain at `now`: what RPC and the indexer answer for the season's accounts. */
function chain(scene) {
  const rounds = [round({ n: 1, id: 's1-0001-d74851', openedAt: R1_OPEN, course: R1, now: scene.now }), round({ n: 2, id: 's1-0002-7c41e9', openedAt: R2_OPEN, course: scene.course, now: scene.now })];
  const byId = new Map(rounds.map((r) => [r.id, r]));
  const bySafe = new Map(rounds.map((r) => [r.safe, r]));
  const txs = rounds.flatMap((r) => r.txs);
  const view = (account, method, args) => {
    if (account === SEASON) {
      if (method === 'season') return { name: 's1', bounty: BOUNTY };
      if (method === 'latest') return [...rounds].reverse().map((r) => ({ id: r.id, safe: r.safe, challenge: 'live-safe' }));
      if (method === 'next') {
        return { at_ns: ns(NEXT), n: 3, challenge: 'live-safe', code_hash: SAFE_CODE, prize: LOCKED.toString(), safe_fund: SAFE_FUND.toString(), min_loot: MIN_LOOT.toString(), masks: MASKS, hours: 4, commit_minutes: 45, funded: true };
      }
    }
    if (account === BOUNTY) {
      if (method === 'judge') return { outlayer: OUTLAYER, project: `${TEAM}/judge`, version: JUDGE };
      const r = byId.get(args?.id);
      if (method === 'get' || method === 'get_safe' || method === 'get_round') return r ? r.views[method] : null;
    }
    if (bySafe.has(account) && method === 'available') return bySafe.get(account).available;
    return undefined;
  };
  return { txs, view, owns: (account) => account === SEASON || account === BOUNTY || bySafe.has(account) };
}

const actionsOf = (call, transfer = 0n) => [
  ...(call ? [{ FunctionCall: { method_name: call.method, args: b64(call.args), gas: 100000000000000, deposit: call.deposit.toString() } }] : []),
  ...(transfer > 0n ? [{ Transfer: { deposit: transfer.toString() } }] : []),
];

/** A transaction as the indexer's /v0/transactions gives it: only the fields the arena reads. */
function rawTx(t) {
  const first = hashOf(`${t.hash} receipt`);
  const own = { receipt: { receipt_id: first, predecessor_id: t.signer, receiver_id: t.receiver, receipt: { Action: { actions: actionsOf(t.call) } } }, execution_outcome: { id: first, block_timestamp: Number(ns(t.at)), outcome: { logs: [], status: t.ok ? { SuccessValue: '' } : { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked' } } } } } } } };
  const rest = t.receipts.map((r, i) => {
    const id = hashOf(`${t.hash} receipt ${i}`);
    return {
      receipt: { receipt_id: id, predecessor_id: r.from, receiver_id: r.to, receipt: { Action: { actions: actionsOf(r.call, r.transfer) } } },
      execution_outcome: { id, block_timestamp: Number(ns(r.at)), outcome: { logs: [], status: r.ok ? { SuccessValue: '' } : { Failure: {} } } },
    };
  });
  return {
    transaction: { hash: t.hash, signer_id: t.signer, receiver_id: t.receiver, actions: actionsOf(t.call) },
    execution_outcome: { block_timestamp: Number(ns(t.at)), block_height: heightOf(t.at), outcome: { status: { SuccessReceiptId: first } } },
    receipts: [own, ...rest],
  };
}

/** A block a second, counted from the base recording's own height. */
const heightOf = (at) => 276_700_000 + Math.round((at - Date.UTC(2026, 10, 8)) / 1000);

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** A fetch that answers for the season from the scripted chain and for everything else from the base recording. */
function scriptedFetch(scene, base) {
  const world = chain(scene);
  const older = replayFetch(base);
  return async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    if (url.endsWith('/v0/account') && world.owns(body.account_id)) {
      const a = body.account_id;
      const rows = world.txs
        .filter((t) => t.signer === a || t.receiver === a || t.receipts.some((r) => r.from === a || r.to === a))
        .map((t) => ({
          account_id: a,
          transaction_hash: t.hash,
          tx_block_height: heightOf(t.at),
          tx_block_timestamp: ns(t.at),
          is_function_call: t.receiver === a || t.receipts.some((r) => r.to === a && r.call !== null),
        }))
        .filter((r) => body.max_block_height == null || r.tx_block_height <= body.max_block_height)
        .sort((x, y) => y.tx_block_height - x.tx_block_height);
      return json({ account_txs: rows, txs_count: rows.length });
    }
    if (url.endsWith('/v0/transactions')) {
      const mine = (body.tx_hashes ?? []).map((h) => world.txs.find((t) => t.hash === h)).filter(Boolean);
      if (mine.length) return json({ transactions: mine.map(rawTx) });
    }
    const p = body.params;
    if (body.method === 'query' && p && world.owns(p.account_id)) {
      const block = { block_hash: hashOf(`block ${scene.now}`), block_height: heightOf(scene.now) };
      if (p.request_type === 'view_account') {
        return json({ jsonrpc: '2.0', id: body.id, result: { amount: (await world.view(p.account_id, 'available')) ?? NEAR.toString(), code_hash: SAFE_CODE, locked: '0', storage_paid_at: 0, storage_usage: 108138, ...block } });
      }
      if (p.request_type === 'call_function') {
        const answer = world.view(p.account_id, p.method_name, JSON.parse(Buffer.from(p.args_base64, 'base64').toString('utf8')));
        if (answer === undefined) return json({ jsonrpc: '2.0', id: body.id, result: { ...block, error: 'wasm execution failed with error: MethodResolveError(MethodNotFound)', logs: [] } });
        return json({ jsonrpc: '2.0', id: body.id, result: { ...block, logs: [], result: [...Buffer.from(JSON.stringify(answer))] } });
      }
    }
    return older(input, init);
  };
}

/** The recording of one scene, and the arena as the site will read it from that recording. */
export async function record(scene) {
  const base = JSON.parse(readFileSync(BASE, 'utf8'));
  const rec = recordFetch(scriptedFetch(scene, base));
  const arena = new Arena({ rpc: new ChainReader({ endpoints: RPCS, fetch: rec.fetch }), indexer: new Indexer({ fetch: rec.fetch }), now: () => scene.now });
  const view = await arena.view();
  return { recording: { recordedAt: scene.now, exchanges: rec.exchanges }, view };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ?? join(tmpdir(), 'maskwars-season');
  mkdirSync(out, { recursive: true });
  for (const scene of SCENES) {
    const { recording, view } = await record(scene);
    writeFileSync(join(out, `${scene.name}.json`), `${JSON.stringify(recording)}\n`);
    const r = view.now;
    console.log(
      `${scene.name.padEnd(10)} ${new Date(scene.now).toISOString().slice(0, 16)} now ${r?.id} ${r?.phase} ${r?.state} live ${r?.live} winner ${r?.winner?.name ?? '–'} events ${r?.events.length} next ${view.next ? new Date(view.next.at).toISOString().slice(0, 16) : '–'} races ${view.races.length}`,
    );
  }
}
