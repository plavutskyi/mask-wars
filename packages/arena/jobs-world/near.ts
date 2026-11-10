/**
 * Just enough NEAR to drive the local sandbox from TypeScript with nothing but `node:crypto`: ed25519 keys as NEAR
 * writes them, the Borsh layout of a transaction with the actions the sandbox needs (create an account, send NEAR, add
 * a key, call a function), and JSON-RPC. Sandbox only: the keys it signs with are throwaway keys of a local chain.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

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

/** An ed25519 key from `ed25519:<base58 of the seed and the public key>`. */
export class Key {
  readonly publicKey: Uint8Array;
  readonly #key: KeyObject;

  constructor(secret: string) {
    const [curve, body] = secret.trim().split(":");
    if (curve !== "ed25519" || !body) throw new Error("a NEAR secret key is ed25519:<base58>");
    const raw = base58Decode(body);
    this.#key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, raw.subarray(0, 32)]), format: "der", type: "pkcs8" });
    this.publicKey = new Uint8Array(createPublicKey(this.#key).export({ format: "der", type: "spki" }).subarray(12));
  }

  /** A fresh key, in the form NEAR tools write. */
  static random(): { secret: string; key: Key } {
    const { privateKey } = generateKeyPairSync("ed25519");
    const seed = Buffer.from(privateKey.export({ format: "jwk" }).d ?? "", "base64url");
    const pub = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(12);
    const secret = `ed25519:${base58Encode(Buffer.concat([seed, pub]))}`;
    return { secret, key: new Key(secret) };
  }

  get publicKeyText(): string {
    return `ed25519:${base58Encode(this.publicKey)}`;
  }

  sign(message: Uint8Array): Uint8Array {
    return new Uint8Array(sign(null, message, this.#key));
  }
}

export type Action =
  | { kind: "create_account" }
  | { kind: "transfer"; deposit: bigint }
  | { kind: "add_key"; publicKey: Uint8Array; access: "full" | { receiver: string; methods: string[]; allowance: bigint | null } }
  | { kind: "call"; method: string; args: unknown; gas: bigint; deposit: bigint };

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

function action(w: Borsh, a: Action) {
  switch (a.kind) {
    case "create_account":
      w.u8(0);
      return;
    case "call":
      w.u8(2);
      w.string(a.method);
      w.bytes(Buffer.from(JSON.stringify(a.args)));
      w.u64(a.gas);
      w.u128(a.deposit);
      return;
    case "transfer":
      w.u8(3);
      w.u128(a.deposit);
      return;
    case "add_key":
      w.u8(5);
      w.u8(0);
      w.fixed(a.publicKey);
      w.u64(0n);
      if (a.access === "full") {
        w.u8(1);
      } else {
        w.u8(0);
        if (a.access.allowance === null) w.u8(0);
        else {
          w.u8(1);
          w.u128(a.access.allowance);
        }
        w.string(a.access.receiver);
        w.u32(a.access.methods.length);
        for (const m of a.access.methods) w.string(m);
      }
      return;
  }
}

export class Rpc {
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  async call<T = Record<string, unknown>>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "sandbox", method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json()) as { result?: T; error?: unknown };
    if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
    return json.result as T;
  }

  async view<T>(contract: string, method: string, args: unknown = {}): Promise<T> {
    const r = await this.call<{ result: number[] }>("query", {
      request_type: "call_function",
      finality: "final",
      account_id: contract,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    return JSON.parse(Buffer.from(r.result).toString("utf8")) as T;
  }

  /** Moves sandbox time on by `blocks` blocks, about a second each. */
  async fastForward(blocks: number): Promise<void> {
    await this.call("sandbox_fast_forward", { delta_height: blocks }, 120_000);
  }

  async now(): Promise<bigint> {
    const b = await this.call<{ header: { timestamp_nanosec: string } }>("block", { finality: "final" });
    return BigInt(b.header.timestamp_nanosec);
  }
}

export interface Outcome {
  hash: string;
  ok: boolean;
  /** The decoded return value of the transaction's own call, if any. */
  value: unknown;
  logs: string[];
  failure: unknown;
}

/**
 * Signs `actions` from `signer` with `key` to `receiver` and waits for the outcome. With `wait: false` it returns once the
 * transaction is sent: for a call that waits on someone else, like a judge run that waits for the judge's answer.
 */
export async function send(rpc: Rpc, signer: string, key: Key, receiver: string, actions: Action[], wait = true): Promise<Outcome> {
  const pk = key.publicKeyText;
  const access = await rpc.call<{ nonce: number }>("query", { request_type: "view_access_key", finality: "final", account_id: signer, public_key: pk });
  const block = await rpc.call<{ header: { hash: string } }>("block", { finality: "final" });
  const w = new Borsh();
  w.string(signer);
  w.u8(0);
  w.fixed(key.publicKey);
  w.u64(BigInt(access.nonce) + 1n);
  w.string(receiver);
  w.fixed(base58Decode(block.header.hash));
  w.u32(actions.length);
  for (const a of actions) action(w, a);
  const tx = w.done();
  const hash = createHash("sha256").update(tx).digest();
  const signed = Buffer.concat([tx, Buffer.from([0]), Buffer.from(key.sign(hash))]);
  if (!wait) {
    await rpc.call("send_tx", { signed_tx_base64: signed.toString("base64"), wait_until: "NONE" });
    return { hash: base58Encode(hash), ok: true, value: null, logs: [], failure: null };
  }
  const r = await rpc.call<{
    status: { SuccessValue?: string; Failure?: unknown };
    transaction: { hash: string };
    receipts_outcome: { outcome: { logs: string[]; status: { Failure?: unknown } } }[];
  }>("send_tx", { signed_tx_base64: signed.toString("base64"), wait_until: "FINAL" }, 120_000);
  const failure = r.status.Failure ?? null;
  let value: unknown = null;
  if (typeof r.status.SuccessValue === "string" && r.status.SuccessValue) {
    try {
      value = JSON.parse(Buffer.from(r.status.SuccessValue, "base64").toString("utf8"));
    } catch {
      value = null;
    }
  }
  return { hash: r.transaction.hash, ok: !failure, value, logs: r.receipts_outcome.flatMap((o) => o.outcome.logs), failure };
}

export const TGAS = 1_000_000_000_000n;
export const NEAR = 10n ** 24n;
