import { describe, expect, it } from "vitest";
import { forgeAction, outcome, readPending, RECORD_STORAGE, tank } from "../src/forge.ts";
import { nearText, parseNear, YOCTO } from "../src/near.ts";

describe("forge", () => {
  it("asks the wallet for one call with the deposit attached", () => {
    const a = forgeAction({ look: "porcelain", model: "Qwen/Qwen3.8-27B", style: "cunning", strategy: null, name: "kira", fuel: 2n * YOCTO });
    expect(a).toEqual({
      type: "FunctionCall",
      params: {
        methodName: "forge",
        args: { name: "kira", look: "porcelain", model: "Qwen/Qwen3.8-27B", style: "cunning", strategy: null, race_limit: null, copy_of: null, copy_bps: null },
        gas: "100000000000000",
        deposit: "2000000000000000000000000",
      },
    });
  });

  it("forges a copy with its author, the share the person saw, and no strategy of its own", () => {
    const a = forgeAction({ look: "porcelain", model: "Qwen/Qwen3.8-27B", style: "cunning", strategy: "v1.box", name: "nina", fuel: 2n * YOCTO, copyOf: "kira", copyBps: 3000 });
    expect(a.params.args).toEqual({ name: "nina", look: "porcelain", model: "Qwen/Qwen3.8-27B", style: "cunning", strategy: null, race_limit: null, copy_of: "kira", copy_bps: 3000 });
  });

  it("never forges a copy without the share the person agreed to", () => {
    expect(() => forgeAction({ look: "porcelain", model: "Qwen/Qwen3.8-27B", style: "cunning", strategy: null, name: "nina", fuel: 2n * YOCTO, copyOf: "kira" })).toThrow(/share/);
  });

  it("carries no copy when none is asked", () => {
    const a = forgeAction({ look: "porcelain", model: "Qwen/Qwen3.8-27B", style: "cunning", strategy: "v1.box", name: "kira", fuel: YOCTO, copyBps: 3000 });
    expect(a.params.args).toMatchObject({ copy_of: null, copy_bps: null, strategy: "v1.box" });
  });

  it("counts the races the tank pays for at the least", () => {
    const fund = 300n * (YOCTO / 1000n);
    const limit = 50n * (YOCTO / 1000n);
    expect(tank(2n * YOCTO, fund, limit)).toEqual({ brain: 2n * YOCTO - fund - RECORD_STORAGE, races: 33 });
    expect(tank(YOCTO, fund, limit).races).toBe(13);
    expect(tank(YOCTO / 10n, fund, limit)).toEqual({ brain: 0n, races: 0 });
  });

  it("reads and writes NEAR", () => {
    expect(parseNear("2")).toBe(2n * YOCTO);
    expect(parseNear("0.05")).toBe(YOCTO / 20n);
    expect(parseNear("1.5e3")).toBeNull();
    expect(nearText(2n * YOCTO)).toBe("2");
    expect(nearText(1_685_000_000_000_000_000_000_000n)).toBe("1.68");
    expect(nearText("50000000000000000000000")).toBe("0.05");
  });

  it("calls a mask forged only when the person who signed owns it", () => {
    const mask = (owner: string, state = "ready") => ({ owner, state });
    expect(outcome(mask("ann.testnet"), "ann.testnet")).toBe("mine");
    expect(outcome(mask("ann.testnet", "forging"), "ann.testnet")).toBe("forging");
    // Someone forged the name between the check and the signature: the page must not show it as hers.
    expect(outcome(mask("bob.testnet"), "ann.testnet")).toBe("theirs");
    expect(outcome(null, "ann.testnet")).toBe("none");
  });

  it("resumes only a forge it knows the signer of", () => {
    expect(readPending(JSON.stringify({ name: "kira", account: "ann.testnet" }))).toEqual({ name: "kira", account: "ann.testnet" });
    expect(readPending("kira")).toBeNull();
    expect(readPending(JSON.stringify({ name: "kira" }))).toBeNull();
    expect(readPending(null)).toBeNull();
  });
});
