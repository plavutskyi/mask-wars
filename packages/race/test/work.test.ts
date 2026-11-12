/**
 * The masks at work on the jobs market, checked on a real chain with no network: `fixtures/jobs-work.json` is a tape of
 * everything eighteen passes of src/work.ts and src/sponsor.ts asked a local NEAR sandbox (the arena's jobs world: the
 * real jobs and crews contracts with no key, ten jobs of others in every phase) and what it answered, recorded by
 * scripts/jobs-sandbox.ts. Between the passes our team, people and the round did their part on that chain, as they
 * would on testnet. The replay runs the same passes, signs the same transactions byte for byte and must decide exactly
 * what the recording did: three masks take our team's drain alone and ORACLE is paid 0.95 NEAR, then the crew of three
 * takes one and every striker is paid 0.475 NEAR; then six people post drains on the house's round, the house bonds the
 * two the limits let through, the crew takes one and NOVA and ONYX the other, and both pay with nobody's hand on them.
 *
 * One thing the code does sooner than the recording did. The tape was made when the house took a waiting bond back only
 * once its job's work window was over (the recording's pass 12). It now takes one back as soon as the masks' plan seats
 * its mask no more: ORACLE's on F at pass 11, where an outsider's mask holds the slot. The replay sends there the very
 * transaction the recording sent a pass later, and the tape, a recording of a real chain, is left as it was made:
 * recording it again (pnpm --filter @maskwars/race jobs:sandbox, on the Linux sandbox) brings the two back in step.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SALT, outsideTermsBar, revealRuns, type Job, type JobBoard } from "@maskwars/arena/jobs";
import { bondOf, jobKeys, nearOf } from "../../../scripts/testnet/jobs-keys.mjs";
import { racePublicKey } from "../../../scripts/testnet/season-keys.mjs";
import { raceKey } from "../src/keys.ts";
import { FailoverRpc, RpcError } from "../src/near-tx.ts";
import { packed, replayingFetch, unpacked } from "../src/tape.ts";
import { actKey, CREW_KEY_METHODS, drainContent, JOB_KEY_METHODS, jobSalt, jobTag, keepWorking, KEY_REFUSED, withoutSpentKeys, MAX_FAILED_PASSES, MAX_PASSES, MIN_REVEAL_MS, oursOn, outsideRules, plan, readFacts, RACE_MIN_MS, RETRY_MS, SETTLE_MS, STEP_MARGIN_MS, type Facts, type Pass } from "../src/work.ts";
import { NETWORKS, teams } from "@maskwars/network";
import { sponsorPlan } from "../src/sponsor.ts";
import { A, B, C, D, E, F, G, H, OUTSIDE, OWNER, about, housePass, masksPass, ours, replay, replayed, tape } from "./jobs-tape.ts";

describe("the masks at work, replayed from the sandbox", () => {
  it("was recorded against the contracts as they are: a change to them records the tape again", () => {
    for (const [file, sha] of Object.entries(about.sources)) {
      const now = createHash("sha256").update(readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8")).digest("hex");
      expect(now, `${file} changed since the tape was recorded: pnpm --filter @maskwars/race jobs:sandbox`).toBe(sha);
    }
    expect(Object.keys(about.sources)).toContain("contracts/jobs/src/lib.rs");
  });

  it("decides and signs, pass by pass, the masks' and the house's, exactly what the recording did, and asks the chain nothing more", async () => {
    const r = await replayed();
    expect(r.seen).toHaveLength(tape.passes.length);
    // Every pass but the two of the house around the bond nobody took: decided and signed as recorded, to the byte.
    for (let n = 1; n <= tape.passes.length; n++) if (n !== 11 && n !== 12) expect(r.seen[n - 1], `pass ${n}`).toEqual(tape.passes[n - 1]);
    const [was11, was12] = [tape.passes[10]!, tape.passes[11]!];
    const [now11, now12] = [r.seen[10]!, r.seen[11]!];
    // Pass 11: the house takes ORACLE's bond on F back now, with the transaction the recording sent at pass 12. The
    // tape answers a transaction only when it is the recorded one byte for byte: the same hash, and it went through.
    expect(was11.done).toEqual([]);
    expect(now11.done).toEqual(was12.done);
    expect(now11.done).toEqual([{ what: `the house takes back its bonds of ORACLE on ${F}: 0.05 NEAR`, ok: true, sent: true, hash: was12.done[0]!.hash }]);
    // It still locks nothing there, for the reasons it gave then; IVY's second job now names her first, which holds
    // her one place, before the round's two.
    expect({ ...now11, done: [], skips: [] }).toEqual({ ...was11, skips: [] });
    const said = (skips: typeof now11.skips) => Object.fromEntries(skips.map((s) => [s.job, s.why]));
    expect(said(now11.skips)).toEqual({ ...said(was11.skips), [E]: `no bond of the house: our masks are on 1 job of ${about.people.ivy} already: 1 at a time from one client` });
    // Pass 12: the tape's chain at that block still shows the bond, since the recording took it back only then. So the
    // replayed pass decides the same act again, and the tape holds no second answer for it: on a chain that had seen
    // pass 11, no bond would wait here. Everything else of the pass is as recorded.
    expect(now12.done).toEqual([{ what: was12.done[0]!.what, ok: false, sent: true, hash: null, error: expect.stringContaining("not recorded") }]);
    expect({ ...now12, done: [] }).toEqual({ ...was12, done: [] });
    expect(r.unasked).toEqual([]);
  }, 60_000);

  it("takes the first job alone, three masks as in break-safe-0004, and races its round", () => {
    const [p1] = tape.passes;
    expect(p1!.done.map((d) => d.what)).toEqual([
      `NOVA takes ${A} alone`,
      `NOVA seals its striker step on ${A}`,
      `ONYX takes ${A} alone`,
      `ONYX seals its striker step on ${A}`,
      `ORACLE takes ${A} alone`,
      `ORACLE seals its striker step on ${A}`,
    ]);
    expect(p1!.done.every((d) => d.ok && d.sent && d.hash)).toBe(true);
    expect(p1!.race).toEqual({ job: A, bounty: about.bounty, round: "race-0101", striker: null });
  });

  it("holds the crew until every seat's bond is there, then joins and enlists it with the masks' own keys", () => {
    const [, p2, p3] = tape.passes;
    expect(p2!.done).toEqual([]);
    expect(p2!.skips).toContainEqual({ job: B, why: `crew ${about.crew} waits for the bond of ONYX` });
    expect(p2!.skips).toContainEqual({ job: B, mask: "ONYX", why: `no bond waits for it: the owner locks it (jobs-bond.ps1 -Job ${B})` });
    expect(p3!.done.map((d) => d.what)).toEqual([
      `NOVA joins crew ${about.crew} v1`,
      `ONYX joins crew ${about.crew} v1`,
      `ORACLE enlists crew ${about.crew} (ORACLE, NOVA, ONYX) in ${B}`,
      `ORACLE seals its striker step on ${B}`,
      `NOVA seals its striker step on ${B}`,
      `ONYX seals its striker step on ${B}`,
    ]);
    expect(p3!.done.every((d) => d.ok)).toBe(true);
  });
  it("reveals every step after the work window, waits for the rounds, asks the judge, and the jobs pay", () => {
    const [, , , p4, p5, p6, p7, p8] = tape.passes;
    expect(p4!.done.filter((d) => d.what.includes(" reveals step #") && d.ok)).toHaveLength(6);
    // The outsider sealed first, and revealed first, the line NOVA would reveal with no tag: no step of ours is a copy.
    const onA = p5!.steps.filter((st) => st.job === A);
    const farm = onA.find((st) => st.mask === about.outsider)!;
    expect(farm.seq).toBe(0);
    expect(farm.content).toBe(`NOVA strikes round race-0101 on ${about.bounty}. The plan is sealed on the round and shows there once the round reveals it.`);
    const mine = p5!.steps.filter((st) => Object.values(about.masks).includes(st.mask));
    expect(mine).toHaveLength(6);
    for (const st of mine) {
      expect(st.revealed && st.copyOf === null, `${st.job} #${st.seq}`).toBe(true);
      expect(st.content).toMatch(/ Tag [0-9a-f]{32}\.$/);
    }
    expect(p5!.done).toEqual([]);
    expect(p5!.skips).toEqual(
      expect.arrayContaining([
        { job: A, why: "round race-0101 is still open: the judge waits for its outcome" },
        { job: B, why: "round race-0102 is still open: the judge waits for its outcome" },
      ]),
    );
    // The round's winner moves its job on: ORACLE won race-0101, NOVA race-0102.
    expect(p6!.done.map((d) => [d.what, d.note])).toEqual(
      expect.arrayContaining([
        [`ORACLE asks the judge on ${A}`, "decided"],
        [`NOVA asks the judge on ${B}`, "decided"],
      ]),
    );
    const paid = Object.fromEntries(p7!.done.map((d) => [d.what, d.note]));
    expect(paid[`ORACLE settles ${A}`]).toBe("paid ORACLE 0.95 NEAR · fee 0.05 · back to the client 0.433");
    expect(paid[`NOVA settles ${B}`]).toBe("paid ORACLE 0.475, NOVA 0.475, ONYX 0.475 NEAR · fee 0.075 · back to the client 0.381");
    expect(p8!.done).toEqual([]);
  });

  it("leaves others' work alone and says why: a round of another team, a private job its minds cannot seal yet", () => {
    const p1 = tape.passes[0]!;
    expect(p1.skips).toContainEqual({ job: "drain-0007", why: "round live-0008 was opened by dao.test.near, not by one of our teams" });
    expect(p1.skips.some((s) => /ai_review: the work is sealed for the judge's TEE key/.test(s.why))).toBe(true);
    // Nothing on any job of the world but ours, and the two of people's the limits let through, ever sent a transaction.
    for (const p of tape.passes) for (const d of p.done) expect(d.what).toMatch(new RegExp(`${A}|${B}|${C}|${F}|joins crew`));
    for (const p of tape.passes) for (const d of p.done) for (const refused of [D, E, G, H]) expect(d.what).not.toContain(refused);
  });
});

describe("jobs from outside, replayed: people post, the house bonds, the masks take, nobody's hand", () => {
  const NEAR = 10n ** 24n;
  const at = (n: number) => tape.passes[n - 1]!;

  it("the house locks the masks' bonds on the two jobs the limits let through, a job's bonds in one transaction, and on nothing else", () => {
    const p9 = at(9);
    expect(p9.who).toBe("house");
    expect(p9.done.map((d) => [d.what, d.ok])).toEqual([
      [`the house locks the bonds of ORACLE, NOVA, ONYX on ${C}: 0.162 NEAR`, true],
      [`the house locks the bonds of ORACLE, NOVA, ONYX on ${F}: 0.162 NEAR`, true],
    ]);
    expect(p9.done.every((d) => d.hash)).toBe(true);
    // Each refused job says its own limit, and the house locks nothing for it.
    expect(p9.skips).toEqual(
      expect.arrayContaining([
        { job: D, why: "no bond of the house: a job from outside with 0.2 NEAR of reward: our masks take one from 0.5 NEAR" },
        { job: E, why: `no bond of the house: our masks are on 1 job of ${about.people.ivy} already: 1 at a time from one client` },
        { job: G, why: `no bond of the house: our masks are on 2 jobs from outside on round race-0103 already: 2 a round, first opened first taken` },
        { job: H, why: `no bond of the house: MASK CHECK blocks its client ${about.people.mallory}: our masks do no work for it` },
      ]),
    );
  });

  it("the crew takes the first on the house's bonds, NOVA and ONYX the second alone, and the masks refuse the rest, each for its limit", () => {
    const p10 = at(10);
    expect(p10.who).toBeUndefined();
    expect(p10.done.map((d) => d.what)).toEqual([
      `ORACLE enlists crew ${about.crew} (ORACLE, NOVA, ONYX) in ${C}`,
      `ORACLE seals its striker step on ${C}`,
      `NOVA seals its striker step on ${C}`,
      `ONYX seals its striker step on ${C}`,
      `NOVA takes ${F} alone`,
      `NOVA seals its striker step on ${F}`,
      `ONYX takes ${F} alone`,
      `ONYX seals its striker step on ${F}`,
    ]);
    expect(p10.done.every((d) => d.ok && d.sent && d.hash)).toBe(true);
    expect(p10.skips).toEqual(
      expect.arrayContaining([
        { job: D, why: "a job from outside with 0.2 NEAR of reward: our masks take one from 0.5 NEAR" },
        { job: E, why: `our masks are on 1 job of ${about.people.ivy} already: 1 at a time from one client` },
        // An outside mask took one of F's three slots after the house bonded: the crew of three no longer fits.
        { job: F, why: `crew ${about.crew} needs 3 slots, the job has 2; its masks go alone` },
        { job: F, mask: "ORACLE", why: "no slot left" },
        { job: G, why: "our masks are on 2 jobs from outside on round race-0103 already: 2 a round, first opened first taken" },
        { job: H, why: `MASK CHECK blocks its client ${about.people.mallory}: our masks do no work for it` },
      ]),
    );
    // The house's round is the season's to race: the jobs' run races nothing of it.
    expect(p10.race).toBeNull();
  });

  it("the house takes back the bond no mask could take as soon as the job has no slot left, not once the work window is over", async () => {
    // As recorded: nothing at pass 11, the bond back at pass 12, once F's work window was over.
    expect(at(11).who).toBe("house");
    expect(at(11).done).toEqual([]);
    expect(at(12).done.map((d) => [d.what, d.ok])).toEqual([[`the house takes back its bonds of ORACLE on ${F}: 0.05 NEAR`, true]]);
    expect(at(18).done).toEqual([]);
    // As decided now, on what pass 11 read: F still takes masks for a quarter hour, and has no slot left for ORACLE.
    const p11 = await housePass(11);
    const f = p11.board.jobs.find((j) => j.id === F)!;
    expect([f.phase, f.slots - f.masks]).toEqual(["enlisting", 0]);
    expect(f.workUntil - p11.board.readAt).toBeGreaterThan(10 * 60_000);
    expect(p11.plan.acts).toEqual([{ kind: "unbond", job: F, masks: ["ORACLE"], back: 5n * 10n ** 22n }]);
    expect(p11.done.map((d) => [d.ok, d.hash])).toEqual([[true, at(12).done[0]!.hash]]);
    // And once nothing of the house is out, nothing is sent.
    const p18 = await housePass(18);
    expect([p18.waiting, p18.seated, p18.plan.acts, p18.plan.out]).toEqual([[], [], [], 0n]);
  });

  it("both jobs are revealed, judged by their round and paid by the crew's roles, with nobody's hand on them", () => {
    expect(at(13).done.filter((d) => / reveals step #/.test(d.what) && d.ok)).toHaveLength(5);
    expect(at(14).skips).toEqual(expect.arrayContaining([{ job: C, why: "round race-0103 is still open: the judge waits for its outcome" }]));
    // NOVA drained the round: it moves both jobs on.
    expect(at(15).done.map((d) => [d.what, d.note])).toEqual([
      [`NOVA asks the judge on ${C}`, "decided"],
      [`NOVA asks the judge on ${F}`, "decided"],
    ]);
    const paid = Object.fromEntries(at(16).done.map((d) => [d.what, d.note]));
    // The crew of three strikers shares the reward by its split; NOVA alone takes the second whole. 5% to the company.
    expect(paid[`NOVA settles ${C}`]).toBe("paid ORACLE 0.316, NOVA 0.316, ONYX 0.316 NEAR · fee 0.05 · back to the client 0.594");
    expect(paid[`NOVA settles ${F}`]).toBe("paid NOVA 0.95 NEAR · fee 0.05 · back to the client 0.471");
    expect(at(17).done).toEqual([]);
  });

  it("the house ends with every bond back: it is out only the gas of its transactions", () => {
    const spent = BigInt(about.houseBefore) - BigInt(about.houseAfter);
    expect(spent).toBeGreaterThan(0n);
    expect(spent).toBeLessThan(NEAR / 300n);
  });

  it("the bonds on people's jobs are the house's, and the masks take a bond its client locked for them on its own job as before: never", async () => {
    const p10 = await masksPass(10);
    for (const job of [C, F]) for (const name of ["ORACLE", "NOVA", "ONYX"]) expect(p10.facts!.bonds.get(`${job}/${about.masks[name]}`), `${job} ${name}`).toBe(5n * 10n ** 22n);
    // The same reading, as if IVY had locked the bonds on C herself: none of ours, on a job none of ours opened.
    const foreign = new Map(p10.facts!.foreignBonds);
    const bonds = new Map(p10.facts!.bonds);
    for (const name of ["ORACLE", "NOVA", "ONYX"]) {
      bonds.delete(`${C}/${about.masks[name]}`);
      foreign.set(`${C}/${about.masks[name]}`, about.people.ivy!);
    }
    const p = plan(p10.board, { ...p10.facts!, bonds, foreignBonds: foreign }, ours(about.crew));
    expect(p.acts.filter((a) => "job" in a && a.job === C)).toEqual([]);
  });
});

describe("the limits on jobs from outside, one fact at a time", () => {
  const masksOn = (p: ReturnType<typeof plan>, job: string) =>
    p.acts.flatMap((a) => (a.kind === "enlist" && a.job === job ? [a.mask] : a.kind === "enlist_crew" && a.job === job ? [...a.members] : [])).sort();
  const outside = (change: Partial<typeof OUTSIDE>) => ({ ...ours(about.crew), outside: { ...OUTSIDE, ...change } });

  it("a reward under the least and a bond over the most bar the job for every mask", async () => {
    const { board, facts } = await masksPass(10);
    const rich = plan(board, facts!, outside({ minReward: 2n * 10n ** 24n }));
    expect(masksOn(rich, C)).toEqual([]);
    expect(rich.skips).toContainEqual({ job: C, why: "a job from outside with 1 NEAR of reward: our masks take one from 2 NEAR. Its bond waits: the house takes back its own on its next pass" });
    const tight = plan(board, facts!, outside({ maxBond: 10n ** 22n }));
    expect(masksOn(tight, C)).toEqual([]);
    expect(tight.skips.some((s) => s.job === C && s.why.startsWith("a job from outside that asks a bond of 0.05 NEAR a mask: the house locks 0.01 at most"))).toBe(true);
  });

  it("first opened first taken: one a round takes the first job and leaves the second", async () => {
    const { board, facts } = await masksPass(10);
    const one = plan(board, facts!, outside({ perRound: 1 }));
    expect(masksOn(one, C)).toEqual(["NOVA", "ONYX", "ORACLE"]);
    expect(masksOn(one, F)).toEqual([]);
    expect(one.skips).toContainEqual({ job: F, why: "our masks are on 1 job from outside on round race-0103 already: 1 a round, first opened first taken. Its bond waits: the house takes back its own on its next pass" });
    // One of a client at a time, the same way: of two jobs of one client that each hold a bond, the first opened.
    const both = { ...board, jobs: board.jobs.map((j) => (j.id === F ? { ...j, client: about.people.ivy! } : j)) };
    const client = plan(both, facts!, outside({ perRound: 5 }));
    expect(masksOn(client, C)).toEqual(["NOVA", "ONYX", "ORACLE"]);
    expect(masksOn(client, F)).toEqual([]);
    expect(client.skips.some((s) => s.job === F && s.why.startsWith(`our masks are on 1 job of ${about.people.ivy} already: 1 at a time from one client`))).toBe(true);
  });

  it("a bond of the house waits an hour at most: a job from outside with long windows is never taken and never bonded", async () => {
    const { board, facts } = await masksPass(10);
    const MIN = 60_000;
    const windows = (work: number, reveal: number, appeal: number) => (j: Job): Job => (j.id === C ? { ...j, workUntil: j.openedAt + work * MIN, revealUntil: j.openedAt + (work + reveal) * MIN, appealMinutes: appeal } : j);
    const taken = (work: number, reveal = 30, appeal = 10) => plan({ ...board, jobs: board.jobs.map(windows(work, reveal, appeal)) }, facts!, ours(about.crew));
    // As posted on /jobs (40 minutes of work at most, 30 of reveals, 10 of appeal), and at the limits: taken.
    expect(masksOn(taken(40), C)).toEqual(["NOVA", "ONYX", "ORACLE"]);
    expect(masksOn(taken(60, 60, 60), C)).toEqual(["NOVA", "ONYX", "ORACLE"]);
    // Three days of work, the contract's longest: a bond would wait that long, and the reveal would come days later.
    const days = taken(3 * 24 * 60);
    expect(masksOn(days, C)).toEqual([]);
    expect(days.skips).toContainEqual({ job: C, why: "a job from outside with a work window of 4320 min: the house's bond waits for a mask 60 min at most. Its bond waits: the house takes back its own on its next pass" });
    expect(masksOn(taken(61), C)).toEqual([]);
    // A day of reveals, or of appeal: the contract's longest too.
    const reveals = taken(40, 24 * 60);
    expect(masksOn(reveals, C)).toEqual([]);
    expect(reveals.skips.some((s) => s.job === C && s.why.startsWith("a job from outside with a reveal window of 1440 min: our masks take one with 30 to 60 min"))).toBe(true);
    expect(masksOn(taken(40, 61), C)).toEqual([]);
    const appeals = taken(40, 30, 24 * 60);
    expect(masksOn(appeals, C)).toEqual([]);
    expect(appeals.skips.some((s) => s.job === C && s.why.startsWith("a job from outside with an appeal window of 1440 min: our masks take one with 60 min at most"))).toBe(true);
    // The house reads the same bar before it locks anything: no bond on such a job, and the next one gets its place.
    const p9 = await housePass(9);
    const long = sponsorPlan({ ...p9.board, jobs: p9.board.jobs.map(windows(3 * 24 * 60, 30, 10)) }, p9.facts!, ours(about.crew), p9.house!, p9.waiting);
    expect(long.acts.filter((a) => a.kind === "bond").map((a) => a.job)).toEqual([E, F]);
    expect(long.skips).toContainEqual({ job: C, why: "no bond of the house: a job from outside with a work window of 4320 min: the house's bond waits for a mask 60 min at most" });
    // Our own jobs keep the contract's windows: none of this bars them.
    const { board: b1, facts: f1 } = await firstPass();
    const ownLong = { ...b1, jobs: b1.jobs.map((j) => (j.id === A ? { ...j, workUntil: j.openedAt + 3 * 24 * 60 * MIN, revealUntil: j.openedAt + 4 * 24 * 60 * MIN } : j)) };
    expect(takes(plan(ownLong, f1, ours(null)))).toEqual(["NOVA", "ONYX", "ORACLE"]);
  });

  it("only with our own runs sure to come while its steps can be revealed: two of the site's clock inside the reveal window", async () => {
    const { board, facts } = await masksPass(10);
    const MIN = 60_000;
    const mainnet = outsideRules(NETWORKS.mainnet);
    const live = { ...ours(about.crew), outside: mainnet };
    const utc = (hh: number, mm: number, ss = 0) => Date.UTC(2026, 10, 13, hh, mm, ss);
    const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16);
    /** IVY's job, as if opened at `openedAt` on a round that still seals, read a minute later. */
    const opened = (openedAt: number, work: number, reveal = 30) => ({
      board: { ...board, readAt: openedAt + MIN, jobs: board.jobs.map((j) => (j.id === C ? { ...j, openedAt, workUntil: openedAt + work * MIN, revealUntil: openedAt + (work + reveal) * MIN } : j)) },
      facts: { ...facts!, rounds: new Map([...facts!.rounds].map(([k, r]) => [k, { ...r, commitUntil: openedAt + 45 * MIN }] as const)) },
    });
    const on = (openedAt: number, work: number, reveal = 30) => {
      const o = opened(openedAt, work, reveal);
      return plan(o.board, o.facts, live);
    };
    // Posted at 18:05 on the house's round: it works until 18:44 and reveals until 19:14. The site's clock runs at
    // 18:49 and 18:59 then (19:09 comes too close to the end to count): the masks take it.
    const day = opened(utc(18, 5), 39).board.jobs.find((j) => j.id === C)!;
    expect(revealRuns(day, mainnet.clock).map(hhmm)).toEqual(["18:49", "18:59"]);
    expect(masksOn(on(utc(18, 5), 39), C)).toEqual(["NOVA", "ONYX", "ORACLE"]);
    // The same job at night, on a hand round of ours: no run of the clock comes while its steps can be revealed, and a
    // seat that reveals nothing loses half its bond. The masks leave it, and the house locks nothing on it.
    const night = on(utc(3, 0), 39);
    expect(masksOn(night, C)).toEqual([]);
    expect(night.skips).toContainEqual({
      job: C,
      why: "a job from outside whose steps are revealed from 03:39 to 04:09 UTC: the site's clock runs 0 times then, and our masks take one only with 2 runs of ours sure to reveal. Its bond waits: the house takes back its own on its next pass",
    });
    // One run is not two: a round the house opened as late as 19:04 reveals from 19:44 to 20:14, with 19:59 alone.
    const late = on(utc(19, 5), 39);
    expect(masksOn(late, C)).toEqual([]);
    expect(late.skips.some((s) => s.job === C && /from 19:44 to 20:14 UTC: the site's clock runs 1 time then/.test(s.why))).toBe(true);
    // The clock is the network's: where none is counted on (the sandbox of the tape), nothing is asked of it.
    expect(OUTSIDE.revealRuns).toBe(0);
    const o = opened(utc(3, 0), 39);
    expect(masksOn(plan(o.board, o.facts, ours(about.crew)), C)).toEqual(["NOVA", "ONYX", "ORACLE"]);

    // A job posted on /jobs always passes: whenever the house opened its round within five minutes of the first tick
    // (18:04), whenever the person posted while the sheet was open (25 minutes before the seals end at the latest), and
    // however long the wallet took to sign (up to three minutes): 40 minutes of work at most, to five before the seals
    // end, 30 of reveals, 10 of appeal.
    for (let open = utc(18, 4); open < utc(18, 9); open += 20_000) {
      const sealUntil = open + NETWORKS.mainnet.round.commit_minutes * MIN;
      for (let shown = open; sealUntil - shown >= 25 * MIN; shown += MIN) {
        const work = Math.min(40, Math.floor((sealUntil - shown) / MIN) - 5);
        for (const signing of [0, 60_000, 180_000]) {
          const openedAt = shown + signing;
          const job = { reward: (10n ** 24n).toString(), bond: (5n * 10n ** 22n).toString(), openedAt, workUntil: openedAt + work * MIN, revealUntil: openedAt + (work + 30) * MIN, appealMinutes: 10 };
          expect(outsideTermsBar(job, mainnet), `round at ${hhmm(open)}, posted at ${hhmm(shown)}, signed in ${signing / 1000} s`).toBeNull();
        }
      }
    }
  });

  it("a mask keeps its other places for our own jobs: past `seats` it takes no more from outside, whatever the round allows", async () => {
    const { board, facts } = await masksPass(10);
    const p = plan(board, facts!, outside({ seats: 1, perRound: 5 }));
    expect(masksOn(p, C)).toEqual(["NOVA", "ONYX", "ORACLE"]);
    expect(masksOn(p, F)).toEqual([]);
    expect(p.skips.some((s) => s.job === F && /on 1 job from outside already: its other places stay for our own jobs/.test(s.why))).toBe(true);
    // However the limits are set, no plan puts a mask on more jobs from outside than `seats`.
    for (const seats of [1, 2, 3]) {
      for (const perRound of [1, 2, 5]) {
        const q = plan(board, facts!, outside({ seats, perRound, perClient: 3 }));
        const on = new Map<string, number>();
        for (const j of [C, D, E, F, G, H]) for (const m of masksOn(q, j)) on.set(m, (on.get(m) ?? 0) + 1);
        for (const [m, n] of on) expect(n, `${m}, seats ${seats}, ${perRound} a round`).toBeLessThanOrEqual(seats);
      }
    }
  });

  it("MASK CHECK first: with no word on a client, or no answer, nothing of it is taken", async () => {
    const { board, facts } = await masksPass(10);
    const unasked = plan(board, (({ clients: _, ...rest }) => rest)(facts!), ours(about.crew));
    for (const j of [C, D, E, F, G, H]) expect(masksOn(unasked, j), j).toEqual([]);
    expect(unasked.skips.some((s) => s.job === C && s.why.startsWith(`MASK CHECK was not asked about its client ${about.people.ivy}: a job from outside waits for it`))).toBe(true);
    const silent = plan(board, { ...facts!, clients: new Map([...facts!.clients!, [about.people.ivy!, null]]) }, ours(about.crew));
    expect(masksOn(silent, C)).toEqual([]);
    expect(silent.skips.some((s) => s.job === C && s.why.startsWith(`MASK CHECK did not answer on its client ${about.people.ivy}`))).toBe(true);
    // Our own jobs need no word from it: the first pass took our team's job with no check asked.
    const { board: b1, facts: f1 } = await firstPass();
    expect(takes(plan(b1, f1, ours(null)))).toEqual(["NOVA", "ONYX", "ORACLE"]);
  });

  it("our own jobs are never from outside: no limit of these applies to them", async () => {
    const { board, facts } = await firstPass();
    const strict = { ...ours(null), outside: { ...OUTSIDE, minReward: 10n ** 30n, maxBond: 1n, perRound: 1, perClient: 1, seats: 1, maxOut: 0n, maxWorkMs: 0, maxRevealMs: 0, maxAppealMinutes: 0, revealRuns: 99 } };
    expect(takes(plan(board, facts, strict))).toEqual(["NOVA", "ONYX", "ORACLE"]);
  });

  it("the workflow's side on mainnet: the house is one of our own accounts, and the limits are the network's", () => {
    const m = NETWORKS.mainnet;
    const o = oursOn(m, { masks: m.masks, signers: Object.keys(m.masks), crew: "arena-trio" });
    expect(o.owners).toEqual(["maskwars.near", "season.maskwars.near", "house.maskwars.near"]);
    expect(o.teams).toEqual([...teams(m)]);
    expect(o.raceTeams).toEqual(["maskwars.near"]);
    expect(o.outside).toEqual(outsideRules(m));
    // The recording ran the same limits, but for the site's clock, which a sandbox does not have.
    expect(o.outside).toEqual({ ...OUTSIDE, revealRuns: 2 });
    expect(o.outside).toMatchObject({ maxOut: 624n * 10n ** 21n, maxWorkMs: 3_600_000, maxRevealMs: 3_600_000, maxAppealMinutes: 60, clock: { first_minute: 1080, every_minutes: 1440 } });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The decisions, on a real board read from the tape and facts changed one at a time
// ---------------------------------------------------------------------------------------------------------------

/** The board and the facts of the first pass, read from the tape. */
async function firstPass(): Promise<{ board: JobBoard; facts: Facts }> {
  const { jobs, chain } = replay(replayingFetch(tape).fetch);
  const board = await jobs.board();
  return { board, facts: await readFacts(chain, board, ours(null), about.crews) };
}

const takes = (p: ReturnType<typeof plan>, job = A) => p.acts.filter((a) => a.kind === "enlist" && a.job === job).map((a) => a.mask);

describe("what a mask takes", () => {
  it("only with a bond locked for it: the key it signs with attaches no NEAR", async () => {
    const { board, facts } = await firstPass();
    expect(takes(plan(board, facts, ours(null)))).toEqual(["NOVA", "ONYX", "ORACLE"]);
    const bonds = new Map(facts.bonds);
    bonds.delete(`${A}/${about.masks.ONYX}`);
    bonds.set(`${A}/${about.masks.NOVA}`, 1n);
    const p = plan(board, { ...facts, bonds }, ours(null));
    expect(takes(p)).toEqual(["ORACLE"]);
    expect(p.skips).toContainEqual({ job: A, mask: "NOVA", why: "the bond waiting for it is less than this job's" });
    expect(p.acts.some((a) => a.kind === "step" && a.mask === "ONYX")).toBe(false);
  });

  it("only on a round of our team that lets it in, still open", async () => {
    const { board, facts } = await firstPass();
    const key = `${about.bounty}/race-0101`;
    const round = facts.rounds.get(key)!;
    const withRound = (r: typeof round) => ({ ...facts, rounds: new Map([...facts.rounds, [key, r]]) });
    expect(takes(plan(board, withRound({ ...round, owner: "mallory.test.near" }), ours(null)))).toEqual([]);
    expect(takes(plan(board, withRound({ ...round, state: "drained" }), ours(null)))).toEqual([]);
    expect(takes(plan(board, withRound({ ...round, masks: [about.masks.ORACLE!] }), ours(null)))).toEqual(["ORACLE"]);
    expect(takes(plan(board, withRound({ ...round, masks: null }), ours(null)))).toEqual([]);
    const elsewhere = plan(board, facts, { ...ours(null), bounties: ["other-bounty.test.near"] });
    expect(takes(elsewhere)).toEqual([]);
    expect(elsewhere.skips).toContainEqual({ job: A, why: `the round is on ${about.bounty}, not a bounty contract of ours. Its bond waits: jobs-bond.ps1 -Job ${A} -Unbond` });
  });

  it("not when the work window closes too soon to seal, nor without its seed, nor past its slots", async () => {
    const { board, facts } = await firstPass();
    const job = board.jobs.find((j) => j.id === A)!;
    const late = { ...board, readAt: job.workUntil - STEP_MARGIN_MS };
    expect(takes(plan(late, facts, ours(null)))).toEqual([]);
    expect(takes(plan(board, facts, { ...ours(null), signers: ["NOVA"] }))).toEqual(["NOVA"]);
    // FARM holds one slot of the four already.
    const tight = { ...board, jobs: board.jobs.map((j) => (j.id === A ? { ...j, slots: 3 } : j)) };
    const p = plan(tight, facts, ours(null));
    expect(takes(p)).toEqual(["NOVA", "ONYX"]);
    expect(p.skips).toContainEqual({ job: A, mask: "ORACLE", why: "no slot left" });
  });

  it("not on a job with a reveal window a scheduled run may miss, nor on a round it can no longer win", async () => {
    const { board, facts } = await firstPass();
    const short = { ...board, jobs: board.jobs.map((j) => (j.id === A ? { ...j, revealUntil: j.workUntil + MIN_REVEAL_MS - 60_000 } : j)) };
    const p = plan(short, facts, ours(null));
    expect(takes(p)).toEqual([]);
    expect(p.skips.some((s) => s.job === A && /reveal window is 29 min/.test(s.why))).toBe(true);
    const key = `${about.bounty}/race-0101`;
    const round = facts.rounds.get(key)!;
    const closed = { ...facts, rounds: new Map([...facts.rounds, [key, { ...round, commitUntil: board.readAt - 1, sealedBy: [about.masks.ORACLE!] }]]) };
    // The commit window is over: only the mask that sealed in it can still win.
    expect(takes(plan(board, closed, ours(null)))).toEqual(["ORACLE"]);
  });

  it("only on a bond one of our accounts locked, or on a job one of them opened: an outsider cannot fill its live seats", async () => {
    // The same first pass, read as if the owner who locked the three bonds on A were a stranger.
    const as = async (owners: string[]) => {
      const { jobs, chain } = replay(replayingFetch(tape).fetch);
      const board = await jobs.board();
      const o = { ...ours(null), owners };
      return { board, o, facts: await readFacts(chain, board, o, about.crews) };
    };
    // Our own accounts here are the house's alone: the team that opened A and the owner who bonded it are strangers.
    const stranger = await as([about.house]);
    const job = stranger.board.jobs.find((j) => j.id === A)!;
    expect(stranger.o.owners).not.toContain(job.client);
    expect([...stranger.facts.bonds.keys()].filter((k) => k.startsWith(`${A}/`))).toEqual([]);
    expect(stranger.facts.foreignBonds?.get(`${A}/${about.masks.NOVA}`)).toBe(OWNER);
    // MASK CHECK lets its client through and the job clears every limit on jobs from outside: only the bond bars it.
    const p = plan(stranger.board, { ...stranger.facts, clients: new Map([[job.client, "allow"]]) }, stranger.o);
    expect(takes(p)).toEqual([]);
    expect(p.acts.filter((a) => "job" in a && a.job === A)).toEqual([]);
    expect(p.race).toBeNull();
    expect(p.skips).toContainEqual({ job: A, why: `its bond was locked by ${OWNER} on a job ${job.client} opened, neither ours: a mask takes only our own bonds, so no outsider fills its 4 live seats` });
    // Whoever locked it, a bond on a job one of our accounts opened is taken: the job is ours.
    const client = await as([job.client]);
    expect(takes(plan(client.board, client.facts, client.o))).toEqual(["NOVA", "ONYX", "ORACLE"]);
    expect(client.facts.foreignBonds?.size).toBe(0);
  });

  it("names a mask's bond that waits on a job it will not take, so the owner takes it back", async () => {
    const { board, facts } = await firstPass();
    const p = plan(board, facts, { ...ours(null), signers: ["NOVA", "ORACLE"] });
    expect(p.skips).toContainEqual({ job: A, mask: "ONYX", why: `no seed in MASK_KEYS. Its bond waits: jobs-bond.ps1 -Job ${A} -Unbond` });
  });

  it("races only a hand round of ours nobody sealed in yet, with time left to seal the plan", async () => {
    const { board, facts } = await firstPass();
    const key = `${about.bounty}/race-0101`;
    const round = facts.rounds.get(key)!;
    const withRound = (r: typeof round) => ({ ...facts, rounds: new Map([...facts.rounds, [key, r]]) });
    expect(plan(board, facts, ours(null)).race).toEqual({ job: A, bounty: about.bounty, round: "race-0101", striker: null });
    expect(plan(board, withRound({ ...round, seals: 1 }), ours(null)).race).toBeNull();
    expect(plan(board, withRound({ ...round, commitUntil: board.readAt + RACE_MIN_MS - 1 }), ours(null)).race).toBeNull();
    // The season races its own rounds: a round of a team that is ours but not a hand team is taken, not raced.
    const season = plan(board, facts, { ...ours(null), raceTeams: ["season.test.near"] });
    expect(season.race).toBeNull();
    expect(takes(season)).toEqual(["NOVA", "ONYX", "ORACLE"]);
    // A round with a person's mask on its list is raced by hand, with the keeper: the workflow takes it and races nothing.
    const people = plan(board, withRound({ ...round, masks: [...round.masks!, "kira.masks.test.near"] }), ours(null));
    expect(people.race).toBeNull();
    expect(takes(people)).toEqual(["NOVA", "ONYX", "ORACLE"]);
  });

  it("names the striker of a crew with roles, who plays whatever any of our masks finds in the race", async () => {
    const { board, facts } = await firstPass();
    const seat = (name: string, role: "scout" | "striker" | "verifier") => ({ mask: about.masks[name]!, role, joined: true });
    const crew = (seats: ReturnType<typeof seat>[]) => ({ ...facts, crew: { id: "roles", captain: about.masks.ORACLE!, seats, version: 1 } });
    const roles = plan(board, crew([seat("NOVA", "scout"), seat("ORACLE", "striker"), seat("ONYX", "verifier")]), ours("roles"));
    expect(roles.acts.filter((a) => a.kind === "enlist_crew").map((a) => a.mask)).toEqual(["ORACLE"]);
    expect(roles.acts.filter((a) => a.kind === "step").map((a) => [a.mask, a.kind === "step" ? a.role : null])).toEqual([
      ["NOVA", "scout"],
      ["ORACLE", "striker"],
      ["ONYX", "verifier"],
    ]);
    expect(roles.race).toEqual({ job: A, bounty: about.bounty, round: "race-0101", striker: "ORACLE" });
    // Three strikers, or a striker with no seed here: no one to name, and the finder plays its own plan.
    expect(plan(board, crew([seat("NOVA", "striker"), seat("ORACLE", "striker"), seat("ONYX", "striker")]), ours("roles")).race?.striker).toBeNull();
    const unsigned = plan(board, crew([seat("NOVA", "scout"), seat("ORACLE", "striker"), seat("ONYX", "verifier")]), { ...ours("roles"), signers: ["NOVA", "ONYX"] });
    expect(unsigned.race?.striker ?? null).toBeNull();
    // A round raced elsewhere (the season's): the finder plays, so a crew with roles could win nothing and its masks
    // go alone, each its own striker. A crew of strikers takes it.
    const elsewhere = { ...ours("roles"), raceTeams: ["season.test.near"] };
    const alone = plan(board, crew([seat("NOVA", "scout"), seat("ORACLE", "striker"), seat("ONYX", "verifier")]), elsewhere);
    expect(alone.acts.some((a) => a.kind === "enlist_crew")).toBe(false);
    expect(takes(alone)).toEqual(["NOVA", "ONYX", "ORACLE"]);
    expect(alone.skips.some((s) => s.job === A && /crew roles has roles, and round race-0101 is raced elsewhere/.test(s.why))).toBe(true);
    const strikers = plan(board, crew([seat("NOVA", "striker"), seat("ORACLE", "striker"), seat("ONYX", "striker")]), elsewhere);
    expect(strikers.acts.filter((a) => a.kind === "enlist_crew").map((a) => a.mask)).toEqual(["ORACLE"]);
  });

  it("follows the round the run raced while it is open, and drops a judge run that never answered", async () => {
    const { board, facts } = await firstPass();
    expect(plan(board, facts, ours(null)).waits).toBe(false);
    expect(plan(board, facts, { ...ours(null), follow: "race-0101" }).waits).toBe(true);
    expect(plan(board, facts, { ...ours(null), follow: "race-0999" }).waits).toBe(false);
    // A job of ours whose judge run is out past its blocks: the mask on it drops it.
    const nova = { mask: { account: about.masks.NOVA!, name: "NOVA", slug: null, forged: false }, role: "striker" as const, left: false, bond: { amount: "0", by: null, lost: null, why: null }, burned: "0", covered: null, steps: 1, payout: null };
    const judging = { ...board, jobs: board.jobs.map((j) => (j.id === A ? { ...j, phase: "judging" as const, entrants: [{ index: 0, crew: null, version: 0, split: { scout: 0, striker: 10000, verifier: 0 }, won: false, members: [nova] }] } : j)) };
    expect(plan(judging, { ...facts, stuck: new Set([A]) }, ours(null)).acts).toContainEqual({ kind: "unstick", mask: "NOVA", job: A });
    expect(plan(judging, facts, ours(null)).acts.filter((a) => "job" in a && a.job === A)).toEqual([]);
  });

  it("moves a job on with another mask once the mover's key is spent, and sends nothing more from that key", async () => {
    const { board, facts } = await firstPass();
    const member = (name: string) => ({ mask: { account: about.masks[name]!, name, slug: null, forged: false }, role: "striker" as const, left: false, bond: { amount: "0", by: null, lost: null, why: null }, burned: "0", covered: null, steps: 1, payout: null });
    const waiting = { ...board, jobs: board.jobs.map((j) => (j.id === A ? { ...j, phase: "judging" as const, entrants: ["NOVA", "ONYX", "ORACLE"].map((n, index) => ({ index, crew: null, version: 0, split: { scout: 0, striker: 10000, verifier: 0 }, won: false, members: [member(n)] })) } : j)) };
    const first = plan(waiting, { ...facts, stuck: new Set([A]) }, ours(null)).acts.find((a) => a.kind === "unstick")!;
    // The chain would not take that mask's transaction (its allowance is spent): the next pass picks another mask.
    for (const why of ["NotEnoughAllowance", "AccessKeyNotFound"]) expect(KEY_REFUSED.test(`send_tx: InvalidTransaction {"InvalidAccessKeyError":{"${why}":{}}}`)).toBe(true);
    expect(KEY_REFUSED.test("send_tx: InvalidNonce")).toBe(false);
    const left = withoutSpentKeys(ours(null), new Set([`key/${first.mask}`]));
    expect(left.signers).not.toContain(first.mask);
    const next = plan(waiting, { ...facts, stuck: new Set([A]) }, left).acts.find((a) => a.kind === "unstick")!;
    expect(next.mask).not.toBe(first.mask);
    expect(withoutSpentKeys(ours(null), new Set(["enlist/x/NOVA"]))).toEqual(ours(null));
  });
});

describe("the step a mask seals and the keys it signs with", () => {
  const seed = about.seeds.NOVA!;

  it("rebuilds its salt and content from its seed alone, the same on every pass", () => {
    const salt = jobSalt(seed, about.jobs, A);
    expect(salt).toMatch(SALT);
    expect(jobSalt(seed, about.jobs, A)).toBe(salt);
    expect(jobSalt(seed, about.jobs, B)).not.toBe(salt);
    expect(jobSalt(about.seeds.ONYX!, about.jobs, A)).not.toBe(salt);
    const round = { bounty: about.bounty, id: "race-0101" };
    const tag = jobTag(seed, about.jobs, A);
    expect(tag).toMatch(/^[0-9a-f]{32}$/);
    expect(jobTag(seed, about.jobs, B)).not.toBe(tag);
    expect(jobTag(about.seeds.ONYX!, about.jobs, A)).not.toBe(tag);
    const c = drainContent("NOVA", "striker", round, tag);
    expect(Buffer.byteLength(c)).toBeLessThanOrEqual(1024);
    expect(c).toContain(tag);
    // Nobody can seal the mask's line first: without its seed, nobody knows the tag in it.
    expect(drainContent("NOVA", "striker", round, jobTag(about.seeds.ONYX!, about.jobs, A))).not.toBe(c);
    expect(() => drainContent("NOVA", "striker", round, "x")).toThrow("16 bytes");
  });

  it("signs with the keys the owner's script puts on chain: the same seeds, the jobs and crews contracts", () => {
    const keys = jobKeys({ NOVA: { seed } }, about.jobs, about.crews, ["nova"]);
    expect(keys.nova!.jobs).toBe(raceKey(seed, about.jobs).publicKeyText);
    expect(keys.nova!.crews).toBe(raceKey(seed, about.crews).publicKeyText);
    expect(keys.nova!.jobs).toBe(racePublicKey(seed, about.jobs));
    expect(() => jobKeys({}, about.jobs, about.crews, ["onyx"])).toThrow("no seed");
  });

  it("locks the job's bond with its record's storage, and near.exe gets it in NEAR", () => {
    const b = bondOf({ id: A, phase: "enlisting", terms: { kind: "drain", bond: (10n ** 22n).toString() } });
    expect(b).toEqual({ job: A, kind: "drain", phase: "enlisting", bond: "10000000000000000000000", deposit: "0.014" });
    expect(nearOf(5n * 10n ** 22n + 4n * 10n ** 21n)).toBe("0.054");
    expect(nearOf(10n ** 24n)).toBe("1");
    expect(() => bondOf(null)).toThrow("no such job");
  });
});

describe("the tape", () => {
  it("keeps a view's bytes as base64 and gives back exactly the chain's answer", () => {
    const answer = { jsonrpc: "2.0", id: "x", result: { result: [...Buffer.from('{"a":1}')], logs: [], block_height: 7 } };
    const p = packed(answer) as { result: Record<string, unknown> };
    expect(p.result["result_b64"]).toBe(Buffer.from('{"a":1}').toString("base64"));
    expect(p.result["result"]).toBeUndefined();
    expect(unpacked(p)).toEqual(answer);
    expect(packed({ result: { header: { height: 1 } } })).toEqual({ result: { header: { height: 1 } } });
  });
});

describe("one run of the workflow", () => {
  /** A pass as the run sees it: read at `at`, with `moved` acts that went through and the next deadline. */
  const fake = (at: number, moved: number, next: number | null, waits = false): Pass =>
    ({
      board: { readAt: at } as JobBoard,
      facts: null,
      plan: { acts: [], skips: [], race: null, next, waits },
      done: Array.from({ length: moved }, () => ({ act: { kind: "settle", mask: "NOVA", job: A } as const, ok: true, sent: true, hash: "h" })),
    }) as Pass;

  /** A clock the run's sleeps move on, and passes read at it. */
  function run(script: { moved: number; next: number | null; waits?: boolean }[], waitMinutes: number, pollMs?: number) {
    let clock = 1_000_000;
    const slept: number[] = [];
    let i = 0;
    return keepWorking({
      pass: async () => {
        const s = script[Math.min(i++, script.length - 1)]!;
        return fake(clock, s.moved, s.next === null ? null : clock + s.next, s.waits);
      },
      waitMinutes,
      ...(pollMs ? { pollMs } : {}),
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    }).then((passes) => ({ passes: passes.length, slept }));
  }

  it("makes one pass with no time to wait: the take job, before the race", async () => {
    expect(await run([{ moved: 3, next: 60_000 }], 0)).toEqual({ passes: 1, slept: [] });
  });

  it("passes again a few blocks after a pass that moved, waits for a window that comes in time, and stops when none does", async () => {
    const r = await run(
      [
        { moved: 6, next: 5 * 60_000 }, // reveals
        { moved: 0, next: 5 * 60_000 }, // the reveal window is still open: wait for its end
        { moved: 1, next: null }, // the judge answered
        { moved: 1, next: null }, // settled
        { moved: 0, next: null }, // nothing left
      ],
      12,
    );
    // A few blocks after each pass that moved, so the next reading is past its transactions.
    expect(r).toEqual({ passes: 5, slept: [SETTLE_MS, 5 * 60_000 + 20_000, SETTLE_MS, SETTLE_MS] });
  });

  it("leaves a window past its time for a later run", async () => {
    expect(await run([{ moved: 0, next: 13 * 60_000 }], 12)).toEqual({ passes: 1, slept: [] });
  });

  it("in a run that raced, asks again every little while for the round's outcome, and calls the judge once it is over", async () => {
    const r = await run(
      [
        { moved: 0, next: 37 * 60 * 60_000, waits: true }, // the reveal window is over, the round still runs
        { moved: 0, next: 37 * 60 * 60_000, waits: true },
        { moved: 1, next: null }, // drained: the judge answered
        { moved: 1, next: null }, // settled
        { moved: 0, next: null },
      ],
      100,
      2 * 60_000,
    );
    expect(r).toEqual({ passes: 5, slept: [120_000, 120_000, SETTLE_MS, SETTLE_MS] });
    // Without a race of its own the run does not poll: the round's end comes to a later run.
    expect(await run([{ moved: 0, next: 37 * 60 * 60_000, waits: true }], 12)).toEqual({ passes: 1, slept: [] });
  });

  it("tries a pass the chain did not answer again a minute later, a few times, and only with time to wait", async () => {
    let clock = 0;
    let calls = 0;
    const slept: number[] = [];
    const flaky = (failing: number, waitMinutes: number) =>
      keepWorking({
        pass: async () => {
          calls += 1;
          if (calls <= failing) throw new Error("every endpoint failed");
          return fake(clock, 0, null);
        },
        waitMinutes,
        now: () => clock,
        sleep: async (ms) => {
          slept.push(ms);
          clock += ms;
        },
      });
    expect((await flaky(2, 12)).length).toBe(1);
    expect(slept).toEqual([RETRY_MS, 2 * RETRY_MS]);
    calls = 0;
    await expect(flaky(MAX_FAILED_PASSES, 12)).rejects.toThrow("every endpoint failed");
    calls = 0;
    await expect(flaky(1, 0)).rejects.toThrow("every endpoint failed");
  });

  it("never makes more than MAX_PASSES passes, whatever keeps moving", async () => {
    expect((await run([{ moved: 1, next: null }], 120)).passes).toBe(MAX_PASSES);
  });
});

describe("calls that cost a key's allowance for nothing", () => {
  it("are not sent again in a run once the chain refused them, and a crew refused on a job lets its masks go alone", async () => {
    const { board, facts } = await firstPass();
    // The crews contract waits for new code: no crew enlists, so the masks go alone.
    const changing = plan(board, { ...facts, crew: { id: about.crew, captain: about.masks.ORACLE!, version: 1, seats: Object.values(about.masks).map((m) => ({ mask: m, role: "striker" as const, joined: true })) }, crewsChanging: true }, ours(about.crew));
    expect(takes(changing)).toEqual(["NOVA", "ONYX", "ORACLE"]);
    expect(changing.skips.some((s) => s.job === A && /new code waits on/.test(s.why))).toBe(true);
    const refusedCrew = plan(board, { ...facts, crew: { id: about.crew, captain: about.masks.ORACLE!, version: 1, seats: Object.values(about.masks).map((m) => ({ mask: m, role: "striker" as const, joined: true })) }, crewRefused: new Set([A]) }, ours(about.crew));
    expect(takes(refusedCrew)).toEqual(["NOVA", "ONYX", "ORACLE"]);
    expect(actKey({ kind: "enlist_crew", mask: "ORACLE", crew: about.crew, job: A, members: [] })).toBe(`enlist_crew/${A}/ORACLE`);
    expect(actKey({ kind: "join", mask: "NOVA", crew: about.crew, version: 1 })).toBe(`join/${about.crew}/NOVA`);
  });

  it("keep the owner's key script and the workflow on the same methods", () => {
    const ps1 = readFileSync(new URL("../../../scripts/testnet/jobs-keys.ps1", import.meta.url), "utf8");
    expect(ps1).toContain(`'--function-names', '${JOB_KEY_METHODS.join(", ")}'`);
    expect(ps1).toContain(`'--function-names', '${CREW_KEY_METHODS.join(", ")}'`);
  });
});

describe("several RPCs", () => {
  it("asks the next endpoint only when one does not answer, never when the chain answered with an error", async () => {
    const asked: string[] = [];
    const down = { rpc: async () => { asked.push("down"); throw new TypeError("fetch failed"); } };
    const refuses = { rpc: async () => { asked.push("refuses"); throw new RpcError("query: UNKNOWN_ACCOUNT"); } };
    const up = { rpc: async () => { asked.push("up"); return { ok: true }; } };
    expect(await new FailoverRpc([down, up]).rpc("block", {})).toEqual({ ok: true });
    await expect(new FailoverRpc([refuses, up]).rpc("query", {})).rejects.toThrow("UNKNOWN_ACCOUNT");
    await expect(new FailoverRpc([down, down]).rpc("block", {})).rejects.toThrow("fetch failed");
    expect(asked).toEqual(["down", "up", "refuses", "down", "down"]);
  });
});
