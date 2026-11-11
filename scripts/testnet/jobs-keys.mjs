// The masks' keys on the jobs market, for jobs-keys.ps1 and jobs-bond.ps1. Every key a mask races with comes from one
// seed (season-keys.mjs, packages/race/src/keys.ts): the key for receiver R is the ed25519 key whose 32-byte seed is
// HMAC-SHA256(seed, "maskwars-race-key:" + R). So the same seeds in MASK_KEYS give each mask its key on the jobs
// contract and its key on the crews contract, and the `Jobs` workflow derives the private halves it signs with. This
// helper never makes a seed: it reads the seeds file season-keys.ps1 wrote (mask-seeds.json in .scratch), the same
// contents as the secret MASK_KEYS, so the keys it puts on chain are the ones the workflow holds.
//
//   node jobs-keys.mjs <seeds file> <jobs contract> <crews contract> nova onyx oracle
//     → {"nova":{"jobs":"ed25519:…","crews":"ed25519:…"},…}: the public halves to add
//   node jobs-keys.mjs --bond <jobs contract> <job id>
//     → {"job","kind","phase","bond","deposit"}: what jobs-bond.ps1 locks for each mask, read over NEAR_RPC.
//       `deposit` is the bond and its record's storage (400 bytes), in NEAR: what the record does not take comes back.
//   node jobs-keys.mjs --deposit <bond in yoctoNEAR>
//     → the same deposit for a bond given by hand, with no network (a dry run).
import { existsSync, readFileSync } from 'node:fs';
import { racePublicKey } from './season-keys.mjs';

/** What a bond's record may take before its mask enlists: 400 bytes at 10^19 yocto a byte (contracts/jobs). */
export const BOND_RECORD = 400n * 10n ** 19n;

/** yoctoNEAR → NEAR as near.exe takes it: no trailing zeros. */
export function nearOf(yocto) {
  const y = BigInt(yocto);
  const whole = y / 10n ** 24n;
  const frac = (y % 10n ** 24n).toString().padStart(24, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Each mask's public keys on the jobs and crews contracts, from its seed in the file. */
export function jobKeys(secrets, jobs, crews, masks) {
  const out = {};
  for (const m of masks) {
    const seed = secrets[m.toUpperCase()]?.seed;
    if (!/^[0-9a-f]{64}$/.test(seed ?? '')) throw new Error(`${m}: no seed in the seeds file: season-keys.ps1 makes it, and the same file is MASK_KEYS`);
    out[m] = { jobs: racePublicKey(seed, jobs), crews: racePublicKey(seed, crews) };
  }
  return out;
}

/** What locking a mask's bond on a job takes, from the job as the contract shows it (`get`). */
export function bondOf(view) {
  if (!view) throw new Error('no such job');
  const bond = BigInt(view.terms.bond);
  return { job: view.id, kind: view.terms.kind, phase: view.phase, bond: bond.toString(), deposit: nearOf(bond + BOND_RECORD) };
}

async function getJob(rpc, jobs, id) {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'maskwars', method: 'query',
      params: { request_type: 'call_function', finality: 'final', account_id: jobs, method_name: 'get', args_base64: Buffer.from(JSON.stringify({ id })).toString('base64') },
    }),
  });
  const body = await res.json();
  if (body.error || !body.result?.result) throw new Error(`${jobs}.get: ${JSON.stringify(body.error ?? body.result)}`);
  return JSON.parse(Buffer.from(body.result.result).toString('utf8'));
}

const main = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (main) {
  const argv = process.argv.slice(2);
  const account = /^[a-z0-9._-]{2,64}$/;
  if (argv[0] === '--deposit') {
    if (!/^\d{1,40}$/.test(argv[1] ?? '')) {
      console.error('usage: node jobs-keys.mjs --deposit <bond in yoctoNEAR>');
      process.exit(2);
    }
    console.log(nearOf(BigInt(argv[1]) + BOND_RECORD));
  } else if (argv[0] === '--bond') {
    const [, jobs, id] = argv;
    if (!account.test(jobs ?? '') || !/^[a-z0-9_-]{1,64}$/.test(id ?? '') || !process.env.NEAR_RPC) {
      console.error('usage: NEAR_RPC=<rpc> node jobs-keys.mjs --bond <jobs contract> <job id>');
      process.exit(2);
    }
    try {
      console.log(JSON.stringify(bondOf(await getJob(process.env.NEAR_RPC, jobs, id))));
    } catch (e) {
      console.error(`${id}: ${e.message}`);
      process.exit(1);
    }
  } else {
    const [file, jobs, crews, ...masks] = argv;
    if (!file || !account.test(jobs ?? '') || !account.test(crews ?? '') || masks.length === 0 || !masks.every((m) => /^[a-z0-9-]+$/.test(m))) {
      console.error('usage: node jobs-keys.mjs <seeds file> <jobs contract> <crews contract> nova onyx oracle');
      process.exit(2);
    }
    if (!existsSync(file)) {
      console.error(`${file} is not there: season-keys.ps1 writes the masks' seeds first, and the same file is MASK_KEYS`);
      process.exit(1);
    }
    try {
      console.log(JSON.stringify(jobKeys(JSON.parse(readFileSync(file, 'utf8')), jobs, crews, masks)));
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  }
}
