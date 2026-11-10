/**
 * Just enough NEAR to sign and send one function call from a mask's key, with nothing but `node:crypto`: base58,
 * the Borsh layout of a transaction with a single `FunctionCall`, ed25519 keys as NEAR writes them, and JSON-RPC.
 * A function-call key can do nothing more than this anyway: one action, no deposit, one receiver.
 */
import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function base58Decode(text: string): Uint8Array {
  let n = 0n;
  for (const c of text) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("not base58");
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of text) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");

/** A NEAR ed25519 key from its secret form `ed25519:<base58 of seed and public key>`. */
export class NearKey {
  readonly publicKey: Uint8Array;
  readonly #key: KeyObject;

  constructor(secret: string) {
    const [curve, body] = secret.trim().split(":");
    if (curve !== "ed25519" || !body) throw new Error("a NEAR secret key is ed25519:<base58>");
    const raw = base58Decode(body);
    if (raw.length !== 64 && raw.length !== 32) throw new Error("an ed25519 secret key is 32 or 64 bytes");
    this.#key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, raw.subarray(0, 32)]), format: "der", type: "pkcs8" });
    this.publicKey = new Uint8Array(createPublicKey(this.#key).export({ format: "der", type: "spki" }).subarray(12));
    if (raw.length === 64 && Buffer.compare(raw.subarray(32), this.publicKey) !== 0) {
      throw new Error("the secret key does not match its public half");
    }
  }

  get publicKeyText(): string {
    return `ed25519:${base58Encode(this.publicKey)}`;
  }

  sign(message: Uint8Array): Uint8Array {
    return new Uint8Array(sign(null, message, this.#key));
  }

  /**
   * The X25519 key of this ed25519 key, as libsodium's `crypto_sign_ed25519_sk_to_curve25519` makes it: it opens what
   * was sealed for this key's public half (finding-box.ts). The secret never leaves the object.
   */
  x25519(): KeyObject {
    const seed = Buffer.from(this.#key.export({ format: "jwk" }).d ?? "", "base64url");
    const s = createHash("sha512").update(seed).digest().subarray(0, 32);
    s[0]! &= 248;
    s[31]! &= 127;
    s[31]! |= 64;
    return createPrivateKey({ key: Buffer.concat([PKCS8_X25519, s]), format: "der", type: "pkcs8" });
  }
}

export interface FunctionCallTx {
  readonly signer: string;
  readonly publicKey: Uint8Array;
  readonly nonce: bigint;
  readonly receiver: string;
  readonly blockHash: Uint8Array;
  readonly method: string;
  readonly args: Uint8Array;
  readonly gas: bigint;
  readonly deposit: bigint;
}

class Borsh {
  readonly #parts: Buffer[] = [];
  u8(n: number) {
    this.#parts.push(Buffer.from([n]));
  }
  u32(n: number) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    this.#parts.push(b);
  }
  u64(n: bigint) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(n);
    this.#parts.push(b);
  }
  u128(n: bigint) {
    const b = Buffer.alloc(16);
    b.writeBigUInt64LE(n & 0xffff_ffff_ffff_ffffn);
    b.writeBigUInt64LE(n >> 64n, 8);
    this.#parts.push(b);
  }
  fixed(bytes: Uint8Array) {
    this.#parts.push(Buffer.from(bytes));
  }
  bytes(bytes: Uint8Array) {
    this.u32(bytes.length);
    this.fixed(bytes);
  }
  string(s: string) {
    this.bytes(Buffer.from(s, "utf8"));
  }
  done(): Buffer {
    return Buffer.concat(this.#parts);
  }
}

/** Borsh of a `Transaction` (V0) with one `FunctionCall` action, as nearcore hashes and signs it. */
export function encodeTx(tx: FunctionCallTx): Buffer {
  if (tx.blockHash.length !== 32 || tx.publicKey.length !== 32) throw new Error("block hash and key are 32 bytes");
  const w = new Borsh();
  w.string(tx.signer);
  w.u8(0); // ed25519
  w.fixed(tx.publicKey);
  w.u64(tx.nonce);
  w.string(tx.receiver);
  w.fixed(tx.blockHash);
  w.u32(1);
  w.u8(2); // Action::FunctionCall
  w.string(tx.method);
  w.bytes(tx.args);
  w.u64(tx.gas);
  w.u128(tx.deposit);
  return w.done();
}

/** The signed transaction, base64 for `send_tx`, and its hash. */
export function signTx(tx: FunctionCallTx, key: NearKey): { hash: string; base64: string } {
  const body = encodeTx(tx);
  const digest = createHash("sha256").update(body).digest();
  const w = new Borsh();
  w.fixed(body);
  w.u8(0);
  w.fixed(key.sign(digest));
  return { hash: base58Encode(digest), base64: w.done().toString("base64") };
}

/** The bits of NEAR JSON-RPC a mask needs. */
export interface Chain {
  rpc(method: string, params: unknown): Promise<unknown>;
}

export class JsonRpc implements Chain {
  readonly url: string;
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs = 60_000) {
    this.url = url;
    this.timeoutMs = timeoutMs;
  }

  async rpc(method: string, params: unknown): Promise<unknown> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "maskwars", method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = (await res.json()) as { result?: unknown; error?: { name?: string; cause?: { name?: string }; data?: unknown } };
    if (body.error) {
      const e = body.error;
      throw new Error(`${method}: ${e.cause?.name ?? e.name ?? "error"} ${typeof e.data === "string" ? e.data : JSON.stringify(e.data ?? "")}`);
    }
    return body.result;
  }
}

/** A view call, its JSON result. */
export async function view<T>(chain: Chain, contract: string, method: string, args: object = {}): Promise<T> {
  const r = (await chain.rpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  })) as { result?: number[]; error?: string };
  if (!r.result) throw new Error(`${contract}.${method}: ${r.error ?? "no result"}`);
  return JSON.parse(Buffer.from(r.result).toString("utf8")) as T;
}

/** The failure in an outcome status. A status may be a bare word: `Started` before a final block, `Unknown`. */
const failureOf = (status: unknown): unknown =>
  status && typeof status === "object" && "Failure" in status ? status.Failure : undefined;

export interface CallResult {
  readonly hash: string;
  readonly ok: boolean;
  /** The failure the chain reported, if any. */
  readonly error?: string;
  /** The transaction's JSON return value, once every receipt ran (FINAL): what the last call in its chain returned.
   * Also on a call that returned it while a receipt it did not wait for failed. */
  readonly value?: unknown;
  /** Every log line of every receipt, in order. */
  readonly logs?: readonly string[];
}

/** The JSON a `SuccessValue` carries, or undefined. */
function successValue(status: unknown): unknown {
  if (!status || typeof status !== "object" || !("SuccessValue" in status)) return undefined;
  const raw = (status as { SuccessValue: unknown }).SuccessValue;
  if (typeof raw !== "string" || raw === "") return undefined;
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Signs `method(args)` on `receiver` as `signer` with `key` and waits for the result. `waitUntil` FINAL waits for every
 * receipt; INCLUDED_FINAL only for the transaction to be in a final block.
 */
export async function call(
  chain: Chain,
  signer: string,
  key: NearKey,
  receiver: string,
  method: string,
  args: object,
  gasTgas: number,
  waitUntil: "FINAL" | "INCLUDED_FINAL" = "FINAL",
): Promise<CallResult> {
  const access = (await chain.rpc("query", {
    request_type: "view_access_key",
    finality: "final",
    account_id: signer,
    public_key: key.publicKeyText,
  })) as { nonce: number | string; block_hash: string };
  const tx: FunctionCallTx = {
    signer,
    publicKey: key.publicKey,
    nonce: BigInt(access.nonce) + 1n,
    receiver,
    blockHash: base58Decode(access.block_hash),
    method,
    args: Buffer.from(JSON.stringify(args)),
    gas: BigInt(gasTgas) * 10n ** 12n,
    deposit: 0n,
  };
  const signed = signTx(tx, key);
  const r = (await chain.rpc("send_tx", { signed_tx_base64: signed.base64, wait_until: waitUntil })) as {
    status?: unknown;
    receipts_outcome?: { outcome: { status: unknown; logs?: string[] } }[];
  };
  const failedReceipt = r.receipts_outcome?.find((o) => failureOf(o.outcome.status) !== undefined)?.outcome.status;
  const error = failureOf(r.status) ?? failureOf(failedReceipt);
  const logs = (r.receipts_outcome ?? []).flatMap((o) => o.outcome.logs ?? []);
  const value = successValue(r.status);
  if (error !== undefined) {
    // A call can return its value and still leave a failed receipt behind it (a promise it did not wait for).
    const failed = { hash: signed.hash, ok: false, error: JSON.stringify(error), logs };
    return value === undefined ? failed : { ...failed, value };
  }
  return value === undefined ? { hash: signed.hash, ok: true, logs } : { hash: signed.hash, ok: true, value, logs };
}
