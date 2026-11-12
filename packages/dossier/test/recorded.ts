// The arena as testnet answered on 7.11.2026 (packages/arena/test/fixtures/testnet.json), replayed with no network.
import { readFileSync } from "node:fs";
import { Arena, type ArenaView, Indexer, RPCS } from "@maskwars/arena";
import { type Recording, replayFetch } from "@maskwars/arena/replay";
import { ChainReader } from "@maskwars/check";

export const recording = JSON.parse(
  readFileSync(new URL("../../arena/test/fixtures/testnet.json", import.meta.url), "utf8"),
) as Recording;

export async function recordedView(): Promise<ArenaView> {
  const fetch = replayFetch(recording);
  const arena = new Arena({ rpc: new ChainReader({ endpoints: RPCS, fetch }), indexer: new Indexer({ fetch }), now: () => recording.recordedAt });
  return arena.view();
}
