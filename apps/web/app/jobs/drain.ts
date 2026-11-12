// Post a job with a person's own NEAR wallet: a drain on the house's round of the day. The person types one line and a
// reward; the rest comes from the chain (the round sealing now, the contract's numbers for the deposit) and from the
// rules below, the same as scripts/mainnet/jobs.mjs --job writes for the owner. Nothing here signs: the wallet does.
//
// This file runs in the browser, so it imports nothing of Node's. post.ts builds the same call on the server with the
// arena's own builder (`openArgs`, `openCost`, `nearCliCommand`), and a test holds the two the same, so the call a
// wallet signs is the one the contract's rules were checked against.
import { slotAfter, slotAt } from '@maskwars/network';

const NEAR = 10n ** 24n;
const MINUTE = 60_000;

/**
 * A drain on the house's round, beside the person's line and reward. Four masks at 0.05 NEAR of fuel each, as the
 * sheet always started (1 NEAR of reward locks 1.64 NEAR in all), open to any mask; the windows of the owner's first
 * job (scripts/mainnet/jobs.mjs --job).
 */
export const DRAIN = {
  slots: 4,
  fuelPerMask: (NEAR / 20n).toString(),
  /** The masks reveal their steps for half an hour: the shortest reveal window they take a job with
   *  (packages/race/src/work.ts, `MIN_REVEAL_MS`). */
  revealMinutes: 30,
  appealMinutes: 10,
  maxWorkMinutes: 40,
  /** The work window ends this long before the round's seals do: the crew enlists while every mask may still seal. */
  marginMinutes: 5,
  /** Posting closes this long before the round's seals do: the masks' pass every quarter hour must find the job open. */
  leadMinutes: 25,
  /** The house opens its round this long after its slot: the first tick of the site's clock (vercel.json, 18:04 UTC). */
  openDelayMinutes: 4,
  /** `open` writes the job's record and sends back what the deposit does not use: 100 TGas (`OPEN_TGAS`). */
  gas: (100n * 10n ** 12n).toString(),
  /** The contract's least reward (`MIN_REWARD`). Fuel for every slot must fit in the reward as well. */
  minReward: (NEAR / 10n).toString(),
  maxBriefBytes: 280,
} as const;

/**
 * Room for jobs from outside on the round, as the arena's masks take them (packages/race/src/work.ts and sponsor.ts,
 * within the network's `limits.jobs`): how many more they take on it, and the accounts that hold as many live jobs with
 * them as one account may.
 */
export interface ArenaRoom {
  readonly left: number;
  readonly full: readonly string[];
}

/** The house's round as the server read it: the round sealing now, if any, and the server's clock at that moment. */
export interface HouseRound {
  /** The house's round runs on schedule on this network (`round.live` of packages/network). */
  readonly live: boolean;
  /** The bounty contract the house opens its rounds on. */
  readonly bounty: string;
  /** The house's latest round still open on chain: its id and the end of its seal window (ms, the chain's clock). */
  readonly round: { readonly id: string; readonly sealUntil: number } | null;
  /** The server's clock when it read this, ms: the sheet counts from it, not from the device's own clock. */
  readonly now: number;
  /** The arena's masks' room on that round; absent or `null` when it was not read. */
  readonly arena?: ArenaRoom | null;
}

/** The house's schedule: a slot every `every_minutes` from `first_minute`, and the minutes its round seals. */
export interface Schedule {
  readonly first_minute: number;
  readonly every_minutes: number;
  readonly commit_minutes: number;
}

/** What the server hands the sheet: the contract, what it locks beside the reward, and the house's round. */
export interface DrainSheet {
  /** The least reward the arena's masks take a job from outside for (`limits.jobs.min_reward`), yoctoNEAR. */
  readonly minReward: string;
  /** The arena's masks that take a job posted here, by name, and the bond MASK WARS locks for each of them, yoctoNEAR. */
  readonly arena: { readonly masks: readonly string[]; readonly bond: string };
  readonly network: string;
  readonly contract: string;
  /** The house's bounty contract: the round a drain follows is on it. */
  readonly bounty: string;
  /** Where a person opens a transaction; `null` for a local chain. */
  readonly explorer: string | null;
  /** yoctoNEAR the job locks beside its reward, by the contract's own `quote`: the masks' fuel, the judge's runs and
   *  the storage (what is not used comes back). */
  readonly costs: { readonly fuel: string; readonly judge: string; readonly storage: string };
  /** The company's fee, basis points of a paid reward. */
  readonly feeBps: number;
  /** The round as the server read it for this page; `null` when the chain did not answer then. */
  readonly house: HouseRound | null;
  readonly schedule: Schedule;
}

/**
 * Whether a job can be posted now, by the device's `now` set to the server's clock:
 * - `open`: the house's round seals for at least `leadMinutes` more. Posting closes then (`closesAt`); the job's work
 *   window runs until `marginMinutes` before the seals end, `maxWorkMinutes` at most.
 * - `opening`: the round of the day is due (the house opens it at its slot and `openDelayMinutes`) and is not on chain
 *   yet; posting would still be open.
 * - `closed`: the next window opens at `opensAt`.
 * - `booked`: as `open`, but the arena's masks take no more jobs from outside on this round: the next window opens at
 *   `opensAt`.
 * - `off`: the house's round does not run on schedule on this network: there is no window to wait for.
 */
export type PostWindow =
  | { readonly state: 'open'; readonly round: string; readonly bounty: string; readonly closesAt: number; readonly workMinutes: number }
  | { readonly state: 'opening' | 'closed'; readonly opensAt: number }
  /** The round is open, and the arena's masks take no more jobs from outside on it (`ArenaRoom.left`). */
  | { readonly state: 'booked'; readonly round: string; readonly opensAt: number }
  | { readonly state: 'off' };

export function postWindow(house: HouseRound, now: number, schedule: Schedule): PostWindow {
  if (!house.live) return { state: 'off' };
  const lead = DRAIN.leadMinutes * MINUTE;
  const r = house.round;
  if (r && r.sealUntil - now >= lead) {
    if (house.arena && house.arena.left <= 0) return { state: 'booked', round: r.id, opensAt: slotAfter(schedule, now) + DRAIN.openDelayMinutes * MINUTE };
    const workMinutes = Math.min(DRAIN.maxWorkMinutes, Math.floor((r.sealUntil - now) / MINUTE) - DRAIN.marginMinutes);
    return { state: 'open', round: r.id, bounty: house.bounty, closesAt: r.sealUntil - lead, workMinutes };
  }
  const delay = DRAIN.openDelayMinutes * MINUTE;
  const slot = slotAt(schedule, now);
  if (slot !== null) {
    const opens = slot + delay;
    const closes = opens + (schedule.commit_minutes - DRAIN.leadMinutes) * MINUTE;
    // Today's round is on chain once a round seals past today's slot; until then it is due, or not yet.
    const today = r !== null && r.sealUntil > slot;
    if (now < opens) return { state: 'closed', opensAt: opens };
    if (now < closes && !today) return { state: 'opening', opensAt: opens };
  }
  return { state: 'closed', opensAt: slotAfter(schedule, now) + delay };
}

/** NEAR as a person types it (`1`, `0.5`, `2,5`) → yoctoNEAR; `null` when it is not an amount. */
export function rewardYocto(text: string): bigint | null {
  const m = /^(\d{0,7})(?:\.(\d{0,6}))?$/.exec(text.trim().replace(',', '.'));
  const whole = m?.[1] ?? '';
  const frac = m?.[2] ?? '';
  if (!m || (whole === '' && frac === '')) return null;
  return BigInt(whole || '0') * NEAR + BigInt((frac + '0'.repeat(24)).slice(0, 24));
}

/**
 * The least reward a drain of `DRAIN.slots` masks takes: the contract's least, fuel for every slot, and the least the
 * arena's masks take a job from outside for (`minReward`, the network's `limits.jobs.min_reward`).
 */
export function leastReward(minReward: bigint | string = 0n): bigint {
  return [BigInt(DRAIN.fuelPerMask) * BigInt(DRAIN.slots), BigInt(DRAIN.minReward), BigInt(minReward)].reduce((a, b) => (a > b ? a : b));
}

const bytes = (text: string) => new TextEncoder().encode(text).length;

/** Why the contract would refuse this line as a brief, or null. */
export function briefProblem(brief: string): string | null {
  const n = bytes(brief.trim());
  if (n === 0) return 'Say in one line what the masks should do.';
  if (n > DRAIN.maxBriefBytes) return `One line: ${DRAIN.maxBriefBytes} bytes at most, this one is ${n}.`;
  return null;
}

/** Why the contract, or the arena's masks, would refuse this reward, or null. */
export function rewardProblem(text: string, minReward: bigint | string = 0n): string | null {
  // `1,000` reads as a thousand to some and as one to others: neither is guessed.
  if (/^\d{1,3}(,\d{3})+$/.test(text.trim())) return 'Write the reward as 1000 or 1.5.';
  const y = rewardYocto(text);
  if (y === null) return 'The reward is an amount of NEAR, like 1 or 0.5.';
  const least = leastReward(minReward);
  if (y < least) {
    return BigInt(minReward) >= least ? `The reward is at least ${nearText(least)} NEAR: the arena’s masks take a job from that.` : `The reward is at least ${nearText(least)} NEAR: it covers the fuel of ${DRAIN.slots} masks.`;
  }
  return null;
}

/**
 * What the job's record keeps on chain once the job ends, at most: its terms, its brief of up to 280 bytes and its
 * verdict, well under this. Measured on the local sandbox: 0.006 NEAR with a short brief, 0.0085 with the longest
 * (packages/race/scripts/jobs-sandbox.ts world, `open` then `cancel`). Everything else of the deposit comes back.
 */
export const RECORD_KEEPS = (NEAR / 50n).toString();

/** What comes back to the person after the round at least, whoever wins: everything beside the reward but the record. */
export function drainBack(costs: DrainSheet['costs']): bigint {
  const back = BigInt(costs.fuel) + BigInt(costs.judge) + BigInt(costs.storage) - BigInt(RECORD_KEEPS);
  return back > 0n ? back : 0n;
}

/** yoctoNEAR exact, with no trailing zeros: `1.64`. */
export function nearText(yocto: bigint | string): string {
  const v = BigInt(yocto);
  const frac = (v % NEAR).toString().padStart(24, '0').replace(/0+$/, '');
  return `${v / NEAR}${frac ? `.${frac}` : ''}`;
}

/** The brief a drain on `round` starts with: the person may write any other line. */
export const defaultBrief = (round: string | null) => (round ? `Drain the house vault in ${round}.` : 'Drain today’s house vault.');

/** A new job id on `round`: the round's id and six letters or digits of the person's own, 64 characters at most. */
export function jobIdOf(round: string, salt: string): string {
  const tail = salt.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6);
  return `${round.slice(0, 64 - tail.length - 1)}-${tail}`;
}

/** Six random letters and digits, for `jobIdOf`. */
export function freshSalt(): string {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => abc[b % abc.length]).join('');
}

/** sha256 of the brief, lowercase hex: the job's spec. The brief is the whole spec of a drain. */
export async function specOf(brief: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(brief));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface DrainJob {
  readonly id: string;
  readonly brief: string;
  readonly spec: string;
  readonly reward: bigint;
  readonly round: { readonly bounty: string; readonly id: string };
  readonly workMinutes: number;
}

/** The arguments of `open`, in the contract's own names and order (`openArgs`): a drain names its round, no judge. */
export function drainArgs(job: DrainJob): Record<string, unknown> {
  return {
    id: job.id,
    kind: 'drain',
    brief: job.brief,
    spec: job.spec,
    rubric: null,
    judge_version: null,
    round: { bounty: job.round.bounty, id: job.round.id },
    secrets: null,
    bar: null,
    reward: job.reward.toString(),
    fuel_per_mask: DRAIN.fuelPerMask,
    slots: DRAIN.slots,
    open_to: { who: 'anyone' },
    work_minutes: job.workMinutes,
    reveal_minutes: DRAIN.revealMinutes,
    appeal_minutes: DRAIN.appealMinutes,
    bond: null,
    client_key: null,
  };
}

/** What `open` takes for this reward: the reward and everything beside it, by the contract's `quote`. */
export function drainDeposit(reward: bigint, costs: DrainSheet['costs']): bigint {
  return reward + BigInt(costs.fuel) + BigInt(costs.judge) + BigInt(costs.storage);
}

/** The one function call the person's wallet signs on the jobs contract. */
export function drainCall(job: DrainJob, costs: DrainSheet['costs']) {
  return {
    type: 'FunctionCall' as const,
    params: { methodName: 'open', args: drainArgs(job), gas: DRAIN.gas, deposit: drainDeposit(job.reward, costs).toString() },
  };
}

/** The same call as one NEAR CLI command (near-cli-rs), for an agent: the arguments the contract reads as none left out. */
export function drainCommand(network: string, contract: string, signer: string, job: DrainJob, costs: DrainSheet['costs']): string {
  const args = Object.fromEntries(Object.entries(drainArgs(job)).filter(([, v]) => v !== null));
  const quoted = `'${JSON.stringify(args).replace(/'/g, "'\\''")}'`;
  const tgas = BigInt(DRAIN.gas) / 10n ** 12n;
  return `near contract call-function as-transaction ${contract} open json-args ${quoted} prepaid-gas '${tgas} Tgas' attached-deposit '${nearText(drainDeposit(job.reward, costs))} NEAR' sign-as ${signer} network-config ${network} sign-with-keychain send`;
}

/** The account a person signs with, as a stand-in of this network. */
export const anyAccount = (network: string) => (network === 'mainnet' ? 'YOUR_ACCOUNT.near' : network === 'testnet' ? 'YOUR_ACCOUNT.testnet' : 'YOUR_ACCOUNT.test.near');
