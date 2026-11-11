/**
 * A round's record → the chain answers the site replays (`ARENA_FIXTURE`), so the arena can be filmed with no network.
 *
 * A cloud session cannot reach NEAR RPC. What it has is the round's record (`races/<id>.json`), read from the chain
 * when the round ended. This plays that record back as a chain: the bounty contract's views and the round's
 * transactions in the wire formats of NEAR JSON-RPC and the FastNEAR explorer API. The arena's own reader reads it and
 * every answer is kept, the way `packages/arena/scripts/record.ts` keeps the network's.
 *
 * It answers only what the record holds. Every hash, time and amount is the record's; a request about anything the
 * record does not hold (the vault's funding transaction, its code hash, a season treasury) gets no answer, exactly as
 * a node that is down gives none, and the site shows the round without that line. Receipt ids and block heights are
 * never shown anywhere: they are derived from the transaction they belong to.
 *
 * With network access the real thing is better: `MASKWARS_NETWORK=mainnet pnpm --filter @maskwars/arena record --out
 * <file>` keeps the chain's own answers, and `film --answers <file>` films from them.
 */

import { createHash } from "node:crypto";
import { Arena, Indexer, MASKS } from "@maskwars/arena";
import type { ArenaView, MaskProfile } from "@maskwars/arena";
import { recordFetch } from "@maskwars/arena/replay";
import type { Recording } from "@maskwars/arena/replay";
import { ChainReader } from "@maskwars/check";
import { bountyContracts, NETWORKS, teams } from "@maskwars/network";
import { addNear, toYocto } from "../race/near.ts";
import type { SealedRound } from "../race/record.ts";

/** What the record does not hold and the owner's own files do (`scripts/<network>/open-safe-args.json`, `judge-args.json`). */
export type RoundExtras = {
  /** The accounts entered in the round. Without it, the arena's own masks on that network. */
  entrants?: readonly string[];
  /** What a drain must take to count, yoctoNEAR. */
  minLoot?: string;
  /** Minutes of the reveal window after the sealing window. */
  revealMinutes?: number;
  /** The judge's wasm (sha256) pinned on the bounty contract. */
  judge?: string;
};

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** An id nobody sees (a receipt, a block): base58 of sha256 of what it belongs to. */
function idOf(label: string): string {
  let n = BigInt(`0x${createHash("sha256").update(`maskwars film: ${label}`).digest("hex")}`);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out.padStart(43, "1");
}
const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64");
const ns = (ms: number): string => (BigInt(ms) * 1_000_000n).toString();
const ms = (iso: string): number => Date.parse(iso);
/** A height that only orders the transactions in time: about a block every 600 ms. */
const heightAt = (at: number): number => Math.floor(at / 600);

type Action = { call: string; args: unknown; deposit?: string } | { transfer: string };
type Step = { from: string; to: string; at: number; actions: Action[]; logs?: string[]; value?: unknown };
type Made = { hash: string; at: number; signer: string; receiver: string; raw: unknown };

const wire = (a: Action): unknown =>
  "call" in a ? { FunctionCall: { method_name: a.call, args: b64(a.args), gas: 100_000_000_000_000, deposit: a.deposit ?? "0" } } : { Transfer: { deposit: a.transfer } };

/** One transaction as `/v0/transactions` gives it: `steps[0]` is its own receipt, the rest are the receipts it set off. */
function tx(hash: string, at: number, signer: string, steps: Step[]): Made {
  const first = steps[0]!;
  const ids = steps.map((_, i) => idOf(`${hash} receipt ${i}`));
  const receipts = steps.map((s, i) => ({
    execution_outcome: {
      block_timestamp: Number(ns(s.at)),
      block_height: heightAt(s.at),
      id: ids[i],
      outcome: { logs: s.logs ?? [], receipt_ids: i === 0 ? ids.slice(1) : [], executor_id: s.to, status: { SuccessValue: s.value === undefined ? "" : b64(s.value) } },
    },
    receipt: {
      block_timestamp: Number(ns(s.at)),
      block_height: heightAt(s.at),
      predecessor_id: s.from,
      receiver_id: s.to,
      receipt_id: ids[i],
      receipt: { Action: { signer_id: signer, actions: s.actions.map(wire) } },
    },
  }));
  const raw = {
    transaction: { signer_id: signer, receiver_id: first.to, actions: first.actions.map(wire), hash },
    execution_outcome: { block_timestamp: Number(ns(at)), block_height: heightAt(at), id: hash, outcome: { logs: [], receipt_ids: [ids[0]], executor_id: signer, status: { SuccessReceiptId: ids[0] } } },
    receipts,
    data_receipts: [],
  };
  return { hash, at, signer, receiver: first.to, raw };
}

/** The arena of a network as the site reads it, over any fetch: `packages/arena/scripts/empty.ts` builds it the same way. */
function arenaOf(network: SealedRound["network"], fetch: typeof globalThis.fetch, now: number): Arena {
  const net = NETWORKS[network];
  const masks: MaskProfile[] = Object.entries(net.masks).map(([name, account]) => ({ slug: name.toLowerCase(), name, account, model: MASKS.find((m) => m.name === name)?.model ?? "" }));
  return new Arena({
    network,
    rpc: new ChainReader({ endpoints: net.rpc, fetch }),
    indexer: new Indexer({ base: net.indexer, fetch }),
    contracts: bountyContracts(net),
    seasons: [net.season],
    teams: teams(net),
    masks,
    factory: net.factory,
    now: () => now,
  });
}

/** The record played back as a chain: a fetch that answers the reader's requests about this one round. */
export function recordChain(record: SealedRound, extras: RoundExtras = {}): typeof fetch {
  const net = NETWORKS[record.network];
  const id = record.id;
  const contract = record.contract;
  const safe = record.target.account;
  // Who opened it: the treasury for a season's round, the team for one opened by hand.
  const team = record.season ?? net.admin;
  const accountOf = (name: string): string => record.masks.find((m) => m.name === name)?.account ?? net.masks[name] ?? name;
  const winner = accountOf(record.winner);
  const entrants = [...(extras.entrants ?? Object.values(net.masks))];
  for (const m of record.masks) if (!entrants.includes(accountOf(m.name))) entrants.push(accountOf(m.name));

  const opened = ms(record.opened.at);
  const closed = ms(record.sealed.closedAt);
  const deadline = opened + record.hours * 3_600_000;
  const revealUntil = closed + (extras.revealMinutes ?? 60) * 60_000;
  const minLoot = extras.minLoot ?? "0";
  const locked = toYocto(record.bounty).toString();
  const paid = toYocto(record.payout.amount).toString();
  const call = (hash: string, at: number, signer: string, to: string, method: string, args: unknown, more: Step[] = [], deposit?: string): Made =>
    tx(hash, at, signer, [{ from: signer, to, at, actions: [{ call: method, args, ...(deposit ? { deposit } : {}) }] }, ...more]);

  const open = call(record.opened.tx, opened, team, contract, "open_safe", { id, safe, masks: entrants, min_loot: minLoot, hours: record.hours, commit_minutes: record.sealed.minutes }, [], locked);
  const seals = record.sealed.seals.flatMap((s) => (s.tx ? [call(s.tx, ms(s.at), accountOf(s.mask), contract, "commit", { id })] : []));
  const plan = record.drain.txs.map((t) => {
    const at = ms(t.at ?? record.drain.at);
    return call(t.hash, at, winner, safe, t.method, {}, t.amount ? [{ from: safe, to: winner, at: at + 1_000, actions: [{ transfer: toYocto(t.amount).toString() }] }] : []);
  });
  const lastDrain = record.drain.txs[record.drain.txs.length - 1]!.hash;
  const reveal = call(record.sealed.reveal.tx, ms(record.sealed.reveal.at), winner, contract, "reveal", { id });

  // The claim: the contract asks the judge on OutLayer, the judge confirms, the contract pays. OutLayer's two events
  // carry the judge's request, its run time and its cost, as the record read them from the real claim.
  const claimAt = ms(record.sealed.claim.at);
  const paidAt = ms(record.payout.at);
  const cost = toYocto(record.judge.cost).toString();
  const judged: Step[] = [
    {
      from: contract,
      to: net.outlayer.contract,
      at: claimAt + 1_000,
      actions: [{ call: "request_execution", args: { source: { Project: { project_id: `${net.admin}/judge` } } } }],
      logs: [`EVENT_JSON:${JSON.stringify({ standard: "near-outlayer", version: "1.0.0", event: "execution_requested", data: [{ request_data: JSON.stringify({ request_id: record.judge.request, sender_id: winner, predecessor_id: contract }) }] })}`],
    },
    {
      from: net.outlayer.contract,
      to: net.outlayer.contract,
      at: paidAt - 2_000,
      actions: [{ call: "on_execution_response", args: { request_id: record.judge.request } }],
      logs: [`EVENT_JSON:${JSON.stringify({ standard: "near-outlayer", version: "1.0.0", event: "execution_completed", data: [{ sender_id: winner, resources_used: { time_ms: Math.round(record.judge.seconds * 1000) }, success: true, payment_charged: cost }] })}`],
      value: { success: true },
    },
    { from: contract, to: contract, at: paidAt - 1_000, actions: [{ call: "on_judged", args: { id, drain: { tx_hash: lastDrain, mask: winner } } }] },
  ];
  const pay: Step = { from: contract, to: winner, at: paidAt, actions: [{ transfer: paid }] };
  const sameTx = record.payout.tx === record.sealed.claim.tx;
  const claim = call(record.sealed.claim.tx, claimAt, winner, contract, "claim_drain", { id, tx_hash: lastDrain }, sameTx ? [...judged, pay] : judged);
  // A payout the contract made later, on a `settle` call: its own transaction.
  const settle = sameTx ? [] : [call(record.payout.tx, paidAt - 1_000, team, contract, "settle", { id }, [pay])];

  const all = [open, ...seals, ...plan, reveal, claim, ...settle];
  const history: Record<string, Made[]> = { [contract]: [open, ...seals, reveal, claim, ...settle], [safe]: plan };
  const views: Record<string, unknown> = {
    get: { owner: team, amount: paid, target: safe, deadline_ns: ns(deadline), status: { state: "drained", winner, tx_hash: lastDrain } },
    get_safe: { safe, masks: entrants, min_loot: minLoot, opened_ns: ns(opened) },
    get_round: {
      commit_until: ns(closed),
      reveal_until: ns(revealUntil),
      deadline_ns: ns(deadline),
      seals: record.sealed.seals.map((s) => ({ mask: accountOf(s.mask), seq: s.seq, at_ns: ns(ms(s.at)), state: s.mask === record.winner ? "revealed" : "sealed" })),
      judging: [],
    },
    ...(extras.judge ? { judge: { version: extras.judge } } : {}),
  };

  const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const silent = (what: string): never => {
    throw new TypeError(`fetch failed (the record of ${id} does not hold ${what})`);
  };
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (url === `${net.indexer}/v0/account`) {
      const account = String(body["account_id"]);
      const rows = history[account];
      if (!rows) silent(`the transactions of ${account}`);
      const sorted = [...rows!].sort((a, b) => b.at - a.at);
      return json({
        account_txs: sorted.map((t) => ({ account_id: account, transaction_hash: t.hash, tx_block_height: heightAt(t.at), tx_block_timestamp: ns(t.at), is_function_call: t.receiver === account })),
        txs_count: sorted.length,
      });
    }
    if (url === `${net.indexer}/v0/transactions`) {
      const asked = (body["tx_hashes"] as string[] | undefined) ?? [];
      return json({ transactions: asked.flatMap((h) => all.filter((t) => t.hash === h).map((t) => t.raw)) });
    }
    if (!net.rpc.includes(url)) silent(`anything at ${url}`);
    const p = (body["params"] ?? {}) as Record<string, string>;
    const head = { block_hash: idOf(`block ${heightAt(paidAt)}`), block_height: heightAt(paidAt) };
    if (body["method"] === "query" && p["request_type"] === "call_function" && p["account_id"] === contract) {
      const args = JSON.parse(Buffer.from(p["args_base64"] ?? "e30=", "base64").toString("utf8")) as { id?: string };
      const method = p["method_name"]!;
      // The contract's own word about any other id: it holds no such round.
      const answer = args.id !== undefined && args.id !== id ? null : views[method];
      if (answer === undefined) silent(`${contract}.${method}`);
      return json({ jsonrpc: "2.0", id: body["id"], result: { ...head, logs: [], result: [...Buffer.from(JSON.stringify(answer))] } });
    }
    return silent(`${String(body["method"])} ${p["request_type"] ?? ""} of ${p["account_id"] ?? "the chain"}`);
  }) as typeof fetch;
}

/** The hashes a record holds: every transaction the replayed site may link to must be one of them. */
export function recordHashes(record: SealedRound): Set<string> {
  return new Set([record.opened.tx, ...record.sealed.seals.flatMap((s) => (s.tx ? [s.tx] : [])), ...record.drain.txs.map((t) => t.hash), record.sealed.reveal.tx, record.sealed.claim.tx, record.payout.tx]);
}

/** When the replayed site reads the arena: an hour after the payout, the round over and its numbers final. */
export const readAtOf = (record: SealedRound): number => ms(record.payout.at) + 3_600_000;

/**
 * The answers for `ARENA_FIXTURE`, and the arena as the site will read it from them. Throws when that arena does not
 * say what the record says: the winner, what it drained, what the contract paid, what it took in all, and no
 * transaction the record does not hold.
 */
export async function answersFromRecord(record: SealedRound, extras: RoundExtras = {}, readAt: number = readAtOf(record)): Promise<{ recording: Recording; view: ArenaView }> {
  const rec = recordFetch(recordChain(record, extras));
  const view = await arenaOf(record.network, rec.fetch, readAt).view();
  const race = view.now;
  const fail = (why: string): never => {
    throw new Error(`the replay of ${record.id} does not match its record: ${why}`);
  };
  if (!race || race.id !== record.id || view.races.length !== 1) return fail(`the arena shows ${view.races.map((r) => r.id).join(", ") || "no race"}`);
  const winner = record.masks.find((m) => m.name === record.winner)?.account ?? NETWORKS[record.network].masks[record.winner];
  if (race.phase !== "broken" || race.state !== "drained" || race.winner?.account !== winner) fail(`it is ${race.phase}, ${race.state}, won by ${race.winner?.account ?? "nobody"}`);
  // The site names a mask only when its account is the arena's own on that network.
  if (race.winner?.name !== record.winner) fail(`the site would call the winner ${race.winner?.name ?? "nobody"}, not ${record.winner}`);
  if (race.loot !== toYocto(record.drain.amount).toString()) fail(`the drain reads ${race.loot}`);
  if (race.payout?.amount !== toYocto(record.payout.amount).toString() || race.payout.tx !== record.payout.tx) fail(`the payout reads ${race.payout?.amount}`);
  if (race.takes !== toYocto(addNear(record.drain.amount, record.payout.amount)).toString()) fail(`the winner's take reads ${race.takes}`);
  if (race.openedAt !== ms(record.opened.at) || race.sealUntil !== ms(record.sealed.closedAt)) fail("the opening or the window's close moved");
  const held = recordHashes(record);
  const strange = [...race.events.map((e) => e.tx), race.txs.open, race.txs.drain, race.txs.payout].filter((h): h is string => !!h && !held.has(h));
  if (strange.length) fail(`it names transactions the record does not hold: ${strange.join(", ")}`);
  return { recording: { recordedAt: readAt, exchanges: rec.exchanges }, view };
}
