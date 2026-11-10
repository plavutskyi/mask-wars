// check_account and its paid twin: the same check run inside a TEE on OutLayer (services/check). The tool hands an
// agent the call it would make, as data, and only once that module is published.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import { TEE_DEPLOYMENT, type TeeDeployment, teeCheckOf } from "../src/index.ts";
import { usd } from "../src/tee.ts";
import { data, setup } from "./helpers.ts";

const PUBLISHED: TeeDeployment = {
  outlayer: "testnet",
  api: "https://testnet-api.outlayer.ai",
  project: "tinygif8324.testnet/check",
  price_usd_micro: 10_000,
  wasm_sha256: "a1".repeat(32),
  rules: "5f2c0a1e9d8b7c6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a29",
  key: "ed25519:FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z",
};

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function check(account: string, tee?: TeeDeployment) {
  const s = setup(tee ? { tee } : {});
  const client = await s.connect();
  clients.push(client);
  const { tools } = await client.listTools();
  return { answer: data(await client.callTool({ name: "check_account", arguments: { account } })), tool: tools.find((t) => t.name === "check_account")! };
}

describe("check_account, once the TEE module is published", () => {
  it("adds the call that gets the same account checked in the TEE: where, which build, for how much and in what money, signed by which key", async () => {
    const { answer } = await check("treasury.intents.near", PUBLISHED);
    expect(answer["verdict"]).toBe("block");
    expect(answer["tee"]).toEqual({
      url: "https://testnet-api.outlayer.ai/call/tinygif8324.testnet/check",
      input: { account: "treasury.intents.near", network: "mainnet" },
      version_key: PUBLISHED.wasm_sha256,
      header: "X-Attached-Deposit: 10000",
      price_usd: "0.01",
      outlayer: "testnet",
      paid_in: "test stablecoins on OutLayer testnet: no real money moves",
      key: "ed25519:FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z",
      rules: PUBLISHED.rules,
      wasm_sha256: PUBLISHED.wasm_sha256,
    });
  });

  it("says plainly that OutLayer testnet takes test money, and does not say it of mainnet", async () => {
    expect(teeCheckOf(PUBLISHED, "intents.near", "mainnet")).toMatchObject({ outlayer: "testnet", paid_in: expect.stringContaining("test stablecoins") });
    const live = teeCheckOf({ ...PUBLISHED, outlayer: "mainnet", api: "https://api.outlayer.ai" }, "intents.near", "mainnet");
    expect(live).toMatchObject({ outlayer: "mainnet", paid_in: "stablecoins on OutLayer mainnet", url: "https://api.outlayer.ai/call/tinygif8324.testnet/check" });
  });

  it("pins the call to the build it names: the version key is the module's sha256", async () => {
    const { answer, tool } = await check("intents.near", PUBLISHED);
    const tee = answer["tee"] as { version_key: string; wasm_sha256: string };
    expect(tee.version_key).toBe(tee.wasm_sha256);
    const fields = (tool.outputSchema?.properties as Record<string, { properties?: Record<string, { description?: string }> }>)["tee"]?.properties;
    expect(fields?.["version_key"]?.description).toContain("exactly this build");
    expect(fields?.["key"]?.description).toContain("never against the key an answer names");
  });

  it("names the network the check read, for a testnet account too", async () => {
    const { answer } = await check("nova.tinygif8324.testnet", PUBLISHED);
    expect((answer["tee"] as { input: unknown }).input).toEqual({ account: "nova.tinygif8324.testnet", network: "testnet" });
  });

  it("describes the field in the tool's output schema", async () => {
    const { tool } = await check("intents.near", PUBLISHED);
    const tee = (tool.outputSchema?.properties as Record<string, { description?: string }>)["tee"];
    expect(tee?.description).toContain("run inside a TEE on OutLayer and signed there");
    expect(tool.outputSchema?.required).not.toContain("tee");
  });
});

describe("check_account, before a version is published", () => {
  it.each([
    ["no key yet", { ...PUBLISHED, key: null }],
    ["no module yet", { ...PUBLISHED, wasm_sha256: null }],
    ["no rules recorded yet", { ...PUBLISHED, rules: null }],
  ])("sends no agent to an address nothing answers at: %s", async (_why, tee) => {
    const { answer } = await check("intents.near", tee);
    expect(answer["verdict"]).toBe("allow");
    expect("tee" in answer).toBe(false);
  });

  it("is what the repo says today, by the same rule", async () => {
    const { answer } = await check("intents.near");
    expect("tee" in answer).toBe(teeCheckOf(TEE_DEPLOYMENT, "intents.near", "mainnet") !== null);
  });
});

describe("the published address", () => {
  it("is a project on OutLayer's HTTPS API, at the module's own price", () => {
    expect(TEE_DEPLOYMENT.api).toMatch(/^https:\/\/(testnet-)?api\.outlayer\.ai$/);
    expect(TEE_DEPLOYMENT.project).toMatch(/^[a-z0-9._-]+\.(testnet|near)\/check$/);
    // The price is the module's: `PRICE_USD_MICRO` in services/check/src/lib.rs, which the module's own test holds to
    // this file.
    const lib = readFileSync(new URL("../../../services/check/src/lib.rs", import.meta.url), "utf8");
    expect(lib).toContain(`pub const PRICE_USD_MICRO: u64 = ${TEE_DEPLOYMENT.price_usd_micro.toLocaleString("en-US").replaceAll(",", "_")};`);
    expect(TEE_DEPLOYMENT.outlayer).toBe(TEE_DEPLOYMENT.api.includes("testnet") ? "testnet" : "mainnet");
    expect(TEE_DEPLOYMENT.key === null).toBe(TEE_DEPLOYMENT.wasm_sha256 === null);
    expect(TEE_DEPLOYMENT.key === null).toBe(TEE_DEPLOYMENT.rules === null);
    if (TEE_DEPLOYMENT.rules) expect(TEE_DEPLOYMENT.rules).toMatch(/^[0-9a-f]{64}$/);
    if (TEE_DEPLOYMENT.key) expect(TEE_DEPLOYMENT.key).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    if (TEE_DEPLOYMENT.wasm_sha256) expect(TEE_DEPLOYMENT.wasm_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("writes millionths of a dollar as dollars", () => {
    expect([10_000, 5_000, 1_000_000, 12_500_000, 1].map(usd)).toEqual(["0.01", "0.005", "1", "12.5", "0.000001"]);
  });
});
