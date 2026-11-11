// MASK CHECK signed inside a TEE. The site asks the module published on OutLayer (services/check, deployment.json)
// and hands its answer on only when the signature is the published key's, over exactly what the answer says, made by
// the published rules, about the account that was asked, read from the chain within the last five minutes, and only
// while the published rules are the ones the site checks by itself. Anything short of that and the site reads the
// chain itself, as it always did, and says in `tee.why` that nothing is signed. No error on the way ever turns into a
// failed check: the worst case is the site's own, unsigned answer.
//
// What a signed answer costs the site: the module's price, which goes to the project's own earnings on OutLayer, and
// the run's compute, about $0.002. The site pays with the OutLayer payment key in OUTLAYER_PAYMENT_KEY (Vercel, the
// owner's hands), never shown anywhere. A budget per caller and per instance keeps a flood of checks from spending it,
// and a breaker stops asking OutLayer for a minute when it fails three times in a row or wants more money (402).
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import type { CheckResult, Network } from '@maskwars/check';
import type { TeeDeployment } from '@maskwars/mcp';
import deployment from '../../../services/check/deployment.json' with { type: 'json' };
import sample from '../../../services/check/sample.json' with { type: 'json' };
import { type Limiter, createLimiter } from './limit';

/** Where MASK CHECK is published on OutLayer, as services/check/deployment.json records it. */
export const TEE_DEPLOYMENT: TeeDeployment = deployment;

/**
 * The rules this checkout builds, which the site's own check reads too: the sha256 of the module's sources and of the
 * two shared lists (services/check/build.rs). services/check/sample.json is the module's own answer and `cargo test`
 * holds it to those files, so a new safe in the shared list changes this value. A published module that states other
 * rules carries an older list: its signed answer could miss a drain the site already knows about.
 */
export const SITE_RULES: string = (sample as { output: { module: { rules: string } } }).output.module.rules;

/** What goes with a signed answer: who signed, over what, by which build, and where the run is attested. */
export interface TeeSigned {
  signed: true;
  /** Which OutLayer ran the module: `mainnet` or `testnet`. */
  outlayer: string;
  /** `owner/name` of the project on OutLayer. */
  project: string;
  /**
   * The build the site asked OutLayer to run (`version_key`, from deployment.json), by its sha256. It is the request,
   * not a proof: the site does not read the attestation. Which build ran is what `attestation_url` attests.
   */
  requested_wasm_sha256: string;
  /** The project's key, from deployment.json: the signature was checked against it, not against what the answer named. */
  key: string;
  /** The module's version and the sha256 of the rules that made the answer, as the signed message names them. */
  module: { version: string; rules: string };
  /** The exact text that was signed, and the ed25519 signature over its UTF-8 bytes, base64. */
  message: string;
  signature: string;
  /** OutLayer's TDX attestation of this run, when it gave one on its own API's origin over https. */
  attestation_url: string | null;
  call_id: string | null;
}

/** An answer the site read itself: why it carries no signature. */
export interface TeeUnsigned {
  signed: false;
  why: string;
}

export type Tee = TeeSigned | TeeUnsigned;

/** What /api/check answers: the check, and whether it was signed inside the TEE. */
export type CheckAnswer = CheckResult & { tee: Tee };

/** The first field of a signed message (services/check/src/lib.rs, `MESSAGE_VERSION`). */
const MESSAGE_VERSION = 2;
/** How old a signed answer may be, counted from the block it was read at (live.mjs holds the same). */
export const MAX_AGE_SECONDS = 300;
/** How far a block's time may be ahead of this machine's clock. */
const CLOCK_SLACK_SECONDS = 120;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** An ed25519 public key as SubjectPublicKeyInfo: a fixed 12-byte header, then the 32 bytes. */
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

function base58(text: string): Buffer | null {
  let n = 0n;
  for (const c of text) {
    const digit = B58.indexOf(c);
    if (digit < 0) return null;
    n = n * 58n + BigInt(digit);
  }
  const zeros = text.length - text.replace(/^1+/, '').length;
  const hex = n === 0n ? '' : n.toString(16);
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex')]);
}

/** JSON values that say the same, whatever order their fields come in. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const [ka, kb] = [Object.keys(a), Object.keys(b)];
  return ka.length === kb.length && ka.every((k) => k in b && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The module's answer inside what OutLayer returned: `{ call_id, status, output }`, then `{ success, output, error }`. */
export function moduleAnswerOf(body: unknown): Record<string, unknown> | null {
  let at: unknown = body;
  for (let i = 0; i < 2 && isObject(at) && !('tier' in at) && 'output' in at; i++) {
    at = at['output'];
    if (typeof at === 'string') {
      try {
        at = JSON.parse(at);
      } catch {
        return null;
      }
    }
  }
  return isObject(at) && 'tier' in at ? at : null;
}

/** The same three checks as services/check/verify.mjs, against the key and the rules the site trusts. */
export function verifySigned(
  answer: Record<string, unknown>,
  trusted: { key: string; rules: string },
  now: number,
  maxAgeSeconds = MAX_AGE_SECONDS,
): { ok: true; check: CheckResult; module: { version: string; rules: string }; message: string; signature: string } | { ok: false; why: string } {
  const signed = answer['signed'];
  if (!isObject(signed)) return { ok: false, why: `the ${String(answer['tier'])} answer carries no signature` };
  if (signed['alg'] !== 'ed25519') return { ok: false, why: `unknown signature scheme ${String(signed['alg'])}` };
  // The key an answer names is only a claim: it must be the published one.
  if (signed['key'] !== trusted.key) return { ok: false, why: 'signed by another key than the published one' };
  const raw = base58(trusted.key.replace(/^ed25519:/, ''));
  if (!raw || raw.length !== 32) return { ok: false, why: 'the published key is not an ed25519 key' };
  const { message, signature } = signed;
  if (typeof message !== 'string' || typeof signature !== 'string') return { ok: false, why: 'no message or no signature' };
  const publicKey = createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' });
  if (!verifySignature(null, Buffer.from(message, 'utf8'), publicKey, Buffer.from(signature, 'base64'))) {
    return { ok: false, why: 'the signature does not match the message' };
  }
  let said: unknown;
  try {
    said = JSON.parse(message);
  } catch {
    return { ok: false, why: 'the signed message is not JSON' };
  }
  if (!isObject(said)) return { ok: false, why: 'the signed message is not a MASK CHECK answer' };
  const { maskwars_check: mark, module, ...rest } = said;
  if (mark !== MESSAGE_VERSION) return { ok: false, why: `the signed message is not of version ${MESSAGE_VERSION}` };
  if (!isObject(module) || typeof module['version'] !== 'string' || typeof module['rules'] !== 'string') return { ok: false, why: 'the signed message names no module' };
  if (module['rules'] !== trusted.rules) return { ok: false, why: 'made by other rules than the published ones' };
  if (!same(rest, answer['check'])) return { ok: false, why: 'the answer is not what was signed' };
  const check = rest as unknown as CheckResult;
  if (!check.block) return { ok: false, why: 'the chain was not read, so no block says how old the answer is' };
  const age = (now - Date.parse(check.block.time)) / 1000;
  if (!Number.isFinite(age)) return { ok: false, why: 'the block has no readable time' };
  if (age < -CLOCK_SLACK_SECONDS) return { ok: false, why: "the block's time is ahead of the site's clock" };
  if (age > maxAgeSeconds) return { ok: false, why: `read from the chain ${Math.round(age)} s ago` };
  return { ok: true, check, module: { version: module['version'], rules: module['rules'] }, message, signature };
}

/**
 * OutLayer's attestation link, kept only when it is on the origin of OutLayer's own API (deployment.json `api`) over
 * https. A relative link is read against that API. Anything else, a malformed link or another host, is dropped: the
 * answer stays signed, since the signature is checked against the published key, but the site names no link it cannot
 * vouch for.
 */
export function attestationOf(raw: unknown, api: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2_048) return null;
  try {
    const base = new URL(api);
    const at = new URL(raw, base);
    return base.protocol === 'https:' && at.protocol === 'https:' && at.origin === base.origin ? at.href : null;
  } catch {
    return null;
  }
}

export interface TeeOptions {
  deployment?: TeeDeployment;
  /** The OutLayer payment key that pays for the site's signed answers; unset, nothing is signed. */
  paymentKey?: string | undefined;
  /** The rules the site checks by itself (SITE_RULES): a published module that states other rules is not asked. */
  siteRules?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** How long the site waits for OutLayer before it reads the chain itself. */
  timeoutMs?: number;
  /** Failed runs in a row after which the site stops asking OutLayer for `pauseMs`. A 402 stops it at once. */
  failuresToPause?: number;
  pauseMs?: number;
  /** Signed answers a caller gets a minute; the rest it gets read by the site, unsigned. */
  perCaller?: number;
  /** Signed answers one instance asks for a minute, and a day. */
  perMinute?: number;
  perDay?: number;
  /** Runs one instance has on OutLayer at once (a payment key allows 10). */
  inFlight?: number;
  /** How long one signed answer about one account is handed out again, in ms. Its block and time say how old it is. */
  reuseMs?: number;
}

export interface Tees {
  /** Whether this deployment can sign at all: published with the rules the site checks by, and a payment key to pay. */
  readonly ready: boolean;
  /** The signed answer about `account` (already a well-formed id of `network`), or why there is none. Never throws. */
  ask(account: string, network: Network, caller: string): Promise<{ check: CheckResult; tee: TeeSigned } | TeeUnsigned>;
}

/** Whether a deployment record names a published version. */
export function isPublished(d: TeeDeployment): d is TeeDeployment & { key: string; wasm_sha256: string; rules: string } {
  return !!d.key && !!d.wasm_sha256 && !!d.rules;
}

/** Whether the site asks the TEE at all: a published version, made by the rules the site checks by, and a key to pay. */
export function canSign(d: TeeDeployment, paymentKey: string | undefined, siteRules = SITE_RULES): boolean {
  return isPublished(d) && d.rules === siteRules && !!paymentKey?.trim();
}

const unsigned = (why: string): TeeUnsigned => ({ signed: false, why });

/**
 * How long a check waits for OutLayer before the site answers itself, and when it stops asking: after three failed runs
 * in a row, or one 402, an instance asks OutLayer nothing for a minute. A check then costs the site's own read only.
 */
export const BREAKER = { timeoutMs: 6_000, failuresToPause: 3, pauseMs: 60_000 } as const;

/** Why nothing is signed while the published module states other rules than the site checks by. */
export const STALE_RULES =
  'the module published in the TEE was built from other rules than the site checks by (the shared list changed since): the site read this answer itself';

export function createTees(o: TeeOptions = {}): Tees {
  const d = o.deployment ?? TEE_DEPLOYMENT;
  const key = o.paymentKey?.trim() ?? '';
  const siteRules = o.siteRules ?? SITE_RULES;
  const get = o.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = o.now ?? Date.now;
  const timeoutMs = o.timeoutMs ?? BREAKER.timeoutMs;
  const failuresToPause = o.failuresToPause ?? BREAKER.failuresToPause;
  const pauseMs = o.pauseMs ?? BREAKER.pauseMs;
  const perCaller: Limiter = createLimiter({ perWindow: o.perCaller ?? 10, windowMs: 60_000 });
  const perMinute: Limiter = createLimiter({ perWindow: o.perMinute ?? 30, windowMs: 60_000 });
  const perDay: Limiter = createLimiter({ perWindow: o.perDay ?? 2_000, windowMs: 86_400_000 });
  const maxInFlight = o.inFlight ?? 8;
  const reuseMs = o.reuseMs ?? 60_000;
  const kept = new Map<string, { at: number; answer: { check: CheckResult; tee: TeeSigned } }>();
  let inFlight = 0;
  // The breaker, per instance: failed runs in a row, and until when the site asks OutLayer nothing.
  let failures = 0;
  let pausedUntil = 0;
  const ready = canSign(d, key, siteRules);

  /** A run that gave no signed answer. The third in a row, or any 402, pauses runs on OutLayer for `pauseMs`. */
  const failed = (why: string, payment = false): TeeUnsigned => {
    failures += 1;
    if (payment || failures >= failuresToPause) {
      pausedUntil = now() + pauseMs;
      failures = 0;
      console.warn(`check-tee: no runs on OutLayer for ${Math.round(pauseMs / 1000)} s after ${payment ? 'HTTP 402' : `${failuresToPause} failed runs in a row`}`);
    }
    return unsigned(why);
  };

  async function signedAnswer(account: string, network: Network, caller: string): Promise<{ check: CheckResult; tee: TeeSigned } | TeeUnsigned> {
    if (!isPublished(d)) return unsigned('MASK CHECK is not published in its TEE yet: the site read this answer itself');
    // The module carries the shared list it was built with. When the list has moved on, its signed answer could miss
    // a drain the site's own check already reads, so the site does not pay for it and answers itself.
    if (d.rules !== siteRules) return unsigned(STALE_RULES);
    if (!key) return unsigned('the site holds no OutLayer payment key yet: it read this answer itself');
    const id = `${network}:${account}`;
    const old = kept.get(id);
    if (old && now() - old.at < reuseMs) return old.answer;
    if (old) kept.delete(id);
    const wait = pausedUntil - now();
    if (wait > 0) return unsigned(`OutLayer failed just now, so signed answers are paused for ${Math.ceil(wait / 1000)} s: the site read this one itself`);
    if (inFlight >= maxInFlight || perCaller.take(caller, now()) !== null || perMinute.take('all', now()) !== null || perDay.take('all', now()) !== null) {
      return unsigned('signed answers are paused for a moment: the site read this one itself');
    }

    inFlight += 1;
    let body: unknown;
    try {
      const res = await get(`${d.api.replace(/\/$/, '')}/call/${d.project}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-payment-key': key, 'x-attached-deposit': String(d.price_usd_micro) },
        // `version_key` pins the build the site trusts; `signed` makes a call that somehow paid nothing a refusal.
        body: JSON.stringify({ input: { account, network, signed: true }, version_key: d.wasm_sha256 }),
        signal: AbortSignal.timeout(timeoutMs),
        cache: 'no-store',
      });
      if (!res.ok) {
        console.warn(`check-tee: OutLayer answered HTTP ${res.status} for ${id}`);
        return failed(`OutLayer answered HTTP ${res.status}: the site read this answer itself`, res.status === 402);
      }
      body = await res.json();
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const late = name === 'TimeoutError' || name === 'AbortError';
      console.warn(`check-tee: ${late ? 'no answer in time' : name === 'SyntaxError' ? 'an answer that is not JSON' : 'OutLayer unreachable'} for ${id}`);
      if (late) return failed('OutLayer did not answer in time: the site read this answer itself');
      if (name === 'SyntaxError') return failed('OutLayer answered something that is not JSON: the site read this answer itself');
      return failed('OutLayer could not be reached: the site read this answer itself');
    } finally {
      inFlight -= 1;
    }

    const run = isObject(body) ? body : {};
    if (run['status'] !== 'completed') return failed(`the run on OutLayer ended ${String(run['status'] ?? 'without a status')}: the site read this answer itself`);
    const answer = moduleAnswerOf(body);
    if (!answer) return failed('OutLayer returned no MASK CHECK answer: the site read this one itself');
    if (answer['tier'] !== 'signed') return failed(`the module answered ${String(answer['tier'])}, not signed: the site read this answer itself`);
    const v = verifySigned(answer, { key: d.key, rules: d.rules }, now());
    if (!v.ok) {
      console.error(`check-tee: a signed answer for ${id} did not verify: ${v.why}`);
      return failed(`the TEE's answer did not verify (${v.why}): the site read this one itself`);
    }
    if (v.check.account !== account || v.check.network !== network) return failed('the TEE answered about another account: the site read this one itself');
    // Held to d.rules above, which is the site's own; said again here so that no later change can loosen it.
    if (v.module.rules !== siteRules) return unsigned(STALE_RULES);

    failures = 0;
    const done = {
      check: v.check,
      tee: {
        signed: true as const,
        outlayer: d.outlayer,
        project: d.project,
        requested_wasm_sha256: d.wasm_sha256,
        key: d.key,
        module: v.module,
        message: v.message,
        signature: v.signature,
        attestation_url: attestationOf(run['attestation_url'], d.api),
        call_id: typeof run['call_id'] === 'string' ? run['call_id'] : null,
      },
    };
    if (kept.size >= 1_000) kept.delete(kept.keys().next().value as string);
    kept.set(id, { at: now(), answer: done });
    return done;
  }

  return {
    ready,
    async ask(account, network, caller) {
      try {
        return await signedAnswer(account, network, caller);
      } catch (error) {
        // Whatever OutLayer sent that the lines above did not foresee: the check still answers, unsigned.
        console.error(`check-tee: the TEE's answer about ${network}:${account} could not be read: ${error instanceof Error ? error.message : String(error)}`);
        return failed("the TEE's answer could not be read: the site read this one itself");
      }
    },
  };
}
