// The agent's side: nothing is signed before MASK CHECK answers about the payee.
// - `block`: refuse, the signer is never called.
// - `warn`: a person decides; no answer is a no.
// - `allow`: sign. It only means no signal against the payee was found.
// - The check fails or times out: refuse. A pre-payment check that fails open is no check.
//
// The agent signs with a function-call access key scoped to one contract, never with a full-access key. The wrapper
// reads what the key may do and refuses any call outside it before asking anything else.
import { accountOk, isImplicit } from "./account.ts";
import type { CheckResult, Verdict } from "./check.ts";
import type { ChainReader, KeyPermission } from "./rpc.ts";

/** One call the agent wants to sign: a payment made through the one contract its key is scoped to. */
export interface PaymentIntent {
  /** Who ends up with the money. This is the account MASK CHECK is asked about. */
  payee: string;
  /** yoctoNEAR. */
  amount: string;
  /** The function call that makes the payment. */
  call: { contract: string; method: string; args: Record<string, unknown>; deposit: string; gas: string };
  /** Why the agent wants to pay, in its own words; shown to the person on a warn. */
  why: string;
}

export interface HumanQuestion {
  intent: PaymentIntent;
  check: CheckResult;
}

export interface Guard {
  /** What the agent's key may do, as read from the chain (`readKeyScope`). */
  key: KeyPermission;
  check: (account: string) => Promise<CheckResult>;
  /** Asks a person. Anything but `true` is a no. */
  askHuman: (question: HumanQuestion) => Promise<boolean>;
  /** Signs and sends the call; returns the transaction hash. Called only after every gate passed. */
  sign: (call: PaymentIntent["call"]) => Promise<string>;
  log?: (line: string) => void;
  /** How long the check may take. Default 15 s. */
  checkTimeoutMs?: number;
}

export type RefusedBy = "key" | "call" | "block" | "human" | "check_failed";

export type PayOutcome =
  | { status: "signed"; tx: string; verdict: Verdict; check: CheckResult }
  | { status: "refused"; by: RefusedBy; reason: string; check: CheckResult | null };

/** Why the key cannot make this call, or `null` when it can. */
export function keyRefusal(key: KeyPermission, call: PaymentIntent["call"]): string | null {
  if (key.kind === "full_access") return "the agent never signs with a full-access key";
  if (call.contract !== key.receiver) return `the key is scoped to ${key.receiver}, not ${call.contract}`;
  if (key.methods.length > 0 && !key.methods.includes(call.method)) return `the key may call ${key.methods.join(", ")}, not ${call.method}`;
  // NEAR rejects a function-call key's transaction that attaches a deposit, so it would fail on chain anyway.
  if (BigInt(call.deposit) !== 0n) return "a function-call key cannot attach a deposit";
  return null;
}

/** Reads the agent's key from the chain. A key the account does not have is no key at all. */
export async function readKeyScope(reader: ChainReader, accountId: string, publicKey: string): Promise<KeyPermission> {
  const key = await reader.accessKey(accountId, publicKey);
  if (!key) throw new Error(`${accountId} has no key ${publicKey}`);
  return key;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

const RANK: Record<Verdict, number> = { block: 2, warn: 1, allow: 0 };

/** An account id as it can stand in call arguments: with a dot or implicit, so amounts and method names never count. */
function looksLikeAccount(v: string): boolean {
  return accountOk(v) && (v.includes(".") || isImplicit(v));
}

/**
 * Every account the call names anywhere in its arguments, in the order they appear. The wrapper checks all of them:
 * an agent told to pay someone can be told to name a clean payee and put another account in the call.
 */
export function accountsInCall(call: PaymentIntent["call"]): string[] {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      if (looksLikeAccount(v)) out.add(v);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === "object") {
      Object.values(v).forEach(walk);
    }
  };
  walk(call.args);
  return [...out];
}

/** The one way the agent pays. */
export async function guardedPay(intent: PaymentIntent, guard: Guard): Promise<PayOutcome> {
  const log = guard.log ?? (() => {});
  log(`intent  pay ${intent.payee} via ${intent.call.contract}.${intent.call.method}: ${intent.why}`);

  const keyNo = keyRefusal(guard.key, intent.call);
  if (keyNo) {
    log(`REFUSED key: ${keyNo}`);
    return { status: "refused", by: "key", reason: keyNo, check: null };
  }

  // What gets signed is the call, so the call decides who is checked. The payee the agent states must be in it.
  const named = accountsInCall(intent.call);
  if (!named.includes(intent.payee)) {
    const reason = `the call does not pay ${intent.payee}: it names ${named.length ? named.join(", ") : "no account"}`;
    log(`REFUSED call: ${reason}`);
    return { status: "refused", by: "call", reason, check: null };
  }
  const accounts = [intent.payee, ...named.filter((a) => a !== intent.payee)];

  let check: CheckResult | null = null;
  for (const account of accounts) {
    let one: CheckResult;
    try {
      one = await withTimeout(guard.check(account), guard.checkTimeoutMs ?? 15_000);
    } catch (error) {
      const reason = `MASK CHECK did not answer for ${account}: ${error instanceof Error ? error.message : String(error)}`;
      log(`REFUSED ${reason}`);
      return { status: "refused", by: "check_failed", reason, check: null };
    }
    log(`check   ${one.account} → ${one.verdict.toUpperCase()} at block ${one.block?.height ?? "?"}`);
    for (const r of one.reasons) log(`        ${r.level.padEnd(5)} ${r.code}: ${r.text}`);
    if (!check || RANK[one.verdict] > RANK[check.verdict]) check = one;
  }
  if (!check) throw new Error("unreachable: the payee is always checked");

  if (check.verdict === "block") {
    log("REFUSED block: nothing was signed");
    return { status: "refused", by: "block", reason: check.summary, check };
  }
  if (check.verdict === "warn") {
    let yes = false;
    try {
      yes = (await guard.askHuman({ intent, check })) === true;
    } catch {
      yes = false;
    }
    if (!yes) {
      log("REFUSED warn: the person did not confirm");
      return { status: "refused", by: "human", reason: check.summary, check };
    }
    log("confirm the person confirmed the warn");
  }
  const tx = await guard.sign(intent.call);
  log(`signed  ${tx}`);
  return { status: "signed", tx, verdict: check.verdict, check };
}
