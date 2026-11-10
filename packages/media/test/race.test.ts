import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launch, shootPage } from "../src/cards/render.ts";
import { findMusic } from "../src/clip/render.ts";
import {
  addNear,
  countUp,
  fromYocto,
  lintPost,
  lintThread,
  parseRace,
  planRaceClip,
  RACE_CARDS,
  RACE_CLIP,
  raceCaptions,
  raceClock,
  raceStory,
  raceThread,
  readSeconds,
  SCENES,
  threadMarkdown,
  toYocto,
  xLength,
} from "../src/index.ts";
import { raceCardHtml, RACE_CARD } from "../src/race/cards.ts";

const RACE = join(import.meta.dirname, "../races/race-0003.json");
const race3 = (): any => JSON.parse(readFileSync(RACE, "utf8"));

/** A made-up race unlike race 3 in every way the machine branches on. */
function rehearsal(): any {
  const r = race3();
  return {
    ...r,
    source: "SIMULATED",
    network: "mainnet",
    id: "race-0012",
    bounty: "25",
    masks: ["ONYX", "NOVA", "ORACLE", "WRAITH", "RONIN", "VOLT"].map((name) => ({ name })),
    sandbox: {
      ...r.sandbox,
      board: [
        { mask: "VOLT", attempt: 1, atMs: 90_000, verdict: "fail" },
        { mask: "WRAITH", attempt: 1, atMs: 300_000, verdict: "fail" },
        { mask: "VOLT", attempt: 2, atMs: 1_200_000, verdict: "fail" },
        { mask: "WRAITH", attempt: 3, atMs: 2_460_000, verdict: "breach" },
      ],
    },
    winner: "WRAITH",
    drain: { ...r.drain, amount: "130.5" },
    payout: { ...r.payout, amount: "22.5" },
    next: { id: "race-0013", bounty: "40", at: "2026-12-01T18:00:00Z" },
  };
}

describe("the race record", () => {
  it("race-0003 reads as recorded, every number as it is on chain", () => {
    const r = parseRace(race3());
    expect(r).toMatchObject({ source: "LIVE", network: "testnet", id: "race-0003", winner: "NOVA", bounty: "0.1", status: "drained" });
    expect(r.drain.amount).toBe("1");
    expect(r.payout.amount).toBe("0.08664");
    expect(r.drain.txs.at(-1)).toEqual({ method: "sweep", hash: "8pvCJFDwUW1XXBUKHVMo973Kp1WMkWc4DDpHoHVr2uqg" });
    expect(r.payout.tx).toBe("BHuCzqtM3ZWnS4EBww9ig9txers8ebQnqerGCpqW4Me8");
    expect(r.sandbox.board).toEqual([{ mask: "NOVA", attempt: 1, atMs: 64_000, verdict: "breach" }]);
  });

  it("refuses a record that cannot be true", () => {
    const r = race3();
    expect(() => parseRace({ ...r, winner: "VOLT" })).toThrow(/winner/);
    expect(() => parseRace({ ...r, winner: "ONYX" })).toThrow(/breach/);
    expect(() => parseRace({ ...r, masks: [...r.masks, { name: "NOVA" }] })).toThrow(/once/);
    expect(() => parseRace({ ...r, masks: [{ name: "GHOST" }] })).toThrow(/season mask/);
    expect(() => parseRace({ ...r, status: "open" })).toThrow();
    expect(() => parseRace({ ...r, drain: { ...r.drain, at: "2026-11-06T18:00:00Z" } })).toThrow(/after/);
    const board = [
      { mask: "ONYX", attempt: 1, atMs: 50_000, verdict: "fail" },
      { mask: "NOVA", attempt: 1, atMs: 40_000, verdict: "breach" },
    ];
    expect(() => parseRace({ ...r, sandbox: { ...r.sandbox, board } })).toThrow(/forward/);
  });

  it("money is an exact decimal of NEAR, never a float or zero", () => {
    const r = race3();
    for (const amount of ["1e3", "-1", "0", "0.", ".5", "1.0000000000000000000000001", 1]) {
      expect(() => parseRace({ ...r, payout: { ...r.payout, amount } }), String(amount)).toThrow();
    }
    expect(() => parseRace({ ...r, payout: { ...r.payout, tx: "0xdeadbeef" } })).toThrow(/hash/);
  });

  it("adds NEAR in yocto, with nothing lost", () => {
    expect(toYocto("0.08664")).toBe(86_640_000_000_000_000_000_000n);
    expect(fromYocto(toYocto("1.000"))).toBe("1");
    expect(addNear("1", "0.08664")).toBe("1.08664");
    expect(addNear("0.1", "0.2")).toBe("0.3");
  });
});

describe("the story", () => {
  it("tells race 3 in facts", () => {
    const s = raceStory(race3());
    expect(s.no).toBe(3);
    expect(s.chain).toBe("NEAR testnet");
    expect(s.winner.name).toBe("NOVA");
    expect(s.winner.model).toBe("DeepSeek V4.1 Flash");
    expect(s.rivals.map((m) => m.name)).toEqual(["ONYX", "ORACLE"]);
    expect(s.breach).toMatchObject({ attempt: 1, firstTry: true, tryWords: "first try", clock: "01:04", words: "1 min 4 s", short: { n: "64", unit: "SECONDS" } });
    expect([s.bounty, s.drained, s.paid, s.total]).toEqual(["0.1", "1", "0.08664", "1.08664"]);
    expect(s.links.drain).toBe("https://testnet.nearblocks.io/txns/8pvCJFDwUW1XXBUKHVMo973Kp1WMkWc4DDpHoHVr2uqg");
    expect(s.links.payout).toBe("https://testnet.nearblocks.io/txns/BHuCzqtM3ZWnS4EBww9ig9txers8ebQnqerGCpqW4Me8");
    expect(s.day).toBe("Nov 6");
    expect(s.simulated).toBe(false);
  });

  it("tells another race its own way", () => {
    const s = raceStory(rehearsal());
    expect(s.chain).toBe("NEAR");
    expect(s.breach).toMatchObject({ attempt: 3, firstTry: false, tryWords: "third try", clock: "41:00", words: "41 min", short: { n: "41", unit: "MINUTES" } });
    expect(s.links.drain.startsWith("https://nearblocks.io/txns/")).toBe(true);
    expect(s.total).toBe("153");
    expect(s.simulated).toBe(true);
  });
});

describe("the thread", () => {
  const s = raceStory(race3());
  const posts = raceThread(s);
  const all = posts.map((p) => p.text).join("\n");

  it("is 4 to 8 posts and passes every check", () => {
    expect(posts.length).toBeGreaterThanOrEqual(4);
    expect(posts.length).toBeLessThanOrEqual(8);
    expect(lintThread(posts)).toEqual([]);
  });

  it("opens on the fight and the money, whole in the feed, with no link", () => {
    const first = posts[0]!;
    expect(first.text).toMatch(/^An AI mask broke into a vault on NEAR testnet and walked out with 1 NEAR\./);
    expect(first.text).toContain("0.08664 NEAR bounty");
    expect(xLength(first.text)).toBeLessThanOrEqual(280);
    expect(lintPost(first.text)).toEqual([]);
    expect(first.media).toMatchObject({ kind: "clip", file: "clip.mp4", poster: "cards/01-result.png" });
  });

  it("says what it is, how the race went step by step, the numbers with links, how to try", () => {
    expect(posts[1]!.text).toMatch(/^MASK WARS is an arena/);
    expect(posts[2]!.text).toContain("How race 3 went:");
    expect(posts[2]!.text).toContain("ONYX, NOVA and ORACLE attacked a private copy");
    expect(posts[2]!.text).toContain("NOVA broke the copy on its first try, 1 min 4 s in.");
    expect(posts[3]!.text).toContain("testnet.nearblocks.io/txns/8pvCJFDwUW1XXBUKHVMo973Kp1WMkWc4DDpHoHVr2uqg");
    expect(posts[3]!.text).toContain("testnet.nearblocks.io/txns/BHuCzqtM3ZWnS4EBww9ig9txers8ebQnqerGCpqW4Me8");
    expect(posts[3]!.text).toContain("1.1 s for 0.00111 NEAR");
    expect(posts.at(-1)!.text).toContain("maskwars.xyz/break");
    expect(posts.at(-1)!.text).toContain("maskwars.xyz/api/check?account=safe-0001.tinygif8324.testnet");
  });

  it("claims only what happened: no 'every number is on chain', no payout 'by itself', testnet said up front", () => {
    expect(all).not.toMatch(/every number/i);
    expect(all).not.toMatch(/by itself|on its own/i);
    expect(posts[0]!.text).toContain("NEAR testnet");
    expect(Object.values(raceCaptions(s)).join(" ")).not.toMatch(/by itself|on its own/i);
  });

  it("every number in it comes from the record", () => {
    const r = race3();
    const known = new Set([
      "1", "0.08664", "0.1", "72", "1.1", "0.00111", "3", "4", "2", "5",
      ...r.drain.txs.map((t: any) => t.hash), r.payout.tx, "0001", "8324",
      // the winner's model, named in the post about who thinks where
      ...r.masks.flatMap((m: any) => String(m.model).match(/\d+(?:\.\d+)?/g) ?? []),
    ]);
    const words = all.replace(/\b[1-9A-HJ-NP-Za-km-z]{43,44}\b/g, (h) => (known.has(h) ? "" : h));
    for (const n of words.match(/\d+(?:\.\d+)?/g) ?? []) expect(known.has(n), n).toBe(true);
  });

  it("tags only who works in the race, and each post has its own picture", () => {
    for (const tag of all.match(/@\w+/g) ?? []) expect(["@NEARProtocol", "@near_ai", "@out_layer"]).toContain(tag);
    expect(new Set(posts.map((p) => p.media.file)).size).toBe(posts.length);
    expect(posts.slice(1).map((p) => p.media.kind === "card" && p.media.card)).toEqual(RACE_CARDS.slice(1));
  });

  it("a thread with a link in the first post, a stray tag or one post too few is held back", () => {
    const bad = posts.map((p, i) => (i === 0 ? { ...p, text: `${p.text} maskwars.xyz` } : p));
    expect(lintThread(bad).some((x) => x.startsWith("1/ a link"))).toBe(true);
    const tagged = posts.map((p, i) => (i === 1 ? { ...p, text: `${p.text} @somejudge` } : p));
    expect(lintThread(tagged)).toContain("2/ a tag that is not on the list: @somejudge");
    expect(lintThread(posts.slice(0, 3))[0]).toMatch(/4 to 8 posts/);
  });

  it("another race reads its own way, and a made-up one says not to publish", () => {
    const r = raceStory(rehearsal());
    const p = raceThread(r);
    expect(lintThread(p)).toEqual([]);
    expect(p[0]!.text).toContain("on NEAR and walked out with 130.5 NEAR");
    expect(p[0]!.text).toContain("on its third try");
    expect(p[2]!.text).toContain("ONYX, NOVA, ORACLE, WRAITH, RONIN and VOLT attacked");
    expect(p[3]!.text).toContain("nearblocks.io/txns/");
    expect(p[3]!.text).not.toContain("testnet.nearblocks.io");
    expect(p.at(-1)!.text).not.toContain("api/check");
    expect(p.at(-1)!.text).toContain("Race 13 opens Dec 1 with a 40 NEAR bounty.");
    expect(threadMarkdown(r, p)).toContain("SIMULATED: цифри вигадані, не публікувати.");
  });

  it("the draft names each post's picture and where every number was read", () => {
    const md = threadMarkdown(s, posts, { clipSeconds: 36.2 });
    expect(md).toContain(`| 1/ | \`clip.mp4\`, 36 с; обкладинка \`cards/01-result.png\` | ${xLength(posts[0]!.text)} |`);
    expect(threadMarkdown(s, posts, { noClip: true })).toContain("ще не зібрано");
    for (const p of posts) expect(md).toContain(p.text);
    expect(md).toContain("https://github.com/plavutskyi/mask-wars-hq/actions/runs/42270915840");
    expect(md).toContain("У гілці 5 постів.");
  });
});

describe("lintPost inside a thread", () => {
  it("lets a post carry links to the chain, but not a bare hash or account", () => {
    expect(lintPost("The drain:\ntestnet.nearblocks.io/txns/8pvCJFDwUW1XXBUKHVMo973Kp1WMkWc4DDpHoHVr2uqg", { role: "thread" })).toEqual([]);
    expect(lintPost("tx 8pvCJFDwUW1XXBUKHVMo973Kp1WMkWc4DDpHoHVr2uqg", { role: "thread" })).toContain("a hash or tx id");
    expect(lintPost("paid nova.tinygif8324.testnet", { role: "thread" })).toContain("an account id");
  });

  it("a long handle is caught too", () => {
    expect(lintPost("thanks @ThisHandleIsWayTooLong", { handles: ["@near_ai"] })).toContain("a tag that is not on the list: @ThisHandleIsWayTooLong");
    expect(lintPost("runs on @near_ai", { handles: ["@near_ai"] })).toEqual([]);
  });

  it("counts like X: a link is 23", () => {
    expect(xLength("a testnet.nearblocks.io/txns/8pvCJFDwUW1XXBUKHVMo973Kp1WMkWc4DDpHoHVr2uqg")).toBe(2 + 23);
    expect(lintPost("x".repeat(281))).toContain("over 280 characters");
    expect(lintPost("x".repeat(281), { max: 600 })).toEqual([]);
  });
});

describe("the clip's plan", () => {
  const s = raceStory(race3());
  const plan = planRaceClip(s);

  it("is 16:9 and 15 to 45 seconds", () => {
    expect([RACE_CLIP.width, RACE_CLIP.height]).toEqual([1920, 1080]);
    expect(plan.durationInFrames / RACE_CLIP.fps).toBeGreaterThanOrEqual(15);
    expect(plan.durationInFrames / RACE_CLIP.fps).toBeLessThanOrEqual(45);
  });

  it("opens on the result at frame 0, scenes back to back", () => {
    expect(plan.scenes.result.from).toBe(0);
    let at = 0;
    for (const id of SCENES) {
      expect(plan.scenes[id].from, id).toBe(at);
      at = plan.scenes[id].to;
    }
    expect(at).toBe(plan.durationInFrames);
    expect(plan.captions.every((c) => c.from >= plan.scenes.result.to)).toBe(true);
  });

  it("burns in one line at a time, each long enough to read, carrying the real numbers", () => {
    for (const [i, c] of plan.captions.entries()) {
      if (i > 0) expect(c.from).toBeGreaterThanOrEqual(plan.captions[i - 1]!.to);
      expect((c.to - c.from + 12) / RACE_CLIP.fps, c.text).toBeGreaterThanOrEqual(readSeconds(c.text) - 0.01);
    }
    const lines = Object.values(raceCaptions(s)).join(" ");
    for (const n of ["0.1 NEAR", "1 min 4 s", "1 NEAR out", "1.1 s"]) expect(lines).toContain(n);
  });

  it("hits where it should: the breach inside the race, the crack inside the drain", () => {
    expect(plan.beats.breach).toBeGreaterThan(plan.scenes.race.from);
    expect(plan.beats.breach).toBeLessThan(plan.scenes.race.to);
    expect(plan.beats.crack).toBeGreaterThan(plan.scenes.drain.from);
    expect(plan.beats.crack).toBeLessThan(plan.scenes.drain.to);
    expect(plan.clock.to).toBe(plan.beats.breach);
  });

  it("a long race with six masks still fits", () => {
    const p = planRaceClip(raceStory(rehearsal()));
    expect(p.durationInFrames / RACE_CLIP.fps).toBeLessThanOrEqual(45);
  });

  it("counts up to the exact number and never past it", () => {
    expect(countUp("0.08664", 0)).toBe("0.00000");
    expect(countUp("0.08664", 1)).toBe("0.08664");
    expect(countUp("0.08664", 0.5)).toBe("0.04332");
    for (let k = 0; k <= 1; k += 0.01) expect(Number(countUp("1.08664", k))).toBeLessThanOrEqual(1.08664);
    expect(countUp("130", 0.5)).toBe("65");
    // Round amounts still move: in hundredths at least.
    expect(countUp("1", 0.5)).toBe("0.50");
    expect(countUp("1", 0.99)).toBe("0.99");
    expect(countUp("0.1", 0.5)).toBe("0.050");
    expect(countUp("1", 1)).toBe("1");
    expect(raceClock(64_900)).toBe("01:04");
  });
});

describe("the race cards", () => {
  const s = raceStory(race3());

  it("one card per post after the clip, plus the clip's poster, all with nothing small", () => {
    expect(RACE_CARDS).toEqual(["result", "arena", "how", "numbers", "next"]);
    for (const kind of RACE_CARDS) {
      const html = raceCardHtml(kind, s);
      const body = html.slice(html.indexOf("</style>"));
      for (const m of body.matchAll(/font-size:(\d+)px/g)) expect(Number(m[1]), kind).toBeGreaterThanOrEqual(36);
      expect(html, kind).not.toMatch(/tinygif|nearblocks|8pvC|BHuC/);
      expect(html, kind).not.toContain(">SIMULATED<");
    }
    expect(raceCardHtml("result", s)).toContain("1 NEAR");
    expect(raceCardHtml("numbers", s)).toContain("0.08664");
    expect(raceCardHtml("result", raceStory(rehearsal()))).toContain(">SIMULATED<");
    expect(raceCardHtml("next", raceStory(rehearsal()))).toContain("RACE 13");
  });

  it("renders every card at 1600×900 with no console error", async () => {
    const browser = await launch();
    try {
      for (const kind of RACE_CARDS) {
        const png = await shootPage(browser, raceCardHtml(kind, s), { ...RACE_CARD, scale: 1 }, kind);
        expect([png.readUInt32BE(16), png.readUInt32BE(20)], kind).toEqual([1600, 900]);
      }
    } finally {
      await browser.close();
    }
  }, 120_000);
});

describe("music", () => {
  it("takes the clip's track from the audio folder when there is one, else none", () => {
    const dir = mkdtempSync(join(tmpdir(), "maskwars-audio-"));
    try {
      expect(findMusic(join(dir, "missing"))).toBeNull();
      expect(findMusic(dir)).toBeNull();
      writeFileSync(join(dir, "zeta.mp3"), "");
      writeFileSync(join(dir, "notes.txt"), "");
      expect(findMusic(dir)).toBe(join(dir, "zeta.mp3"));
      writeFileSync(join(dir, "theme.m4a"), "");
      expect(findMusic(dir)).toBe(join(dir, "theme.m4a"));
      writeFileSync(join(dir, "clip.wav"), "");
      expect(findMusic(dir)).toBe(join(dir, "clip.wav"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The full render needs Remotion's headless browser. Where the box has one (CI, a dev machine with it
// installed), frame 0 is drawn and checked; CI checks everything above.
const headless = existsSync("/opt/pw-browsers") || process.env.MEDIA_RENDER === "1";
describe.runIf(headless)("the clip, drawn", () => {
  it("frame 0 is the result, 1920×1080", async () => {
    const { renderRaceClip } = await import("../src/clip/render.ts");
    const dir = mkdtempSync(join(tmpdir(), "maskwars-frames-"));
    try {
      const r = await renderRaceClip(race3(), { video: null, frames: dir, music: null });
      expect(r.seconds).toBeGreaterThanOrEqual(15);
      const jpg = readFileSync(join(dir, "1-result.jpg"));
      // JPEG: the SOF0 marker carries height, then width.
      const sof = jpg.indexOf(Buffer.from([0xff, 0xc0]));
      expect([jpg.readUInt16BE(sof + 7), jpg.readUInt16BE(sof + 5)]).toEqual([1920, 1080]);
      expect(r.frames.map((f) => f.name)).toEqual(["1-result", "2-vault", "3-race", "4-breach", "5-drain", "6-paid", "7-end"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
});

describe("small words", () => {
  it("say times and seconds the way a person would", async () => {
    const { secondsText } = await import("../src/index.ts");
    expect(secondsText(1.1)).toBe("1.1");
    expect(secondsText(1e-7)).toBe("0.1");
    expect(secondsText(2)).toBe("2");
    expect(secondsText(12.6)).toBe("13");
    const r = race3();
    const at = (atMs: number) => raceStory({ ...r, sandbox: { ...r.sandbox, board: [{ mask: "NOVA", attempt: 1, atMs, verdict: "breach" }] } }).breach.words;
    expect(at(3_600_000)).toBe("1 h");
    expect(at(3_660_000)).toBe("1 h 1 min");
    expect(at(400)).toBe("under a second");
  });
});
