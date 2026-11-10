import { describe, expect, it } from "vitest";
import { maskAccounts, onThisNetwork } from "../src/net.ts";

// The tests run on testnet, the default network.
describe("a job on one network", () => {
  it("takes the accounts of its network and refuses the other's", () => {
    expect(onThisNetwork("SEASON", "season.tinygif8324.testnet")).toBe("season.tinygif8324.testnet");
    expect(() => onThisNetwork("SEASON", "season.maskwars.near")).toThrow("SEASON: season.maskwars.near is not a testnet account");
  });

  it("knows the arena's own masks without MASK_ACCOUNTS, and checks the variable when it is set", () => {
    expect(maskAccounts(undefined)).toEqual({ NOVA: "nova.tinygif8324.testnet", ONYX: "onyx.tinygif8324.testnet", ORACLE: "oracle.tinygif8324.testnet" });
    expect(maskAccounts('{"NOVA":"nova.tinygif8324.testnet"}')).toEqual({ NOVA: "nova.tinygif8324.testnet" });
    expect(() => maskAccounts('{"NOVA":"nova.maskwars.near"}')).toThrow("MASK_ACCOUNTS.NOVA");
  });
});
