// "Post a job": the one call that opens a job on the jobs contract, written out for the client's own wallet. The site
// signs nothing and holds no key. The contract, the judge's exact wasm and the deposit come from the chain; what only
// the client knows (its account, the job's id and brief, the hashes of its material, its keys) stands in capitals for
// it to replace.
import { type JobBoard, type Kind, type OpenInput, nearCliCommand, openAction, openCost, openableKinds } from '@maskwars/arena/jobs';
import { near } from '@maskwars/arena/format';
import { type Network, yocto } from '@maskwars/network';
import { DRAIN, type DrainSheet, type HouseRound } from './drain';
import { KIND_WORD } from './show';

const NEAR = 10n ** 24n;

/** A starting point a client edits: a job of 1 NEAR for four masks, a day to work, an hour to reveal and to appeal. */
const START = { reward: NEAR.toString(), fuelPerMask: DRAIN.fuelPerMask, slots: DRAIN.slots, workMinutes: 24 * 60, revealMinutes: 60, appealMinutes: 60 } as const;

export interface PostCall {
  kind: Kind;
  word: string;
  /** The whole NEAR CLI command. */
  command: string;
  /** NEAR the call attaches, and where it goes. */
  deposit: string;
  parts: { label: string; value: string }[];
  /** What the client replaces before it signs. */
  fill: { name: string; what: string }[];
}

/** The account a client signs with, as a name of this network. */
function clientOf(network: string): string {
  return network === 'mainnet' ? 'YOUR_ACCOUNT.near' : network === 'testnet' ? 'YOUR_ACCOUNT.testnet' : 'YOUR_ACCOUNT.test.near';
}

function template(kind: Kind, board: JobBoard): { input: OpenInput; fill: PostCall['fill'] } {
  const base = { id: 'YOUR-JOB-ID', brief: 'ONE LINE: WHAT TO DO', spec: 'SHA256_OF_YOUR_SPEC', ...START };
  const common = [
    { name: 'YOUR_ACCOUNT', what: 'the account that pays for the job and signs this call' },
    { name: 'YOUR-JOB-ID', what: 'a new id: lowercase letters, digits, - or _' },
    { name: 'ONE LINE: WHAT TO DO', what: 'the brief every mask reads, 280 bytes at most' },
    { name: 'SHA256_OF_YOUR_SPEC', what: 'the sha256 of the full spec you published' },
  ];
  const numbers = { name: 'reward, fuel_per_mask, slots, minutes', what: 'yours to change: amounts are yoctoNEAR, 1 NEAR is 1 and 24 zeros' };
  if (kind === 'drain') {
    return {
      input: { ...base, kind, round: { bounty: board.market?.bounties[0] ?? '', id: 'THE-ROUND-ID' } },
      fill: [...common, { name: 'THE-ROUND-ID', what: 'the sealed round whose vault the masks break' }, numbers],
    };
  }
  const sealed = [
    { name: 'YOUR_REFERENCE_BOX', what: 'your own reference work, sealed for the judge’s key with box.mjs: it must clear the bar' },
    { name: 'x25519:YOUR_KEY', what: 'your public key from box.mjs keygen: the winning work is sealed for it' },
  ];
  if (kind === 'ai_review') {
    return {
      input: { ...base, kind, rubric: 'SHA256_OF_YOUR_RUBRIC', bar: { winAt: 60, reference: 'YOUR_REFERENCE_BOX' }, clientKey: 'x25519:YOUR_KEY' },
      fill: [...common, { name: 'SHA256_OF_YOUR_RUBRIC', what: 'the sha256 of the rubric you published' }, ...sealed, { name: 'win_at', what: 'points of 100 a review needs to win, 80 at most' }, numbers],
    };
  }
  return {
    input: { ...base, kind, rubric: 'SHA256_OF_YOUR_TEST_SET', secretsProfile: 'YOUR-SECRETS-PROFILE', bar: { winAt: 3, cases: 4, fuel: '1000000', reference: 'YOUR_REFERENCE_BOX' }, clientKey: 'x25519:YOUR_KEY' },
    fill: [
      ...common,
      { name: 'SHA256_OF_YOUR_TEST_SET', what: 'the sha256 of your private test set' },
      { name: 'YOUR-SECRETS-PROFILE', what: 'the profile of your OutLayer secrets that holds the test set' },
      ...sealed,
      { name: 'win_at, cases, fuel', what: 'cases in your test set, how many a work must pass, the fuel each may burn' },
      numbers,
    ],
  };
}

/** Arguments the contract reads as "none" need not be sent, at any depth: the call stays short enough to read. */
function compact(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => [k, typeof v === 'object' && !Array.isArray(v) ? compact(v as Record<string, unknown>) : v]),
  );
}

/**
 * The call for every kind of job this contract can open now: none while it is not deployed, or while it has no judge
 * and follows no bounty contract. Then the board offers no way to post.
 */
export function postCalls(board: JobBoard): PostCall[] {
  const { contract, market } = board;
  if (!board.deployed || !contract || !market) return [];
  return openableKinds(market).map((kind) => {
    const { input, fill } = template(kind, board);
    const action = openAction(contract, clientOf(board.network), input, market);
    const cost = openCost(input.reward, input.fuelPerMask, input.slots, market.judgeFee);
    return {
      kind,
      word: KIND_WORD[kind],
      command: nearCliCommand(board.network, { ...action, args: compact(action.args) }),
      deposit: near(cost.total),
      parts: [
        { label: 'Reward', value: `${near(cost.reward)} NEAR` },
        { label: `Fuel for ${input.slots} masks’ minds`, value: `${near(cost.fuel)} NEAR` },
        { label: 'The judge’s runs', value: `${near(cost.judge)} NEAR` },
        { label: 'Storage, what is free comes back', value: `${near(BigInt(cost.reserve) + BigInt(cost.record))} NEAR` },
      ],
      fill,
    };
  });
}

/**
 * The sheet that posts a drain with the person's own NEAR wallet: on the house's round of the day, wherever the
 * contract opens drains on the house's bounty contract and the house's round runs on schedule. Elsewhere `null`: the
 * sheet hands out the call for an agent to sign, as for every other kind. `house` is the round as the server read it
 * now, `null` when the chain did not answer: the sheet reads it again when it opens.
 */
export function drainSheet(board: JobBoard, net: Pick<Network, 'bounty' | 'round' | 'masks' | 'limits'>, house: HouseRound | null, explorer: string | null): DrainSheet | null {
  const { contract, market } = board;
  if (!board.deployed || !contract || !market || !net.round.live) return null;
  if (!openableKinds(market).includes('drain') || !market.bounties.includes(net.bounty)) return null;
  const cost = openCost('0', DRAIN.fuelPerMask, DRAIN.slots, market.judgeFee);
  const { first_minute, every_minutes, commit_minutes } = net.round;
  return {
    minReward: yocto(net.limits.jobs.min_reward).toString(),
    // The bond a job posted here asks of each mask is its fuel (`bond` left out): MASK WARS locks it for each of them.
    arena: { masks: Object.keys(net.masks), bond: DRAIN.fuelPerMask },
    network: board.network,
    contract,
    bounty: net.bounty,
    explorer,
    costs: { fuel: cost.fuel, judge: cost.judge, storage: (BigInt(cost.reserve) + BigInt(cost.record)).toString() },
    feeBps: market.feeBps,
    house: house && house.bounty === net.bounty ? house : null,
    schedule: { first_minute, every_minutes, commit_minutes },
  };
}
