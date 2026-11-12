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
import { crateVersion, houseTerms, readBuild, setField, stakeOf, vaultFaults } from "../../../scripts/mainnet/source.mjs";

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
  version: "1.6.0",
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
    expect(crateVersion("contracts/challenges/live-safe")).toBe("1.6.0");
    expect(vault.why).toEqual(expect.arrayContaining([expect.stringMatching(/^link: null/), "version 0.1.0, not 1.6.0 of contracts/challenges/live-safe/Cargo.toml"]));
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

  it("leaves room in the vault for the masks: the 1.6.0 code built at 166 743 bytes still fits 1.93 NEAR", () => {
    const fits = (bytes: number) => vaultFaults({ file: "", bytes: new Uint8Array(bytes), sha256: "", code: "", meta: null, why: [], exports: ["set_owner", "sweep", "arm", "queue", "retire", "on_retire", "reclaim", "on_bounty", "about", "contract_source_metadata"] }, NETWORKS.mainnet);
    expect(fits(166_743)).toEqual([]);
    expect(fits(190_000)[0]).toMatch(/leaves less than twice the least drain/);
  });
});
