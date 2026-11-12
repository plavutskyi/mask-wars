#!/usr/bin/env node
// The code that names its own source (NEP-330) on its way to mainnet. Takes the files contracts/build-source.sh built
// in the clone of the public repository, checks each, puts the ones the owner deploys where the scripts and the site
// read them, writes the house's new terms, and prints the owner's steps in their order. Signs nothing, sends nothing.
//
//   node scripts/mainnet/source.mjs <out/source>                    check, place, print the steps
//   node --use-env-proxy scripts/mainnet/source.mjs <out/source> --switch safe
//        once the bounty contract lists the vault's new code: `safe_code` and `round.stake` of mainnet.json, so the
//        house's next day makes the vault with it (refused while the chain does not list the code)
//   node scripts/mainnet/source.mjs <out/source> --switch home
//        `home_code` of mainnet.json, right before home-deploy.mjs puts the new home on the masks
//
// The vault's code is pinned in two places on chain and one in the repository, and all three move together or the
// day stops: the bounty contract's `safe_codes` (it opens no round on a code it does not list), the house's
// `safe_code` once the house runs its own contract (contracts/house: its `make_vault` takes only that code), and
// `safe_code` of packages/network/mainnet.json (the day deploys the file the repository serves under it).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeHash, faults, sourceMetadata } from '../../contracts/nep330.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const NEAR = 10n ** 24n;
/** NEAR locks this much for every byte an account stores. */
const BYTE_COST = 10n ** 19n;
/** What the vault's state may take besides its code, at most (packages/race/src/house.ts, VAULT_STATE_BYTES). */
const VAULT_STATE_BYTES = 6000n;
/** The round's window on mainnet, UTC: no owner's step lands in it. */
export const ROUND_WINDOW = { from: '18:00', to: '21:30' };

/** Each file contracts/build-source.sh makes: its crate, and where the deploy takes it from. */
export const CONTRACTS = {
  'live-safe': { crate: 'contracts/challenges/live-safe', scratch: 'maskwars_live_safe.wasm', served: (sha) => `maskwars-live-safe-${sha}.wasm` },
  bounty: { crate: 'contracts/bounty', scratch: 'maskwars_bounty.wasm' },
  house: { crate: 'contracts/house', scratch: 'maskwars_house.wasm' },
  'home-mainnet': { crate: 'contracts/home', served: (sha) => `maskwars-home-mainnet-${sha}.wasm` },
  'home-testnet': { crate: 'contracts/home', served: (sha) => `maskwars-home-testnet-${sha}.wasm` },
  season: { crate: 'contracts/season', scratch: 'maskwars_season.wasm' },
  jobs: { crate: 'contracts/jobs', scratch: 'maskwars_jobs.wasm' },
  crews: { crate: 'contracts/crews', scratch: 'maskwars_crews.wasm' },
  mask: { crate: 'contracts/masks/mask', scratch: 'maskwars_mask.wasm' },
  factory: { crate: 'contracts/masks/factory', scratch: 'maskwars_masks.wasm' },
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const yocto = (near) => {
  const [whole, frac = ''] = String(near).split('.');
  return BigInt(whole) * NEAR + BigInt(frac.padEnd(24, '0').slice(0, 24));
};
const near = (y) => `${y / NEAR}.${String(y % NEAR).padStart(24, '0').slice(0, 4)}`;

/** The version a crate's Cargo.toml names. */
export function crateVersion(crate, root = ROOT) {
  const m = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(join(root, crate, 'Cargo.toml'), 'utf8'));
  if (!m) throw new Error(`${crate}/Cargo.toml names no version`);
  return m[1];
}

/** Every exported function of a wasm. */
const exportsOf = (bytes) => WebAssembly.Module.exports(new WebAssembly.Module(bytes)).filter((e) => e.kind === 'function').map((e) => e.name);

/**
 * Reads the built files in `dir`: each with its size, sha256, code hash and metadata, and why it may not go to
 * mainnet. All of them must come from one commit of the public repository and each must be its crate's version.
 */
export async function readBuild(dir, root = ROOT) {
  const out = {};
  for (const [name, c] of Object.entries(CONTRACTS)) {
    const file = join(dir, `${name}.wasm`);
    if (!existsSync(file)) continue;
    const bytes = readFileSync(file);
    const meta = await sourceMetadata(bytes);
    const why = faults(meta);
    const version = crateVersion(c.crate, root);
    if (meta && meta.version !== version) why.push(`version ${meta.version}, not ${version} of ${c.crate}/Cargo.toml`);
    if (meta?.build_info && meta.build_info.contract_path !== c.crate) why.push(`built from ${meta.build_info.contract_path}, not ${c.crate}`);
    out[name] = { file, bytes, sha256: sha256(bytes), code: codeHash(bytes), meta, why, exports: exportsOf(bytes) };
  }
  if (Object.keys(out).length === 0) throw new Error(`${dir} holds none of ${Object.keys(CONTRACTS).map((n) => `${n}.wasm`).join(', ')}`);
  const revs = new Set(Object.values(out).map((b) => b.meta?.link?.split('/tree/')[1]));
  if (revs.size > 1) for (const b of Object.values(out)) b.why.push(`the files come from ${revs.size} commits: build them all at one`);
  return out;
}

/** Why the vault's code cannot be the next vault on `net`; empty when it can. */
export function vaultFaults(b, net) {
  const out = [];
  for (const m of ['set_owner', 'sweep', 'arm', 'queue', 'retire', 'on_retire', 'reclaim', 'on_bounty', 'about', 'contract_source_metadata']) {
    if (!b.exports.includes(m)) out.push(`it exports no ${m}`);
  }
  const stake = (BigInt(b.bytes.length) + VAULT_STATE_BYTES) * BYTE_COST;
  const safe = yocto(net.round.safe);
  if (stake + 2n * yocto(net.round.min_loot) > safe) out.push(`its code and state lock ${near(stake)} NEAR: ${net.round.safe} in the vault leaves less than twice the least drain`);
  return out;
}

/** The house contract's terms (contracts/house, `new` and `configure`) for `net`, with the vault's code `code`. */
export function houseTerms(net, judge, code) {
  return {
    bounty: net.bounty,
    vault: net.vault,
    safe_code: code,
    masks: Object.values(net.masks),
    judge_version: judge,
    safe: yocto(net.round.safe).toString(),
    deposit: yocto(net.round.deposit).toString(),
    min_loot: yocto(net.round.min_loot).toString(),
    gas: yocto(net.round.gas).toString(),
    hours: net.round.hours,
    commit_minutes: net.round.commit_minutes,
    reveal_minutes: net.round.reveal_minutes,
    first_minute: net.round.first_minute,
    every_minutes: net.round.every_minutes,
    safe_max: yocto(net.limits.hand.safe_max).toString(),
    deposit_max: yocto(net.limits.hand.deposit_max).toString(),
  };
}

/** What the vault's code and state lock, rounded up to a hundredth of a NEAR: `round.stake` of the network file. */
export function stakeOf(bytes) {
  const y = BigInt(bytes) * BYTE_COST;
  const hundredths = (y + NEAR / 100n - 1n) / (NEAR / 100n);
  return `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}`;
}

/** `text` of a network file with one string field set, the rest of the file as it is. */
export function setField(text, key, value) {
  const re = new RegExp(`("${key}": )"[^"]*"`);
  if (!re.test(text)) throw new Error(`no "${key}" in the network file`);
  return text.replace(re, `$1"${value}"`);
}

async function listed(net, code) {
  const args = Buffer.from('{}').toString('base64');
  for (const url of net.rpc) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'maskwars', method: 'query', params: { finality: 'final', request_type: 'call_function', account_id: net.bounty, method_name: 'governance', args_base64: args } }),
      });
      const body = await res.json();
      if (body.error) throw new Error(JSON.stringify(body.error).slice(0, 200));
      const gov = JSON.parse(Buffer.from(body.result.result).toString('utf8'));
      return (gov.safe_codes ?? []).includes(code);
    } catch (e) {
      console.error(`${url}: ${e.message}`);
    }
  }
  throw new Error('no RPC answered: nothing switched');
}

async function main(argv) {
  const dir = argv.find((a) => !a.startsWith('--'));
  const which = argv.includes('--switch') ? argv[argv.indexOf('--switch') + 1] : null;
  if (!dir || (argv.includes('--switch') && !['safe', 'home'].includes(which))) {
    console.error('usage: node scripts/mainnet/source.mjs <out/source> [--switch safe|home]');
    return 2;
  }
  const net = JSON.parse(readFileSync(join(ROOT, 'packages/network/mainnet.json'), 'utf8'));
  const judge = JSON.parse(readFileSync(join(ROOT, 'scripts/mainnet/judge-args.json'), 'utf8')).version;
  const build = await readBuild(dir);
  let bad = false;
  const rev = Object.values(build)[0].meta?.link?.split('/tree/')[1];
  console.log(`commit ${rev} of the public repository\n`);
  for (const [name, b] of Object.entries(build)) {
    const why = name === 'live-safe' ? [...b.why, ...vaultFaults(b, net)] : b.why;
    console.log(`${name.padEnd(13)} ${b.meta?.version ?? '?'}  ${String(b.bytes.length).padStart(7)} bytes  code hash ${b.code}  sha256 ${b.sha256}`);
    for (const w of why) console.log(`  NOT OK: ${w}`);
    bad ||= why.length > 0;
  }
  if (bad) {
    console.log('\nNothing placed: build again with contracts/build-source.sh in the public clone.');
    return 1;
  }

  const safe = build['live-safe'];
  if (which === 'safe') {
    if (!safe) throw new Error('no live-safe.wasm: nothing to switch');
    if (!(await listed(net, safe.code))) {
      console.log(`\n${net.bounty} does not list ${safe.code} yet: bounty-change.ps1 -Network mainnet -AllowSafe, then -Apply. Nothing switched.`);
      return 1;
    }
    const file = join(ROOT, 'packages/network/mainnet.json');
    let text = readFileSync(file, 'utf8');
    text = setField(setField(text, 'safe_code', safe.code), 'stake', stakeOf(safe.bytes.length));
    writeFileSync(file, text);
    console.log(`\nmainnet.json: safe_code ${safe.code}, round.stake ${stakeOf(safe.bytes.length)}. Commit, merge, export the public copy before 18:00 UTC.`);
    return 0;
  }
  if (which === 'home') {
    const b = build['home-mainnet'];
    if (!b) throw new Error('no home-mainnet.wasm: nothing to switch');
    const file = join(ROOT, 'packages/network/mainnet.json');
    writeFileSync(file, setField(readFileSync(file, 'utf8'), 'home_code', b.code));
    console.log(`mainnet.json: home_code ${b.code}`);
    console.log('\nCommit, then node scripts/mainnet/home-deploy.mjs prints the three deploys. Until each mask runs it, the');
    console.log("house's day leaves that mask's winnings where they are and says so. testnet.json moves once testnet's masks run it.");
    return 0;
  }

  // Place what the deploys read: the site serves the vault's code and home under their sha256, the owner's scripts read
  // the rest from .scratch\near-mainnet.
  const scratch = join(ROOT, '.scratch', 'near-mainnet');
  const served = join(ROOT, 'apps', 'web', 'public', 'contracts');
  mkdirSync(scratch, { recursive: true });
  for (const [name, b] of Object.entries(build)) {
    const c = CONTRACTS[name];
    if (c.served) copyFileSync(b.file, join(served, c.served(b.sha256)));
    if (c.scratch) copyFileSync(b.file, join(scratch, c.scratch));
  }
  const terms = safe ? houseTerms(net, judge, safe.code) : null;
  if (terms) writeFileSync(join(scratch, 'house-terms.json'), `${JSON.stringify(terms, null, 2)}\n`);

  const window = `not between ${ROUND_WINDOW.from} and ${ROUND_WINDOW.to} UTC`;
  let steps = 0;
  const step = () => `${(steps += 1)}.`;
  console.log(`\nPlaced: the vault and home in apps/web/public/contracts, the rest in .scratch/near-mainnet. Commit the files in apps/web/public/contracts.\n`);
  console.log('The owner signs, in this order:');
  if (safe) {
    console.log(`\n${step()} The bounty contract takes the vault's new code ${safe.code} (maskwars.near, keychain). Propose ${window}; apply within`);
    console.log('   the day, before 17:30 UTC: while a change waits, the house opens no round.');
    console.log('     .\\scripts\\testnet\\bounty-change.ps1 -Network mainnet -AllowSafe');
    console.log('     an hour later: .\\scripts\\testnet\\bounty-change.ps1 -Network mainnet -Apply; then -Show lists the code');
    console.log(`${step()} The repository names the new code: node --use-env-proxy scripts/mainnet/source.mjs <out/source> --switch safe,`);
    console.log('   merge, export the public copy before 18:00 UTC. The next day the house retires the vault and makes it with 1.6.0.');
    console.log(`${step()} The house's terms with the new code are .scratch/near-mainnet/house-terms.json. While house.maskwars.near has no`);
    console.log('   contract (contracts/house/README.md) nothing to send. Once it runs one, the same moment as step 2, ' + window + ':');
    console.log("     near contract call-function as-transaction house.maskwars.near configure file-args .scratch/near-mainnet/house-terms.json prepaid-gas '30.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as house.maskwars.near network-config mainnet sign-with-keychain send");
    console.log('   Deploying the house contract (1.2.0, .scratch/near-mainnet/maskwars_house.wasm): `new` takes these terms and last_round.');
  }
  if (build['home-mainnet']) {
    console.log(`\n${step()} home ${build['home-mainnet'].meta.version} on NOVA, ONYX and ORACLE, ${window}: node scripts/mainnet/source.mjs <out/source> --switch home,`);
    console.log('   commit, then node scripts/mainnet/home-deploy.mjs prints three deploys, each signed by the mask\'s own key.');
  }
  if (build.bounty) {
    console.log(`\n${step()} The bounty contract ${build.bounty.meta.version} (${build.bounty.bytes.length} bytes): .\\scripts\\testnet\\bounty-change.ps1 -Network mainnet -Code,`);
    console.log('   after the wait -Upgrade. It waits 1 h with no bounty live and 108 h otherwise, and no round opens while it waits:');
    console.log('   on a day the owner chooses to pause the arena.');
  }
  // Contracts with no key change their code only the way they allow: the admin proposes the new sha256, the change
  // waits in the open, then `upgrade` takes the wasm itself.
  const upgrades = [
    ['jobs', net.jobs, 'an hour with no job live, a week while one is: no job opens meanwhile'],
    ['crews', net.crews, 'an hour'],
  ].filter(([name]) => build[name]);
  if (upgrades.length > 0) {
    console.log(`\n${step()} The contracts that hold no key take the new code only through their admin, ${window} (maskwars.near, keychain):`);
    for (const [name, account, wait] of upgrades) {
      const b = build[name];
      const file = join('.scratch', 'near-mainnet', CONTRACTS[name].scratch);
      console.log(`   ${account}: ${b.meta.version}, ${b.bytes.length} bytes; waits ${wait}`);
      console.log(`     near contract call-function as-transaction ${account} propose json-args '{"change":{"kind":"code","sha256":"${b.sha256}"}}' prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as ${net.admin} network-config mainnet sign-with-keychain send`);
      console.log(`     after the wait: near contract call-function as-transaction ${account} upgrade file-args ${file} prepaid-gas '300.0 Tgas' attached-deposit '0 NEAR' sign-as ${net.admin} network-config mainnet sign-with-keychain send`);
    }
  }
  if (build.factory) {
    console.log(`\n${step()} The mask factory ${net.factory}: ${build.factory.meta.version}, ${build.factory.bytes.length} bytes, ${window}. It waits an hour before the`);
    console.log('   first mask is forged, 72 h after: .\\scripts\\testnet\\forge-change.ps1 -Network mainnet -Code, after the wait -Upgrade.');
  }
  if (build.mask) {
    console.log(`\n${step()} The code on every forged mask (${build.mask.meta.version}, ${build.mask.bytes.length} bytes): the factory publishes it once as a global contract,`);
    console.log(`   0.0001 NEAR a byte (${(build.mask.bytes.length / 10000).toFixed(4)} NEAR): forge-change.ps1 proposes it (mask_code ${build.mask.sha256}), then publish_mask_code;`);
    console.log('   masks forged before it take it with `renew`. Only when the owner chooses to spend that.');
  }
  if (build.season) console.log(`\n${step()} The season treasury is not on mainnet: its first deploy takes ${CONTRACTS.season.scratch} from .scratch/near-mainnet.`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
