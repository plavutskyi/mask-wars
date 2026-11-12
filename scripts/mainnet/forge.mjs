// The forge on mainnet: the mask factory `masks.maskwars.near`, for the owner. It signs nothing and holds no key. It
// checks the two wasm files against the bytes this commit pins (forge-wasm.json), reads mainnet, works out the exact
// NEAR the forge takes and prints every near-cli command in order, each with what to check after it. The owner runs
// each one with the keychain of maskwars.near; near-cli shows the transaction and asks, and the owner chooses "send".
//
//   node scripts/mainnet/forge.mjs                          # wasm files from .scratch/near-mainnet, mainnet read
//   node scripts/mainnet/forge.mjs --wasm <dir> --offline   # no chain read: the plan and the sum only
//
// What it sends is data in this folder, reviewed in the pull request: brain-project-args.json makes the mind's project
// on OutLayer mainnet (the mainnet build of services/brain, served on maskwars.xyz under its sha256);
// forge-init-args.json is the factory's `new` exactly as it goes on chain (admin, keeper and treasury maskwars.near,
// the arena bounty.maskwars.near, the teams maskwars.near and house.maskwars.near, the mask code's sha256, the
// catalog, 48 hours before anyone may release a race the keeper never settled). The one thing not in it is the mind's
// key (`strategy_key`): it comes out of the brain's TEE once the owner has made the project's secret. Given with
// --strategy-key, it goes into a copy of the file in .scratch/near-mainnet and the factory is born with it; without
// it the factory opens with no private strategy line, and a key added later waits 72 hours once a mask exists.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
export const NEAR = 10n ** 24n;
/** NEAR's storage price, 0.00001 NEAR a byte, and a global contract's, ten times that (the factory's GLOBAL_CODE_BYTE_COST). */
export const BYTE = 10n ** 19n;
export const GLOBAL_BYTE = 10n ** 20n;
/** What an account's own record takes in storage before any code or state (nearcore's `num_bytes_account`). */
export const ACCOUNT_BYTES = 100n;
/**
 * What the keeper's function-call key takes in storage on maskwars.near, exactly: the 40 bytes nearcore counts for any
 * record, the key's 33, and the key's own record: its nonce (8), its kind (1), its allowance (17), the receiver
 * masks.maskwars.near (4 + 19) and the four method names (4 + 7 + 10 + 8 + 9).
 */
export const KEEPER_KEY_BYTES = 160n;
/** What the keeper signs on the factory, and nothing else: the same key scripts/testnet/keeper-key.ps1 adds. */
export const KEEPER_METHODS = 'arm, settle, note, share';
/**
 * Gas the owner's account pays up front for each transaction, at mainnet's least gas price (0.0001 NEAR a TGas) and
 * the prepaid gas the command names; what is not burnt comes back. The deploy carries the factory's 347 KB, the
 * publish the mask code's 60 KB to the global store.
 */
export const GAS = { brain: 50n, deploy: 100n, publish: 300n, key: 5n };
/** What OutLayer's create_project takes for the project's storage; the rest comes back (scripts/testnet/judge-pin.ps1). */
export const BRAIN_DEPOSIT = NEAR / 50n;
/**
 * What the payment key gets for the minds' runs on OutLayer, in dollars. OutLayer keeps a payment key's money in its
 * stablecoin, never in NEAR: `outlayer keys topup <number> --usd <amount>` (OutLayer CLI 0.2.3) takes USDC from the
 * key's owner. OutLayer's own estimate for one run at the mind's limits (`estimate_execution_cost`, 180 s, 128 MB, a
 * billion instructions, read 11.11.2026) is 0.0190001 NEAR at most, and a race asks a mind at most 5 times
 * (packages/race/src/brain.ts, RACE_CALLS): under 0.1 NEAR a guest's race at the dearest, so, counted at NEAR's price,
 * $3 runs at least four guests' races while NEAR costs less than $7.8. The arena pays this; the tokens the mind spends come out of the
 * mask's own tank. A key's first top-up is what OutLayer keeps as its `initial_balance`, the sum Live race counts
 * "low" from (packages/race/src/payment-key.ts).
 */
export const RUNS_TOPUP_USD = 3;
/**
 * The stablecoin OutLayer's payment keys hold on mainnet: native USDC on NEAR (`get_payment_token_contract` of
 * outlayer.near, read 12.11.2026). The account that tops a key up is registered on it first and holds the dollars.
 */
export const USDC_ON_NEAR = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
/** What the token takes to register an account (`storage_deposit`), once: 0.00125 NEAR. */
export const USDC_STORAGE = NEAR / 800n;
const GAS_PRICE_PER_TGAS = NEAR / 10_000n;
/** Where `outlayer login` keeps the key it imports, in plain text (the OutLayer CLI's config). */
export const OUTLAYER_CREDENTIALS = '%USERPROFILE%\\.outlayer\\mainnet\\credentials.json';

export function readJson(name) {
  return JSON.parse(readFileSync(join(HERE, name), 'utf8'));
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The mind's build that brain-project-args.json names: its url on maskwars.xyz and its sha256, checked against the file
 * apps/web/public/outlayer serves under that name. Throws when they differ or the file is not there.
 */
export function brainBuild() {
  const { url, hash } = readJson('brain-project-args.json').source.WasmUrl;
  const file = join(ROOT, 'apps', 'web', 'public', 'outlayer', `maskwars-brain-${hash}.wasm`);
  if (url !== `https://maskwars.xyz/outlayer/maskwars-brain-${hash}.wasm`) throw new Error(`brain-project-args.json: ${url} is not the site's file for ${hash}`);
  if (!existsSync(file)) throw new Error(`apps/web/public/outlayer serves no maskwars-brain-${hash}.wasm: the mind's version would point at nothing`);
  const bytes = readFileSync(file);
  if (sha256Hex(bytes) !== hash) throw new Error(`apps/web/public/outlayer/maskwars-brain-${hash}.wasm is not those bytes`);
  return { url, hash, bytes: bytes.length };
}

/** `9.4012345 NEAR` → yocto; a decimal string with at most 24 decimals. */
export function yocto(near) {
  const [whole, frac = ''] = String(near).split('.');
  if (!/^\d+$/.test(whole) || !/^\d{0,24}$/.test(frac)) throw new Error(`not an amount of NEAR: ${near}`);
  return BigInt(whole) * NEAR + BigInt(frac.padEnd(24, '0'));
}

/** yocto → `9.4012 NEAR`, to `digits` decimals, rounded up: a budget never says less than it takes. */
export function nearUp(y, digits = 4) {
  const step = 10n ** BigInt(24 - digits);
  const r = ((y + step - 1n) / step) * step;
  const frac = (r % NEAR).toString().padStart(24, '0').slice(0, digits).replace(/0+$/, '');
  return `${r / NEAR}${frac ? `.${frac}` : ''}`;
}

/**
 * The exact NEAR of the forge, from the bytes of the two wasm files and the factory's state after `new`.
 * - `stake`: what the factory's own storage locks for good: its account, its code, its state;
 * - `publish`: what publishing the mask code burns, 0.0001 NEAR a byte;
 * - `fund`: what the factory's account gets in the deploy (forge-wasm.json `fund`), and what of it stays free after
 *   publishing, the factory's margin for its own state (a change the admin proposes, the copy lists);
 * - `gas`: the most the owner's account pays up front for the four transactions;
 * - `key`: the keeper's key on maskwars.near;
 * - `brain`: the mind's project on OutLayer, the deposit its create_project takes;
 * - `keeperFloat`: what stays on maskwars.near for the keeper's gas.
 * The payment key for the minds' runs is not NEAR and not in this sum: it is paid in USDC (`runsLine`).
 */
export function budget({ factoryBytes, maskBytes, stateBytes, fund, keeperFloat }) {
  const stake = (ACCOUNT_BYTES + BigInt(factoryBytes) + BigInt(stateBytes)) * BYTE;
  const publish = BigInt(maskBytes) * GLOBAL_BYTE;
  const margin = fund - stake - publish;
  const gas = (GAS.brain + GAS.deploy + GAS.publish + GAS.key) * GAS_PRICE_PER_TGAS;
  const key = KEEPER_KEY_BYTES * BYTE;
  const brain = BRAIN_DEPOSIT;
  return { stake, publish, fund, margin, gas, key, brain, keeperFloat, total: fund + gas + key + brain + keeperFloat };
}

/**
 * The payment key's money, in one line: it is not part of the NEAR above. `admin` pays it in USDC, and before the
 * top-up it is registered on the token and holds the dollars.
 */
export function runsLine(admin) {
  return `the payment key for the minds' runs on OutLayer is paid in USDC, not NEAR: about $${RUNS_TOPUP_USD}. First ${admin} registers on the token ${USDC_ON_NEAR} (storage_deposit, ${nearUp(USDC_STORAGE, 5)} NEAR), then gets the USDC there (any coin to USDC on NEAR for ${admin} at maskwars.xyz/swap)`;
}

/** The account and access-key reads the plan rests on. `rpc` is a JSON-RPC endpoint. */
async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'maskwars-forge', method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const out = await res.json();
  if (out.error) {
    const text = JSON.stringify(out.error);
    if (/UNKNOWN_ACCOUNT|does not exist/.test(text)) return null;
    throw new Error(`${method}: ${text}`);
  }
  return out.result;
}

const account = (url, id) => rpc(url, 'query', { request_type: 'view_account', finality: 'final', account_id: id });

/**
 * The commands, in order, each with the check after it. `initFile` is the factory's `new`: the committed file, or its
 * copy with the mind's key in it.
 */
export function commands({ net, wasmDir, initFile, fund, brainFile }) {
  const f = net.factory;
  const admin = net.admin;
  const outlayer = net.outlayer.contract;
  const factoryWasm = join(wasmDir, 'maskwars_masks.wasm');
  const maskWasm = join(wasmDir, 'maskwars_mask.wasm');
  const seed = join('.scratch', 'near-mainnet', 'keeper-seed.txt');
  return [
    {
      what: `The mind's project on OutLayer mainnet, ${admin}/brain: the mainnet build of services/brain`,
      cli: `near contract call-function as-transaction ${outlayer} create_project file-args ${brainFile} prepaid-gas '${GAS.brain}.0 Tgas' attached-deposit '${nearUp(BRAIN_DEPOSIT)} NEAR' sign-as ${admin} network-config mainnet sign-with-keychain`,
      check: `near contract call-function as-read-only ${outlayer} get_project json-args '{"project_id":"${admin}/brain"}' network-config mainnet now`,
    },
    {
      what: `The mind's secrets and key, in the OutLayer CLI logged in as ${admin} (services/brain/README.md). outlayer login keeps the full-access key of ${admin} in a plain file on this computer, ${OUTLAYER_CREDENTIALS}: delete it after the last outlayer command`,
      cli: [
        'outlayer login',
        `outlayer secrets set --generate PROTECTED_BRAIN_SEED:hex32 --project ${admin}/brain --access whitelist:${admin}`,
        `outlayer secrets update '{"NEAR_AI_API_KEY":"<the key>"}' --project ${admin}/brain`,
        `outlayer run ${admin}/brain --input <a file that holds {"action":"key"}> --secrets-profile default --secrets-account ${admin}`,
        'outlayer keys create',
        `outlayer keys topup <the key's number> --usd ${RUNS_TOPUP_USD}`,
      ].join('\n   '),
      check: `the run answers {"key":"x25519:<64 hex>"}: run this script again with --strategy-key x25519:<64 hex>. The top-up takes $${RUNS_TOPUP_USD} of USDC from ${admin}, which is registered on the token and holds them first (the line under the sum above); \`outlayer keys balance <the key's number>\` then shows the dollars. The payment key goes into the secret OUTLAYER_PAYMENT_KEY of the environment outlayer-mainnet; nothing refills it by itself: Live race reports what is left on it after each round and, when it runs low, the same topup by hand. Then delete ${OUTLAYER_CREDENTIALS}`,
    },
    {
      what: `The factory on its own account, with no key: create ${f}, ${nearUp(fund)} NEAR, its code, new(...)`,
      cli: `near transaction construct-transaction ${admin} ${f} add-action create-account add-action transfer '${nearUp(fund)} NEAR' add-action deploy-contract use-file ${factoryWasm} with-init-call new file-args ${initFile} prepaid-gas '${GAS.deploy}.0 Tgas' attached-deposit '0 NEAR' skip network-config mainnet sign-with-keychain`,
      check: `near account list-keys ${f} network-config mainnet now   # no key at all`,
    },
    {
      what: "The keeper's seed, once, on this computer: it goes into KEEPER_SEED of the environment live-race-mainnet",
      cli: `node scripts/testnet/keeper-key.mjs ${seed} ${f}`,
      check: "prints the public half of the keeper's key: the next command adds it. Paste the file into the secret, then delete the file",
    },
    {
      what: `The keeper's key on ${admin}: ${KEEPER_METHODS} on ${f} only, 2 NEAR of gas over its life, never a deposit`,
      cli: `near account add-key ${admin} grant-function-call-access --allowance '2 NEAR' --contract-account-id ${f} --function-names '${KEEPER_METHODS}' use-manually-provided-public-key <the public key printed above> network-config mainnet sign-with-keychain`,
      check: `near account list-keys ${admin} network-config mainnet now`,
    },
    {
      what: 'The mask code, published once as a global contract: the forge opens',
      cli: `near contract call-function as-transaction ${f} publish_mask_code file-args ${maskWasm} prepaid-gas '${GAS.publish}.0 Tgas' attached-deposit '0 NEAR' sign-as ${admin} network-config mainnet sign-with-keychain`,
      check: `near contract call-function as-read-only ${f} config json-args '{}' network-config mainnet now   # mask_code.published: true; maskwars.xyz/forge opens by itself`,
    },
  ];
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const net = JSON.parse(readFileSync(join(ROOT, 'packages', 'network', 'mainnet.json'), 'utf8'));
  const pins = readJson('forge-wasm.json');
  const init = readJson('forge-init-args.json');
  let initFile = join('scripts', 'mainnet', 'forge-init-args.json');
  const brainFile = join('scripts', 'mainnet', 'brain-project-args.json');
  const wasmDir = resolve(opt('--wasm') ?? join(ROOT, '.scratch', 'near-mainnet'));
  const strategyKey = opt('--strategy-key');
  if (strategyKey && !/^x25519:[0-9a-f]{64}$/.test(strategyKey)) throw new Error('--strategy-key: x25519:<64 hex>, as the brain module gives it');

  // The bytes: exactly the ones this commit pins, or nothing is printed to send.
  const files = { factory: 'maskwars_masks.wasm', mask: 'maskwars_mask.wasm' };
  const sizes = {};
  for (const [k, file] of Object.entries(files)) {
    const path = join(wasmDir, file);
    if (!existsSync(path)) throw new Error(`${path} is not there: build it (contracts/masks, Forge workflow) and put it in ${wasmDir}`);
    const bytes = readFileSync(path);
    const sha = sha256Hex(bytes);
    if (sha !== pins[k].sha256 || bytes.length !== pins[k].bytes) {
      throw new Error(`${file} is ${bytes.length} bytes, sha256 ${sha}; this commit pins ${pins[k].bytes} bytes, ${pins[k].sha256}`);
    }
    sizes[k] = bytes.length;
  }
  if (init.mask_code !== pins.mask.sha256) throw new Error('forge-init-args.json names another mask code than forge-wasm.json');
  // The mind's build: the file the site serves for OutLayer must be these very bytes, or step 1 would point at nothing.
  const mind = brainBuild();
  if (strategyKey) {
    // The same `new`, with the mind's key: a copy next to the owner's other mainnet files, never committed.
    const dir = join(ROOT, '.scratch', 'near-mainnet');
    mkdirSync(dir, { recursive: true });
    initFile = join('.scratch', 'near-mainnet', 'forge-init-args.json');
    writeFileSync(join(ROOT, initFile), `${JSON.stringify({ ...init, strategy_key: strategyKey })}\n`);
  }

  const fund = yocto(net.fund.factory);
  const b = budget({ factoryBytes: sizes.factory, maskBytes: sizes.mask, stateBytes: pins.state_bytes, fund, keeperFloat: yocto(pins.keeper_float) });
  if (b.margin < 0n) throw new Error(`fund.factory ${net.fund.factory} NEAR does not cover the stake and the publish`);

  console.log(`The forge on mainnet: ${net.factory}`);
  console.log(`  factory code  ${sizes.factory} bytes  sha256 ${pins.factory.sha256}`);
  console.log(`  mask code     ${sizes.mask} bytes  sha256 ${pins.mask.sha256}`);
  console.log(`  mind          ${mind.bytes} bytes  sha256 ${mind.hash}  (services/brain, build.sh --mainnet; served at ${mind.url})`);
  console.log('');
  console.log('NEAR, exactly:');
  console.log(`  ${nearUp(b.stake).padStart(8)}  the factory's storage, locked for good: its account, code and state after new()`);
  console.log(`  ${nearUp(b.publish).padStart(8)}  publishing the mask code once, 0.0001 NEAR a byte, burnt`);
  console.log(`  ${nearUp(b.margin).padStart(8)}  left free on the factory: its margin for its own state`);
  console.log(`  ${nearUp(b.fund).padStart(8)}  = what ${net.factory} gets (fund.factory)`);
  console.log(`  ${nearUp(b.gas).padStart(8)}  gas the owner pays up front at most, for every transaction below; the unburnt part comes back`);
  console.log(`  ${nearUp(b.key).padStart(8)}  the keeper's key on ${net.admin}, storage`);
  console.log(`  ${nearUp(b.brain).padStart(8)}  the mind's project on OutLayer, its storage deposit`);
  console.log(`  ${nearUp(b.keeperFloat).padStart(8)}  kept on ${net.admin} for the keeper's gas: arm, settle, note and share around each round`);
  console.log(`  ${nearUp(b.total).padStart(8)}  in all, from ${net.admin}`);
  console.log(`  Beside it, ${runsLine(net.admin)}.`);

  if (!args.includes('--offline')) {
    const url = net.rpc[0];
    const [admin, factory, bounty, house] = await Promise.all([account(url, net.admin), account(url, net.factory), account(url, net.bounty), account(url, net.house)]);
    console.log('');
    console.log('Mainnet now:');
    const free = admin ? BigInt(admin.amount) - BigInt(admin.storage_usage) * BYTE : 0n;
    console.log(`  ${net.admin}: ${admin ? `${nearUp(free)} NEAR free` : 'not there'}${admin && free < b.total ? `, ${nearUp(b.total - free)} NEAR short: send it there first` : ''}`);
    console.log(`  ${net.factory}: ${factory ? `already there (code ${factory.code_hash}): do not deploy again` : 'not there yet'}`);
    console.log(`  ${net.bounty}: ${bounty ? `code ${bounty.code_hash}` : 'NOT THERE: the factory arms masks only for its rounds'}`);
    console.log(`  ${net.house}: ${house ? 'there: its rounds are a team the factory arms masks for' : 'not there'}`);
    if (factory) process.exitCode = 1;
  }

  console.log('');
  console.log('Commands, in order. near-cli shows each transaction and asks; choose "send".');
  commands({ net, wasmDir, initFile, fund, brainFile }).forEach((s, i) => {
    console.log('');
    console.log(`${i + 1}. ${s.what}`);
    console.log(`   ${s.cli}`);
    console.log(`   check: ${s.check}`);
  });
  console.log('');
  console.log(strategyKey
    ? `The factory is born with the mind's key ${strategyKey} (${initFile}).`
    : "No --strategy-key: step 3 would make the factory without the mind's key, and the forge would take no private strategy line. Run steps 1 and 2 first, then this again with --strategy-key.");
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
