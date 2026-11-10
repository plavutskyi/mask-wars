// Race keys of the masks for a season, from one seed per mask, for season-keys.ps1. NEAR gives a function-call key
// exactly one receiver, and every round of a season races on a new safe (s0001, s0002, … under the season's account),
// so each mask gets its keys ahead of time: one on the bounty contract and one on each of the next safes. The key for
// receiver R is the ed25519 key whose 32-byte seed is HMAC-SHA256(seed, "maskwars-race-key:" + R), the same as
// packages/race/src/keys.ts, so the race derives the private half it needs and the secret holds only the seed.
//
// The seeds go to the file given first, in the shape of the secret MASK_KEYS of the `live-race` environment:
// {"NOVA":{"seed":"…"},…}. A mask already in the file keeps its seed, so running it again for later safes gives the
// same keys for the same safes; --rotate gives the masks named new seeds. Next to it, <file>.public.json holds the
// public half of every mask's key on the bounty contract, in the shape of the repository variable MASK_CLAIM_KEYS:
// {"NOVA":"ed25519:…",…}; the race job seals the winning finding only for that key. The public halves of all keys go
// to stdout for season-keys.ps1 to put on chain.
//   node season-keys.mjs [--rotate] <file> <season account> <bounty contract> <first safe> <last safe> nova onyx oracle
import { createHmac, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const LABEL = 'maskwars-race-key:';
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

export function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

/** The public half of the mask's key for `receiver`, as NEAR writes it. */
export function racePublicKey(seedHex, receiver) {
  const seed = createHmac('sha256', Buffer.from(seedHex, 'hex')).update(LABEL + receiver, 'utf8').digest();
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });
  return `ed25519:${base58(createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(12))}`;
}

/** `s<nnnn>.<season>`: the n-th safe the season makes. */
export const safeAccount = (season, n) => `s${String(n).padStart(4, '0')}.${season}`;

const main = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (main) {
  const rotate = process.argv[2] === '--rotate';
  const [file, season, bounty, first, last, ...masks] = process.argv.slice(rotate ? 3 : 2);
  const from = Number(first);
  const to = Number(last);
  const ok =
    file && season && bounty && Number.isInteger(from) && Number.isInteger(to) && from >= 1 && to >= from && to - from < 90 &&
    masks.length > 0 && masks.every((m) => /^[a-z0-9-]+$/.test(m));
  if (!ok) {
    console.error('usage: node season-keys.mjs <file> <season> <bounty contract> <first safe> <last safe> nova onyx oracle');
    process.exit(2);
  }
  const secrets = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const publics = {};
  for (const m of masks) {
    const name = m.toUpperCase();
    const seed = (!rotate && secrets[name]?.seed) || randomBytes(32).toString('hex');
    secrets[name] = { seed };
    const safes = [];
    for (let n = from; n <= to; n++) safes.push({ safe: safeAccount(season, n), key: racePublicKey(seed, safeAccount(season, n)) });
    publics[m] = { bounty: racePublicKey(seed, bounty), safes };
  }
  writeFileSync(file, JSON.stringify(secrets));
  // MASK_CLAIM_KEYS: the one key per mask a finding is ever sealed for, its key on the bounty contract.
  const claimKeys = Object.fromEntries(Object.entries(secrets).map(([m, k]) => [m, racePublicKey(k.seed, bounty)]));
  writeFileSync(file.replace(/\.json$/, '') + '.public.json', JSON.stringify(claimKeys));
  console.log(JSON.stringify(publics));
}
