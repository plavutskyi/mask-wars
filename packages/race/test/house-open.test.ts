/**
 * The script the Season workflow runs on mainnet, scripts/house-open.ts, started as the workflow starts it, against the
 * made-up chain of house-chain.ts behind a real JSON-RPC endpoint: what it sends, what it writes for the next job, and
 * how it ends. The network's own file names no `safe_code` yet, so the days here end where a vault would be made; the
 * steps after that are the ones house.test.ts drives.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NETWORKS } from "@maskwars/network";
import { afterEach, describe, expect, it } from "vitest";
import { NearKey } from "../src/near-tx.ts";
import { BOUNTY, FakeNear, HOUSE, KEY, KEY_SECRET, MINUTE, NOW, round, VAULT, WASM } from "./house-chain.ts";

const SCRIPT = fileURLToPath(new URL("../scripts/house-open.ts", import.meta.url));
const HELPER = fileURLToPath(new URL("../../../scripts/testnet/house.mjs", import.meta.url));
const judge = (JSON.parse(readFileSync(new URL("../../../scripts/mainnet/judge-args.json", import.meta.url), "utf8")) as { version: string }).version;

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

/** The made-up chain behind HTTP, answering the way a NEAR node does, errors included. */
async function serve(chain: FakeNear): Promise<string> {
  chain.judge = judge;
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body) as { id: string; method: string; params: Record<string, string> };
      chain.rpc(method, params).then(
        (result) => res.end(JSON.stringify({ jsonrpc: "2.0", id, result })),
        (e: Error) => {
          // "query: UNKNOWN_ACCOUNT account … does not exist while viewing" → the node's own error object.
          const [, cause = "INTERNAL_ERROR", data = e.message] = /^\w+: ([A-Z_]+) (.*)$/.exec(e.message) ?? [];
          res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { name: "HANDLER_ERROR", cause: { name: cause }, code: -32000, message: "Server error", data } }));
        },
      );
    });
  });
  await new Promise<void>((ok) => server!.listen(0, "127.0.0.1", ok));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

interface Ran {
  code: number;
  out: string;
  err: string;
  output: string;
  summary: string;
  dir: string;
}

/** Runs the script as the workflow does. */
async function start(chain: FakeNear | null, args: string[] = [], env: Record<string, string> = {}): Promise<Ran> {
  const dir = mkdtempSync(join(tmpdir(), "house-open-"));
  const files = { GITHUB_OUTPUT: join(dir, "output"), GITHUB_STEP_SUMMARY: join(dir, "summary") };
  for (const f of Object.values(files)) writeFileSync(f, "");
  const rpc = chain ? await serve(chain) : "http://127.0.0.1:9";
  const all = { ...process.env, MASKWARS_NETWORK: "mainnet", NEAR_RPC: rpc, HOUSE_KEY: "", SAFE_WASM: "", GITHUB_ACTIONS: "true", ...files, ...env };
  const res = await new Promise<{ code: number; out: string; err: string }>((done) => {
    execFile(process.execPath, [SCRIPT, ...args], { env: all }, (error, out, err) => done({ code: error ? Number(error.code ?? 1) : 0, out, err }));
  });
  return { ...res, output: readFileSync(files.GITHUB_OUTPUT, "utf8"), summary: readFileSync(files.GITHUB_STEP_SUMMARY, "utf8"), dir };
}

describe("house-open.ts, as the Season workflow starts it", () => {
  it("without HOUSE_KEY: signs nothing, says which steps wait and how to send them by hand, and stays green", async () => {
    const chain = FakeNear.after("open");
    const r = await start(chain);
    expect(r.code).toBe(0);
    expect(chain.steps).toEqual([]);
    expect(r.output).toBe("");
    expect(r.summary).toContain("### The house's round waits for a signature");
    expect(r.summary).toContain(`- refund: the bounty of race-0002, which nobody won, goes back to ${HOUSE}`);
    expect(r.summary).toContain(`- retire: ${VAULT} deletes itself and gives its whole balance back to ${HOUSE}`);
    expect(r.summary).toContain("then no round opens: bounty.maskwars.near does not know the vault's code");
    expect(r.summary).toContain("`HOUSE_KEY` is not set in this job's environment, so nothing was signed.");
    expect(r.summary).toContain("`retire.ps1`, `safe-deploy.ps1 -House`, `open-safe.ps1 -House`");
  });

  it("a round opened by hand and still sealing goes to the race, key or no key", async () => {
    for (const env of [{}, { HOUSE_KEY: KEY_SECRET }]) {
      const chain = FakeNear.after("open");
      chain.bounties.set("race-0002", round(NOW - 10n * MINUTE));
      const r = await start(chain, [], env);
      expect(r.code).toBe(0);
      expect(r.output).toBe("bounty=race-0002\nchallenge=live-safe\n");
      expect(r.summary).toContain("### Round race-0002");
      expect(r.summary).toContain("- not opened by this run: round race-0002 is open and seals until 2026-11-11 18:39 UTC: racing it");
      expect(chain.steps).toEqual([]);
    }
  });

  it("with HOUSE_KEY: sends what the day needs, signed by the house, and goes red when no round can open", async () => {
    const chain = FakeNear.after("drained");
    const r = await start(chain, [], { HOUSE_KEY: KEY_SECRET });
    // The vault came home; no vault is made while the network names no code for it.
    expect(chain.steps).toEqual(["retire"]);
    expect(chain.landed[0]).toMatchObject({ signer: HOUSE, receiver: VAULT });
    expect(chain.vault).toBeNull();
    expect(r.code).toBe(1);
    expect(r.output).toBe("");
    expect(r.summary).toContain("### No round today");
    expect(r.summary).toContain("bounty.maskwars.near does not know the vault's code");
    expect(r.summary).toMatch(/- `retire`: [1-9A-HJ-NP-Za-km-z]{43,44}\n/);
    // The key never shows in what the job prints, beyond the line that tells GitHub to mask it.
    expect(r.out.split(KEY_SECRET)).toHaveLength(2);
    expect(r.out).toContain(`::add-mask::${KEY_SECRET}`);
    expect(r.summary).not.toContain(KEY_SECRET);
  });

  it("outside GitHub Actions the key is never printed: there is no log to hide it in", async () => {
    const chain = FakeNear.after("drained");
    const r = await start(chain, [], { HOUSE_KEY: KEY_SECRET, GITHUB_ACTIONS: "" });
    expect(chain.steps).toEqual(["retire"]);
    expect(r.out).not.toContain(KEY_SECRET);
    expect(r.err).not.toContain(KEY_SECRET);
    expect(r.out).not.toContain("::add-mask::");
  });

  it("with a key, a round that is not over turns the run red and nothing is sent", async () => {
    const chain = FakeNear.after("drained");
    chain.bounties.get("race-0002")!.deadline = NOW + 60n * MINUTE;
    const r = await start(chain, [], { HOUSE_KEY: KEY_SECRET });
    expect(r.code).toBe(1);
    expect(r.summary).toContain("round race-0002 is not over: its winner is paid, and the vault retires only after the round's deadline, 2026-11-11 19:04 UTC");
    expect(chain.steps).toEqual([]);
  });

  it("refuses a HOUSE_KEY that is not a key, and a wasm that is not there, before it asks the chain anything", async () => {
    const chain = new FakeNear();
    const bad = await start(chain, [], { HOUSE_KEY: "not-a-key" });
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("HOUSE_KEY: a NEAR secret key is ed25519:<base58>");
    const missing = await start(chain, [], { SAFE_WASM: join(tmpdir(), "no-such-safe.wasm") });
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("the safe's wasm is not there");
    expect(chain.asked).toBe(0);
  });

  it("says a chain that does not answer as that, and exits 1", async () => {
    const r = await start(null, [], { HOUSE_KEY: KEY_SECRET });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/fetch failed|ECONNREFUSED/);
    expect(r.output).toBe("");
  });
});

describe("house-open.ts --plan, for the owner's scripts", () => {
  it("gives the steps that are left with what near.exe needs, writes each step's arguments, and signs nothing", async () => {
    const chain = FakeNear.after("open");
    const dir = mkdtempSync(join(tmpdir(), "house-plan-"));
    const wasm = join(dir, "safe.wasm");
    writeFileSync(wasm, WASM);
    const r = await start(chain, ["--plan", "--args-dir", dir, "--wasm", wasm]);
    expect(r.code).toBe(0);
    const plan = JSON.parse(r.out) as { kind: string; stop: string; vault_on_chain: string; house_free: string; steps: Record<string, string>[] };
    expect(plan).toMatchObject({ network: "mainnet", house: HOUSE, vault: VAULT, bounty: BOUNTY, kind: "steps", vault_on_chain: "armed", house_free: "0.897 NEAR" });
    expect(plan.stop).toContain("does not know the vault's code");
    expect(plan.steps.map((s) => [s.kind, s.receiver, s.method, s.gas, s.deposit])).toEqual([
      ["refund", BOUNTY, "refund", "30.0 Tgas", "0 NEAR"],
      ["retire", VAULT, "retire", "100.0 Tgas", "0 NEAR"],
    ]);
    expect(JSON.parse(readFileSync(plan.steps[0]!.args_file!, "utf8"))).toEqual({ id: "race-0002" });
    expect(JSON.parse(readFileSync(plan.steps[1]!.args_file!, "utf8"))).toEqual({});
    expect(chain.steps).toEqual([]);
  });

  it("--sample reads nothing from the chain: the three steps of an ordinary day, with the network's own sums", async () => {
    const dir = mkdtempSync(join(tmpdir(), "house-plan-"));
    const r = await start(null, ["--plan", "--sample", "--args-dir", dir]);
    expect(r.code).toBe(0);
    const plan = JSON.parse(r.out) as { steps: { kind: string; near?: string; deposit: string; gas: string; args: Record<string, unknown>; args_file: string }[] };
    const n = NETWORKS.mainnet;
    expect(plan.steps.map((s) => s.kind)).toEqual(["retire", "create", "open"]);
    expect(plan.steps[1]).toMatchObject({ receiver: VAULT, method: "new", near: `${n.round.safe} NEAR`, gas: "30.0 Tgas", args: { owner: VAULT, arbiter: BOUNTY, team: HOUSE, masks: Object.values(n.masks) } });
    expect(plan.steps[2]).toMatchObject({ receiver: BOUNTY, method: "open_safe", deposit: `${n.round.deposit} NEAR`, gas: "100.0 Tgas" });
    expect(plan.steps[2]!.args).toMatchObject({ safe: VAULT, hours: n.round.hours, commit_minutes: n.round.commit_minutes, reveal_minutes: n.round.reveal_minutes, judge_version: judge });
    expect(readdirSync(dir).sort()).toEqual(["house-1-retire-args.json", "house-2-create-args.json", "house-3-open-args.json"]);
    expect(JSON.parse(readFileSync(plan.steps[2]!.args_file, "utf8"))).toEqual(plan.steps[2]!.args);
  });
});

describe("house.mjs, the helper of house.ps1", () => {
  const node = (args: string[], env: Record<string, string> = {}) =>
    new Promise<{ code: number; out: string; err: string }>((done) => {
      execFile(process.execPath, [HELPER, ...args], { env: { ...process.env, ...env } }, (error, out, err) => done({ code: error ? Number(error.code ?? 1) : 0, out, err }));
    });

  it("makes the hot key: the secret in the form HOUSE_KEY takes, its public half for the chain and for taking it back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "house-key-"));
    const file = join(dir, "house-key.txt");
    const r = await node(["key", file]);
    expect(r.code).toBe(0);
    const key = new NearKey(readFileSync(file, "utf8"));
    expect(r.out.trim()).toBe(key.publicKeyText);
    expect(readFileSync(join(dir, "house-key.public.txt"), "utf8")).toBe(key.publicKeyText);
    expect(key.publicKeyText).not.toBe(KEY.publicKeyText);
  });

  it("reads what the masks hold from the chain and says what each sends home", async () => {
    const chain = new FakeNear();
    chain.house = { amount: 2_030n * 10n ** 21n, storage: 300 };
    const masks = Object.values(NETWORKS.mainnet.masks);
    const holds: Record<string, bigint> = { [masks[0]!]: 500n, [masks[1]!]: 500n, [masks[2]!]: 1250n };
    const rpc = chain.rpc.bind(chain);
    chain.rpc = async (method, p) => (p.request_type === "view_account" && holds[p.account_id!] !== undefined ? { amount: (holds[p.account_id!]! * 10n ** 21n).toString() } : rpc(method, p));
    const r = await node(["collect"], { MASKWARS_NETWORK: "mainnet", NEAR_RPC: await serve(chain) });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      house: HOUSE,
      holds: "2.030",
      after: "3.080",
      keep: "0.4",
      transfers: [
        { account: masks[0], holds: "0.500", near: "0.100 NEAR" },
        { account: masks[1], holds: "0.500", near: "0.100 NEAR" },
        { account: masks[2], holds: "1.250", near: "0.850 NEAR" },
      ],
    });
  });

  it("says a house that is not on chain as that", async () => {
    const chain = new FakeNear();
    chain.house = null;
    const rpc = chain.rpc.bind(chain);
    chain.rpc = async (method, p) => (p.request_type === "view_account" && p.account_id !== HOUSE ? { amount: "500000000000000000000000" } : rpc(method, p));
    const r = await node(["collect"], { MASKWARS_NETWORK: "mainnet", NEAR_RPC: await serve(chain) });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${HOUSE} is not on chain: UNKNOWN_ACCOUNT`);
  });
});
