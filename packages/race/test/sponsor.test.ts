/**
 * The house's bonds on jobs from outside (src/sponsor.ts), decided on the board and the facts its passes read on the
 * tape (fixtures/jobs-work.json), one fact changed at a time: what it locks, from what it holds, what holds a place in
 * its limits, how much it ever has out, and when it takes a bond back. The tape's own run of these passes is replayed in
 * test/work.test.ts.
 */
import { describe, expect, it } from "vitest";
import { BOND_STORAGE, RULES, type Job, type JobBoard } from "@maskwars/arena/jobs";
import { ChainReader, maskCheck, sharedLists } from "@maskwars/check";
import { NETWORKS, houseKeeps, houseOutMost } from "@maskwars/network";
import { HOUSE_DAY_MS, TX_GAS_KEEP, houseDayBusy, houseOut, sponsorPlan, type Waiting } from "../src/sponsor.ts";
import { JOB_LOOKBACK_MS, outsideRules, plan, wordOf, type Facts, type Verdict } from "../src/work.ts";
import { C, D, E, F, G, H, OUTSIDE, about, housePass, ours } from "./jobs-tape.ts";

const NEAR = 10n ** 24n;
const BOND = 5n * 10n ** 22n;
const JOB = 3n * (BOND + 4n * 10n ** 21n); // three bonds of 0.05 NEAR, each with its record's 0.004
const bonded = (p: ReturnType<typeof sponsorPlan>) => p.acts.filter((a) => a.kind === "bond").map((a) => [a.job, [...a.masks]]);
const unbonded = (p: ReturnType<typeof sponsorPlan>) => p.acts.filter((a) => a.kind === "unbond").map((a) => [a.job, [...a.masks].sort()]);
const MASKS = Object.values(about.masks);

async function first() {
  const p = await housePass(9);
  return { board: p.board, facts: p.facts!, house: p.house!, waiting: p.waiting };
}

/** A stranger's mask on a seat, as the board shows one. */
const stranger = (n: number) => ({
  mask: { account: `sybil${n}.test.near`, name: `sybil${n}.test.near`, slug: null, forged: false },
  role: "striker" as const,
  left: false,
  bond: { amount: BOND.toString(), by: null, lost: null, why: null },
  burned: "0",
  covered: null,
  steps: 0,
  payout: null,
});
/** The job with every slot taken by strangers' masks, one entrant each: nobody of ours got in. */
const filled = (j: Job): Job => ({
  ...j,
  masks: j.slots,
  room: false,
  takes: false,
  entrants: Array.from({ length: j.slots }, (_, index) => ({ index, crew: null, version: 0, split: { scout: 0, striker: 10_000, verifier: 0 }, won: false, members: [stranger(index)] })),
});
const withJobs = (board: JobBoard, change: (j: Job) => Job): JobBoard => ({ ...board, jobs: board.jobs.map(change) });
/** The house's bonds for our three masks on these jobs, as they wait: on the chain's list, and in the masks' facts. */
function waitingOn(facts: Facts, jobs: readonly string[]): { facts: Facts; waiting: Waiting[] } {
  const waiting = jobs.flatMap((job) => MASKS.map((mask) => ({ job, mask, amount: BOND })));
  const bonds = new Map(facts.bonds);
  for (const w of waiting) bonds.set(`${w.job}/${w.mask}`, w.amount);
  return { facts: { ...facts, bonds }, waiting };
}

describe("what the house locks", () => {
  it("the bonds of exactly the masks the masks' own plan would seat, on the jobs from outside the limits let through", async () => {
    const { board, facts, house, waiting } = await first();
    expect(house).toEqual({ account: about.house, free: house.free, fullAccess: true, keeps: NEAR, busy: false });
    const p = sponsorPlan(board, facts, ours(about.crew), house, waiting);
    expect(bonded(p)).toEqual([
      [C, ["ORACLE", "NOVA", "ONYX"]],
      [F, ["ORACLE", "NOVA", "ONYX"]],
    ]);
    for (const a of p.acts) if (a.kind === "bond") expect([a.each, a.deposit]).toEqual([JOB / 3n, JOB]);
    expect(p.spare).toBe(house.free - house.keeps - 2n * (JOB + TX_GAS_KEEP));
    expect(p.out).toBe(2n * JOB);
    for (const job of [D, E, G, H]) expect(p.acts.some((a) => a.job === job), job).toBe(false);
  });

  it("only from what it holds beyond what its next round needs: a job it cannot pay whole waits, and a later one gets the room", async () => {
    const { board, facts, house, waiting } = await first();
    // Room for one job's bonds and its gas, not two.
    const one = sponsorPlan(board, facts, ours(about.crew), { ...house, free: house.keeps + JOB + TX_GAS_KEEP }, waiting);
    expect(bonded(one)).toEqual([[C, ["ORACLE", "NOVA", "ONYX"]]]);
    expect(one.skips.some((s) => s.job === F && /the bonds of this job take 0\.162 more than it can lock now/.test(s.why))).toBe(true);
    // IVY's first job asks bonds of 0.1 NEAR a mask, more than the room: it waits, and the next job opened takes the
    // room. That is IVY's second: with her first not taken, it is her one live job.
    const dear = { ...board, jobs: board.jobs.map((j) => (j.id === C ? { ...j, bond: (10n ** 23n).toString() } : j)) };
    const later = sponsorPlan(dear, facts, ours(about.crew), { ...house, free: house.keeps + JOB + TX_GAS_KEEP }, waiting);
    expect(bonded(later)).toEqual([[E, ["ORACLE", "NOVA", "ONYX"]]]);
    expect(later.skips.some((s) => s.job === C && /0\.312 more than it can lock now/.test(s.why))).toBe(true);
    // Nothing beyond what it keeps: nothing locked.
    expect(bonded(sponsorPlan(board, facts, ours(about.crew), { ...house, free: house.keeps }, waiting))).toEqual([]);
  });

  it("nothing for a client MASK CHECK blocks or did not answer about: MASK CHECK comes before any NEAR", async () => {
    const { board, facts, house, waiting } = await first();
    const silent = new Map(facts.clients);
    silent.set(about.people.ivy!, null);
    const p = sponsorPlan(board, { ...facts, clients: silent }, ours(about.crew), house, waiting);
    // IVY's two jobs wait for MASK CHECK's word; the round's two places go to the next jobs opened, ERIN's and FINN's.
    expect(bonded(p).map(([j]) => j)).toEqual([F, G]);
    expect(p.skips.some((s) => s.job === C && s.why.startsWith(`no bond of the house: MASK CHECK did not answer on its client ${about.people.ivy}`))).toBe(true);
    const none = sponsorPlan(board, (({ clients: _, ...rest }) => rest)(facts), ours(about.crew), house, waiting);
    expect(bonded(none)).toEqual([]);
  });

  it("nothing on a chain MASK CHECK could not read: to a person that is a warning, to the house it is no answer", async () => {
    const { board, facts, house, waiting } = await first();
    // MASK CHECK itself, with no RPC that answers: it does not throw, and its verdict is `warn`.
    const down = new ChainReader({ endpoints: ["https://rpc.down.example"], fetch: (async () => new Response("down", { status: 503 })) as typeof fetch, timeoutMs: 1_000 });
    const result = await maskCheck("ivy.near", { network: "mainnet", reader: down, list: sharedLists.mainnet });
    expect(result.verdict).toBe("warn");
    expect(result.reasons.map((r) => r.code)).toEqual(["chain_unreadable"]);
    expect(wordOf(result)).toBeNull();
    // Two providers that answered one read differently: the same.
    const disagree = { verdict: "warn" as const, reasons: [{ code: "rpc_disagree" as const, level: "warn" as const, text: "two answers" }] };
    expect(wordOf(disagree)).toBeNull();
    // What MASK CHECK did read stands: a plain warning lets the job through, and a block blocks whatever else failed.
    expect(wordOf({ verdict: "warn", reasons: [{ code: "young_account", level: "warn", text: "new" }] })).toBe("warn");
    expect(wordOf({ verdict: "allow", reasons: [{ code: "plain_account", level: "info", text: "plain" }] })).toBe("allow");
    expect(wordOf({ verdict: "block", reasons: [{ code: "reported", level: "block", text: "listed" }, { code: "chain_unreadable", level: "warn", text: "down" }] })).toBe("block");

    // The verdict as it came (`warn`) would let the house lock IVY's bonds; the word the house takes does not.
    const said = (word: Verdict | null) => new Map([...facts.clients!, [about.people.ivy!, word]]);
    expect(bonded(sponsorPlan(board, { ...facts, clients: said(result.verdict) }, ours(about.crew), house, waiting)).map(([j]) => j)).toEqual([C, F]);
    const p = sponsorPlan(board, { ...facts, clients: said(wordOf(result)) }, ours(about.crew), house, waiting);
    expect(bonded(p).map(([j]) => j)).toEqual([F, G]);
    for (const j of [C, E]) expect(p.acts.some((a) => a.job === j), j).toBe(false);
    // And no mask works for that client either.
    const masks = plan(board, { ...waitingOn(facts, [C]).facts, clients: said(wordOf(result)) }, ours(about.crew));
    expect(masks.acts.filter((a) => "job" in a && a.job === C)).toEqual([]);
  });

  it("alone, without the crew: a bond for each mask its plan seats alone, all of a job's in one transaction", async () => {
    const { board, facts, house, waiting } = await first();
    const p = sponsorPlan(board, { ...facts, crew: null }, ours(null), house, waiting);
    expect(bonded(p)).toEqual([
      [C, ["NOVA", "ONYX", "ORACLE"]],
      [F, ["NOVA", "ONYX", "ORACLE"]],
    ]);
  });

  it("nothing at all with a key that is not a full key of the house, while its day may be signing, or for an account that is not ours", async () => {
    const { board, facts, house, waiting } = await first();
    const dayKey = sponsorPlan(board, facts, ours(about.crew), { ...house, fullAccess: false }, waiting);
    expect(dayKey.acts).toEqual([]);
    expect(dayKey.skips).toContainEqual({ job: "-", why: `the key the house signs with here is not a full key of ${about.house}: it attaches no NEAR, so the house locks no bond` });
    const busy = sponsorPlan(board, facts, ours(about.crew), { ...house, busy: true }, waiting);
    expect(busy.acts).toEqual([]);
    const notOurs = sponsorPlan(board, facts, { ...ours(about.crew), owners: ["test.near"] }, house, waiting);
    expect(notOurs.acts).toEqual([]);
    expect(notOurs.skips[0]!.why).toContain("our masks would not take a bond it locked");
  });

  it("locks nothing twice: once its bonds wait, the next pass finds them and locks no more", async () => {
    const p = await housePass(11);
    expect(bonded(sponsorPlan(p.board, p.facts!, ours(about.crew), p.house!, p.waiting, p.seated))).toEqual([]);
    // The same on the first reading, as if the bonds it locked there waited and no mask had enlisted yet.
    const { board, facts, house } = await first();
    const w = waitingOn(facts, [C, F]);
    expect(sponsorPlan(board, w.facts, ours(about.crew), house, w.waiting).acts).toEqual([]);
  });
});

describe("a job holds its place once a bond of the house waits on it, whoever took its slots", () => {
  // The attack: open jobs, let the house lock its bonds, then fill their slots with masks of one's own before ours
  // enlist. Our masks get "no slot left", the jobs stay enlisting, the bonds wait. Counted only where our masks sit,
  // the house would bond the round's next two jobs on the next pass, then two more, until its spare NEAR is locked.
  async function attacked() {
    const { board, facts, house } = await first();
    const w = waitingOn(facts, [C, F]);
    return { board: withJobs(board, (j) => (j.id === C || j.id === F ? filled(j) : j)), facts: w.facts, waiting: w.waiting, house };
  }

  it("the house bonds no further job on that round or of that client, and takes its bonds back from the jobs our masks cannot enter", async () => {
    const { board, facts, waiting, house } = await attacked();
    const p = sponsorPlan(board, facts, ours(about.crew), house, waiting);
    // Nothing more is locked: IVY's second job and FINN's, the round's next two, stay without a bond.
    expect(bonded(p)).toEqual([]);
    expect(p.skips).toEqual(
      expect.arrayContaining([
        { job: E, why: `no bond of the house: our masks are on 1 job of ${about.people.ivy} already: 1 at a time from one client` },
        { job: G, why: "no bond of the house: our masks are on 2 jobs from outside on round race-0103 already: 2 a round, first opened first taken" },
      ]),
    );
    // What waits where no slot is left comes back at once, a job's bonds in one transaction, not after the work window.
    const all = Object.keys(about.masks).sort();
    expect(unbonded(p)).toEqual([
      [C, all],
      [F, all],
    ]);
    expect(p.acts.filter((a) => a.kind === "unbond").map((a) => a.back)).toEqual([3n * BOND, 3n * BOND]);
    // A bond the house takes back now still counts as out until it lands, and nothing was added to it.
    expect(p.out).toBe(2n * JOB);
    expect(p.spare).toBe(house.free - house.keeps);
  });

  it("the masks' own plan counts those jobs too: no mask takes a third job on the round, or a second of the client", async () => {
    const { board, facts } = await attacked();
    // As if a bond waited for every mask on the round's next jobs as well: the masks still refuse them.
    const more = waitingOn(facts, [E, G]).facts;
    const p = plan(board, more, ours(about.crew));
    expect(p.acts.filter((a) => a.kind === "enlist" || a.kind === "enlist_crew")).toEqual([]);
    expect(p.skips.some((s) => s.job === E && s.why.startsWith(`our masks are on 1 job of ${about.people.ivy} already`))).toBe(true);
    // Three jobs opened before FINN's hold a bond on its round: two is the most.
    expect(p.skips.some((s) => s.job === G && s.why.startsWith("our masks are on 3 jobs from outside on round race-0103 already: 2 a round"))).toBe(true);
  });

  it("a mask's two places for jobs from outside are taken by its waiting bonds as by its seats", async () => {
    const { board, facts, house } = await first();
    // Two jobs of other rounds hold a bond for each mask: every mask's places for jobs from outside are taken.
    const elsewhere = withJobs(board, (j) => (j.id === D || j.id === G ? { ...j, judge: { by: "round" as const, bounty: about.bounty, round: `race-09${j.id === D ? "1" : "2"}`, state: "open", winner: null } } : j));
    const w = waitingOn(facts, [D, G]);
    const p = sponsorPlan(elsewhere, w.facts, ours(about.crew), house, w.waiting);
    expect(bonded(p)).toEqual([]);
    expect(p.skips.some((s) => s.job === C && /on 2 jobs from outside already: its other places stay for our own jobs/.test(s.why))).toBe(true);
  });
});

describe("how much the house ever has out", () => {
  it("never more than the cap, counted before anything is signed: the bonds that wait and those on our masks' seats", async () => {
    const { board, facts, house, waiting } = await first();
    // On mainnet: every mask on two jobs from outside at 0.1 NEAR a bond, each with its record's storage.
    expect(outsideRules(NETWORKS.mainnet).maxOut).toBe(624n * 10n ** 21n);
    expect(houseOutMost(NETWORKS.mainnet)).toBe(624n * 10n ** 21n);
    expect(OUTSIDE.maxOut).toBe(624n * 10n ** 21n);
    expect(houseOut([{ job: "a", mask: "m", amount: BOND }], [{ job: "b", mask: "m", amount: BOND }])).toBe(2n * BOND + BigInt(BOND_STORAGE));

    // Room under the cap for one job's three bonds, not two: the second waits, whatever the house holds free.
    const tight = { ...ours(about.crew), outside: { ...OUTSIDE, maxOut: 2n * JOB - 1n } };
    const one = sponsorPlan(board, facts, tight, house, waiting);
    expect(bonded(one)).toEqual([[C, ["ORACLE", "NOVA", "ONYX"]]]);
    expect(one.out).toBe(JOB);
    expect(one.skips).toContainEqual({ job: F, why: "the house has 0.162 NEAR out in bonds and 0.323 at most at one time: the bonds of this job take 0.162 more" });
    // What is out already counts: bonds on our masks' seats on a job that runs, and bonds that wait.
    const seats: Waiting[] = MASKS.map((mask) => ({ job: "race-0099-old001", mask, amount: 101n * 10n ** 21n }));
    const held = sponsorPlan(board, facts, ours(about.crew), house, [], seats);
    expect(held.out).toBe(303n * 10n ** 21n + JOB);
    expect(bonded(held)).toEqual([[C, ["ORACLE", "NOVA", "ONYX"]]]);
    expect(held.skips.some((s) => s.job === F && s.why.startsWith("the house has 0.465 NEAR out in bonds and 0.624 at most at one time"))).toBe(true);
    // At the cap: nothing more.
    const full = sponsorPlan(board, facts, { ...ours(about.crew), outside: { ...OUTSIDE, maxOut: JOB - 1n } }, house, waiting);
    expect(bonded(full)).toEqual([]);
    // However the limits are set, what the plan leaves out is never above the cap.
    for (const maxOut of [0n, JOB, 2n * JOB, 10n * JOB]) {
      for (const perRound of [1, 2, 6]) {
        const p = sponsorPlan(board, facts, { ...ours(about.crew), outside: { ...OUTSIDE, maxOut, perRound, perClient: 2, seats: 3 } }, house, waiting);
        expect(p.out, `${maxOut} ${perRound}`).toBeLessThanOrEqual(maxOut);
        expect(p.out).toBe(BigInt(bonded(p).length) * JOB);
      }
    }
  });
});

describe("what the house takes back", () => {
  it("a bond whose mask the plan seats no more, at once: the job's slots are taken", async () => {
    // Pass 11 on the tape: NOVA and ONYX sit on F beside an outsider's mask, F has no slot left, ORACLE's bond waits.
    const p = await housePass(11);
    expect(p.waiting).toEqual([{ job: F, mask: about.masks.ORACLE, amount: BOND }]);
    expect(p.seated.map((s) => `${s.job}/${s.mask}`).sort()).toEqual([...MASKS.map((m) => `${C}/${m}`), `${F}/${about.masks.NOVA}`, `${F}/${about.masks.ONYX}`].sort());
    expect(p.plan.acts).toEqual([{ kind: "unbond", job: F, masks: ["ORACLE"], back: BOND }]);
    // Five bonds on seats and one that waits, with its record's storage.
    expect(p.plan.out).toBe(6n * BOND + BigInt(BOND_STORAGE));
    // With a slot left on F and the work window open, ORACLE may still take it: the bond stays.
    const room = withJobs(p.board, (j) => (j.id === F ? { ...j, slots: j.slots + 1 } : j));
    expect(sponsorPlan(room, p.facts!, ours(about.crew), p.house!, p.waiting, p.seated).acts).toEqual([]);
    // A full key is needed to send it, as for every call of the house.
    expect(sponsorPlan(p.board, p.facts!, ours(about.crew), { ...p.house!, fullAccess: false }, p.waiting, p.seated).acts).toEqual([]);
  });

  it("every bond of a job at once when no mask can take it: the client is barred, the window is closing, the job is over or gone", async () => {
    const { board, facts, house } = await first();
    const w = waitingOn(facts, [C]);
    const all = Object.keys(about.masks).sort();
    const on = (b: JobBoard) => sponsorPlan(b, w.facts, ours(about.crew), house, w.waiting);
    // While the masks' plan seats them, the bonds wait; the round's second place goes to the next job, as before.
    expect(unbonded(on(board))).toEqual([]);
    expect(bonded(on(board))).toEqual([[F, ["ORACLE", "NOVA", "ONYX"]]]);
    // MASK CHECK blocks the client now, or gave no answer: the masks take nothing of it, so the house holds nothing.
    for (const word of ["block", null] as const) {
      const p = sponsorPlan(board, { ...w.facts, clients: new Map([...facts.clients!, [about.people.ivy!, word]]) }, ours(about.crew), house, w.waiting);
      expect(unbonded(p), String(word)).toEqual([[C, all]]);
    }
    // The work window is about to close, the job was cancelled, or it is on the reading no more.
    const job = board.jobs.find((j) => j.id === C)!;
    expect(unbonded(on({ ...board, readAt: job.workUntil - 60_000 }))).toEqual([[C, all]]);
    expect(unbonded(on(withJobs(board, (j) => (j.id === C ? { ...j, phase: "cancelled" as const } : j))))).toEqual([[C, all]]);
    expect(unbonded(on({ ...board, jobs: board.jobs.filter((j) => j.id !== C) }))).toEqual([[C, all]]);
    // A limit that lets the job through no longer: its reward is under the least now.
    const dear = sponsorPlan(board, w.facts, { ...ours(about.crew), outside: { ...OUTSIDE, minReward: 2n * NEAR } }, house, w.waiting);
    expect(unbonded(dear)).toEqual([[C, all]]);
    expect(bonded(dear)).toEqual([]);
  });

  it("keeps the bonds of a crew whose last bond it locks in this very pass, and takes them back when it cannot lock it", async () => {
    const { board, facts, house } = await first();
    // NOVA's and ONYX's bonds wait on C; ORACLE's, the crew's captain, does not: the crew waits for it.
    const w = waitingOn(facts, [C]);
    const two = w.waiting.filter((x) => x.mask !== about.masks.ORACLE);
    const bonds = new Map(w.facts.bonds);
    bonds.delete(`${C}/${about.masks.ORACLE}`);
    const partial = { ...w.facts, bonds };
    expect(plan(board, partial, ours(about.crew)).skips).toContainEqual({ job: C, why: `crew ${about.crew} waits for the bond of ORACLE` });
    const p = sponsorPlan(board, partial, ours(about.crew), house, two);
    expect(unbonded(p)).toEqual([]);
    expect(bonded(p)).toEqual([
      [C, ["ORACLE"]],
      [F, ["ORACLE", "NOVA", "ONYX"]],
    ]);
    // With nothing to lock it from, the crew will not sit: the two bonds come back instead of waiting out the window.
    const broke = sponsorPlan(board, partial, ours(about.crew), { ...house, free: house.keeps }, two);
    expect(bonded(broke)).toEqual([]);
    expect(unbonded(broke)).toEqual([[C, ["NOVA", "ONYX"]]]);
  });

  it("looks back a day more than the longest any job lives: no job still running is older than the reading", () => {
    // The contract's own windows: the check, three days of work, a day of reveals, the judge, a day of appeals.
    expect(RULES.maxJobHours).toBe(144);
    expect(JOB_LOOKBACK_MS).toBe(7 * 24 * 3_600_000);
    expect(JOB_LOOKBACK_MS).toBeGreaterThan(RULES.maxJobHours * 3_600_000);
    // A job the house bonds lives far less: an hour of work and one of reveals, then its round's 37 hours at most.
    const o = outsideRules(NETWORKS.mainnet);
    const longest = Math.max(o.maxWorkMs + o.maxRevealMs + RULES.judgeGraceHours * 3_600_000, RULES.drainRoundHours * 3_600_000);
    expect(longest).toBe(37 * 3_600_000);
    expect(JOB_LOOKBACK_MS).toBeGreaterThan(4 * longest);
  });
});

describe("the house's day", () => {
  const round = NETWORKS.mainnet.round;
  const at = (hh: number, mm: number, day = 13) => Date.UTC(2026, 10, day, hh, mm);

  it("may be signing from the slot until a round the house opened in it seals, an hour at most", () => {
    expect(houseDayBusy(round, at(18, 2), null)).toBe(true);
    // Yesterday's round sealed before today's slot: today's is not open yet.
    expect(houseDayBusy(round, at(18, 2), at(18, 49, 12))).toBe(true);
    // Today's round seals at 18:49: the day is over, the house's key is free.
    expect(houseDayBusy(round, at(18, 6), at(18, 49))).toBe(false);
    expect(houseDayBusy(round, at(18, 0) + HOUSE_DAY_MS, null)).toBe(false);
    expect(houseDayBusy(round, at(17, 59), null)).toBe(false);
    expect(houseDayBusy({ ...round, live: false }, at(18, 2), null)).toBe(false);
  });

  it("keeps what its next round needs on mainnet: 0.503 NEAR beside the vault, whatever it locks", () => {
    expect(houseKeeps(NETWORKS.mainnet)).toBe(503n * 10n ** 21n);
  });
});
