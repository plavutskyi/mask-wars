/**
 * Makes `example-round.json`: the answers a made-up chain gives about one won sealed round, in the wire formats of
 * the real ones (NEAR JSON-RPC and the FastNEAR explorer API). It exists to test the reader and the drawing with no
 * network. Nothing in it is on chain and nothing in it can be taken for a real round: the round is `example-0000`,
 * every account is under `example.testnet`, the file says `simulated`, and everything read from it is marked
 * SIMULATED.
 *
 *   node test/fixtures/make-example-round.ts
 *
 * The round is played against the pretend chain and every request the reader makes is kept with its answer, the way
 * `packages/arena/scripts/record.ts` keeps testnet's. The shapes follow a recorded race
 * (`packages/arena/test/fixtures/testnet.json`): transactions with their receipts, transfers, logs and OutLayer's
 * events. Hashes are sha256 of a label.
 *
 * `exampleChain` also plays the round other ways, for the tests of the reader: a plan that sweeps the vault in two
 * transactions, a round the team opened by hand, a sealer the cards cannot draw, a treasury or an RPC that is down.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Arena, Indexer, RPCS } from "@maskwars/arena";
import { recordFetch } from "@maskwars/arena/replay";
import { ChainReader } from "@maskwars/check";
import { roundFromChain } from "../../src/race/chain.ts";

export const ID = "example-0000";
const ADMIN = "example.testnet";
const BOUNTY = `bounty.${ADMIN}`;
const SEASON = `season.${ADMIN}`;
const SCHEDULER = `scheduler.${ADMIN}`;
const FACTORY = `masks.${ADMIN}`;
const NOVA = `nova.${ADMIN}`;
const ONYX = `onyx.${ADMIN}`;
const ORACLE = `oracle.${ADMIN}`;
/** A person's mask from the factory: it has no portrait among the season's six. */
const KIRA = `kira.${FACTORY}`;
const OUTLAYER = `outlayer.${ADMIN}`;

/** The made-up arena the answers are about: what `Arena` is given to read them. */
export const EXAMPLE_ARENA = {
  contracts: [BOUNTY],
  seasons: [SEASON],
  teams: [ADMIN, SEASON],
  factory: FACTORY,
  masks: [
    { slug: "nova", name: "NOVA", account: NOVA, model: "deepseek-ai/DeepSeek-V4.1-Flash-1017" },
    { slug: "onyx", name: "ONYX", account: ONYX, model: "z-ai/glm-5.3-flash" },
    { slug: "oracle", name: "ORACLE", account: ORACLE, model: "Qwen/Qwen3.8-27B" },
  ],
};

const NEAR = 10n ** 24n;
const milli = (n: number): string => ((NEAR * BigInt(n)) / 1000n).toString();
const SAFE_FUND = milli(1500);
const HAND_FUND = milli(3000);
const PRIZE = milli(350);
const MIN_LOOT = milli(500);
const PAID = "211420000000000000000000";
const JUDGE = { request: 20417, ms: 1183, charged: "1118320500000000000000", attached: "10000000000000000000000" };

const MIN = 60_000;
const OPEN_TX = Date.UTC(2026, 10, 10, 18, 0, 4, 310);
const OPENED = OPEN_TX + 2_240;
const COMMIT_UNTIL = OPENED + 45 * MIN;
const REVEAL_UNTIL = COMMIT_UNTIL + 60 * MIN;
const DEADLINE = OPENED + 4 * 60 * MIN;
const NEXT_AT = Date.UTC(2026, 10, 11, 18, 0, 0);
export const READ_AT = Date.UTC(2026, 10, 10, 19, 30, 0);
const ns = (ms: number): string => (BigInt(ms) * 1_000_000n).toString();

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** A stand-in for a hash on chain: base58 of sha256 of what it names. */
function fake(label: string): string {
  let n = BigInt(`0x${createHash("sha256").update(`maskwars example round ${ID}: ${label}`).digest("hex")}`);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out.padStart(43, "1");
}
const hex = (label: string): string => createHash("sha256").update(`maskwars example round ${ID}: ${label}`).digest("hex");
const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64");

const CODE = fake("the vault's code");
/** About 1.1 s a block. */
const heightAt = (ms: number): number => 277_100_000 + Math.round((ms - OPEN_TX) / 1100);

type Action = { call: string; args: unknown; deposit?: string } | { transfer: string } | { other: unknown };
type Step = { from: string; to: string; after: number; actions: Action[]; logs?: string[]; fail?: boolean; value?: unknown };
type Made = { hash: string; at: number; signer: string; receiver: string; raw: unknown };

const wire = (a: Action): unknown =>
  "call" in a
    ? { FunctionCall: { method_name: a.call, args: b64(a.args), gas: 100_000_000_000_000, deposit: a.deposit ?? "0" } }
    : "transfer" in a
      ? { Transfer: { deposit: a.transfer } }
      : a.other;

/**
 * One transaction as `/v0/transactions` gives it. `steps[0]` is the transaction's own receipt; the rest are the
 * receipts it set off, each `after` ms later than the transaction.
 */
function tx(label: string, at: number, signer: string, steps: Step[]): Made {
  const hash = fake(label);
  const first = steps[0]!;
  const ids = steps.map((_, i) => fake(`${label} receipt ${i}`));
  const receipts = steps.map((s, i) => {
    const t = at + s.after;
    const status = s.fail
      ? { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: the vault holds nothing to sweep" } } } } }
      : i === 0 && steps.length > 1 && s.value === undefined
        ? { SuccessReceiptId: ids[1] }
        : { SuccessValue: s.value === undefined ? "" : b64(s.value) };
    return {
      execution_outcome: {
        block_hash: fake(`block ${heightAt(t)}`),
        block_timestamp: Number(BigInt(t) * 1_000_000n),
        block_height: heightAt(t),
        index: i,
        id: ids[i],
        outcome: { logs: s.logs ?? [], receipt_ids: i === 0 ? ids.slice(1) : [], gas_burnt: 2_428_000_000_000, tokens_burnt: "242800000000000000000", executor_id: s.to, status },
      },
      receipt: {
        block_height: heightAt(t),
        block_hash: fake(`block ${heightAt(t)}`),
        block_timestamp: Number(BigInt(t) * 1_000_000n),
        receipt_index: i,
        predecessor_id: s.from,
        receiver_id: s.to,
        receipt_id: ids[i],
        receipt: { Action: { signer_id: signer, gas_price: "100000000", output_data_receivers: [], input_data_ids: [], actions: s.actions.map(wire), is_promise_yield: false } },
        priority: 0,
      },
    };
  });
  const raw = {
    transaction: { signer_id: signer, nonce: heightAt(at) * 1_000_000 + 1, receiver_id: first.to, actions: first.actions.map(wire), priority_fee: 0, hash },
    execution_outcome: {
      block_hash: fake(`block ${heightAt(at)}`),
      block_timestamp: Number(BigInt(at) * 1_000_000n),
      block_height: heightAt(at),
      index: 0,
      id: hash,
      outcome: { logs: [], receipt_ids: [ids[0]], gas_burnt: 312_255_666_920, tokens_burnt: "31225566692000000000", executor_id: signer, status: { SuccessReceiptId: ids[0] } },
    },
    receipts,
    data_receipts: [],
  };
  return { hash, at, signer, receiver: first.to, raw };
}

/** A mask's call: one receipt on the contract, and the transfers it set off. */
const call = (label: string, at: number, mask: string, to: string, method: string, args: unknown, more: Step[] = [], fail = false): Made =>
  tx(label, at, mask, [{ from: mask, to, after: 580, actions: [{ call: method, args }], fail }, ...more]);

/** The ways the example round can be played. With none given it is the round `example-round.json` holds. */
export type Variant = {
  /** What each sweep of the winner's plan moves out of the vault, in thousandths of a NEAR. One sweep of 1.48 NEAR by default. */
  sweeps?: number[];
  /** The team opens the round by hand on the bounty contract: no treasury makes the vault. */
  hand?: boolean;
  /** A person's mask seals a plan too, and the indexer does not show its `commit` transaction. */
  stranger?: boolean;
  /** No mask does anything: nobody seals, nobody touches the vault, the bounty stays open. */
  idle?: boolean;
  /** The season treasury does not answer. */
  seasonDown?: boolean;
  /** No RPC answers at all. */
  rpcDown?: boolean;
  /** The indexer does not answer. */
  indexerDown?: boolean;
};

function play(v: Variant) {
  const sweeps = v.sweeps ?? [1480];
  const safe = v.hand ? `safe-0001.${ADMIN}` : `s0001.${SEASON}`;
  const team = v.hand ? ADMIN : SEASON;
  const masks = v.stranger ? [NOVA, ONYX, ORACLE, KIRA] : [NOVA, ONYX, ORACLE];
  const openArgs = { id: ID, safe, masks, min_loot: MIN_LOOT, hours: 4, commit_minutes: 45, reveal_minutes: 60, safe_code: CODE, judge_version: hex("the judge") };
  const arm: Step = { from: BOUNTY, to: safe, after: 3_360, actions: [{ call: "arm", args: { id: ID, commit_until: ns(COMMIT_UNTIL), masks, team } }], value: true };
  const opening: Step = { from: team, to: BOUNTY, after: OPENED - OPEN_TX, actions: [{ call: "open_safe", args: openArgs, deposit: PRIZE }], logs: [`round ${ID} opened on ${safe}`] };

  // By hand: the team puts NEAR into a vault it made earlier, then opens the round on the bounty contract itself.
  const fund = tx("fund the vault", OPEN_TX - 20_000, ADMIN, [{ from: ADMIN, to: safe, after: 560, actions: [{ transfer: HAND_FUND }] }]);
  // On schedule: the treasury's one transaction makes the vault, funds it and opens the round, and the contract locks the vault.
  const open = v.hand
    ? tx("open_safe by hand", OPEN_TX, ADMIN, [opening, arm])
    : tx("open_next", OPEN_TX, SCHEDULER, [
        { from: SCHEDULER, to: SEASON, after: 560, actions: [{ call: "open_next", args: {} }] },
        {
          from: SEASON,
          to: safe,
          after: 1_120,
          actions: [
            { other: "CreateAccount" },
            { transfer: SAFE_FUND },
            { other: { UseGlobalContract: { contract_identifier: { CodeHash: CODE } } } },
            { call: "new", args: { owner: safe, masks, arbiter: BOUNTY, team: SEASON } },
          ],
        },
        opening,
        arm,
        { from: SEASON, to: SEASON, after: 4_480, actions: [{ call: "on_opened", args: { id: ID, safe } }], value: { id: ID, safe, challenge: "live-safe" } },
      ]);

  // ORACLE seals 6 min 12 s after the round opened, NOVA 15 min later. A stranger's seal comes between them.
  const sealOracle = call("commit oracle", OPENED + 6 * MIN + 12_400 - 580, ORACLE, BOUNTY, "commit", { id: ID, hash: hex("oracle's plan") });
  const sealNova = call("commit nova", OPENED + 21 * MIN + 37_900 - 580, NOVA, BOUNTY, "commit", { id: ID, hash: hex("nova's plan") });
  const sealKiraAt = OPENED + 10 * MIN + 3_000;

  // The window closes. Seal #0 plays first: ORACLE takes the vault over and sweeps it, in as many transactions as its plan has.
  const ownOracle = call("set_owner oracle", COMMIT_UNTIL + 12_600, ORACLE, safe, "set_owner", { new_owner: ORACLE });
  const sweepsOracle = sweeps.map((amount, i) =>
    call(i === 0 ? "sweep oracle" : `sweep oracle ${i + 1}`, COMMIT_UNTIL + 17_100 + i * 2_300, ORACLE, safe, "sweep", { to: ORACLE, amount: milli(amount) }, [
      { from: safe, to: ORACLE, after: 1_140, actions: [{ transfer: milli(amount) }] },
      { from: "system", to: ORACLE, after: 1_140, actions: [{ transfer: "100513088041893800000000" }] },
    ]),
  );
  const lastSweep = sweepsOracle[sweepsOracle.length - 1]!;
  const plan = [{ method: "set_owner", args: { new_owner: ORACLE } }, ...sweeps.map((amount) => ({ method: "sweep", args: { to: ORACLE, amount: milli(amount) } }))];
  const reveal = call("reveal oracle", COMMIT_UNTIL + 25_300, ORACLE, BOUNTY, "reveal", { id: ID, plan: JSON.stringify(plan), salt: hex("oracle's salt"), txs: [ownOracle.hash, ...sweepsOracle.map((t) => t.hash)] });

  // The claim: the bounty contract asks the judge on OutLayer, the judge confirms, the contract pays.
  const drainInput = JSON.stringify({ kind: "drain", bounty_id: ID, safe, mask: ORACLE, tx_hash: lastSweep.hash, min_loot: MIN_LOOT, opened_ns: ns(OPENED), deadline_ns: ns(DEADLINE) });
  const CLAIM_AT = COMMIT_UNTIL + 32_000;
  const refund = (BigInt(JUDGE.attached) - BigInt(JUDGE.charged)).toString();
  const claim = tx("claim_drain oracle", CLAIM_AT, ORACLE, [
    { from: ORACLE, to: BOUNTY, after: 460, actions: [{ call: "claim_drain", args: { id: ID, tx_hash: lastSweep.hash } }] },
    {
      from: BOUNTY,
      to: OUTLAYER,
      after: 1_030,
      actions: [{ call: "request_execution", args: { source: { Project: { project_id: `${BOUNTY}/judge` } }, input_data: drainInput, response_format: "Text", payer_account_id: BOUNTY }, deposit: JUDGE.attached }],
      logs: [
        `EVENT_JSON:${JSON.stringify({
          standard: "near-outlayer",
          version: "1.0.0",
          event: "execution_requested",
          data: [
            {
              request_data: JSON.stringify({ request_id: JUDGE.request, sender_id: ORACLE, predecessor_id: BOUNTY, input_data: drainInput, response_format: "Text", payment: JUDGE.attached, project_id: `${BOUNTY}/judge` }),
              timestamp: Number(BigInt(CLAIM_AT + 1_030) * 1_000_000n),
            },
          ],
        })}`,
      ],
    },
    {
      from: OUTLAYER,
      to: OUTLAYER,
      after: 7_780,
      actions: [{ call: "on_execution_response", args: { request_id: JUDGE.request, sender_id: ORACLE, predecessor_id: BOUNTY } }],
      logs: [
        `[[yNEAR charged: "${JUDGE.charged}"]]`,
        `EVENT_JSON:${JSON.stringify({
          standard: "near-outlayer",
          version: "1.0.0",
          event: "execution_completed",
          data: [
            {
              sender_id: ORACLE,
              resources_used: { instructions: 5_912_044, time_ms: JUDGE.ms, compile_time_ms: null },
              success: true,
              error_message: null,
              payment_charged: JUDGE.charged,
              payment_refunded: refund,
              timestamp: Number(BigInt(CLAIM_AT + 7_780) * 1_000_000n),
            },
          ],
        })}`,
        `Execution completed successfully. Output: Text(281 bytes), Resources: { instructions: 5912044, time_ms: ${JUDGE.ms} }, Cost: ${JUDGE.charged} yoctoNEAR, Refund: ${refund} yoctoNEAR`,
      ],
      value: { success: true },
    },
    { from: OUTLAYER, to: BOUNTY, after: 8_320, actions: [{ transfer: refund }] },
    {
      from: BOUNTY,
      to: BOUNTY,
      after: 8_320,
      actions: [{ call: "on_judged", args: { id: ID, drain: { tx_hash: lastSweep.hash, mask: ORACLE } } }],
      logs: [`bounty ${ID} paid to ${ORACLE} for draining the safe in ${lastSweep.hash}`, `the safe's code: ${CODE}`],
      value: { state: "drained", winner: ORACLE, tx_hash: lastSweep.hash },
    },
    { from: BOUNTY, to: ORACLE, after: 8_970, actions: [{ transfer: PAID }] },
    { from: BOUNTY, to: BOUNTY, after: 9_540, actions: [{ call: "on_paid", args: { id: ID } }], value: { state: "drained", winner: ORACLE, tx_hash: lastSweep.hash } },
  ]);

  // Seal #1 plays in its own slot, 3 minutes later, on the vault as the round left it: there is nothing left to sweep.
  const ownNova = call("set_owner nova", COMMIT_UNTIL + 3 * MIN + 5_200, NOVA, safe, "set_owner", { new_owner: NOVA });
  const sweepNova = call("sweep nova", COMMIT_UNTIL + 3 * MIN + 9_700, NOVA, safe, "sweep", { to: NOVA, amount: milli(1480) }, [], true);

  const played = v.idle ? { bounty: [], safe: [] } : { bounty: [sealOracle, sealNova, reveal, claim], safe: [ownOracle, ...sweepsOracle, ownNova, sweepNova] };
  const all = [fund, open, ...played.bounty, ...played.safe];
  /** Which account sees which transaction in its history. */
  const history: Record<string, Made[]> = {
    [BOUNTY]: [...(v.hand ? [open] : []), ...played.bounty],
    [SEASON]: v.hand ? [] : [open],
    [safe]: [...(v.hand ? [fund] : []), open, ...played.safe],
  };
  const status = v.idle ? { state: "open" } : { state: "drained", winner: ORACLE, tx_hash: lastSweep.hash };
  const seals = (v.idle ? [] : [
    { mask: ORACLE, at_ns: ns(sealOracle.at + 580), state: "revealed" },
    ...(v.stranger ? [{ mask: KIRA, at_ns: ns(sealKiraAt), state: "sealed" }] : []),
    { mask: NOVA, at_ns: ns(sealNova.at + 580), state: "sealed" },
  ]).map((s, seq) => ({ ...s, seq }));
  /** What the contracts answer to a view call. */
  const views: Record<string, Record<string, unknown>> = {
    [SEASON]: {
      season: { name: "example", bounty: BOUNTY, scheduler: SCHEDULER, opened: v.hand ? 0 : 1 },
      latest: v.hand ? [] : [{ id: ID, safe, challenge: "live-safe" }],
      next: { at_ns: ns(NEXT_AT), n: v.hand ? 1 : 2, challenge: "live-safe", code_hash: CODE, prize: PRIZE, safe_fund: SAFE_FUND, min_loot: MIN_LOOT, masks: [NOVA, ONYX, ORACLE], hours: 4, commit_minutes: 45, funded: true },
    },
    [BOUNTY]: {
      get: { owner: team, amount: v.idle ? "221170000000000000000000" : PAID, target: safe, deadline_ns: ns(DEADLINE), status },
      get_safe: { safe, masks, min_loot: MIN_LOOT, opened_ns: ns(OPENED) },
      get_round: { commit_until: ns(COMMIT_UNTIL), reveal_until: ns(REVEAL_UNTIL), deadline_ns: ns(DEADLINE), seals, judging: [] },
      judge: { version: hex("the judge") },
    },
  };
  return { safe, all, history, views };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The pretend chain: answers the indexer's and the RPC's requests about the example round, played as `v` says. */
export function exampleChain(v: Variant = {}): typeof fetch {
  const { safe, all, history, views } = play(v);
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const ofIndexer = url.endsWith("/v0/account") || url.endsWith("/v0/transactions");
    if (ofIndexer ? v.indexerDown : v.rpcDown) return json({ message: "Service Unavailable" }, 503);
    if (url.endsWith("/v0/account")) {
      const rows = [...(history[String(body["account_id"])] ?? [])].sort((a, b) => b.at - a.at);
      return json({
        account_txs: rows.map((t) => ({
          account_id: body["account_id"],
          transaction_hash: t.hash,
          tx_block_height: heightAt(t.at),
          tx_block_timestamp: ns(t.at),
          tx_index: 0,
          is_signer: t.signer === body["account_id"],
          is_receiver: true,
          is_function_call: t.receiver === body["account_id"],
          is_success: true,
        })),
        txs_count: rows.length,
      });
    }
    if (url.endsWith("/v0/transactions")) {
      const asked = (body["tx_hashes"] as string[]) ?? [];
      return json({ transactions: asked.flatMap((h) => all.filter((t) => t.hash === h).map((t) => t.raw)) });
    }
    const p = body["params"] as Record<string, string>;
    if (v.seasonDown && p["account_id"] === SEASON) return json({ message: "Service Unavailable" }, 503);
    const head = { block_hash: fake(`block ${heightAt(READ_AT)}`), block_height: heightAt(READ_AT) };
    const answer = (result: Record<string, unknown>) => json({ jsonrpc: "2.0", result: { ...head, ...result }, id: body["id"] });
    if (p["request_type"] === "view_account" && p["account_id"] === safe) {
      return answer({ amount: "13200000000000000000000", code_hash: "11111111111111111111111111111111", global_contract_hash: CODE, locked: "0", storage_paid_at: 0, storage_usage: 1184 });
    }
    if (p["request_type"] === "call_function") {
      // The contract holds this one round: any other id has no bounty, no safe and no round.
      const args = JSON.parse(Buffer.from(p["args_base64"] ?? "e30=", "base64").toString("utf8")) as { id?: string };
      if (p["account_id"] === BOUNTY && args.id !== undefined && args.id !== ID) return answer({ logs: [], result: [...Buffer.from("null")] });
      const view = views[p["account_id"]!]?.[p["method_name"]!];
      if (view === undefined) return answer({ error: "wasm execution failed with error: MethodResolveError(MethodNotFound)", logs: [] });
      return answer({ logs: [], result: [...Buffer.from(JSON.stringify(view))] });
    }
    return json({ jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: {} }, code: -32000, message: "Server error", data: `account ${p["account_id"]} does not exist while viewing` }, id: body["id"] });
  }) as typeof fetch;
}

/** The example round as `example-round.json` holds it. */
export const pretendChain = exampleChain();

/** The reader over a fetch: the made-up arena, read at the fixture's own moment unless another is given. */
export function readerOn(fetch: typeof globalThis.fetch, at: number = READ_AT) {
  const indexer = new Indexer({ fetch });
  return { arena: new Arena({ ...EXAMPLE_ARENA, rpc: new ChainReader({ endpoints: RPCS, fetch }), indexer, now: () => at }), indexer, now: () => at };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rec = recordFetch(pretendChain);
  const record = await roundFromChain(ID, readerOn(rec.fetch), "SIMULATED");
  const out = join(dirname(fileURLToPath(import.meta.url)), "example-round.json");
  const about = `A made-up sealed round in the wire formats of NEAR JSON-RPC and the FastNEAR explorer API. Made by make-example-round.ts; nothing in it is on chain.`;
  const text = `${JSON.stringify({ simulated: true, about, arena: EXAMPLE_ARENA, recordedAt: READ_AT, exchanges: rec.exchanges }, null, 1)}\n`;
  writeFileSync(out, text);
  console.log(`${rec.exchanges.length} answers, ${(text.length / 1024).toFixed(0)} KB → ${out}`);
  console.log(`${record.id}: ${record.winner} drained ${record.drain.amount} NEAR, paid ${record.payout.amount} NEAR, judge ${record.judge.seconds} s`);
}
