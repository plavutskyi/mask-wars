import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "../src/chain.ts";
import { allowCopyAction, copyEarnings, GAS_FUND, parseTerms, payAuthorAction, readWithdraw, stopCopyAction, takeOut, times, timesText, waitingChange, waitText, withdrawAction, withdrawn, type TxOutcome } from "../src/owner.ts";
import { YOCTO } from "../src/near.ts";

const HOUR = 3_600_000;
const ms = (n: number) => (BigInt(n) * 1_000_000n).toString();

function cfg(masks: number, kind: string, extra: Record<string, string> = {}): FactoryConfig {
  return {
    masks,
    pending: { change: { kind, ...extra }, proposed_ns: ms(0), notice_ns: ms(HOUR), ready_ns: ms(72 * HOUR) },
  } as unknown as FactoryConfig;
}

describe("a change of the factory that waits", () => {
  it("names the change and the moment anyone may apply it: an hour before the first mask, three days after", () => {
    expect(waitingChange(cfg(0, "keeper", { account: "keeper.testnet" }), 0)).toEqual({ what: "New keeper, keeper.testnet", at: HOUR });
    expect(waitingChange(cfg(3, "code", { sha256: "72912cfe27b9cd5d" }), 0)).toEqual({ what: "New factory code 72912cfe…", at: 72 * HOUR });
    expect(waitingChange(cfg(3, "strategy_key", { key: "x25519:00" }), 0)?.what).toBe("A new key for the mind");
    const teams = { masks: 1, pending: { change: { kind: "teams", accounts: ["team.testnet", "season.testnet"] }, proposed_ns: ms(0), notice_ns: ms(HOUR), ready_ns: ms(72 * HOUR) } };
    expect(waitingChange(teams as unknown as FactoryConfig, 0)).toEqual({ what: "New teams, team.testnet, season.testnet", at: 72 * HOUR });
  });

  it("shows nothing once the change lapsed, a day after it was ready, or when none waits", () => {
    expect(waitingChange(cfg(3, "code"), 96 * HOUR)).toBeNull();
    expect(waitingChange(cfg(3, "code"), 95 * HOUR)).not.toBeNull();
    expect(waitingChange({ masks: 1, pending: null } as unknown as FactoryConfig, 0)).toBeNull();
  });

  it("says how long it still waits", () => {
    expect(waitText(71 * HOUR + 1)).toBe("2 d 23 h");
    expect(waitText(5 * HOUR + 12 * 60_000)).toBe("5 h 12 min");
    expect(waitText(60_000)).toBe("1 min");
    expect(waitText(0)).toBe("now");
  });
});

describe("what the owner takes out", () => {
  it("is everything above the account's storage and the gas fund, as the mask's withdraw pays", () => {
    const storage = 300;
    const amount = (2n * YOCTO + GAS_FUND + BigInt(storage) * 10n ** 19n).toString();
    expect(takeOut({ amount, storage_usage: storage })).toBe(2n * YOCTO);
    expect(takeOut({ amount: GAS_FUND.toString(), storage_usage: storage })).toBe(0n);
    expect(takeOut(null)).toBe(0n);
  });

  it("is one call on the mask's own account, no NEAR attached", () => {
    expect(withdrawAction()).toEqual({ type: "FunctionCall", params: { methodName: "withdraw", args: {}, gas: "30000000000000", deposit: "0" } });
  });
});

describe("the ×", () => {
  it("is earned over everything put in", () => {
    expect(times(29n * YOCTO / 10n, 2n * YOCTO)).toBe(1.45);
    expect(times(0n, 2n * YOCTO)).toBe(0);
    expect(times(1n, 0n)).toBeNull();
    expect([timesText(1.45), timesText(12.34), timesText(0), timesText(null)]).toEqual(["×1.45", "×12.3", "×0", "×—"]);
  });
});

describe("a take-out counts only once NEAR confirms it", () => {
  const OWNER = "ann.testnet";
  const KIRA = "kira.masks.tinygif8324.testnet";
  const ok = { SuccessValue: "" };
  const tx = (o: Partial<TxOutcome> = {}): TxOutcome => ({
    status: ok,
    transaction: { signer_id: OWNER, receiver_id: KIRA },
    receipts_outcome: [
      { outcome: { executor_id: KIRA, logs: [`withdraw 1902000000000000000000000 to ${OWNER}`], status: { SuccessReceiptId: "r" } } },
      { outcome: { executor_id: OWNER, logs: [], status: ok } },
    ],
    ...o,
  });

  it("reads the amount from the mask's own log, once every receipt went through", () => {
    expect(readWithdraw(tx(), OWNER, KIRA)).toEqual({ state: "done", amount: 1902000000000000000000000n });
  });

  /** The review's finding 6: the page said "Taken out" with its own figure as soon as the wallet answered. */
  it("is no success when the wallet answered but the chain did not move the prize", () => {
    expect(readWithdraw(tx({ status: { Failure: { ActionError: {} } } }), OWNER, KIRA)).toEqual({ state: "failed" });
    const cut = tx().receipts_outcome!.map((r, i) => (i === 1 ? { outcome: { ...r.outcome, status: { Failure: {} } } } : r));
    expect(readWithdraw(tx({ receipts_outcome: cut }), OWNER, KIRA)).toEqual({ state: "failed" });
    // Not the mask's withdraw, or not to its owner: no amount to name.
    expect(readWithdraw(tx({ transaction: { signer_id: OWNER, receiver_id: "lena.masks.tinygif8324.testnet" } }), OWNER, KIRA)).toEqual({ state: "failed" });
    const other = tx().receipts_outcome!.map((r, i) => (i === 0 ? { outcome: { ...r.outcome, logs: ["withdraw 5 to bob.testnet"] } } : r));
    expect(readWithdraw(tx({ receipts_outcome: other }), OWNER, KIRA)).toEqual({ state: "failed" });
    expect(readWithdraw(tx({ status: {} }), OWNER, KIRA)).toEqual({ state: "unknown" });
  });

  it("asks NEAR for the transaction at the final block, and knows nothing while no RPC has it", async () => {
    const asked: unknown[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      asked.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" } } }));
    }) as typeof fetch;
    try {
      const net = { id: "testnet", factory: "masks.tinygif8324.testnet", rpcs: ["https://a", "https://b"], explorer: "" };
      expect(await withdrawn(net as never, "Hash1", OWNER, KIRA)).toEqual({ state: "unknown" });
    } finally {
      globalThis.fetch = real;
    }
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatchObject({ method: "tx", params: { tx_hash: "Hash1", sender_account_id: OWNER, wait_until: "FINAL" } });
  });
});

describe("confidential copying actions", () => {
  it("opens a mask to copying, closes it, and pays the author", () => {
    const allow = allowCopyAction("kira", 3000);
    expect(allow.params).toMatchObject({ methodName: "allow_copy", args: { name: "kira", author_bps: 3000 } });
    expect(BigInt(allow.params.deposit)).toBeGreaterThan(0n);
    expect(stopCopyAction("kira").params).toMatchObject({ methodName: "stop_copy", args: { name: "kira" }, deposit: "0" });
    expect(payAuthorAction().params).toMatchObject({ methodName: "pay_author", args: {}, deposit: "0" });
  });

  it("reads a copy's terms as the mask's own account writes them", () => {
    expect(parseTerms("kira.masks.testnet|3000|300|0|12|700")).toEqual({ author: "kira.masks.testnet", bps: 3000, paid: 300n, owed: 0n, due: 12n, owner: 700n });
    expect(parseTerms("")).toBeNull();
    expect(parseTerms("kira.masks.testnet|3000|300|0|12")).toBeNull();
    expect(parseTerms("kira.masks.testnet|3000|3e2|0|12|700")).toBeNull();
  });

  it("adds up what an author earned on its copies and what waits for it", () => {
    const t = (paid: bigint, owed: bigint, due: bigint) => ({ author: "kira.masks.testnet", bps: 3000, paid, owed, due, owner: 0n });
    expect(copyEarnings([t(300n, 0n, 0n), t(0n, 30n, 330n), null])).toEqual({ earned: 330n, due: 330n, waiting: 1 });
  });

  it("reads the owner's withdraw from a copy, beside the author's share in the same transaction", () => {
    const tx: TxOutcome = {
      status: { SuccessValue: "" },
      transaction: { signer_id: "bob.testnet", receiver_id: "nina.masks.testnet" },
      receipts_outcome: [
        { outcome: { executor_id: "nina.masks.testnet", logs: ["pay_author 300 to kira.masks.testnet", "withdraw 700 to bob.testnet"], status: { SuccessValue: "" } } },
        { outcome: { executor_id: "kira.masks.testnet", logs: [], status: { SuccessValue: "" } } },
        { outcome: { executor_id: "bob.testnet", logs: [], status: { SuccessValue: "" } } },
      ],
    };
    expect(readWithdraw(tx, "bob.testnet", "nina.masks.testnet")).toEqual({ state: "done", amount: 700n });
  });
});
