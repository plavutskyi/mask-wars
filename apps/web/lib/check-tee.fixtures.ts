// Signed MASK CHECK answers for tests: an ed25519 signer from a seed, a check as the module reads it, and the answer
// as services/check/src/lib.rs writes it. Real signatures, so the site's verifier and verify.mjs judge them for real.
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { CheckResult } from '@maskwars/check';
import type { TeeDeployment } from '@maskwars/mcp';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes: Buffer): string {
  let n = BigInt(`0x${bytes.toString('hex') || '0'}`);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** An ed25519 signer from a 32-byte seed, with its key as NEAR writes it. */
export function signer(seedHex: string) {
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seedHex, 'hex')]), format: 'der', type: 'pkcs8' });
  const raw = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { key: `ed25519:${b58(Buffer.from(raw))}`, sign: (text: string) => sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64') };
}

export const PROJECT = signer('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
export const FORGER = signer('4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb');
export const SAMPLE = JSON.parse(readFileSync(new URL('../../../services/check/sample.json', import.meta.url), 'utf8')) as {
  output: { check: CheckResult; module: { version: string; rules: string }; signed: { key: string } };
};
export const RULES = SAMPLE.output.module.rules;
export const WASM = 'e31b34425df79da9a33eeeef70431d010e677aa75d456a40fb073ed2b24799cf';
export const NOW = Date.parse('2026-11-12T12:00:00Z');

export const DEPLOYED: TeeDeployment = {
  outlayer: 'mainnet',
  api: 'https://api.outlayer.ai',
  project: 'maskwars.near/check',
  price_usd_micro: 10_000,
  wasm_sha256: WASM,
  rules: RULES,
  key: PROJECT.key,
};

/** What the module says about the arena's drained mainnet safe, read `ago` seconds before NOW. */
export function checkOf(account = 'safe-0001.maskwars.near', ago = 12): CheckResult {
  const time = new Date(NOW - ago * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    account,
    network: 'mainnet',
    verdict: 'block',
    summary: 'BLOCK: Drained on the MASK WARS arena.',
    reasons: [{ code: 'arena_drained', level: 'block', text: 'Drained on the MASK WARS arena.', evidence: { race: 'race-0001', winner: 'oracle.maskwars.near' } }],
    block: { height: 175_000_000, hash: 'CT51tgpxrixX98tcLChtTcGvqf15YgN5avpx2a3XgXjW', time },
    checked_at: time,
    rpc: ['https://rpc.mainnet.fastnear.com', 'https://near.drpc.org'],
  };
}

/** The module's signed answer, as services/check/src/lib.rs writes it: the message first, then the fields. */
export function signedAnswer(check: CheckResult, { by = PROJECT, names = by.key, rules = RULES, shown = check }: { by?: typeof PROJECT; names?: string; rules?: string; shown?: CheckResult } = {}) {
  const message = JSON.stringify({ maskwars_check: 2, module: { version: '0.2.0', rules }, ...check });
  return { tier: 'signed', check: shown, signed: { alg: 'ed25519', key: names, message, signature: by.sign(message) }, module: { version: '0.2.0', rules }, attached_usd_micro: 10_000 };
}

/** OutLayer's reply to a synchronous call. */
export const run = (module: unknown, extra: Record<string, unknown> = {}) => ({
  call_id: 'call-1',
  status: 'completed',
  output: { success: true, output: module, error: null },
  attestation_url: '/attestations/call-1',
  ...extra,
});
