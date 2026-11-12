/**
 * After the forge: what a person's mask has on its own account, what its owner may take out, its ×, and a change of
 * the factory that is waiting. All of it is read from NEAR; nothing here is anyone's word.
 */
import { type FactoryConfig, type Network } from "./chain.ts";
import { YOCTO } from "./near.ts";

/** What `withdraw` leaves on the mask's account besides its storage: the gas its races burn (`GAS_FUND`, mask code). */
export const GAS_FUND = (YOCTO * 25n) / 100n;
/** NEAR's storage price: 0.00001 NEAR a byte. */
export const BYTE_COST = 10n ** 19n;
/** A change nobody applies lapses a day after it is ready (`CHANGE_LAPSE_HOURS`). */
const LAPSE_MS = 24 * 3_600_000;

/** A change the factory's admin proposed, as `config().pending` shows it. */
export interface PendingChange {
  readonly change: {
    readonly kind: string;
    readonly sha256?: string;
    readonly account?: string;
    readonly accounts?: readonly string[];
    readonly key?: string;
  };
  readonly proposed_ns: string;
  /** From then on it applies while no mask exists. */
  readonly notice_ns: string;
  /** From then on it applies in any case. */
  readonly ready_ns: string;
}

const short = (hex: string | undefined) => (hex ? `${hex.slice(0, 8)}…` : "");

/** The waiting change in words, and when anyone may apply it, ms; `null` when none waits or it lapsed. */
export function waitingChange(cfg: FactoryConfig & { readonly pending?: PendingChange | null }, nowMs: number): { what: string; at: number } | null {
  const p = cfg.pending;
  if (!p) return null;
  const at = Number(BigInt(cfg.masks > 0 ? p.ready_ns : p.notice_ns) / 1_000_000n);
  if (nowMs >= at + LAPSE_MS) return null;
  const c = p.change;
  const what = (() => {
    switch (c.kind) {
      case "code":
        return `New factory code ${short(c.sha256)}`;
      case "mask_code":
        return `New mask code ${short(c.sha256)}`;
      case "admin":
        return `New admin, ${c.account}`;
      case "keeper":
        return `New keeper, ${c.account}`;
      case "treasury":
        return `New treasury, ${c.account}`;
      case "arena":
        return `New arena, ${c.account}`;
      case "strategy_key":
        return "A new key for the mind";
      case "teams":
        return `New teams, ${(c.accounts ?? []).join(", ")}`;
      default:
        return "A change of the factory";
    }
  })();
  return { what, at };
}

/** `2 d 23 h`, `5 h 12 min`, `12 min`, or `now`. */
export function waitText(ms: number): string {
  if (ms <= 0) return "now";
  const min = Math.ceil(ms / 60_000);
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

/** A NEAR account's balance and storage, as `view_account` gives them. */
export interface AccountState {
  readonly amount: string;
  readonly storage_usage: number;
}

/** The mask's own account, at the final block: the first RPC that answers decides. */
export async function accountState(net: Network, account: string, timeoutMs = 8000): Promise<AccountState | null> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "maskwars-forge",
    method: "query",
    params: { request_type: "view_account", finality: "final", account_id: account },
  });
  for (const url of net.rpcs) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(timeoutMs) });
      const out = (await res.json()) as { result?: AccountState; error?: unknown };
      if (out.result && typeof out.result.amount === "string") return { amount: out.result.amount, storage_usage: out.result.storage_usage };
      if (out.error) return null;
    } catch {
      // the next RPC
    }
  }
  return null;
}

/** What the owner can take out now: everything above the account's storage and the gas fund, as `withdraw` pays. */
export function takeOut(state: AccountState | null): bigint {
  if (!state) return 0n;
  const keep = BigInt(state.storage_usage) * BYTE_COST + GAS_FUND;
  const amount = BigInt(state.amount);
  return amount > keep ? amount - keep : 0n;
}

/**
 * What the × divides by: everything people put into the mask (`fuel`), and whatever the mask fed its own mind
 * (`recycled`) beyond what it really earned in the arena. Winnings it spends on its mind raise nothing; NEAR sent to its
 * account and fuelled from there counts as put in, as a refuel would.
 */
export function putIn(fuel: bigint | string, recycled: bigint | string | undefined, earned: bigint | string): bigint {
  const over = BigInt(recycled ?? 0) - BigInt(earned);
  return BigInt(fuel) + (over > 0n ? over : 0n);
}

/** Earned ÷ everything put in, e.g. 1.45. `null` before anything was put in. */
export function times(earned: bigint | string, fuel: bigint | string): number | null {
  const f = BigInt(fuel);
  if (f <= 0n) return null;
  return Number((BigInt(earned) * 10_000n) / f) / 10_000;
}

/** `×1.45`, `×12.3`, `×0`. */
export function timesText(x: number | null): string {
  if (x === null) return "×—";
  if (x === 0) return "×0";
  return `×${x >= 10 ? x.toFixed(1) : x.toFixed(2)}`;
}

/** The owner's call on the mask's own account: everything above the gas fund goes to them. A copy pays its author's
 * share first, in the same call, to the author's own mask. */
export function withdrawAction() {
  return {
    type: "FunctionCall" as const,
    params: { methodName: "withdraw", args: {}, gas: "30000000000000", deposit: "0" },
  };
}

/** Pays a copy's author what is owed, to their own mask account. Anyone may send it; the destination is fixed in the
 * copy's code, so this can only pay the author. */
export function payAuthorAction() {
  return {
    type: "FunctionCall" as const,
    params: { methodName: "pay_author", args: {}, gas: "30000000000000", deposit: "0" },
  };
}

/** The author's call on the factory: opens their mask to copying for `authorBps` of each copy's winnings. Attaches a
 * little for the record's storage; the rest comes back. */
export function allowCopyAction(name: string, authorBps: number, storageDeposit = "100000000000000000000000") {
  return {
    type: "FunctionCall" as const,
    params: { methodName: "allow_copy", args: { name, author_bps: authorBps }, gas: "30000000000000", deposit: storageDeposit },
  };
}

/** The author closes their mask to new copies; copies already made keep their terms. */
export function stopCopyAction(name: string) {
  return {
    type: "FunctionCall" as const,
    params: { methodName: "stop_copy", args: { name }, gas: "30000000000000", deposit: "0" },
  };
}

/** An author's share in basis points as a percent, e.g. `30%`, `12.5%`. */
export function shareText(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

/** A copy's terms as the mask's own account tells them (`copy_terms`). All amounts yoctoNEAR. */
export interface CopyTerms {
  /** The author's own mask account, where the share goes. */
  readonly author: string;
  readonly bps: number;
  /** Sent to the author so far. */
  readonly paid: bigint;
  /** Counted for the author and not sent yet. With `paid`, what the author earned on this copy: it never goes down. */
  readonly owed: bigint;
  /** What `pay_author` would send the author now. */
  readonly due: bigint;
  /** What the owner's `withdraw` would send the owner now, the author's share already set aside. */
  readonly owner: bigint;
}

/** `copy_terms` as text: `author|bps|paid|owed|due|owner`, built by hand so the mask's wasm keeps no JSON code. `null`
 * for a mask that is not a copy (empty) or an answer of another shape. */
export function parseTerms(text: string): CopyTerms | null {
  const f = text.split("|");
  if (f.length !== 6 || !f[0] || f.slice(1).some((n) => !/^\d+$/.test(n))) return null;
  return { author: f[0], bps: Number(f[1]), paid: BigInt(f[2]!), owed: BigInt(f[3]!), due: BigInt(f[4]!), owner: BigInt(f[5]!) };
}

/** Reads a copy's terms from its own account; `null` for a mask that is not a copy, or when no RPC answers. */
export async function copyTerms(net: Network, account: string, timeoutMs = 8000): Promise<CopyTerms | null> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "maskwars-forge",
    method: "query",
    params: { request_type: "call_function", finality: "optimistic", account_id: account, method_name: "copy_terms", args_base64: "" },
  });
  for (const url of net.rpcs) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(timeoutMs) });
      const out = (await res.json()) as { result?: { result?: number[] } };
      if (!out.result?.result) continue;
      return parseTerms(new TextDecoder().decode(Uint8Array.from(out.result.result)));
    } catch {
      // the next RPC
    }
  }
  return null;
}

/** What an author earned on its copies and what waits for it on them now, from each copy's terms. */
export function copyEarnings(terms: readonly (CopyTerms | null)[]): { earned: bigint; due: bigint; waiting: number } {
  let earned = 0n;
  let due = 0n;
  let waiting = 0;
  for (const t of terms) {
    if (!t) continue;
    earned += t.paid + t.owed;
    due += t.due;
    if (t.due > 0n) waiting++;
  }
  return { earned, due, waiting };
}

/**
 * What NEAR says about an owner's `withdraw`: `done` with the amount the mask's own log names
 * (`withdraw <yocto> to <owner>`) once every receipt of the transaction went through; `failed` when the transaction
 * or one of its receipts failed, or it is not the owner's withdraw from this mask; `unknown` while no RPC has it.
 */
export type Withdrawn = { readonly state: "done"; readonly amount: bigint } | { readonly state: "failed" } | { readonly state: "unknown" };

/** A transaction's outcome as NEAR's `tx` method gives it, as far as a withdraw needs. */
export interface TxOutcome {
  readonly status?: Record<string, unknown>;
  readonly transaction?: { readonly signer_id?: string; readonly receiver_id?: string };
  readonly receipts_outcome?: readonly {
    readonly outcome?: { readonly executor_id?: string; readonly logs?: readonly string[]; readonly status?: Record<string, unknown> };
  }[];
}

export function readWithdraw(tx: TxOutcome, owner: string, mask: string): Withdrawn {
  return readOwnerMove(tx, owner, mask, "withdraw", owner);
}

/**
 * What NEAR says about an owner's `fuel`: the mask paying for its own mind. `done` with the amount the mask's own log
 * names (`fuel <yocto> to <factory>`) once every receipt went through, the factory's `refuel` included; `failed` when
 * any of them failed (the NEAR is then back on the mask), or it is not the owner's call on this mask.
 */
export function readFuel(tx: TxOutcome, owner: string, mask: string, factory: string): Withdrawn {
  return readOwnerMove(tx, owner, mask, "fuel", factory);
}

/** One of the owner's two moves on the mask's account, by the line the mask's code logs for it: `<move> <yocto> to <to>`. */
function readOwnerMove(tx: TxOutcome, owner: string, mask: string, move: "withdraw" | "fuel", to: string): Withdrawn {
  const status = tx.status ?? {};
  if ("Failure" in status) return { state: "failed" };
  if (!("SuccessValue" in status) && !("SuccessReceiptId" in status)) return { state: "unknown" };
  if (tx.transaction?.signer_id !== owner || tx.transaction?.receiver_id !== mask) return { state: "failed" };
  const receipts = tx.receipts_outcome ?? [];
  if (receipts.some((r) => r.outcome?.status && "Failure" in r.outcome.status)) return { state: "failed" };
  const pattern = new RegExp(`^${move} (\\d+) to (\\S+)$`);
  const line = receipts
    .filter((r) => r.outcome?.executor_id === mask)
    .flatMap((r) => r.outcome?.logs ?? [])
    .map((l) => pattern.exec(l))
    .find((m) => m?.[2] === to);
  return line ? { state: "done", amount: BigInt(line[1]!) } : { state: "failed" };
}

/** The owner's call on the mask's own account that makes the mask pay for its own mind: everything `withdraw` would pay
 * them goes into the mask's tank in the factory instead. A copy pays its author's share first, in the same call. */
export function fuelAction() {
  return {
    type: "FunctionCall" as const,
    params: { methodName: "fuel", args: {}, gas: "60000000000000", deposit: "0" },
  };
}

/** The owner's withdraw in transaction `hash`, as the first RPC that knows it says, at the final block. */
export async function withdrawn(net: Network, hash: string, owner: string, mask: string, timeoutMs = 15_000): Promise<Withdrawn> {
  const tx = await finalTx(net, hash, owner, timeoutMs);
  return tx ? readWithdraw(tx, owner, mask) : { state: "unknown" };
}

/** The owner's `fuel` in transaction `hash`: the mask's prize gone into its own tank in `net.factory`. */
export async function fueled(net: Network, hash: string, owner: string, mask: string, timeoutMs = 15_000): Promise<Withdrawn> {
  const tx = await finalTx(net, hash, owner, timeoutMs);
  return tx ? readFuel(tx, owner, mask, net.factory) : { state: "unknown" };
}

/** Transaction `hash` of `signer` at the final block, from the first RPC that knows it; `null` while none does. */
async function finalTx(net: Network, hash: string, signer: string, timeoutMs: number): Promise<TxOutcome | null> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "maskwars-forge",
    method: "tx",
    params: { tx_hash: hash, sender_account_id: signer, wait_until: "FINAL" },
  });
  for (const url of net.rpcs) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(timeoutMs) });
      const out = (await res.json()) as { result?: TxOutcome };
      if (out.result) return out.result;
    } catch {
      // the next RPC
    }
  }
  return null;
}
