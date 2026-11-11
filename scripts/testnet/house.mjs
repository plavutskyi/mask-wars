// Helpers of house.ps1, the owner's script for the house: the plain account that opens the daily round on the vault
// (packages/race/src/house.ts). The network is MASKWARS_NETWORK and the RPC is NEAR_RPC, both set by house.ps1.
//
//   node house.mjs key <file>
// A new full-access key for the house's account, for the Season workflow: the secret half goes to <file>, in the form
// the secret HOUSE_KEY takes (ed25519:…), its public half to <file without .txt>.public.txt (what `-DropHotKey`
// deletes later), and the public half to stdout for house.ps1 to put on the house's account.
//
//   node house.mjs collect [--sample]
// What each of the arena's own masks sends home to the house: everything it holds above round.mask_keep of
// packages/network, in whole thousandths of a NEAR, and nothing below 0.01 NEAR. Read from the chain; as JSON on
// stdout. It stops when the house would hold more than limits.house_max. --sample reads nothing: each mask holds one
// NEAR more than it keeps.
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { base58 } from './season-keys.mjs';

const NEAR = 10n ** 24n;
const MILLI = NEAR / 1000n;
/** A transfer smaller than this is not worth its own signature. */
export const LEAST = 10n * MILLI;

/** NEAR as a decimal string ("0.35") → yoctoNEAR. */
export function yocto(near) {
  const m = /^(0|[1-9]\d{0,8})(\.(\d{1,24}))?$/.exec(near);
  if (!m) throw new Error(`not an amount of NEAR: ${near}`);
  return BigInt(m[1]) * NEAR + BigInt((m[3] ?? '').padEnd(24, '0'));
}

/** yoctoNEAR → NEAR with three decimals, rounded down: what near.exe is told to send. */
export const milli = (y) => `${y / NEAR}.${String((y % NEAR) / MILLI).padStart(3, '0')}`;

/**
 * What goes home: for each mask, what it holds above `keep`, rounded down to 0.001 NEAR, when that is at least 0.01
 * NEAR. Throws when the house would then hold more than `houseMax`.
 */
export function homeTransfers({ masks, keep, house, houseMax }) {
  const transfers = masks
    .map((m) => ({ account: m.account, holds: m.amount, send: m.amount > keep ? ((m.amount - keep) / MILLI) * MILLI : 0n }))
    .filter((t) => t.send >= LEAST);
  const after = house + transfers.reduce((a, t) => a + t.send, 0n);
  if (after > houseMax) {
    throw new Error(`the house would hold ${milli(after)} NEAR, above limits.house_max of ${milli(houseMax)} NEAR: nothing is sent`);
  }
  return { transfers, after };
}

async function balance(rpc, account) {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'house', method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: account } }),
  });
  const body = await res.json();
  if (!body.result) throw new Error(`${account} is not on chain: ${body.error?.cause?.name ?? body.error?.name ?? 'no answer'}`);
  return BigInt(body.result.amount);
}

const main = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (main) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'key' && rest[0]) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
    const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16);
    writeFileSync(rest[0], `ed25519:${base58(Buffer.concat([seed, pub]))}`);
    writeFileSync(rest[0].replace(/\.txt$/, '') + '.public.txt', `ed25519:${base58(pub)}`);
    console.log(`ed25519:${base58(pub)}`);
  } else if (command === 'collect') {
    const id = process.env.MASKWARS_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
    const net = JSON.parse(readFileSync(new URL(`../../packages/network/${id}.json`, import.meta.url), 'utf8'));
    const rpc = process.env.NEAR_RPC || net.rpc[0];
    const keep = yocto(net.round.mask_keep);
    const sample = rest.includes('--sample');
    try {
      const masks = await Promise.all(Object.values(net.masks).map(async (account) => ({ account, amount: sample ? keep + NEAR : await balance(rpc, account) })));
      const house = sample ? 0n : await balance(rpc, net.house);
      const { transfers, after } = homeTransfers({ masks, keep, house, houseMax: yocto(net.limits.house_max) });
      console.log(JSON.stringify({
        house: net.house,
        holds: milli(house),
        after: milli(after),
        keep: net.round.mask_keep,
        transfers: transfers.map((t) => ({ account: t.account, holds: milli(t.holds), near: `${milli(t.send)} NEAR` })),
      }));
    } catch (e) {
      console.error(e.message);
      // Not process.exit: on Windows, Node 24 trips an assertion in libuv when it exits with fetch's sockets open.
      process.exitCode = 1;
    }
  } else {
    console.error('usage: node house.mjs key <file> | collect [--sample]');
    process.exit(2);
  }
}
