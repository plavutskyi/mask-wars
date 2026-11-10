// A sealed round with the people's masks beside ours, for human-round.ps1: reads the mask factory of the network, takes
// every forged mask that is ready to race (not paused, not in a race, fuel in its tank), at most 13 so that with NOVA,
// ONYX and ORACLE the round has 16, and writes the two argument files the script signs with: the safe's `new` (it owns
// itself, lets in exactly these masks, names the bounty contract as its arbiter and the team) and the round's
// `open_safe`. Every sealed sweep in such a round asks for min_loot, and `Live race` seals one plan a run, the sandbox's
// winner's: the safe holds one min_loot and a margin. A safe funded for every mask would keep the rest for good once a
// mask wins, since its team takes back only what a round nobody won left (live-safe `reclaim`).
// Our own masks need a key on the new safe too: their public halves come from their seeds in <dir>/mask-seeds.json
// (season-keys.ps1 keeps that file), the keys the drain job derives for this safe. The network is MASKWARS_NETWORK
// (human-round.ps1 sets it): its factory, team, bounty contract and masks come from packages/network/<network>.json.
// --sample, for a dry run: one stand-in person's mask and throwaway seeds, nothing read from the chain.
//   node human-round.mjs <dir> <n> [--sample]   # writes <dir>/human-safe-args.json and <dir>/human-round-args.json
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { racePublicKey } from './season-keys.mjs';

export const OURS = ['nova.tinygif8324.testnet', 'onyx.tinygif8324.testnet', 'oracle.tinygif8324.testnet'];
const NEAR = 10n ** 24n;
/** What one sealed sweep takes in a round with the people's masks. */
export const MIN_LOOT = NEAR / 2n;
/** The live safe's code takes about 1.55 NEAR of storage; the rest is what the masks race for. */
const CODE_NEAR = 16n * NEAR / 10n;
/** Plans one `Live race` run seals in a round: the winner's. */
export const SEALS = 1n;
/** On top of the sweeps: the storage the turns add, and room so a sweep never asks for the last yocto. */
export const MARGIN = NEAR / 10n;

/**
 * The round: its id and safe from `n`, the masks (ours, then the people's that can race), the windows, what the safe
 * holds and what the round's deposit is. `people` is the factory's `list_masks`.
 */
export function humanRound({ n, people, team = 'tinygif8324.testnet', bounty = 'bounty.tinygif8324.testnet', ours = OURS }) {
  if (!Number.isInteger(n) || n < 1 || n > 9999) throw new Error('n: the round number, 1 to 9999');
  const ready = people.filter((m) => m.state === 'ready' && BigInt(m.brain) > 0n).slice(0, 16 - ours.length);
  if (ready.length === 0) throw new Error("no person's mask is ready to race: nothing to open");
  const masks = [...ours, ...ready.map((m) => m.account)];
  const safe = `h${String(n).padStart(4, '0')}.${team}`;
  const id = `human-${String(n).padStart(4, '0')}`;
  // The plans a run seals each take min_loot in their own turn; nothing else ever leaves a won round's safe.
  const safeNear = CODE_NEAR + SEALS * MIN_LOOT + MARGIN;
  // The bounty contract keeps about 0.04 NEAR a mask for the round's storage; at least 0.1 NEAR goes to the winner.
  const depositMilli = 250n + 50n * BigInt(masks.length);
  return {
    id,
    safe,
    masks,
    people: ready.map((m) => m.account),
    safeNear: `${(safeNear * 100n) / NEAR / 100n}.${String(((safeNear * 100n) / NEAR) % 100n).padStart(2, '0')} NEAR`,
    deposit: `${depositMilli / 1000n}.${String(depositMilli % 1000n).padStart(3, '0')} NEAR`,
    init: { owner: safe, masks, arbiter: bounty, team },
    open: {
      id,
      safe,
      masks,
      min_loot: MIN_LOOT.toString(),
      hours: 24,
      // The keeper arms the people's masks and the race runs inside the commit window.
      commit_minutes: 60,
      reveal_minutes: Math.max(60, 3 * (masks.length + 1)),
    },
  };
}

const main = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (main) {
  const [dir, nText, flag] = process.argv.slice(2);
  const sample = flag === '--sample';
  const network = process.env.MASKWARS_NETWORK || 'testnet';
  if (network !== 'testnet' && network !== 'mainnet') {
    console.error(`MASKWARS_NETWORK: testnet or mainnet, not ${network}`);
    process.exit(2);
  }
  const net = JSON.parse(readFileSync(new URL(`../../packages/network/${network}.json`, import.meta.url), 'utf8'));
  const ours = Object.values(net.masks);
  const factory = process.env.MASK_FACTORY || net.factory;
  if (factory.endsWith('.testnet') !== (network === 'testnet')) {
    console.error(`MASK_FACTORY: ${factory} is not a ${network} account`);
    process.exit(2);
  }
  const rpc = process.env.NEAR_RPC || net.rpc[0];
  const view = async (method, args) => {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'h', method: 'query', params: { request_type: 'call_function', finality: 'final',
        account_id: factory, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }),
    });
    const body = await res.json();
    if (!body.result?.result) throw new Error(`${factory}.${method}: ${JSON.stringify(body.error ?? body)}`);
    return JSON.parse(Buffer.from(body.result.result).toString('utf8'));
  };
  try {
    const people = [];
    if (sample) {
      // A dry run: one stand-in that is ready to race, so the round below is the shape a real one takes.
      people.push({ account: `kira.${factory}`, state: 'ready', brain: '1000000000000000000000000' });
    } else {
      for (let from = 0; ; from += 50) {
        const page = await view('list_masks', { from_index: from, limit: 50 });
        people.push(...page);
        if (page.length < 50) break;
      }
    }
    const r = humanRound({ n: Number(nText), people, team: net.admin, bounty: net.bounty, ours });
    const seedsFile = join(dir, 'mask-seeds.json');
    if (!sample && !existsSync(seedsFile)) throw new Error(`${seedsFile} is missing: our masks need their seeds for a key on ${r.safe}`);
    const seeds = sample ? {} : JSON.parse(readFileSync(seedsFile, 'utf8'));
    const keys = Object.fromEntries(
      ours.map((account) => {
        const seed = sample ? randomBytes(32).toString('hex') : seeds[account.split('.')[0].toUpperCase()]?.seed;
        if (!seed) throw new Error(`${seedsFile} has no seed for ${account}`);
        return [account, racePublicKey(seed, r.safe)];
      }),
    );
    writeFileSync(join(dir, 'human-safe-args.json'), JSON.stringify(r.init));
    writeFileSync(join(dir, 'human-round-args.json'), JSON.stringify(r.open));
    console.log(JSON.stringify({ id: r.id, safe: r.safe, safeNear: r.safeNear, deposit: r.deposit, people: r.people, ours: keys }));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
