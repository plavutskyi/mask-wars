import { INTENTS } from "./intent.ts";

/**
 * A vault opened by a NEAR wallet spends its own NEAR on a contract: the money a person brought in from any network goes
 * into a call that takes NEAR, such as a mask's mind (`refuel` on the mask factory). NEAR Intents keeps the vault's NEAR
 * as wNEAR on `intents.near`, and only a NEAR account can attach NEAR to a call, so the person's wallet signs four
 * transactions in this order (in one approval where the wallet signs several at once, else one approval each):
 *
 *   1. `wrap.near`    storage_deposit(account, registration_only)   0.00125 NEAR, given back at once if already there
 *   2. `intents.near` ft_withdraw(wrap.near → account, amount)       1 yocto: the vault's wNEAR to the account itself
 *   3. `wrap.near`    near_withdraw(amount)                          1 yocto: wNEAR to NEAR on the account
 *   4. the contract   method(args)                                   `amount` attached
 *
 * Step 1 keeps step 2 from bouncing: wNEAR can only land on an account `wrap.near` knows, and a transfer that bounces
 * goes back to the vault while the wallet would go on to the next step. Every step moves the person's own money between
 * the person's own accounts until the last one, which is the call the person chose. The site signs nothing and holds no
 * key: the wallet shows each transaction before it signs.
 *
 * A passkey vault cannot do this: its account lives inside NEAR Intents only and has no NEAR account to attach NEAR
 * from. Masks are forged from NEAR wallets, so a passkey vault has no mask to fuel.
 */

/** wNEAR, the token NEAR Intents keeps a vault's NEAR as. */
export const WNEAR = "wrap.near";

/** What `wrap.near` asks to register an account (its `storage_balance_bounds().min`). */
export const WNEAR_STORAGE = 1_250_000_000_000_000_000_000n;

const TGAS = 10n ** 12n;

/** One function call, in the shape NEAR wallets sign (NEAR Connect, wallet selector). */
export interface CallAction {
  readonly type: "FunctionCall";
  readonly params: {
    readonly methodName: string;
    readonly args: Record<string, unknown>;
    /** Gas, in units. */
    readonly gas: string;
    /** yoctoNEAR attached. */
    readonly deposit: string;
  };
}

export interface Transaction {
  readonly receiverId: string;
  readonly actions: readonly CallAction[];
}

/** The call the vault's NEAR ends in. */
export interface Spend {
  readonly receiver: string;
  readonly method: string;
  readonly args: Record<string, unknown>;
  /** yoctoNEAR: what leaves the vault and what the call attaches. */
  readonly amount: bigint;
  /** Gas for the call itself, in TGas. */
  readonly tgas: number;
}

const call = (methodName: string, args: Record<string, unknown>, tgas: number, deposit: bigint): CallAction => ({
  type: "FunctionCall",
  params: { methodName, args, gas: (BigInt(tgas) * TGAS).toString(), deposit: deposit.toString() },
});

/** The four transactions that move `spend.amount` of the vault's NEAR into `spend`, for `account`'s own wallet. */
export function spendTransactions(account: string, spend: Spend): Transaction[] {
  if (spend.amount <= 0n) throw new Error("nothing to spend");
  if (account.startsWith("0x")) throw new Error("a passkey vault has no NEAR account to spend from");
  const amount = spend.amount.toString();
  return [
    { receiverId: WNEAR, actions: [call("storage_deposit", { account_id: account, registration_only: true }, 10, WNEAR_STORAGE)] },
    { receiverId: INTENTS, actions: [call("ft_withdraw", { token: WNEAR, receiver_id: account, amount }, 60, 1n)] },
    { receiverId: WNEAR, actions: [call("near_withdraw", { amount }, 10, 1n)] },
    { receiverId: spend.receiver, actions: [call(spend.method, spend.args, spend.tgas, spend.amount)] },
  ];
}

/**
 * NEAR the wallet's own account pays for the four transactions, besides the vault's NEAR: at most 0.02, gas prepaid and
 * step 1, most of it given back at once.
 */
export const SPEND_GAS_NEAR = 20_000_000_000_000_000_000_000n;

/** How a wallet reported one transaction: NEAR's `FinalExecutionOutcome`, as far as this page reads it. */
export interface Outcome {
  readonly status?: { readonly SuccessValue?: string; readonly Failure?: unknown } | string;
  readonly transaction?: { readonly hash?: string };
  readonly transaction_outcome?: { readonly id?: string };
}

/** How the four transactions ended, from what the wallet gave back. */
export type Spent =
  /** The call took the NEAR; `value` is what it returned (JSON), if anything. */
  | { readonly ok: true; readonly hash: string | null; readonly value: unknown }
  /**
   * It stopped at a step. `lost: false`: the wallet reported that step failed (1–2: the NEAR is in the vault; 3: wNEAR on
   * the account; 4: NEAR on the account). `lost: true`: the wallet gave no answer for that step on (closed, timed out),
   * so only the chain can say how far it went.
   */
  | { readonly ok: false; readonly step: number; readonly hash: string | null; readonly lost: boolean };

const hashOf = (o: Outcome | undefined) => o?.transaction?.hash ?? o?.transaction_outcome?.id ?? null;

/** Whether one transaction went through, as its wallet reported it. */
export function succeeded(o: Outcome | undefined): boolean {
  if (!o) return false;
  const st = o.status;
  if (typeof st === "string") return st.startsWith("Success");
  return Boolean(st) && typeof st === "object" && ("SuccessValue" in st || "SuccessReceiptId" in st);
}

/** Whether the wallet said a transaction failed: only a `Failure` says so; a status it did not wait for says nothing. */
function failed(o: Outcome | undefined): boolean {
  const st = o?.status;
  if (typeof st === "string") return st === "Failure";
  return Boolean(st) && typeof st === "object" && "Failure" in st;
}

/** What a transaction returned, as JSON; `null` when it returned nothing readable. */
function valueOf(o: Outcome | undefined): unknown {
  const raw = o && typeof o.status === "object" ? o.status.SuccessValue : undefined;
  if (!raw) return null;
  try {
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}

/**
 * Reads the wallet's outcomes for `spendTransactions`: where it stopped, or what the call returned. With `amount`, the
 * withdrawal (step 2) counts only if NEAR Intents says it moved exactly that much: when wNEAR cannot land on the
 * account, `ft_withdraw` still succeeds, returns "0" and puts the wNEAR back in the vault.
 */
export function spentOf(outcomes: readonly Outcome[], amount?: bigint): Spent {
  for (let i = 0; i < 4; i++) {
    if (failed(outcomes[i])) return { ok: false, step: i + 1, hash: hashOf(outcomes[i]), lost: false };
    // No outcome, or one without a final status (a wallet that waits only for inclusion): only the chain can say.
    if (!succeeded(outcomes[i])) return { ok: false, step: i + 1, hash: hashOf(outcomes[i]), lost: true };
    // A wallet that reports a bare status string gives no value to read: then the read-back of the vault decides.
    const moved = i === 1 && amount !== undefined ? valueOf(outcomes[1]) : null;
    if (moved !== null && moved !== amount!.toString()) return { ok: false, step: 2, hash: hashOf(outcomes[1]), lost: false };
  }
  return { ok: true, hash: hashOf(outcomes[3]), value: valueOf(outcomes[3]) };
}
