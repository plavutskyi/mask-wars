// "Post a job" on mainnet, walked end to end through real eyes with no real wallet and no real chain. The built site
// (`MASKWARS_NETWORK=mainnet NEXT_PUBLIC_JOBS_TEST=1 next build` first) runs against a stand-in of mainnet served here:
// jobs.maskwars.near as it stands after its deployment (no job, drains on bounty.maskwars.near, 5% fee), the house's
// vault and its round, and the public indexer. The site reads it with its own readers, exactly as it reads mainnet.
// In the browser the test hook of NEXT_PUBLIC_JOBS_TEST stands in for the person's wallet: it hands the `open` the
// sheet built to this chain, which opens the job by the contract's own rules and answers with a transaction hash.
//
//   open    the round of the day seals for 41 more minutes: the sheet, its details, the wallet signing, the job on
//           chain, the board with the job, the job's page, and the client taking it back there.
//   closed  no round on chain (the walk runs outside 18:04 to 18:24 UTC): the sheet says when the next window opens,
//           and its button asks no wallet.
//   booked  the round of the day, with two jobs from outside on it already: the arena's masks take two a round, so
//           the sheet says they are booked and its button asks no wallet.
//
// Every screen is checked on desk 1440×900, phone 375×812 and small phone 360×740 (pictures kept) and 360×640 (checked
// only): nothing wider than the screen, nothing cut, every target 40 px or more, a clean console. Pictures and
// report.json go to apps/web/shots/jobs-post/.
//
//   node apps/web/scripts/jobs-post-walk.mjs
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..');
const require = createRequire(join(web, 'package.json'));
const { chromium } = createRequire(join(web, '..', '..', 'packages', 'media', 'package.json'))('playwright');
const NEXT = require.resolve('next/dist/bin/next');
const OUT = join(web, 'shots', 'jobs-post');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- mainnet, as this walk needs it --------------------------------------------------------------------------------

const JOBS = 'jobs.maskwars.near';
const CREWS = 'crews.maskwars.near';
const BOUNTY = 'bounty.maskwars.near';
const VAULT = 'vault.house.maskwars.near';
const HOUSE = 'house.maskwars.near';
const ROUND = 'race-0004';
const BYTE = 10n ** 19n;
const MILLI = 10n ** 21n;
const NS = (ms) => `${BigInt(ms) * 1_000_000n}`;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const txHash = () => Array.from(crypto.getRandomValues(new Uint8Array(44)), (b) => B58[b % 58]).join('');

/** The jobs contract's settings on mainnet after its deployment (scripts/mainnet/jobs.mjs, `initArgs`). */
const SETTINGS = {
  admin: 'maskwars.near', meter: 'maskwars.near', treasury: 'maskwars.near', outlayer: 'outlayer.near', crews: CREWS,
  judges: [], bounties: [BOUNTY], factories: [], fee_bps: 500, fee_to: 'maskwars.near', pending: null,
  judge_fee: (10n * MILLI).toString(), appeal_bond: (200n * MILLI).toString(), max_slots: 16, max_steps: 4,
};

// The stand-in round opened four minutes before the walk and seals 45 minutes after it opened, as the house's round
// does from its slot. The site's clock (the runs that reveal a job's steps) is counted from that minute: the site is told
// it in JOBS_CLOCK_FIRST_MINUTE, which only the walk's build reads.
const SLOT = Math.floor(Date.now() / 60_000) * 60_000 - 4 * 60_000;
const SEAL_UNTIL = SLOT + 45 * 60_000;

/** One stand-in chain: `open` has the round of the day sealing, `closed` has none. */
function chainOf(mode) {
  const start = Date.now();
  return { mode, start, sealUntil: SEAL_UNTIL, jobs: [], txs: [], height: 180_000_000 };
}

/** What `open` would do on the contract: its own checks of a drain, the deposit by `quote`, the job's record. */
function open(c, signer, receiverId, action) {
  const a = action?.params?.args ?? {};
  const deposit = BigInt(action?.params?.deposit ?? '0');
  const fail = (why) => ({ error: why });
  if (receiverId !== JOBS || action?.params?.methodName !== 'open') return fail('not an open on the jobs contract');
  if (!/^[a-z0-9_-]{1,64}$/.test(a.id ?? '') || c.jobs.some((j) => j.id === a.id)) return fail('id: taken or not an id');
  if (a.kind !== 'drain' || a.round?.bounty !== BOUNTY || !/^[a-z0-9_-]{1,64}$/.test(a.round?.id ?? '')) return fail('a drain on the bounty contract this contract follows');
  const bytes = Buffer.byteLength(a.brief ?? '', 'utf8');
  if (bytes < 1 || bytes > 280 || !/^[0-9a-f]{64}$/.test(a.spec ?? '')) return fail('brief and spec');
  const reward = BigInt(a.reward);
  const fuel = BigInt(a.fuel_per_mask) * BigInt(a.slots);
  if (reward < 100n * MILLI || fuel > reward || a.slots < 1 || a.slots > 16) return fail('reward, fuel and slots');
  if (a.work_minutes < 5 || a.reveal_minutes < 5 || a.appeal_minutes < 10) return fail('windows');
  const total = reward + fuel + 8n * 10n * MILLI + BYTE * (BigInt(a.slots) * 7600n + 1200n) + BYTE * 4400n;
  if (deposit < total) return fail(`this job takes ${total} yoctoNEAR: see quote`);
  const now = Date.now();
  const work = now + a.work_minutes * 60_000;
  const reveal = work + a.reveal_minutes * 60_000;
  const job = {
    id: a.id,
    client: signer,
    terms: {
      kind: 'drain', brief: a.brief, spec: a.spec, rubric: null, judge: null, round: a.round, secrets: null, bar: null,
      reward: a.reward, fee_bps: SETTINGS.fee_bps, fee_to: SETTINGS.fee_to, fuel_per_mask: a.fuel_per_mask, slots: a.slots,
      bond: a.bond ?? a.fuel_per_mask, client_key: null, open_to: a.open_to, meter: SETTINGS.meter, treasury: SETTINGS.treasury,
      outlayer: SETTINGS.outlayer, crews: CREWS, opened_ns: NS(now), work_until: NS(work), reveal_until: NS(reveal),
      judge_until: NS(Math.max(reveal + 12 * 3_600_000, now + 37 * 3_600_000)), appeal_minutes: a.appeal_minutes,
    },
    status: { state: 'open' }, masks: 0, entrants: 0, steps: 0, runs: 0, verdict: null, prior: null, appeal: null,
    checked: true, left: 0, retry_at: '0', phase: 'enlisting',
  };
  c.jobs.push(job);
  return record(c, signer, 'open', a, deposit.toString(), [{ event: 'open', data: { id: job.id, client: signer } }]);
}

/** A transaction the stand-in chain took, as the indexer will show it: its call and the events its receipt logged. */
function record(c, signer, method, args, deposit, events) {
  const now = Date.now();
  const hash = txHash();
  c.txs.push({ hash, signer, at: now, height: c.height + Math.floor((now - c.start) / 1000), method, args, deposit, events });
  return { hash };
}

/** What `cancel` would do: only the client, only while no mask sealed a step; everything back but the record's storage. */
function cancel(c, signer, a) {
  const job = c.jobs.find((j) => j.id === a.id);
  if (!job) return { error: 'no such job' };
  if (signer !== job.client) return { error: 'only the client cancels its job' };
  if (job.status.state !== 'open' || job.steps !== 0) return { error: 'a mask has sealed a step: the job runs to its end' };
  const t = job.terms;
  const locked = BigInt(t.reward) + BigInt(t.fuel_per_mask) * BigInt(t.slots) + 8n * 10n * MILLI + BYTE * (BigInt(t.slots) * 7600n + 1200n);
  job.phase = 'cancelled';
  job.status = { state: 'cancelled' };
  // The record stays on chain: the 9 790 bytes jobs.mjs measured for a job of the same shape (`KEPT.job`).
  const back = (locked - 9_790n * 10n ** 18n).toString();
  return record(c, signer, 'cancel', a, '0', [
    { event: 'settle', data: { id: job.id, status: { state: 'cancelled' }, payouts: [], fee: '0', fuel: [], bonds: [], forfeit: '0', back } },
    { event: 'cancel', data: { id: job.id } },
  ]);
}

/** One signed call of the stand-in wallet: `open` or `cancel` on the jobs contract. */
function send(c, signer, receiverId, action) {
  if (receiverId !== JOBS) return { error: 'not the jobs contract' };
  if (action?.params?.methodName === 'cancel') return cancel(c, signer, action.params.args ?? {});
  return open(c, signer, receiverId, action);
}

function rpc(c, body) {
  const now = Date.now();
  const height = c.height + Math.floor((now - c.start) / 1000);
  const ok = (result) => ({ jsonrpc: '2.0', id: body.id, result });
  const err = (name, data) => ({ jsonrpc: '2.0', id: body.id, error: { name: 'HANDLER_ERROR', cause: { name, info: {} }, code: -32000, message: 'Server error', data } });
  if (body.method === 'block') return ok({ header: { height, hash: 'MockMainnetBlockAAAAAAAAAAAAAAAAAAAAAAAAAAAA', timestamp_nanosec: NS(now) } });
  const p = body.params ?? {};
  if (p.request_type === 'view_account') {
    if (p.account_id === JOBS || p.account_id === CREWS) {
      return ok({ amount: '5800000000000000000000000', locked: '0', code_hash: '3uGyF1PvMockJobsCodeAAAAAAAAAAAAAAAAAAAAAAA', storage_usage: 570_000, storage_paid_at: 0, block_height: height, block_hash: 'h' });
    }
    return err('UNKNOWN_ACCOUNT', `account ${p.account_id} does not exist while viewing`);
  }
  if (p.request_type !== 'call_function') return err('UNKNOWN', 'not served here');
  const view = (v) => ok({ result: [...Buffer.from(JSON.stringify(v))], logs: [], block_height: height, block_hash: 'h' });
  const args = p.args_base64 ? JSON.parse(Buffer.from(p.args_base64, 'base64').toString('utf8') || '{}') : {};
  switch (`${p.account_id}.${p.method_name}`) {
    case `${JOBS}.config`:
      return view({ ...SETTINGS, jobs: c.jobs.length, live: c.jobs.length });
    case `${CREWS}.config`:
      return view({ admin: 'maskwars.near', factories: [], crews: 1, pending: null });
    case `${JOBS}.list`:
      return view(c.jobs.slice(args.from_index ?? 0, (args.from_index ?? 0) + (args.limit ?? 50)));
    case `${JOBS}.entrants`:
    case `${JOBS}.fuel`:
      return view([]);
    case `${VAULT}.get_round`:
      return c.mode !== 'closed' ? view({ arbiter: BOUNTY, bounty: ROUND }) : err('UNKNOWN_ACCOUNT', `account ${VAULT} does not exist while viewing`);
    case `${BOUNTY}.get`:
      return view({ owner: HOUSE, amount: '200000000000000000000000', target: VAULT, deadline_ns: NS(c.start + 4 * 3_600_000), status: { state: 'open' } });
    case `${BOUNTY}.get_round`:
      return view({ commit_until: NS(c.sealUntil), reveal_until: NS(c.sealUntil + 3_600_000), deadline_ns: NS(c.start + 4 * 3_600_000), seals: [] });
    default:
      return err('CONTRACT_EXECUTION_ERROR', `wasm execution failed with error: MethodNotFound (${p.account_id}.${p.method_name})`);
  }
}

/** The indexer's answers: the jobs contract's transactions, each `open` with its event, as the contract logs it. */
function indexer(c, path, body) {
  if (path === '/v0/account') {
    const mine = body.account_id === JOBS ? [...c.txs].reverse() : [];
    return { account_txs: mine.map((t) => ({ transaction_hash: t.hash, tx_block_height: t.height, tx_block_timestamp: NS(t.at), is_function_call: true, is_success: true })), txs_count: mine.length };
  }
  const asked = new Set(body.tx_hashes ?? []);
  return {
    transactions: c.txs
      .filter((t) => asked.has(t.hash))
      .map((t) => {
        const actions = [{ FunctionCall: { method_name: t.method, args: Buffer.from(JSON.stringify(t.args)).toString('base64'), gas: 100_000_000_000_000, deposit: t.deposit } }];
        const rid = `R${t.hash.slice(1)}`;
        const logs = t.events.map((e) => `EVENT_JSON:${JSON.stringify({ standard: 'maskwars_jobs', version: '1.0.0', ...e })}`);
        return {
          transaction: { hash: t.hash, signer_id: t.signer, receiver_id: JOBS, actions },
          execution_outcome: { block_timestamp: NS(t.at), block_height: t.height, outcome: { status: { SuccessReceiptId: rid } } },
          receipts: [
            {
              receipt: { receipt_id: rid, predecessor_id: t.signer, receiver_id: JOBS, receipt: { Action: { actions } } },
              execution_outcome: { id: rid, block_timestamp: NS(t.at), outcome: { logs, status: { SuccessValue: '' } } },
            },
          ],
        };
      }),
  };
}

/** Two people's jobs on the round already, as /jobs opens them: the arena's masks take two a round. */
function seeded(c) {
  for (const [i, client] of ['ivy.near', 'erin.near'].entries()) {
    const args = {
      id: `${ROUND}-seed0${i}`, kind: 'drain', brief: 'Drain the house vault.', spec: 'a'.repeat(64), round: { bounty: BOUNTY, id: ROUND },
      reward: '1000000000000000000000000', fuel_per_mask: '50000000000000000000000', slots: 4, open_to: { who: 'anyone' },
      work_minutes: 36, reveal_minutes: 30, appeal_minutes: 10,
    };
    open(c, client, JOBS, { params: { methodName: 'open', deposit: (2n * 10n ** 24n).toString(), args } });
  }
  return c;
}
const chains = { open: chainOf('open'), closed: chainOf('closed'), booked: seeded(chainOf('booked')) };
const CHAIN_PORT = 3190;
const mock = createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'content-type': 'application/json' };
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const [, name, ...rest] = (req.url ?? '/').split('/');
    const c = chains[name];
    const path = `/${rest.join('/')}`;
    const body = raw ? JSON.parse(raw) : {};
    let answer;
    if (!c) answer = { error: 'no such chain' };
    else if (path === '/__send') answer = send(c, body.signer, body.receiverId, body.action);
    else if (path === '/__reset') answer = ((c.jobs = []), (c.txs = []), (c.start = Date.now()), (c.sealUntil = SEAL_UNTIL), { reset: true });
    else if (path.startsWith('/v0/')) answer = indexer(c, path, body);
    else answer = rpc(c, body);
    res.writeHead(200, cors).end(JSON.stringify(answer));
  });
});
await new Promise((r) => mock.listen(CHAIN_PORT, r));

// ---- the site ------------------------------------------------------------------------------------------------------

const servers = [];
function stop() {
  for (const s of servers.splice(0)) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(s.pid), '/T', '/F'], { stdio: 'ignore' });
    else s.kill();
  }
  mock.close();
}
process.on('exit', stop);

async function start(port, chain) {
  const at = `http://localhost:${CHAIN_PORT}/${chain}`;
  const env = { ...process.env, MASKWARS_NETWORK: 'mainnet', MASKWARS_RPC: at, MASKWARS_INDEXER: at, JOBS_FIXTURE: '', JOBS_ROUND_FIXTURE: '', JOBS_CLOCK_FIRST_MINUTE: String(Math.floor((SLOT % 86_400_000) / 60_000)) };
  const server = spawn(process.execPath, [NEXT, 'start', '-p', String(port)], { cwd: web, stdio: 'ignore', env });
  servers.push(server);
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/api/jobs-round`)).ok) return base;
    } catch {
      /* not yet */
    }
    await wait(500);
  }
  throw new Error(`next start on ${port} did not come up`);
}

const OPEN = await start(3141, 'open');
const CLOSED = await start(3142, 'closed');
const BOOKED = await start(3143, 'booked');

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) if (/\.(jpg|json)$/.test(f)) rmSync(join(OUT, f));

const VIEWS = {
  desk: { keep: true, context: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 } },
  phone: { keep: true, context: { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
  small: { keep: true, context: { viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
  tiny: { keep: false, context: { viewport: { width: 360, height: 640 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true } },
};

/** The stand-in wallet: it takes a second and a half to "approve", then sends the call to the stand-in chain. */
const signerScript = (chain) => `
  window.__signed = [];
  window.__jobsSigner = {
    accountId: 'alice.near',
    async call(receiverId, action) {
      window.__signed.push({ receiverId, action });
      await new Promise((r) => setTimeout(r, 1500));
      const res = await fetch('http://localhost:${CHAIN_PORT}/${chain}/__send', { method: 'POST', body: JSON.stringify({ signer: 'alice.near', receiverId, action }) });
      const out = await res.json();
      if (out.error) throw new Error(out.error);
      return out.hash;
    },
  };`;

/** What is wrong on the screen now: anything wider than it, text cut, a target under 40 px, a sheet off its edge. */
async function inspect(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[role="dialog"]') ?? document.querySelector('main');
    const all = [...root.querySelectorAll('*')];
    const wide = all
      .filter((e) => {
        const r = e.getBoundingClientRect();
        if (r.width === 0) return false;
        for (let p = e.parentElement; p && p !== root.parentElement; p = p.parentElement) {
          const o = getComputedStyle(p).overflowX;
          if ((o === 'hidden' || o === 'clip' || o === 'auto') && p.getBoundingClientRect().right <= innerWidth + 1) return false;
        }
        return r.right > innerWidth + 1 || r.left < -1;
      })
      .map((e) => String(e.className || e.tagName).slice(0, 40));
    const cut = all
      .filter((e) => {
        if (e.children.length !== 0 || !(e.textContent || '').trim()) return false;
        const st = getComputedStyle(e);
        return (e.scrollWidth > e.clientWidth + 1 && st.textOverflow === 'ellipsis') || (st.webkitLineClamp !== 'none' && e.scrollHeight > e.clientHeight + 1);
      })
      .map((e) => (e.textContent || '').trim().slice(0, 40))
      // A line in a field shows whole: the sheet's own words never run past its edge.
      .concat([...root.querySelectorAll('input, textarea')].filter((i) => i.scrollWidth > i.clientWidth + 1 || i.scrollHeight > i.clientHeight + 1).map((i) => `field: ${i.value.slice(0, 40)}`));
    const small = [...root.querySelectorAll('a, button, input, summary')]
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && (r.height < 40 || r.width < 40);
      })
      .map((e) => `${(e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 24)} ${Math.round(e.getBoundingClientRect().width)}×${Math.round(e.getBoundingClientRect().height)}`);
    const sheet = document.querySelector('[role="dialog"]');
    const off = [];
    if (sheet) {
      const r = sheet.getBoundingClientRect();
      if (r.left < -1 || r.right > innerWidth + 1 || r.top < -1 || r.bottom > innerHeight + 1) off.push('the sheet is off the screen');
    }
    // Text that runs over the text beside it: two leaf boxes of the sheet that overlap where they show, each clipped
    // by the boxes that scroll or clip it (a long call scrolls inside its own box, under nothing).
    const shown = (e) => {
      let r = e.getBoundingClientRect();
      r = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
        if (getComputedStyle(p).overflow === 'visible') continue;
        const c = p.getBoundingClientRect();
        r = { left: Math.max(r.left, c.left), right: Math.min(r.right, c.right), top: Math.max(r.top, c.top), bottom: Math.min(r.bottom, c.bottom) };
      }
      return r.right - r.left > 1 && r.bottom - r.top > 1 ? r : null;
    };
    const leaves = (sheet ? [...sheet.querySelectorAll('*')] : [])
      .filter((e) => e.children.length === 0 && (e.textContent || '').trim() && e.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true }))
      .map((e) => ({ e, r: shown(e) }))
      .filter((x) => x.r);
    const overlap = [];
    for (let i = 0; i < leaves.length; i++) {
      for (let j = i + 1; j < leaves.length; j++) {
        const [x, y] = [leaves[i], leaves[j]];
        if (x.e.contains(y.e) || y.e.contains(x.e)) continue;
        const [a, b] = [x.r, y.r];
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlap.push(`${x.e.textContent.trim().slice(0, 20)} / ${y.e.textContent.trim().slice(0, 20)}`);
      }
    }
    return { scroll: document.documentElement.scrollWidth - innerWidth, wide, cut, small, off, overlap };
  });
}

const report = [];
const browser = await chromium.launch();
for (const [view, { keep, context }] of Object.entries(VIEWS)) {
  await fetch(`http://localhost:${CHAIN_PORT}/open/__reset`, { method: 'POST' });
  for (const [base, chain] of [
    [OPEN, 'open'],
    [CLOSED, 'closed'],
    [BOOKED, 'booked'],
  ]) {
    const ctx = await browser.newContext(context);
    await ctx.addInitScript(signerScript(chain));
    const page = await ctx.newPage();
    const problems = [];
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(m.text().slice(0, 200));
    });
    page.on('pageerror', (e) => problems.push(String(e).slice(0, 200)));
    page.on('response', (r) => {
      if (r.status() >= 400) problems.push(`${r.status()} ${r.url()}`);
    });
    const check = async (name, shot = true) => {
      const found = await inspect(page);
      report.push({ view, name, ...found, problems: [...problems] });
      const bad = found.scroll > 0 || found.wide.length || found.cut.length || found.small.length || found.off.length || found.overlap.length || problems.length;
      console.log(`${view.padEnd(5)} ${name.padEnd(22)} ${bad ? `PROBLEMS ${JSON.stringify({ ...found, problems })}` : 'clean'}`);
      problems.length = 0;
      if (keep && shot) await page.screenshot({ path: join(OUT, `${name}-${view}.jpg`), type: 'jpeg', quality: 82 });
    };
    const sheetButton = (text) => page.locator('[role="dialog"] button, [role="dialog"] a').filter({ hasText: text }).first();

    await page.goto(`${base}/jobs`, { waitUntil: 'load' });
    await wait(1800);
    if (chain === 'open') {
      await check('1-board-empty');
      await page.locator('main button', { hasText: /^Post a job$/ }).first().click();
      await wait(900);
      await check('2-post-open');
      // The details: what the deposit is made of, the job's terms, the call for an agent.
      await page.locator('[role="dialog"] summary').click();
      await wait(300);
      await page.evaluate(() => document.querySelector('[role="dialog"] summary')?.scrollIntoView({ block: 'start' }));
      await wait(200);
      await check('3-post-details');
      await page.locator('[role="dialog"] summary').click();
      await page.evaluate(() => document.querySelector('[role="dialog"]')?.scrollTo(0, 0));
      // The person's own line and reward.
      const sheet = page.locator('[role="dialog"]');
      await sheet.getByLabel('The job', { exact: true }).fill('Drain the vault before ORACLE does.');
      await sheet.getByLabel('Reward', { exact: true }).fill('2');
      await wait(200);
      await check('4-post-typed');
      await sheetButton(/^Post with NEAR wallet$/).click();
      await wait(700);
      await check('5-post-signing');
      try {
        await page.locator('[role="dialog"]', { hasText: 'Your job is live' }).waitFor({ timeout: 30_000 });
      } catch (error) {
        console.error(`the job did not land: ${await page.locator('[role="dialog"]').textContent()}`);
        console.error(`the chain holds ${chains.open.jobs.length} jobs, ${JSON.stringify(await page.evaluate(() => window.__signed.length))} signed; ${problems.join(' | ')}`);
        throw error;
      }
      await wait(400);
      await check('6-post-done');
      const signed = await page.evaluate(() => window.__signed);
      const args = signed[0]?.action?.params?.args ?? {};
      report.push({ view, name: 'signed', signed: signed.length, receiver: signed[0]?.receiverId, deposit: signed[0]?.action?.params?.deposit, args });
      if (signed.length !== 1 || signed[0].receiverId !== JOBS || args.round?.id !== ROUND || args.reward !== '2000000000000000000000000') {
        console.log(`${view} signed PROBLEM ${JSON.stringify(signed)}`);
        report.at(-1).problems = ['the wallet did not get the one expected call'];
      }
      // Closed: the board behind the sheet reads the chain again and holds the job.
      await page.keyboard.press('Escape');
      try {
        await page.locator('main', { hasText: args.id }).waitFor({ timeout: 15_000 });
      } catch {
        problems.push(`the board does not show ${args.id} after the sheet closed`);
      }
      await wait(600);
      await page.evaluate(() => window.scrollTo(0, 0));
      await check('7-board-posted');
      if (keep) await page.screenshot({ path: join(OUT, `7-board-posted-full-${view}.jpg`), type: 'jpeg', quality: 82, fullPage: true });
      await page.goto(`${base}/jobs/${encodeURIComponent(args.id)}`, { waitUntil: 'load' });
      await wait(1500);
      await check('8-job-page');
      if (keep) await page.screenshot({ path: join(OUT, `8-job-page-full-${view}.jpg`), type: 'jpeg', quality: 82, fullPage: true });
      // The client takes it back from its page: one `cancel`, and the page reads the job as taken back.
      await page.locator('main button', { hasText: /^Take it back$/ }).click();
      try {
        await page.locator('main h1', { hasText: /Taken back/i }).waitFor({ timeout: 20_000 });
      } catch {
        problems.push('the job page does not read the job as taken back');
      }
      await wait(600);
      // This page's own wallet calls (the board's `open` was checked there): one `cancel` of this job, no NEAR attached.
      const calls = await page.evaluate(() => window.__signed.map((x) => `${x.action.params.methodName}:${x.action.params.args.id}:${x.action.params.deposit}`));
      if (calls.join() !== `cancel:${args.id}:0`) problems.push(`the wallet signed ${calls.join() || 'nothing'}, not one cancel of ${args.id}`);
      await check('10-job-taken-back');
    } else {
      await page.locator('main button', { hasText: /^Post a job$/ }).first().click();
      await wait(900);
      await check(chain === 'booked' ? '11-post-booked' : '9-post-closed');
      // The button says when the next window opens and asks no wallet, pressed or by Enter in the form.
      const go = sheetButton(chain === 'booked' ? /^Booked till \d\d:\d\d UTC$/ : /^Opens at \d\d:\d\d UTC$/);
      const label = (await go.textContent())?.trim();
      await go.click({ force: true });
      await page.locator('[role="dialog"]').getByLabel('Reward', { exact: true }).press('Enter');
      await wait(800);
      const signed = await page.evaluate(() => window.__signed.length);
      const status = await page.locator('[role="dialog"] [data-post-status]').first().textContent();
      report.push({ view, name: chain, label, status, signed, problems: signed ? [`a wallet was asked on a ${chain} round`] : [] });
      console.log(`${view.padEnd(5)} ${chain.padEnd(22)} ${label} · ${status} · wallet asked ${signed} times`);
    }
    await ctx.close();
  }
}
await browser.close();
writeFileSync(join(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
stop();
const bad = report.filter((r) => r.scroll > 0 || r.wide?.length || r.cut?.length || r.small?.length || r.off?.length || r.overlap?.length || r.problems?.length);
if (bad.length) {
  console.error(JSON.stringify(bad, null, 2));
  process.exit(1);
}
console.log(`${report.length} checks on ${Object.keys(VIEWS).length} screens: nothing wider than the screen, nothing cut or overlapping, every target 40 px or more, a clean console; one wallet call in the window, none outside it.`);
