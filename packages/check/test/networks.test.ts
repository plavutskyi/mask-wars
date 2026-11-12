import { describe, expect, it } from "vitest";
import { InvalidAccountError, maskCheck } from "../src/check.ts";
import { mainnetList, sharedList, sharedLists } from "../src/index.ts";
import { NETWORKS } from "@maskwars/network";
import { parseList, withArena } from "../src/list.ts";
import { NETWORK, endpointsFor, networkOf, readerFor } from "../src/network.ts";
import { MAINNET_RPCS, TESTNET_RPCS } from "../src/rpc.ts";

describe("the network an account names", () => {
  it("reads .testnet on testnet and everything else on mainnet, where the money is", () => {
    expect(networkOf("safe-0001.tinygif8324.testnet")).toBe("testnet");
    expect(networkOf("testnet")).toBe("testnet");
    expect(networkOf(" Alice.TESTNET ")).toBe("testnet");
    expect(networkOf("intents.near")).toBe("mainnet");
    expect(networkOf("a".repeat(64))).toBe("mainnet");
    expect(networkOf(`0x${"b".repeat(40)}`)).toBe("mainnet");
    expect(networkOf("aurora")).toBe("mainnet");
    expect(networkOf("game.hot.tg")).toBe("mainnet");
  });
});

describe("the reader of each network", () => {
  it("reads testnet with failover, as before, and mainnet from two providers that must agree", () => {
    const t = readerFor("testnet");
    expect(t.endpoints).toEqual(TESTNET_RPCS);
    expect(t.crossCheck).toBe(false);
    const m = readerFor("mainnet");
    expect(m.endpoints).toEqual(["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"]);
    expect(m.endpoints).toEqual(MAINNET_RPCS);
    expect(m.crossCheck).toBe(true);
    expect(NETWORK.mainnet.archival).toEqual({ "https://rpc.mainnet.fastnear.com": "https://archival-rpc.mainnet.fastnear.com" });
  });

  it("takes its endpoints from the environment when it names any", () => {
    const env = { MASKCHECK_RPC: "https://t.example", MASKCHECK_MAINNET_RPC: " https://m1.example , https://m2.example " };
    expect(endpointsFor("testnet", env)).toEqual(["https://t.example"]);
    expect(endpointsFor("mainnet", env)).toEqual(["https://m1.example", "https://m2.example"]);
    expect(endpointsFor("mainnet", { MASKCHECK_MAINNET_RPC: " , " })).toEqual(MAINNET_RPCS);
    expect(readerFor("mainnet", { env }).endpoints).toEqual(["https://m1.example", "https://m2.example"]);
  });
});

describe("one shared list per network", () => {
  it("has the testnet list as before and a mainnet list of the arena's mainnet safes", () => {
    expect(sharedList.network).toBe("testnet");
    expect(sharedLists.testnet).toBe(sharedList);
    expect(mainnetList).toMatchObject({ network: "mainnet", reports: [] });
    expect(mainnetList.arena.map((e) => e.safe)).toEqual(["safe-0001.maskwars.near"]);
    expect(sharedLists.mainnet).toBe(mainnetList);
  });

  it("refuses an account of the other network in a list", () => {
    const report = { level: "block", reason: "Swept a vault.", evidence: [{ kind: "url", url: "https://nearblocks.io/txns/x" }], reported_by: "maskwars", added: "2026-11-08" };
    expect(() => parseList({ ...mainnetList, reports: [{ ...report, account: "drainer.testnet" }] })).toThrow(/not a mainnet account/);
    expect(() => parseList({ ...sharedList, reports: [{ ...report, account: "drainer.near" }] })).toThrow(/not a testnet account/);
    expect(() =>
      parseList({ ...mainnetList, arena: [{ contract: "bounty.maskwars.testnet", race: "s0-0001", safe: "safe-0001.maskwars.near", owner_at_open: "safe-0001.maskwars.near", note: "x" }] }),
    ).toThrow(/not a mainnet account/);
    expect(parseList({ ...mainnetList, reports: [{ ...report, account: "drainer.near" }] }).reports).toHaveLength(1);
  });
});

describe("the house's vault in each list", () => {
  it("is the network's own vault, house and bounty contract wherever the network names the vault's code, and null elsewhere", () => {
    for (const network of ["testnet", "mainnet"] as const) {
      const net = NETWORKS[network];
      const vault = net.safe_code === null ? null : { contract: net.bounty, safe: net.vault, house: net.house };
      expect(sharedLists[network].vault ?? null).toEqual(vault);
    }
    expect(mainnetList.vault).toEqual({ contract: "bounty.maskwars.near", safe: "vault.house.maskwars.near", house: "house.maskwars.near" });
    expect(sharedList.vault).toBeNull();
  });

  it("must be the house's own sub-account, of the list's network, and never listed race by race", () => {
    const vault = { contract: "bounty.maskwars.near", safe: "vault.house.maskwars.near", house: "house.maskwars.near" };
    expect(parseList({ ...mainnetList, vault }).vault).toEqual(vault);
    expect(parseList({ ...mainnetList, vault: undefined }).vault).toBeUndefined();
    for (const safe of ["vault.maskwars.near", "a.vault.house.maskwars.near", "house.maskwars.near", "vaulthouse.maskwars.near"]) {
      expect(() => parseList({ ...mainnetList, vault: { ...vault, safe } })).toThrow(/not the house's own sub-account/);
    }
    expect(() => parseList({ ...mainnetList, vault: { ...vault, house: "house.maskwars.testnet", safe: "vault.house.maskwars.testnet" } })).toThrow(/not a mainnet account/);
    const race = { contract: vault.contract, race: "race-0012", safe: vault.safe, owner_at_open: vault.safe, note: "x" };
    expect(() => parseList({ ...mainnetList, vault, arena: [race] })).toThrow(/is the house's vault: its round is read from the chain/);
    expect(withArena(mainnetList, [{ contract: vault.contract, race: "race-0012", safe: vault.safe, by: "hand" }]).added).toEqual([]);
  });
});

describe("a check on the wrong network", () => {
  const reader = readerFor("mainnet", { fetch: (async () => { throw new TypeError("no network in this test"); }) as typeof fetch });

  it("refuses a testnet name on mainnet, and a mainnet name on testnet", async () => {
    await expect(maskCheck("nova.tinygif8324.testnet", { network: "mainnet", reader, list: mainnetList })).rejects.toThrow(
      new InvalidAccountError("nova.tinygif8324.testnet is a testnet name; this check reads mainnet"),
    );
    await expect(maskCheck("alice.near", { reader, list: sharedList })).rejects.toThrow("alice.near is a mainnet name; this check reads testnet");
  });

  it("refuses a list of the other network: that is a wiring mistake, not an answer", async () => {
    await expect(maskCheck("intents.near", { network: "mainnet", reader, list: sharedList })).rejects.toThrow("the shared list is for testnet, not mainnet");
  });
});
