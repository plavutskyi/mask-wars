import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NETWORKS, SECTIONS, bountyContracts, networkOf, onNetwork, otherNetwork, parseNetwork, teams, whereIs, yocto, type NetworkId } from "../src/index.ts";

const NEAR = 10n ** 24n;
/** What the season treasury's `min_prize(masks)` asks of a round's bounty: storage and reserve, and 0.1 NEAR left. */
const minPrize = (masks: number) => (1500n + 100n * BigInt(masks) + 240n + 4000n * BigInt(masks)) * 10n ** 19n + NEAR / 10n;
const input = (net: NetworkId, file: string) =>
  JSON.parse(readFileSync(new URL(`../../../scripts/${net}/${file}`, import.meta.url), "utf8")) as Record<string, any>;

describe("the two networks", () => {
  it("mainnet lives under maskwars.near: every contract, the scheduler and the masks", () => {
    const m = NETWORKS.mainnet;
    expect(m.admin).toBe("maskwars.near");
    for (const a of [m.bounty, m.season, m.scheduler, m.factory, m.jobs, m.crews, ...Object.values(m.masks)]) {
      expect(a.endsWith(".maskwars.near"), a).toBe(true);
    }
    expect([m.bounty, m.season, m.factory, m.jobs, m.crews]).toEqual([
      "bounty.maskwars.near",
      "season.maskwars.near",
      "masks.maskwars.near",
      "jobs.maskwars.near",
      "crews.maskwars.near",
    ]);
    expect(m.outlayer.contract).toBe("outlayer.near");
    expect(m.older_bounty).toEqual([]);
  });

  it("testnet stays where the arena already is", () => {
    const t = NETWORKS.testnet;
    expect(bountyContracts(t)).toEqual(["bounty.tinygif8324.testnet", "tinygif8324.testnet"]);
    expect(teams(t)).toEqual(["tinygif8324.testnet", "season.tinygif8324.testnet"]);
    expect(t.rpc[0]).toBe("https://rpc.testnet.fastnear.com");
  });

  it("mainnet is read from two providers, the same two MASK CHECK and the judge read", () => {
    expect(NETWORKS.mainnet.rpc).toEqual(["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"]);
  });

  it("a network file with an account of the other network, or not under its admin, does not load", () => {
    const raw = JSON.parse(readFileSync(new URL("../mainnet.json", import.meta.url), "utf8"));
    expect(() => parseNetwork({ ...raw, bounty: "bounty.tinygif8324.testnet" })).toThrow("is not a mainnet account");
    expect(() => parseNetwork({ ...raw, season: "season.someone.near" })).toThrow("is not under maskwars.near");
    expect(() => parseNetwork({ ...raw, limits: { ...raw.limits, fuel_max: "0.5" } })).toThrow("fuel_max");
    expect(() => parseNetwork({ ...raw, fund: { ...raw.fund, safe: "3" } })).toThrow("fund.safe");
  });

  it("MASKWARS_NETWORK: testnet when unset, mainnet when it says so, and nothing else", () => {
    expect(networkOf(undefined)).toBe("testnet");
    expect(networkOf("")).toBe("testnet");
    expect(networkOf("mainnet")).toBe("mainnet");
    expect(() => networkOf(" testnet ")).toThrow("testnet or mainnet");
    expect(() => networkOf("mainnet ")).toThrow("testnet or mainnet");
    expect(() => networkOf("Mainnet")).toThrow("testnet or mainnet");
    expect(() => networkOf("main")).toThrow("testnet or mainnet");
  });

  it("amounts and accounts read the way the contracts take them", () => {
    expect(yocto("0.35")).toBe(35n * NEAR / 100n);
    expect(yocto("1")).toBe(NEAR);
    expect(yocto("0.000000000000000000000001")).toBe(1n);
    expect(() => yocto("1e3")).toThrow();
    expect(onNetwork("mainnet", "0e6879a4be880000000000000000000000000000000000000000000000000000")).toBe(true);
    expect(onNetwork("mainnet", "nova.tinygif8324.testnet")).toBe(false);
  });
});

// What is on chain where is written once, in packages/network/<network>.json: the site reads it to show a part on its
// own network and to send a visitor to the other network for a part that is only there.
describe("which parts are on chain on which network", () => {
  const raw = (net: NetworkId) => JSON.parse(readFileSync(new URL(`../${net}.json`, import.meta.url), "utf8"));

  it("mainnet has the arena; the season, the forge and the jobs are not there yet", () => {
    expect(NETWORKS.mainnet.sections).toEqual({ arena: true, season: false, forge: false, jobs: false });
  });

  it("testnet has the arena, the season and the jobs market; the factory of people's masks is not on chain yet", () => {
    expect(NETWORKS.testnet.sections).toEqual({ arena: true, season: true, forge: false, jobs: true });
  });

  it("every part is stated on every network, as true or false, and nothing else is", () => {
    for (const net of ["testnet", "mainnet"] as const) expect(Object.keys(NETWORKS[net].sections).sort()).toEqual([...SECTIONS].sort());
    const m = raw("mainnet");
    const { sections: _, ...none } = m;
    expect(() => parseNetwork(none)).toThrow("sections");
    const { jobs: __, ...three } = m.sections;
    expect(() => parseNetwork({ ...m, sections: three })).toThrow("sections.jobs: true or false");
    expect(() => parseNetwork({ ...m, sections: { ...m.sections, forge: "yes" } })).toThrow("sections.forge: true or false");
    expect(() => parseNetwork({ ...m, sections: { ...m.sections, casino: true } })).toThrow("sections.casino");
  });

  // The rule, on a picture written out here: the files above change as parts go on chain, the rule does not.
  it("a part is found on the asking network first, then on the other, then nowhere", () => {
    expect(otherNetwork("mainnet")).toBe("testnet");
    expect(otherNetwork("testnet")).toBe("mainnet");
    const picture = {
      mainnet: { sections: { arena: true, season: false, forge: false, jobs: false } },
      testnet: { sections: { arena: true, season: true, forge: false, jobs: true } },
    };
    // On both: each network answers for itself.
    for (const from of ["testnet", "mainnet"] as const) expect(whereIs("arena", from, picture)).toBe(from);
    // On one only: found there from either side.
    for (const part of ["season", "jobs"] as const) {
      expect(whereIs(part, "mainnet", picture)).toBe("testnet");
      expect(whereIs(part, "testnet", picture)).toBe("testnet");
    }
    // On chain nowhere: no network to send a visitor to, from either side.
    expect(whereIs("forge", "mainnet", picture)).toBeNull();
    expect(whereIs("forge", "testnet", picture)).toBeNull();
    // The other way round: a part only mainnet has is found on mainnet.
    const turned = { mainnet: picture.testnet, testnet: picture.mainnet };
    expect(whereIs("jobs", "testnet", turned)).toBe("mainnet");
    expect(whereIs("jobs", "mainnet", turned)).toBe("mainnet");
  });

  it("putting a part on chain is one word in the network's file, on either network", () => {
    for (const net of ["testnet", "mainnet"] as const) {
      const other = otherNetwork(net);
      for (const part of SECTIONS) {
        const file = raw(net);
        const after = { ...NETWORKS, [net]: parseNetwork({ ...file, sections: { ...file.sections, [part]: true } }) } as typeof NETWORKS;
        expect(whereIs(part, net, after), `${part} on ${net}`).toBe(net);
        // Seen from the other network it is there, unless that network has the part itself.
        expect(whereIs(part, other, after), `${part} from ${other}`).toBe(NETWORKS[other].sections[part] ? other : net);
      }
    }
  });

  it("without a default, the files themselves answer", () => {
    for (const part of SECTIONS) {
      for (const from of ["testnet", "mainnet"] as const) {
        const other = otherNetwork(from);
        const expected = NETWORKS[from].sections[part] ? from : NETWORKS[other].sections[part] ? other : null;
        expect(whereIs(part, from), `${part} from ${from}`).toBe(expected);
      }
    }
  });
});

// The limits are written once, in packages/network/<network>.json, and what the scripts send must fit them: the season
// treasury refuses a program over its limits, and these tests keep the files in scripts/ from drifting past them.
describe.each(["testnet", "mainnet"] as const)("%s: the inputs of the scripts fit the limits", (net) => {
  const n = NETWORKS[net];
  const season = input(net, "season-args.json");
  const p = season["program"];

  it("the season's program: bounty, safe, least drain, masks and windows", () => {
    expect(yocto(p.prize)).toBeLessThanOrEqual(yocto(n.limits.season.max_prize));
    expect(yocto(p.prize)).toBeGreaterThanOrEqual(minPrize(p.masks.length));
    for (const t of p.targets) {
      expect(yocto(t.safe_fund)).toBeLessThanOrEqual(yocto(n.limits.season.max_safe_fund));
      // A plain transfer into the safe during a plan shrinks the loss the judge sees: min_loot sits well below it.
      expect(yocto(t.min_loot) * 2n).toBeLessThanOrEqual(yocto(t.safe_fund));
      expect(yocto(t.min_loot)).toBeGreaterThanOrEqual(NEAR / 10n);
    }
    expect(p.masks).toEqual(Object.values(n.masks));
    expect(p.commit_minutes).toBeGreaterThanOrEqual(30);
    expect(p.reveal_minutes).toBeGreaterThanOrEqual(3 * (p.masks.length + 1));
    expect(p.commit_minutes + p.reveal_minutes).toBeLessThanOrEqual(p.hours * 60);
    expect("limits" in season).toBe(false);
  });

  it("a safe made by hand and its round: on this network's accounts, within the hand limits", () => {
    const safe = input(net, "safe-init-args.json");
    const round = input(net, "open-safe-args.json");
    expect(safe["owner"]).toBe(round["safe"]);
    expect(safe["arbiter"]).toBe(n.bounty);
    expect(safe["team"]).toBe(n.admin);
    expect(safe["masks"]).toEqual(round["masks"]);
    expect(safe["owner"].endsWith(`.${n.admin}`)).toBe(true);
    // The safe keeps about 1.55 NEAR for its own code: what is left must hold min_loot.
    expect(yocto(n.fund.safe) - yocto("1.55")).toBeGreaterThan(BigInt(round["min_loot"]));
    expect(round["hours"]).toBeLessThanOrEqual(24);
  });

  it("the judge the scripts pin is the one they open rounds with", () => {
    const judge = input(net, "judge-args.json");
    const version = input(net, "judge-version-args.json");
    expect(version["source"].WasmUrl.hash).toBe(judge["version"]);
    expect(version["source"].WasmUrl.url).toBe(`https://maskwars.xyz/outlayer/maskwars-judge-${judge["version"]}.wasm`);
  });

  it("the jobs contract's fee is at most 10% and its judges are this network's", () => {
    const jobs = input(net, "jobs-args.json");
    expect(jobs["fee_bps"]).toBeLessThanOrEqual(1000);
    for (const j of jobs["judges"]) expect(j.project.startsWith(`${n.admin}/`)).toBe(true);
  });
});

describe("mainnet's small sums", () => {
  const l = NETWORKS.mainnet.limits;
  it("the vault and hiring have their own limits in dollars", () => {
    expect(l.pay_usd_max).toBe(100);
    expect(l.hire_usd_max).toBe(250);
  });
  it("a day of the season moves at most a bounty and a safe, once", () => {
    expect(l.season.max_per_day).toBe(1);
    expect(yocto(l.season.max_prize) + yocto(l.season.max_safe_fund)).toBeLessThanOrEqual(3n * NEAR);
  });
  it("a person's mask takes 1 to 2 NEAR on mainnet", () => {
    expect(yocto(l.fuel_max)).toBe(2n * NEAR);
  });
});
