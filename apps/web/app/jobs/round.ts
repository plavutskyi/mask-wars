// The house's round as the "Post a job" sheet needs it: the round sealing now on the house's bounty contract (its id
// and the end of its seal window), read from the chain with no keys. The vault names its round (`get_round`), the
// bounty contract says whether it is still open (`get`) and until when it takes seals (`get_round`). One reading serves
// every visitor for a few seconds.
//
// JOBS_ROUND_FIXTURE answers instead of the chain, outside production only, as if the house's round ran on schedule:
// `open` (a round sealing for 41 more minutes, room for two jobs from outside), `booked` (the same round, the arena's
// masks taking no more jobs from outside on it), `late` (a round with 10 minutes of seals left: too late to post) or
// `closed` (no round). With JOBS_FIXTURE set and no round fixture there is no round: the jobs fixtures read no network,
// and neither does this.
import { BOND_STORAGE, OVER, outsideRules, outsideTermsBar, type Job, type JobBoard } from '@maskwars/arena/jobs';
import { ChainError, ChainReader, maskCheck, readerFor, sharedLists } from '@maskwars/check';
import { NET, bountyContracts, houseKeeps, teams, type Network } from '@maskwars/network';
import { DRAIN, type ArenaRoom, type HouseRound } from './drain';
import { getJobs } from './reader';

const TTL_MS = 10_000;
const MINUTE = 60_000;

let kept: { at: number; value: Promise<HouseRound> } | null = null;

const nsToMs = (ns: unknown): number | null => (typeof ns === 'string' && /^\d+$/.test(ns) ? Number(BigInt(ns) / 1_000_000n) : null);

/** A view that answers `null` where the contract or its account is not there (a vault between two rounds). */
async function viewOrNull<T>(rpc: ChainReader, contract: string, method: string, args: unknown): Promise<T | null> {
  try {
    return await rpc.view<T | null>(contract, method, args);
  } catch (error) {
    if (error instanceof ChainError && (error.kind === 'unknown_account' || error.kind === 'contract')) return null;
    throw error;
  }
}

/** What the house keeps for the gas of one transaction beside its bonds (packages/race/src/sponsor.ts, `TX_GAS_KEEP`). */
const TX_GAS_KEEP = 10n ** 22n;
/** A mask seals no step this close to the end of a work window (packages/race/src/work.ts, `STEP_MARGIN_MS`). */
const STEP_MARGIN_MS = 2 * MINUTE;

type RoomNet = Pick<Network, 'admin' | 'season' | 'house' | 'bounty' | 'older_bounty' | 'masks' | 'limits' | 'round' | 'guests'>;

const roundKey = (bounty: string, id: string) => `${bounty}/${id}`;

/**
 * Room for jobs from outside on round `round`, as the arena's masks and the house take them (packages/race/src/work.ts
 * and sponsor.ts): `limits.jobs` a round, of a client and of each mask's places, and the house's NEAR beyond what its
 * next round needs (`houseFree`, its balance less its storage; `null`: not read).
 *
 * What takes room is what the masks' own plan counts, and nothing else:
 * - the jobs the masks are on, and the jobs a bond of ours waits on for a mask (the house's, once it has locked it);
 * - the jobs posted before that the house would really lock its bonds on: they still take masks, their terms clear
 *   the plan's own bar (`outsideTermsBar`, the one function the plan, the house and this page read: the reward, the
 *   bond, windows of an hour at most with our own runs inside the reveal), their client is not one MASK CHECK blocks
 *   (`blocked`), and their round is one of ours that is open: this round, or one `ourRounds` names
 *   (`<bounty>/<round>`, read from the chain by `houseRoundOf`). A job with a window of days, or on a round somebody
 *   else opened, is never taken: however many of those anyone posts, they take no place and book nothing.
 * With `round.sealUntil`, a job posted on this page right now is read against the same bar: if the masks would not take
 * it, there is no room for it. A guess on the safe side: the masks' own pass decides, and it never takes more than this
 * leaves.
 */
export function arenaRoom(
  board: JobBoard,
  round: { id: string; bounty: string; sealUntil?: number },
  net: RoomNet,
  houseFree: bigint | null,
  blocked: ReadonlySet<string> = new Set(),
  ourRounds: ReadonlySet<string> = new Set(),
): ArenaRoom {
  const lim = net.limits.jobs;
  const rules = outsideRules(net);
  const masks = Object.values(net.masks);
  const ours = teams(net as Network);
  const now = board.readAt;
  const seatsOf = (j: Job) => j.entrants.flatMap((e) => e.members.filter((m) => !m.left && masks.includes(m.mask.account)).map((m) => m.mask.account));
  /** The masks a bond of ours waits for on the job: the house locked it, and no mask has taken its seat yet. */
  const bondedOf = (j: Job) => (j.phase === 'enlisting' ? (j.bonds ?? []).filter((b) => masks.includes(b.mask) && ours.includes(b.by)).map((b) => b.mask) : []);
  const holdOf = (j: Job) => [...new Set([...seatsOf(j), ...bondedOf(j)])];
  const outside = board.jobs.filter((j) => j.kind === 'drain' && !ours.includes(j.client) && !OVER.has(j.phase));
  const held = outside.filter((j) => holdOf(j).length > 0);
  const here = (j: Job) => j.judge.by === 'round' && j.judge.round === round.id && j.judge.bounty === round.bounty;
  const pending = outside.filter(
    (j) =>
      holdOf(j).length === 0 &&
      !blocked.has(j.client) &&
      j.phase === 'enlisting' &&
      j.room &&
      now < j.workUntil - STEP_MARGIN_MS &&
      j.judge.by === 'round' &&
      j.judge.state === 'open' &&
      (here(j) || ourRounds.has(roundKey(j.judge.bounty, j.judge.round))) &&
      outsideTermsBar(j, rules) === null,
  );
  const onRound = [...held, ...pending].filter(here);
  const roundLeft = lim.per_round - onRound.length;
  const busiest = Math.max(0, ...masks.map((m) => held.filter((j) => holdOf(j).includes(m)).length));
  const seatsLeft = lim.seats - busiest - pending.length;
  const perJob = BigInt(masks.length) * (BigInt(DRAIN.fuelPerMask) + BigInt(BOND_STORAGE)) + TX_GAS_KEEP;
  const spare = houseFree === null ? null : houseFree - houseKeeps(net) - BigInt(pending.length) * perJob;
  const houseLeft = spare === null ? Number.POSITIVE_INFINITY : spare < 0n ? 0 : Number(spare / perJob);
  const per = new Map<string, number>();
  for (const j of [...held, ...pending]) per.set(j.client, (per.get(j.client) ?? 0) + 1);
  // A job posted on this page right now, as the sheet would open it (drain.ts, `postWindow`): the masks take it only
  // if its own terms clear the bar.
  let taken = true;
  if (round.sealUntil !== undefined) {
    const work = Math.min(DRAIN.maxWorkMinutes, Math.floor((round.sealUntil - now) / MINUTE) - DRAIN.marginMinutes) * MINUTE;
    const posted = { reward: rules.minReward.toString(), bond: DRAIN.fuelPerMask, openedAt: now, workUntil: now + work, revealUntil: now + work + DRAIN.revealMinutes * MINUTE, appealMinutes: DRAIN.appealMinutes };
    taken = work > 0 && outsideTermsBar(posted, rules) === null;
  }
  return {
    left: taken ? Math.max(0, Math.min(roundLeft, seatsLeft, houseLeft)) : 0,
    full: [...per].filter(([, n]) => n >= lim.per_client).map(([c]) => c).sort(),
  };
}

/**
 * The rounds beside `round` that jobs from outside wait on and that are ours to play: on one of our bounty contracts,
 * opened by one of our teams, still open. Read from the chain for the jobs that would otherwise take room, one view a
 * round: a round anybody else opened is never one.
 */
async function ourRoundsOf(board: JobBoard, round: { id: string; bounty: string }, net: RoomNet, rpc: ChainReader): Promise<Set<string>> {
  const ours = teams(net as Network);
  const bounties = bountyContracts(net as Network);
  const rules = outsideRules(net);
  const asked = new Map<string, { bounty: string; id: string }>();
  for (const j of board.jobs) {
    if (j.kind !== 'drain' || ours.includes(j.client) || j.phase !== 'enlisting' || !j.room || j.judge.by !== 'round' || j.judge.state !== 'open') continue;
    if ((j.judge.round === round.id && j.judge.bounty === round.bounty) || !bounties.includes(j.judge.bounty) || outsideTermsBar(j, rules) !== null) continue;
    asked.set(roundKey(j.judge.bounty, j.judge.round), { bounty: j.judge.bounty, id: j.judge.round });
  }
  const out = new Set<string>();
  for (const [key, r] of asked) {
    const b = await viewOrNull<{ owner?: unknown; status?: { state?: unknown } }>(rpc, r.bounty, 'get', { id: r.id });
    if (typeof b?.owner === 'string' && ours.includes(b.owner) && b.status?.state === 'open') out.add(key);
  }
  return out;
}

/** The clients of jobs from outside that may still take the arena's masks: the ones MASK CHECK is asked about. */
export function waitingClients(board: JobBoard, net: Pick<Network, 'admin' | 'season' | 'house'>): string[] {
  const ours = teams(net as Network);
  return [...new Set(board.jobs.filter((j) => j.kind === 'drain' && j.phase === 'enlisting' && !ours.includes(j.client)).map((j) => j.client))].sort();
}

type Check = (account: string) => Promise<'allow' | 'warn' | 'block'>;
const CHECK_MS = 10 * MINUTE;
const verdicts = new Map<string, { at: number; blocked: boolean }>();

/** MASK CHECK on this network, as the masks' pass asks it (packages/race/scripts/jobs.ts); each word kept ten minutes. */
async function blockedOf(accounts: readonly string[], check: Check, now: number): Promise<Set<string>> {
  const out = new Set<string>();
  for (const a of accounts) {
    const kept = verdicts.get(a);
    if (kept && now - kept.at < CHECK_MS) {
      if (kept.blocked) out.add(a);
      continue;
    }
    // No answer is not a block: the job keeps its place, as the masks' pass keeps it waiting.
    const blocked = await check(a).then((v) => v === 'block').catch(() => null);
    if (blocked === null) continue;
    verdicts.set(a, { at: now, blocked });
    if (blocked) out.add(a);
  }
  return out;
}

/** The house's balance less the stake its storage locks; `null` when the chain did not say. */
async function houseFreeOf(rpc: ChainReader, house: string): Promise<bigint | null> {
  const a = await rpc.account(house).catch(() => null);
  if (!a) return null;
  const free = BigInt(a.amount) - BigInt(a.storageUsage) * 10n ** 19n;
  return free > 0n ? free : 0n;
}

/**
 * The house's latest round still taking seals or racing, read from `net` with `rpc`. With `board`, the arena's room for
 * jobs from outside on it too (`arenaRoom`); a reading that fails leaves the room unknown, never the round.
 */
export async function houseRoundOf(
  net: Pick<Network, 'bounty' | 'vault' | 'round'> & Partial<RoomNet>,
  rpc: ChainReader,
  now: number,
  board?: () => Promise<JobBoard>,
  check?: Check,
): Promise<HouseRound> {
  const base: HouseRound = { live: net.round.live, bounty: net.bounty, round: null, now };
  if (!net.round.live) return base;
  const lock = await viewOrNull<{ arbiter?: unknown; bounty?: unknown }>(rpc, net.vault, 'get_round', {});
  if (!lock || lock.arbiter !== net.bounty || typeof lock.bounty !== 'string') return base;
  const id = lock.bounty;
  const [bounty, round] = await Promise.all([
    viewOrNull<{ status?: { state?: unknown } }>(rpc, net.bounty, 'get', { id }),
    viewOrNull<{ commit_until?: unknown }>(rpc, net.bounty, 'get_round', { id }),
  ]);
  const sealUntil = nsToMs(round?.commit_until);
  if (bounty?.status?.state !== 'open' || sealUntil === null) return base;
  if (!board || !net.limits || !net.masks || !net.house) return { ...base, round: { id, sealUntil } };
  const room = await Promise.all([board(), houseFreeOf(rpc, net.house)])
    .then(async ([b, free]) => {
      if (!b.deployed || b.stale) return null;
      const blocked = check ? await blockedOf(waitingClients(b, net as RoomNet), check, now) : new Set<string>();
      const here = { id, bounty: net.bounty, sealUntil };
      return arenaRoom(b, here, net as RoomNet, free, blocked, await ourRoundsOf(b, here, net as RoomNet, rpc));
    })
    .catch(() => null);
  return { ...base, round: { id, sealUntil }, arena: room };
}

/** What a fixture shows, by the clock of `now`. */
export function fixtureRound(fixture: string, now: number, net: Pick<Network, 'bounty'> = NET): HouseRound {
  const base: HouseRound = { live: true, bounty: net.bounty, round: null, now };
  if (fixture === 'open') return { ...base, round: { id: 'race-0004', sealUntil: now + 41 * MINUTE }, arena: { left: 2, full: [] } };
  if (fixture === 'booked') return { ...base, round: { id: 'race-0004', sealUntil: now + 41 * MINUTE }, arena: { left: 0, full: [] } };
  if (fixture === 'late') return { ...base, round: { id: 'race-0004', sealUntil: now + 10 * MINUTE } };
  return base;
}

const checkReader = readerFor(NET.id, { env: process.env });
/** MASK CHECK as the masks' pass runs it: this network's reader and shared lists. */
const siteCheck: Check = async (account) => (await maskCheck(account, { network: NET.id, reader: checkReader, list: sharedLists[NET.id] })).verdict;

/**
 * The network the room is read by. Only in the walk-through's build (NEXT_PUBLIC_JOBS_TEST, which next.config.ts refuses
 * in production): its stand-in round opens when the walk starts, not at the house's slot, so the walk names the minute
 * of the day its round opened at and the site's clock is counted from there, as it is from the slot on mainnet.
 */
function roomNet(): typeof NET {
  const minute = Number(process.env.JOBS_CLOCK_FIRST_MINUTE ?? '');
  if ((process.env.NEXT_PUBLIC_JOBS_TEST ?? '').trim() === '' || process.env.JOBS_CLOCK_FIRST_MINUTE === undefined || !Number.isInteger(minute) || minute < 0 || minute >= 1440) return NET;
  return { ...NET, round: { ...NET.round, first_minute: minute } };
}

async function read(): Promise<HouseRound> {
  const now = Date.now();
  if (process.env.VERCEL_ENV !== 'production') {
    if (process.env.JOBS_ROUND_FIXTURE) return fixtureRound(process.env.JOBS_ROUND_FIXTURE, now);
    if (process.env.JOBS_FIXTURE) return { live: NET.round.live, bounty: NET.bounty, round: null, now };
  }
  return houseRoundOf(roomNet(), new ChainReader({ endpoints: getJobs().config.rpc }), now, () => getJobs().board(), siteCheck);
}

/** The house's round now. A reading that fails is not kept: the next visitor asks the chain again. */
export async function readHouseRound(): Promise<HouseRound> {
  const now = Date.now();
  if (kept && now - kept.at < TTL_MS) {
    const value = await kept.value;
    return { ...value, now };
  }
  const value = read();
  kept = { at: now, value };
  try {
    return await value;
  } catch (error) {
    kept = null;
    throw error;
  }
}
