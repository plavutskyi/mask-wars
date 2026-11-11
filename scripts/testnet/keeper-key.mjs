// The keeper's seed for keeper-key.ps1. One secret seed, KEEPER_SEED, gives the keeper everything it signs with, the
// same way as packages/race/src/keeper.ts: its own function-call key on the mask factory (arm, settle, note and share only) is the
// ed25519 key whose 32-byte seed is HMAC-SHA256(seed, "maskwars-keeper-key:" + factory), and each person's mask gets
// two new race keys every round from HMAC-SHA256(seed, "maskwars-human-key:" + mask + ":" + round + ":" + receiver).
//
// A new seed goes to the file given, in the form of the secret KEEPER_SEED of the `live-race` environment (64 hex); a
// seed already in the file is kept. The public half of the keeper's key goes to stdout for keeper-key.ps1 to put on
// the keeper's account.
//   node keeper-key.mjs <file> <factory>
import { createHmac, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { base58 } from './season-keys.mjs';

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

function publicOf(seed) {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });
  return `ed25519:${base58(createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(12))}`;
}

/** The public half of the keeper's own key on `factory`. */
export function keeperPublicKey(seedHex, factory) {
  return publicOf(createHmac('sha256', Buffer.from(seedHex, 'hex')).update(`maskwars-keeper-key:${factory}`, 'utf8').digest());
}

/** The public half of a person's mask's race key for one round and one receiver. */
export function humanPublicKey(seedHex, mask, round, receiver) {
  return publicOf(createHmac('sha256', Buffer.from(seedHex, 'hex')).update(`maskwars-human-key:${mask}:${round}:${receiver}`, 'utf8').digest());
}

const main = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (main) {
  const [file, factory] = process.argv.slice(2);
  if (!file || !factory) {
    console.error('usage: node keeper-key.mjs <file> <factory>');
    process.exit(2);
  }
  const kept = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  const seed = /^[0-9a-f]{64}$/.test(kept) ? kept : randomBytes(32).toString('hex');
  if (seed !== kept) writeFileSync(file, seed);
  console.log(keeperPublicKey(seed, factory));
}
