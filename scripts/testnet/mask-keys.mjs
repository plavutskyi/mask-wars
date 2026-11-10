// Makes the race keys of the masks for masks.ps1: per mask, one key for the safe and one for the bounty contract.
// The secret halves go to the file given as the first argument, in the shape of the secret MASK_KEYS of the
// `live-race` environment:
// {"NOVA":{"safe":"ed25519:…","claim":"ed25519:…"},…}. Masks already in the file keep their keys unless named again.
// Next to it, <file>.public.json holds the public halves of every mask's key on the bounty contract, in the shape of
// the repository variable MASK_CLAIM_KEYS: {"NOVA":"ed25519:…",…}; the race job seals a finding only for those.
// The public halves of the new keys go to stdout for masks.ps1 to put on chain.
//   node mask-keys.mjs <file> nova onyx oracle
//   node mask-keys.mjs --function-call-keys nova.tinygif8324.testnet   # the account's function-call keys, one per line
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

if (process.argv[2] === '--function-call-keys') {
  // What a rotation deletes: every function-call key the account holds now, read from the network's RPC (NEAR_RPC).
  const account = process.argv[3] ?? '';
  const res = await fetch(process.env.NEAR_RPC || 'https://rpc.testnet.fastnear.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'keys', method: 'query',
      params: { request_type: 'view_access_key_list', finality: 'final', account_id: account } }),
  });
  const body = await res.json();
  if (!body.result) {
    console.error(`no key list for ${account}: ${JSON.stringify(body.error ?? body)}`);
    process.exit(1);
  }
  for (const k of body.result.keys) if (typeof k.access_key.permission === 'object') console.log(k.public_key);
  process.exit(0);
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(bytes) {
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

function unbase58(text) {
  let n = 0n;
  for (const c of text) n = n * 58n + BigInt(B58.indexOf(c));
  const out = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of text) {
    if (c !== '1') break;
    out.unshift(0);
  }
  return Buffer.from(out);
}

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16);
  return { secret: `ed25519:${base58(Buffer.concat([seed, pub]))}`, public: `ed25519:${base58(pub)}` };
}

const [file, ...masks] = process.argv.slice(2);
if (!file || masks.length === 0 || !masks.every((m) => /^[a-z0-9-]+$/.test(m))) {
  console.error('usage: node mask-keys.mjs <file> nova onyx oracle');
  process.exit(2);
}
const secrets = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
const publics = {};
for (const m of masks) {
  const safe = keypair();
  const claim = keypair();
  secrets[m.toUpperCase()] = { safe: safe.secret, claim: claim.secret };
  publics[m] = { safe: safe.public, claim: claim.public };
}
writeFileSync(file, JSON.stringify(secrets));
// The public half of a secret key `ed25519:<base58 of seed and public key>` is its last 32 bytes.
const claimKeys = Object.fromEntries(
  Object.entries(secrets).map(([m, k]) => [m, `ed25519:${base58(unbase58(k.claim.slice(8)).subarray(32))}`]),
);
writeFileSync(file.replace(/\.json$/, '') + '.public.json', JSON.stringify(claimKeys));
console.log(JSON.stringify(publics));
