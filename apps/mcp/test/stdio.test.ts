// Code that runs in its own process, as an agent or a maintainer runs it from a clone: the stdio server and the
// recorder, against the recorded chain behind a real HTTP port.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, expect, it } from "vitest";
import { arenaRecording, data, listen, text } from "./helpers.ts";
import { RecordedNode, type Recording, recording } from "./node.ts";

let rpc: Awaited<ReturnType<typeof listen>>;
beforeAll(async () => {
  rpc = await listen(new RecordedNode(), arenaRecording);
});
afterAll(() => rpc.close());

it("the server runs from a clone over stdio with the same tools", async () => {
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../src/stdio.ts", import.meta.url))],
      env: { ...getDefaultEnvironment(), MASKWARS_RPC: rpc.url, MASKWARS_INDEXER: rpc.url },
      stderr: "pipe",
    }),
  );
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toEqual(["get_live_race", "list_races", "get_race", "get_mask", "get_league", "get_rules", "check_account", "get_house_round", "how_to_join_round", "how_to_play_round", "list_jobs", "get_job", "job_rules", "how_to_enlist", "how_to_enlist_crew", "seal_step", "reveal_step", "job_result", "job_delivery", "how_to_open_job"]);
  expect(data(await client.callTool({ name: "get_mask", arguments: { name: "nova" } }))).toMatchObject({ rank: 1, earned_near: "1.08664", fastest_break: "8:13" });
  expect(data(await client.callTool({ name: "get_live_race", arguments: {} }))).toMatchObject({ race: { id: "race-0003", winner: "NOVA", took_near: "1.08664" } });
  expect(text(await client.callTool({ name: "get_rules", arguments: {} }))).toContain("# Sealed rounds");
  expect(data(await client.callTool({ name: "get_race", arguments: { id: "race-0003" } }))).toMatchObject({ state: "drained", winner: "nova.tinygif8324.testnet" });
  expect(data(await client.callTool({ name: "check_account", arguments: { account: "safe-0001.tinygif8324.testnet" } }))).toMatchObject({ verdict: "block" });
  await client.close();
}, 30_000);

it("the live check passes on the chain it reads: race-0003 is NOVA's break, 1.08664 NEAR in 8:13", async () => {
  const script = fileURLToPath(new URL("../scripts/live.ts", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [script], { env: { ...process.env, MASKWARS_RPC: rpc.url, MASKWARS_INDEXER: rpc.url } });
  expect(stdout).toContain("get_live_race  Latest: race-0003 · BROKEN · NOVA broke SAFE-0001 in 8:13 and took 1.086 NEAR.");
  expect(stdout).toContain("get_mask       NOVA · #1 of 3 in the league · took 1.086 NEAR");
  expect(stdout).toContain("race-0003 reads as it happened");
}, 30_000);

it("the recorder writes back the chain it reads: a fresh recording replays the same", async () => {
  const dir = await mkdtemp(join(tmpdir(), "maskwars-record-"));
  try {
    const out = join(dir, "testnet.json");
    const script = fileURLToPath(new URL("../scripts/record.ts", import.meta.url));
    await promisify(execFile)(process.execPath, [script, out], { env: { ...process.env, MASKWARS_RPC: rpc.url } });
    const fresh = JSON.parse(await readFile(out, "utf8")) as Recording;
    const before = recording();
    expect({ head: fresh.head, ns: fresh.ns_per_block, dayAgo: fresh.day_ago_height }).toEqual({ head: before.head, ns: before.ns_per_block, dayAgo: before.day_ago_height });
    expect(fresh.accounts).toEqual(before.accounts);
    // Every answer the hand recording holds, the recorder found on the chain it serves.
    for (const [contract, methods] of Object.entries(before.views)) {
      for (const [method, answers] of Object.entries(methods)) {
        for (const [args, answer] of Object.entries(answers)) expect(fresh.views[contract]?.[method]?.[args], `${contract}.${method}(${args})`).toEqual(answer);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
