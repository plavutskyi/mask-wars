/**
 * NEAR as the house's day sees it, made up: the bounty contract, the vault and the house's account, with the rules that
 * matter here kept the way the real contracts keep them. A vault retires only once its round is over, an account cannot
 * be made twice, a round opens only on a code the contract knows. The tests of the daily step drive it in process
 * (house.test.ts); the tests of the script put it behind HTTP (house-open.test.ts).
 */
import { createHash } from "node:crypto";
import { NETWORKS } from "@maskwars/network";
import { codeHashOf, houseConfig, type HouseConfig } from "../src/house.ts";
import { base58Encode, NearKey, type Chain } from "../src/near-tx.ts";

export const NEAR = 10n ** 24n;
export const MILLI = NEAR / 1000n;
export const MINUTE = 60_000_000_000n;
export const HOUR = 60n * MINUTE;
export const ns = (iso: string) => BigInt(Date.parse(iso)) * 1_000_000n;
/** Today's slot, and the cron a few minutes after it. */
export const SLOT = ns("2026-11-11T18:00:00Z");
export const NOW = SLOT + 4n * MINUTE;
export const YESTERDAY = SLOT - 24n * HOUR + 4n * MINUTE;

export const JUDGE = "1f".repeat(32);

const leb = (n: number): number[] => {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};

/**
 * A wasm module that exports `exports` as empty functions and is padded with a custom section to exactly `size` bytes:
 * a safe as the house sees it before it deploys one, its exports and the stake its size locks. `fill` sets the padding,
 * so two of them differ in their code hash.
 */
export function safeWasm(size: number, exports: readonly string[] = ["new", "retire", "on_retire", "available"], fill = 7): Buffer {
  const section = (id: number, body: number[]) => [id, ...leb(body.length), ...body];
  const n = exports.length;
  const head = [
    ...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
    ...section(1, [1, 0x60, 0, 0]),
    ...section(3, [...leb(n), ...exports.map(() => 0)]),
    ...section(7, [...leb(n), ...exports.flatMap((e, i) => [...leb(e.length), ...Buffer.from(e), 0x00, ...leb(i)])]),
    ...section(10, [...leb(n), ...exports.flatMap(() => [2, 0, 0x0b])]),
  ];
  const left = size - head.length;
  // id, the section's length, "pad" with its length, then the padding: the section's length takes 1 to 5 bytes.
  for (let l = 1; l <= 5; l++) {
    const pad = left - 1 - l - 4;
    if (pad >= 0 && leb(4 + pad).length === l) return Buffer.concat([Buffer.from(head), Buffer.from([0, ...leb(4 + pad), 3, ...Buffer.from("pad")]), Buffer.alloc(pad, fill)]);
  }
  throw new Error(`no wasm of ${size} bytes`);
}

/** The safe the house deploys: of the size of the real one, so the stake its code locks is the real one. */
export const WASM = safeWasm(164_000);
export const CODE = codeHashOf(WASM);
export const OLD_CODE = codeHashOf(Buffer.alloc(154_000, 3));
export const KEY = new NearKey(`ed25519:${base58Encode(Buffer.alloc(32, 5))}`);

export const CFG: HouseConfig = { ...houseConfig(NETWORKS.mainnet, JUDGE), safeCode: CODE };
export const { house: HOUSE, vault: VAULT, bounty: BOUNTY } = CFG;
export const [NOVA, ONYX, ORACLE] = CFG.masks as [string, string, string];
/** The house key's secret, as the secret HOUSE_KEY holds it. */
export const KEY_SECRET = `ed25519:${base58Encode(Buffer.alloc(32, 5))}`;

export type Decoded =
  | { kind: "createAccount" }
  | { kind: "transfer"; deposit: bigint }
  | { kind: "deployContract"; code: Buffer }
  | { kind: "functionCall"; method: string; args: Record<string, any>; gas: bigint; deposit: bigint };

/** A signed transaction read back from its Borsh: who signed, to whom, and every action. */
export function readTx(base64: string) {
  const b = Buffer.from(base64, "base64");
  let at = 0;
  const u32 = () => (at += 4, b.readUInt32LE(at - 4));
  const u64 = () => (at += 8, b.readBigUInt64LE(at - 8));
  const u128 = () => u64() + (u64() << 64n);
  const bytes = () => {
    const n = u32();
    return b.subarray(at, (at += n));
  };
  const signer = bytes().toString();
  at += 1 + 32 + 8;
  const receiver = bytes().toString();
  at += 32;
  const actions: Decoded[] = [];
  for (let n = u32(); n > 0; n--) {
    const tag = b[at++];
    if (tag === 0) actions.push({ kind: "createAccount" });
    else if (tag === 1) actions.push({ kind: "deployContract", code: Buffer.from(bytes()) });
    else if (tag === 2) actions.push({ kind: "functionCall", method: bytes().toString(), args: JSON.parse(bytes().toString()), gas: u64(), deposit: u128() });
    else if (tag === 3) actions.push({ kind: "transfer", deposit: u128() });
    else throw new Error(`action ${tag} is not one the house sends`);
  }
  // Nothing but the 65 bytes of the signature may follow the actions.
  if (b.length - at !== 65) throw new Error("the transaction has bytes no action accounts for");
  return { signer, receiver, actions };
}

export interface FakeBounty {
  owner: string;
  amount: bigint;
  state: "open" | "drained" | "refunded";
  opened: bigint;
  commitUntil: bigint;
  revealUntil: bigint;
  deadline: bigint;
  seals: { state: string }[];
}

export interface FakeVault {
  amount: bigint;
  codeHash: string;
  stake: bigint;
  keys: number;
  owner: string;
  team: string | null;
  arbiter: string | null;
  masks: string[];
  lock: { arbiter: string; bounty: string; armed_ns: string } | null;
}

export const round = (opened: bigint, patch: Partial<FakeBounty> = {}): FakeBounty => ({
  owner: HOUSE,
  amount: 110n * MILLI,
  state: "open",
  opened,
  commitUntil: opened + 45n * MINUTE,
  revealUntil: opened + 105n * MINUTE,
  deadline: opened + 4n * HOUR,
  seals: [],
  ...patch,
});

/** What every call throws once the runner is gone: nothing more reaches the chain from that run. */
export const GONE = "the runner is gone";

export class FakeNear implements Chain {
  now = NOW;
  height = 200_000_000;
  house: { amount: bigint; storage: number } | null = { amount: 3080n * MILLI, storage: 300 };
  vault: FakeVault | null = null;
  /** The bounty contract's rounds, and the ids an older bounty contract of the arena holds. */
  readonly bounties = new Map<string, FakeBounty>([["race-0001", round(ns("2026-11-10T15:14:00Z"), { owner: "maskwars.near", state: "drained" })]]);
  readonly older = new Set<string>();
  readonly claims = new Map<number, { bounty: string; by: string; height: string }>();
  safeCodes = [OLD_CODE, CODE];
  judge = JUDGE;
  pending: { change: { kind: string } } | null = null;
  /** Every transaction that landed, in order, and every call the chain was asked. */
  readonly landed: { step: string; signer: string; receiver: string; actions: Decoded[] }[] = [];
  asked = 0;
  /** Steps whose answer never comes back: `lost` lands all the same, `dropped` does not. */
  readonly lost = new Set<string>();
  readonly dropped = new Set<string>();
  /** The runner dies right after this many transactions landed, or right before the next one would. */
  dieAfter: number | null = null;
  dieBefore: number | null = null;
  dead = false;
  /** This many transactions come too early for the node: it refuses each for its nonce, and none of them lands. */
  staleNonce = 0;
  /** The safe refuses to arm: the bounty contract gives the deposit back at once. */
  armFails = false;
  /** What a vault this chain makes differs by from the one the house asked for. */
  made: Partial<FakeVault> = {};

  /** Yesterday's round on the vault, as the day finds it. */
  static after(state: FakeBounty["state"], patch: Partial<FakeBounty> = {}): FakeNear {
    const c = new FakeNear();
    c.bounties.set("race-0002", round(YESTERDAY, { state, ...patch }));
    c.vault = c.newVault(state === "drained" ? 1680n * MILLI : 1930n * MILLI, WASM, { bounty: "race-0002", armed: YESTERDAY });
    // The house after it opened that round: what it put into the vault and the bounty is not in its account.
    c.house = { amount: 900n * MILLI, storage: 300 };
    return c;
  }

  newVault(amount: bigint, code: Uint8Array, lock?: { bounty: string; armed: bigint }): FakeVault {
    return {
      amount,
      codeHash: base58Encode(createHash("sha256").update(code).digest()),
      stake: BigInt(code.length + 1500) * 10n ** 19n,
      keys: 0,
      owner: VAULT,
      team: HOUSE,
      arbiter: BOUNTY,
      masks: [...CFG.masks],
      lock: lock ? { arbiter: BOUNTY, bounty: lock.bounty, armed_ns: lock.armed.toString() } : null,
    };
  }

  get steps(): string[] {
    return this.landed.map((t) => t.step);
  }

  async rpc(method: string, p: Record<string, string>): Promise<unknown> {
    if (this.dead) throw new Error(GONE);
    this.asked += 1;
    if (method === "block") return { header: { height: this.height, timestamp_nanosec: this.now.toString() } };
    if (method === "send_tx") return this.send(p.signed_tx_base64!);
    if (p.request_type === "view_access_key") return { nonce: 40 + this.landed.length, block_hash: base58Encode(Buffer.alloc(32, 9)) };
    const missing = () => {
      throw new Error(`query: UNKNOWN_ACCOUNT account ${p.account_id} does not exist while viewing`);
    };
    if (p.request_type === "view_account") {
      const a = p.account_id === HOUSE ? this.house : p.account_id === VAULT ? this.vault : null;
      if (!a) return missing();
      return { amount: a.amount.toString(), code_hash: "codeHash" in a ? a.codeHash : "1".repeat(32), storage_usage: "storage" in a ? a.storage : 165_500 };
    }
    if (p.request_type === "view_access_key_list") return { keys: Array.from({ length: this.vault?.keys ?? 0 }, () => ({})) };
    const args = JSON.parse(Buffer.from(p.args_base64!, "base64").toString()) as Record<string, string>;
    const value = this.view(p.account_id!, p.method_name!, args, missing);
    return { result: [...Buffer.from(JSON.stringify(value))] };
  }

  view(contract: string, method: string, args: Record<string, string>, missing: () => never): unknown {
    if (contract === VAULT) {
      const v = this.vault ?? missing();
      if (v.codeHash !== CODE && v.codeHash !== OLD_CODE) throw new Error("query: CONTRACT_EXECUTION_ERROR wasm execution failed with error: MethodResolveError(MethodNotFound)");
      if (method === "get_owner") return v.owner;
      if (method === "team") return v.team;
      if (method === "arbiter") return v.arbiter;
      if (method === "masks") return v.masks;
      if (method === "get_round") return v.lock;
      if (method === "available") return (v.amount > v.stake ? v.amount - v.stake : 0n).toString();
    }
    if (contract === "old.maskwars.near" && method === "get") return this.older.has(args.id!) ? { owner: "maskwars.near", deadline_ns: "0", status: { state: "paid" } } : null;
    if (contract === BOUNTY) {
      if (method === "governance") return { admin: "maskwars.near", pending: this.pending, judge: { version: this.judge }, safe_codes: this.safeCodes };
      if (method === "get_claim") return this.claims.get(Number(args.claim)) ?? null;
      const b = this.bounties.get(args.id!);
      if (!b) return null;
      if (method === "get") return { owner: b.owner, amount: b.amount.toString(), deadline_ns: b.deadline.toString(), status: { state: b.state } };
      if (method === "get_safe") return { safe: VAULT, masks: CFG.masks, min_loot: "0", opened_ns: b.opened.toString() };
      if (method === "get_round") {
        return { commit_until: b.commitUntil.toString(), reveal_until: b.revealUntil.toString(), deadline_ns: b.deadline.toString(), seals: b.seals, judging: [] };
      }
      if (method === "get_terms") return { judging: [...this.claims.values()].filter((c) => c.bounty === args.id).length };
    }
    throw new Error(`no view ${contract}.${method}`);
  }

  /** One transaction: checked and applied the way the chain and the contracts would, or refused. */
  send(base64: string): unknown {
    const tx = readTx(base64);
    const call = tx.actions.find((a) => a.kind === "functionCall");
    const step = tx.actions[0]!.kind === "createAccount" ? "create" : call?.kind === "functionCall" ? (call.method === "open_safe" ? "open" : call.method) : "?";
    if (this.dieBefore !== null && this.landed.length >= this.dieBefore) {
      this.dead = true;
      throw new Error(GONE);
    }
    if (this.dropped.delete(step)) throw new Error("fetch failed: the RPC timed out");
    if (this.staleNonce > 0) {
      this.staleNonce -= 1;
      throw new Error('send_tx: INVALID_TRANSACTION {"TxExecutionError":{"InvalidTxError":{"InvalidNonce":{"tx_nonce":41,"ak_nonce":41}}}}');
    }
    const failure = this.apply(step, tx);
    if (failure === null) this.landed.push({ step, ...tx });
    if (this.dieAfter !== null && this.landed.length >= this.dieAfter) {
      this.dead = true;
      throw new Error(GONE);
    }
    if (this.lost.delete(step)) throw new Error("fetch failed: the RPC timed out");
    if (failure !== null) {
      const status = { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: failure } } } } };
      return { status, receipts_outcome: [{ outcome: { status, logs: [] } }] };
    }
    return { status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { SuccessValue: "" }, logs: [`${step} done`] } }] };
  }

  /** Applies the step, or says why the chain refuses it. */
  apply(step: string, tx: ReturnType<typeof readTx>): string | null {
    if (tx.signer !== HOUSE) return "only the house signs";
    const call = tx.actions.find((a): a is Extract<Decoded, { kind: "functionCall" }> => a.kind === "functionCall");
    const b = call?.args.id ? this.bounties.get(call.args.id) : undefined;
    if (step === "unstick") {
      const c = this.claims.get(Number(call!.args.claim));
      if (!c || c.bounty !== call!.args.id) return "no such claim with the judge";
      if (this.height < Number(c.height) + 600) return "the judge may still answer";
      this.claims.delete(Number(call!.args.claim));
      return null;
    }
    if (step === "settle") {
      if (!b || b.state !== "open") return "the bounty is not open";
      if (!b.seals.some((s) => s.state === "confirmed")) return "no confirmed seal yet";
      b.state = "drained";
      return null;
    }
    if (step === "refund") {
      if (!b || b.state !== "open") return "the bounty is not open";
      if (this.now < b.deadline + 12n * HOUR) return "the masks can still claim";
      if ([...this.claims.values()].some((c) => c.bounty === call!.args.id)) return "a claim is still with the judge";
      b.state = "refunded";
      this.house!.amount += b.amount;
      return null;
    }
    if (step === "retire") {
      const v = this.vault;
      if (!v || tx.receiver !== VAULT) return "no such account";
      if (v.codeHash !== CODE) return "MethodNotFound";
      if (v.team !== HOUSE) return "only the safe's team retires it";
      const of = v.lock ? this.bounties.get(v.lock.bounty) : undefined;
      if (of && of.state === "open") return "the round is not over: its bounty is still open";
      if (of && of.state === "drained" && this.now < of.deadline) return "a mask won the round: the safe retires after its deadline";
      this.house!.amount += v.amount;
      this.vault = null;
      return null;
    }
    if (step === "create") {
      const [, pay, deploy, init] = tx.actions as [Decoded, Extract<Decoded, { kind: "transfer" }>, Extract<Decoded, { kind: "deployContract" }>, Extract<Decoded, { kind: "functionCall" }>];
      if (tx.receiver !== VAULT || tx.actions.length !== 4 || init.method !== "new") return "not the vault's transaction";
      if (this.vault) return "AccountAlreadyExists";
      if (this.house!.amount < pay.deposit) return "NotEnoughBalance";
      this.house!.amount -= pay.deposit;
      this.vault = { ...this.newVault(pay.deposit, deploy.code), owner: init.args.owner, team: init.args.team, arbiter: init.args.arbiter, masks: init.args.masks, ...this.made };
      return null;
    }
    if (step === "open") {
      const a = call!.args;
      if (this.bounties.has(a.id) || this.older.has(a.id)) return "this id is taken";
      if (!this.safeCodes.includes(a.safe_code)) return "the safe's code is not one the contract knows";
      if (a.judge_version !== this.judge) return "the judge is not the one the team agreed to: see judge()";
      if (this.pending && ["code", "admin"].includes(this.pending.change.kind)) return "new code or a new admin is pending";
      if (this.house!.amount < call!.deposit) return "NotEnoughBalance";
      const v = this.vault;
      const opened = this.now;
      const made = round(opened, { commitUntil: opened + BigInt(a.commit_minutes) * MINUTE, revealUntil: opened + BigInt(a.commit_minutes + a.reveal_minutes) * MINUTE, deadline: opened + BigInt(a.hours) * HOUR });
      if (this.armFails || !v || v.lock || v.team !== tx.signer || a.safe !== VAULT) {
        // The contract keeps the id and gives the whole deposit back: the safe took no round.
        this.bounties.set(a.id, { ...made, state: "refunded" });
        return "only a round the safe's own team opens arms the safe";
      }
      this.house!.amount -= call!.deposit;
      this.bounties.set(a.id, made);
      v.lock = { arbiter: BOUNTY, bounty: a.id, armed_ns: opened.toString() };
      return null;
    }
    return `the house sends no ${step}`;
  }
}

