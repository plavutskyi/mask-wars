/**
 * The winning plan, played again on a real chain by the winning mask with its own keys, in a sealed round
 * (RULES.md). The sandbox names its accounts `*.test.near`; here they become the race's safe on chain, the mask's
 * account and the safe's owner. A sweep asks for at most what the real safe can pay out, since the sandbox safe holds
 * a different amount.
 *
 * 1. `sealLive`, while the commit window is open: the mask turns its plan into the calls it will send the safe and
 *    puts only their hash on the bounty contract (`commit`). Nobody sees the plan.
 * 2. `playLive`, once the window has closed: the mask sends those exact calls to the safe, reveals the plan, the salt
 *    and the transactions (`reveal`) before the reveal window ends, and claims its drain (`claim_drain`). The safe is
 *    locked to the round: only the masks that sealed move it, in the order of the seals, and the mask's first call
 *    starts its one turn, in which nobody else moves the safe; while another mask has its turn, an earlier seal still
 *    goes first, or the mask missed its slot and the later seals go first, the mask waits, but never past the reveal
 *    window. The judge checks that the transactions are the sealed plan, played whole in the mask's own turn from its
 *    first move.
 *
 * Every call is checked before it is sealed and again before it is signed: it may name only the mask, the safe and
 * the safe's owner, a sweep pays only the mask and the safe is handed only to the mask. Whatever the model wrote, the
 * mask's key never sends the safe's NEAR anywhere else. Each call gets a fixed, small amount of gas, and the mask
 * plays only when its key's allowance covers the whole plan: a plan cut off half-way would waste its one turn.
 *
 * A sweep for more than the safe holds is cut, when the mask seals, to what the safe can pay out less `SWEEP_MARGIN`
 * for the storage the turns before the mask's own may add, rounded down to 0.01 NEAR. In a round with the people's
 * masks (`sweep: "min_loot"`) a sweep asks for exactly the round's `min_loot` instead: an earlier seal then leaves the
 * safe enough for every later sealed plan, whoever sealed it, and still wins the bounty if it is the earliest. The salt
 * comes from the mask's own key (`sealSalt`), so a job that dies between commit and reveal can be run again:
 * `resumeLive` rebuilds the sealed plan, finds the cut it sealed, and checks it against the seal on chain.
 *
 * Each mask has two function-call keys, because NEAR gives such a key exactly one receiver and never lets it attach
 * NEAR: one on the safe, one on the bounty contract (`commit`, `reveal`, `claim_drain`, `settle`). Neither can move the
 * mask's own NEAR. A key from the mask's seed (keys.ts) reaches any method of its one safe, so it plays any safe of the
 * library; an old key on the safe reaches only `set_owner` and `sweep`.
 */
import type { Challenge } from "./challenge.ts";
import { call, view, type Chain, type NearKey } from "./near-tx.ts";
import type { Plan } from "./plan.ts";
import { planText, sealHash, sealSalt, type SealedCall } from "./seal.ts";

/** The race as the bounty contract holds it (`get_safe`). */
export interface SafeRace {
  readonly safe: string;
  readonly masks: readonly string[];
  readonly min_loot: string;
}

/** One seal as the contract shows it (`get_round`). */
export interface RoundSeal {
  readonly mask: string;
  readonly hash: string;
  readonly seq: number;
  readonly state: "sealed" | "revealed" | "confirmed" | "refused";
  readonly plan: string | null;
  readonly txs: readonly string[];
}

/** The sealed round (`get_round`): times in nanoseconds as decimal strings. */
export interface RoundView {
  readonly commit_until: string;
  /** A seal not revealed by then drops out. */
  readonly reveal_until: string;
  readonly deadline_ns: string;
  readonly seals: readonly RoundSeal[];
  /** Masks whose claim is with the judge right now. */
  readonly judging: readonly string[];
}

export interface LiveOptions {
  readonly chain: Chain;
  /** The bounty contract and the live race's id on it. */
  readonly bountyContract: string;
  readonly bountyId: string;
  /** The mask's account and its two keys. */
  readonly mask: string;
  readonly safeKey: NearKey;
  readonly claimKey: NearKey;
  /** The teams whose rounds the mask plays (ours: the owner and the season's treasury); by default any team, as long
   * as the round is the safe's own team's. */
  readonly team?: string | readonly string[] | undefined;
  /** What a sealed sweep asks for: all the safe can pay out less the margin (the arena's own rounds), or exactly the
   * round's `min_loot` (a round with the people's masks, so an early seal spoils no later plan). By default `all`. */
  readonly sweep?: SweepRule;
  readonly log?: (line: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
}

export type SweepRule = "all" | "min_loot";

/**
 * The sweep rule of a round from its masks: `min_loot` as soon as one mask on its list is not one of `ours` (a person's
 * mask from the factory, say), `all` when every mask is the arena's own.
 */
export function sweepRuleOf(masks: readonly string[], ours: readonly string[]): SweepRule {
  return masks.every((m) => ours.includes(m)) ? "all" : "min_loot";
}

export interface SealOptions extends LiveOptions {
  readonly challenge: Challenge;
  readonly plan: Plan;
  /** The safe methods the mask's key reaches; `null` for any. By default `set_owner` and `sweep`. */
  readonly safeMethods?: ReadonlySet<string> | null;
  /** Salt for the seal; by default the one the mask's key on the bounty contract gives (`sealSalt`). */
  readonly salt?: string;
}

/** What the mask keeps to itself between sealing and revealing. */
export interface Sealed {
  readonly safe: string;
  readonly calls: readonly SealedCall[];
  readonly plan: string;
  readonly salt: string;
  readonly hash: string;
  readonly seq: number;
  /** End of the commit window, ns. */
  readonly commitUntil: bigint;
}

export interface PlayOptions extends LiveOptions {
  /** How long to wait for the end of the commit window; the default waits as long as it takes. */
  readonly windowWaitMs?: number;
  /** How long to wait for the judge's answer; 0 does not wait. */
  readonly judgeWaitMs?: number;
}

export interface PlayResult {
  /** Every call the mask sent to the safe, in order. */
  readonly calls: readonly { readonly method: string; readonly hash: string; readonly ok: boolean; readonly error?: string }[];
  readonly revealTx: string | null;
  /** The sweep that moved the most to the mask: the drain the mask claims. */
  readonly drainTx: string | null;
  readonly claimTx: string | null;
  /** The bounty's state after the judge answered, or while it still thinks. */
  readonly status: string | null;
  /** The mask's seal after the judge answered: `confirmed` may still wait for an earlier seal. */
  readonly seal: RoundSeal["state"] | null;
}

const DEFAULT_GAS_TGAS = 30;
/** Gas for one call on the safe: `set_owner` and `sweep` burn a few TGas. NEAR takes the whole prepaid gas out of a
 * function-call key's allowance, so a plan never asks for more. */
export const SAFE_CALL_TGAS = 15;
/** What one TGas of prepaid gas costs a key's allowance at most, yoctoNEAR (0.001 NEAR, at the pessimistic price). */
const ALLOWANCE_PER_TGAS = 10n ** 21n;
/** A sweep cut to what the safe holds is rounded down to this, so the same plan comes out again a little later. */
const SWEEP_STEP = 10n ** 22n;
/** What a cut sweep leaves in the safe: the storage that the turns before the mask's own may add (a mask's first move
 * and its turn take about 0.0015 NEAR; 16 masks and the owner's longest name fit). */
export const SWEEP_MARGIN = 3n * 10n ** 22n;
/** How many steps of 0.01 NEAR either side of today's cut `resumeLive` tries to find the one it sealed. */
const RESUME_STEPS = 50n;
const CLAIM_GAS_TGAS = 200;
/** All an old key on the safe can call (masks.ps1). The sandbox lets a plan call anything; NEAR would refuse the rest. */
export const SAFE_KEY_METHODS: ReadonlySet<string> = new Set(["set_owner", "sweep"]);

/** Sandbox account id → its account on chain. A string that names any other sandbox account cannot be played. */
export function accountMap(challenge: Challenge, onChain: { safe: string; mask: string; owner: string }): Map<string, string> {
  const m = new Map<string, string>([
    [challenge.targetId, onChain.safe],
    [challenge.attackerId, onChain.mask],
  ]);
  const owner = challenge.manifest.init.args?.owner;
  if (typeof owner === "string") m.set(owner, onChain.owner);
  return m;
}

/** A NEAR account id: 2-64 of a-z 0-9 - _ . with no separator at the edges or doubled. */
const ACCOUNT = /^(?=.{2,64}$)[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;

/**
 * The guard on every call the mask plays on chain (A9): its arguments may name only the round's accounts (the mask,
 * the safe, the safe's owner) besides plain numbers; a sweep pays only the mask, and the safe is handed only to the
 * mask. A plan that a prompt injection or a slip of the model pointed anywhere else is refused before it is sealed or
 * signed.
 */
export function guardCall(call: SealedCall, round: { safe: string; mask: string; owner: string }): void {
  const allowed = new Set([round.safe, round.mask, round.owner]);
  const visit = (v: unknown, at: string): void => {
    if (typeof v === "string") {
      if (/^\d+$/.test(v) || allowed.has(v)) return;
      throw new Error(`${call.method}: ${at} names ${ACCOUNT.test(v) ? "an account outside the round" : "something that is not an amount"}: ${v}`);
    }
    if (Array.isArray(v)) v.forEach((x, i) => visit(x, `${at}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) visit(x, at ? `${at}.${k}` : k);
  };
  visit(call.args, "");
  if (call.method === "sweep" && call.args.to !== round.mask) throw new Error(`sweep pays only the mask, not ${String(call.args.to)}`);
  if (call.method === "set_owner" && call.args.new_owner !== round.mask) {
    throw new Error(`set_owner hands the safe only to the mask, not ${String(call.args.new_owner)}`);
  }
}

/** `args` with every sandbox account replaced by its account on chain. */
export function translateArgs(args: unknown, accounts: ReadonlyMap<string, string>): unknown {
  if (typeof args === "string") {
    const real = accounts.get(args);
    if (real) return real;
    if (args.endsWith(".test.near")) throw new Error(`${args} exists only in the sandbox`);
    return args;
  }
  if (Array.isArray(args)) return args.map((a) => translateArgs(a, accounts));
  if (args && typeof args === "object") {
    return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, translateArgs(v, accounts)]));
  }
  return args;
}

/**
 * The sandbox plan as the calls the mask will send the real safe: views dropped, calls its key cannot make skipped,
 * accounts translated, a sweep cut to what the safe can pay out now (or `available`, when given) less `SWEEP_MARGIN`.
 */
export async function chainPlan(o: {
  chain: Chain;
  challenge: Challenge;
  plan: Plan;
  safe: string;
  mask: string;
  safeMethods?: ReadonlySet<string> | null;
  available?: bigint;
  /** A sweep asks for exactly this, whatever the sandbox swept: the round's `min_loot` under the `min_loot` rule. */
  sweepTo?: bigint;
  log?: (line: string) => void;
}): Promise<SealedCall[]> {
  const log = o.log ?? (() => {});
  // A round's safe is its own owner, and every turn on it starts so: the sandbox owner is the safe on chain.
  const round = { safe: o.safe, mask: o.mask, owner: o.safe };
  const accounts = accountMap(o.challenge, round);
  const calls: SealedCall[] = [];
  for (const step of o.plan.steps) {
    if (step.kind === "view") continue;
    const reach = o.safeMethods === undefined ? SAFE_KEY_METHODS : o.safeMethods;
    if (reach && !reach.has(step.method)) {
      log(`${step.method.padEnd(10)} skip: the mask's key does not reach it`);
      continue;
    }
    if (step.deposit && BigInt(step.deposit) > 0n) throw new Error(`${step.method}: a mask's key on the safe attaches no NEAR`);
    const args = translateArgs(step.args ?? {}, accounts) as Record<string, unknown>;
    if (step.method === "sweep" && typeof args.amount === "string" && o.sweepTo !== undefined) {
      args.amount = o.sweepTo.toString();
    } else if (step.method === "sweep" && typeof args.amount === "string") {
      const available = o.available ?? BigInt(await view<string>(o.chain, o.safe, "available"));
      const room = available > SWEEP_MARGIN ? available - SWEEP_MARGIN : 0n;
      if (BigInt(args.amount) > room) args.amount = ((room / SWEEP_STEP) * SWEEP_STEP).toString();
    }
    const call = { method: step.method, args };
    guardCall(call, round);
    calls.push(call);
  }
  return calls;
}

/** The round the safe is locked to (the safe's `get_round`), as the bounty contract armed it. */
interface SafeLock {
  readonly arbiter: string;
  readonly bounty: string;
  readonly opens_ns: string;
}

/**
 * The safe must be locked to this very round: armed by this bounty contract, for this bounty, until the end of its
 * commit window, and the round must be the safe's own team's: whoever opened the bounty is the team the safe was
 * deployed for (and the team the mask plays for, when it names one). On any other safe no plan can win, or the round is
 * not the one the team meant, so the mask does not seal or play one.
 */
export async function checkLocked(o: LiveOptions, safe: string, commitUntil: bigint): Promise<void> {
  const lock = await view<SafeLock | null>(o.chain, safe, "get_round").catch(() => null);
  if (!lock || lock.arbiter !== o.bountyContract || lock.bounty !== o.bountyId || BigInt(lock.opens_ns) !== commitUntil) {
    throw new Error(`${safe} is not locked to ${o.bountyId} on ${o.bountyContract}: no plan on it can win`);
  }
  const team = await view<string | null>(o.chain, safe, "team").catch(() => null);
  const bounty = await view<{ owner: string } | null>(o.chain, o.bountyContract, "get", { id: o.bountyId });
  const ours = o.team === undefined ? undefined : [o.team].flat();
  if (!team || bounty?.owner !== team || (ours !== undefined && !ours.includes(team))) {
    throw new Error(`${o.bountyId} was opened by ${bounty?.owner ?? "nobody"}, not by the team of ${safe}: not our round`);
  }
}

/** What the key's allowance still pays for, yoctoNEAR; `null` for a key with no limit. */
export async function allowanceLeft(chain: Chain, account: string, key: NearKey): Promise<bigint | null> {
  const k = (await chain.rpc("query", {
    request_type: "view_access_key",
    finality: "final",
    account_id: account,
    public_key: key.publicKeyText,
  })) as { permission?: { FunctionCall?: { allowance?: string | null } } | string };
  const fc = typeof k.permission === "object" ? k.permission.FunctionCall : undefined;
  return fc?.allowance ? BigInt(fc.allowance) : null;
}

/** The latest final block's time, ns. */
export async function chainTime(chain: Chain): Promise<bigint> {
  const b = (await chain.rpc("block", { finality: "final" })) as { header: { timestamp_nanosec?: string; timestamp?: number } };
  return BigInt(b.header.timestamp_nanosec ?? b.header.timestamp ?? 0);
}

async function loadRound(o: LiveOptions): Promise<{ race: SafeRace; round: RoundView }> {
  const race = await view<SafeRace | null>(o.chain, o.bountyContract, "get_safe", { id: o.bountyId });
  if (!race) throw new Error(`${o.bountyId} is not a live race on ${o.bountyContract}`);
  if (!race.masks.includes(o.mask)) throw new Error(`${o.mask} is not a mask of ${o.bountyId}`);
  const round = await view<RoundView | null>(o.chain, o.bountyContract, "get_round", { id: o.bountyId });
  if (!round) throw new Error(`${o.bountyId} has no sealed round`);
  return { race, round };
}

/** Step 1, in the commit window: the mask seals its plan. Only the hash goes on chain. */
export async function sealLive(o: SealOptions): Promise<Sealed> {
  const log = o.log ?? (() => {});
  const { race: r, round } = await loadRound(o);
  const commitUntil = BigInt(round.commit_until);
  if ((await chainTime(o.chain)) >= commitUntil) throw new Error(`${o.bountyId}: the commit window is closed`);
  await checkLocked(o, r.safe, commitUntil);
  const sweepTo = o.sweep === "min_loot" ? BigInt(r.min_loot) : undefined;
  if (sweepTo !== undefined) {
    const available = BigInt(await view<string>(o.chain, r.safe, "available"));
    if (available < sweepTo) throw new Error(`the safe can pay out ${available}, less than the round's min_loot: nothing to seal`);
    log(`sweep      min_loot ${sweepTo}: the round has the people's masks, an early seal leaves the later plans whole`);
  }
  const calls = await chainPlan({ ...o, safe: r.safe, log, ...(sweepTo === undefined ? {} : { sweepTo }) });
  // An old key reaches only set_owner and sweep: without a sweep such a plan takes nothing. A seed's key plays any
  // safe of the library, whose drain may be any call.
  const reach = o.safeMethods === undefined ? SAFE_KEY_METHODS : o.safeMethods;
  if (reach && !calls.some((c) => c.method === "sweep")) throw new Error("the plan never sweeps the safe: nothing to seal");
  if (calls.length === 0) throw new Error("the plan makes no call the mask's key reaches: nothing to seal");
  const plan = planText(calls);
  const salt = o.salt ?? sealSalt(o.claimKey, o.bountyId, o.mask);
  const hash = sealHash(o.bountyId, o.mask, salt, plan);
  const res = await call(o.chain, o.mask, o.claimKey, o.bountyContract, "commit", { id: o.bountyId, hash }, DEFAULT_GAS_TGAS);
  if (!res.ok) throw new Error(`commit failed: ${res.error ?? res.hash}`);
  const seal = (await view<RoundView>(o.chain, o.bountyContract, "get_round", { id: o.bountyId })).seals.find((s) => s.mask === o.mask);
  log(`commit     ok   ${res.hash} seal #${seal?.seq ?? "?"} ${hash.slice(0, 12)}`);
  return { safe: r.safe, calls, plan, salt, hash, seq: seal?.seq ?? -1, commitUntil };
}

/**
 * Step 1 again, for a job that died after `commit`: the mask's seal is on chain, the plan and the salt are rebuilt
 * from the same finding and the same key, and must give that very seal.
 */
export async function resumeLive(o: SealOptions): Promise<Sealed> {
  const log = o.log ?? (() => {});
  const { race: r, round } = await loadRound(o);
  const seal = round.seals.find((s) => s.mask === o.mask);
  if (!seal) throw new Error(`${o.mask} sealed no plan in ${o.bountyId}`);
  if (seal.state !== "sealed") throw new Error(`${o.mask}'s seal is already ${seal.state}`);
  const salt = o.salt ?? sealSalt(o.claimKey, o.bountyId, o.mask);
  if (o.sweep === "min_loot") {
    // The sweep asked for min_loot exactly: the plan comes out the same whatever the safe holds now.
    const calls = await chainPlan({ ...o, safe: r.safe, sweepTo: BigInt(r.min_loot), log });
    const plan = planText(calls);
    if (sealHash(o.bountyId, o.mask, salt, plan) !== seal.hash) {
      throw new Error("the plan rebuilt from this finding is not the sealed one: the finding changed since");
    }
    log(`resume     seal #${seal.seq} ${seal.hash.slice(0, 12)}: the plan and salt match`);
    return { safe: r.safe, calls, plan, salt, hash: seal.hash, seq: seal.seq, commitUntil: BigInt(round.commit_until) };
  }
  // The safe may pay out a little more or less than when the mask sealed (gas rewards, a transfer in, storage), so
  // today's cut may be another step of 0.01 NEAR: try the steps around it until one gives the seal on chain.
  const available = BigInt(await view<string>(o.chain, r.safe, "available"));
  const today = available > SWEEP_MARGIN ? available - SWEEP_MARGIN : 0n;
  const base = (today / SWEEP_STEP) * SWEEP_STEP;
  for (let k = 0n; k <= RESUME_STEPS; k++) {
    for (const cut of k === 0n ? [base] : [base + k * SWEEP_STEP, base - k * SWEEP_STEP]) {
      if (cut < 0n) continue;
      const calls = await chainPlan({ ...o, safe: r.safe, available: cut + SWEEP_MARGIN, log: k === 0n ? log : () => {} });
      const plan = planText(calls);
      if (sealHash(o.bountyId, o.mask, salt, plan) !== seal.hash) continue;
      log(`resume     seal #${seal.seq} ${seal.hash.slice(0, 12)}: the plan and salt match`);
      return { safe: r.safe, calls, plan, salt, hash: seal.hash, seq: seal.seq, commitUntil: BigInt(round.commit_until) };
    }
  }
  throw new Error("the plan rebuilt from this finding is not the sealed one: the safe or the finding changed since");
}

/** The safe's latest turn (`get_turn`): whose it is and until when, ns. */
interface SafeTurn {
  readonly mask: string;
  readonly until_ns: string;
}

/** A call refused because another mask has its turn on the safe, an earlier seal still goes first, or the mask missed
 * its own slot and the later seals play first: the safe lets the mask in later, so it waits and sends the call again,
 * but never past the reveal window, after which a plan can no longer be revealed. */
const OTHERS_TURN = "another mask has its turn on the safe";
const EARLIER_SEAL = "an earlier seal goes first";
const SLOT_MISSED = "this seal missed its slot";
const waits = (why: string | undefined) =>
  !!why && (why.includes(OTHERS_TURN) || why.includes(EARLIER_SEAL) || why.includes(SLOT_MISSED));
/** The mask stops waiting for the safe this long before the reveal window ends: the plan and the reveal must fit. */
const REVEAL_ROOM_NS = 60_000_000_000n;

/** Step 2, after the commit window: the mask plays exactly what it sealed, reveals it and claims its drain. */
export async function playLive(o: PlayOptions, sealed: Sealed): Promise<PlayResult> {
  const log = o.log ?? (() => {});
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const nothing = { revealTx: null, drainTx: null, claimTx: null, status: null, seal: null };

  // Every call is checked again right before it is signed, whatever the seal holds.
  for (const c of sealed.calls) guardCall(c, { safe: sealed.safe, mask: o.mask, owner: sealed.safe });
  await checkLocked(o, sealed.safe, sealed.commitUntil);
  const left = await allowanceLeft(o.chain, o.mask, o.safeKey);
  const needs = BigInt(sealed.calls.length * SAFE_CALL_TGAS) * ALLOWANCE_PER_TGAS;
  if (left !== null && left < needs) {
    throw new Error(`the mask's key on the safe has ${left} yoctoNEAR of allowance, the plan needs up to ${needs}: add a key first`);
  }

  const waitUntil = Date.now() + (o.windowWaitMs ?? Number.POSITIVE_INFINITY);
  while ((await chainTime(o.chain)) < sealed.commitUntil) {
    if (Date.now() > waitUntil) throw new Error("the commit window is still open");
    await sleep(10_000);
  }
  log("the commit window is closed: playing the sealed plan");
  const { round: opened } = await loadRound(o);
  const lastStart = BigInt(opened.reveal_until) - REVEAL_ROOM_NS;
  // Only the masks that sealed move the safe, in the order of the seals: the mask waits until the safe lets it in,
  // without spending its key's allowance on calls the safe would refuse.
  const letIn = async () => {
    for (let said = ""; ; ) {
      const why = await view<string | null>(o.chain, sealed.safe, "waits_for", { account_id: o.mask }).catch(() => null);
      if (!waits(why ?? undefined)) return;
      if ((await chainTime(o.chain)) >= lastStart) {
        throw new Error(`the safe never let the mask in before the reveal window ends (${why}): the seal drops out`);
      }
      if (why !== said) log(`waiting    ${(said = why!)}`);
      await sleep(5_000);
    }
  };
  await letIn();

  const calls: { method: string; hash: string; ok: boolean; error?: string }[] = [];
  let best: { hash: string; amount: bigint } | null = null;
  for (const c of sealed.calls) {
    let r = await call(o.chain, o.mask, o.safeKey, sealed.safe, c.method, c.args, SAFE_CALL_TGAS);
    for (let tries = 0; !r.ok && waits(r.error) && tries < 16; tries++) {
      // Another mask took its turn in the same moment: the mask waits it out and starts its own.
      const turn = await view<SafeTurn | null>(o.chain, sealed.safe, "get_turn");
      log(`${c.method.padEnd(10)} wait ${r.error?.includes(OTHERS_TURN) ? `${turn?.mask ?? "another mask"} has its turn on the safe` : EARLIER_SEAL}`);
      while (turn && (await chainTime(o.chain)) < BigInt(turn.until_ns)) await sleep(5_000);
      await letIn();
      r = await call(o.chain, o.mask, o.safeKey, sealed.safe, c.method, c.args, SAFE_CALL_TGAS);
    }
    calls.push({ method: c.method, hash: r.hash, ok: r.ok, ...(r.error === undefined ? {} : { error: r.error }) });
    log(`${c.method.padEnd(10)} ${r.ok ? "ok  " : "fail"} ${r.hash}`);
    // The judge confirms only a plan played whole: a failed call ends the run here.
    if (!r.ok) return { calls, ...nothing };
    if (c.method === "sweep" && c.args.to === o.mask && typeof c.args.amount === "string") {
      const amount = BigInt(c.args.amount);
      if (!best || amount > best.amount) best = { hash: r.hash, amount };
    }
  }
  const { race: r } = await loadRound(o);
  // A safe drained by another call than sweep (the library's other safes): the drain the mask claims is the plan's
  // last call, which counts everything the plan moved; the judge measures the loot itself.
  if (!sealed.calls.some((c) => c.method === "sweep") && calls.length > 0) {
    best = { hash: calls[calls.length - 1]!.hash, amount: BigInt(r.min_loot) };
  }
  if (!best || best.amount < BigInt(r.min_loot)) {
    log("no sweep moved enough to the mask: nothing to claim");
    return { calls, ...nothing, drainTx: best?.hash ?? null };
  }

  const txs = calls.map((c) => c.hash);
  const reveal = await call(o.chain, o.mask, o.claimKey, o.bountyContract, "reveal", {
    id: o.bountyId,
    plan: sealed.plan,
    salt: sealed.salt,
    txs,
  }, DEFAULT_GAS_TGAS);
  log(`reveal     ${reveal.ok ? "ok  " : "fail"} ${reveal.hash}`);
  if (!reveal.ok) return { calls, ...nothing, revealTx: reveal.hash, drainTx: best.hash };

  // claim_drain waits for the judge on OutLayer: the transaction lands now, the answer comes in later blocks.
  const claim = await call(
    o.chain,
    o.mask,
    o.claimKey,
    o.bountyContract,
    "claim_drain",
    { id: o.bountyId, tx_hash: best.hash },
    CLAIM_GAS_TGAS,
    "INCLUDED_FINAL",
  );
  log(`claim_drain ${claim.ok ? "sent" : "fail"} ${claim.hash}`);
  const base = { calls, revealTx: reveal.hash, drainTx: best.hash, claimTx: claim.hash };
  if (!claim.ok) return { ...base, status: null, seal: null };

  // The bounty stays open while claims are with the judge: the mask's claim is answered once it leaves `judging`.
  let status: string | null = null;
  let seal: RoundSeal["state"] | null = null;
  const until = Date.now() + (o.judgeWaitMs ?? 300_000);
  for (;;) {
    await sleep(5_000);
    const round = await view<RoundView | null>(o.chain, o.bountyContract, "get_round", { id: o.bountyId });
    const b = await view<{ status: { state: string } } | null>(o.chain, o.bountyContract, "get", { id: o.bountyId });
    status = b?.status.state ?? null;
    seal = round?.seals.find((s) => s.mask === o.mask)?.state ?? null;
    const waiting = (round?.judging ?? []).includes(o.mask) || status === "judging";
    if (!waiting || Date.now() >= until) break;
  }
  log(`${o.bountyId}: ${status ?? "unknown"}, seal ${seal ?? "unknown"}`);
  return { ...base, status, seal };
}
