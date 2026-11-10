import { fromBase64 } from "./codec.ts";
import type { UnsignedIntent } from "./oneclick.ts";

/** The verifier contract of NEAR Intents: every vault lives in its ledger. */
export const INTENTS = "intents.near";

export interface Expected {
  /** The vault's account: the only one allowed to sign. */
  readonly signer: string;
  /** 1Click's deposit address from the quote this intent pays. */
  readonly depositAddress: string;
  /** The coin and the exact units the person agreed to send. */
  readonly asset: string;
  readonly amount: string;
  /**
   * The latest the intent may stay valid: the cash-out quote's own deadline (`quoteRequest.deadline`, 15 minutes after
   * the quote). 1Click dates the intent it builds as late as its deposit address (three days); the page shortens it
   * with `withDeadline` before signing, so a signature that went astray cannot move money days later. Without it,
   * half an hour.
   */
  readonly notAfter?: string;
  readonly now?: Date;
}

/** How far ahead an intent may be valid when the quote does not say. */
export const MAX_DEADLINE_MS = 30 * 60_000;

export type Check = { readonly ok: true } | { readonly ok: false; readonly why: string };

const no = (why: string): Check => ({ ok: false, why });
const keys = (o: object) => Object.keys(o).sort().join(",");

/**
 * Reads what a person is about to sign before the passkey or wallet sees it. 1Click builds the intent; this page signs
 * it only if it says exactly one thing: move `amount` of `asset` from the vault to the quote's deposit address, inside
 * NEAR Intents, while the quote lasts. Anything else (another receiver, another coin, a bigger amount, a second intent, a later deadline,
 * another signer or contract) is refused, so a broken or hostile server cannot get a signature for more than that.
 */
export function checkIntent(intent: UnsignedIntent, e: Expected): Check {
  let message: unknown;
  let contract: unknown;
  let nonce: unknown;
  if (intent.standard === "webauthn") {
    if (typeof intent.payload !== "string") return no("payload is not a string");
    try {
      message = JSON.parse(intent.payload);
    } catch {
      return no("payload is not JSON");
    }
    if (!message || typeof message !== "object") return no("payload is not an object");
    const m = message as Record<string, unknown>;
    if (keys(m) !== "deadline,intents,nonce,signer_id,verifying_contract") return no(`unexpected fields: ${keys(m)}`);
    contract = m.verifying_contract;
    nonce = m.nonce;
  } else if (intent.standard === "nep413") {
    const p = intent.payload;
    if (!p || typeof p !== "object" || typeof p.message !== "string") return no("payload has no message");
    if (p.callbackUrl) return no("payload asks for a callback");
    contract = p.recipient;
    nonce = p.nonce;
    try {
      message = JSON.parse(p.message);
    } catch {
      return no("message is not JSON");
    }
    if (!message || typeof message !== "object") return no("message is not an object");
    if (keys(message) !== "deadline,intents,signer_id") return no(`unexpected fields: ${keys(message)}`);
  } else {
    return no(`unknown standard ${String((intent as { standard: unknown }).standard)}`);
  }

  const m = message as Record<string, unknown>;
  if (m.signer_id !== e.signer) return no(`signer is ${String(m.signer_id)}`);
  if (contract !== INTENTS) return no(`contract is ${String(contract)}`);
  if (typeof nonce !== "string" || fromBase64(nonce)?.length !== 32) return no("nonce is not 32 bytes");

  const now = (e.now ?? new Date()).getTime();
  const deadline = typeof m.deadline === "string" ? Date.parse(m.deadline) : NaN;
  if (!Number.isFinite(deadline) || deadline <= now) return no(`deadline has passed: ${String(m.deadline)}`);
  const limit = e.notAfter !== undefined ? Date.parse(e.notAfter) + 60_000 : now + MAX_DEADLINE_MS;
  if (!Number.isFinite(limit) || deadline > limit) return no(`deadline is too far away: ${String(m.deadline)}`);

  if (!Array.isArray(m.intents) || m.intents.length !== 1) return no("not exactly one intent");
  const t = m.intents[0] as Record<string, unknown>;
  if (!t || typeof t !== "object") return no("intent is not an object");
  const extra = Object.keys(t).filter((k) => !["intent", "receiver_id", "tokens", "memo"].includes(k));
  if (extra.length) return no(`intent has ${extra.join(", ")}`);
  if (t.intent !== "transfer") return no(`intent is ${String(t.intent)}`);
  if (t.memo !== undefined && typeof t.memo !== "string") return no("memo is not text");
  if (t.receiver_id !== e.depositAddress) return no(`receiver is ${String(t.receiver_id)}`);
  const tokens = t.tokens as Record<string, unknown> | null;
  if (!tokens || typeof tokens !== "object" || keys(tokens) !== e.asset) return no("tokens are not the agreed coin");
  if (tokens[e.asset] !== e.amount) return no(`amount is ${String(tokens[e.asset])}`);
  return { ok: true };
}

/**
 * The same intent, valid only until `deadline` (never later than it already was). 1Click's `generate-intent` dates a
 * cash-out's transfer as late as its deposit address lives, three days; the money only has to move while the quote
 * lasts, fifteen minutes. Only the `deadline` value changes: the text around it stays byte for byte as 1Click wrote it,
 * and the result is read back to make sure nothing else moved. `null` if the payload is not one this page signs.
 */
export function withDeadline(intent: UnsignedIntent, deadline: string): UnsignedIntent | null {
  const want = Date.parse(deadline);
  if (!Number.isFinite(want)) return null;
  const rewrite = (text: string): string | null => {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (!m || typeof m !== "object" || typeof m.deadline !== "string") return null;
    const had = Date.parse(m.deadline);
    if (!Number.isFinite(had)) return null;
    if (had <= want) return text;
    const from = `"deadline":${JSON.stringify(m.deadline)}`;
    if (text.split(from).length !== 2) return null;
    const next = text.replace(from, `"deadline":${JSON.stringify(new Date(want).toISOString())}`);
    const back = JSON.parse(next) as Record<string, unknown>;
    if (JSON.stringify({ ...back, deadline: m.deadline }) !== JSON.stringify(m)) return null;
    return next;
  };
  if (intent.standard === "webauthn") {
    if (typeof intent.payload !== "string") return null;
    const payload = rewrite(intent.payload);
    return payload === null ? null : { standard: "webauthn", payload };
  }
  if (intent.standard === "nep413") {
    if (!intent.payload || typeof intent.payload.message !== "string") return null;
    const message = rewrite(intent.payload.message);
    return message === null ? null : { standard: "nep413", payload: { ...intent.payload, message } };
  }
  return null;
}

/** When an intent stops being valid, in ms; `null` if it does not say. */
export function intentDeadline(intent: UnsignedIntent): number | null {
  try {
    const text = intent.standard === "webauthn" ? intent.payload : intent.payload.message;
    const d = (JSON.parse(text) as { deadline?: unknown }).deadline;
    const t = typeof d === "string" ? Date.parse(d) : NaN;
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/** A vault's account: a passkey's `0x…` account, or a NEAR mainnet account a wallet signs for. */
export function vaultAccountOk(id: string): boolean {
  if (/^0x[0-9a-f]{40}$/.test(id)) return true;
  if (id.length < 2 || id.length > 64 || id.endsWith(".testnet")) return false;
  return /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(id);
}
