import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EMPTY_AT, emptyMainnet, mainnetArena } from "../scripts/empty.ts";
import { type Recording, replayFetch } from "../src/replay.ts";

// Mainnet before season 0: maskwars.near holds nothing yet. `pnpm --filter @maskwars/arena empty` writes the answers
// (test/fixtures/mainnet-empty.json); the site replays the same file for its screenshots with MASKWARS_NETWORK=mainnet.
const recording = JSON.parse(readFileSync(new URL("./fixtures/mainnet-empty.json", import.meta.url), "utf8")) as Recording;

describe("mainnet before season 0", () => {
  it("is an empty arena, said plainly: no race, no next race, nothing live", async () => {
    const view = await mainnetArena(replayFetch(recording), recording.recordedAt).view();
    expect(view.network).toBe("mainnet");
    expect(view.races).toEqual([]);
    expect(view.now).toBeNull();
    expect(view.next).toBeNull();
    // The arena's own masks stand in the league with nothing won: no race, no NEAR, no ×.
    expect(view.league.map((m) => m.who.account)).toEqual(["nova.maskwars.near", "onyx.maskwars.near", "oracle.maskwars.near"]);
    for (const m of view.league) expect(m.races).toBe(0);
  });

  it("the recording is exactly what the empty chain answers", async () => {
    expect(recording.recordedAt).toBe(EMPTY_AT);
    const asked = new Set(recording.exchanges.map((e) => e.url));
    expect([...asked].sort()).toEqual(["https://rpc.mainnet.fastnear.com", "https://tx.main.fastnear.com/v0/account"]);
    const view = await mainnetArena(emptyMainnet(), EMPTY_AT).view();
    expect(view.races).toEqual([]);
  });
});
