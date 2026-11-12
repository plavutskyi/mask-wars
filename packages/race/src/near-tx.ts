/**
 * Just enough NEAR to sign and send a transaction with nothing but `node:crypto`: base58, the Borsh layout of a
 * transaction, ed25519 keys as NEAR writes them, and JSON-RPC.
 *
 * A mask's function-call key can do one thing only: one `FunctionCall`, no deposit, one receiver (`call`). The house's
 * full key (house.ts) makes the round's safe in one transaction of four actions, `CreateAccount`, `Transfer`,
 * `DeployContract` and `FunctionCall`, and opens the round with a call that carries the deposit (`send`).
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

/**
 * One action of a transaction. Only the four the arena sends: nearcore numbers them 0 to 3 in `Action`, and Borsh writes
 * that number as the action's first byte.
 */
export type Action =
  | { readonly kind: "createAccount" }
  | { readonly kind: "deployContract"; readonly code: Uint8Array }
  | { readonly kind: "functionCall"; readonly method: string; readonly args: Uint8Array; readonly gas: bigint; readonly deposit: bigint }
  | { readonly kind: "transfer"; readonly deposit: bigint };

const TGAS = 10n ** 12n;

/** Makes the transaction's receiver a new account. It gets no key unless the same transaction adds one. */
export const createAccount = (): Action => ({ kind: "createAccount" });
/** Moves `yocto` yoctoNEAR from the signer to the receiver. */
export const transfer = (yocto: bigint): Action => ({ kind: "transfer", deposit: yocto });
/** Puts `code` (a wasm) on the receiver's account. */
export const deployContract = (code: Uint8Array): Action => ({ kind: "deployContract", code });
/** Calls `method(args)` on the receiver with `gasTgas` TGas and, if given, a deposit in yoctoNEAR. */
export const functionCall = (method: string, args: object, gasTgas: number, deposit = 0n): Action => ({
  kind: "functionCall",
  method,
  args: Buffer.from(JSON.stringify(args)),
  gas: BigInt(gasTgas) * TGAS,
  deposit,
});

/** A transaction (V0) as nearcore hashes and signs it: who signs with which key, to whom, and the actions in order. */
export interface Transaction {
  readonly signer: string;
  readonly publicKey: Uint8Array;
  readonly nonce: bigint;
  readonly receiver: string;
  readonly blockHash: Uint8Array;
  readonly actions: readonly Action[];
}

/** A transaction of one `FunctionCall`: all a function-call key can sign. */
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

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

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
    if (n < 0n || n > U64_MAX) throw new Error("not a u64");
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(n);
    this.#parts.push(b);
  }
  u128(n: bigint) {
    if (n < 0n || n > U128_MAX) throw new Error("not a u128");
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

function writeAction(w: Borsh, a: Action): void {
  switch (a.kind) {
    case "createAccount":
      w.u8(0);
      return;
    case "deployContract":
      w.u8(1);
      w.bytes(a.code);
      return;
    case "functionCall":
      w.u8(2);
      w.string(a.method);
      w.bytes(a.args);
      w.u64(a.gas);
      w.u128(a.deposit);
      return;
    case "transfer":
      w.u8(3);
      w.u128(a.deposit);
      return;
  }
}

/** Borsh of a `Transaction` (V0), as nearcore hashes and signs it. */
export function encodeTransaction(tx: Transaction): Buffer {
  if (tx.blockHash.length !== 32 || tx.publicKey.length !== 32) throw new Error("block hash and key are 32 bytes");
  if (tx.actions.length === 0) throw new Error("a transaction carries at least one action");
  const w = new Borsh();
  w.string(tx.signer);
  w.u8(0); // ed25519
  w.fixed(tx.publicKey);
  w.u64(tx.nonce);
  w.string(tx.receiver);
  w.fixed(tx.blockHash);
  w.u32(tx.actions.length);
  for (const a of tx.actions) writeAction(w, a);
  return w.done();
}

const asTransaction = (tx: Transaction | FunctionCallTx): Transaction =>
  "actions" in tx
    ? tx
    : {
        signer: tx.signer,
        publicKey: tx.publicKey,
        nonce: tx.nonce,
        receiver: tx.receiver,
        blockHash: tx.blockHash,
        actions: [{ kind: "functionCall", method: tx.method, args: tx.args, gas: tx.gas, deposit: tx.deposit }],
      };

/** Borsh of a transaction with one `FunctionCall` action. */
export function encodeTx(tx: FunctionCallTx): Buffer {
  return encodeTransaction(asTransaction(tx));
}

/** The signed transaction, base64 for `send_tx`, and its hash. */
export function signTx(tx: Transaction | FunctionCallTx, key: NearKey): { hash: string; base64: string } {
  const body = encodeTransaction(asTransaction(tx));
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
  readonly #fetch: typeof fetch;

  /** `fetchImpl` stands in for the network: a recording or its replay (test/tape.ts). */
  constructor(url: string, timeoutMs = 60_000, fetchImpl: typeof fetch = fetch) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.#fetch = fetchImpl;
  }

  async rpc(method: string, params: unknown): Promise<unknown> {
    const res = await this.#fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "maskwars", method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = (await res.json()) as { result?: unknown; error?: { name?: string; cause?: { name?: string }; data?: unknown } };
    if (body.error) {
      const e = body.error;
      throw new RpcError(`${method}: ${e.cause?.name ?? e.name ?? "error"} ${typeof e.data === "string" ? e.data : JSON.stringify(e.data ?? "")}`);
    }
    return body.result;
  }
}

/** The chain answered, and the answer is an error: another endpoint would answer the same. */
export class RpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcError";
  }
}

/**
 * Several endpoints, the first preferred: a request goes to the next one only when an endpoint does not answer at all
 * (the network, a timeout, a page that is not JSON-RPC). An answer that is an error is the chain's and is not asked
 * again elsewhere. A signed transaction sent again elsewhere is the same transaction: it lands once.
 */
export class FailoverRpc implements Chain {
  readonly #chains: readonly Chain[];

  constructor(chains: readonly Chain[]) {
    if (chains.length === 0) throw new Error("at least one endpoint");
    this.#chains = chains;
  }

  async rpc(method: string, params: unknown): Promise<unknown> {
    let last: unknown;
    for (const c of this.#chains) {
      try {
        return await c.rpc(method, params);
      } catch (e) {
        if (e instanceof RpcError) throw e;
        last = e;
      }
    }
    throw last;
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
 * Signs a transaction of `actions` to `receiver` as `signer` with `key` and waits for the result. `waitUntil` FINAL
 * waits for every receipt; INCLUDED_FINAL only for the transaction to be in a final block.
 */
export async function send(
  chain: Chain,
  signer: string,
  key: NearKey,
  receiver: string,
  actions: readonly Action[],
  waitUntil: "FINAL" | "INCLUDED_FINAL" = "FINAL",
): Promise<CallResult> {
  const access = (await chain.rpc("query", {
    request_type: "view_access_key",
    finality: "final",
    account_id: signer,
    public_key: key.publicKeyText,
  })) as { nonce?: number | string; block_hash?: string; error?: string };
  // A node answers a key the account does not hold with an `error` inside the result, not as an RPC error.
  if (access.nonce === undefined || access.block_hash === undefined) {
    throw new RpcError(`view_access_key: AccessKeyNotFound: ${signer} holds no key ${key.publicKeyText}${access.error ? ` (${access.error})` : ""}`);
  }
  const tx: Transaction = {
    signer,
    publicKey: key.publicKey,
    nonce: BigInt(access.nonce) + 1n,
    receiver,
    blockHash: base58Decode(access.block_hash),
    actions,
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

/** Whether `account` holds `key` now: a node answers a missing key inside the result, so this reads that answer. */
export async function holdsKey(chain: Chain, account: string, key: NearKey): Promise<boolean> {
  const k = (await chain.rpc("query", {
    request_type: "view_access_key",
    finality: "final",
    account_id: account,
    public_key: key.publicKeyText,
  })) as { nonce?: unknown };
  return k.nonce !== undefined;
}

/** Signs `method(args)` on `receiver` as `signer` with `key`, no deposit, and waits for the result (`send`). */
export function call(
  chain: Chain,
  signer: string,
  key: NearKey,
  receiver: string,
  method: string,
  args: object,
  gasTgas: number,
  waitUntil: "FINAL" | "INCLUDED_FINAL" = "FINAL",
): Promise<CallResult> {
  return send(chain, signer, key, receiver, [functionCall(method, args, gasTgas)], waitUntil);
}
