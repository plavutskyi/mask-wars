import { describe, expect, it } from "vitest";
import { shots } from "../src/demo/Demo.tsx";
import type { DemoData, LeagueRow, Race, Who } from "../src/demo/plan.ts";
import { afterBars, AT, BAR_S, barFrame, DEMO, DURATION, FORGE_FRAMES, FORGE_WORDS, forgeActs, forgeFrame, MIN_TYPE, MUSIC_CUT, NAME_EVERY, roundNo, spell, story } from "../src/demo/plan.ts";

const NEAR = 10n ** 24n;
const y = (n: number): string => ((BigInt(Math.round(n * 1e6)) * NEAR) / 1_000_000n).toString();
const who = (name: string, account = `${name.toLowerCase()}.maskwars.near`): Who => ({ account, slug: name.toLowerCase(), name, mask: true });
const ORACLE = who("ORACLE");
const NOVA = who("NOVA");
const ONYX = who("ONYX");
const DMYTRO = who("DMYTRO", "dmytro.masks.maskwars.near");

/** Round 3 on NEAR mainnet, 12 Nov 2026, as the site's API gave it: the times and the sums are the chain's. */
const ROUND3: Race = {
  id: "race-0003",
  network: "mainnet",
  phase: "broken",
  bounty: "111760000000000000000000",
  safeFunded: "1930000000000000000000000",
  openedAt: 1794506732035,
  startsAt: 1794509432035,
  sealUntil: 1794509432035,
  masks: [NOVA, ONYX, ORACLE],
  winner: ORACLE,
  brokeAt: 1794509446313,
  breakMs: 14278,
  loot: "240000000000000000000000",
  payout: { amount: "111760000000000000000000", at: 1794509467669 },
  refund: null,
  takes: "351760000000000000000000",
  prize: "351760000000000000000000",
  events: [
    { kind: "fund", at: 1794506726273, who: null, amount: "1930000000000000000000000", ok: true },
    { kind: "open", at: 1794506731428, who: null, amount: "250000000000000000000000", ok: true },
    { kind: "seal", at: 1794507355034, who: ORACLE, amount: null, ok: true },
    { kind: "move", at: 1794509442453, who: ORACLE, amount: null, ok: true },
    { kind: "drain", at: 1794509446313, who: ORACLE, amount: "240000000000000000000000", ok: true },
    { kind: "reveal", at: 1794509450927, who: ORACLE, amount: null, ok: true },
    { kind: "claim", at: 1794509454829, who: ORACLE, amount: null, ok: true },
    { kind: "paid", at: 1794509467669, who: ORACLE, amount: "111760000000000000000000", ok: true },
  ],
};
const row = (w: Who, earned: string, won: string[], lost: string[] = []): LeagueRow => ({ who: w, races: won.length + lost.length, breaks: won.length, earned, history: [...won, ...lost].map((id) => ({ id })) });
const LEAGUE3: LeagueRow[] = [row(ORACLE, "1455380000000000000000000", ["race-0003", "race-0002", "race-0001"]), row(NOVA, "0", [], ["race-0003", "race-0002", "race-0001"]), row(ONYX, "0", [], ["race-0003", "race-0002", "race-0001"])];

const data = (race: Race, league: LeagueRow[] = LEAGUE3): DemoData => ({
  id: race.id,
  mask: "dmytro",
  site: "https://maskwars.xyz",
  capturedAt: 1794564907469,
  race,
  league,
  maskPage: { forged: "Forged 12 NOV", state: "Ready to race" },
  boxes: null as unknown as DemoData["boxes"],
  forge: { frames: FORGE_FRAMES, taps: [] },
  home: { frames: 180 },
});
const everyWord = (d: DemoData): string => {
  const s = story(d);
  return [s.mask, s.lineup, s.loaded, s.sealed, s.window, s.result, ...s.after, s.league, s.top].map((c) => `${c.kicker ?? ""} ${c.head} ${"sub" in c ? (c.sub ?? "") : ""}`).join(" | ");
};

describe("the demo film's timeline", () => {
  it("runs 60 to 90 seconds at 1920×1080, 30 frames a second, and nothing vertical", () => {
    expect(DURATION / DEMO.fps).toBeGreaterThanOrEqual(60);
    expect(DURATION / DEMO.fps).toBeLessThanOrEqual(90);
    expect(DURATION).toBe(2138);
    expect([DEMO.width, DEMO.height, DEMO.fps]).toEqual([1920, 1080, 30]);
  });

  it("cuts every part on a beat of the track, the vault's break on its drop at bar 17", () => {
    const starts = Object.values(AT);
    for (const bar of starts) expect(Number.isInteger(bar * 4)).toBe(true);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(AT.result).toBe(17);
    expect(AT.window).toBe(16); // the track's silent bar
    expect(barFrame(AT.result)).toBe(Math.round(31.875 * 30));
  });

  it("plays the track's first 35 bars, then its finale's two hits, each piece from a bar line", () => {
    expect(MUSIC_CUT[0]![0]).toBe(0);
    for (const [from] of MUSIC_CUT.slice(1)) expect(((from - 0.02) / BAR_S) % 1).toBeCloseTo(0, 6);
    expect(MUSIC_CUT[0]![1] - 0.02).toBeCloseTo(barFrame(AT.end) / DEMO.fps, 1);
    expect(MUSIC_CUT.reduce((s, [a, b]) => s + b - a, 0)).toBeGreaterThan(DURATION / DEMO.fps);
  });

  it("sets no type under 44 px", () => {
    expect(MIN_TYPE).toBeGreaterThanOrEqual(44);
  });

  it("shares the bars after the result between its lines in whole bars", () => {
    expect(afterBars(3)).toEqual([2, 2, 2]);
    expect(afterBars(2)).toEqual([3, 3]);
    expect(afterBars(1)).toEqual([6]);
  });
});

describe("the forge as it is filmed", () => {
  const acts = forgeActs("dmytro");

  it("walks the six steps in order, each tap on a beat, inside its reel", () => {
    expect([...new Set(acts.map((a) => a.step))]).toEqual(["Face", "Mind", "Style", "Plan", "Fuel", "Name"]);
    expect(FORGE_FRAMES).toBe(450);
    for (const a of acts.filter((a) => !("type" in a))) expect(Number.isInteger(a.beat)).toBe(true);
    for (const a of acts) expect(forgeFrame(a.beat)).toBeLessThan(FORGE_FRAMES);
  });

  it("never presses Forge: the name is the last thing typed, and no button follows it", () => {
    const name = acts[acts.length - 1]!;
    expect(name).toMatchObject({ step: "Name", type: "name" });
    expect(acts.filter((a) => a.step === "Name" && "next" in a)).toEqual([]);
  });

  it("cuts before the page asks the chain about the name: the last letter lands under 300 ms before the cut", () => {
    const name = acts[acts.length - 1]!;
    const last = forgeFrame(name.beat) + ("dmytro".length - 1) * NAME_EVERY;
    expect(last).toBeLessThan(FORGE_FRAMES);
    expect(FORGE_FRAMES - last).toBeLessThan(9);
    expect(NAME_EVERY).toBeLessThan(9);
  });

  it("puts each step's words on the beat its step comes on screen", () => {
    const nexts = acts.filter((a) => "next" in a).map((a) => a.beat);
    expect(FORGE_WORDS.map((w) => w.beat)).toEqual([0, ...nexts]);
    expect(FORGE_WORDS.filter((w) => /TEE/.test(w.kicker))).toHaveLength(1);
  });
});

describe("the words, from the round's data", () => {
  it("tells round 3 as the chain has it", () => {
    const s = story(data(ROUND3));
    expect(s.roundNo).toBe(3);
    expect(s.outcome).toBe("broken");
    expect(s.inRound).toBe(false);
    expect(s.lineup.head).toBe("It lines up for the daily round");
    expect(s.loaded).toMatchObject({ row: "fund", kicker: "Round 3 · 12 Nov · 18:05 UTC", head: "1.93 NEAR in the vault" });
    expect(s.sealed).toMatchObject({ row: "seal", kicker: "18:15 UTC · nobody sees the move", head: "ORACLE seals its plan" });
    expect(s.window).toMatchObject({ kicker: "The sealing window closes", head: "18:50:32 UTC" });
    expect(s.result).toMatchObject({ kicker: "18:50:46 UTC", head: "Broken in 14 seconds", sub: "after the window closed" });
    expect(s.after.map((a) => [a.row, a.head])).toEqual([
      ["break", "0.24 NEAR"],
      ["paid", "+0.111 NEAR"],
      ["hero", "ORACLE takes 0.351 NEAR"],
    ]);
    expect(s.league.head).toBe("3 rounds. One winner so far.");
    expect(s.top).toMatchObject({ kicker: "ORACLE · 3 vaults broken", head: "1.455 NEAR" });
    expect(s.topIndex).toBe(0);
    expect(s.mask).toMatchObject({ kicker: "Forged 12 NOV · NEAR mainnet", head: "DMYTRO is ready to race" });
  });

  it("never shows more NEAR than was paid: a sum is cut, not rounded up", () => {
    expect(story(data(ROUND3)).after[1]!.head).toBe("+0.111 NEAR"); // 0.11176 on chain
  });

  // What follows is round 3 played other ways, to see the words follow the data: none of it happened.
  const round4 = (over: Partial<Race>): Race => ({ ...ROUND3, id: "race-0004", openedAt: ROUND3.openedAt! + 86_400_000, masks: [NOVA, ONYX, ORACLE, DMYTRO], ...over });
  const swap = (w: Who): Partial<Race> => ({ winner: w, events: ROUND3.events.map((e) => (e.who ? { ...e, who: w } : e)) });

  it("names whoever won: a person's mask that breaks the vault is said to be one", () => {
    const league = [row(ORACLE, "1455380000000000000000000", ["race-0003", "race-0002", "race-0001"], ["race-0004"]), row(DMYTRO, y(0.35176), ["race-0004"])];
    const d = data(round4({ ...swap(DMYTRO), breakMs: 9_100 }), league);
    const s = story(d);
    expect(s.inRound).toBe(true);
    expect(s.lineup).toMatchObject({ kicker: "Round 4 · 13 Nov", head: "DMYTRO is in the round" });
    expect(s.sealed.head).toBe("DMYTRO seals its plan");
    expect(s.result.kicker).toBe("18:50:46 UTC · a mask forged by a person");
    expect(s.result.head).toBe("Broken in 9 seconds");
    expect(s.after[2]!.head).toBe("DMYTRO takes 0.351 NEAR");
    expect(s.league.head).toBe("4 rounds. 2 masks have won.");
    expect(s.top.head).toBe("1.455 NEAR");
    expect(everyWord(d).replace("ORACLE · 3 vaults broken", "")).not.toContain("ORACLE");
  });

  it("names every mask that sealed, and counts them past three", () => {
    const seal = (w: Who, at: number) => ({ kind: "seal", at, who: w, amount: null, ok: true });
    const two = story(data(round4({ events: [...ROUND3.events, seal(DMYTRO, 1794507400000)] })));
    expect(two.sealed.head).toBe("ORACLE and DMYTRO seal their plans");
    const four = story(data(round4({ events: [...ROUND3.events, seal(DMYTRO, 1794507400000), seal(NOVA, 1794507500000), seal(ONYX, 1794507600000)] })));
    expect(four.sealed.head).toBe("4 masks seal their plans");
  });

  it("says the vault held when nobody broke it, and names no winner", () => {
    const held = round4({ phase: "held", winner: null, brokeAt: null, breakMs: null, loot: null, payout: null, takes: null, refund: { amount: y(0.25) }, events: ROUND3.events.filter((e) => ["fund", "open", "seal"].includes(e.kind)) });
    const d = data(held);
    const s = story(d);
    expect(s.outcome).toBe("held");
    expect(s.result).toMatchObject({ head: "The vault held", sub: "Nobody got through" });
    expect(s.after.map((a) => a.head)).toEqual(["No mask broke it", "0.25 NEAR goes back to the team"]);
    expect(s.after[0]!.kicker).toBe("1 plan sealed");
    expect(s.league.head).toBe("3 rounds. One winner so far.");
    expect(everyWord(d)).not.toMatch(/takes|broke the vault|Broken in/);
  });

  it("says a round that is still on is on, and promises nothing", () => {
    const on = round4({ phase: "sealing", winner: null, brokeAt: null, breakMs: null, loot: null, payout: null, takes: null, events: ROUND3.events.slice(0, 3) });
    const s = story(data(on));
    expect(s.outcome).toBe("open");
    expect(s.result.head).toBe("The masks are sealing");
    expect(s.after).toHaveLength(1);
    expect(s.after[0]).toMatchObject({ kicker: "On the line", head: "0.351 NEAR" });
  });

  it("keeps the league honest while no vault is broken", () => {
    const s = story(data(ROUND3, [row(NOVA, "0", [], ["race-0001"])]));
    expect(s.league.head).toBe("1 round. No vault broken yet.");
    expect(s.topIndex).toBe(-1);
    expect(s.top.count).toBeUndefined();
  });

  it("spells a span as a person says it, cut and never rounded up", () => {
    expect(spell(14278)).toBe("14 seconds");
    expect(spell(1999)).toBe("1 second");
    expect(spell(125_000)).toBe("2 min 05 s");
    expect(spell(3_840_000)).toBe("1 h 04 min");
    expect(roundNo("race-0004")).toBe(4);
    expect(roundNo("s1-0002-7c41e9")).toBe(2);
  });
});

describe("the cut", () => {
  /** The boxes as measured on the live pages for round 3, 13 Nov 2026, px of the 1440 desk. */
  const rowKinds = ["fund", "open", "seal", "unlock", "move", "drain", "reveal", "claim", "paid"];
  const BOXES: DemoData["boxes"] = {
    race: { hero: { x: 130, y: 64, w: 1180, h: 549 }, rows: rowKinds.map((kind, i) => ({ x: 130, y: 662 + 68 * i, w: 1180, h: 68, kind, breaks: kind === "drain" })) },
    league: { table: { x: 130, y: 242, w: 1180, h: 328 }, rows: [282, 378, 474].map((y0) => ({ x: 130, y: y0, w: 1180, h: 96 })), forged: { x: 130, y: 570, w: 1180, h: 267 }, forgedRow: { x: 130, y: 733, w: 1180, h: 96 } },
    mask: { hero: { x: 130, y: 64, w: 1180, h: 540 } },
    home: { picks: { x: 440, y: 633, w: 560, h: 98 } },
    near: { networks: 20 },
    connect: { code: { x: 824, y: 192, w: 456, h: 88 }, panel: { x: 792, y: 96, w: 520, h: 671 } },
  };
  const held: Race = { ...ROUND3, phase: "held", winner: null, brokeAt: null, breakMs: null, loot: null, payout: null, takes: null, events: ROUND3.events.slice(0, 3) };
  const cases: [string, DemoData][] = [
    ["a broken vault", { ...data(ROUND3), boxes: BOXES }],
    ["a vault that held", { ...data(held), boxes: { ...BOXES, race: { ...BOXES.race, rows: BOXES.race.rows.slice(0, 4) } } }],
    ["pages with nothing found on them", { ...data(ROUND3), boxes: { ...BOXES, league: { ...BOXES.league, forged: null, forgedRow: null }, home: { picks: null }, near: { networks: null }, connect: { code: null, panel: null } } }],
  ];

  it.each(cases)("fills every frame of the film, shot after shot with no gap: %s", (_, d) => {
    const cut = shots(d);
    expect(cut[0]!.at).toBe(0);
    cut.forEach((s, i) => expect(s.at + s.len).toBe(cut[i + 1]?.at ?? DEMO.bars));
    for (const s of cut) {
      expect(s.beats[0]!.at).toBe(0);
      for (const b of s.beats) {
        expect(Number.isInteger((s.at + b.at) * 4)).toBe(true); // every change of words or camera is on a beat
        expect(b.at).toBeLessThan(s.len);
        if (s.pic.kind === "still" && b.cam) {
          expect(b.cam.x).toBeGreaterThanOrEqual(0);
          expect(b.cam.y).toBeGreaterThanOrEqual(0);
          expect(b.cam.x + b.cam.w).toBeLessThanOrEqual(1440);
        }
      }
      if (s.pic.kind === "still") expect(s.beats[0]!.cam).toBeDefined();
    }
  });

  it("keeps the result off screen until the drop: before bar 17 the round's page is filmed under its headline", () => {
    const before = shots(cases[0]![1]).filter((s) => s.pic.kind === "still" && s.pic.src === "race" && s.at < AT.window);
    expect(before.length).toBeGreaterThan(0);
    for (const s of before) for (const b of s.beats) expect(b.cam!.y).toBeGreaterThanOrEqual(BOXES.race.hero.y + BOXES.race.hero.h - 80);
  });

  it("repeats the page's own count of networks, or none", () => {
    const kickers = (d: DemoData) => shots(d).flatMap((s) => s.beats.map((b) => b.words?.kicker ?? ""));
    expect(kickers(cases[0]![1])).toContain("Any coin · 20 networks");
    expect(kickers(cases[2]![1]).some((k) => /\d+ networks/.test(k))).toBe(false);
  });
});
