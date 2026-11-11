/**
 * The owner's scripts for the house's day (scripts/testnet): what the masks send home, and that every script signs
 * with the house's key from the keychain, sends the sums of packages/network and nothing typed into the script.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { codeHashHex, NETWORKS } from "@maskwars/network";
import { describe, expect, it } from "vitest";
import { homeDeploy } from "../../../scripts/mainnet/home-deploy.mjs";
import { homeTransfers, LEAST, milli, yocto } from "../../../scripts/testnet/house.mjs";

const NEAR = 10n ** 24n;
const MILLI = NEAR / 1000n;
const script = (name: string) => readFileSync(new URL(`../../../scripts/testnet/${name}`, import.meta.url), "utf8");
/** A script without its comments: what it does. */
const code = (name: string) => script(name).split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");

describe("winnings go home to the house", () => {
  const keep = yocto(NETWORKS.mainnet.round.mask_keep);
  const houseMax = yocto(NETWORKS.mainnet.limits.house_max);
  const masks = (...near: string[]) => near.map((n, i) => ({ account: ["nova", "onyx", "oracle"][i]! + ".maskwars.near", amount: yocto(n) }));

  it("each mask sends what it holds above what it keeps: the first day's budget, to the thousandth", () => {
    // After the first round on mainnet: nova and onyx 0.5 NEAR each, oracle 1.25, and the house made with 2.03.
    const { transfers, after } = homeTransfers({ masks: masks("0.5", "0.5", "1.25"), keep, house: yocto(NETWORKS.mainnet.fund.house), houseMax });
    expect(transfers.map((t) => [t.account, milli(t.send)])).toEqual([
      ["nova.maskwars.near", "0.100"],
      ["onyx.maskwars.near", "0.100"],
      ["oracle.maskwars.near", "0.850"],
    ]);
    expect(milli(after)).toBe("3.080");
    // Enough for a round: the vault, the deposit and the gas the house keeps free.
    const r = NETWORKS.mainnet.round;
    expect(after).toBeGreaterThanOrEqual(yocto(r.safe) + yocto(r.deposit) + yocto(r.gas));
  });

  it("rounds down, never sends dust and never takes a mask below what it keeps", () => {
    const { transfers } = homeTransfers({ masks: masks("0.4", "0.4099", "0.7519999"), keep, house: 0n, houseMax });
    expect(transfers.map((t) => [t.account, milli(t.send)])).toEqual([["oracle.maskwars.near", "0.351"]]);
    expect(LEAST).toBe(10n * MILLI);
    for (const t of transfers) expect(t.holds - t.send).toBeGreaterThanOrEqual(keep);
    expect(homeTransfers({ masks: masks("0.1", "0", "0.39"), keep, house: 0n, houseMax }).transfers).toEqual([]);
  });

  it("stops before the house would hold more than its limit", () => {
    expect(() => homeTransfers({ masks: masks("0.5", "0.5", "1.25"), keep, house: 3n * NEAR, houseMax })).toThrow(
      "the house would hold 4.050 NEAR, above limits.house_max of 3.500 NEAR: nothing is sent",
    );
  });

  it("reads NEAR the way the network files write it", () => {
    expect(yocto("1.93")).toBe(1930n * MILLI);
    expect(milli(yocto("0.25"))).toBe("0.250");
    expect(milli(1_999_999n * 10n ** 18n)).toBe("1.999");
    expect(() => yocto("1e3")).toThrow("not an amount");
  });
});

describe("the owner's scripts for the house's day", () => {
  it("the day by hand is three scripts, each sending the step the chain asks for, signed by the house", () => {
    for (const name of ["retire.ps1", "safe-deploy.ps1", "open-safe.ps1"]) {
      const text = code(name);
      expect(text, name).toContain("Get-HousePlan");
      expect(text, name).toContain("$HouseAccount");
      // What it sends comes from the plan, which reads packages/network: no amount is typed into the house's part.
      const house = name === "retire.ps1" ? text : text.slice(text.indexOf("if ($House) {"), text.indexOf("\n}\n", text.indexOf("if ($House) {")));
      expect(house.replace(/attached-deposit '0 NEAR'/g, "").replace(/prepaid-gas '100\.0 Tgas'/g, ""), name).not.toMatch(/'\d[\d.]* (NEAR|Tgas)'/);
    }
    expect(code("retire.ps1")).toContain("sign-as $HouseAccount network-config $Network sign-with-keychain");
    expect(code("open-safe.ps1")).toContain("open_safe file-args $step.args_file prepaid-gas $step.gas attached-deposit $step.deposit sign-as $HouseAccount");
  });

  it("a safe is made in one transaction that adds no key: create, fund, deploy, new", () => {
    const text = code("safe-deploy.ps1");
    const made = text.split("\n").filter((l) => l.includes("construct-transaction"));
    expect(made).toHaveLength(2);
    for (const line of made) {
      expect(line).toMatch(/construct-transaction \S+ \S+ add-action create-account add-action transfer \S+( NEAR")? add-action deploy-contract use-file \$wasm with-init-call new file-args /);
      expect(line).not.toContain("add-key");
    }
    expect(made[0]).toContain("construct-transaction $HouseAccount $Vault ");
    expect(made[1]).toContain("construct-transaction $Admin $Safe ");
    // Nothing is left of the old way: an account made with a key that the safe then drops.
    expect(text).not.toContain("autogenerate-new-keypair");
    expect(text).not.toContain("contract deploy");
  });

  it("the vault's wasm is the repository's file with the code safe_code names, .scratch only without it, hashed again before the deploy", () => {
    const config = code("config.ps1");
    expect(config).toContain("Where-Object { (Get-CodeHash $_.FullName) -ceq $Net.safe_code }");
    const plan = config.slice(config.indexOf("function Get-HousePlan"));
    expect(plan.indexOf("$repoWasm = Get-VaultWasm")).toBeGreaterThan(0);
    expect(plan.indexOf("$repoWasm = Get-VaultWasm")).toBeLessThan(plan.indexOf("maskwars_live_safe.wasm"));
    expect(plan).toContain("if ($repoWasm) { $more += @('--wasm', $repoWasm) } elseif (Test-Path $artifact) { $more += @('--wasm', $artifact) }");
    const deploy = code("safe-deploy.ps1");
    const check = deploy.indexOf("if ($code -cne $Net.safe_code) {");
    expect(check).toBeGreaterThan(deploy.indexOf("$code = Get-CodeHash $wasm"));
    expect(check).toBeLessThan(deploy.indexOf("construct-transaction $HouseAccount $Vault"));
  });

  it("no script names the house's account by a name PowerShell would mix up with its own switch", () => {
    // PowerShell names are case-blind: a $House set by config.ps1 would overwrite a script's -House switch.
    expect(code("config.ps1")).toContain("$HouseAccount = $Net.house");
    expect(code("config.ps1")).not.toMatch(/\$House\s*=/);
    for (const name of ["safe-deploy.ps1", "open-safe.ps1"]) expect(code(name), name).toContain("[switch]$House,");
    // $Home is PowerShell's own, too.
    expect(code("house.ps1")).not.toMatch(/\$Home\b/i);
  });

  it("the house's own script makes the account, brings winnings home, and adds or removes the hot key", () => {
    const text = code("house.ps1");
    expect(text).toContain('create-account fund-myself $HouseAccount "$($Net.fund.house) NEAR" autogenerate-new-keypair save-to-keychain sign-as $Admin');
    expect(text).toContain("Assert-Limit");
    expect(text).toContain("tokens $t.account send-near $HouseAccount $t.near");
    // The day by hand sends the masks' winnings home with the rest of what closes yesterday, as the plan gives it.
    expect(code("retire.ps1")).toContain("$closing = @('home', 'unstick', 'settle', 'refund', 'retire')");
    // Once per mask: a home() that did not go through stops nothing, and the list is gone when the script ends.
    const retire = code("retire.ps1");
    expect(retire).toContain("$env:HOUSE_SKIP_HOME = (@($env:HOUSE_SKIP_HOME -split ',' | Where-Object { $_ }) + $step.mask) -join ','");
    expect(retire.indexOf("if ($step.kind -eq 'home') {")).toBeLessThan(retire.indexOf("if ($LASTEXITCODE -ne 0) { Write-Host 'Not sent: nothing changed.'"));
    expect(retire).toMatch(/\} finally \{\n\s+Remove-Item Env:HOUSE_SKIP_HOME -ErrorAction SilentlyContinue\n\}/);
    expect(code("safe-deploy.ps1")).toContain(`$first = if ($step.kind -eq 'home') { "the masks' winnings come home first" }`);
    expect(text).toContain("add-key $HouseAccount grant-full-access use-manually-provided-public-key $public");
    expect(text).toContain("delete-keys $HouseAccount public-keys $Key");
    // The secret lives in the environment of the network, never in the repository.
    expect(text).toContain("'season$GhEnvSuffix'");
  });

  it("a key on a safe takes the allowance it is given, and only a sane one", () => {
    const text = code("season-keys.ps1");
    expect(text).toContain("[string]$Allowance = '0.5 NEAR'");
    expect(text).toContain("allowance = $Allowance;");
    const ok = /^(unlimited|(0|[1-9]\d{0,3})(\.\d{1,5})? NEAR)$/;
    expect(text).toContain(`'${ok.source}'`);
    for (const a of ["0.5 NEAR", "2 NEAR", "unlimited", "10.25 NEAR"]) expect(ok.test(a), a).toBe(true);
    for (const a of ["", "2", "NEAR", "-1 NEAR", "1e3 NEAR", "Unlimited ", "0.5 NEAR; rm"]) expect(ok.test(a), a).toBe(false);
  });
});

describe("home on the masks (scripts/mainnet/home-deploy.mjs)", () => {
  const REPO = fileURLToPath(new URL("../../../", import.meta.url));

  it("is the file home_code names, for each network: the build of contracts/home, under its sha256", () => {
    for (const net of ["mainnet", "testnet"] as const) {
      const d = homeDeploy(REPO, net);
      expect(d.sha256).toBe(codeHashHex(NETWORKS[net].home_code!));
      expect(d.wasm.endsWith(`maskwars-home-${net}-${d.sha256}.wasm`)).toBe(true);
      expect(createHash("sha256").update(readFileSync(d.wasm)).digest("hex")).toBe(d.sha256);
      // A wasm module of a few hundred bytes, whose house is the network's own, written into it.
      const bytes = readFileSync(d.wasm);
      expect(bytes.subarray(0, 4).toString("hex")).toBe("0061736d");
      expect(d.bytes).toBeLessThan(2_000);
      expect(bytes.includes(Buffer.from(`"to":"${NETWORKS[net].house}"`))).toBe(true);
      expect(d.house).toBe(NETWORKS[net].house);
      expect(WebAssembly.Module.exports(new WebAssembly.Module(bytes)).filter((e) => e.kind === "function").map((e) => e.name)).toEqual(["home"]);
    }
  });

  it("prints exactly three deploys of that file, one per mask, each signed by the mask's own key from the keychain", () => {
    const d = homeDeploy(REPO);
    // `near`, or on the owner's machine the near-cli of their scripts, .scratch/near/near.exe.
    const cli = existsSync(join(REPO, ".scratch", "near", "near.exe")) ? `& '${join(REPO, ".scratch", "near", "near.exe")}'` : "near";
    const wasm = /\s/.test(d.wasm) ? `'${d.wasm}'` : d.wasm;
    expect(d.commands).toEqual(
      Object.values(NETWORKS.mainnet.masks).map(
        (mask) => `${cli} contract deploy ${mask} use-file ${wasm} without-init-call network-config mainnet sign-with-keychain`,
      ),
    );
    expect(d.commands).toHaveLength(3);
    // The code locks well under 0.02 NEAR of each mask's balance.
    expect(Number(d.stake)).toBeGreaterThan(0.005);
    expect(Number(d.stake)).toBeLessThan(0.02);
  });

  it("deploys nothing when the file is not the code home_code names", () => {
    const repo = mkdtempSync(join(tmpdir(), "home-deploy-"));
    mkdirSync(join(repo, "packages", "network"), { recursive: true });
    mkdirSync(join(repo, "apps", "web", "public", "contracts"), { recursive: true });
    cpSync(join(REPO, "packages", "network", "mainnet.json"), join(repo, "packages", "network", "mainnet.json"));
    const hex = codeHashHex(NETWORKS.mainnet.home_code!)!;
    expect(() => homeDeploy(repo)).toThrow(`holds no maskwars-home-mainnet-${hex}.wasm`);
    writeFileSync(join(repo, "apps", "web", "public", "contracts", `maskwars-home-mainnet-${hex}.wasm`), "not home");
    expect(() => homeDeploy(repo)).toThrow(`hashes to ${createHash("sha256").update("not home").digest("hex")}, not to home_code`);
    writeFileSync(join(repo, "packages", "network", "mainnet.json"), JSON.stringify({ ...NETWORKS.mainnet, home_code: null }));
    expect(() => homeDeploy(repo)).toThrow("names no home_code: nothing to deploy");
  });

  it("calls the near-cli the owner's scripts use when it is there, from PowerShell, with a path that holds a space quoted", () => {
    const repo = join(mkdtempSync(join(tmpdir(), "home-deploy-")), "the repo");
    const hex = codeHashHex(NETWORKS.mainnet.home_code!)!;
    for (const dir of [["packages", "network"], ["apps", "web", "public", "contracts"], [".scratch", "near"]]) mkdirSync(join(repo, ...dir), { recursive: true });
    cpSync(join(REPO, "packages", "network", "mainnet.json"), join(repo, "packages", "network", "mainnet.json"));
    cpSync(homeDeploy(REPO).wasm, join(repo, "apps", "web", "public", "contracts", `maskwars-home-mainnet-${hex}.wasm`));
    writeFileSync(join(repo, ".scratch", "near", "near.exe"), "");
    const d = homeDeploy(repo);
    expect(d.commands[0]).toBe(
      `& '${join(repo, ".scratch", "near", "near.exe")}' contract deploy nova.maskwars.near use-file '${d.wasm}' without-init-call network-config mainnet sign-with-keychain`,
    );
  });

  it("run by the owner: the three commands on stdout and nothing else", async () => {
    const script = fileURLToPath(new URL("../../../scripts/mainnet/home-deploy.mjs", import.meta.url));
    const r = await new Promise<{ code: number; out: string; err: string }>((done) =>
      execFile(process.execPath, [script], (error, out, err) => done({ code: error ? Number(error.code ?? 1) : 0, out, err })),
    );
    expect(r.code).toBe(0);
    expect(r.out.trimEnd().split("\n")).toEqual(homeDeploy(REPO).commands);
    expect(r.err).toContain("choose \"send\"");
    expect(r.err).toContain(NETWORKS.mainnet.home_code!);
  });
});
