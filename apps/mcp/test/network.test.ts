import { describe, expect, it } from "vitest";
import { MAINNET, TESTNET, configFromEnv, createMcpRoute, instructionsFor } from "../src/index.ts";

describe("the MCP server on the network MASKWARS_NETWORK names", () => {
  it("reads testnet by default and mainnet when told, with that network's contracts and teams", () => {
    expect(configFromEnv({})).toEqual(TESTNET);
    const m = configFromEnv({ MASKWARS_NETWORK: "mainnet" });
    expect(m).toEqual(MAINNET);
    expect(m.contracts).toEqual(["bounty.maskwars.near"]);
    // The admin, the season treasury and the house, which opens the daily round on mainnet.
    expect(m.teams).toEqual(["maskwars.near", "season.maskwars.near", "house.maskwars.near"]);
    expect(m.rpc).toEqual(["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"]);
    expect(() => configFromEnv({ MASKWARS_NETWORK: "Mainnet" })).toThrow("testnet or mainnet");
  });

  it("tells an agent which network it reads", async () => {
    expect(instructionsFor("mainnet")).toContain("This server reads the arena live from NEAR mainnet.");
    const route = createMcpRoute({ config: MAINNET });
    const about = (await (await route.GET(new Request("https://maskwars.xyz/mcp"))).json()) as { network: string; about: string };
    expect(about.network).toBe("mainnet");
    expect(about.about).toContain("NEAR mainnet");
  });
});
