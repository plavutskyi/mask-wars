import { describe, expect, it } from "vitest";
import {
  base58Decode,
  base58Encode,
  call,
  createAccount,
  deployContract,
  encodeTransaction,
  encodeTx,
  functionCall,
  NearKey,
  send,
  signTx,
  transfer,
  type Action,
  type Chain,
} from "../src/near-tx.ts";

// Made once with near-api-js 5 (`createTransaction`, `functionCall`, `signTransaction`) from the same inputs: a
// throwaway key whose seed is 32 bytes of 7.
const SEED = Buffer.alloc(32, 7);
const SECRET = `ed25519:${base58Encode(Buffer.concat([SEED, base58Decode("GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB")]))}`;
const PUBLIC = "ed25519:GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB";
const HASH = "8GpRaE1naBGQB5JDHFk5bTK7UmxotgEZ6TinbVNB5zgU";
const SIGNED =
  "GAAAAG5vdmEudGlueWdpZjgzMjQudGVzdG5ldADqSmxj4pxSCr71UHsTLsX5lUd2rr6+e5JCHuppFEbSLBQamb4cAAAAHQAAAHNhZmUtMDAwMS50aW55Z2lmODMyNC50ZXN0bmV0JZeSHlORWntLKOV3wHDM4WiLUkIT1juOKeOFYSzQuFQBAAAAAgUAAABzd2VlcEYAAAB7InRvIjoibm92YS50aW55Z2lmODMyNC50ZXN0bmV0IiwiYW1vdW50IjoiMTUwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCJ9AOBX60gbAAAAAAAAAAAAAAAAAAAAAAAAAJn7g8kpG2uSfRigDNVcpNHzRsI9T9GqOhIiU4BXI2RePXfxMD+wJFGGJjRqMNPIuA//WjiV8gDNC+Qg3Ac55AM=";

const sweep = (key: NearKey) => ({
  signer: "nova.tinygif8324.testnet",
  publicKey: key.publicKey,
  nonce: 123456789012n,
  receiver: "safe-0001.tinygif8324.testnet",
  blockHash: base58Decode("3Xk8pQ2rT5vW9yB1cD4fG6hJ7kL8mN9oP1qR2sT3uV4w"),
  method: "sweep",
  args: Buffer.from('{"to":"nova.tinygif8324.testnet","amount":"1500000000000000000000000"}'),
  gas: 30_000_000_000_000n,
  deposit: 0n,
});

describe("a mask's transaction", () => {
  it("reads a NEAR secret key, 64 or 32 bytes, and knows its public half", () => {
    expect(new NearKey(SECRET).publicKeyText).toBe(PUBLIC);
    expect(new NearKey(`ed25519:${base58Encode(SEED)}`).publicKeyText).toBe(PUBLIC);
  });

  it("signs byte for byte as near-api-js does", () => {
    const key = new NearKey(SECRET);
    expect(signTx(sweep(key), key)).toEqual({ hash: HASH, base64: SIGNED });
  });

  it("carries the deposit as u128", () => {
    const key = new NearKey(SECRET);
    const body = encodeTx({ ...sweep(key), deposit: (1n << 100n) + 5n });
    expect(body.subarray(-16).toString("hex")).toBe("05000000000000000000000010000000");
  });

  it("refuses a key that is not ed25519 or does not match itself", () => {
    expect(() => new NearKey("secp256k1:abc")).toThrow("ed25519");
    const raw = base58Decode(SECRET.slice(8));
    raw[40] = raw[40]! ^ 1;
    expect(() => new NearKey(`ed25519:${base58Encode(raw)}`)).toThrow("does not match");
  });

  it("keeps leading zero bytes through base58", () => {
    const bytes = Uint8Array.from([0, 0, 1, 2, 255]);
    expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
  });
});

// The house's transactions (src/house.ts), made once with near-api-js 5.1.1 from the same inputs and the same throwaway
// key: `createTransaction` with `createAccount`, `transfer`, `deployContract` and `functionCall`, then
// `signTransaction`. The hash is the sha256 of the Borsh body, so one string checks every byte of the layout.
const HOUSE = "house.maskwars.near";
const VAULT = "vault.house.maskwars.near";
const BOUNTY = "bounty.maskwars.near";
const BLOCK = base58Decode("3Xk8pQ2rT5vW9yB1cD4fG6hJ7kL8mN9oP1qR2sT3uV4w");
/** Not a contract: eight bytes of a wasm header and 24 more, enough to see the length prefix. */
const CODE = Buffer.from(`0061736d01000000${"ab".repeat(24)}`, "hex");
const INIT = { owner: VAULT, masks: ["nova.maskwars.near", "onyx.maskwars.near", "oracle.maskwars.near"], arbiter: BOUNTY, team: HOUSE };
const SAFE_NEAR = 1_930_000_000_000_000_000_000_000n;
const DEPOSIT = 250_000_000_000_000_000_000_000n;

const CREATE = {
  hash: "CLY7bx5pDRGfzL9T71TRse3LuEGpTW4BpvdYaU6oV5q3",
  base64:
    "EwAAAGhvdXNlLm1hc2t3YXJzLm5lYXIA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iwUGpm+HAAAABkAAAB2YXVsdC5ob3VzZS5tYXNrd2Fycy5uZWFyJZeSHlORWntLKOV3wHDM4WiLUkIT1juOKeOFYSzQuFQEAAAAAAMAAEBiwBV4grGYAQAAAAAAASAAAAAAYXNtAQAAAKurq6urq6urq6urq6urq6urq6urq6urqwIDAAAAbmV3rgAAAHsib3duZXIiOiJ2YXVsdC5ob3VzZS5tYXNrd2Fycy5uZWFyIiwibWFza3MiOlsibm92YS5tYXNrd2Fycy5uZWFyIiwib255eC5tYXNrd2Fycy5uZWFyIiwib3JhY2xlLm1hc2t3YXJzLm5lYXIiXSwiYXJiaXRlciI6ImJvdW50eS5tYXNrd2Fycy5uZWFyIiwidGVhbSI6ImhvdXNlLm1hc2t3YXJzLm5lYXIifQDgV+tIGwAAAAAAAAAAAAAAAAAAAAAAAAC7qLNSib4BrKlI9sAJ5X7aock+jFIPfS+r4BIH0xKmwus0mL1iiyUfJWq0eWfe8F6SaHE9X7aVBp0Hu6Asbk8H",
};
const OPEN = {
  hash: "woaRaR9aabNAUbiCSP5qbyWAemtUH6PVB64EsZL2o4L",
  base64:
    "EwAAAGhvdXNlLm1hc2t3YXJzLm5lYXIA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iwVGpm+HAAAABQAAABib3VudHkubWFza3dhcnMubmVhciWXkh5TkVp7Syjld8BwzOFoi1JCE9Y7jinjhWEs0LhUAQAAAAIJAAAAb3Blbl9zYWZlNQAAAHsiaWQiOiJyYWNlLTAwMDIiLCJzYWZlIjoidmF1bHQuaG91c2UubWFza3dhcnMubmVhciJ9AEB6EPNaAAAAAEBoO7PzhvA0AAAAAAAAAAGLg+KQirYCGfJeluhCc/N/3ClPJzlhlwz85UjlX8aHDXqCJp5M0vkfYrSKLXmiu8zSf3i7YpoOtT0FksbJ6AE=",
};
const RETIRE = {
  hash: "7V7ca8mCMZhz1riy4xuvXj5XwdEehXC4QDVttWqzibts",
  base64:
    "EwAAAGhvdXNlLm1hc2t3YXJzLm5lYXIA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iwWGpm+HAAAABkAAAB2YXVsdC5ob3VzZS5tYXNrd2Fycy5uZWFyJZeSHlORWntLKOV3wHDM4WiLUkIT1juOKeOFYSzQuFQBAAAAAgYAAAByZXRpcmUCAAAAe30AwK/WkTYAAAAAAAAAAAAAAAAAAAAAAAAAWyezKwxg6zUDesHN9Qa6k5gabYBc7AbOQg6gwfUkxaF4bZErT2mXNcW+hyJuhwCriyxjXkCZ+b5ZNrU1TdvEAw==",
};

const houseTx = (key: NearKey, receiver: string, nonce: bigint, actions: readonly Action[]) => ({
  signer: HOUSE,
  publicKey: key.publicKey,
  nonce,
  receiver,
  blockHash: BLOCK,
  actions,
});
const makeSafe = [createAccount(), transfer(SAFE_NEAR), deployContract(CODE), functionCall("new", INIT, 30)];

describe("the house's transaction", () => {
  const key = new NearKey(SECRET);

  it("makes an account, funds it, deploys code and calls new in one transaction, byte for byte as near-api-js does", () => {
    expect(signTx(houseTx(key, VAULT, 123456789012n, makeSafe), key)).toEqual(CREATE);
  });

  it("carries a deposit on a function call, byte for byte as near-api-js does", () => {
    const open = [functionCall("open_safe", { id: "race-0002", safe: VAULT }, 100, DEPOSIT)];
    expect(signTx(houseTx(key, BOUNTY, 123456789013n, open), key)).toEqual(OPEN);
    expect(signTx(houseTx(key, VAULT, 123456789014n, [functionCall("retire", {}, 60)]), key)).toEqual(RETIRE);
  });

  // The layout read back by hand, independent of the vectors above: each action starts with nearcore's number for it.
  it("writes each action under its own number, in order, and no key anywhere", () => {
    const body = encodeTransaction(houseTx(key, VAULT, 1n, makeSafe));
    // signer, key type and key, nonce, receiver, block hash
    let at = 4 + HOUSE.length + 1 + 32 + 8 + 4 + VAULT.length + 32;
    expect(body.readUInt32LE(at)).toBe(4);
    at += 4;
    expect(body[at]).toBe(0); // CreateAccount: nothing else
    at += 1;
    expect(body[at]).toBe(3); // Transfer: u128, little-endian
    expect(body.readBigUInt64LE(at + 1) + (body.readBigUInt64LE(at + 9) << 64n)).toBe(SAFE_NEAR);
    at += 17;
    expect(body[at]).toBe(1); // DeployContract: the code with its length
    expect(body.readUInt32LE(at + 1)).toBe(CODE.length);
    expect(body.subarray(at + 5, at + 5 + CODE.length)).toEqual(CODE);
    at += 5 + CODE.length;
    expect(body[at]).toBe(2); // FunctionCall: method, args, gas, deposit
    expect(body.subarray(at + 5, at + 8).toString()).toBe("new");
    const args = body.readUInt32LE(at + 8);
    expect(JSON.parse(body.subarray(at + 12, at + 12 + args).toString())).toEqual(INIT);
    at += 12 + args;
    expect(body.readBigUInt64LE(at)).toBe(30_000_000_000_000n);
    expect(body.subarray(at + 8)).toEqual(Buffer.alloc(16));
    // Nothing follows: the account is born without a key (AddKey would be action 5).
    expect(at + 24).toBe(body.length);
  });

  it("refuses an empty transaction and a number that does not fit", () => {
    expect(() => encodeTransaction(houseTx(key, VAULT, 1n, []))).toThrow("at least one action");
    expect(() => encodeTransaction(houseTx(key, VAULT, 1n, [transfer(-1n)]))).toThrow("u128");
    expect(() => encodeTransaction(houseTx(key, VAULT, 1n, [transfer(1n << 128n)]))).toThrow("u128");
    expect(() => encodeTransaction(houseTx(key, VAULT, 1n << 64n, [transfer(1n)]))).toThrow("u64");
  });

  it("one function call reads the same either way", () => {
    const one = sweep(key);
    const many = { ...houseTx(key, one.receiver, one.nonce, [{ kind: "functionCall" as const, method: one.method, args: one.args, gas: one.gas, deposit: 0n }]), signer: one.signer };
    expect(encodeTransaction(many)).toEqual(encodeTx(one));
  });
});

describe("sending", () => {
  const key = new NearKey(SECRET);
  /** An RPC that takes the key's nonce and block hash from the chain and keeps what it was sent. */
  const chain = (status: unknown, receipts: unknown[] = []) => {
    const sent: string[] = [];
    const rpc: Chain = {
      rpc: async (method, params) => {
        if (method === "query") return { nonce: 123456789011, block_hash: "3Xk8pQ2rT5vW9yB1cD4fG6hJ7kL8mN9oP1qR2sT3uV4w" };
        sent.push((params as { signed_tx_base64: string }).signed_tx_base64);
        return { status, receipts_outcome: receipts };
      },
    };
    return { rpc, sent };
  };

  it("takes the next nonce and the block hash from the key on chain, and signs the same bytes", async () => {
    const c = chain({ SuccessValue: "" });
    const r = await send(c.rpc, HOUSE, key, VAULT, makeSafe);
    expect(r).toEqual({ hash: CREATE.hash, ok: true, logs: [] });
    expect(c.sent).toEqual([CREATE.base64]);
  });

  it("call is one function call with no deposit", async () => {
    const c = chain({ SuccessValue: Buffer.from('"ok"').toString("base64") });
    const r = await call(c.rpc, HOUSE, key, VAULT, "retire", {}, 60);
    expect(r.value).toBe("ok");
    const body = Buffer.from(c.sent[0]!, "base64");
    expect(body.subarray(0, -65).subarray(-16)).toEqual(Buffer.alloc(16));
  });

  it("says a failed action as a failure, with the logs of what ran", async () => {
    const failure = { ActionError: { index: 0, kind: { AccountAlreadyExists: { account_id: VAULT } } } };
    const c = chain({ Failure: failure }, [{ outcome: { status: { Failure: failure }, logs: ["a line"] } }]);
    const r = await send(c.rpc, HOUSE, key, VAULT, makeSafe);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("AccountAlreadyExists");
    expect(r.logs).toEqual(["a line"]);
  });
});
