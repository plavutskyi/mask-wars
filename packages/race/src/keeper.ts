/**
 * The keeper: the arena's side of the people's masks (contracts/masks). A person forges a mask in the factory; the
 * mask has no key of its own. For each sealed round the keeper arms it: the factory asks the bounty contract that the
 * round is open, in its commit window, with the mask on its list, and only then puts two race keys on the mask's
 * account, one on the bounty contract and one on the round's safe. After the round the keeper settles: the mind's
 * real cost goes from the mask's tank to the treasury that pays NEAR AI, the rest goes back, the keys are removed.
 *
 * Every key comes from one secret seed, `KEEPER_SEED`, which lives only in the `live-race` environment, next to the
 * arena's own masks' seeds, and only the jobs that sign read it (`arm`, `drain`, `settle` of `Live race`): never the
 * race job, which runs the models and the sandbox. The key for a mask, a round and a receiver is the ed25519 key whose
 * 32-byte seed is HMAC-SHA256(seed, "maskwars-human-key:" + mask + ":" + round + ":" + receiver): new keys every round,
 * so a key that leaked is dead once its round is settled. The keeper's own key, a function-call key on the keeper's
 * account for the factory's `arm` and `settle` only, is HMAC-SHA256(seed, "maskwars-keeper-key:" + factory); the
 * owner adds its public half once (`scripts/testnet/keeper-key.ps1`).
 *
 * What a leaked `KEEPER_SEED` gives away: the race keys of the people's masks in rounds still open, which can seal
 * junk in a mask's name or play its turn, and the keeper's key, which can arm a mask only for a round one of the
 * factory's teams opened with the mask on its list (the factory checks), and settle a race for at most what it held
 * (0.05 NEAR by default, one race an hour).
 * No key from it attaches NEAR or calls the mask itself: a mask's prize stays on its account for its owner.
 */
import { createHmac } from "node:crypto";
import { base58Encode, call, view, NearKey, type Chain } from "./near-tx.ts";

export const HUMAN_KEY_LABEL = "maskwars-human-key:";
export const KEEPER_KEY_LABEL = "maskwars-keeper-key:";
/** The safe methods a person's mask's key reaches: a sealed plan on a live safe is `set_owner` then `sweep`. */
export const HUMAN_SAFE_METHODS = ["set_owner", "sweep"] as const;
/** Gas for `arm`: three views of the round, the check, the keys and the callback. */
export const ARM_TGAS = 150;
/** The bounty contract takes claims until this long after a round's deadline (`CLAIM_GRACE_HOURS` there). */
export const CLAIM_GRACE_NS = 12n * 3_600_000_000_000n;
const SETTLE_TGAS = 60;

function seeded(seedHex: string, label: string): NearKey {
  if (!/^[0-9a-f]{64}$/.test(seedHex)) throw new Error("KEEPER_SEED is 32 bytes in lowercase hex");
  const seed = createHmac("sha256", Buffer.from(seedHex, "hex")).update(label, "utf8").digest();
  return new NearKey(`ed25519:${base58Encode(seed)}`);
}

/** A person's mask's race key for one round and one receiver: the bounty contract or the round's safe. */
export function humanKey(seedHex: string, mask: string, round: string, receiver: string): NearKey {
  return seeded(seedHex, `${HUMAN_KEY_LABEL}${mask}:${round}:${receiver}`);
}

/** The keeper's own key: a function-call key on the keeper's account for the factory's `arm` and `settle`. */
export function keeperKey(seedHex: string, factory: string): NearKey {
  return seeded(seedHex, `${KEEPER_KEY_LABEL}${factory}`);
}

/** The two keys a person's mask plays one round with, as `drain-live` takes them. */
export function humanRoundKeys(
  seedHex: string,
  mask: string,
  round: string,
  safe: string,
  bountyContract: string,
): { safeKey: NearKey; claimKey: NearKey } {
  return { safeKey: humanKey(seedHex, mask, round, safe), claimKey: humanKey(seedHex, mask, round, bountyContract) };
}

/** A mask name in the factory: 3 to 16 lowercase letters and digits, starting with a letter (`name_ok`). */
const NAME = /^[a-z][a-z0-9]{2,15}$/;

/** The mask's name when `account` is a mask a person forged in `factory` (a direct sub-account), else `null`. */
export function humanName(account: string, factory: string): string | null {
  if (!account.endsWith(`.${factory}`)) return null;
  const name = account.slice(0, -factory.length - 1);
  return NAME.test(name) ? name : null;
}

/** A mask as the factory shows it (`get_mask`): amounts in yoctoNEAR, times in ns, as decimal strings. */
export interface FactoryMask {
  readonly name: string;
  readonly account: string;
  readonly owner: string;
  readonly look: string;
  readonly model: string;
  readonly style: string;
  readonly strategy: boolean;
  readonly born_ns: string;
  readonly fuel: string;
  readonly brain: string;
  readonly spent: string;
  readonly race_limit: string;
  readonly races: number;
  readonly state: "forging" | "ready" | "racing" | "paused";
  readonly race: { readonly race: string; readonly held: string; readonly armed_ns: string; readonly keys: readonly string[] } | null;
  readonly code: string;
}

export interface KeeperOptions {
  readonly chain: Chain;
  /** The mask factory, e.g. `masks.tinygif8324.testnet`. */
  readonly factory: string;
  /** The keeper's account: the factory's `keeper`. */
  readonly keeper: string;
  /** `KEEPER_SEED`: 32 bytes in hex. */
  readonly seed: string;
  readonly bountyContract: string;
  readonly bountyId: string;
  /** The teams whose rounds the keeper arms masks for: ours. */
  readonly team: readonly string[];
  readonly log?: (line: string) => void;
  /** The chain's time, ns; by default the latest final block's. */
  readonly now?: () => Promise<bigint>;
}

interface RoundTerms {
  readonly safe: string;
  readonly masks: readonly string[];
  readonly commitUntil: bigint;
  readonly owner: string;
  readonly state: string;
}

async function terms(o: KeeperOptions): Promise<RoundTerms> {
  const race = await view<{ safe: string; masks: string[] } | null>(o.chain, o.bountyContract, "get_safe", { id: o.bountyId });
  const round = await view<{ commit_until: string } | null>(o.chain, o.bountyContract, "get_round", { id: o.bountyId });
  const bounty = await view<{ owner: string; status: { state: string } } | null>(o.chain, o.bountyContract, "get", { id: o.bountyId });
  if (!race || !round || !bounty) throw new Error(`${o.bountyId} is not a sealed round on ${o.bountyContract}`);
  return { safe: race.safe, masks: race.masks, commitUntil: BigInt(round.commit_until), owner: bounty.owner, state: bounty.status.state };
}

async function finalTime(chain: Chain): Promise<bigint> {
  const b = (await chain.rpc("block", { finality: "final" })) as { header: { timestamp_nanosec?: string; timestamp?: number } };
  return BigInt(b.header.timestamp_nanosec ?? b.header.timestamp ?? 0);
}

/** The keys on an account, by their public half. */
export async function keysOn(chain: Chain, account: string): Promise<Set<string>> {
  const list = (await chain.rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: account })) as {
    keys: { public_key: string }[];
  };
  return new Set(list.keys.map((k) => k.public_key));
}

/** The people's masks on the round's list. */
export function humansOf(masks: readonly string[], factory: string): { name: string; account: string }[] {
  return masks.flatMap((account) => {
    const name = humanName(account, factory);
    return name ? [{ name, account }] : [];
  });
}

export interface Armed {
  readonly name: string;
  readonly account: string;
  readonly armed: boolean;
  /** Why it was not armed, or what was checked. */
  readonly note: string;
  /** The mask's model and style, for the race job: public on the factory anyway. */
  readonly model?: string;
  readonly style?: string;
}

/**
 * Arms every person's mask on the round's list that can race: forged, not paused, with fuel. Only a round one of our
 * teams opened, still in its commit window. A mask already armed for this very round counts as armed, so a second run
 * does no harm. Each arming is checked on chain afterwards: the factory's record names this round and both keys are on
 * the mask's account.
 */
export async function armHumans(o: KeeperOptions): Promise<Armed[]> {
  const log = o.log ?? (() => {});
  const t = await terms(o);
  if (!o.team.includes(t.owner)) throw new Error(`${o.bountyId} was opened by ${t.owner}, not by our team: the keeper arms no mask for it`);
  if (t.state !== "open") throw new Error(`${o.bountyId} is ${t.state}, not open`);
  const now = await (o.now ?? (() => finalTime(o.chain)))();
  if (now >= t.commitUntil) throw new Error(`${o.bountyId}: the commit window is closed, a mask armed now could not seal`);
  const own = keeperKey(o.seed, o.factory);
  const out: Armed[] = [];
  for (const { name, account } of humansOf(t.masks, o.factory)) {
    const m = await view<FactoryMask | null>(o.chain, o.factory, "get_mask", { name });
    const done = (armed: boolean, note: string) => {
      log(`${name.padEnd(16)} ${armed ? "armed" : "not armed"}: ${note}`);
      out.push({ name, account, armed, note, ...(m ? { model: m.model, style: m.style } : {}) });
    };
    if (!m) {
      done(false, "the factory has no such mask");
      continue;
    }
    const arena = humanKey(o.seed, account, o.bountyId, o.bountyContract);
    const target = humanKey(o.seed, account, o.bountyId, t.safe);
    if (m.state === "racing" && m.race?.race === o.bountyId) {
      const on = await keysOn(o.chain, account);
      done(on.has(arena.publicKeyText) && on.has(target.publicKeyText), "already armed for this round");
      continue;
    }
    if (m.state !== "ready") {
      done(false, `the mask is ${m.state}`);
      continue;
    }
    const budget = await view<string>(o.chain, o.factory, "budget", { name });
    if (BigInt(budget) === 0n) {
      done(false, "the mind is out of fuel");
      continue;
    }
    const r = await call(o.chain, o.keeper, own, o.factory, "arm", {
      name,
      race: o.bountyId,
      arena_key: arena.publicKeyText,
      target: t.safe,
      target_key: target.publicKeyText,
      target_methods: [...HUMAN_SAFE_METHODS],
    }, ARM_TGAS);
    if (!r.ok) {
      done(false, `arm failed: ${r.error ?? r.hash}`);
      continue;
    }
    const after = await view<FactoryMask | null>(o.chain, o.factory, "get_mask", { name });
    const on = await keysOn(o.chain, account);
    if (r.value === true && after?.race?.race === o.bountyId && on.has(arena.publicKeyText) && on.has(target.publicKeyText)) {
      done(true, `${r.hash}, holds ${after.race.held} for the mind`);
    } else {
      const why = (r.logs ?? []).find((l) => l.includes("refused") || l.includes("no key")) ?? "the keys are not on the mask";
      done(false, `${r.hash}: ${why}`);
    }
  }
  return out;
}

/** What a person's mask's mind spent in a race, as the race job counts it (src/brain.ts): NEAR AI's price for every
 * token the model used, as the mind's module counted them inside its TEE, in whole steps rounded down. What OutLayer
 * charged to run the mind is not in it: the arena pays that. `calls` is the answers the tokens were counted for. */
export interface MindCost {
  readonly usd: number;
  readonly calls: number;
}

/** The race job's `--costs` file: the round it raced and what each person's mind spent in it. */
export interface CostsFile {
  readonly bounty: string;
  readonly costs: Readonly<Record<string, MindCost>>;
}

/**
 * What each mind spent in round `bounty`, in dollars, from the race job's costs file. No file settles at no cost (the
 * `Keeper` workflow without a run). A file of another round, or one that names no round, is refused: the keeper never
 * charges a mask what its mind spent somewhere else.
 */
export function costsFor(text: string, bounty: string): Map<string, number> {
  if (!text.trim()) return new Map();
  let file: Partial<CostsFile>;
  try {
    file = JSON.parse(text) as Partial<CostsFile>;
  } catch {
    throw new Error("the costs file is not JSON: nothing settled");
  }
  if (typeof file.bounty !== "string" || !file.costs || typeof file.costs !== "object") {
    throw new Error("the costs file names no round: nothing settled");
  }
  if (file.bounty !== bounty) throw new Error(`the costs file is of ${file.bounty}, not of ${bounty}: nothing settled`);
  return new Map(
    Object.entries(file.costs).map(([account, c]) => [account, typeof c?.usd === "number" && c.usd > 0 ? c.usd : 0]),
  );
}

/**
 * The cost in yoctoNEAR at `nearUsd` dollars a NEAR, rounded down: the mind never pays more than it spent.
 */
export function costYocto(usd: number, nearUsd: number): bigint {
  if (!(usd > 0) || !(nearUsd > 0)) return 0n;
  // Twelve decimals of NEAR are far below a token's price; the rest of the yocto are zeros.
  const micro = Math.floor((usd / nearUsd) * 1e12);
  return BigInt(micro) * 10n ** 12n;
}

export interface Settled {
  readonly name: string;
  readonly account: string;
  readonly settled: boolean;
  readonly spent: string;
  readonly note: string;
}

/**
 * Settles every person's mask armed for this round: what its mind spent (`costs`, yoctoNEAR, never more than the race
 * held) goes to the treasury, the rest goes back to its tank, its race keys are removed. A mask in `keep` is left
 * armed: its sealed plan is still in play, and it needs its keys to reveal or claim; a later run settles it.
 */
export async function settleHumans(o: KeeperOptions, costs: ReadonlyMap<string, bigint>, keep: ReadonlySet<string> = new Set()): Promise<Settled[]> {
  const log = o.log ?? (() => {});
  const race = await view<{ masks: string[] } | null>(o.chain, o.bountyContract, "get_safe", { id: o.bountyId });
  if (!race) throw new Error(`${o.bountyId} is not a live race on ${o.bountyContract}`);
  const own = keeperKey(o.seed, o.factory);
  const out: Settled[] = [];
  for (const { name, account } of humansOf(race.masks, o.factory)) {
    const done = (settled: boolean, spent: bigint, note: string) => {
      log(`${name.padEnd(16)} ${settled ? "settled" : "not settled"}: ${note}`);
      out.push({ name, account, settled, spent: spent.toString(), note });
    };
    const m = await view<FactoryMask | null>(o.chain, o.factory, "get_mask", { name });
    if (!m?.race || m.race.race !== o.bountyId) {
      done(false, 0n, "not armed for this round");
      continue;
    }
    if (keep.has(account)) {
      done(false, 0n, "its sealed plan is still in play: it keeps its keys until the round is over");
      continue;
    }
    const held = BigInt(m.race.held);
    const cost = costs.get(account) ?? 0n;
    const spent = cost < held ? cost : held;
    const r = await call(o.chain, o.keeper, own, o.factory, "settle", { name, race: o.bountyId, spent: spent.toString() }, SETTLE_TGAS);
    done(r.ok, spent, r.ok ? `${r.hash}: the mind paid ${spent} of ${held} held` : `settle failed: ${r.error ?? r.hash}`);
  }
  return out;
}

/**
 * The masks whose sealed plan is still in play in this round, so the keeper must not take their keys yet. A mask with a
 * claim with the judge keeps them until the judge answers. Every other mask that sealed, whatever its seal's state now,
 * keeps them for as long as the bounty contract would still take its claim: while the bounty is open and the claim
 * grace after the deadline is not over. A refused drain may claim again in that time, and a revealed plan claims after
 * the reveal window too.
 */
export async function stillInPlay(o: Pick<KeeperOptions, "chain" | "bountyContract" | "bountyId" | "now">): Promise<Set<string>> {
  const round = await view<{
    seals: { mask: string; state: string }[];
    judging: string[];
  } | null>(o.chain, o.bountyContract, "get_round", { id: o.bountyId });
  const bounty = await view<{ deadline_ns: string; status: { state: string } } | null>(o.chain, o.bountyContract, "get", { id: o.bountyId });
  if (!round || !bounty) return new Set();
  const judging = new Set(round.judging);
  if (bounty.status.state !== "open" && bounty.status.state !== "judging") return judging;
  const now = await (o.now ?? (() => finalTime(o.chain)))();
  if (now >= BigInt(bounty.deadline_ns) + CLAIM_GRACE_NS) return judging;
  for (const s of round.seals) if (["sealed", "revealed", "refused", "confirmed"].includes(s.state)) judging.add(s.mask);
  return judging;
}
