/**
 * The forge on mainnet (scripts/mainnet/forge.mjs): what the owner sends is the reviewed data of scripts/mainnet, the
 * same accounts as packages/network, the scripts against the code they drive (the keeper's calls, the pinned bytes, the
 * mind's build), and the NEAR it takes to the yocto, the same total wherever the owner reads it.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { NETWORKS } from "@maskwars/network";
import { describe, expect, it } from "vitest";
import { brainBuild, budget, BRAIN_DEPOSIT, commands, KEEPER_KEY_BYTES, KEEPER_METHODS, nearUp, OUTLAYER_CREDENTIALS, USDC_ON_NEAR, RUNS_TOPUP_USD, runsLine, yocto } from "../../../scripts/mainnet/forge.mjs";
import { TOPUP_USD } from "../src/payment-key.ts";

const NEAR = 10n ** 24n;
const file = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url));
const json = (path: string) => JSON.parse(file(path).toString("utf8"));
const net = NETWORKS.mainnet;
const init = json("scripts/mainnet/forge-init-args.json");
const pins = json("scripts/mainnet/forge-wasm.json");
const brain = json("scripts/mainnet/brain-project-args.json");

describe("the factory's new(...) on mainnet", () => {
  it("names the network's accounts: maskwars.near keeps it, the arena is the bounty contract, the house is a team", () => {
    expect([init.admin, init.keeper, init.treasury]).toEqual([net.admin, net.admin, net.admin]);
    expect(init.arena).toBe(net.bounty);
    expect(init.teams).toEqual([net.admin, net.house]);
    expect(init.release_minutes).toBe(2880);
  });

  it("forges with the catalog of contracts/masks and the mask code this commit pins, and no key until the mind has one", () => {
    expect(init.catalog).toEqual(json("contracts/masks/catalog.json"));
    expect(init.mask_code).toBe(pins.mask.sha256);
    expect(init.strategy_key).toBeNull();
  });
});

describe("the NEAR the forge takes", () => {
  const b = budget({
    factoryBytes: pins.factory.bytes,
    maskBytes: pins.mask.bytes,
    stateBytes: pins.state_bytes,
    fund: yocto(net.fund.factory),
    keeperFloat: yocto(pins.keeper_float),
  });

  it("is exact: the factory's storage and the publish come from the bytes, the rest is margin", () => {
    // 100 bytes of account, the code, and the state new() writes with these very arguments (measured on chain).
    expect(b.stake).toBe(BigInt(100 + pins.factory.bytes + pins.state_bytes) * 10n ** 19n);
    expect(b.publish).toBe(BigInt(pins.mask.bytes) * 10n ** 20n);
    expect(b.margin).toBeGreaterThan(0n);
    expect(b.margin).toBeLessThan(NEAR / 10n);
    expect(b.fund).toBe(b.stake + b.publish + b.margin);
  });

  it("adds up to the one total the owner is told, every stake, deposit and the gas paid up front in it", () => {
    expect(b.total).toBe(b.fund + b.gas + b.key + BRAIN_DEPOSIT + b.keeperFloat);
    // The factory of this commit: 355 216 bytes with copying and view keys, the mask code 60 229.
    expect([pins.factory.bytes, pins.mask.bytes]).toEqual([355_216, 60_229]);
    expect(nearUp(b.stake, 6)).toBe("3.55795");
    expect(nearUp(b.margin, 6)).toBe("0.02915");
    expect(nearUp(b.total)).toBe("9.7771");
    // The guide's budget row and the owner's table in scripts/mainnet say the same figures, not older ones. The guide is
    // a working document of the development repository: a checkout without it checks the owner's table alone.
    if (existsSync(new URL("../../../docs/mainnet.md", import.meta.url))) {
      const guide = file("docs/mainnet.md").toString("utf8");
      const row = guide.split("\n").find((l) => l.startsWith("| Кузня масок людей |"))!;
      expect(row).toContain(`| ${nearUp(b.total)} |`);
      expect(row).toContain(`фабрика ${net.fund.factory} (`);
    }
    const owner = file("scripts/mainnet/README.md").toString("utf8");
    expect(owner).toContain(`| **${nearUp(b.total)}** | **in all, from \`maskwars.near\`** |`);
    expect(owner).toContain(`| **${net.fund.factory}** | **what \`masks.maskwars.near\` gets** (\`fund.factory\`) |`);
    expect(owner).toContain(`${pins.factory.bytes.toLocaleString("en").replace(/,/g, " ")} of code`);
  });
});

describe("the commands", () => {
  const steps = commands({ net, wasmDir: ".scratch/near-mainnet", initFile: "scripts/mainnet/forge-init-args.json", fund: yocto(net.fund.factory), brainFile: "scripts/mainnet/brain-project-args.json" });
  const near = steps.flatMap((s) => s.cli.split("\n")).map((l) => l.trim()).filter((l) => l.startsWith("near "));

  it("every transaction is signed by maskwars.near from the keychain, and near-cli asks before it sends", () => {
    for (const line of near) {
      expect(line).toMatch(/network-config mainnet sign-with-keychain$/);
      expect(line).not.toMatch(/\bsend\b/);
      expect(line.includes(` ${net.admin} `) || line.includes(`sign-as ${net.admin}`)).toBe(true);
    }
  });

  it("makes the factory with the network's fund and no key, adds the keeper's narrow key, then publishes", () => {
    expect(near.map((l) => l.split(" ").slice(1, 3).join(" "))).toEqual([
      "contract call-function",
      "transaction construct-transaction",
      "account add-key",
      "contract call-function",
    ]);
    const deploy = near[1]!;
    expect(deploy).toContain(`${net.admin} ${net.factory} add-action create-account add-action transfer '${net.fund.factory} NEAR'`);
    expect(deploy).not.toContain("add-key");
    expect(near[2]).toContain(`--contract-account-id ${net.factory} --function-names '${KEEPER_METHODS}'`);
    expect(near[3]).toContain(`${net.factory} publish_mask_code`);
  });

  it("gives the keeper's key every call the factory keeps for its keeper, the same key keeper-key.ps1 adds", () => {
    // The factory's keeper-only calls, read from its code: each `pub fn` whose body starts with only_keeper().
    const src = ["lib.rs", "view.rs"].map((f) => file(`contracts/masks/factory/src/${f}`).toString("utf8")).join("\n");
    const keeperOnly = [...src.matchAll(/pub fn (\w+)\([^{]*\{\s*self\.only_keeper\(\);/g)].map((m) => m[1]!);
    expect([...keeperOnly].sort()).toEqual(["arm", "note", "settle", "share"]);
    expect(KEEPER_METHODS.split(", ").sort()).toEqual([...keeperOnly].sort());
    expect(file("scripts/testnet/keeper-key.ps1").toString("utf8")).toContain(`'--function-names' '${KEEPER_METHODS}'`);
    // The key's storage: 40 + 33 + 8 + 1 + 17 + (4 + 19) + 4 + Σ(4 + name), exactly what the budget counts.
    const names = KEEPER_METHODS.split(", ").reduce((n, m) => n + 4 + m.length, 4);
    expect(BigInt(40 + 33 + 8 + 1 + 17 + 4 + net.factory.length + names)).toBe(KEEPER_KEY_BYTES);
  });

  it("keeps the mind's secrets for maskwars.near's runs only, and says where outlayer login leaves the key", () => {
    const outlayer = steps[1]!;
    expect(outlayer.cli).toContain(`outlayer secrets set --generate PROTECTED_BRAIN_SEED:hex32 --project ${net.admin}/brain --access whitelist:${net.admin}`);
    expect(outlayer.what).toContain(OUTLAYER_CREDENTIALS);
    expect(outlayer.check).toContain(`delete ${OUTLAYER_CREDENTIALS}`);
  });

  // OutLayer keeps a payment key's money in its stablecoin: the CLI's `keys topup <number> --usd <amount>` takes USDC
  // from the key's owner. A step that names NEAR there sends the owner to a command that does not exist.
  it("pays the minds' runs in dollars of USDC, beside the NEAR: the same $3 in the script, the day's report and the owner's pages", () => {
    expect(RUNS_TOPUP_USD).toBe(3);
    expect(TOPUP_USD).toBe(RUNS_TOPUP_USD);
    const outlayer = steps[1]!;
    expect(outlayer.cli.split("\n").map((l) => l.trim()).at(-1)).toBe(`outlayer keys topup <the key's number> --usd ${RUNS_TOPUP_USD}`);
    expect(outlayer.cli).toContain(`outlayer run ${net.admin}/brain --input <a file that holds {"action":"key"}> --secrets-profile default --secrets-account ${net.admin}`);
    expect(outlayer.check).toContain(`$${RUNS_TOPUP_USD} of USDC from ${net.admin}`);
    // The one line under the sum: what it costs, and the two things the owner's account needs before the top-up.
    const line = runsLine(net.admin);
    expect(line).toContain(`paid in USDC, not NEAR: about $${RUNS_TOPUP_USD}`);
    expect(line).toContain(`${net.admin} registers on the token ${USDC_ON_NEAR} (storage_deposit, 0.00125 NEAR), then gets the USDC there`);
    // The token is the native USDC on NEAR the vault and the swap already list.
    expect(file("packages/pay/src/listed.ts").toString("utf8")).toContain(`"nep141:${USDC_ON_NEAR}"`);
    // Nowhere does the owner read a top-up in NEAR any more.
    const pages = ["scripts/mainnet/README.md", "scripts/mainnet/forge.mjs", "packages/race/src/payment-key.ts"];
    if (existsSync(new URL("../../../docs/mainnet.md", import.meta.url))) pages.push("docs/mainnet.md");
    for (const page of pages) {
      const text = file(page).toString("utf8");
      expect(text, page).not.toMatch(/topup[^\n]*0\.45|0\.45 NEAR/);
      expect(text, page).toMatch(/keys topup [^\n]*--usd/);
    }
  });

  it("forge-deploy.ps1 -Network mainnet checks the factory's code against the bytes this commit pins before it sends", () => {
    const ps = file("scripts/testnet/forge-deploy.ps1").toString("utf8");
    const pinCheck = ps.indexOf("$pins.factory.sha256");
    expect(pinCheck).toBeGreaterThan(0);
    expect(ps).toContain("Read-Input 'forge-wasm.json'");
    expect(ps).toMatch(/\$factoryBytes -ne \$pins\.factory\.bytes\) \{ Write-Error [^}]*; exit 1 \}/);
    expect(pinCheck).toBeLessThan(ps.indexOf("Invoke-Near transaction construct-transaction"));
  });
});

describe("the mind's project on OutLayer mainnet", () => {
  it("is the mainnet build of services/brain, served on maskwars.xyz under its own sha256", () => {
    const { url, hash, build_target } = brain.source.WasmUrl;
    expect(brain.name).toBe("brain");
    expect(build_target).toBe("wasm32-wasip2");
    expect(url).toBe(`https://maskwars.xyz/outlayer/maskwars-brain-${hash}.wasm`);
    const served = file(`apps/web/public/outlayer/maskwars-brain-${hash}.wasm`);
    expect(createHash("sha256").update(served).digest("hex")).toBe(hash);
    // The development repository's guide names the same build for step 18; a checkout without it has the served file only.
    if (existsSync(new URL("../../../docs/mainnet.md", import.meta.url))) expect(file("docs/mainnet.md").toString("utf8")).toContain(hash);
  });

  it("is the newest mainnet build the site lists, built from the source on main: copies, the check on a copy's author, a factory's masks for its keeper", () => {
    const { hash } = brain.source.WasmUrl;
    const readme = file("apps/web/public/outlayer/README.md").toString("utf8");
    const newest = /\| Brain, mainnet build \| `([0-9a-f]{8})…([0-9a-f]{4})` \|/.exec(readme);
    expect(newest).not.toBeNull();
    expect(`${hash.slice(0, 8)}…${hash.slice(-4)}`).toBe(`${newest![1]}…${newest![2]}`);
    expect(hash.startsWith("3e1b05b6")).toBe(true);
    // forge.mjs checks the same file before it prints a step: the site serves exactly these bytes under that name.
    expect(brainBuild()).toEqual({ url: brain.source.WasmUrl.url, hash, bytes: file(`apps/web/public/outlayer/maskwars-brain-${hash}.wasm`).length });
    // The step the owner runs from scripts/mainnet/README.md names it too, and no older build.
    const owner = file("scripts/mainnet/README.md").toString("utf8");
    expect(owner).toContain(`${hash.slice(0, 8)}…${hash.slice(-4)}`);
    expect(owner).not.toContain("a1922652…bae0");
  });
});
