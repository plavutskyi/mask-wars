// Prints the three near-cli commands that put `home` (contracts/home) on the arena's own masks on mainnet: NOVA, ONYX
// and ORACLE, one command each, every one signed by that mask's own full key from the owner's keychain. Nothing is
// signed or sent here, and nothing is read from the chain. The near-cli is the one the owner's scripts use,
// .scratch\near\near.exe (scripts/testnet/config.ps1), called from PowerShell, or `near` where there is none.
//
//   node scripts/mainnet/home-deploy.mjs
//
// The code is the file in apps/web/public/contracts named after its sha256, the build of contracts/home/build.sh, and
// it goes out only if it hashes to `home_code` in packages/network/mainnet.json: the code the house's day calls
// `home()` on. stdout holds the three commands and nothing else; what the code is and what it costs goes to stderr.
// near-cli then asks how to finish each one: choose "send".
//
// With home on a mask, anyone may call `home()` on it, and all it does is send what the mask holds above 0.4 NEAR and
// the stake of its own storage to house.maskwars.near. The masks' keys stay as they are: their function-call keys on
// the bounty contract and the vault play rounds as before.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** NEAR locks this much for every byte an account stores. */
const BYTE_COST = 10n ** 19n;

/** A code hash as NEAR shows it, base58 of 32 bytes → the sha256 in lowercase hex. */
export function codeHashHex(codeHash) {
  let n = 0n;
  for (const c of codeHash) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`not a code hash: ${codeHash}`);
    n = n * 58n + BigInt(i);
  }
  return n.toString(16).padStart(64, '0');
}

/** yoctoNEAR → NEAR with four decimals. */
const near = (y) => `${y / 10n ** 24n}.${String((y % 10n ** 24n) / 10n ** 20n).padStart(4, '0')}`;

/** A path on the owner's PowerShell command line: quoted, literally, when it holds a space or a quote. */
const arg = (path) => (/[\s']/.test(path) ? `'${path.replaceAll("'", "''")}'` : path);

/**
 * The deploy of home on each of the network's masks. Throws when the network names no home code, or when the
 * repository does not hold a file whose bytes hash to it.
 */
export function homeDeploy(repo, networkId = 'mainnet') {
  const net = JSON.parse(readFileSync(join(repo, 'packages', 'network', `${networkId}.json`), 'utf8'));
  if (!net.home_code) throw new Error(`packages/network/${networkId}.json names no home_code: nothing to deploy`);
  const hex = codeHashHex(net.home_code);
  const dir = join(repo, 'apps', 'web', 'public', 'contracts');
  const name = readdirSync(dir).find((f) => f === `maskwars-home-${networkId}-${hex}.wasm`);
  if (!name) throw new Error(`apps/web/public/contracts holds no maskwars-home-${networkId}-${hex}.wasm, the code home_code names`);
  const wasm = join(dir, name);
  const bytes = readFileSync(wasm);
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== hex) throw new Error(`${name} hashes to ${sha}, not to home_code ${net.home_code}: nothing to deploy`);
  const masks = Object.values(net.masks);
  const exe = join(repo, '.scratch', 'near', 'near.exe');
  // PowerShell runs a quoted path only after `&`.
  const cli = existsSync(exe) ? `& '${exe.replaceAll("'", "''")}'` : 'near';
  return {
    wasm,
    bytes: bytes.length,
    sha256: sha,
    code: net.home_code,
    house: net.house,
    keep: net.round.mask_keep,
    stake: near(BigInt(bytes.length) * BYTE_COST),
    commands: masks.map(
      (mask) => `${cli} contract deploy ${mask} use-file ${arg(wasm)} without-init-call network-config ${networkId} sign-with-keychain`,
    ),
  };
}

const main = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (main) {
  try {
    const d = homeDeploy(fileURLToPath(new URL('../../', import.meta.url)));
    console.error(`home for mainnet: ${d.wasm}, ${d.bytes} bytes, sha256 ${d.sha256}, code hash ${d.code}`);
    console.error(`it sends what a mask holds above ${d.keep} NEAR and its storage to ${d.house}, and nowhere else`);
    console.error(`each deploy locks ${d.stake} NEAR of the mask's own balance for the code; its gas is under 0.001 NEAR`);
    console.error('run each line below; near-cli asks how to finish: choose "send"');
    for (const c of d.commands) console.log(c);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
