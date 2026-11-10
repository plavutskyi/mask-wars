// Prepares store_secrets for the judge's GITHUB_TOKEN without the OutLayer dashboard. The token comes from
// MASK_JUDGE_TOKEN, goes only to GitHub for a test read, and is written out sealed for OutLayer's keystore.
// Sealing is ECIES v1 as in out-layer/outlayer-cli src/crypto.rs:
// 0x01 | ephemeral X25519 public key (32) | nonce (12) | ChaCha20-Poly1305 ciphertext and tag.
import { createCipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PROBE = 'https://api.github.com/repos/plavutskyi/mask-wars-hq/actions/runs/42198804982';
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');

export function seal(pubkeyHex, plaintext) {
  const recipient = createPublicKey({ key: Buffer.concat([X25519_SPKI, Buffer.from(pubkeyHex, 'hex')]), format: 'der', type: 'spki' });
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const shared = diffieHellman({ privateKey, publicKey: recipient });
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), 'outlayer-keystore-v1', 32));
  const nonce = randomBytes(12);
  const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  const ephemeral = publicKey.export({ format: 'der', type: 'spki' }).subarray(X25519_SPKI.length);
  return Buffer.concat([Buffer.from([1]), ephemeral, nonce, body]).toString('base64');
}

// The judge's OutLayer project belongs to the admin of the network, and OutLayer keeps each network's secrets apart:
//   node judge-token.mjs <out> [owner] [api]   # tinygif8324.testnet on https://testnet-api.outlayer.ai by default
async function main() {
  const token = (process.env.MASK_JUDGE_TOKEN ?? '').trim();
  const [out, OWNER = 'tinygif8324.testnet', api = 'https://testnet-api.outlayer.ai'] = process.argv.slice(2);
  const PROJECT = `${OWNER}/judge`;
  if (!token || !out) throw new Error('no token');

  const probe = await fetch(PROBE, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'maskwars-judge' },
  });
  if (probe.status !== 200) throw new Error(`GitHub answered ${probe.status}: this token cannot read the race. Nothing was stored.`);
  console.log('GitHub accepts this token.');

  const res = await fetch(`${api.replace(/\/$/, '')}/secrets/pubkey`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessor: { type: 'Project', project_id: PROJECT }, owner: OWNER, profile: 'default', secrets_json: '{}' }),
  });
  if (!res.ok) throw new Error(`OutLayer answered ${res.status}`);
  const { pubkey } = await res.json();

  writeFileSync(out, JSON.stringify({
    accessor: { Project: { project_id: PROJECT } },
    profile: 'default',
    encrypted_secrets_base64: seal(pubkey, JSON.stringify({ GITHUB_TOKEN: token })),
    access: { Whitelist: { accounts: [OWNER] } },
    vault_id: null,
  }));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
