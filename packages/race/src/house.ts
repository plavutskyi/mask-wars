/**
 * The house's day. The house is a plain account that opens one sealed round a day (RULES.md) on one safe, the vault.
 * The NEAR goes round: the house puts it into the vault and the round's bounty, the mask that wins takes it, and it
 * comes home to the house for the next round. What makes the circle close is the vault itself: once its round is over
 * it deletes its own account (`retire`, the team's call alone) and gives its whole balance, the stake its code locked
 * included, back to the house, which makes it again under the same name for the next round.
 *
 * One day is at most these steps, in this order:
 *
 * 1. close yesterday's round on the bounty contract, whichever applies: `unstick` a claim the judge never answered,
 *    `settle` a confirmed winner nobody paid yet, `refund` a bounty nobody won;
 * 2. `retire` the vault: its balance comes home;
 * 3. make the vault again in one transaction that adds no key: create the account, fund it, deploy the code, `new`;
 * 4. `open_safe`: the round, with its deposit.
 *
 * Nothing here remembers anything. `readHouse` reads the chain, `planDay` says from that reading alone which steps are
 * left or why the day is skipped, and `runDay` sends the first step, reads the chain again and plans again. A run that
 * died after any step, or whose answer was lost, starts over the same way and repeats nothing: a step the chain
 * already shows is not in the plan. The same plan drives the owner's scripts (scripts/testnet: retire.ps1,
 * safe-deploy.ps1, open-safe.ps1), where each step is a transaction the owner sends by hand.
 *
 * Before the vault is made the wasm at hand must hash to the network's `safe_code`, export `retire` and `on_retire`
 * (or the vault could never give its NEAR back), and the bounty contract must list that code (`safe_codes`). After,
 * the account must run that code, hold no key, own itself and name the house as its team: only then does the round
 * open on it. The sums come from packages/network (`round`, `limits.hand`). A round that
 * is not over, a house that cannot pay, a code the contract does not know: each is said plainly and the day is
 * skipped. A vault is never made without the NEAR to open its round.
 */
import { createHash } from "node:crypto";
import { CLAIM_GRACE_MINUTES, slotAt, yocto, type Network } from "@maskwars/network";
import { SWEEP_MARGIN } from "./live.ts";
import {
  base58Encode,
  createAccount,
  deployContract,
  functionCall,
  send,
  transfer,
  view,
  type Action,
  type CallResult,
  type Chain,
  type NearKey,
} from "./near-tx.ts";

/** The library target every round of the house runs: the live safe (contracts/challenges/live-safe). */
export const HOUSE_CHALLENGE = "live-safe";
/** The bounty contract drops a claim nobody answered after this many blocks (`CLAIM_TIMEOUT_BLOCKS`). */
export const CLAIM_TIMEOUT_BLOCKS = 600;
/** Claim numbers looked through for a claim that never came back. The contract numbers its claims from 0. */
export const CLAIM_SCAN = 4096;
/** Bytes the vault's own state and account record take beside its code, at most (16 masks with the longest names). */
export const VAULT_STATE_BYTES = 6_000n;
const STORAGE_PER_BYTE = 10n ** 19n;
const NS_PER_MINUTE = 60_000_000_000n;
const GRACE_NS = BigInt(CLAIM_GRACE_MINUTES) * NS_PER_MINUTE;

/** Gas for each call. The vault asks the bounty contract how its round ended before it retires. */
const GAS = { unstick: 30, settle: 50, refund: 30, retire: 100, new: 30, open: 100 } as const;

/** What the house's day runs on: all of it from packages/network, and the judge the team agrees to. */
export interface HouseConfig {
  readonly house: string;
  readonly vault: string;
  /** The bounty contract the rounds open on. */
  readonly bounty: string;
  /** Every bounty contract whose races the arena shows: a round's id must be new on all of them. */
  readonly contracts: readonly string[];
  readonly masks: readonly string[];
  /** The code the vault runs, as NEAR shows a code hash; `null` while it is not known. */
  readonly safeCode: string | null;
  /** The judge the house opens its rounds with (scripts/<network>/judge-args.json). */
  readonly judgeVersion: string;
  readonly round: {
    readonly firstMinute: number;
    readonly everyMinutes: number;
    readonly safe: bigint;
    readonly deposit: bigint;
    readonly minLoot: bigint;
    readonly gas: bigint;
    readonly hours: number;
    readonly commitMinutes: number;
    readonly revealMinutes: number;
  };
  readonly limits: { readonly safeMax: bigint; readonly depositMax: bigint };
}

/** The house's config on network `n`, with the judge its rounds name. */
export function houseConfig(n: Network, judgeVersion: string): HouseConfig {
  const r = n.round;
  return {
    house: n.house,
    vault: n.vault,
    bounty: n.bounty,
    contracts: [n.bounty, ...n.older_bounty],
    masks: Object.values(n.masks),
    safeCode: n.safe_code,
    judgeVersion,
    round: {
      firstMinute: r.first_minute,
      everyMinutes: r.every_minutes,
      safe: yocto(r.safe),
      deposit: yocto(r.deposit),
      minLoot: yocto(r.min_loot),
      gas: yocto(r.gas),
      hours: r.hours,
      commitMinutes: r.commit_minutes,
      revealMinutes: r.reveal_minutes,
    },
    limits: { safeMax: yocto(n.limits.hand.safe_max), depositMax: yocto(n.limits.hand.deposit_max) },
  };
}

/** A wasm's code hash as NEAR shows it: base58 of its sha256. */
export const codeHashOf = (wasm: Uint8Array): string => base58Encode(createHash("sha256").update(wasm).digest());

/**
 * What the vault's code must export to give its NEAR back: `retire`, and `on_retire`, the bounty contract's answer it
 * retires on. A safe without them (1.4.0 and before, whose code the bounty contract may well list) would take the
 * house's NEAR and keep the stake of its code for good: no vault is made from such a code.
 */
export const RETIRE_METHODS = ["retire", "on_retire"] as const;

/** A wasm as the day sees it: its code hash, its size and the functions it exports (none when it is not a module). */
export interface WasmInfo {
  readonly code: string;
  readonly bytes: number;
  readonly exports: readonly string[];
}

export function wasmInfo(wasm: Uint8Array): WasmInfo {
  let exports: string[] = [];
  try {
    // Compiled, never run: only its list of exports is read. A copy, as WebAssembly takes no shared buffer.
    exports = WebAssembly.Module.exports(new WebAssembly.Module(new Uint8Array(wasm)))
      .filter((e) => e.kind === "function")
      .map((e) => e.name);
  } catch {
    // Not a wasm module at all: it exports nothing.
  }
  return { code: codeHashOf(wasm), bytes: wasm.length, exports };
}

/** The methods of RETIRE_METHODS a wasm does not export. */
export const retireMissing = (w: Pick<WasmInfo, "exports">): string[] => RETIRE_METHODS.filter((m) => !w.exports.includes(m));

/** A claim still with the judge. */
export interface StuckClaim {
  readonly no: number;
  readonly mask: string;
  /** The block it went to the judge in. */
  readonly height: number;
}

/** The round the vault is armed for, as the bounty contract holds it. */
export interface RoundState {
  readonly id: string;
  /** Who opened it. */
  readonly owner: string;
  /** `open`, `drained`, `paid`, `refunded`. */
  readonly state: string;
  readonly openedNs: bigint;
  readonly commitUntilNs: bigint;
  readonly revealUntilNs: bigint;
  readonly deadlineNs: bigint;
  /** A seal the judge confirmed waits to be paid. */
  readonly confirmed: boolean;
  /** Claims with the judge right now, and the ones of them found by number. */
  readonly judging: number;
  readonly claims: readonly StuckClaim[];
}

/** The vault's account, and what it says as a safe; `safe` is null when it does not answer as one. */
export interface VaultState {
  readonly amount: bigint;
  readonly codeHash: string;
  readonly keys: number;
  readonly safe: {
    readonly owner: string;
    readonly team: string | null;
    readonly arbiter: string | null;
    readonly masks: readonly string[];
    /** What it can pay out: its balance less the stake its storage locks. */
    readonly available: bigint;
    /** The round it is armed for. */
    readonly lock: { readonly arbiter: string; readonly bounty: string; readonly armedNs: bigint } | null;
  } | null;
}

/** One reading of everything the day depends on. */
export interface HouseState {
  readonly nowNs: bigint;
  readonly height: number;
  /** The house's account: what it holds, and what of that is free of its own storage stake. */
  readonly house: { readonly amount: bigint; readonly free: bigint } | null;
  readonly vault: VaultState | null;
  /** The round the vault is armed for, when the house's bounty contract holds it. */
  readonly round: RoundState | null;
  /** The bounty contract's own word: the safe codes it knows, its judge, a change that stops new bounties. */
  readonly safeCodes: readonly string[];
  readonly judge: string | null;
  readonly blocking: string | null;
  /** The first id no bounty contract of the arena holds, and the round right before it on the house's contract. */
  readonly nextId: string;
  readonly last: { readonly id: string; readonly owner: string; readonly state: string; readonly openedNs: bigint; readonly deadlineNs: bigint } | null;
}

export type DayStep =
  | { readonly kind: "unstick"; readonly id: string; readonly claim: number; readonly mask: string }
  | { readonly kind: "settle"; readonly id: string }
  | { readonly kind: "refund"; readonly id: string }
  | { readonly kind: "retire" }
  | { readonly kind: "create" }
  | { readonly kind: "open"; readonly id: string };

/** A round of the house that is open. Times in ns. */
export interface OpenRound {
  readonly id: string;
  readonly safe: string;
  readonly challenge: string;
  readonly commitUntilNs: bigint;
  readonly deadlineNs: bigint;
}

export type DayPlan =
  /** A round is open and its masks are sealing: the race takes it as it is. */
  | { readonly kind: "race"; readonly round: OpenRound; readonly why: string }
  /** The slot already has its round: nothing is left to do. */
  | { readonly kind: "done"; readonly why: string }
  /** No slot has come yet. */
  | { readonly kind: "waiting"; readonly why: string }
  /** The day is skipped, and why. */
  | { readonly kind: "skip"; readonly why: string }
  /**
   * What is left, in order. `stop` says why the steps end before a round opens (they still bring the NEAR home);
   * `note` is a warning that stops nothing.
   */
  | { readonly kind: "steps"; readonly steps: readonly DayStep[]; readonly stop?: string; readonly note?: string };

export interface PlanOptions {
  /** The safe's wasm at hand (`wasmInfo`): its code hash, its size and its exports. `null` when there is none. */
  readonly wasm: WasmInfo | null;
  /**
   * By hand, the owner opens a round when they choose: the slots do not hold the plan back. On schedule a slot gets
   * one round, and none so late that it could not be over before the next slot.
   */
  readonly anyTime?: boolean;
}

const near = (y: bigint): string => {
  const whole = y / 10n ** 24n;
  const frac = (y % 10n ** 24n).toString().padStart(24, "0").slice(0, 4).replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""} NEAR`;
};
const when = (ns: bigint): string => new Date(Number(ns / 1_000_000n)).toISOString().replace(/:\d\d\.\d{3}Z$/, " UTC").replace("T", " ");
const raceId = (n: number): string => `race-${String(n).padStart(4, "0")}`;
const raceNo = (id: string): number | null => {
  const m = /^race-(\d{1,9})$/.exec(id);
  return m ? Number(m[1]) : null;
};
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

// ---------------------------------------------------------------------------------------------------------------------
// Reading the chain

/** The node says the account is not there, in either of the two ways nodes say it. */
const noAccount = (e: unknown) => /UNKNOWN_ACCOUNT|does not exist while viewing/.test((e as Error).message ?? "");

interface AccountView {
  readonly amount: string;
  readonly code_hash: string;
  readonly storage_usage: number;
}

async function account(chain: Chain, id: string): Promise<AccountView | null> {
  try {
    return (await chain.rpc("query", { request_type: "view_account", finality: "final", account_id: id })) as AccountView;
  } catch (e) {
    if (noAccount(e)) return null;
    throw e;
  }
}

async function head(chain: Chain): Promise<{ nowNs: bigint; height: number }> {
  const b = (await chain.rpc("block", { finality: "final" })) as { header: { height?: number; timestamp_nanosec?: string; timestamp?: number } };
  return { nowNs: BigInt(b.header.timestamp_nanosec ?? b.header.timestamp ?? 0), height: Number(b.header.height ?? 0) };
}

interface BountyView {
  readonly owner: string;
  readonly deadline_ns: string;
  readonly status: { readonly state: string };
}

/** The bounty `id` on `contract`, or null. A contract that is not on chain holds nothing. */
async function bountyOn(chain: Chain, contract: string, id: string): Promise<BountyView | null> {
  try {
    return await view<BountyView | null>(chain, contract, "get", { id });
  } catch (e) {
    if (noAccount(e)) return null;
    throw e;
  }
}

/**
 * The first `race-<n>` no bounty contract of the arena holds. Rounds are numbered in a row, so the search doubles its
 * step until it finds a free number and then halves back to the first one. With `from` (the number after the vault's
 * own round) it is one question on an ordinary day.
 */
async function firstFreeId(chain: Chain, contracts: readonly string[], from: number | null): Promise<number> {
  const taken = async (n: number) => {
    for (const c of contracts) if (await bountyOn(chain, c, raceId(n))) return true;
    return false;
  };
  if (from !== null) {
    let n = from;
    while (await taken(n)) n += 1;
    return n;
  }
  if (!(await taken(1))) return 1;
  let low = 1;
  let high = 2;
  while (await taken(high)) {
    low = high;
    high *= 2;
  }
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (await taken(mid)) low = mid;
    else high = mid;
  }
  return high;
}

interface ClaimView {
  readonly bounty: string;
  readonly by: string;
  readonly height: string;
}

/** The claims on bounty `id` still with the judge, by number: the contract gives a claim only by its number. */
async function claimsOf(chain: Chain, contract: string, id: string, want: number): Promise<StuckClaim[]> {
  const found: StuckClaim[] = [];
  const BATCH = 16;
  for (let from = 0; from < CLAIM_SCAN && found.length < want; from += BATCH) {
    const numbers = Array.from({ length: BATCH }, (_, i) => from + i);
    const claims = await Promise.all(numbers.map((n) => view<ClaimView | null>(chain, contract, "get_claim", { claim: String(n) })));
    claims.forEach((c, i) => {
      if (c && c.bounty === id) found.push({ no: numbers[i]!, mask: c.by, height: Number(c.height) });
    });
  }
  return found;
}

async function readVault(chain: Chain, vault: string): Promise<VaultState | null> {
  const a = await account(chain, vault);
  if (!a) return null;
  const keys = ((await chain.rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: vault })) as { keys?: unknown[] }).keys ?? [];
  const base = { amount: BigInt(a.amount), codeHash: a.code_hash, keys: keys.length };
  try {
    const [owner, team, arbiter, masks, lock, available] = await Promise.all([
      view<string>(chain, vault, "get_owner"),
      view<string | null>(chain, vault, "team"),
      view<string | null>(chain, vault, "arbiter"),
      view<string[]>(chain, vault, "masks"),
      view<{ arbiter: string; bounty: string; armed_ns: string } | null>(chain, vault, "get_round"),
      view<string>(chain, vault, "available"),
    ]);
    return {
      ...base,
      safe: {
        owner,
        team,
        arbiter,
        masks,
        available: BigInt(available),
        lock: lock ? { arbiter: lock.arbiter, bounty: lock.bounty, armedNs: BigInt(lock.armed_ns) } : null,
      },
    };
  } catch (e) {
    // An account with other code, or none, does not answer a safe's views: that is said as such, not as a failure.
    if (/CONTRACT_EXECUTION_ERROR|NO_CONTRACT_CODE|MethodNotFound|CodeDoesNotExist|wasm execution failed/i.test((e as Error).message ?? "")) {
      return { ...base, safe: null };
    }
    throw e;
  }
}

interface RoundViewOnChain {
  readonly commit_until: string;
  readonly reveal_until: string;
  readonly deadline_ns: string;
  readonly seals: readonly { readonly state: string }[];
}

async function readRound(chain: Chain, contract: string, id: string): Promise<RoundState | null> {
  const [bounty, safe, round, terms] = await Promise.all([
    view<BountyView | null>(chain, contract, "get", { id }),
    view<{ opened_ns: string } | null>(chain, contract, "get_safe", { id }),
    view<RoundViewOnChain | null>(chain, contract, "get_round", { id }),
    view<{ judging: number } | null>(chain, contract, "get_terms", { id }),
  ]);
  if (!bounty || !safe || !round) return null;
  const judging = terms?.judging ?? 0;
  const state = bounty.status.state;
  return {
    id,
    owner: bounty.owner,
    state,
    openedNs: BigInt(safe.opened_ns),
    commitUntilNs: BigInt(round.commit_until),
    revealUntilNs: BigInt(round.reveal_until),
    deadlineNs: BigInt(bounty.deadline_ns),
    confirmed: round.seals.some((s) => s.state === "confirmed"),
    judging,
    claims: state === "open" && judging > 0 ? await claimsOf(chain, contract, id, judging) : [],
  };
}

/** Reads everything the day depends on, at the latest final block. Sends nothing. */
export async function readHouse(chain: Chain, cfg: HouseConfig): Promise<HouseState> {
  const [{ nowNs, height }, house, vault, gov] = await Promise.all([
    head(chain),
    account(chain, cfg.house),
    readVault(chain, cfg.vault),
    view<{ safe_codes?: string[]; judge?: { version?: string }; pending?: { change?: { kind?: string } } | null }>(chain, cfg.bounty, "governance"),
  ]);
  const lock = vault?.safe?.lock ?? null;
  const round = lock && lock.arbiter === cfg.bounty ? await readRound(chain, cfg.bounty, lock.bounty) : null;
  const after = round ? raceNo(round.id) : null;
  const free = await firstFreeId(chain, cfg.contracts, after === null ? null : after + 1);
  // The round right before the first free id: the one that tells whether this slot already had its round.
  let last: HouseState["last"] = null;
  if (round && raceNo(round.id) === free - 1) last = { id: round.id, owner: round.owner, state: round.state, openedNs: round.openedNs, deadlineNs: round.deadlineNs };
  else if (free > 1) {
    const id = raceId(free - 1);
    const [b, s] = await Promise.all([bountyOn(chain, cfg.bounty, id), view<{ opened_ns: string } | null>(chain, cfg.bounty, "get_safe", { id })]);
    if (b && s) last = { id, owner: b.owner, state: b.status.state, openedNs: BigInt(s.opened_ns), deadlineNs: BigInt(b.deadline_ns) };
  }
  const pending = gov.pending?.change?.kind ?? null;
  return {
    nowNs,
    height,
    house: house ? { amount: BigInt(house.amount), free: BigInt(house.amount) - BigInt(house.storage_usage) * STORAGE_PER_BYTE } : null,
    vault,
    round,
    safeCodes: gov.safe_codes ?? [],
    judge: gov.judge?.version ?? null,
    // While new code or a new admin waits on the contract, it opens no bounty.
    blocking: pending === "code" || pending === "admin" ? pending : null,
    nextId: raceId(free),
    last,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Planning: from one reading, with nothing sent and nothing remembered

/** Why the vault on chain cannot take a round, or null when it can: the checks after it is made. */
export function vaultFault(v: VaultState, cfg: HouseConfig): string | null {
  if (!v.safe) return `it does not answer as a safe (code ${v.codeHash})`;
  if (v.codeHash !== cfg.safeCode) return `it runs code ${v.codeHash}, not ${cfg.safeCode ?? "a code the network names"}`;
  if (v.keys > 0) return `it holds ${v.keys} access key(s): a safe holds none`;
  if (v.safe.owner !== cfg.vault) return `its owner is ${v.safe.owner}, not itself`;
  if (v.safe.team !== cfg.house) return `its team is ${v.safe.team ?? "nobody"}, not ${cfg.house}`;
  if (v.safe.arbiter !== cfg.bounty) return `its bounty contract is ${v.safe.arbiter ?? "none"}, not ${cfg.bounty}`;
  if (!sameSet(v.safe.masks, cfg.masks)) return "its masks are not the round's";
  if (v.safe.available < cfg.round.minLoot + SWEEP_MARGIN) {
    return `it can pay out ${near(v.safe.available)}, less than the least drain of ${near(cfg.round.minLoot)} and its margin`;
  }
  return null;
}

/**
 * The steps that end the vault's round on the bounty contract, and, when the vault cannot retire after them yet, why.
 * What can be done now is done even then: a claim the judge never answered is dropped, a winner is paid.
 */
function closing(r: RoundState, s: HouseState, bounty: string): { steps: DayStep[]; blocked?: string } {
  if (r.state === "refunded") return { steps: [] };
  const paidTooEarly = `the vault retires only after the round's deadline, ${when(r.deadlineNs)}`;
  if (r.state === "drained" || r.state === "paid") {
    return s.nowNs >= r.deadlineNs ? { steps: [] } : { steps: [], blocked: `its winner is paid, and ${paidTooEarly}` };
  }
  if (r.state !== "open") return { steps: [], blocked: `its bounty is ${r.state}` };
  const steps: DayStep[] = [];
  if (r.judging > 0) {
    if (r.claims.length < r.judging) {
      const blocked = `${r.judging} claim(s) are with the judge and only ${r.claims.length} could be found by number on ${bounty}: drop them by hand, unstick(id, claim), the number is in the claim's log`;
      return { steps, blocked };
    }
    for (const c of r.claims) {
      const from = c.height + CLAIM_TIMEOUT_BLOCKS;
      if (s.height < from) return { steps, blocked: `claim #${c.no} of ${c.mask} is with the judge, who may still answer until block ${from} (now ${s.height})` };
      steps.push({ kind: "unstick", id: r.id, claim: c.no, mask: c.mask });
    }
  }
  if (r.confirmed) {
    if (s.nowNs < r.revealUntilNs) return { steps, blocked: `a confirmed seal waits for the reveal window to end, ${when(r.revealUntilNs)}` };
    steps.push({ kind: "settle", id: r.id });
    return s.nowNs >= r.deadlineNs ? { steps } : { steps, blocked: `once its winner is paid, ${paidTooEarly}` };
  }
  const refundable = r.deadlineNs + GRACE_NS;
  if (s.nowNs < refundable) return { steps, blocked: `nobody won it, and its masks can still claim until ${when(refundable)}` };
  steps.push({ kind: "refund", id: r.id });
  return { steps };
}

/** Which steps are left today, or why there are none. */
export function planDay(s: HouseState, cfg: HouseConfig, o: PlanOptions): DayPlan {
  const r = cfg.round;
  if (!s.house) return { kind: "skip", why: `the house ${cfg.house} is not on chain yet: house.ps1 makes it` };
  const slotMs = slotAt({ first_minute: r.firstMinute, every_minutes: r.everyMinutes }, Number(s.nowNs / 1_000_000n));
  const slotNs = slotMs === null ? null : BigInt(slotMs) * 1_000_000n;
  const nextSlotNs = slotNs === null ? null : slotNs + BigInt(r.everyMinutes) * NS_PER_MINUTE;

  // What stands on the vault's name now.
  const steps: DayStep[] = [];
  let ready = false;
  let note: string | undefined;
  const v = s.vault;
  if (v) {
    if (!v.safe) return { kind: "skip", why: `${cfg.vault} is on chain and does not answer as a safe (code ${v.codeHash}): nothing is sent to it` };
    const lock = v.safe.lock;
    if (lock) {
      if (lock.arbiter !== cfg.bounty) return { kind: "skip", why: `${cfg.vault} is armed by ${lock.arbiter}, not by ${cfg.bounty}: not the house's round` };
      const round = s.round;
      if (!round) return { kind: "skip", why: `${cfg.bounty} does not hold ${lock.bounty}, the round ${cfg.vault} is armed for` };
      // A round sealing right now is raced as it is, whoever opened it: an earlier run, or the owner by hand.
      if (round.state === "open" && s.nowNs < round.commitUntilNs) {
        const open = { id: round.id, safe: cfg.vault, challenge: HOUSE_CHALLENGE, commitUntilNs: round.commitUntilNs, deadlineNs: round.deadlineNs };
        return { kind: "race", round: open, why: `round ${round.id} is open and seals until ${when(round.commitUntilNs)}: racing it` };
      }
      if (!o.anyTime && slotNs !== null && round.openedNs >= slotNs) {
        return { kind: "done", why: `round ${round.id} is the round of the slot of ${when(slotNs)}: ${round.state === "open" ? "it is on its way" : round.state}` };
      }
      const close = closing(round, s, cfg.bounty);
      if (close.blocked) {
        const why = `round ${round.id} is not over: ${close.blocked}`;
        return close.steps.length > 0 ? { kind: "steps", steps: close.steps, stop: why } : { kind: "skip", why };
      }
      steps.push(...close.steps, { kind: "retire" });
    } else {
      // A vault no round was opened on: an earlier run made it and stopped. One that is right takes the round as it
      // is; any other goes back to the house first, and a safe without a round retires at once.
      const fault = vaultFault(v, cfg);
      if (fault) {
        note = `${cfg.vault} is on chain without a round and cannot take one (${fault}): it retires first`;
        steps.push({ kind: "retire" });
      } else ready = true;
    }
  }

  // Whether a round opens after that, and if not, why: nothing is due, the slot has its round, or the day is skipped.
  const stop = ((): { kind: "waiting" | "done" | "skip"; why: string } | null => {
    const skip = (why: string) => ({ kind: "skip" as const, why });
    if (!o.anyTime) {
      if (slotNs === null || nextSlotNs === null) return { kind: "waiting", why: "no slot has come yet" };
      // A bounty refunded before its claim grace is over never ran: its safe would not arm, and the contract gave the
      // deposit back at once. Any other round the house opened in this slot is the slot's round.
      const ran = s.last && s.last.owner === cfg.house && s.last.openedNs >= slotNs && !(s.last.state === "refunded" && s.nowNs < s.last.deadlineNs + GRACE_NS);
      if (ran) return { kind: "done", why: `round ${s.last!.id} already ran for the slot of ${when(slotNs)}` };
      const over = s.nowNs + BigInt(r.hours * 60) * NS_PER_MINUTE + GRACE_NS;
      if (over > nextSlotNs) {
        return skip(`too late for the slot of ${when(slotNs)}: a round opened now could stay open until ${when(over)}, past the next slot`);
      }
    }
    if (!cfg.safeCode) return skip("the network's safe_code is not set: the vault's code hash goes into packages/network once its wasm is built");
    if (r.safe > cfg.limits.safeMax) return skip(`the vault's ${near(r.safe)} is above limits.hand.safe_max, ${near(cfg.limits.safeMax)}`);
    if (r.deposit > cfg.limits.depositMax) return skip(`the round's deposit of ${near(r.deposit)} is above limits.hand.deposit_max, ${near(cfg.limits.depositMax)}`);
    if (!s.safeCodes.includes(cfg.safeCode)) {
      return skip(`${cfg.bounty} does not know the vault's code ${cfg.safeCode}: bounty-change.ps1 -AllowSafe, then -Apply after its hour`);
    }
    if (s.judge !== cfg.judgeVersion) {
      return skip(`${cfg.bounty} judges new rounds with ${s.judge ?? "nothing"}, not with ${cfg.judgeVersion}, the judge the house agrees to`);
    }
    if (s.blocking) return skip(`a new ${s.blocking} waits on ${cfg.bounty}: it opens no bounty until that applies, lapses or is cancelled`);
    if (!ready) {
      if (!o.wasm) return skip("the safe's wasm is not at hand: nothing to deploy");
      if (o.wasm.code !== cfg.safeCode) return skip(`the wasm at hand has code hash ${o.wasm.code}, not the network's safe_code ${cfg.safeCode}`);
      const missing = retireMissing(o.wasm);
      if (missing.length > 0) {
        return skip(`the wasm at hand (${cfg.safeCode}) exports no ${missing.join(" or ")}: a vault made from it could never retire and give the house its NEAR back`);
      }
      const stake = (BigInt(o.wasm.bytes) + VAULT_STATE_BYTES) * STORAGE_PER_BYTE;
      if (r.safe < stake + r.minLoot + SWEEP_MARGIN) {
        return skip(`${near(r.safe)} in the vault would leave less than the least drain of ${near(r.minLoot)} above the ${near(stake)} its code and state lock`);
      }
    }
    const need = (ready ? 0n : r.safe) + r.deposit + r.gas;
    // A vault about to retire gives its whole balance back first.
    const coming = steps.some((x) => x.kind === "retire") && v ? v.amount : 0n;
    if (s.house!.free + coming < need) {
      const back = coming > 0n ? ` and ${near(coming)} comes back with the vault` : "";
      return skip(`the house holds ${near(s.house!.free)} free${back}: the round needs ${near(need)}`);
    }
    return null;
  })();

  if (stop) {
    // The steps that bring yesterday's NEAR home still go, whatever stops today's round.
    if (steps.length === 0) return stop;
    return { kind: "steps", steps, stop: stop.why, ...(note ? { note } : {}) };
  }
  if (!ready) steps.push({ kind: "create" });
  steps.push({ kind: "open", id: s.nextId });
  if (o.anyTime && nextSlotNs !== null) {
    const over = s.nowNs + BigInt(r.hours * 60) * NS_PER_MINUTE + GRACE_NS;
    if (over > nextSlotNs) note ??= `a round opened now can stay open until ${when(over)}: the slot of ${when(nextSlotNs)} would be skipped if nobody wins it`;
  }
  return { kind: "steps", steps, ...(note ? { note } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The transactions

/** One step as the transaction that makes it: who it goes to and its actions. */
export interface StepTx {
  readonly receiver: string;
  readonly actions: readonly Action[];
}

/** The arguments `new` takes on the vault: it owns itself, lets in the round's masks and takes only the house's round. */
export const vaultInit = (cfg: HouseConfig) => ({ owner: cfg.vault, masks: [...cfg.masks], arbiter: cfg.bounty, team: cfg.house });

/** The arguments `open_safe` takes for round `id`. */
export const roundArgs = (cfg: HouseConfig, id: string) => ({
  id,
  safe: cfg.vault,
  masks: [...cfg.masks],
  min_loot: cfg.round.minLoot.toString(),
  hours: cfg.round.hours,
  commit_minutes: cfg.round.commitMinutes,
  reveal_minutes: cfg.round.revealMinutes,
  safe_code: cfg.safeCode,
  judge_version: cfg.judgeVersion,
});

/** What `step` does, in a line: for a log, a summary, or the owner before they sign it. */
export function stepText(step: DayStep, cfg: HouseConfig): string {
  switch (step.kind) {
    case "unstick":
      return `unstick: drop claim #${step.claim} of ${step.mask} on ${step.id}, which the judge never answered`;
    case "settle":
      return `settle: ${cfg.bounty} pays the confirmed winner of ${step.id}`;
    case "refund":
      return `refund: the bounty of ${step.id}, which nobody won, goes back to ${cfg.house}`;
    case "retire":
      return `retire: ${cfg.vault} deletes itself and gives its whole balance back to ${cfg.house}`;
    case "create":
      return `make ${cfg.vault} with ${near(cfg.round.safe)} in one transaction that adds no key: create, fund, deploy, new`;
    case "open":
      return `open_safe: round ${step.id} on ${cfg.vault} with a deposit of ${near(cfg.round.deposit)}`;
  }
}

/** The transaction of `step`, signed by the house. Making the vault needs the wasm. */
export function stepTx(step: DayStep, cfg: HouseConfig, wasm?: Uint8Array | null): StepTx {
  switch (step.kind) {
    case "unstick":
      return { receiver: cfg.bounty, actions: [functionCall("unstick", { id: step.id, claim: String(step.claim) }, GAS.unstick)] };
    case "settle":
      return { receiver: cfg.bounty, actions: [functionCall("settle", { id: step.id }, GAS.settle)] };
    case "refund":
      return { receiver: cfg.bounty, actions: [functionCall("refund", { id: step.id }, GAS.refund)] };
    case "retire":
      return { receiver: cfg.vault, actions: [functionCall("retire", {}, GAS.retire)] };
    case "create": {
      if (!wasm) throw new Error("the safe's wasm is not at hand: nothing to deploy");
      // The plan refuses such a code before this; the transaction refuses it again, the last word before it is signed.
      const missing = retireMissing(wasmInfo(wasm));
      if (missing.length > 0) throw new Error(`the safe's wasm exports no ${missing.join(" or ")}: a vault made from it could never retire`);
      return { receiver: cfg.vault, actions: [createAccount(), transfer(cfg.round.safe), deployContract(wasm), functionCall("new", vaultInit(cfg), GAS.new)] };
    }
    case "open":
      return { receiver: cfg.bounty, actions: [functionCall("open_safe", roundArgs(cfg, step.id), GAS.open, cfg.round.deposit)] };
  }
}

/** The gas each step's call carries, in TGas, for the owner's scripts to send the same. */
export const STEP_GAS: Readonly<Record<keyof typeof GAS, number>> = GAS;

// ---------------------------------------------------------------------------------------------------------------------
// Running the day

export interface DayOptions {
  readonly chain: Chain;
  readonly config: HouseConfig;
  /** The house's key. Without it nothing is sent: the day is read, and a round already sealing is handed to the race. */
  readonly key?: NearKey | undefined;
  /** The safe's wasm at hand. */
  readonly wasm?: Uint8Array | null | undefined;
  readonly anyTime?: boolean | undefined;
  readonly log?: (line: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  /** How long to look for a step on chain after its answer was lost. */
  readonly settleMs?: number;
}

/** A transaction this run sent. */
export interface Sent {
  readonly step: DayStep["kind"];
  readonly hash: string;
}

export type Day =
  /** This run opened the round. */
  | { readonly kind: "opened"; readonly round: OpenRound; readonly sent: readonly Sent[] }
  /** A round is open and still sealing: the race takes it as it is. */
  | { readonly kind: "open"; readonly round: OpenRound; readonly why: string; readonly sent: readonly Sent[] }
  /** The slot has its round, or no slot has come: nothing to do, and nothing is wrong. */
  | { readonly kind: "done" | "waiting"; readonly why: string; readonly sent: readonly Sent[] }
  /** The day is skipped: no round opens, and why. */
  | { readonly kind: "skipped"; readonly why: string; readonly sent: readonly Sent[] }
  /** No key: these steps wait for whoever signs for the house. */
  | { readonly kind: "unsigned"; readonly steps: readonly DayStep[]; readonly stop?: string; readonly sent: readonly Sent[] };

/** The same step again: for a claim, the same claim; for the rest, the same kind (a round's id may have moved on). */
const same = (a: DayStep, b: DayStep) => a.kind === b.kind && (a.kind !== "unstick" || (b.kind === "unstick" && a.claim === b.claim));

/**
 * The house's day, as far as it goes: reads the chain, sends the first step that is left, reads again. It returns when
 * a round is open, when nothing is left to do, or when the day is skipped; it throws when a step it sent failed and
 * the chain shows no trace of it.
 */
export async function runDay(o: DayOptions): Promise<Day> {
  const log = o.log ?? (() => {});
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const cfg = o.config;
  const wasm = o.wasm ? wasmInfo(o.wasm) : null;
  const read = async () => planDay(await readHouse(o.chain, cfg), cfg, { wasm, ...(o.anyTime ? { anyTime: true } : {}) });
  const sent: Sent[] = [];
  /** How many times each kind of step went out: a day needs each once, and a few claims dropped at most. */
  const count = new Map<DayStep["kind"], number>();
  let said = "";
  let stale = 0;
  let p = await read();

  for (;;) {
    if (p.kind === "race") return sent.some((x) => x.step === "open") ? { kind: "opened", round: p.round, sent } : { kind: "open", round: p.round, why: p.why, sent };
    if (p.kind === "done" || p.kind === "waiting") return { kind: p.kind, why: p.why, sent };
    if (p.kind === "skip") return { kind: "skipped", why: p.why, sent };
    if (p.note && p.note !== said) log((said = p.note));
    const step = p.steps[0]!;
    if (!o.key) return { kind: "unsigned", steps: p.steps, ...(p.stop ? { stop: p.stop } : {}), sent };
    // A vault this run made is right or the run stops: it is never retired and made again in a loop.
    if (step.kind === "retire" && count.has("create")) throw new Error(`the vault this run made cannot take a round: ${p.note ?? "see the chain"}`);
    const n = (count.get(step.kind) ?? 0) + 1;
    if (n > (step.kind === "unstick" ? 16 : 1)) throw new Error(`${step.kind} was sent and the chain asks for it again: stopping`);
    count.set(step.kind, n);

    log(stepText(step, cfg));
    const tx = stepTx(step, cfg, o.wasm);
    let hash = "(the answer was lost)";
    let failure = "";
    try {
      const r = await send(o.chain, cfg.house, o.key, tx.receiver, tx.actions);
      for (const line of r.logs ?? []) if (!line.startsWith("EVENT_JSON:")) log(`  ${line}`);
      hash = r.hash;
      if (!r.ok) failure = r.error ?? "failed";
    } catch (e) {
      failure = (e as Error).message;
    }
    // A nonce a node read a moment too early: the transaction was never taken, so it is signed again with a fresh one.
    if (/InvalidNonce/.test(failure) && stale < 3) {
      stale += 1;
      count.set(step.kind, n - 1);
      await sleep(2_000);
      p = await read();
      continue;
    }
    // What counts is the chain, whatever the answer was: once the step is no longer the next one (it went through, it
    // landed after its answer was lost, or someone else made the same call first), the day goes on. A step that
    // failed and is still the next one stops the run. A node may also answer a moment behind the block the step is
    // final in, so the chain is asked again for a while before either is said.
    const until = Date.now() + (o.settleMs ?? 60_000);
    for (;;) {
      const next = await read().catch((e: Error) => (failure ? null : Promise.reject(e)));
      if (next && !(next.kind === "steps" && same(next.steps[0]!, step))) {
        log(failure ? `  ${step.kind}: ${failure}; the chain has moved on all the same` : `  ${step.kind} ok ${hash}`);
        sent.push({ step: step.kind, hash });
        p = next;
        break;
      }
      if (Date.now() >= until) {
        throw new Error(failure ? `${step.kind} failed: ${failure}` : `${step.kind} went through (${hash}) and the chain still asks for it`);
      }
      await sleep(5_000);
    }
  }
}

/** The lines the workflow's summary shows for the house's round. */
export function daySummary(day: Day, cfg: HouseConfig): string[] {
  const txs = day.sent.map((s) => `- \`${s.step}\`: ${s.hash}`);
  if (day.kind === "opened" || day.kind === "open") {
    const r = day.round;
    return [
      `### Round ${r.id}`,
      "",
      `- target: \`${r.challenge}\` on \`${r.safe}\` (code \`${cfg.safeCode}\`)`,
      `- in the vault: ${near(cfg.round.safe)}, deposit: ${near(cfg.round.deposit)}, a drain counts from ${near(cfg.round.minLoot)}`,
      `- masks: ${cfg.masks.map((m) => `\`${m}\``).join(", ")}`,
      `- sealing until ${when(r.commitUntilNs)}, deadline ${when(r.deadlineNs)}`,
      ...(day.kind === "open" ? [`- not opened by this run: ${day.why}`] : []),
      ...txs,
    ];
  }
  if (day.kind === "unsigned") {
    return [
      "### The house's round waits for a signature",
      "",
      ...day.steps.map((s) => `- ${stepText(s, cfg)}`),
      ...(day.stop ? [`- then no round opens: ${day.stop}`] : []),
    ];
  }
  return [`### ${day.kind === "skipped" ? "No round today" : "Nothing to do"}`, "", day.why, ...txs];
}
