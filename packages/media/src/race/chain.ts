/**
 * A sealed round's record, read from the chain: nobody writes it by hand. The arena reader (`@maskwars/arena`) reads
 * the one round as the contracts and the indexer tell it: who opened it and with what, every seal, every move on the
 * vault, the reveal, the claim, the payout. The judge's own numbers (its OutLayer request, how long it ran, what it
 * cost) are in the logs of the claim transaction, so they are read from there.
 *
 * Any sealed round the arena's bounty contracts hold is read by its id: a season's (`s1-0001-d74851`) and one the
 * team opened by hand (`race-0005`) alike. Only a round that ended in a paid drain makes a record. Any other round is
 * refused, and the error says where the round stands. A chain or an indexer that does not answer is that error, never
 * a round that "does not exist".
 */

import type { NextRace, Race, RaceEvent, Tx, Who } from "@maskwars/arena";
import { SEASON_0 } from "../masks.ts";
import { fromYocto } from "./near.ts";
import type { SealedRound } from "./record.ts";
import { EXAMPLE_ID, parseRace, RACE_ID, ROUND_ID, roundOf } from "./record.ts";

/** What the reader needs of the arena and of the indexer: `Arena` and `Indexer` of `@maskwars/arena` fit. */
export type RoundChain = {
  arena: { round(id: string): Promise<Race | null>; next(): Promise<NextRace | null> };
  indexer: { transactions(hashes: readonly string[]): Promise<Tx[]> };
  /** The moment of the reading; the clock when not given. */
  now?: () => number;
};

export type JudgeRun = { request: number; seconds: number; cost: string };

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** OutLayer's events in a transaction's logs: `EVENT_JSON:{"standard":"near-outlayer","event":…,"data":[…]}`. */
function outlayerEvents(tx: Tx): { event: string; data: Json }[] {
  const out: { event: string; data: Json }[] = [];
  for (const log of tx.receipts.flatMap((r) => r.logs)) {
    if (!log.startsWith("EVENT_JSON:")) continue;
    let e: unknown;
    try {
      e = JSON.parse(log.slice("EVENT_JSON:".length));
    } catch {
      continue;
    }
    if (!isObj(e) || e["standard"] !== "near-outlayer" || typeof e["event"] !== "string") continue;
    const data = Array.isArray(e["data"]) ? e["data"][0] : null;
    if (isObj(data)) out.push({ event: e["event"], data });
  }
  return out;
}

/**
 * The judge's run in a claim transaction, as OutLayer logged it on chain: the request it took (`execution_requested`)
 * and how long the judge ran and what it charged (`execution_completed`). Null when the transaction holds no finished
 * run of the judge.
 */
export function judgeRun(tx: Tx): JudgeRun | null {
  const events = outlayerEvents(tx);
  const asked = events.find((e) => e.event === "execution_requested");
  const done = events.find((e) => e.event === "execution_completed" && e.data["success"] === true);
  if (!asked || !done) return null;
  let request: unknown;
  try {
    request = (JSON.parse(String(asked.data["request_data"])) as Json)["request_id"];
  } catch {
    return null;
  }
  const used = done.data["resources_used"];
  const ms = isObj(used) ? used["time_ms"] : null;
  const charged = done.data["payment_charged"];
  if (typeof request !== "number" || typeof ms !== "number" || !(ms > 0) || typeof charged !== "string" || !/^[1-9]\d*$/.test(charged)) return null;
  return { request, seconds: ms / 1000, cost: fromYocto(BigInt(charged)) };
}

const iso = (ms: number): string => new Date(ms).toISOString();
const nearOf = (yocto: string): string => fromYocto(BigInt(yocto));
const names = (xs: readonly string[]): string => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** Why this round makes no record, in the words of where it stands. */
function refuse(id: string, why: string): never {
  throw new Error(`round ${id} makes no record: ${why}`);
}

/**
 * Where a round stands, in one line and only from what the chain holds: who sealed a plan, whether anyone drained the
 * vault, where the bounty is.
 */
export function standing(race: Race): string {
  const sealers = race.events.filter((e) => e.kind === "seal").map((e) => e.who?.name ?? "a mask");
  const seals = sealers.length ? `${names(sealers)} sealed a plan` : "no mask sealed a plan";
  const bounty = `${nearOf(race.bounty)} NEAR`;
  switch (race.phase) {
    case "sealing":
      return `the sealing window is open until ${iso(race.sealUntil ?? race.deadline)}: ${seals} so far, and the vault is locked`;
    case "racing":
      return `it is open until ${iso(race.deadline)}: ${seals}, nobody has drained the vault, the ${bounty} bounty is on the contract`;
    case "held":
      return race.state === "refunded"
        ? `the vault held: ${seals}, nobody drained it by ${iso(race.deadline)}, and the bounty went back to ${race.team}`
        : `the vault held: ${seals}, nobody drained it by ${iso(race.deadline)}, and the ${bounty} bounty is still on the contract`;
    case "broken":
      // Paid is the contract's own word (its state), not a transfer seen in a transaction.
      return (race.state === "drained" || race.state === "paid") && race.payout?.tx
        ? `${race.winner?.name ?? "a mask"} drained the vault and the contract paid`
        : `${race.winner?.name ?? "a mask"} drained the vault and the contract has not paid yet (the bounty is ${race.state})`;
  }
}

/** A mask of the arena's own with a portrait in `brand/art/web`: one the cards and the clip can draw. */
const drawn = (w: Who): boolean => w.model !== null && SEASON_0.some((m) => m.name === w.name);

const ACTS: ReadonlySet<RaceEvent["kind"]> = new Set(["seal", "move", "drain", "reveal", "claim"]);

function nextOf(next: NextRace | null, race: Race, readAt: number, paidAt: number): SealedRound["next"] {
  // Only a round still ahead when the record is read, that the treasury can pay for.
  if (!next || !next.funded || next.at <= paidAt || next.at <= readAt) return undefined;
  if (race.season && (next.season !== race.season || next.n <= (roundOf(race.id)?.round ?? 0))) return undefined;
  return { round: next.n, safe: nearOf(next.inSafe), bounty: nearOf(next.locked), at: iso(next.at) };
}

/**
 * The record of sealed round `id`, from one reading of that round. `source` is `LIVE` for a reading of the chain and
 * `SIMULATED` for a reading of made-up answers (a rehearsal), never chosen by the round itself; made-up answers tell
 * an example round only (`example-0000`), so a real round's id is never put on a made-up record.
 */
export async function roundFromChain(id: string, chain: RoundChain, source: SealedRound["source"] = "LIVE"): Promise<SealedRound> {
  if (!ROUND_ID.test(id) && !RACE_ID.test(id) && !EXAMPLE_ID.test(id)) {
    throw new Error(`not a round id: ${id} (a season round reads like s1-0001-d74851, a round opened by hand like race-0005)`);
  }
  if (EXAMPLE_ID.test(id) !== (source === "SIMULATED")) {
    throw new Error(source === "SIMULATED" ? `made-up answers tell an example round only (example-0000), not ${id}` : `${id} is an example round: it is read from made-up answers, never from the chain`);
  }
  const readAt = (chain.now ?? Date.now)();
  const race = await chain.arena.round(id);
  if (!race) refuse(id, "no bounty contract of the arena holds a round with this id");
  if (ROUND_ID.test(id) && !race.season) refuse(id, `its bounty belongs to ${race.team}, which is not a season treasury of the arena`);
  if (RACE_ID.test(id) && race.season) refuse(id, `the season treasury ${race.season} opened it, and a season round's id reads like s1-0001-d74851`);
  if (race.kind !== "safe" || race.sealUntil === null || race.openedAt === null) refuse(id, "it is not a sealed round on a live safe");
  const winner = race.winner;
  const paid = race.payout;
  if ((race.state !== "drained" && race.state !== "paid") || !winner || !paid?.tx || paid.at === null) refuse(id, standing(race));
  if (!drawn(winner)) refuse(id, `its winner ${winner.name} has no portrait in brand/art/web, so its cards cannot be drawn`);
  if (!race.txs.open || !race.locked) refuse(id, "the indexer does not show the transaction that opened it yet");
  if (!race.safeFunded) refuse(id, "the indexer does not show the NEAR that went into the vault for it");

  const mine = (e: RaceEvent) => e.who?.account === winner.account;
  // A seal is told with the name the arena gives its mask; two accounts under one name go by their accounts.
  const sealEvents = race.events.filter((e) => e.kind === "seal" && e.who).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const sealName = (w: Who): string => (drawn(w) || sealEvents.filter((e) => e.who!.name === w.name).length === 1 ? w.name : w.account);
  if (!sealEvents.some(mine)) refuse(id, `${winner.name} has no seal on it`);

  const reveal = race.events.filter((e) => e.kind === "reveal" && mine(e) && e.ok).pop();
  if (!reveal) refuse(id, `the indexer does not show ${winner.name}'s reveal yet`);
  const claims = race.events.filter((e) => e.kind === "claim" && mine(e) && e.ok);
  const claim = claims.find((e) => e.tx === paid.tx) ?? claims[claims.length - 1];
  if (!claim) refuse(id, `the indexer does not show ${winner.name}'s claim yet`);

  // The winner's sealed plan as it played: its calls on the vault from the window's close to the last one that moved
  // NEAR before it revealed. Every transaction that moved NEAR is kept with its own amount, so the drain is their sum.
  const closed = race.sealUntil;
  const moves = race.events.filter((e) => mine(e) && (e.kind === "move" || e.kind === "drain") && e.ok && !e.early && e.at >= closed && e.at <= reveal.at);
  const last = moves.map((e) => e.kind === "drain" && e.amount !== null).lastIndexOf(true);
  if (last < 0) refuse(id, `the indexer shows no drain of ${winner.name} between the window's close and its reveal`);
  const plan = moves.slice(0, last + 1);
  const taken = plan.reduce((sum, e) => (e.kind === "drain" && e.amount !== null ? sum + BigInt(e.amount) : sum), 0n);

  // The judge ran in the claim the contract paid on; when a later `settle` paid, in the winner's own claim.
  let judge: JudgeRun | null = null;
  for (const hash of [...new Set([paid.tx, ...claims.map((c) => c.tx).reverse()])]) {
    const [tx] = await chain.indexer.transactions([hash]);
    judge = tx ? judgeRun(tx) : null;
    if (judge) break;
  }
  if (!judge) refuse(id, "no finished run of the judge is in the logs of the claim");

  // Only masks with a move of their own on chain in this round are named, in the order they first moved.
  const entered = new Set(race.masks.map((m) => m.account));
  const acted = new Map<string, Who>();
  for (const e of race.events) if (ACTS.has(e.kind) && e.who && entered.has(e.who.account) && !acted.has(e.who.account)) acted.set(e.who.account, e.who);
  const masks = [...acted.values()].filter(drawn).slice(0, 6);

  // The next round is the treasury's own word at the moment of the reading, or nothing.
  let next: SealedRound["next"];
  let nextSource = "";
  try {
    next = nextOf(await chain.arena.next(), race, readAt, paid.at);
    if (next) nextSource = `The next round: the season treasury's own \`next\`, read at ${iso(readAt)}`;
  } catch (error) {
    nextSource = `The next round is not in the record: the season treasury could not be read at ${iso(readAt)} (${error instanceof Error ? error.message : String(error)})`;
  }

  const net = race.network === "testnet" ? "NEAR testnet" : "NEAR";
  const record = {
    v: 1,
    source,
    network: race.network,
    id,
    contract: race.contract,
    ...(race.season ? { season: race.season } : {}),
    target: { kind: "live-safe", account: race.target },
    safe: nearOf(race.safeFunded),
    bounty: nearOf(race.locked),
    hours: Math.round((race.deadline - race.openedAt) / 3_600_000),
    opened: { at: iso(race.openedAt), tx: race.txs.open },
    masks: masks.map((m) => ({ name: m.name, account: m.account, ...(m.model ? { model: m.model } : {}) })),
    sealed: {
      minutes: Math.round((closed - race.openedAt) / 60_000),
      closedAt: iso(closed),
      seals: sealEvents.map((s) => ({ mask: sealName(s.who!), seq: s.seq ?? 0, at: iso(s.at), ...(s.tx ? { tx: s.tx } : {}) })),
      reveal: { at: iso(reveal.at), tx: reveal.tx },
      claim: { at: iso(claim.at), tx: claim.tx },
    },
    winner: winner.name,
    drain: {
      amount: fromYocto(taken),
      at: iso(plan[last]!.at),
      txs: plan.map((e) => ({ method: e.method ?? "", hash: e.tx, at: iso(e.at), ...(e.kind === "drain" && e.amount !== null ? { amount: nearOf(e.amount) } : {}) })),
    },
    judge,
    payout: { amount: nearOf(paid.amount), tx: paid.tx, at: iso(paid.at) },
    status: "drained",
    ...(next ? { next } : {}),
    sources:
      source === "SIMULATED"
        ? [`SIMULATED: made-up answers in the wire formats of NEAR JSON-RPC and the indexer, replayed through the arena reader. Nothing in this record happened on chain`]
        : [
            `${net}, read through the arena reader at ${iso(readAt)}: get, get_safe and get_round of ${id} on ${race.contract}`,
            `The round's transactions in the public indexer: ${race.season ? `the treasury ${race.season}, ` : ""}the vault ${race.target}, the bounty contract ${race.contract}`,
            `The judge: OutLayer's execution_requested and execution_completed events in the logs of the claim`,
            ...(masks.some((m) => m.model) ? [`Each mask's model: the arena's own profile of the mask, not the chain`] : []),
            ...(nextSource ? [nextSource] : []),
          ],
  };
  // The schema has the last word: a round whose steps do not line up is refused with the field named.
  return parseRace(record) as SealedRound;
}
