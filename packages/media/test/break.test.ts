import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { near } from "@maskwars/arena";
import { describe, expect, it } from "vitest";
import { beatFrame, beatGrid, checkTempo, snapToBeat } from "../src/break/beat.ts";
import { beatOffset, breakTrack, chooseTrack, fullFrom, tempoFromJson } from "../src/break/music.ts";
import { breakNumbers, countTo } from "../src/break/numbers.ts";
import type { Source } from "../src/break/plan.ts";
import { BOARD, BREAK, pickSource, planBreak, SLOT_MOMENTS, sourceFrame } from "../src/break/plan.ts";
import { estimateTempo, impact, rise, SAMPLE_RATE } from "../src/break/sound.ts";
import { answersFromRecord, recordHashes } from "../src/film/answers.ts";
import { momentsOf } from "../src/film/moments.ts";
import { shotsOf } from "../src/film/shots.ts";
import { toYocto } from "../src/race/near.ts";
import { parseRace } from "../src/race/record.ts";
import type { SealedRound } from "../src/race/record.ts";

const MEDIA = join(import.meta.dirname, "..");
const round1 = (): SealedRound => parseRace(JSON.parse(readFileSync(join(MEDIA, "races/race-0001.json"), "utf8"))) as SealedRound;
const T120 = { bpm: 120, offset: 0 };

const reel = (name: string, frames: number, moments: Record<string, number> = {}, width = 1920): Source => ({ kind: "reel", name, frames, width, moments });
const slot = (name: string, frames: number, moments: Record<string, number> = {}): Source => ({ kind: "slot", name, frames, width: 1920, moments });
/** The reels as the film of round 1 gives them. */
const REELS = {
  crack: reel("crack", 109, { split: 35, ignite: 20 }),
  eye: reel("eye", 76, { split: 35, ignite: 20 }),
  hero: reel("hero", 91),
  home: reel("home", 223, { split: 53, ignite: 38, launch: 109, land: 134 }),
  flow: reel("flow", 112, { launch: 9, land: 54 }),
  league: reel("league", 91, {}, 4912),
};

describe("the beat grid", () => {
  it("at 120 BPM a beat is 15 frames, and 15 s hold 30 of them", () => {
    const grid = beatGrid(T120, 30, 450);
    expect(grid).toHaveLength(30);
    expect(grid.slice(0, 4)).toEqual([0, 15, 30, 45]);
    expect(grid[29]).toBe(435);
  });

  it("any other tempo gives each beat to the frame on screen when it sounds: the cut leads by under a frame, never trails", () => {
    for (const bpm of [96, 128, 143.5, 150]) {
      const grid = beatGrid({ bpm, offset: 0 }, 30, 450);
      grid.forEach((f, n) => {
        const exact = (n * 1800) / bpm;
        expect(f, `${bpm} BPM, beat ${n}`).toBeLessThanOrEqual(exact + 1e-6);
        expect(exact - f, `${bpm} BPM, beat ${n}`).toBeLessThan(1);
      });
      expect(beatFrame(8, { bpm, offset: 0 }, 30)).toBe(grid[8]);
    }
  });

  it("a track whose first beat is a few milliseconds in keeps the whole-frame grid", () => {
    // break-01.mp3 says its first beat is 17 ms in: still frames 0, 15, 30.
    expect(beatGrid({ bpm: 120, offset: 0.017 }, 30, 60)).toEqual([0, 15, 30, 45]);
    expect(planBreak({ bpm: 120, offset: 0.017 }, {}, REELS).cuts).toEqual([60, 105, 165, 240, 315, 375]);
  });

  it("counts from the music's own downbeat when the clip starts off it", () => {
    expect(beatGrid({ bpm: 120, offset: 0.2 }, 30, 60)).toEqual([6, 21, 36, 51]);
  });

  it("snaps a storyboard time to the nearest beat, and a tie to the earlier one", () => {
    expect(snapToBeat(3.5, T120, 30)).toBe(105);
    expect(snapToBeat(3.6, T120, 30)).toBe(105);
    expect(snapToBeat(3.75, T120, 30)).toBe(105);
    expect(snapToBeat(3.8, T120, 30)).toBe(120);
  });

  it("refuses a tempo no music has", () => {
    expect(() => checkTempo({ bpm: 20, offset: 0 })).toThrow(/outside 60–200/);
    expect(() => checkTempo({ bpm: 120, offset: -1 })).toThrow(/not a time/);
  });
});

describe("the timeline of THE BREAK", () => {
  it("is 15 s at 30 frames a second, 16:9", () => {
    const p = planBreak(T120, {}, REELS);
    expect([BREAK.width, BREAK.height, BREAK.fps]).toEqual([1920, 1080, 30]);
    expect(p.durationInFrames).toBe(450);
    expect(p.segments.map((s) => s.id)).toEqual(["crack", "eye", "hero", "arena", "flow", "league", "end"]);
    expect(p.segments[0]!.from).toBe(0);
    expect(p.segments.at(-1)!.to).toBe(450);
  });

  it("cuts where the storyboard says at 120 BPM: 2, 3.5, 5.5, 8, 10.5 and 12.5 s", () => {
    expect(planBreak(T120, {}, REELS).cuts).toEqual([60, 105, 165, 240, 315, 375]);
  });

  it("puts every cut on a beat at any tempo, and the first cut within two seconds", () => {
    for (const bpm of [100, 120, 128, 143.5, 150]) {
      const p = planBreak({ bpm, offset: 0 }, {}, REELS);
      for (const c of p.cuts) expect(p.beats, `${bpm} BPM, cut at ${c}`).toContain(c);
      expect(p.cuts[0]!, `${bpm} BPM`).toBeLessThanOrEqual(2 * 30 + 3);
      p.segments.forEach((s, i) => expect(s.from).toBe(i === 0 ? 0 : p.segments[i - 1]!.to));
    }
  });

  it("keeps seven shots in the storyboard's order down to the slowest tempo it takes", () => {
    expect(BOARD.map((b) => b.at)).toEqual([0, 2, 3.5, 5.5, 8, 10.5, 12.5]);
    const p = planBreak({ bpm: 60, offset: 0 }, {}, REELS);
    expect(p.cuts).toEqual([60, 90, 150, 240, 300, 360]);
    expect(() => planBreak({ bpm: 40, offset: 0 }, {}, REELS)).toThrow(/outside 60–200/);
  });

  it("gives a shot its slot's clip when the round brought one, else the footage filmed off the site", () => {
    const filmed = planBreak(T120, {}, REELS);
    expect(filmed.segments.map((s) => `${s.source.kind}:${s.source.name}`)).toEqual(["reel:crack", "reel:eye", "reel:hero", "reel:home", "reel:flow", "reel:league", "reel:crack"]);

    const some = planBreak(T120, { hero: slot("hero", 120), flow: slot("flow", 120, { launch: 0, land: 60 }) }, REELS);
    expect(some.segments.map((s) => `${s.source.kind}:${s.source.name}`)).toEqual(["reel:crack", "reel:eye", "slot:hero", "reel:home", "slot:flow", "reel:league", "reel:crack"]);

    // The crack's clip also closes the film, backwards. The real page and the league are never a slot.
    const all = planBreak(T120, { crack: slot("crack", 120, { split: 15 }), eye: slot("eye", 120, { ignite: 15 }), hero: slot("hero", 120), flow: slot("flow", 120, { launch: 0, land: 60 }) }, REELS);
    expect(all.segments.map((s) => `${s.source.kind}:${s.source.name}`)).toEqual(["slot:crack", "slot:eye", "slot:hero", "reel:home", "slot:flow", "reel:league", "slot:crack"]);
  });

  it("never stands a card in for footage: a shot with neither a slot nor a reel stops the render", () => {
    const { hero: _hero, ...rest } = REELS;
    expect(() => planBreak(T120, {}, rest)).toThrow(/no footage for this shot: neither slots\/hero\.mp4 nor the filmed reel hero\.mp4/);
    expect(pickSource("hero", "hero", { hero: slot("hero", 90) }, rest).kind).toBe("slot");
    expect(pickSource(null, "home", { hero: slot("hero", 90) }, REELS).name).toBe("home");
  });

  it("puts the split on the first beat, with motion before it from frame 0", () => {
    const p = planBreak(T120, {}, REELS);
    expect(p.hits.crack).toBe(15);
    // The reel is entered 15 frames before its split: frame 0 already shows the seam alight.
    expect(p.segments[0]!.start).toBe(20);
    expect(sourceFrame(p.segments[0]!, 0)).toBe(20);
    expect(sourceFrame(p.segments[0]!, 15)).toBe(35);
    expect(sourceFrame(p.segments[0]!, 45)).not.toBe(sourceFrame(p.segments[0]!, 0));
  });

  it("lets the sound follow the picture when a clip has too little before its moment", () => {
    // A generated crack that splits 0.2 s in: the hit moves to the split, the grid does not move the picture.
    const p = planBreak(T120, { crack: slot("crack", 120, { split: 6 }) }, REELS);
    expect(p.segments[0]!.start).toBe(0);
    expect(p.hits.crack).toBe(6);
  });

  it("times the page's own break, the payout and the counter off the footage", () => {
    const p = planBreak(T120, {}, REELS);
    // The page's vault splits a beat into its shot; the payout leaves on the cut and lands where the slow motion puts it.
    expect(p.hits.split).toBe(165 + 15);
    expect(p.segments[4]!.start).toBe(9);
    expect(p.hits.land).toBe(240 + (54 - 9));
    // The counter runs from the landing to the next beat, and the sum then stands until the cut.
    expect(p.counter).toEqual({ from: 285, to: 300 });
    expect(p.hits.sum).toBe(300);
    expect(p.beats).toContain(p.hits.sum);
    expect(p.segments[4]!.to - p.hits.sum).toBeGreaterThanOrEqual(10);
    expect(p.hits.name).toBe(105 + 15);
    expect(p.hits.sign).toBe(375 + 15);
  });

  it("keeps the sum on screen before the cut, whenever the payout lands", () => {
    for (const land of [20, 40, 54, 60, 68, 74]) {
      const p = planBreak(T120, {}, { ...REELS, flow: reel("flow", 112, { launch: 9, land }) });
      const flow = p.segments[4]!;
      expect(p.counter.to, `landing at ${land}`).toBeGreaterThan(p.counter.from);
      expect(flow.to - p.hits.sum, `landing at ${land}`).toBeGreaterThanOrEqual(Math.min(10, flow.to - p.hits.land - 6));
      expect(p.hits.sum).toBeLessThan(flow.to);
    }
  });

  it("ends on its own first frame: the last shot is the first one backwards, and the vault shuts as it opened", () => {
    const p = planBreak(T120, {}, REELS);
    const end = p.segments.at(-1)!;
    expect(end.reverse).toBe(true);
    expect(sourceFrame(end, 449)).toBe(sourceFrame(p.segments[0]!, 0));
    expect(sourceFrame(end, end.from)).toBe(p.segments[0]!.start + (end.to - end.from - 1));
    // The split, backwards.
    expect(sourceFrame(end, p.hits.lock)).toBe(REELS.crack.moments["split"]);
  });

  it("holds a source's last frame when it runs out, and never reads past it", () => {
    const short = planBreak(T120, { hero: slot("hero", 20) }, REELS);
    const hero = short.segments[2]!;
    expect(sourceFrame(hero, hero.to - 1)).toBe(19);
    for (const s of planBreak(T120, {}, REELS).segments) for (let f = s.from; f < s.to; f++) expect(sourceFrame(s, f)).toBeLessThan(s.source.frames);
  });

  it("knows where a slot's moments are when nobody says", () => {
    expect(SLOT_MOMENTS).toEqual({ crack: { split: 0.5 }, eye: { ignite: 0.5 }, hero: {}, flow: { launch: 0, land: 2 } });
  });
});

describe("the numbers of the clip", () => {
  it("are the round's own, written as the site writes them: 0.54 + 0.21186 reads 0.751", () => {
    const n = breakNumbers(round1());
    expect(n).toMatchObject({ winner: "ORACLE", drained: "0.54", paid: "0.21186", total: "0.751", stamp: "NEAR MAINNET · 10 NOV" });
    expect(n.yocto.total).toBe(toYocto("0.75186"));
    expect(n.yocto.drained + n.yocto.paid).toBe(n.yocto.total);
    // No LIVE on a recording, no word beyond the network and the day.
    expect(n.stamp).not.toMatch(/LIVE/i);
  });

  it("are the numbers the replayed site shows", async () => {
    const r = round1();
    const { view } = await answersFromRecord(r);
    const race = view.now!;
    const n = breakNumbers(r);
    expect(near(race.takes)).toBe(n.total);
    expect(near(race.loot)).toBe(n.drained);
    expect(race.winner!.name).toBe(n.winner);
    expect(race.payout!.amount).toBe(n.yocto.paid.toString());
  });

  it("the counter starts on the drain, never shows more than the round holds, and lands on the exact sum", () => {
    const n = breakNumbers(round1());
    expect(countTo(n, 0)).toBe("0.54");
    expect(countTo(n, 1)).toBe("0.751");
    expect(countTo(n, 2)).toBe("0.751");
    let prev = 0;
    for (let i = 1; i < 200; i++) {
      const text = countTo(n, i / 200);
      expect(text, `k = ${i / 200}`).toMatch(/^0\.\d{3}$/);
      const v = Number(text);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(0.751);
      prev = v;
    }
    expect(countTo(n, 0.999999)).toBe("0.751");
    expect(countTo(n, 0.5)).toBe("0.645");
  });

  it("a testnet round says so, and a whole sum keeps no decimals", () => {
    const r = { ...round1(), network: "testnet" as const };
    expect(breakNumbers(r).stamp).toBe("NEAR TESTNET · 10 NOV");
  });
});

describe("the music", () => {
  it("takes the series' first track by name, and nothing else in the folder", () => {
    expect(chooseTrack(["break-02.mp3", "README.md", "break-01.json", "break-01.mp3", "theme.mp3"])).toBe("break-01.mp3");
    expect(chooseTrack(["theme.mp3", "break.txt"])).toBeNull();
    expect(chooseTrack([])).toBeNull();
  });

  it("reads the tempo from the json beside a track, in the few ways it may be written", () => {
    expect(tempoFromJson({ bpm: 120 })).toEqual({ bpm: 120, offset: 0, start: 0 });
    expect(tempoFromJson({ BPM: "128", downbeat: 0.47, start: 8 })).toEqual({ bpm: 128, offset: 0.47, start: 8 });
    expect(tempoFromJson({ tempo: 150, offset: 1.5 })).toEqual({ bpm: 150, offset: 1.5, start: 0 });
    // As the series' tracks write it (packages/media/audio/break-01.json).
    expect(tempoFromJson({ file: "break-01.mp3", bpm: 120, beat_s: 0.5, first_beat_s: 0.017, impacts_s: [0, 8, 15, 20] })).toEqual({ bpm: 120, offset: 0.017, start: 0 });
    expect(tempoFromJson({ bpm: 0 })).toBeNull();
    expect(tempoFromJson({ title: "no tempo" })).toBeNull();
    expect(tempoFromJson(null)).toBeNull();
  });

  it("finds where a beat falls in the clip when the clip starts inside the track", () => {
    expect(beatOffset(120, 0, 0)).toBe(0);
    expect(beatOffset(120, 0.2, 0)).toBeCloseTo(0.2);
    expect(beatOffset(120, 0.2, 8)).toBeCloseTo(0.2);
    expect(beatOffset(120, 0, 8.1)).toBeCloseTo(0.4);
    expect(beatOffset(120, 0.5, 0)).toBe(0);
  });

  it("measures the tempo of a track nobody wrote down, and where its beat falls", () => {
    // Fifteen seconds of a click on every beat at 128 BPM, the first 0.3 s in.
    const rate = 22_050;
    const x = new Float32Array(rate * 15);
    for (let t = 0.3; t < 15; t += 60 / 128) {
      const at = Math.round(t * rate);
      for (let i = 0; i < 400 && at + i < x.length; i++) x[at + i] = Math.sin(i * 0.6) * Math.exp(-i / 90);
    }
    const heard = estimateTempo(x, rate);
    expect(Math.abs(heard.bpm - 128)).toBeLessThanOrEqual(0.5);
    expect(heard.confidence).toBeGreaterThan(1.4);
    const beat = 60 / 128;
    const off = Math.abs(((heard.offset - 0.3 + beat / 2) % beat) - beat / 2);
    expect(off).toBeLessThan(0.03);
    // A track with no pulse is not taken for one.
    expect(estimateTempo(new Float32Array(rate * 4), rate).confidence).toBeLessThan(1.4);
  });

  it("the series' own track is the one the clip takes, at the tempo its json says", () => {
    const t = breakTrack(join(MEDIA, "shots/race-0001"));
    expect(t.file.endsWith("audio/break-01.mp3")).toBe(true);
    expect(t.tempo.bpm).toBe(120);
    expect(t.from).toBe(0);
    expect(beatGrid(t.tempo, 30, 60)).toEqual([0, 15, 30, 45]);
  });

  it("starts a track where it first plays at full level", () => {
    const rate = 8000;
    const x = new Float32Array(rate * 10);
    for (let i = 0; i < x.length; i++) x[i] = (i < rate * 3 ? 0.002 : 0.4) * Math.sin(i * 0.3);
    expect(fullFrom(x, rate)).toBe(3);
  });

  it("makes its own hits, the same every time, and the pull stops dead on the hit", () => {
    const a = impact();
    expect(a.length).toBe(Math.round(1.6 * SAMPLE_RATE));
    expect(Buffer.from(a.buffer).equals(Buffer.from(impact().buffer))).toBe(true);
    const peak = (x: Float32Array, from = 0, to = x.length) => x.subarray(from, to).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    // Loud on its first samples: a hit, not a swell.
    expect(peak(a, 0, 480)).toBeGreaterThan(0.3);
    expect(peak(a)).toBeLessThanOrEqual(1);
    const r = rise(0.5);
    expect(peak(r, 0, 2400)).toBeLessThan(peak(r, r.length - 4800, r.length - 480));
    expect(Math.abs(r[r.length - 1]!)).toBeLessThan(0.05);
  });
});

describe("the film of a round", () => {
  it("plays the record back as a chain that says what the record says", async () => {
    const r = round1();
    const { recording, view } = await answersFromRecord(r);
    expect(view.races.map((x) => x.id)).toEqual(["race-0001"]);
    const race = view.now!;
    expect(race).toMatchObject({ network: "mainnet", phase: "broken", state: "drained", live: false, target: "safe-0001.maskwars.near" });
    expect(race.winner!.account).toBe("oracle.maskwars.near");
    expect(race.masks.map((m) => m.name).sort()).toEqual(["NOVA", "ONYX", "ORACLE"]);
    // "in 0:15": from the window's close to the drain.
    expect(Math.floor(race.breakMs! / 1000)).toBe(15);
    expect(view.league[0]!.who.name).toBe("ORACLE");
    expect(recording.recordedAt).toBe(Date.parse(r.payout.at) + 3_600_000);
  });

  it("shows no transaction the record does not hold", async () => {
    const r = round1();
    const { view } = await answersFromRecord(r);
    const held = recordHashes(r);
    expect(held.size).toBe(6);
    for (const e of view.now!.events) if (e.tx) expect(held.has(e.tx), `${e.kind} ${e.tx}`).toBe(true);
    // What the record does not hold, the replay does not make up: the vault's funding and its code hash stay unknown.
    expect(view.now!.safeFunded).toBeNull();
    expect(view.now!.targetCode).toBeNull();
    expect(view.next).toBeNull();
  });

  it("refuses a replay that would not say what the record says", async () => {
    const r = round1();
    // A record whose winner the arena does not enter on that network cannot be played back as that round.
    const strange = { ...r, masks: [{ name: "ORACLE", account: "oracle.someone.near" }] } as SealedRound;
    await expect(answersFromRecord(strange)).rejects.toThrow(/does not match its record/);
  });

  it("films the same shots for any round: the page as it is, four film cameras, the pages", () => {
    const shots = shotsOf({ id: "race-0001", winner: "ORACLE" });
    expect(shots.map((s) => s.name)).toEqual(["home", "crack", "eye", "hero", "flow", "league", "league-page", "mask", "race"]);
    expect(shots.find((s) => s.name === "mask")!.path).toBe("/mask/oracle");
    expect(shots.find((s) => s.name === "race")!.path).toBe("/race/race-0001");
    // The page as a person sees it has no film camera and hides nothing.
    const home = shots[0]!;
    expect(home.camera).toBeUndefined();
    expect(home.css).toBeUndefined();
    for (const s of shots) expect([Math.round(s.viewport.width * s.viewport.scale), Math.round(s.viewport.height * s.viewport.scale)], s.name).toEqual([1920, 1080]);
    for (const s of shots.filter((x) => x.camera)) expect(s.css, s.name).toMatch(/visibility: hidden/);
  });

  it("finds a reel's moments from the frame the arena changed state on", () => {
    expect(momentsOf({ name: "crack", frames: 109, marks: { breach: 18, paid: 91 }, rate: 1, width: 1920 }, 30)).toEqual({ split: 35, ignite: 20, launch: 91 });
    expect(momentsOf({ name: "home", frames: 223, marks: { breach: 36, paid: 109 }, rate: 1, width: 1920 }, 30)).toEqual({ split: 53, ignite: 38, launch: 109, land: 134 });
    // Slow motion stretches the payout's flight; a state before the cut is not a moment of the reel.
    expect(momentsOf({ name: "flow", frames: 112, marks: { breach: -21, paid: 9 }, rate: 0.547, width: 1920 }, 30)).toEqual({ launch: 9, land: 54 });
    expect(momentsOf({ name: "league", frames: 91, marks: { start: 0 }, rate: 1, width: 4912 }, 30)).toEqual({});
  });
});

// The kept clip itself, where ffmpeg is on the machine: what goes to X is checked, not only the code that made it.
const KEPT = join(MEDIA, "shots/race-0001/break/break.mp4");
const ffmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
describe.runIf(ffmpeg && existsSync(KEPT))("the kept clip of round 1", () => {
  const probe = (entries: string, stream: string): string => execFileSync("ffprobe", ["-v", "error", "-select_streams", stream, "-show_entries", entries, "-of", "csv=p=0", KEPT], { encoding: "utf8" }).trim();

  it("is 15 s of 1920×1080 at 30 frames a second, with sound", () => {
    // ffprobe may close the line with an empty field.
    expect(probe("stream=width,height,r_frame_rate,nb_frames", "v:0").split(",").slice(0, 4)).toEqual(["1920", "1080", "30/1", "450"]);
    expect(probe("stream=codec_name", "a:0").split(",")[0]).toBe("aac");
  });

  it("moves from its first frame: frame 0 and frame 45 are different pictures", () => {
    const r = spawnSync("ffmpeg", ["-hide_banner", "-i", KEPT, "-filter_complex", "[0:v]select='eq(n\\,0)',setpts=PTS-STARTPTS[a];[0:v]select='eq(n\\,45)',setpts=PTS-STARTPTS[b];[a][b]ssim", "-f", "null", "-"], { encoding: "utf8" });
    const all = /All:([0-9.]+)/.exec(r.stderr);
    expect(all, r.stderr.slice(-300)).not.toBeNull();
    expect(Number(all![1])).toBeLessThan(0.8);
  });

  it("is loud from its first frame", () => {
    const r = spawnSync("ffmpeg", ["-hide_banner", "-t", "0.25", "-i", KEPT, "-vn", "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
    const mean = /mean_volume: (-?[0-9.]+) dB/.exec(r.stderr);
    expect(mean, r.stderr.slice(-300)).not.toBeNull();
    expect(Number(mean![1])).toBeGreaterThan(-30);
  });
});
