// The scheduler's function-call key for scheduler.ps1: the secret half goes to the file given, in the form the
// repository secret SCHEDULER_KEY takes (ed25519:…); the public half goes to stdout for scheduler.ps1 to put on chain.
//   node scheduler-key.mjs <file>
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { base58 } from './season-keys.mjs';

const [file] = process.argv.slice(2);
if (!file) {
  console.error('usage: node scheduler-key.mjs <file>');
  process.exit(2);
}
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16);
writeFileSync(file, `ed25519:${base58(Buffer.concat([seed, pub]))}`);
console.log(`ed25519:${base58(pub)}`);
