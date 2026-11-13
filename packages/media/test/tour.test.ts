import { describe, expect, it } from "vitest";
import { ROUND_PARTS, PARTS } from "../src/tour/capture.ts";
import type { LeagueRow, Race, Who } from "../src/demo/plan.ts";
import { BAR_S, barFrame, FORGE_FRAMES, MIN_TYPE } from "../src/demo/plan.ts";
import type { Filmed, Pressed, ReelName, Segment, TourData } from "../src/tour/plan.ts";
import { beatFrame, CARD, CHAPTERS, cut, DURATION, END, HOOK, latestFinished, lines, MAX_HEAD, mayEnter, mayPress, mayType, REEL_AT, reelBeats, reelFrames, reels, tagOf, TOUR } from "../src/tour/plan.ts";

const who = (name: string, account = `${name.toLowerCase()}.maskwars.near`): Who => ({ account, slug: name.toLowerCase(), name, mask: true });
const ORACLE = who("ORACLE");
const NOVA = who("NOVA");
const ONYX = who("ONYX");

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

const box = { x: 200, y: 300, w: 900, h: 80 };
/** What the pages said on 13 Nov 2026; `bare` is a page that had none of it. */
const FACTS: Record<Exclude<ReelName, "forge">, Record<string, string | null>> = {
  watch: { vault: "0.407" },
  race: {},
  mask: { title: "DMYTRO", forged: "Forged 12 NOV", state: "Ready to race" },
  copy: { keep: "80%", take: "20%", price: "1 NEAR" },
  league: {},
  jobs: {},
  near: { networks: "20", get: "13.9" },
  swap: { pay: "USDC", get: "BTC" },
  check: { verdict: "block" },
  market: { price: "$0.10" },
  connect: { tools: "20" },
  github: {},
};
function data(race: Race = ROUND3, league: LeagueRow[] = LEAGUE3, bare = false): TourData {
  const all = reels("https://maskwars.xyz", race.id, "dmytro");
  const filmed = Object.fromEntries(
    all.map((r): [string, Filmed] => [
      r.name,
      {
        frames: reelFrames(r.name),
        taps: r.acts.filter((a) => "tap" in a).map((a) => ({ frame: beatFrame(REEL_AT[r.name].at, a.beat), x: 960, y: 440 })),
        boxes: Object.fromEntries(r.measures.map((m) => [m.name, bare ? null : box])),
        facts: bare ? Object.fromEntries(r.reads.map((x) => [x.name, null])) : FACTS[r.name as Exclude<ReelName, "forge">],
      },
    ]),
  ) as TourData["reels"];
  return { round: race.id, mask: "dmytro", site: "https://maskwars.xyz", capturedAt: 1794578400000, race, league, reels: filmed, forge: { frames: FORGE_FRAMES, taps: [] }, home: { frames: 240 } };
}
const reelsOf = (parts: Segment[]) => parts.filter((p): p is Extract<Segment, { kind: "reel" }> => p.kind === "reel");
const everyHead = (d: TourData): string[] => reelsOf(cut(d)).flatMap((p) => p.lines.map((l) => l.head));

describe("the tour's timeline", () => {
  it("runs 2:30 to 3:00 at 1920×1080, 30 frames a second, as long as its track, and nothing vertical", () => {
    expect(DURATION / TOUR.fps).toBeGreaterThanOrEqual(150);
    expect(DURATION / TOUR.fps).toBeLessThanOrEqual(180);
    expect(DURATION).toBe(4500);
    expect(TOUR.bars * BAR_S).toBeCloseTo(150, 6); // audio/promo-150.mp3 played whole
    expect([TOUR.width, TOUR.height, TOUR.fps]).toEqual([1920, 1080, 30]);
  });

  it("has ten chapters in order, each opened by a card of 1.2 to 1.5 s", () => {
    expect(CHAPTERS.map((c) => c.no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const card = (barFrame(CARD) - barFrame(0)) / TOUR.fps;
    expect(card).toBeGreaterThanOrEqual(1.2);
    expect(card).toBeLessThanOrEqual(1.5);
    const cards = cut(data()).filter((p) => p.kind === "card");
    expect(cards.map((c) => c.no)).toEqual(CHAPTERS.map((c) => c.no));
    for (const c of cards) expect(c.len).toBe(CARD);
  });

  it("fills every frame, part after part with no gap, and cuts every part on a beat", () => {
    const parts = cut(data());
    expect(parts[0]).toMatchObject({ kind: "hook", at: 0 });
    parts.forEach((p, i) => expect(p.at + p.len).toBe(parts[i + 1]?.at ?? TOUR.bars));
    for (const p of parts) expect(Number.isInteger(p.at * 4)).toBe(true);
    expect(parts[parts.length - 1]).toMatchObject({ kind: "end", at: END.at });
    expect(Number.isInteger(HOOK.second * 4)).toBe(true);
  });

  it("lands the track's hits on cards: the drops at bars 17 and 53, the finale at 72, the last hit on the end card", () => {
    const at = (no: number) => CHAPTERS[no - 1]!.at;
    expect(at(2)).toBe(17);
    expect(at(7)).toBe(53);
    expect(at(10)).toBe(72);
    expect(END.at).toBe(76);
    expect(barFrame(17)).toBe(Math.round(31.875 * 30));
  });

  it("holds what a round paid and what a person gets in the track's two silent bars", () => {
    const d = data();
    const inBar = (name: ReelName, bar: number) => lines(name, d).find((l) => REEL_AT[name].at + l.beat / 4 === bar);
    expect(inBar("race", 16)?.head).toBe("ORACLE takes 0.351 NEAR");
    expect(inBar("near", 52)?.head).toBe("You get 13.9 NEAR");
  });

  it("plays a chapter's reels end to end after its card, and the forge reel as the demo film shot it", () => {
    for (const ch of CHAPTERS) {
      let at = ch.at + CARD;
      for (const name of ch.reels) {
        expect(REEL_AT[name].at).toBe(at);
        at += REEL_AT[name].len;
      }
      expect(at).toBe(CHAPTERS[ch.no]?.at ?? END.at);
    }
    expect(reelFrames("forge")).toBe(FORGE_FRAMES);
  });
});

describe("what the film does on the pages", () => {
  const all = reels("https://maskwars.xyz/", "race-0003", "DMYTRO");

  it("films the round it is given, the person's mask, and the two pages that are not ours by their public address", () => {
    const url = (n: ReelName) => all.find((r) => r.name === n)!.url;
    expect(url("race")).toBe("https://maskwars.xyz/race/race-0003");
    expect(url("copy")).toBe("https://maskwars.xyz/mask/dmytro");
    expect(url("market")).toBe("https://market.near.ai/a/maskwars");
    expect(url("github")).toBe("https://github.com/plavutskyi/mask-wars");
    expect(reels("https://maskwars.xyz", "race-0004", "dmytro").find((r) => r.name === "race")!.url).toBe("https://maskwars.xyz/race/race-0004");
  });

  it("puts every press, glide and measure on a beat inside its reel", () => {
    for (const r of all) {
      const beats = reelBeats(r.name);
      for (const a of r.acts) {
        expect(Number.isInteger(a.beat)).toBe(true);
        expect(a.beat).toBeLessThan(beats);
        if ("scroll" in a) expect(a.beat + a.over).toBeLessThanOrEqual(beats);
      }
      for (const m of r.measures) expect(m.beat).toBeLessThan(beats);
      expect(Number.isInteger((r.width * 880) / 1920)).toBe(true); // the window is a whole number of px tall
    }
  });

  it("never taps a pick, never goes past a page's last step, and presses nothing on the two pages that are not ours", () => {
    const taps = (n: ReelName) => all.find((r) => r.name === n)!.acts.filter((a) => "tap" in a);
    expect(taps("watch")).toEqual([]);
    expect(taps("copy")).toEqual([]);
    expect(taps("market")).toEqual([]);
    expect(taps("github")).toEqual([]);
    expect(all.flatMap((r) => r.acts).filter((a) => "enter" in a)).toHaveLength(1);
  });

  it("lights a box only once the page has stopped moving: a measure is never taken during a glide", () => {
    for (const r of all) {
      const glides = r.acts.filter((a) => "scroll" in a).map((a) => [a.beat, a.beat + ("over" in a ? a.over : 0)] as const);
      for (const m of r.measures) for (const [from, to] of glides) expect(m.beat <= from || m.beat >= to).toBe(true);
    }
  });
});

describe("what the film may press", () => {
  const ctl = (over: Partial<Pressed>): Pressed => ({ tag: "button", role: "", type: "button", text: "", label: "", href: "", popup: "", inDialog: false, inNav: false, inList: false, group: "", ...over });

  it("presses pickers, tabs, a sheet that opens and its Close", () => {
    expect(mayPress(ctl({ text: "USDCArbitrum", popup: "dialog" }), "picker")).toBeNull();
    expect(mayPress(ctl({ text: "SOLSolana", label: "Receive SOL on Solana", popup: "dialog" }), "picker")).toBeNull();
    expect(mayPress(ctl({ text: "Ethereum", inDialog: true, inNav: true }), "picker")).toBeNull();
    expect(mayPress(ctl({ text: "ETHEthereum$1,972", inDialog: true, inList: true }), "picker")).toBeNull();
    expect(mayPress(ctl({ text: "$50", role: "radio", group: "Amount" }), "picker")).toBeNull();
    expect(mayPress(ctl({ text: "Codex", role: "tab" }), "tab")).toBeNull();
    expect(mayPress(ctl({ text: "Post a job", popup: "dialog" }), "sheet")).toBeNull();
    expect(mayPress(ctl({ tag: "summary", type: "", text: "Details" }), "sheet")).toBeNull();
    expect(mayPress(ctl({ label: "Close", inDialog: true }), "close")).toBeNull();
  });

  it("refuses everything that signs, sends, hires, copies or submits, whatever it is said to be", () => {
    const refused: [Partial<Pressed>, Parameters<typeof mayPress>[1]][] = [
      [{ text: "Get NEAR", type: "submit" }, "picker"],
      [{ text: "Get deposit address", type: "submit" }, "picker"],
      [{ text: "Check", type: "submit" }, "sheet"],
      [{ text: "Opens at 18:04 UTC", type: "submit", inDialog: true }, "sheet"],
      [{ text: "Forge", type: "submit" }, "tab"],
      [{ tag: "a", text: "Copy1 NEAR", href: "/forge?copy=dmytro" }, "picker"],
      [{ tag: "a", text: "Hire MASK CHECK by MASK WARS · $0.10", href: "/hire" }, "sheet"],
      [{ text: "Hire MASK CHECK by MASK WARS · $0.10" }, "picker"],
      [{ text: "Copy" }, "tab"],
      [{ text: "Copy the call", inDialog: true }, "close"],
      [{ text: "Take it out" }, "sheet"],
      [{ text: "Manage copying" }, "sheet"],
      [{ text: "Use my own NEAR wallet" }, "picker"],
      [{ text: "Sign in" }, "tab"],
      [{ text: "ONYX" }, "picker"], // a pick on the home page: a tap is a real pick
      [{ text: "Vault holds" }, "picker"],
      [{ text: "Post a job", popup: "dialog" }, "picker"],
      [{ text: "i", label: "About USDC on Arbitrum", inDialog: true, inList: true }, "picker"],
      [{ text: "Exchange", role: "radio", group: "" }, "picker"],
      [{ text: "", label: "Turn the swap around" }, "picker"],
    ];
    for (const [c, kind] of refused) expect(mayPress(ctl(c), kind), `${c.text || c.label} as ${kind}`).not.toBeNull();
  });

  it("types into a search or the check's field, and presses Enter only where the check asks its question", () => {
    expect(mayType({ tag: "input", label: "", inCheck: true })).toBeNull();
    expect(mayType({ tag: "input", label: "Search a coin or network", inCheck: false })).toBeNull();
    expect(mayType({ tag: "input", label: "", inCheck: false })).not.toBeNull(); // an address, an amount, a job's line
    expect(mayEnter({ tag: "input", label: "", inCheck: true })).toBeNull();
    expect(mayEnter({ tag: "input", label: "Search a coin or network", inCheck: false })).not.toBeNull();
  });

  it("presses on the pages only what those rules name", () => {
    const kinds = reels("https://maskwars.xyz", "race-0003", "dmytro").flatMap((r) => r.acts.flatMap((a) => ("tap" in a ? [`${r.name}:${a.kind}`] : [])));
    expect([...new Set(kinds)].sort()).toEqual(["connect:tab", "check:sheet", "jobs:close", "jobs:sheet", "near:picker", "swap:picker"].sort());
  });
});

describe("the words, from the data", () => {
  it("tells round 3 and the pages as they stood", () => {
    const d = data();
    const said = (n: ReelName) => lines(n, d).map((l) => l.head);
    expect(said("watch")).toEqual(["A new round every day", "0.407 NEAR in the vault", "AI masks race to break it", "Call the winner. It's free."]);
    expect(said("race")).toEqual(["Every round keeps its page", "1.93 NEAR in the vault", "ORACLE seals its plan", "Broken in 14 seconds", "+0.111 NEAR from the contract", "ORACLE takes 0.351 NEAR"]);
    expect(said("mask")).toEqual(["Sign once. The mask is yours.", "DMYTRO is ready to race"]);
    expect(said("copy")).toEqual(["Like a mask? Copy it.", "You keep 80%. Its owner 20%.", "Copy it for 1 NEAR"]);
    expect(said("league")[0]).toBe("ORACLE took 1.455 NEAR");
    expect(said("near")).toEqual(["Any coin on 20 networks", "Pick the coin you hold", "Set the amount", "You get 13.9 NEAR"]);
    expect(said("swap")[1]).toBe("USDC in. BTC out.");
    expect(said("check")[1]).toBe("Verdict: BLOCK");
    expect(said("market")[1]).toBe("$0.10 a call");
    expect(said("connect")[2]).toBe("20 tools. No keys, ever.");
    expect(lines("forge", d)).toHaveLength(6);
    expect(lines("forge", d).filter((l) => /sealed in a TEE/.test(l.kicker ?? ""))).toHaveLength(1);
  });

  it("says a number only when a page or the API gave one", () => {
    const heads = everyHead(data(ROUND3, [row(NOVA, "0", [], ["race-0001"])], true));
    const digits = heads.filter((h) => /\d/.test(h));
    // What is left with a digit in it is the round's own, from the API: its vault, its time, its sums.
    expect(digits).toEqual(["1.93 NEAR in the vault", "Broken in 14 seconds", "+0.111 NEAR from the contract", "ORACLE takes 0.351 NEAR"]);
    expect(heads).toContain("The arena's masks, ranked");
    expect(heads).toContain("One clear verdict");
  });

  it("follows the round: a vault that held names no winner, a round still on promises nothing", () => {
    const held: Race = { ...ROUND3, id: "race-0004", phase: "held", winner: null, brokeAt: null, breakMs: null, loot: null, payout: null, takes: null, refund: { amount: "250000000000000000000000" }, events: ROUND3.events.slice(0, 3) };
    const h = lines("race", data(held)).map((l) => l.head);
    expect(h).toEqual(["Every round keeps its page", "1.93 NEAR in the vault", "ORACLE seals its plan", "The vault held", "No mask broke it", "0.25 NEAR goes back to the team"]);
    expect(h.join(" ")).not.toMatch(/takes|Broken in/);
    const on: Race = { ...held, phase: "sealing", refund: null };
    expect(lines("race", data(on)).map((l) => l.head)).toEqual(["Every round keeps its page", "1.93 NEAR in the vault", "ORACLE seals its plan", "The masks are sealing", "0.351 NEAR on the line"]);
  });

  it("never shows more NEAR than was paid: a sum is cut, not rounded up", () => {
    expect(lines("race", data()).map((l) => l.head)).toContain("+0.111 NEAR from the contract"); // 0.11176 on chain
  });

  it("keeps every line short enough to stand at 56 px and more, and the small line inside the bar", () => {
    expect(MIN_TYPE).toBeGreaterThanOrEqual(44);
    for (const d of [data(), data(ROUND3, LEAGUE3, true)]) {
      for (const p of reelsOf(cut(d))) {
        for (const l of p.lines) {
          expect(l.head.length, l.head).toBeLessThanOrEqual(MAX_HEAD);
          expect((l.kicker ?? tagOf(p.no)).length).toBeLessThanOrEqual(38);
        }
      }
    }
    for (const c of CHAPTERS) for (const l of c.name.split("\n")) expect(l.length).toBeLessThanOrEqual(20);
  });

  it("is in English, with no technical word in the open", () => {
    const said = [...everyHead(data()), ...CHAPTERS.flatMap((c) => [c.name, c.tag]), ...reelsOf(cut(data())).flatMap((p) => p.lines.map((l) => l.kicker ?? ""))].join(" | ").replace(/\s+/g, " ");
    expect(said).toMatch(/^[\x20-\x7e·]+$/);
    expect(said).not.toMatch(/attestation|NEP-?\d|webhook|\.near\b|\.testnet\b|\bRPC\b|\bMCP\b|\bAPI\b|hash|yocto/i);
    expect(said).not.toMatch(/guarantee|profit|risk-free|get rich/i);
  });

  it("puts every line on a beat inside its reel, the first on the reel's first frame", () => {
    for (const p of reelsOf(cut(data()))) {
      expect(p.lines[0]!.beat).toBe(0);
      const beats = p.lines.map((l) => l.beat);
      expect([...beats].sort((a, b) => a - b)).toEqual(beats);
      for (const b of beats) {
        expect(Number.isInteger(b)).toBe(true);
        expect(b).toBeLessThan(p.len * 4);
      }
    }
  });

  it("lights what a line points at once the page has stopped, until the next line or until the page moves again", () => {
    const d = data();
    for (const p of reelsOf(cut(d))) {
      for (const s of p.spots) {
        expect(s.to).toBeGreaterThan(s.from);
        expect(s.to).toBeLessThanOrEqual(reelFrames(p.reel));
      }
    }
    const at = REEL_AT.league.at;
    const league = reelsOf(cut(d)).find((p) => p.reel === "league")!;
    // The table until the page glides to the forged masks on beat 4; those from beat 7 until it glides on, on beat 11.
    expect(league.spots.map((s) => [s.from, s.to])).toEqual([
      [0, beatFrame(at, 4)],
      [beatFrame(at, 7), beatFrame(at, 11)],
      [beatFrame(at, 14), reelFrames("league")],
    ]);
    expect(reelsOf(cut(data(ROUND3, LEAGUE3, true))).flatMap((p) => p.spots)).toEqual([]);
  });

  it("brings the page to a stop on the beat its line lands: a glide ends where the next line begins", () => {
    const all = reels("https://maskwars.xyz", "race-0003", "dmytro");
    const d = data();
    for (const name of ["race", "league", "jobs", "swap", "market", "connect", "github"] as const) {
      const ends = all.find((r) => r.name === name)!.acts.flatMap((a) => ("scroll" in a ? [a.beat + a.over] : []));
      const starts = lines(name, d).map((l) => l.beat);
      // The first glide of the repository's page runs under its first line; every other one ends on a line.
      for (const end of name === "github" ? ends.slice(1) : ends) expect(starts, `${name}: a glide ends on beat ${end}`).toContain(end);
    }
  });
});

describe("one command a round", () => {
  it("takes the latest round that has ended when none is named", () => {
    expect(latestFinished([{ id: "race-0004", phase: "sealing" }, { id: "race-0003", phase: "broken" }, { id: "race-0002", phase: "broken" }])).toBe("race-0003");
    expect(latestFinished([{ id: "race-0004", phase: "held" }, { id: "race-0003", phase: "broken" }])).toBe("race-0004");
    expect(latestFinished([{ id: "race-0001", phase: "racing" }])).toBeNull();
  });

  it("films again only what a new round changes: its page and the league", () => {
    expect([...ROUND_PARTS]).toEqual(["data", "race", "league"]);
    for (const p of ROUND_PARTS) expect(PARTS).toContain(p);
    const names = reels("https://maskwars.xyz", "race-0003", "dmytro").map((r) => r.name);
    expect([...names, "forge"].sort()).toEqual(PARTS.filter((p) => p !== "data" && p !== "home").sort());
  });
});
