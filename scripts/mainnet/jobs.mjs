// The jobs market on mainnet: what the owner signs, in order, and what it costs. This script signs nothing and holds no
// key. It reads the chain, puts the code next to near.exe and prints every command with its exact NEAR.
//
// The code is the code the testnet market already runs: the script reads it from jobs.tinygif8324.testnet and
// crews.tinygif8324.testnet (view_code) and keeps it only if its sha256 is the one contracts/jobs/build.sh gives from
// this repository. So mainnet gets byte for byte the contracts that paid a crew of masks on testnet (README, "Jobs").
//
//   node scripts/mainnet/jobs.mjs              the deployment: checks, budget, commands
//   node scripts/mainnet/jobs.mjs --job        the first job, on today's round of the house: args file and commands
//   node scripts/mainnet/jobs.mjs --job --reward 0.5
//
// Node 22 with the network's proxy, if any: `node --use-env-proxy scripts/mainnet/jobs.mjs`.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAINNET = JSON.parse(readFileSync(join(ROOT, 'packages/network/mainnet.json'), 'utf8'));
const TESTNET = JSON.parse(readFileSync(join(ROOT, 'packages/network/testnet.json'), 'utf8'));
const ARGS = JSON.parse(readFileSync(join(ROOT, 'scripts/mainnet/jobs-args.json'), 'utf8'));
const SCRATCH = join(ROOT, '.scratch', 'near-mainnet');

/** sha256 of contracts/jobs/build.sh output: the bytes on jobs.tinygif8324.testnet and crews.tinygif8324.testnet. */
export const CODE = {
  jobs: { file: 'maskwars_jobs.wasm', sha256: '2b1ba205c3a74dfb9a3404834946e6c8a89294ff66fbabfed06494a32dbb9430', from: TESTNET.jobs },
  crews: { file: 'maskwars_crews.wasm', sha256: 'cb45c2fea71979f6c4087c622c51ee28d4a8008e563a6bc0ad4d6a2bf56e2e7d', from: TESTNET.crews },
};
/** NEAR's storage price: 10^19 yoctoNEAR a byte (1 NEAR per 100 kB). */
const BYTE = 10n ** 19n;
/** What a fresh contract's account holds beside its code: the account record and the state `new` writes. */
export const STATE_BYTES = 1_000n;
const NEAR = 10n ** 24n;

export const yocto = (near) => {
  const [w, f = ''] = String(near).split('.');
  if (!/^\d+$/.test(w) || !/^\d{0,24}$/.test(f)) throw new Error(`not an amount of NEAR: ${near}`);
  return BigInt(w) * NEAR + BigInt((f + '0'.repeat(24)).slice(0, 24));
};
export const near = (y) => {
  const v = BigInt(y);
  const f = (v % NEAR).toString().padStart(24, '0').replace(/0+$/, '');
  return f ? `${v / NEAR}.${f}` : `${v / NEAR}`;
};
/** Rounded up to 0.001 NEAR, for the lines a person reads. */
export const nearUp = (y) => near(((BigInt(y) + 10n ** 21n - 1n) / 10n ** 21n) * 10n ** 21n);

/**
 * The init calls of both contracts on mainnet: the same shape as scripts/testnet/jobs-deploy.ps1 writes. The admin is
 * also the meter and the treasury: the fuel of a counted step is paid to maskwars.near, which keeps it to pay the masks'
 * inference on NEAR AI Cloud. The mask factory goes in only once it is on chain (`sections.forge`): before that a job
 * "open to forged masks" would wait for masks nobody can have. Then the admin proposes `{"kind":"factories"}` on both
 * contracts, which applies after an hour.
 */
export function initArgs(net = MAINNET, args = ARGS) {
  if (args.fee_bps > 1000) throw new Error('jobs-args.json: the fee is at most 1000 basis points, 10%');
  const factories = net.sections.forge ? [net.factory] : [];
  return {
    jobs: {
      admin: net.admin, meter: net.admin, treasury: net.admin, outlayer: net.outlayer.contract, crews: net.crews,
      judges: args.judges, bounties: [net.bounty], factories, fee_bps: args.fee_bps, fee_to: net.admin,
    },
    crews: { admin: net.admin, factories },
  };
}

/** The methods of a mask's key on each contract: the same lists scripts/testnet/jobs-keys.ps1 grants. */
export const KEY_METHODS = {
  jobs: ['enlist', 'step', 'reveal', 'leave', 'judge', 'settle', 'close', 'unstick'],
  crews: ['join', 'leave', 'enlist'],
};

/**
 * The storage a function-call key takes on its account, as nearcore counts it: the public key (33 bytes), the access
 * key in borsh (nonce 8, permission 1, allowance 17, the contract, the methods) and 40 bytes for the record. Checked on
 * nova.maskwars.near, whose four keys and code give its 2 439 bytes exactly.
 */
export const keyBytes = (contract, methods) =>
  BigInt(33 + 8 + 1 + 17 + 4 + contract.length + 4 + methods.reduce((a, m) => a + 4 + m.length, 0) + 40);

/** Rounded up to 0.001 NEAR, in yoctoNEAR. */
const upMilli = (y) => ((BigInt(y) + 10n ** 21n - 1n) / 10n ** 21n) * 10n ** 21n;

/**
 * What maskwars.near sends each mask before its keys go on, so no mask dips into the 0.4 NEAR it keeps for a claim
 * (`round.mask_keep`): the storage of its two keys and the gas of the transaction that adds them; the captain also
 * the crew's record, which it pays when it forms the crew (it attaches 0.05 NEAR, the rest comes back at once).
 */
export function maskTopUps(net = MAINNET, captain = 'ORACLE') {
  const keys = keyBytes(net.jobs, KEY_METHODS.jobs) + keyBytes(net.crews, KEY_METHODS.crews);
  const each = upMilli(keys * BYTE + 10n ** 20n);
  return {
    keys,
    each,
    sends: Object.entries(net.masks).map(([name, account]) => ({ name, account, yocto: name === captain ? each + upMilli(KEPT.crew) : each })),
  };
}

/** What the account of a contract needs to hold: its code and its first state, at NEAR's storage price. */
export const storageOf = (codeBytes) => (BigInt(codeBytes) + STATE_BYTES) * BYTE;

/**
 * What stays on chain for good, measured on testnet with the same code (job crew-drain-0001, crew mw-trio, 11.11): a
 * crew's record and its three seats; a paid job's record and verdict; a bond's record, which goes to the client once the
 * job is paid. Everything else of the deposits comes back.
 */
export const KEPT = { crew: 7_810n * 10n ** 18n, job: 9_790n * 10n ** 18n };

/**
 * The budget of the market on mainnet, yoctoNEAR: everything maskwars.near pays. Both accounts (fund.jobs and
 * fund.crews of mainnet.json, each above its storage), the masks' storage for their keys and the arena's crew, and a
 * first job with its three bonds, by the contract's own `quote`. The crew's own deposit is ORACLE's, not in it: ORACLE
 * signs `form` and attaches 0.05 NEAR, and all but the crew's record comes back to it at once.
 */
export function budget({ jobsBytes, crewsBytes, quote, bond }) {
  const jobs = yocto(MAINNET.fund.jobs);
  const crews = yocto(MAINNET.fund.crews);
  if (jobs < storageOf(jobsBytes)) throw new Error(`fund.jobs ${MAINNET.fund.jobs} NEAR is below the code's storage, ${near(storageOf(jobsBytes))}`);
  if (crews < storageOf(crewsBytes)) throw new Error(`fund.crews ${MAINNET.fund.crews} NEAR is below the code's storage, ${near(storageOf(crewsBytes))}`);
  const masks = maskTopUps();
  const rows = [
    { what: `${MAINNET.jobs}: code ${jobsBytes} bytes and its state (stays as the contract's storage)`, yocto: jobs, back: 0n },
    { what: `${MAINNET.crews}: code ${crewsBytes} bytes and its state (stays as the contract's storage)`, yocto: crews, back: 0n },
    {
      what: `the masks' storage: ${masks.sends.map((s) => `${s.name} ${near(s.yocto)}`).join(', ')} (two keys, ${masks.keys} bytes, and their transaction's gas; ORACLE also the crew's record, ${near(KEPT.crew)}, of the 0.05 it attaches to form arena-trio)`,
      yocto: masks.sends.reduce((a, s) => a + s.yocto, 0n),
      back: 0n,
    },
    { what: `first job: the reward ${near(quote.reward)}, fuel ${near(quote.fuel)}, judge runs ${near(quote.judge)}, the masks' storage ${near(quote.reserve)}, its record ${near(quote.record)}`, yocto: BigInt(quote.total), back: BigInt(quote.total) - BigInt(quote.reward) - KEPT.job },
    { what: `three bonds of ${near(bond)} NEAR and their records' storage (the bonds come back at the payout, the records' storage to the client)`, yocto: 3n * (bond + 400n * BYTE), back: 3n * bond },
    { what: 'gas of the 2 deployments, 3 sends to the masks, the job and 3 bonds (at most)', yocto: yocto('0.05'), back: 0n },
  ];
  const total = rows.reduce((a, r) => a + r.yocto, 0n);
  return { rows, total, back: rows.reduce((a, r) => a + r.back, 0n) };
}

async function rpc(url, method, params) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'maskwars', method, params }) });
  const body = await res.json();
  if (body.error) {
    const e = new Error(`${method}: ${JSON.stringify(body.error.cause ?? body.error).slice(0, 300)}`);
    e.unknown = /UNKNOWN_ACCOUNT|does not exist/.test(JSON.stringify(body.error));
    throw e;
  }
  return body.result;
}
const query = (net, request) => rpc(net.rpc[0], 'query', { finality: 'final', ...request });
async function account(net, id) {
  try {
    return await query(net, { request_type: 'view_account', account_id: id });
  } catch (e) {
    if (e.unknown) return null;
    throw e;
  }
}
async function view(net, contract, method, args = {}) {
  const r = await query(net, { request_type: 'call_function', account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  return JSON.parse(Buffer.from(r.result).toString('utf8'));
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const rel = (p) => relative(ROOT, p).replaceAll('/', '\\');
const cli = '.\\.scratch\\near\\near.exe';

/** The code from the testnet market, checked against the build's sha256, next to near.exe for mainnet. */
async function code(which) {
  const c = CODE[which];
  const file = join(SCRATCH, c.file);
  if (existsSync(file) && sha256(readFileSync(file)) === c.sha256) return { file, bytes: readFileSync(file).length };
  const r = await query(TESTNET, { request_type: 'view_code', account_id: c.from });
  const bytes = Buffer.from(r.code_base64, 'base64');
  if (sha256(bytes) !== c.sha256) throw new Error(`${c.from} runs code with sha256 ${sha256(bytes)}, not the build's ${c.sha256}: nothing written`);
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(file, bytes);
  return { file, bytes: bytes.length };
}

async function deployment() {
  const [jobsCode, crewsCode] = [await code('jobs'), await code('crews')];
  const admin = await account(MAINNET, MAINNET.admin);
  const [jobsAt, crewsAt, bountyAt] = [await account(MAINNET, MAINNET.jobs), await account(MAINNET, MAINNET.crews), await account(MAINNET, MAINNET.bounty)];
  // The contract's own quote for a job of 1 NEAR, three slots, 0.01 NEAR of fuel each: the same code on testnet.
  const reward = yocto('1');
  const fuel = yocto('0.01');
  const quote = await view(TESTNET, TESTNET.jobs, 'quote', { reward: reward.toString(), fuel_per_mask: fuel.toString(), slots: 3 });
  const b = budget({ jobsBytes: jobsCode.bytes, crewsBytes: crewsCode.bytes, quote, bond: fuel });
  const init = initArgs();
  const jobsInit = join(SCRATCH, 'jobs-init-args.json');
  const crewsInit = join(SCRATCH, 'crews-init-args.json');
  writeFileSync(jobsInit, JSON.stringify(init.jobs));
  writeFileSync(crewsInit, JSON.stringify(init.crews));

  const lines = [];
  const say = (s = '') => lines.push(s);
  say('MASK WARS jobs market on mainnet. Nothing here signs: every transaction below is the owner\'s, from the keychain.');
  say();
  say('Chain now:');
  say(`  ${MAINNET.admin}: ${admin ? `${nearUp(admin.amount)} NEAR` : 'not found'}`);
  say(`  ${MAINNET.bounty}: ${bountyAt ? 'on chain' : 'NOT on chain: deploy the bounty contract first'}`);
  say(`  ${MAINNET.jobs}: ${jobsAt ? `already on chain, code ${jobsAt.code_hash}` : 'free: step 2 makes it'}`);
  say(`  ${MAINNET.crews}: ${crewsAt ? `already on chain, code ${crewsAt.code_hash}` : 'free: step 3 makes it'}`);
  say();
  say('Code (read from the testnet market, sha256 checked against contracts/jobs/build.sh):');
  say(`  ${rel(jobsCode.file)}: ${jobsCode.bytes} bytes, sha256 ${CODE.jobs.sha256}, from ${CODE.jobs.from}`);
  say(`  ${rel(crewsCode.file)}: ${crewsCode.bytes} bytes, sha256 ${CODE.crews.sha256}, from ${CODE.crews.from}`);
  say();
  say('Budget (NEAR):');
  for (const r of b.rows) say(`  ${nearUp(r.yocto).padStart(7)}  ${r.what}${r.back ? `; back after the job: ${nearUp(r.back)}` : ''}`);
  say(`  ${nearUp(b.total).padStart(7)}  in all, of which ${nearUp(b.back)} comes back. The reward goes to the masks that win the job, less the fee.`);
  const need = b.total - BigInt(admin?.amount ?? 0) + yocto('0.1');
  say(`  ${MAINNET.admin} holds ${nearUp(admin?.amount ?? 0)}: top it up by ${nearUp(need > 0n ? need : 0n)} NEAR first (0.1 NEAR stays for its own gas).`);
  say();
  say('Steps (PowerShell, from the repository root). Each near.exe command shows the transaction; choose "send".');
  say();
  say(`1. Top up ${MAINNET.admin} by ${nearUp(need > 0n ? need : 0n)} NEAR from the owner's wallet.`);
  say();
  say(`2. ${MAINNET.jobs}: create, fund ${MAINNET.fund.jobs} NEAR, deploy, new(...). No key is added, now or ever.`);
  say(`   init: ${JSON.stringify(init.jobs)}`);
  say(`   ${cli} transaction construct-transaction ${MAINNET.admin} ${MAINNET.jobs} add-action create-account add-action transfer '${MAINNET.fund.jobs} NEAR' add-action deploy-contract use-file ${rel(jobsCode.file)} with-init-call new file-args ${rel(jobsInit)} prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' skip network-config mainnet sign-with-keychain`);
  say();
  say(`3. ${MAINNET.crews}: create, fund ${MAINNET.fund.crews} NEAR, deploy, new(...). No key.`);
  say(`   init: ${JSON.stringify(init.crews)}`);
  say(`   ${cli} transaction construct-transaction ${MAINNET.admin} ${MAINNET.crews} add-action create-account add-action transfer '${MAINNET.fund.crews} NEAR' add-action deploy-contract use-file ${rel(crewsCode.file)} with-init-call new file-args ${rel(crewsInit)} prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' skip network-config mainnet sign-with-keychain`);
  say('   The same two transactions, from the script the testnet market was made with:');
  say('   .\\scripts\\testnet\\jobs-deploy.ps1 -Network mainnet');
  say();
  say('4. Check: both answer config and hold no key (each list must be empty). The site shows Jobs by itself from here.');
  say(`   ${cli} contract call-function as-read-only ${MAINNET.jobs} config json-args '{}' network-config mainnet now`);
  say(`   ${cli} account list-keys ${MAINNET.jobs} network-config mainnet now`);
  say(`   ${cli} account list-keys ${MAINNET.crews} network-config mainnet now`);
  say();
  const masks = maskTopUps();
  say(`5. The masks' storage, before their keys go on: two keys take ${masks.keys} bytes on each mask, and NOVA and ONYX hold`);
  say(`   their 0.4 NEAR and no more. ORACLE also pays the crew's record (${near(KEPT.crew)}) when it forms the crew.`);
  for (const s of masks.sends) say(`   ${cli} tokens ${MAINNET.admin} send-near ${s.account} '${near(s.yocto)} NEAR' network-config mainnet sign-with-keychain`);
  say();
  say('6. The masks\' keys on both contracts (no NEAR attached by any of them), and the crew arena-trio, formed by its captain');
  say('   ORACLE, which attaches 0.05 NEAR from its own balance (all but the record comes back to it at once):');
  say('   .\\scripts\\testnet\\jobs-keys.ps1 -Network mainnet -Crew arena-trio');
  say();
  say('7. The public repository runs the masks: the crew, then the schedule.');
  say('   gh variable set JOBS_CREW --repo plavutskyi/mask-wars --body arena-trio');
  say('   gh variable set JOBS_LIVE --repo plavutskyi/mask-wars --body true');
  say();
  say('8. The first job, on the house\'s round of the day while its commit window is open (18:04 to 18:49 UTC), and the');
  say('   Jobs workflow started by hand right after it: its work window is at most 40 minutes, and a scheduled run of');
  say('   GitHub often comes later than that.');
  say('   node --use-env-proxy scripts/mainnet/jobs.mjs --job');
  console.log(lines.join('\n'));
}

async function firstJob(rewardNear) {
  const jobsAt = await account(MAINNET, MAINNET.jobs);
  if (!jobsAt) throw new Error(`${MAINNET.jobs} is not on chain yet: run the deployment first`);
  const round = await view(MAINNET, MAINNET.vault, 'get_round');
  if (!round || round.arbiter !== MAINNET.bounty) throw new Error(`${MAINNET.vault} holds no round of ${MAINNET.bounty} now: the house opens one at 18:04 UTC`);
  const r = await view(MAINNET, MAINNET.bounty, 'get_round', { id: round.bounty });
  const head = await rpc(MAINNET.rpc[0], 'block', { finality: 'final' });
  const now = BigInt(head.header.timestamp_nanosecond);
  const left = (BigInt(r.commit_until) - now) / 60_000_000_000n;
  if (left < 25n) throw new Error(`${round.bounty}: its commit window closes in ${left} min: too late for the masks to take a job on it today`);
  const reward = yocto(rewardNear);
  const fuel = yocto('0.01');
  const quote = await view(MAINNET, MAINNET.jobs, 'quote', { reward: reward.toString(), fuel_per_mask: fuel.toString(), slots: 3 });
  const id = `drain-${round.bounty}`;
  const brief = `Drain the house's vault in round ${round.bounty}: the mask that drains it wins the job for its crew.`;
  const args = {
    id, kind: 'drain', brief, spec: sha256(Buffer.from(brief)), rubric: null, judge_version: null,
    round: { bounty: MAINNET.bounty, id: round.bounty }, secrets: null, bar: null, reward: reward.toString(), fuel_per_mask: fuel.toString(), slots: 3,
    open_to: { who: 'masks', masks: Object.values(MAINNET.masks) }, work_minutes: Math.min(Number(left) - 5, 40), reveal_minutes: 30, appeal_minutes: 10, bond: null, client_key: null,
  };
  mkdirSync(SCRATCH, { recursive: true });
  const file = join(SCRATCH, 'open-job-args.json');
  writeFileSync(file, JSON.stringify(args));
  console.log(`Round ${round.bounty} on ${MAINNET.bounty}: its commit window closes in ${left} min.`);
  console.log(`Job ${id}: reward ${near(reward)} NEAR, fuel 0.01 NEAR x 3, the deposit ${near(quote.total)} NEAR by the contract's quote.`);
  console.log(`  args: ${rel(file)} ${JSON.stringify(args)}`);
  console.log();
  console.log(`  ${cli} contract call-function as-transaction ${MAINNET.jobs} open file-args ${rel(file)} prepaid-gas '100.0 Tgas' attached-deposit '${near(quote.total)} NEAR' sign-as ${MAINNET.admin} network-config mainnet sign-with-keychain`);
  console.log(`  .\\scripts\\testnet\\jobs-bond.ps1 -Network mainnet -Job ${id}`);
  console.log('  gh workflow run jobs.yml --repo plavutskyi/mask-wars -f race=false');
  console.log();
  console.log(`Start the Jobs workflow by hand at once and approve it in live-race-hand: the work window is ${args.work_minutes} min, and`);
  console.log('a scheduled run of GitHub often starts later than that. The run takes the job: the crew enlists and seals its');
  console.log('steps. The round is raced by the house\'s own run; once it is drained, a later run asks the judge and settles.');
}

const main = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (main) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--reward');
  const run = argv.includes('--job') ? firstJob(at >= 0 ? argv[at + 1] : '1') : deployment();
  run.catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
