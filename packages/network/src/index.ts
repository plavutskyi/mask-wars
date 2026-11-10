// Where MASK WARS lives on each NEAR network, and the limits of the money it moves there. One file per network,
// `testnet.json` and `mainnet.json`, read by everything that needs it: the site and its API, the arena reader, the
// race and the season jobs, and the owner's scripts in scripts/testnet (config.ps1 reads the same files). Which network
// a process reads is MASKWARS_NETWORK: `testnet` (the default) or `mainnet`. Anything else stops the process instead of
// quietly reading testnet.
import mainnetJson from "../mainnet.json" with { type: "json" };
import testnetJson from "../testnet.json" with { type: "json" };

export type NetworkId = "testnet" | "mainnet";

export const NETWORK_IDS: readonly NetworkId[] = ["testnet", "mainnet"];

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
  /** The most one season-fund.ps1 puts into the treasury. */
  readonly fund_max: string;
  /** The most a person may put into a mask they forge (the forge's biggest choice). The factory's least is 1 NEAR. */
  readonly fuel_max: string;
  /** Mainnet only, the vault in NEAR Intents: the most one top-up may bring, in dollars (PAY_LIVE). */
  readonly pay_usd_max?: number;
  /** Mainnet only: the most one hire may pay, in dollars (HIRE_LIVE). */
  readonly hire_usd_max?: number;
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
  /** The mask factory: a person's mask is `<name>.<factory>`. */
  readonly factory: string;
  readonly jobs: string;
  readonly crews: string;
  /** The arena's own masks, by name. */
  readonly masks: Readonly<Record<string, string>>;
  readonly outlayer: { readonly contract: string; readonly api: string };
  /** JSON-RPC endpoints, the first preferred. */
  readonly rpc: readonly string[];
  /** The public transactions indexer (FastNEAR explorer API). */
  readonly indexer: string;
  /** Where a person opens a transaction or an account. */
  readonly explorer: string;
  /**
   * What the owner's scripts give each new account, in NEAR: most of it pays for the code it stores (1 NEAR per 100 KB),
   * the rest is gas and margin. `mask` is one of the arena's own masks, `safe` a safe made by hand (safe-deploy.ps1).
   */
  readonly fund: Readonly<Record<"bounty" | "season" | "factory" | "scheduler" | "mask" | "safe" | "jobs" | "crews", string>>;
  readonly limits: Limits;
}

const NEAR_AMOUNT = /^(0|[1-9]\d{0,8})(\.\d{1,24})?$/;
const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

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
    n.factory,
    n.jobs,
    n.crews,
    n.outlayer?.contract,
    ...Object.values(n.masks ?? {}),
  ];
  for (const a of accounts) if (typeof a !== "string" || !onNetwork(n.id, a)) fail(`${String(a)} is not a ${n.id} account`);
  for (const sub of [n.bounty, n.season, n.scheduler, n.factory, n.jobs, n.crews, ...Object.values(n.masks ?? {})]) {
    if (!sub.endsWith(`.${n.admin}`)) fail(`${sub} is not under ${n.admin}: only the admin can create it`);
  }
  for (const url of [...n.rpc, n.indexer, n.explorer, n.outlayer.api]) if (!/^https:\/\/[a-z0-9.-]+(\/|$)/.test(url)) fail(`${url}: an https URL`);
  if (n.rpc.length < 1) fail("rpc: at least one endpoint");
  for (const a of Object.values(n.fund ?? fail("fund: the NEAR each new account gets"))) yocto(a);
  if (yocto(n.fund.safe) > yocto(n.limits.hand.safe_max)) fail("fund.safe: above limits.hand.safe_max");
  const l = n.limits;
  for (const a of [l.season.max_prize, l.season.max_safe_fund, l.hand.deposit_max, l.hand.safe_max, l.fund_max, l.fuel_max]) yocto(a);
  if (!Number.isInteger(l.season.max_per_day) || l.season.max_per_day < 1) fail("limits.season.max_per_day: 1 or more");
  if (yocto(l.fuel_max) < yocto("1")) fail("limits.fuel_max: at least the factory's least, 1 NEAR");
  for (const usd of [l.pay_usd_max, l.hire_usd_max]) if (usd !== undefined && !(Number.isInteger(usd) && usd >= 1)) fail(`${usd}: whole dollars`);
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

/** The bounty contracts races are read from, newest first. */
export const bountyContracts = (n: Network = NET): readonly string[] => [n.bounty, ...n.older_bounty];

/** The arena's own teams: the accounts that open its races, the admin and the season treasury. */
export const teams = (n: Network = NET): readonly string[] => [n.admin, n.season];
