import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mainnetList, parseList, withArena, type OpenedRound } from "../src/index.ts";

const season = (n: number, id: string): OpenedRound => ({
  contract: "bounty.maskwars.near",
  race: id,
  safe: `s${String(n).padStart(4, "0")}.season.maskwars.near`,
  by: "season",
});

describe("season 0 adds its safes to the mainnet list", () => {
  it("holds race 1, which the team opened by hand on 10 Nov, and says in what order its safes come", () => {
    expect(mainnetList.arena).toEqual([
      expect.objectContaining({ contract: "bounty.maskwars.near", race: "race-0001", safe: "safe-0001.maskwars.near", owner_at_open: "safe-0001.maskwars.near" }),
    ]);
    const raw = JSON.parse(readFileSync(new URL("../list.mainnet.json", import.meta.url), "utf8"));
    expect(raw.about).toContain("s0001.season.maskwars.near");
    expect(raw.about).toContain("add-safe --network mainnet");
  });

  it("appends each round once, in the order it opened, with the safe as its owner at the opening", () => {
    const empty = parseList({ ...mainnetList, arena: [] });
    const one = withArena(empty, [season(1, "s0-0001-3fa9c2")]);
    expect(one.added).toHaveLength(1);
    expect(one.list.arena[0]).toMatchObject({
      contract: "bounty.maskwars.near",
      race: "s0-0001-3fa9c2",
      safe: "s0001.season.maskwars.near",
      owner_at_open: "s0001.season.maskwars.near",
    });
    const hand: OpenedRound = { contract: "bounty.maskwars.near", race: "human-0001", safe: "h0001.maskwars.near", by: "hand" };
    const two = withArena(one.list, [season(1, "s0-0001-3fa9c2"), season(2, "s0-0002-91be04"), hand]);
    expect(two.added.map((e) => e.race)).toEqual(["s0-0002-91be04", "human-0001"]);
    expect(two.list.arena.map((e) => e.safe)).toEqual(["s0001.season.maskwars.near", "s0002.season.maskwars.near", "h0001.maskwars.near"]);
    expect(withArena(two.list, [season(2, "s0-0002-91be04")]).added).toEqual([]);
    expect(parseList(JSON.parse(JSON.stringify(two.list)))).toEqual(two.list);
  });

  it("refuses a testnet safe in the mainnet list", () => {
    const wrong: OpenedRound = { contract: "bounty.tinygif8324.testnet", race: "s1-0001-aaaaaa", safe: "s0001.season.tinygif8324.testnet", by: "season" };
    expect(() => withArena(mainnetList, [wrong])).toThrow("is not a mainnet account");
  });
});
