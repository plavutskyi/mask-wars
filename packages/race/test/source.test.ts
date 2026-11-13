/**
 * The code that names its own source (NEP-330) on its way to mainnet: what contracts/nep330.mjs reads from a wasm, and
 * what scripts/mainnet/source.mjs checks before anything goes to the owner. The vault's code on mainnet today is the
 * file the repository serves under `safe_code`: it says version 0.1.0 and no link, as the chain answers for it.
 */
import { cpSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { codeHashHex, NETWORKS } from "@maskwars/network";
import { describe, expect, it } from "vitest";
import { codeHash, faults, sourceMetadata, type SourceMetadata } from "../../../contracts/nep330.mjs";
import { crateVersion, handRound, houseTerms, KINDS, readBuild, setField, stakeOf, vaultFaults } from "../../../scripts/mainnet/source.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SERVED = join(ROOT, "apps", "web", "public", "contracts");
const REV = "0123456789abcdef0123456789abcdef01234567";
const IMAGE = "sourcescan/cargo-near:0.22.0-rust-1.97.0@sha256:b193c8640a27172f83136a0f0aab2a9bf9d09f6ba0e6afd187addfaa9b92bae0";

/** The vault's code on mainnet: the file served under the sha256 of `safe_code`. */
const mainnetVault = () => {
  const hex = codeHashHex(NETWORKS.mainnet.safe_code!);
  const name = readdirSync(SERVED).find((f) => f === `maskwars-live-safe-${hex}.wasm`);
  if (!name) throw new Error("the vault's code is not served");
  return join(SERVED, name);
};

/** Metadata as `cargo near build reproducible-wasm` writes it for the vault built at commit REV. */
const complete = (over: Partial<SourceMetadata> = {}): SourceMetadata => ({
  version: "1.7.0",
  link: `https://github.com/plavutskyi/mask-wars/tree/${REV}`,
  standards: [{ standard: "nep330", version: "1.3.0" }],
  build_info: {
    build_environment: IMAGE,
    build_command: ["cargo", "near", "build", "non-reproducible-wasm", "--locked", "--no-abi"],
    contract_path: "contracts/challenges/live-safe",
    source_code_snapshot: `git+https://github.com/plavutskyi/mask-wars?rev=${REV}`,
    output_wasm_path: "/home/near/code/contracts/challenges/target/near/live_safe/live_safe.wasm",
  },
  ...over,
});

describe("what a contract says about its source (contracts/nep330.mjs)", () => {
  it("reads the vault on mainnet as the chain answers for it: version 0.1.0, no link, no build", async () => {
    const bytes = readFileSync(mainnetVault());
    expect(codeHash(bytes)).toBe(NETWORKS.mainnet.safe_code);
    const meta = await sourceMetadata(bytes);
    expect(meta).toEqual({ version: "0.1.0", link: null, standards: [{ standard: "nep330", version: "1.3.0" }], build_info: null });
    expect(faults(meta)).toEqual([
      'link: null, not https://github.com/plavutskyi/mask-wars/tree/<commit>',
      "build_info: null (a plain build; only cargo near build reproducible-wasm fills it)",
    ]);
  });

  it("finds nothing in home on the masks today: it had no such method", async () => {
    const hex = codeHashHex(NETWORKS.mainnet.home_code!);
    expect(await sourceMetadata(readFileSync(join(SERVED, `maskwars-home-mainnet-${hex}.wasm`)))).toBeNull();
    expect(faults(null)).toEqual(["no contract_source_metadata"]);
  });

  it("takes only a build that names its version, a public commit and how to build it again at that commit", () => {
    expect(faults(complete())).toEqual([]);
    expect(faults(complete({ version: "0.1" }))).toEqual(['version: "0.1"']);
    expect(faults(complete({ link: "https://github.com/plavutskyi/mask-wars-hq/tree/" + REV }))[0]).toMatch(/^link: /);
    const other = complete();
    other.build_info!.source_code_snapshot = "git+https://github.com/plavutskyi/mask-wars?rev=" + "f".repeat(40);
    expect(faults(other)).toEqual([expect.stringContaining("not the commit the link names")]);
    const unpinned = complete();
    unpinned.build_info!.build_environment = "sourcescan/cargo-near:latest";
    expect(faults(unpinned)).toEqual([expect.stringContaining("build_environment")]);
  });
});

describe("the code on its way to mainnet (scripts/mainnet/source.mjs)", () => {
  it("refuses the vault of today as the next one: no version of its crate, no link, no build, no about", async () => {
    const dir = mkdtempSync(join(tmpdir(), "source-"));
    cpSync(mainnetVault(), join(dir, "live-safe.wasm"));
    const build = await readBuild(dir);
    const vault = build["live-safe"]!;
    expect(crateVersion("contracts/challenges/live-safe")).toBe("1.7.0");
    expect(vault.why).toEqual(expect.arrayContaining([expect.stringMatching(/^link: null/), "version 0.1.0, not 1.7.0 of contracts/challenges/live-safe/Cargo.toml"]));
    expect(vaultFaults(vault, NETWORKS.mainnet)).toEqual(["it exports no about"]);
  });

  it("writes the house's terms with the new code and keeps every other term of mainnet", () => {
    const terms = houseTerms(NETWORKS.mainnet, "1f8e1aca123fa63b5b54447e9c722ea78f73322a53efe0ed15a5528b827f86f7", "NewCode");
    // The arguments the owner sends to the house contract on mainnet (contracts/house
    // tests: the_owners_arguments_read_as_mainnets_terms), with the vault's code the only change.
    expect(terms).toEqual({
      bounty: "bounty.maskwars.near",
      vault: "vault.house.maskwars.near",
      safe_code: "NewCode",
      masks: ["nova.maskwars.near", "onyx.maskwars.near", "oracle.maskwars.near"],
      judge_version: "1f8e1aca123fa63b5b54447e9c722ea78f73322a53efe0ed15a5528b827f86f7",
      safe: "1930000000000000000000000",
      deposit: "250000000000000000000000",
      min_loot: "100000000000000000000000",
      gas: "100000000000000000000000",
      hours: 4,
      commit_minutes: 45,
      reveal_minutes: 60,
      first_minute: 1080,
      every_minutes: 1440,
      safe_max: "2500000000000000000000000",
      deposit_max: "1100000000000000000000000",
    });
  });

  it("names the vault's stake to the hundredth, up, and changes only the field it sets", () => {
    expect(stakeOf(165_172)).toBe("1.66");
    expect(stakeOf(166_743)).toBe("1.67");
    expect(stakeOf(100_000)).toBe("1.00");
    const text = readFileSync(join(ROOT, "packages", "network", "mainnet.json"), "utf8");
    const changed = setField(text, "safe_code", "NewCode");
    expect(JSON.parse(changed)).toEqual({ ...JSON.parse(text), safe_code: "NewCode" });
    expect(changed.split("\n").length).toBe(text.split("\n").length);
    expect(() => setField(text, "no_such_field", "x")).toThrow("no_such_field");
  });

  describe("a round by hand on a vault of another kind (--hand)", () => {
    const every = ["arm", "queue", "retire", "on_retire", "reclaim", "on_bounty", "about", "contract_source_metadata", "variant", ...Object.values(KINDS).flat()];
    const vault = (bytes: number, exports: string[] = every) => ({ file: "", bytes: new Uint8Array(bytes), sha256: "ab".repeat(32), code: "9sey9MBoQQNvJWpnqYxrLT6ZcALY8SsBdvXZ973gNeT9", meta: null, why: [], exports });
    const NET = NETWORKS.mainnet;
    const commandsOf = (plan: { steps: { commands: string[] }[] }) => plan.steps.flatMap((s) => s.commands);
    const ps = (script: string, args: string) => [".", "scripts", "testnet", script].join("\\") + ` -Network mainnet ${args}`;

    it("the kinds and their calls are the ones the vault's source has", () => {
      const text = readFileSync(join(ROOT, "contracts", "challenges", "live-safe", "src", "lib.rs"), "utf8");
      expect(Object.keys(KINDS)).toEqual(["owner", "limit", "pause"]);
      for (const method of Object.values(KINDS).flat()) expect(text, method).toContain(`\n    pub fn ${method}(&mut self`);
    });

    it("the 1.7.0 code of 179 453 bytes does not fit the daily vault's 1.93 NEAR, and a vault by hand gets its own", () => {
      // What `--switch safe` would stop on: the daily vault needs more NEAR before it takes this code.
      expect(vaultFaults(vault(179_453), NET)[0]).toMatch(/1\.93 in the vault leaves less than twice the least drain/);
      const plan = handRound(vault(179_453), NET, "pause");
      expect(plan).toMatchObject({ kind: "pause", id: "pause-0001", safe: "pause-0001.maskwars.near", fund: "2.2" });
      // The stake of the code and state, and at least 0.3 NEAR on top to race for, within the limit of a safe by hand.
      expect(plan.stake).toBe(1_854_530_000_000_000_000_000_000n);
      expect(plan.bank).toBe(345_470_000_000_000_000_000_000n);
      expect(Number(plan.fund)).toBeLessThanOrEqual(Number(NET.limits.hand.safe_max));
    });

    it("gives the owner's steps in their order, each a command of the scripts", () => {
      const plan = handRound(vault(179_453), NET, "limit", "limit-0002");
      expect(plan.steps.map((s: { who: string }) => s.who)).toEqual(["maskwars.near", "maskwars.near", "maskwars.near", "each mask (3 transactions)", "maskwars.near", "nobody signs", "maskwars.near"]);
      expect(commandsOf(plan)).toEqual([
        ps("bounty-change.ps1", "-AllowSafe"),
        ps("bounty-change.ps1", "-Apply"),
        ps("bounty-change.ps1", "-Show"),
        ps("safe-deploy.ps1", "-Safe limit-0002.maskwars.near -Variant limit -Near 2.2"),
        ps("season-keys.ps1", "-Safe limit-0002.maskwars.near -SafeOnly"),
        ps("open-safe.ps1", "-Id limit-0002 -Safe limit-0002.maskwars.near -MinLoot 0.1 -Near 0.25"),
        "gh workflow run live-race.yml --repo plavutskyi/mask-wars -f challenge=live-safe -f attempts=5 -f bounty=limit-0002",
        ps("retire.ps1", "-Safe limit-0002.maskwars.near"),
      ]);
      // Every option a step names is one its script takes.
      for (const command of commandsOf(plan).filter((c) => c.startsWith("."))) {
        const script = /([a-z-]+\.ps1)/.exec(command)![1]!;
        const params = /^param\((.*)\)$/m.exec(readFileSync(join(ROOT, "scripts", "testnet", script), "utf8"))![1]!;
        for (const [, option] of command.matchAll(/ -([A-Z][A-Za-z]+)/g)) expect(params, `${script} -${option}`).toContain("$" + option);
      }
      expect(plan.steps[0]!.what).toContain("9sey9MBoQQNvJWpnqYxrLT6ZcALY8SsBdvXZ973gNeT9");
    });

    it("a code the bounty contract already lists needs no proposal", () => {
      const plan = handRound(vault(179_453), NET, "pause", "pause-0002", true);
      expect(plan.steps).toHaveLength(5);
      expect(plan.steps[0]!.commands[0]).toContain("safe-deploy.ps1");
    });

    it("refuses a kind the code does not have, an id of the house's own row, and a code too big for a safe by hand", () => {
      expect(() => handRound(vault(179_453), NET, "vault")).toThrow("--hand: owner, limit, pause");
      expect(() => handRound(vault(179_453), NET, "pause", "race-0005")).toThrow("not race-<n>");
      expect(() => handRound(vault(179_453), NET, "pause", "p1")).toThrow("--id");
      // The vault on mainnet today (1.5.0) has no kinds: it plays the owner kind only.
      const old = every.filter((m) => !["variant", ...KINDS.limit, ...KINDS.pause].includes(m));
      expect(() => handRound(vault(165_172, old), NET, "pause")).toThrow("this code has no vault of the pause kind: it exports no claim, book, cash_out, pause, unpause, variant");
      expect(handRound(vault(165_172, old), NET, "owner").fund).toBe("2.1");
      expect(() => handRound(vault(230_000), NET, "pause")).toThrow("above limits.hand.safe_max of 2.5");
    });
  });

  it("leaves room in the vault for the masks: the 1.6.0 code built at 166 743 bytes still fits 1.93 NEAR", () => {
    const fits = (bytes: number) => vaultFaults({ file: "", bytes: new Uint8Array(bytes), sha256: "", code: "", meta: null, why: [], exports: ["set_owner", "sweep", "arm", "queue", "retire", "on_retire", "reclaim", "on_bounty", "about", "contract_source_metadata"] }, NETWORKS.mainnet);
    expect(fits(166_743)).toEqual([]);
    expect(fits(190_000)[0]).toMatch(/leaves less than twice the least drain/);
  });
});
