import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CLAIM_GRACE_MINUTES,
  JOB_BOND_STORAGE,
  JOBS_TICK_MINUTES,
  NETWORKS,
  SECTIONS,
  MAX_LIVE_JOBS_PER_MASK,
  bountyContracts,
  codeHashHex,
  houseKeeps,
  houseOutMost,
  jobsTicksIn,
  networkOf,
  onNetwork,
  otherNetwork,
  parseNetwork,
  slotAfter,
  slotAt,
  teams,
  whereIs,
  yocto,
  type NetworkId,
} from "../src/index.ts";

const NEAR = 10n ** 24n;
/** What the season treasury's `min_prize(masks)` asks of a round's bounty: storage and reserve, and 0.1 NEAR left. */
const minPrize = (masks: number) => (1500n + 100n * BigInt(masks) + 240n + 4000n * BigInt(masks)) * 10n ** 19n + NEAR / 10n;
const input = (net: NetworkId, file: string) =>
  JSON.parse(readFileSync(new URL(`../../../scripts/${net}/${file}`, import.meta.url), "utf8")) as Record<string, any>;

describe("the two networks", () => {
  it("mainnet lives under maskwars.near: every contract, the scheduler and the masks", () => {
    const m = NETWORKS.mainnet;
    expect(m.admin).toBe("maskwars.near");
    for (const a of [m.bounty, m.season, m.scheduler, m.house, m.vault, m.factory, m.jobs, m.crews, ...Object.values(m.masks)]) {
      expect(a.endsWith(".maskwars.near"), a).toBe(true);
    }
    expect([m.house, m.vault]).toEqual(["house.maskwars.near", "vault.house.maskwars.near"]);
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
    expect(teams(t)).toEqual(["tinygif8324.testnet", "season.tinygif8324.testnet", "house.tinygif8324.testnet"]);
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
    expect(() => parseNetwork({ ...raw, house: "house.someone.near" })).toThrow("is not under maskwars.near");
  });

  it("jobs from outside: a real reward, a few a round, one live job a client, and a place of every mask kept for our own", () => {
    for (const id of ["testnet", "mainnet"] as const) {
      const j = NETWORKS[id].limits.jobs;
      expect(yocto(j.min_reward)).toBe(NEAR / 2n);
      // A job posted on /jobs asks 0.05 NEAR a mask; the house never locks more than 0.1 for one.
      expect(yocto(j.max_bond)).toBe(NEAR / 10n);
      expect([j.per_round, j.per_client, j.seats]).toEqual([2, 1, 2]);
      expect(j.seats).toBeLessThan(MAX_LIVE_JOBS_PER_MASK);
    }
    const raw = JSON.parse(readFileSync(new URL("../mainnet.json", import.meta.url), "utf8"));
    const jobs = (change: Record<string, unknown>) => parseNetwork({ ...raw, limits: { ...raw.limits, jobs: { ...raw.limits.jobs, ...change } } });
    expect(() => jobs({ min_reward: "0.05" })).toThrow("limits.jobs.min_reward");
    expect(() => jobs({ max_bond: "0.005" })).toThrow("limits.jobs.max_bond");
    expect(() => jobs({ max_bond: "0.6" })).toThrow("limits.jobs.max_bond");
    expect(() => jobs({ seats: 4 })).toThrow("fewer than the 4 live places");
    expect(() => jobs({ per_client: 3 })).toThrow("per_client: no more than seats");
    expect(() => jobs({ per_round: 0 })).toThrow("whole numbers of jobs");
    expect(() => parseNetwork({ ...raw, limits: { ...raw.limits, jobs: undefined } })).toThrow("limits.jobs");
  });

  it("the house's bonds on jobs from outside: an absolute cap, never above what the limits allow, and short windows", () => {
    for (const id of ["testnet", "mainnet"] as const) {
      const n = NETWORKS[id];
      const j = n.limits.jobs;
      // Every mask on `seats` jobs from outside, each bond 0.1 NEAR with its record's 0.004: 3 x 2 x 0.104.
      expect(houseOutMost(n)).toBe(yocto("0.624"));
      expect(yocto(JOB_BOND_STORAGE)).toBe(400n * 10n ** 19n);
      expect(yocto(j.max_out)).toBe(yocto("0.624"));
      expect(yocto(j.max_out)).toBeLessThanOrEqual(houseOutMost(n));
      // A bond waits an hour at most, a reveal lasts an hour at most, and two runs of the site's clock fall inside it.
      expect([j.max_work_minutes, j.max_reveal_minutes, j.max_appeal_minutes, j.reveal_runs]).toEqual([60, 60, 60, 2]);
    }
    const raw = JSON.parse(readFileSync(new URL("../mainnet.json", import.meta.url), "utf8"));
    const jobs = (change: Record<string, unknown>) => parseNetwork({ ...raw, limits: { ...raw.limits, jobs: { ...raw.limits.jobs, ...change } } });
    expect(() => jobs({ max_out: "0.625" })).toThrow("limits.jobs.max_out");
    expect(() => jobs({ max_out: "0" })).toThrow("limits.jobs.max_out");
    expect(() => jobs({ max_out: undefined })).toThrow("limits.jobs.max_out");
    // A lower bond or fewer seats lowers what the cap may be.
    expect(() => jobs({ seats: 1, per_client: 1 })).toThrow("limits.jobs.max_out");
    expect(jobs({ seats: 1, per_client: 1, max_out: "0.312" }).limits.jobs.max_out).toBe("0.312");
    // A work window of three days, the contract's longest, is never one the house's bond waits through.
    expect(() => jobs({ max_work_minutes: 4320 })).toThrow("limits.jobs.max_work_minutes");
    expect(() => jobs({ max_work_minutes: 39 })).toThrow("limits.jobs.max_work_minutes");
    expect(() => jobs({ max_work_minutes: undefined })).toThrow("limits.jobs.max_work_minutes");
    expect(() => jobs({ max_reveal_minutes: 1440 })).toThrow("limits.jobs.max_reveal_minutes");
    expect(() => jobs({ max_reveal_minutes: 29 })).toThrow("limits.jobs.max_reveal_minutes");
    expect(() => jobs({ max_appeal_minutes: 1440 })).toThrow("limits.jobs.max_appeal_minutes");
    expect(() => jobs({ reveal_runs: 0 })).toThrow("limits.jobs.reveal_runs");
    expect(() => jobs({ reveal_runs: undefined })).toThrow("limits.jobs.reveal_runs");
  });

  it("the site's clock: its runs of the Jobs workflow, counted from the house's slot", () => {
    const round = NETWORKS.mainnet.round;
    const at = (hh: number, mm: number, day = 13) => Date.UTC(2026, 10, day, hh, mm);
    const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16);
    expect(JOBS_TICK_MINUTES).toEqual([...JOBS_TICK_MINUTES].sort((a, b) => a - b));
    // A job posted on /jobs reveals from 18:44 to 19:14: the clock runs at 18:49, 18:59 and 19:09 then.
    expect(jobsTicksIn(round, at(18, 44), at(19, 14)).map(hhmm)).toEqual(["18:49", "18:59", "19:09"]);
    expect(jobsTicksIn(round, at(18, 49), at(18, 59)).map(hhmm)).toEqual(["18:49", "18:59"]);
    // No run between 22:29 and the next day's 18:09.
    expect(jobsTicksIn(round, at(22, 30), at(18, 8, 14))).toEqual([]);
    expect(jobsTicksIn(round, at(22, 29), at(18, 9, 14)).map(hhmm)).toEqual(["22:29", "18:09"]);
    expect(jobsTicksIn(round, at(3, 0), at(3, 30))).toEqual([]);
    expect(jobsTicksIn(round, at(19, 0), at(18, 0))).toEqual([]);
  });

  it("the house keeps what its next round needs beside the vault, whatever bonds it locks", () => {
    // mainnet: the deposit 0.25, the gas 0.1 and three guests at 0.051.
    expect(houseKeeps(NETWORKS.mainnet)).toBe(yocto("0.503"));
    // testnet: the same, with five guests (three masks, two agents).
    expect(houseKeeps(NETWORKS.testnet)).toBe(yocto("0.605"));
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

  it("mainnet has the arena and the forge of people's masks; the season and the jobs are not there yet", () => {
    expect(NETWORKS.mainnet.sections).toEqual({ arena: true, season: false, forge: true, jobs: false });
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
  it("Get NEAR takes 25 basis points for the team on mainnet, nothing on testnet, and never more than 1%", () => {
    expect(NETWORKS.mainnet.get_near).toEqual({ fee_bps: 25, fee_to: NETWORKS.mainnet.admin });
    expect(NETWORKS.testnet.get_near).toBeUndefined();
    const over = { ...NETWORKS.mainnet, get_near: { fee_bps: 101, fee_to: "maskwars.near" } };
    expect(() => parseNetwork(over)).toThrow(/fee_bps/);
    const testnetFee = { ...NETWORKS.mainnet, get_near: { fee_bps: 25, fee_to: "maskwars.testnet" } };
    expect(() => parseNetwork(testnetFee)).toThrow(/fee_to/);
  });
  it("a swap between any two coins takes at most 1% for MASK WARS, on mainnet only, with a dollar limit", () => {
    expect(NETWORKS.mainnet.swap).toEqual({ fee_bps: 25, fee_to: NETWORKS.mainnet.admin, usd_max: 100 });
    expect(NETWORKS.testnet.swap).toBeUndefined();
    expect(() => parseNetwork({ ...NETWORKS.mainnet, swap: { fee_bps: 101, fee_to: "maskwars.near", usd_max: 100 } })).toThrow(/swap.fee_bps/);
    expect(() => parseNetwork({ ...NETWORKS.mainnet, swap: { fee_bps: 25, fee_to: "maskwars.testnet", usd_max: 100 } })).toThrow(/swap.fee_to/);
    expect(() => parseNetwork({ ...NETWORKS.mainnet, swap: { fee_bps: 25, fee_to: "maskwars.near", usd_max: 0.5 } })).toThrow(/swap.usd_max/);
  });
  it("a day of the season moves at most a bounty and a safe, once", () => {
    expect(l.season.max_per_day).toBe(1);
    expect(yocto(l.season.max_prize) + yocto(l.season.max_safe_fund)).toBeLessThanOrEqual(3n * NEAR);
  });
  it("a person's mask takes 1 to 2 NEAR on mainnet", () => {
    expect(yocto(l.fuel_max)).toBe(2n * NEAR);
  });
});

// The house opens one round a day on one safe, the vault, which retires itself once the round is over and is made again
// under the same name. Everything the daily step sends is written in packages/network/<network>.json: these tests keep
// it within the limits and keep the circle able to close within a day.
describe.each(["testnet", "mainnet"] as const)("%s: the house's daily round", (net) => {
  const n = NETWORKS[net];
  const r = n.round;
  const raw = () => JSON.parse(readFileSync(new URL(`../${net}.json`, import.meta.url), "utf8"));

  it("the house is the admin's own account, the vault the house's own, and the house is one of the arena's teams", () => {
    expect(n.house).toBe(`house.${n.admin}`);
    expect(n.vault).toBe(`vault.${n.house}`);
    expect(teams(n)).toEqual([n.admin, n.season, n.house]);
    // The bounty contract refuses a round whose team or safe is one of its masks.
    expect(Object.values(n.masks)).not.toContain(n.house);
    expect(Object.values(n.masks)).not.toContain(n.vault);
  });

  it("what goes into the vault and the round's deposit stay within the limits of rounds by hand", () => {
    expect(yocto(r.safe)).toBeLessThanOrEqual(yocto(n.limits.hand.safe_max));
    expect(yocto(r.deposit)).toBeLessThanOrEqual(yocto(n.limits.hand.deposit_max));
    // The bounty contract keeps the round's storage and reserve out of the deposit and still wants 0.1 NEAR to pay.
    expect(yocto(r.deposit)).toBeGreaterThanOrEqual(minPrize(Object.keys(n.masks).length));
    // The vault locks about 1.65 NEAR for its 164 KB of code and its state: what is left is the loot, and a plain
    // transfer into the vault during a plan must not hide a drain, so the least drain sits well below it.
    expect(yocto(r.stake)).toBeGreaterThanOrEqual(yocto("1.65"));
    const loot = yocto(r.safe) - yocto(r.stake);
    expect(yocto(r.min_loot) * 2n).toBeLessThanOrEqual(loot);
    expect(yocto(r.min_loot)).toBeGreaterThanOrEqual(NEAR / 10n);
  });

  it("the house never needs more than it may hold, and starts with no more than that", () => {
    const need = yocto(r.safe) + yocto(r.deposit) + yocto(r.gas);
    expect(need).toBeLessThanOrEqual(yocto(n.limits.house_max));
    expect(yocto(n.fund.house)).toBeLessThanOrEqual(yocto(n.limits.house_max));
    // A mask keeps enough for the gas a claim buys up front (200 TGas, 0.2 NEAR at the pessimistic price).
    expect(yocto(r.mask_keep)).toBeGreaterThanOrEqual(yocto("0.3"));
  });

  it("a slot comes once a day at 18:00 UTC, and a round nobody won is over before the next one", () => {
    expect([r.first_minute, r.every_minutes]).toEqual([1080, 1440]);
    expect(r.hours * 60 + CLAIM_GRACE_MINUTES).toBeLessThan(r.every_minutes);
    expect(r.commit_minutes).toBeGreaterThanOrEqual(30);
    expect(r.reveal_minutes).toBeGreaterThanOrEqual(3 * (Object.keys(n.masks).length + 1));
    expect(r.commit_minutes + r.reveal_minutes).toBeLessThanOrEqual(r.hours * 60);
    // The season's rounds on the same network keep the same clock.
    const p = input(net, "season-args.json")["program"];
    expect([p.first_minute, p.every_minutes]).toEqual([r.first_minute, r.every_minutes]);
  });

  it("the site tells no next round until the owner turns the round on, and names the judge the step opens it with", () => {
    // On for mainnet from 11.11 (the owner's word: the daily round runs now), off for testnet. The site still tells the
    // next round only when the chain says it can open: the house funded, the vault's code known to the contract.
    expect(r.live).toBe(net === "mainnet");
    expect(r.judge).toBe(input(net, "judge-args.json")["version"]);
    expect(() => parseNetwork({ ...raw(), round: { ...raw().round, live: "yes" } })).toThrow("round.live");
    const { live: _, ...noLive } = raw().round;
    expect(() => parseNetwork({ ...raw(), round: noLive })).toThrow("round.live");
    expect(() => parseNetwork({ ...raw(), round: { ...raw().round, judge: "AB".repeat(32) } })).toThrow("round.judge");
    expect(parseNetwork({ ...raw(), round: { ...raw().round, live: true } }).round.live).toBe(true);
  });

  it("the vault's code is a code hash, or not known yet", () => {
    if (n.safe_code !== null) expect(codeHashHex(n.safe_code)).toMatch(/^[0-9a-f]{64}$/);
    expect(parseNetwork({ ...raw(), safe_code: "ACrGiPV5s7DPk5LvXv1N6dyQvqdXTu1m978FseoBw5ja" }).safe_code).toBe("ACrGiPV5s7DPk5LvXv1N6dyQvqdXTu1m978FseoBw5ja");
    expect(() => parseNetwork({ ...raw(), safe_code: "not-a-hash" })).toThrow("safe_code");
    expect(() => parseNetwork({ ...raw(), safe_code: "" })).toThrow("safe_code");
  });

  it("the code of home on the masks is a code hash, or none", () => {
    if (n.home_code !== null) expect(codeHashHex(n.home_code)).toMatch(/^[0-9a-f]{64}$/);
    expect(parseNetwork({ ...raw(), home_code: null }).home_code).toBeNull();
    expect(() => parseNetwork({ ...raw(), home_code: "not-a-hash" })).toThrow("home_code");
    expect(() => parseNetwork({ ...raw(), home_code: "" })).toThrow("home_code");
    expect(() => parseNetwork({ ...raw(), home_code: 7 })).toThrow("home_code");
  });

  it("a file that breaks the circle does not load", () => {
    const f = raw();
    const round = (patch: object) => ({ ...f, round: { ...f.round, ...patch } });
    expect(() => parseNetwork({ ...f, vault: `vault.${f.admin}` })).toThrow("is not a sub-account of");
    expect(() => parseNetwork({ ...f, vault: `a.vault.${f.house}` })).toThrow("is not a sub-account of");
    expect(() => parseNetwork(round({ safe: "9" }))).toThrow("round.safe");
    expect(() => parseNetwork(round({ deposit: "2" }))).toThrow("round.deposit");
    expect(() => parseNetwork(round({ min_loot: "0.05" }))).toThrow("round.min_loot");
    expect(() => parseNetwork(round({ min_loot: "0.2" }))).toThrow("less than its stake and twice min_loot");
    expect(() => parseNetwork(round({ hours: 25 }))).toThrow("round.hours");
    expect(() => parseNetwork(round({ reveal_minutes: 5 }))).toThrow("3 minutes for each mask");
    // 13 hours and the 12 hours of claims after them do not fit in a day.
    expect(() => parseNetwork(round({ hours: 13 }))).toThrow("before the next slot");
    expect(() => parseNetwork({ ...f, limits: { ...f.limits, house_max: "2" } })).toThrow("house_max");
    const { round: _, ...none } = f;
    expect(() => parseNetwork(none)).toThrow("round");
  });

  it("guests: three people's masks beside ours, and two outside agents on testnet only, each adding its storage to the deposit", () => {
    // Outside agents come to mainnet later, with an entry stake of their own: until then the house seats none there.
    expect(NETWORKS.mainnet.guests).toEqual({ masks: 3, agents: 0, deposit: "0.051" });
    expect(NETWORKS.testnet.guests).toEqual({ masks: 3, agents: 2, deposit: "0.051" });
    for (const n of [NETWORKS.mainnet, NETWORKS.testnet]) {
      // The bounty contract keeps 4000 bytes for each mask of a round (0.04 NEAR), the bounty pays a mask's first claim
      // to the judge (0.01), and the mask's account id is stored in the round.
      const all = Object.keys(n.masks).length + n.guests.masks + n.guests.agents;
      expect(all).toBeLessThanOrEqual(16);
      expect(n.round.reveal_minutes).toBeGreaterThanOrEqual(3 * (all + 1));
      const full = yocto(n.round.deposit) + 5n * yocto(n.guests.deposit);
      expect(yocto(n.round.safe) + full + yocto(n.round.gas)).toBeLessThanOrEqual(yocto(n.limits.house_max));
    }
    const f = raw();
    expect(() => parseNetwork({ ...f, guests: { ...f.guests, agents: 14 } })).toThrow("16 at most");
    // Ours alone fit 20 minutes of turns; with five guests they would not.
    expect(() => parseNetwork({ ...f, round: { ...f.round, reveal_minutes: 20 } })).toThrow("reveal window");
    expect(() => parseNetwork({ ...f, guests: { ...f.guests, deposit: "0.3" } })).toThrow("deposit_max");
    expect(() => parseNetwork({ ...f, guests: { ...f.guests, masks: 1.5 } })).toThrow("whole numbers");
    const { guests: _, ...none } = f;
    expect(() => parseNetwork(none)).toThrow("guests");
  });
});

describe("the schedule and the code hash", () => {
  const daily = { first_minute: 1080, every_minutes: 1440 };
  const at = (iso: string) => Date.parse(iso);

  it("the slot at or before a moment, and the one after it", () => {
    expect(slotAt(daily, at("2026-11-11T18:04:00Z"))).toBe(at("2026-11-11T18:00:00Z"));
    expect(slotAt(daily, at("2026-11-11T18:00:00Z"))).toBe(at("2026-11-11T18:00:00Z"));
    expect(slotAt(daily, at("2026-11-11T17:59:59Z"))).toBe(at("2026-11-10T18:00:00Z"));
    expect(slotAfter(daily, at("2026-11-11T17:59:59Z"))).toBe(at("2026-11-11T18:00:00Z"));
    expect(slotAfter(daily, at("2026-11-11T18:00:00Z"))).toBe(at("2026-11-12T18:00:00Z"));
    // Before the first slot there is none yet.
    expect(slotAt(daily, 1000 * 60_000)).toBeNull();
    expect(slotAfter(daily, 1000 * 60_000)).toBe(1080 * 60_000);
  });

  it("a code hash reads back as the wasm's sha256", () => {
    // 32 bytes of 0x01, and 32 zero bytes: base58 keeps the leading zeros as 1s.
    expect(codeHashHex("4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi")).toBe("01".repeat(32));
    expect(codeHashHex("11111111111111111111111111111111")).toBe("00".repeat(32));
    expect(codeHashHex("0OIl")).toBeNull();
    expect(codeHashHex("abc")).toBeNull();
  });
});
