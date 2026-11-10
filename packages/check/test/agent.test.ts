import { describe, expect, it, vi } from "vitest";
import { type Guard, type PaymentIntent, accountsInCall, guardedPay, keyRefusal, readKeyScope } from "../src/agent.ts";
import type { CheckResult, Verdict } from "../src/check.ts";
import { ChainReader, type KeyPermission } from "../src/rpc.ts";
import { CODE_A, FakeNode } from "./chain.ts";

const WALLET = "agent-wallet.tinygif8324.testnet";
const KEY: KeyPermission = { kind: "function_call", receiver: WALLET, methods: ["pay"], allowance: "250000000000000000000000" };

const intent = (over: Partial<PaymentIntent["call"]> = {}): PaymentIntent => ({
  payee: "safe-0001.tinygif8324.testnet",
  amount: "2000000000000000000000000",
  call: { contract: WALLET, method: "pay", args: { receiver: "safe-0001.tinygif8324.testnet", amount: "2000000000000000000000000" }, deposit: "0", gas: "30000000000000", ...over },
  why: "the invoice says so",
});

function result(verdict: Verdict): CheckResult {
  return {
    account: "safe-0001.tinygif8324.testnet",
    network: "testnet",
    verdict,
    summary: verdict === "allow" ? "No signals against this account were found." : `${verdict.toUpperCase()}: reason`,
    reasons: verdict === "allow" ? [] : [{ code: "arena_drained", level: verdict, text: "reason" }],
    block: { height: 1, hash: "h", time: "2026-11-06T00:00:00Z" },
    checked_at: "2026-11-06T00:00:00Z",
    rpc: [],
  };
}

function guard(verdict: Verdict, human: boolean | Error = false, key: KeyPermission = KEY) {
  const sign = vi.fn(async () => "TxHash111");
  const askHuman = vi.fn(async () => {
    if (human instanceof Error) throw human;
    return human;
  });
  const check = vi.fn(async () => result(verdict));
  const lines: string[] = [];
  const g: Guard = { key, check, askHuman, sign, log: (l) => lines.push(l) };
  return { g, sign, askHuman, check, lines };
}

describe("guardedPay", () => {
  it("block: refuses and never calls the signer", async () => {
    const { g, sign, askHuman, check, lines } = guard("block", true);
    const out = await guardedPay(intent(), g);
    expect(out).toMatchObject({ status: "refused", by: "block" });
    expect(check).toHaveBeenCalledWith("safe-0001.tinygif8324.testnet");
    expect(askHuman).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(lines.at(-1)).toBe("REFUSED block: nothing was signed");
  });

  it("warn: asks a person and refuses on no", async () => {
    const { g, sign, askHuman } = guard("warn", false);
    expect(await guardedPay(intent(), g)).toMatchObject({ status: "refused", by: "human" });
    expect(askHuman).toHaveBeenCalledOnce();
    expect(sign).not.toHaveBeenCalled();
  });

  it("warn: a person who cannot be reached is a no", async () => {
    const { g, sign } = guard("warn", new Error("no TTY"));
    expect(await guardedPay(intent(), g)).toMatchObject({ status: "refused", by: "human" });
    expect(sign).not.toHaveBeenCalled();
  });

  it("warn: signs after a person says yes", async () => {
    const { g, sign } = guard("warn", true);
    expect(await guardedPay(intent(), g)).toMatchObject({ status: "signed", tx: "TxHash111", verdict: "warn" });
    expect(sign).toHaveBeenCalledOnce();
  });

  it("allow: signs without asking", async () => {
    const { g, sign, askHuman } = guard("allow");
    expect(await guardedPay(intent(), g)).toMatchObject({ status: "signed", verdict: "allow" });
    expect(askHuman).not.toHaveBeenCalled();
    expect(sign).toHaveBeenCalledWith(intent().call);
  });

  it("a check that fails or hangs is a refusal", async () => {
    const { g, sign } = guard("allow");
    g.check = async () => {
      throw new Error("ECONNRESET");
    };
    expect(await guardedPay(intent(), g)).toMatchObject({ status: "refused", by: "check_failed" });
    g.check = () => new Promise(() => {});
    g.checkTimeoutMs = 20;
    expect(await guardedPay(intent(), g)).toMatchObject({ status: "refused", by: "check_failed", reason: expect.stringContaining("no answer") });
    expect(sign).not.toHaveBeenCalled();
  });

  it("refuses a full-access key before asking anything", async () => {
    const { g, sign, check } = guard("allow", true, { kind: "full_access" });
    expect(await guardedPay(intent(), g)).toMatchObject({ status: "refused", by: "key", reason: "the agent never signs with a full-access key" });
    expect(check).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  });

  it("refuses a call outside the key's one contract", async () => {
    const { g, sign } = guard("allow");
    const out = await guardedPay(intent({ contract: "safe-0001.tinygif8324.testnet" }), g);
    expect(out).toMatchObject({ status: "refused", by: "key", reason: `the key is scoped to ${WALLET}, not safe-0001.tinygif8324.testnet` });
    expect(sign).not.toHaveBeenCalled();
  });

  it("refuses a call that does not pay the payee it states", async () => {
    const { g, sign, check } = guard("allow");
    const lie = { ...intent(), payee: "acme-invoices.testnet" };
    const out = await guardedPay(lie, g);
    expect(out).toMatchObject({ status: "refused", by: "call", reason: "the call does not pay acme-invoices.testnet: it names safe-0001.tinygif8324.testnet" });
    expect(check).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  });

  it("checks every account the call names and lets the worst answer decide", async () => {
    const { g, sign } = guard("allow");
    const seen: string[] = [];
    g.check = async (account) => {
      seen.push(account);
      return { ...result(account === "safe-0001.tinygif8324.testnet" ? "block" : "allow"), account };
    };
    const split: PaymentIntent = {
      ...intent(),
      payee: "acme-invoices.testnet",
      call: { ...intent().call, args: { receiver: "acme-invoices.testnet", refund_to: { account: "safe-0001.tinygif8324.testnet" } } },
    };
    const out = await guardedPay(split, g);
    expect(seen).toEqual(["acme-invoices.testnet", "safe-0001.tinygif8324.testnet"]);
    expect(out).toMatchObject({ status: "refused", by: "block", check: { account: "safe-0001.tinygif8324.testnet" } });
    expect(sign).not.toHaveBeenCalled();
  });
});

describe("accountsInCall", () => {
  it("finds accounts anywhere in the arguments and skips amounts and words", () => {
    const call = {
      ...intent().call,
      args: { receiver: "bob.testnet", amount: "2000000000000000000000000", memo: "invoice", hops: ["a.testnet", { to: "0x" + "ab".repeat(20) }], n: 5 },
    };
    expect(accountsInCall(call)).toEqual(["bob.testnet", "a.testnet", "0x" + "ab".repeat(20)]);
  });
});

describe("keyRefusal", () => {
  it("allows only the key's contract and methods, with no deposit", () => {
    expect(keyRefusal(KEY, intent().call)).toBeNull();
    expect(keyRefusal(KEY, intent({ method: "withdraw" }).call)).toBe("the key may call pay, not withdraw");
    expect(keyRefusal(KEY, intent({ deposit: "1" }).call)).toBe("a function-call key cannot attach a deposit");
    expect(keyRefusal({ ...KEY, methods: [] }, intent({ method: "anything" }).call)).toBeNull();
  });
});

describe("readKeyScope", () => {
  it("reads the agent's key from the chain and refuses a key the account does not have", async () => {
    const n = new FakeNode().setAccount(WALLET, 1, { amount: "1", code_hash: CODE_A, storage_usage: 1 });
    n.keys.set(`${WALLET}/ed25519:agent`, { FunctionCall: { allowance: null, receiver_id: WALLET, method_names: ["pay"] } });
    const r = new ChainReader({ fetch: n.fetch, endpoints: ["https://a.example"] });
    expect(await readKeyScope(r, WALLET, "ed25519:agent")).toEqual({ kind: "function_call", receiver: WALLET, methods: ["pay"], allowance: null });
    await expect(readKeyScope(r, WALLET, "ed25519:other")).rejects.toThrow(/has no key/);
  });
});
