// Where MASK WARS lives on each NEAR network, and the limits of the money it moves there. One file per network,
// `testnet.json` and `mainnet.json`, read by everything that needs it: the site and its API, the arena reader, the
// race and the season jobs, and the owner's scripts in scripts/testnet (config.ps1 reads the same files). Which network
// a process reads is MASKWARS_NETWORK: `testnet` (the default) or `mainnet`. Anything else stops the process instead of
// quietly reading testnet.
import mainnetJson from "../mainnet.json" with { type: "json" };
import testnetJson from "../testnet.json" with { type: "json" };

export type NetworkId = "testnet" | "mainnet";

export const NETWORK_IDS: readonly NetworkId[] = ["testnet", "mainnet"];

/**
 * A part of MASK WARS that lives on chain: `arena` is the bounty contract and the arena's own masks, `season` the
 * treasury that opens a round on schedule, `forge` the factory of people's masks, `jobs` the jobs and crews contracts.
 */
export type Section = "arena" | "season" | "forge" | "jobs";

export const SECTIONS: readonly Section[] = ["arena", "season", "forge", "jobs"];

/** The limits of the money the arena moves on one network. Amounts in NEAR as decimal strings ("0.5"). */
export interface Limits {
  /** The season treasury's own limits (contracts/season `limits`), as `new` and `-Limits` give them. */
  readonly season: {
    /** The most one round's bounty may lock. */
    readonly max_prize: string;
    /** The most one safe of the season may hold. */
    readonly max_safe_fund: string;
    /** Rounds in any 24 hours. */
    readonly max_per_day: number;
  };
  /** Rounds the team opens by hand (open-safe.ps1, human-round.ps1): the scripts refuse to send more. */
  readonly hand: {
    /** The most a hand-opened round's deposit may be: the bounty and the storage it reserves. */
    readonly deposit_max: string;
    /** The most a safe made by hand may hold, its own code included. */
    readonly safe_max: string;
  };
  /**
   * The most the house may hold: house.ps1 refuses to bring it above this. Whoever holds the house's key, its hot key
   * included, can spend what the house holds and nothing else of the arena's.
   */
  readonly house_max: string;
  /** The most one season-fund.ps1 puts into the treasury. */
  readonly fund_max: string;
  /** The most a person may put into a mask they forge (the forge's biggest choice). The factory's least is 1 NEAR. */
  readonly fuel_max: string;
  /**
   * Mainnet only, the vault in NEAR Intents: the most one top-up quote asks for, in dollars (PAY_LIVE). It bounds what
   * the page asks the person to send, not the transfer: a larger one to the same address is still swapped into the
   * person's own vault.
   */
  readonly pay_usd_max?: number;
  /** Mainnet only: the most one hire may pay, in dollars (HIRE_LIVE). */
  readonly hire_usd_max?: number;
  /**
   * Jobs from outside that the arena's own masks take: drains on our rounds that none of our accounts opened, posted
   * by people on /jobs or by agents. The house locks the masks' bonds on such a job (packages/race/src/sponsor.ts) and
   * the masks take it (packages/race/src/work.ts), both within these; the "Post a job" sheet reads the same numbers.
   */
  readonly jobs: OutsideJobs;
}

/** The limits on jobs from outside that the arena's masks take (`Limits.jobs`). */
export interface OutsideJobs {
  /** The least reward of such a job, NEAR. */
  readonly min_reward: string;
  /**
   * The most a mask's bond on such a job may be, NEAR: the house locks it for each mask that takes the job, so a job
   * that asks more takes none of the house's NEAR. A job posted on /jobs asks the fuel of one mask, 0.05.
   */
  readonly max_bond: string;
  /** Such jobs the masks take on one round. */
  readonly per_round: number;
  /** Such jobs of one client the masks are on at once. */
  readonly per_client: number;
  /**
   * Such jobs one mask is on at once, of its four live places on the jobs contract (`MAX_LIVE_JOBS_PER_MASK`): the
   * rest always stay for the arena's own jobs.
   */
  readonly seats: number;
  /**
   * The most NEAR the house has out in bonds on such jobs at one time, waiting for a mask or held on its seat: counted
   * before the house signs anything. Never above what the limits themselves allow (`houseOutMost`).
   */
  readonly max_out: string;
  /**
   * The longest work window of such a job, minutes: a bond the house locked waits for its mask no longer than this.
   * A job posted on /jobs works for 40 minutes at most.
   */
  readonly max_work_minutes: number;
  /** The longest reveal window of such a job, minutes; the shortest is the masks' own half hour. */
  readonly max_reveal_minutes: number;
  /** The longest appeal window of such a job, minutes. */
  readonly max_appeal_minutes: number;
  /**
   * Runs of the site's clock (`JOBS_TICK_MINUTES`) that must fall inside such a job's reveal window: a seat that
   * reveals nothing loses half its bond, so the masks take a job from outside only when our own runs are sure to come
   * while its steps can be revealed.
   */
  readonly reveal_runs: number;
}

/** Live jobs one mask may be on at once: the jobs contract's `MAX_LIVE_JOBS_PER_MASK`. */
export const MAX_LIVE_JOBS_PER_MASK = 4;

/** What a bond's record may take while it waits for its mask, NEAR: the jobs contract's `BOND_RECORD_BYTES`, 400. */
export const JOB_BOND_STORAGE = "0.004";

/**
 * Minutes after the house's slot at which the site's clock starts the Jobs workflow (apps/web/vercel.json calls
 * /api/jobs-tick then, apps/web/lib/jobs-tick.ts): every five while people post a job on the house's round, then
 * through the reveals and to the round's end. GitHub's own quarter-hour schedule comes late on a quiet repository, or
 * not at all, so only these are counted on.
 */
export const JOBS_TICK_MINUTES: readonly number[] = [9, 14, 19, 24, 29, 34, 49, 59, 69, 89, 119, 149, 209, 269];
/**
 * A run the site's clock starts is sure to reveal a job's steps only when it starts at least this long before the
 * reveal window ends: the run GitHub starts on a tick checks the keys, lets the house act, and only then reveals.
 */
export const JOBS_TICK_LEAD_MINUTES = 10;

/**
 * The house's daily round. Amounts in NEAR as decimal strings. A slot comes every `every_minutes` from `first_minute`,
 * both counted in minutes since the Unix epoch, the way the season treasury counts its own (1080 and 1440: every day
 * at 18:00 UTC).
 */
export interface HouseRound {
  /**
   * The house's round really runs on schedule: the vault's code is on the bounty contract, the house is funded and the
   * Season workflow signs for it. Only then does the site tell when the next round opens; `false` until the owner says
   * so, whatever the chain shows.
   */
  readonly live: boolean;
  /**
   * The judge the house opens its rounds with, the sha256 of scripts/<network>/judge-args.json (a test keeps the two
   * the same). The site tells no next round while the bounty contract judges with another one: the step would not open it.
   */
  readonly judge: string;
  readonly first_minute: number;
  readonly every_minutes: number;
  /** What the house puts into the vault: the stake its code and state lock, and on top of it what the masks race for. */
  readonly safe: string;
  /**
   * About what of `safe` the vault's code and state lock (1 NEAR per 100 KB): the rest is what a mask can take. The
   * chain decides the exact figure; this one tells a round that has not opened yet honestly, and keeps `min_loot`
   * well inside what is left.
   */
  readonly stake: string;
  /** The round's deposit on the bounty contract: the bounty and the storage it reserves. */
  readonly deposit: string;
  /** What a drain must take out of the vault to count. */
  readonly min_loot: string;
  /** What the house keeps free for gas while it makes the vault and opens the round: NEAR buys gas up front. */
  readonly gas: string;
  /**
   * What a mask keeps besides the stake of its storage when its winnings go home to the house: the gas its claims buy
   * up front. contracts/home keeps exactly this (a test holds the two the same); house.ps1 -Collect keeps it in all.
   */
  readonly mask_keep: string;
  readonly hours: number;
  readonly commit_minutes: number;
  readonly reveal_minutes: number;
}

export interface Network {
  readonly id: NetworkId;
  /** The team: opens hand rounds, proposes every change to the keyless contracts, keeps the factory's keeper role. */
  readonly admin: string;
  /** The keyless bounty contract new rounds open on. */
  readonly bounty: string;
  /** Bounty contracts from before it, newest first: their races stay where they were opened. */
  readonly older_bounty: readonly string[];
  /** The season treasury: it opens a round on schedule and makes its safe, `s<nnnn>.<season>`. */
  readonly season: string;
  /** The one account whose function-call key may call `open_next` and `collect` on the treasury. */
  readonly scheduler: string;
  /**
   * The house: a plain account that opens one round a day on the vault, by hand or from the Season workflow, and takes
   * back what the round leaves. The NEAR goes round: house, vault, the mask that wins, house.
   */
  readonly house: string;
  /**
   * The one safe of the house's rounds. Once its round is over it retires itself, giving its whole balance back to the
   * house, and the house makes it again under the same name for the next round. Only the house can: it is its own
   * sub-account.
   */
  readonly vault: string;
  /**
   * The code the vault runs: its code hash as NEAR shows it, base58 of the wasm's sha256. `null` until that wasm is
   * built and its hash is written here; until then the house opens nothing.
   */
  readonly safe_code: string | null;
  /**
   * The code of `home` (contracts/home) for this network: its code hash as NEAR shows it, base58 of the wasm's sha256.
   * A mask that runs it sends everything above `round.mask_keep` and its storage to `house`, and only there; the
   * house's day calls `home()` on a mask only when it runs exactly this code. `null` while there is none.
   */
  readonly home_code: string | null;
  readonly round: HouseRound;
  /** The mask factory: a person's mask is `<name>.<factory>`. */
  readonly factory: string;
  readonly jobs: string;
  readonly crews: string;
  /** The arena's own masks, by name. */
  readonly masks: Readonly<Record<string, string>>;
  /**
   * Which parts are on chain on this network: a statement the team reviews, not a reading of the chain. The site shows
   * a part where it is and sends a visitor to the other network for a part that is only there. Putting a part on chain
   * here is one word in this file.
   */
  readonly sections: Readonly<Record<Section, boolean>>;
  readonly outlayer: { readonly contract: string; readonly api: string };
  /**
   * Mainnet only, Get NEAR (/near): MASK WARS's own fee on a swap to NEAR, in basis points of what is sent, and the
   * account it is paid to. 1Click takes it inside the price as an `appFees` entry and shows it in the quote.
   */
  readonly get_near?: { readonly fee_bps: number; readonly fee_to: string };
  /**
   * Mainnet only, Swap (/swap): MASK WARS's own fee on a swap between any two coins, in basis points of what is sent, the
   * account it is paid to, and the most one swap may bring in dollars while it is new. Like `get_near`, 1Click takes
   * the fee inside the price as an `appFees` entry and shows it in the quote.
   */
  readonly swap?: { readonly fee_bps: number; readonly fee_to: string; readonly usd_max: number };
  /** JSON-RPC endpoints, the first preferred. */
  readonly rpc: readonly string[];
  /** The public transactions indexer (FastNEAR explorer API). */
  readonly indexer: string;
  /** Where a person opens a transaction or an account. */
  readonly explorer: string;
  /**
   * What the owner's scripts give each new account, in NEAR: most of it pays for the code it stores (1 NEAR per 100 KB),
   * the rest is gas and margin. `mask` is one of the arena's own masks, `safe` a safe made by hand (safe-deploy.ps1),
   * `house` what the house starts with (house.ps1).
   */
  readonly fund: Readonly<Record<"bounty" | "season" | "factory" | "scheduler" | "house" | "mask" | "safe" | "jobs" | "crews", string>>;
  readonly limits: Limits;
  /** Who else the house lets into its daily round beside the arena's own masks (packages/race/src/house-guests.ts). */
  readonly guests: Guests;
}

/**
 * The guests of the house's daily round, at most so many of each: `masks` people forged in the factory (their minds
 * run in a TEE and their owners pay for them), `agents` from outside that signed up over MCP and play with their own
 * keys. Each guest adds `deposit` NEAR to the round's deposit, so the bounty stays what it is: the 4000 bytes the bounty
 * contract sets aside for one more mask (0.04), the judge's fee of its first claim, which the bounty pays (0.01), and its
 * account id in the round's list of masks. A slot nobody takes stays empty. `agents: 0` closes the round to outside
 * agents (mainnet for now: they come back with an entry stake of their own); the site then refuses their sign-ups.
 */
export interface Guests {
  readonly masks: number;
  readonly agents: number;
  readonly deposit: string;
}

const NEAR_AMOUNT = /^(0|[1-9]\d{0,8})(\.\d{1,24})?$/;
const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MINUTE_MS = 60_000;
/** After a round's deadline its masks may still claim for this long (the bounty contract's `CLAIM_GRACE_HOURS`). */
export const CLAIM_GRACE_MINUTES = 12 * 60;
/** A mask's turn on a live safe, in minutes (the bounty contract's `SAFE_TURN_MINUTES`). */
const SAFE_TURN_MINUTES = 3;
/** The least a drain must take, and the least bounty a round pays (the bounty contract's `MIN_LOOT`, `MIN_BOUNTY`). */
const MIN_LOOT = "0.1";
/** The least reward of a job, and the least fuel of a mask on it (the jobs contract's `MIN_REWARD`, `MIN_FUEL`). */
const MIN_JOB_REWARD = "0.1";
const MIN_JOB_FUEL = "0.01";

/** A code hash as NEAR shows it (base58 of 32 bytes) → the wasm's sha256 in lowercase hex; null when it is not one. */
export function codeHashHex(codeHash: string): string | null {
  let n = 0n;
  for (const c of codeHash) {
    const i = B58.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const hex = n.toString(16);
  return codeHash.length >= 32 && codeHash.length <= 44 && hex.length <= 64 ? hex.padStart(64, "0") : null;
}

/** The schedule's latest slot at or before `ms`, in ms since the epoch; null before the first slot. */
export function slotAt(round: Pick<HouseRound, "first_minute" | "every_minutes">, ms: number): number | null {
  const minute = Math.floor(ms / MINUTE_MS);
  if (minute < round.first_minute) return null;
  const every = Math.max(round.every_minutes, 1);
  return (round.first_minute + Math.floor((minute - round.first_minute) / every) * every) * MINUTE_MS;
}

/** The first slot after `ms`, in ms since the epoch. */
export function slotAfter(round: Pick<HouseRound, "first_minute" | "every_minutes">, ms: number): number {
  const at = slotAt(round, ms);
  return at === null ? round.first_minute * MINUTE_MS : at + Math.max(round.every_minutes, 1) * MINUTE_MS;
}

/** NEAR as a decimal string ("0.35") → yoctoNEAR. */
export function yocto(near: string): bigint {
  const m = NEAR_AMOUNT.exec(near);
  if (!m) throw new Error(`not an amount of NEAR: ${near}`);
  const frac = (m[2] ?? ".").slice(1).padEnd(24, "0");
  return BigInt(m[1]!) * 10n ** 24n + BigInt(frac || "0");
}

/** Whether an account id belongs to this network: `.testnet` on testnet, never on mainnet. */
export function onNetwork(id: NetworkId, account: string): boolean {
  if (!ACCOUNT.test(account) || account.length < 2 || account.length > 64) return false;
  return id === "testnet" ? account.endsWith(".testnet") : !account.endsWith(".testnet");
}

/** Checks a network file: every account on its own network, every amount an amount. Throws on the first fault. */
export function parseNetwork(raw: unknown): Network {
  const n = raw as Network;
  const fail = (why: string): never => {
    throw new Error(`network ${String(n?.id)}: ${why}`);
  };
  if (!n || !isNetworkId(n.id)) fail("id: testnet or mainnet");
  const accounts = [
    n.admin,
    n.bounty,
    ...(n.older_bounty ?? []),
    n.season,
    n.scheduler,
    n.house,
    n.vault,
    n.factory,
    n.jobs,
    n.crews,
    n.outlayer?.contract,
    ...Object.values(n.masks ?? {}),
  ];
  for (const a of accounts) if (typeof a !== "string" || !onNetwork(n.id, a)) fail(`${String(a)} is not a ${n.id} account`);
  for (const sub of [n.bounty, n.season, n.scheduler, n.house, n.factory, n.jobs, n.crews, ...Object.values(n.masks ?? {})]) {
    if (!sub.endsWith(`.${n.admin}`)) fail(`${sub} is not under ${n.admin}: only the admin can create it`);
  }
  // The vault is made again for every round, by the house alone: a direct sub-account of it and of nobody else.
  if (n.vault.slice(n.vault.indexOf(".") + 1) !== n.house) fail(`${n.vault} is not a sub-account of ${n.house}: only the house can make it`);
  if (n.safe_code !== null && (typeof n.safe_code !== "string" || codeHashHex(n.safe_code) === null)) fail("safe_code: a code hash in base58, or null");
  if (n.home_code !== null && (typeof n.home_code !== "string" || codeHashHex(n.home_code) === null)) fail("home_code: a code hash in base58, or null");
  const stated = Object.keys(n.sections ?? fail("sections: which parts are on chain here"));
  for (const part of SECTIONS) if (typeof n.sections[part] !== "boolean") fail(`sections.${part}: true or false`);
  for (const part of stated) if (!SECTIONS.includes(part as Section)) fail(`sections.${part}: not a part of MASK WARS`);
  for (const url of [...n.rpc, n.indexer, n.explorer, n.outlayer.api]) if (!/^https:\/\/[a-z0-9.-]+(\/|$)/.test(url)) fail(`${url}: an https URL`);
  if (n.rpc.length < 1) fail("rpc: at least one endpoint");
  for (const a of Object.values(n.fund ?? fail("fund: the NEAR each new account gets"))) yocto(a);
  if (yocto(n.fund.safe) > yocto(n.limits.hand.safe_max)) fail("fund.safe: above limits.hand.safe_max");
  const l = n.limits;
  for (const a of [l.season.max_prize, l.season.max_safe_fund, l.hand.deposit_max, l.hand.safe_max, l.fund_max, l.fuel_max]) yocto(a);
  if (!Number.isInteger(l.season.max_per_day) || l.season.max_per_day < 1) fail("limits.season.max_per_day: 1 or more");
  if (yocto(l.fuel_max) < yocto("1")) fail("limits.fuel_max: at least the factory's least, 1 NEAR");
  for (const usd of [l.pay_usd_max, l.hire_usd_max]) if (usd !== undefined && !(Number.isInteger(usd) && usd >= 1)) fail(`${usd}: whole dollars`);
  const j = l.jobs ?? fail("limits.jobs: the jobs from outside the arena's masks take");
  if (yocto(j.min_reward) < yocto(MIN_JOB_REWARD)) fail("limits.jobs.min_reward: at least the jobs contract's least, 0.1 NEAR");
  if (yocto(j.max_bond) < yocto(MIN_JOB_FUEL) || yocto(j.max_bond) > yocto(j.min_reward)) fail("limits.jobs.max_bond: from the least fuel of a mask, 0.01 NEAR, up to min_reward");
  for (const k of [j.per_round, j.per_client, j.seats]) if (!Number.isInteger(k) || k < 1) fail("limits.jobs: whole numbers of jobs, 1 or more");
  // One client never holds every place of a mask, and neither do all outsiders together: one stays for our own jobs.
  if (j.seats >= MAX_LIVE_JOBS_PER_MASK) fail(`limits.jobs.seats: fewer than the ${MAX_LIVE_JOBS_PER_MASK} live places of a mask`);
  if (j.per_client > j.seats) fail("limits.jobs.per_client: no more than seats");
  // The cap on the house's bonds is never looser than the limits themselves: every mask on `seats` jobs at max_bond.
  const outMost = houseOutMost(n);
  if (typeof j.max_out !== "string" || yocto(j.max_out) <= 0n || yocto(j.max_out) > outMost) {
    fail(`limits.jobs.max_out: above 0, and no more than every mask's ${j.seats} bonds of max_bond with their storage`);
  }
  // A bond waits for its mask through the work window at most, and a job posted on /jobs fits (40, 30 and 10 minutes).
  if (!Number.isInteger(j.max_work_minutes) || j.max_work_minutes < 40 || j.max_work_minutes > 120) fail("limits.jobs.max_work_minutes: 40 minutes to 2 hours");
  if (!Number.isInteger(j.max_reveal_minutes) || j.max_reveal_minutes < 30 || j.max_reveal_minutes > 120) fail("limits.jobs.max_reveal_minutes: 30 minutes to 2 hours");
  if (!Number.isInteger(j.max_appeal_minutes) || j.max_appeal_minutes < 10 || j.max_appeal_minutes > 120) fail("limits.jobs.max_appeal_minutes: 10 minutes to 2 hours");
  if (!Number.isInteger(j.reveal_runs) || j.reveal_runs < 1 || j.reveal_runs > JOBS_TICK_MINUTES.length) fail("limits.jobs.reveal_runs: 1 or more runs of the site's clock inside a reveal window");
  if (n.get_near !== undefined) {
    const g = n.get_near;
    // 1% at most: a person swapping to NEAR should never meet more than that from us.
    if (!Number.isInteger(g.fee_bps) || g.fee_bps < 0 || g.fee_bps > 100) fail("get_near.fee_bps: whole basis points, 0 to 100");
    if (typeof g.fee_to !== "string" || !onNetwork(n.id, g.fee_to)) fail(`get_near.fee_to: ${String(g.fee_to)} is not a ${n.id} account`);
  }
  if (n.swap !== undefined) {
    const w = n.swap;
    // 1% at most, as for Get NEAR.
    if (!Number.isInteger(w.fee_bps) || w.fee_bps < 0 || w.fee_bps > 100) fail("swap.fee_bps: whole basis points, 0 to 100");
    if (typeof w.fee_to !== "string" || !onNetwork(n.id, w.fee_to)) fail(`swap.fee_to: ${String(w.fee_to)} is not a ${n.id} account`);
    if (!Number.isInteger(w.usd_max) || w.usd_max < 1) fail("swap.usd_max: whole dollars, 1 or more");
  }
  const r = n.round ?? fail("round: the house's daily round");
  if (typeof r.live !== "boolean") fail("round.live: true or false");
  if (typeof r.judge !== "string" || !/^[0-9a-f]{64}$/.test(r.judge)) fail("round.judge: the judge's sha256 in lowercase hex");
  for (const a of [r.safe, r.stake, r.deposit, r.min_loot, r.gas, r.mask_keep, l.house_max]) yocto(a);
  for (const m of [r.first_minute, r.every_minutes, r.hours, r.commit_minutes, r.reveal_minutes]) {
    if (!Number.isInteger(m) || m < 0) fail("round: whole minutes and hours");
  }
  if (yocto(r.safe) > yocto(l.hand.safe_max)) fail("round.safe: above limits.hand.safe_max");
  if (yocto(r.deposit) > yocto(l.hand.deposit_max)) fail("round.deposit: above limits.hand.deposit_max");
  if (yocto(r.min_loot) < yocto(MIN_LOOT)) fail("round.min_loot: at least 0.1 NEAR");
  // A plain transfer into the vault during a plan must not hide a drain: the least drain sits well below the loot.
  if (yocto(r.stake) + 2n * yocto(r.min_loot) > yocto(r.safe)) fail("round.safe: less than its stake and twice min_loot");
  if (yocto(r.safe) + yocto(r.deposit) + yocto(r.gas) > yocto(l.house_max)) fail("round: one round takes more than limits.house_max");
  if (yocto(n.fund.house) > yocto(l.house_max)) fail("fund.house: above limits.house_max");
  if (r.hours < 1 || r.hours > 24) fail("round.hours: 1 to 24, as the bounty contract takes a sealed round");
  const masks = Object.keys(n.masks ?? {}).length;
  if (r.commit_minutes < 1 || r.reveal_minutes < SAFE_TURN_MINUTES * (masks + 1) || r.commit_minutes + r.reveal_minutes > r.hours * 60) {
    fail("round: the commit window, then 3 minutes for each mask's turn and 3 more, all inside the round");
  }
  const g = n.guests ?? fail("guests: who else the house lets into its round");
  for (const k of [g.masks, g.agents]) if (!Number.isInteger(k) || k < 0) fail("guests: whole numbers of masks and agents");
  const all = masks + g.masks + g.agents;
  if (all > 16) fail("guests: with the arena's masks, 16 at most, as the bounty contract and the safe take");
  if (r.reveal_minutes < SAFE_TURN_MINUTES * (all + 1)) fail("guests: the reveal window gives every mask, guests included, its 3 minutes");
  const fullDeposit = yocto(r.deposit) + BigInt(g.masks + g.agents) * yocto(g.deposit);
  if (fullDeposit > yocto(l.hand.deposit_max)) fail("guests: the deposit with every guest is above limits.hand.deposit_max");
  if (yocto(r.safe) + fullDeposit + yocto(r.gas) > yocto(l.house_max)) fail("guests: a full round takes more than limits.house_max");
  // The circle closes within a slot: a round nobody won is refunded only after its claim grace, and the vault can be
  // made again only once that round is over.
  if (r.every_minutes < 1 || r.hours * 60 + CLAIM_GRACE_MINUTES >= r.every_minutes) {
    fail("round: a round nobody won must be over, its claim grace included, before the next slot");
  }
  return n;
}

export function isNetworkId(value: unknown): value is NetworkId {
  return value === "testnet" || value === "mainnet";
}

export const NETWORKS: Readonly<Record<NetworkId, Network>> = {
  testnet: parseNetwork(testnetJson),
  mainnet: parseNetwork(mainnetJson),
};

/**
 * The network MASKWARS_NETWORK names: `testnet` when it is not set, `mainnet` when it says so. Any other value throws:
 * a typo must not read testnet while the owner thinks the site is on mainnet. No trimming: the workflows pick a
 * network's environment and secrets by the exact value, so a padded one must stop the job, not sign on mainnet with
 * the other network's environment.
 */
export function networkOf(value: string | undefined): NetworkId {
  const v = value ?? "";
  if (v === "") return "testnet";
  if (isNetworkId(v)) return v;
  throw new Error(`MASKWARS_NETWORK: testnet or mainnet, not "${v}"`);
}

/** MASKWARS_NETWORK of this process. Written out in full so the site's build inlines it into the browser's code. */
function fromEnv(): string | undefined {
  try {
    return process.env.MASKWARS_NETWORK;
  } catch {
    return undefined;
  }
}

/** The network this process reads. */
export const NETWORK_ID: NetworkId = networkOf(fromEnv());

/** Where MASK WARS lives on the network this process reads. */
export const NET: Network = NETWORKS[NETWORK_ID];

/** The other of the two networks. */
export const otherNetwork = (id: NetworkId): NetworkId => (id === "testnet" ? "mainnet" : "testnet");

/**
 * The network a part is found on, asked from `from`: `from` itself when the part is on chain there, else the other
 * network when it is there, else `null`: a part that is on chain nowhere yet belongs to no network.
 */
export function whereIs(section: Section, from: NetworkId = NETWORK_ID, networks: Readonly<Record<NetworkId, Pick<Network, "sections">>> = NETWORKS): NetworkId | null {
  if (networks[from].sections[section]) return from;
  const other = otherNetwork(from);
  return networks[other].sections[section] ? other : null;
}

/** The bounty contracts races are read from, newest first. */
export const bountyContracts = (n: Network = NET): readonly string[] => [n.bounty, ...n.older_bounty];

/**
 * What the house keeps free whatever bonds it locks for the arena's masks on jobs from outside: what its next round
 * needs beside the vault, which comes back whole when the vault retires. The deposit with every guest it may seat, and
 * the gas it keeps for the day's steps. A bond locked today may come back only after tomorrow's round opened.
 */
export const houseKeeps = (n: Pick<Network, "round" | "guests"> = NET): bigint =>
  yocto(n.round.deposit) + yocto(n.round.gas) + BigInt(n.guests.masks + n.guests.agents) * yocto(n.guests.deposit);

/**
 * The most the house could ever have out in bonds on jobs from outside by the limits alone: each of the arena's masks
 * on `seats` such jobs, each bond `max_bond` with its record's storage. `limits.jobs.max_out` is never above it.
 */
export function houseOutMost(n: Pick<Network, "masks" | "limits">): bigint {
  return BigInt(Object.keys(n.masks ?? {}).length * n.limits.jobs.seats) * (yocto(n.limits.jobs.max_bond) + yocto(JOB_BOND_STORAGE));
}

/** The moments the site's clock starts the Jobs workflow from `from` to `until`, both included, ms by the chain's clock. */
export function jobsTicksIn(round: Pick<HouseRound, "first_minute" | "every_minutes">, from: number, until: number): number[] {
  const every = Math.max(round.every_minutes, 1) * MINUTE_MS;
  const last = Math.max(...JOBS_TICK_MINUTES) * MINUTE_MS;
  const out: number[] = [];
  // Every slot whose ticks may reach the span: from the one before `from` less the last tick, to the one at `until`.
  const first = slotAt(round, from - last) ?? round.first_minute * MINUTE_MS;
  for (let slot = first; slot <= until; slot += every) {
    for (const m of JOBS_TICK_MINUTES) {
      const t = slot + m * MINUTE_MS;
      if (t >= from && t <= until) out.push(t);
    }
  }
  return out;
}

/**
 * The runs of the site's clock that are sure to reveal the steps of a job whose reveal window runs from `workUntil` to
 * `revealUntil` (ms): those that start inside it, `JOBS_TICK_LEAD_MINUTES` before its end at the latest.
 */
export function revealTicks(round: Pick<HouseRound, "first_minute" | "every_minutes">, workUntil: number, revealUntil: number): number[] {
  return jobsTicksIn(round, workUntil, revealUntil - JOBS_TICK_LEAD_MINUTES * MINUTE_MS);
}

/** The arena's own teams: the accounts that open its races, the admin, the season treasury and the house. */
export const teams = (n: Network = NET): readonly string[] => [n.admin, n.season, n.house];
