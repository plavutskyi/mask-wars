/**
 * The demo film: one story, from a person's tap to the contract's payout, in 71 s of the live site. A page is either
 * filmed under a caption bar (the page whole above, the film's words under it, never over the page's own) or fills
 * the frame for a hit. A camera moves over each page; nothing in a page is redrawn.
 *
 * The words are `story()` of the round's data; the camera aims at the boxes measured on the pages when they were
 * filmed. The type and the hits are the long film's (`promo/Promo.tsx`).
 */

import { color } from "@maskwars/brand";
import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, Easing, Html5Audio, Img, interpolate, OffthreadVideo, Sequence, staticFile, useCurrentFrame } from "remotion";
import { MARK } from "../cards/mark.ts";
import "../clip/fonts.ts";
import { FONT } from "../clip/fonts.ts";
import { Arrive, clamp, countText, fit, Flash, head, kicker, shakeOf, Slam, sub } from "../promo/Promo.tsx";
import type { Caption, DemoData, Rect, Tap, Tint } from "./plan.ts";
import { afterBars, AT, BAR_H, barFrame, DEMO, DURATION, FORGE_WORDS, MIN_TYPE, REGION_H, story } from "./plan.ts";

const W = DEMO.width;
const H = DEMO.height;
/** The desk the pages were filmed at, px. */
const PAGE_W = 1440;
const PAGE_H = 810;
/** The site's own header: a camera stands on it whole or under it, never across it. */
const HEADER = 58;
const FIELD = 96;
/** A page's first screen under the caption bar: its header and its hero whole, and nothing of what follows them. */
const TOP: Cam = { x: 36, y: 0, w: 1368 };
const TINT: Record<Tint, string> = { ice: color.ice, money: color.money, amber: color.amber };

// ——— The storyboard ———

/** A window of a page, in the page's px: its left top corner and its width; its height follows the picture's. */
export type Cam = { x: number; y: number; w: number };
type Layout = "bar" | "full";
export type Words = Caption & {
  /** Where the words of a full frame stand. */
  place?: "center" | "low";
  size?: number;
  sub?: string;
  /** The sign above the headline, and a last small line under everything: the end card. */
  logo?: boolean;
  foot?: string;
  /**
   * Already there on the beat's first frame: the film's first frame, and words that stay through a beat. `kicker` when
   * only the small line stays and the headline under it is new.
   */
  steady?: boolean | "kicker";
};
type Beat = {
  /** Bars from the shot's start. */
  at: number;
  words?: Words;
  cam?: Cam;
  /** A row of the page the eye is led to: the rest goes darker. */
  spot?: Rect | null;
  /** Another picture of the same page from this beat on. */
  still?: string;
  flash?: boolean;
  shake?: number;
};
type Pic = { kind: "reel"; src: string; from?: number; zoom?: readonly [number, number]; origin?: string } | { kind: "still"; src: string };
export type Shot = {
  at: number;
  len: number;
  layout: Layout;
  pic: Pic;
  beats: Beat[];
  taps?: Tap[];
  /** A backdrop under words in the middle of the frame: darker, and out of focus so its own words do not read. */
  veil?: number;
  blur?: number;
};

const heightOf = (layout: Layout): number => (layout === "bar" ? REGION_H : H);
const camH = (cam: Cam, layout: Layout): number => (cam.w * heightOf(layout)) / W;

/** A camera of width `w` with a row in the middle of the picture, kept under the header and inside the page. */
function onRow(row: Rect, layout: Layout, w = 1300): Cam {
  const y = row.y + row.h / 2 - camH({ x: 0, y: 0, w }, layout) / 2;
  return { x: Math.max(0, Math.min(PAGE_W - w, row.x + row.w / 2 - w / 2)), y: Math.max(HEADER, y), w };
}

export function shots(d: DemoData): Shot[] {
  const s = story(d);
  const b = d.boxes;
  const rowOf = (name: string): Rect | null => (name === "break" ? (b.race.rows.find((r) => r.breaks) ?? b.race.rows.find((r) => r.kind === "drain")) : b.race.rows.find((r) => r.kind === name)) ?? null;
  // The list of the round's steps is filmed between the page's headline, which is the result, and what follows the list.
  const listTop = b.race.hero.y + b.race.hero.h - 80;
  const listEnd = Math.max(listTop, ...b.race.rows.map((r) => r.y + r.h)) + 40;
  const inList = (cam: Cam): Cam => ({ ...cam, y: Math.max(listTop, Math.min(cam.y, listEnd - camH(cam, "bar"))) });
  /** A line of the round on its row, or on the page's own headline when it has no row. */
  const roundBeat = (at: number, line: Caption & { row: string }): Beat => {
    const row = rowOf(line.row);
    return row ? { at, words: line, cam: inList(onRow(row, "bar")), spot: row } : { at, words: line, cam: TOP, spot: null };
  };
  const first = rowOf(s.loaded.row) ?? b.race.rows[0] ?? b.race.hero;
  const unlock = rowOf("unlock") ?? rowOf(s.sealed.row) ?? first;
  const bars = afterBars(s.after.length);
  const afterAt = bars.map((_, i) => bars.slice(0, i).reduce((a, n) => a + n, 0));
  const topRow = s.topIndex >= 0 ? b.league.rows[s.topIndex] : undefined;
  const picks = b.home.picks ?? { x: 440, y: 630, w: 560, h: 100 };
  const code = b.connect.code ?? { x: 824, y: 192, w: 456, h: 88 };
  const panel = b.connect.panel ?? { x: 792, y: 96, w: 520, h: 670 };
  // How many networks the page itself says it takes coins from: the film repeats the page, never a number of its own.
  const coins = b.near.networks ? `Any coin · ${b.near.networks} networks` : "Any coin · any network";

  return [
    // 1. The hook, over the arena as it stands this minute.
    {
      at: AT.hook,
      len: AT.forge - AT.hook,
      layout: "full",
      pic: { kind: "reel", src: "home", zoom: [1, 1.06], origin: "50% 34%" },
      beats: [
        { at: 0, words: { place: "low", head: "AI masks race to break\na vault of real NEAR.", size: 108, steady: true } },
        { at: AT.hook2 - AT.hook, words: { place: "low", head: "Every day.\nNobody presses a button.", size: 108 }, flash: true },
      ],
    },
    // 2. The forge, tapped step by step.
    {
      at: AT.forge,
      len: AT.mask - AT.forge,
      layout: "bar",
      pic: { kind: "reel", src: "forge" },
      beats: FORGE_WORDS.map((w, i) => ({ at: w.beat / 4, words: { kicker: w.kicker, head: w.head }, flash: i === 0 })),
      taps: d.forge.taps,
    },
    // 3. The mask a person forged, and where it stands in the league.
    {
      at: AT.mask,
      len: AT.lineup - AT.mask,
      layout: "bar",
      pic: { kind: "still", src: "mask" },
      beats: [{ at: 0, words: s.mask, cam: TOP, flash: true, shake: 0.5 }],
    },
    {
      at: AT.lineup,
      len: AT.loaded - AT.lineup,
      layout: "bar",
      pic: { kind: "still", src: "league" },
      beats: [{ at: 0, words: s.lineup, cam: b.league.forged ? { x: 70, y: Math.max(HEADER, b.league.forged.y - 96), w: 1300 } : TOP, spot: b.league.forgedRow, flash: true }],
    },
    // 4. The round, row by row down its own page.
    {
      at: AT.loaded,
      len: AT.window - AT.loaded,
      layout: "bar",
      pic: { kind: "still", src: "race" },
      beats: [
        { ...roundBeat(0, s.loaded), flash: true },
        { ...roundBeat(AT.sealed - AT.loaded, s.sealed) },
      ],
    },
    {
      at: AT.window,
      len: AT.result - AT.window,
      layout: "full",
      pic: { kind: "still", src: "race" },
      veil: 0.8,
      blur: 12,
      beats: [{ at: 0, words: { ...s.window, place: "center", size: 210 }, cam: onRow(unlock, "full") }],
    },
    {
      at: AT.result,
      len: AT.after - AT.result,
      layout: "full",
      pic: { kind: "still", src: "race" },
      beats: [{ at: 0, words: { ...s.result, place: "low", size: 104 }, cam: { x: 0, y: 0, w: PAGE_W }, flash: true, shake: 1 }],
    },
    {
      at: AT.after,
      len: AT.league - AT.after,
      layout: "bar",
      pic: { kind: "still", src: "race" },
      beats: s.after.map((line, i) => ({ ...roundBeat(afterAt[i]!, line), flash: true })),
    },
    // 5. The money so far.
    {
      at: AT.league,
      len: AT.call - AT.league,
      layout: "bar",
      pic: { kind: "still", src: "league" },
      beats: [
        { at: 0, words: s.league, cam: TOP, flash: true },
        { at: AT.top - AT.league, words: s.top, cam: { x: 56, y: 0, w: 1328 }, spot: s.top.count ? (topRow ?? null) : null },
      ],
    },
    // 6. Around it: call the round, get NEAR, plug an agent in.
    {
      at: AT.call,
      len: AT.near - AT.call,
      layout: "bar",
      pic: { kind: "still", src: "home" },
      beats: [
        { at: 0, words: { kicker: "Free · no wallet", head: "Call the round" }, cam: { x: 0, y: PAGE_H - camH({ x: 0, y: 0, w: PAGE_W }, "bar"), w: PAGE_W }, flash: true },
        { at: 0.5, words: { kicker: "Free · no wallet", head: "Call the round", steady: true }, cam: { x: Math.max(0, picks.x + picks.w / 2 - 480), y: PAGE_H - camH({ x: 0, y: 0, w: 960 }, "bar"), w: 960 } },
      ],
    },
    {
      at: AT.near,
      len: AT.agent - AT.near,
      layout: "bar",
      pic: { kind: "still", src: "near" },
      beats: [
        { at: 0, words: { kicker: coins, head: "Get NEAR in one step" }, cam: { x: 0, y: 70, w: PAGE_W }, flash: true },
        { at: 1, words: { kicker: coins, head: "Get NEAR in one step", steady: true }, cam: { x: 60, y: 76, w: 1320 }, still: "near-open" },
      ],
    },
    {
      at: AT.agent,
      len: AT.end - AT.agent,
      layout: "bar",
      pic: { kind: "still", src: "connect" },
      beats: [
        { at: 0, words: { kicker: "Claude Code · Codex · any client", head: "Plug your agent in" }, cam: { x: 30, y: 82, w: 1380 }, flash: true },
        { at: 0.75, words: { kicker: "Claude Code · Codex · any client", head: "One line", steady: "kicker" }, cam: { x: Math.min(PAGE_W - panel.w - 180, panel.x - 80), y: Math.max(HEADER, panel.y - 16), w: panel.w + 180 }, spot: code },
      ],
    },
    // 7. The end card, on the track's last two hits.
    {
      at: AT.end,
      len: DEMO.bars - AT.end,
      layout: "full",
      pic: { kind: "reel", src: "home", from: 8, zoom: [1.08, 1.16], origin: "50% 34%" },
      veil: 0.8,
      blur: 22,
      beats: [
        { at: 0, words: { place: "center", logo: true, head: "Forge yours.", size: 190 }, flash: true, shake: 1 },
        { at: AT.url - AT.end, words: { place: "center", logo: true, head: "Forge yours.", size: 190, sub: "maskwars.xyz", foot: "Built at NEAR HACKATHON", steady: true }, flash: true, shake: 0.5 },
      ],
    },
  ];
}

// ——— Pictures ———

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const GLIDE = 18;
const glide = (frame: number): number => interpolate(frame, [0, GLIDE], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) });

/** How much closer the camera comes over a beat. Its top edge stays where it was set: a header is never cut. */
const PUSH = 0.022;

/** The camera at a frame of a shot: it glides to each beat's window, then keeps coming a little closer. */
function camAt(beats: { from: number; cam: Cam }[], frame: number, len: number): Cam {
  let i = 0;
  while (i + 1 < beats.length && beats[i + 1]!.from <= frame) i++;
  const now = beats[i]!;
  const end = beats[i + 1]?.from ?? len;
  const push = 1 - PUSH * interpolate(frame, [now.from, end], [0, 1], clamp);
  const to = { x: now.cam.x + (now.cam.w * (1 - push)) / 2, y: now.cam.y, w: now.cam.w * push };
  if (i === 0) return to;
  const before = beats[i - 1]!;
  const a = { x: before.cam.x + (before.cam.w * PUSH) / 2, y: before.cam.y, w: before.cam.w * (1 - PUSH) };
  const t = glide(frame - now.from);
  return { x: lerp(a.x, to.x, t), y: lerp(a.y, to.y, t), w: lerp(a.w, to.w, t) };
}

function Still({ shot, frame, len }: { shot: Shot; frame: number; len: number }) {
  const withCam = shot.beats.filter((b) => b.cam).map((b) => ({ from: barFrame(shot.at + b.at) - barFrame(shot.at), cam: b.cam!, spot: b.spot ?? null }));
  const cam = camAt(withCam, frame, len);
  const k = W / cam.w;
  let src = (shot.pic as { src: string }).src;
  for (const b of shot.beats) if (b.still && frame >= barFrame(shot.at + b.at) - barFrame(shot.at)) src = b.still;
  // The lit row: it slides with the camera from one beat's row to the next.
  let i = 0;
  while (i + 1 < withCam.length && withCam[i + 1]!.from <= frame) i++;
  const now = withCam[i]!;
  const before = i > 0 ? withCam[i - 1]!.spot : null;
  const t = glide(frame - now.from);
  const spot = now.spot ? (before ? { x: lerp(before.x, now.spot.x, t), y: lerp(before.y, now.spot.y, t), w: lerp(before.w, now.spot.w, t), h: lerp(before.h, now.spot.h, t) } : now.spot) : null;
  const lit = now.spot ? (before ? 1 : interpolate(frame - now.from, [4, GLIDE], [0, 1], clamp)) : 0;
  return (
    <>
      <Img src={staticFile(`demo/${src}.jpg`)} style={{ position: "absolute", left: -cam.x * k, top: -cam.y * k, width: PAGE_W * k, maxWidth: "none" }} />
      {spot ? (
        <div
          style={{
            position: "absolute",
            left: (spot.x - cam.x) * k - 14,
            top: (spot.y - cam.y) * k,
            width: spot.w * k + 28,
            height: spot.h * k,
            borderRadius: 2,
            boxShadow: `0 0 0 4000px rgba(6,5,12,${0.62 * lit}), inset 0 0 0 2px rgba(238,241,255,${0.34 * lit})`,
          }}
        />
      ) : null}
    </>
  );
}

function Reel({ pic, frame, len, layout }: { pic: Extract<Pic, { kind: "reel" }>; frame: number; len: number; layout: Layout }) {
  const zoom = pic.zoom ?? [1, 1];
  const scale = interpolate(frame, [0, len], zoom as [number, number], { easing: Easing.inOut(Easing.quad) });
  return <OffthreadVideo src={staticFile(`demo/${pic.src}.mp4`)} startFrom={pic.from ?? 0} muted style={{ position: "absolute", left: 0, top: 0, width: W, height: heightOf(layout), objectFit: "cover", transformOrigin: pic.origin ?? "50% 50%", scale: `${scale}` }} />;
}

/** A tap as the film shows it: a ring that opens where the finger landed and is gone in half a second. */
export function Taps({ taps, frame }: { taps: Tap[]; frame: number }) {
  return (
    <>
      {taps.map((t, i) => {
        const dt = frame - t.frame;
        if (dt < 0 || dt > 14) return null;
        const r = interpolate(dt, [0, 14], [14, 84], { ...clamp, easing: Easing.out(Easing.cubic) });
        const o = interpolate(dt, [0, 3, 14], [0.95, 0.8, 0], clamp);
        return (
          <div key={i} style={{ position: "absolute", left: t.x - r, top: t.y - r, width: 2 * r, height: 2 * r, borderRadius: "50%", border: `4px solid ${color.ice}`, opacity: o, boxShadow: `0 0 30px rgba(238,241,255,.35)` }}>
            <div style={{ position: "absolute", left: "50%", top: "50%", width: 22, height: 22, margin: -11, borderRadius: "50%", background: color.ice, opacity: interpolate(dt, [0, 8], [1, 0], clamp) }} />
          </div>
        );
      })}
    </>
  );
}

// ——— Words ———

const face = (text: string): string => (/\d/.test(text) ? FONT.num : FONT.word);
const small: CSSProperties = { ...kicker, fontSize: MIN_TYPE, lineHeight: 1 };

function headText(w: Words, frame: number): ReactNode {
  if (w.count && w.steady !== true) {
    const k = interpolate(frame, [2, 30], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
    return countText(w.count, k);
  }
  return w.head.split("\n").map((l, i) => <div key={i}>{l}</div>);
}

export function Mark({ height, style }: { height: number; style?: CSSProperties }) {
  return (
    <svg viewBox="0 0 240 280" style={{ height, width: "auto", display: "block", ...style }}>
      <path fill={color.ice} d={MARK} />
    </svg>
  );
}

/** The caption bar: the film's words under the page, so they never sit on the page's own. */
export function Bar({ w, frame }: { w: Words | undefined; frame: number }) {
  const at = w?.steady === true ? -100 : 0;
  const size = w ? Math.max(MIN_TYPE, fit(w.head, 84, W - 2 * FIELD - 150)) : 84;
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top: REGION_H, height: BAR_H, background: color.ink, boxShadow: `inset 0 1px 0 ${color.line}` }}>
      {w ? (
        <div style={{ position: "absolute", left: FIELD, top: 0, bottom: 0, display: "flex", flexDirection: "column", justifyContent: "center", gap: 12 }}>
          {w.kicker ? (
            <Arrive frame={frame} at={w.steady ? -100 : 0}>
              <div style={{ ...small, fontFamily: face(w.kicker) }}>{w.kicker}</div>
            </Arrive>
          ) : null}
          <Slam frame={frame} at={at + 1} style={{ transformOrigin: "0% 50%" }}>
            <div style={{ ...head(size, w.tint), fontFamily: face(w.head), whiteSpace: "nowrap" }}>{headText(w, frame)}</div>
          </Slam>
        </div>
      ) : null}
      <Mark height={84} style={{ position: "absolute", right: FIELD, top: (BAR_H - 84) / 2, opacity: 0.92 }} />
    </div>
  );
}

/** Words over a full frame: in the middle for a hit, low over a page's own headline. */
export function Full({ w, frame }: { w: Words; frame: number }) {
  const at = w.steady === true ? -100 : 0;
  const place = w.place ?? "center";
  const size = Math.max(MIN_TYPE, fit(w.head, w.size ?? 120, W - 2 * FIELD - 60));
  const align = place === "center" ? "center" : "left";
  const box: CSSProperties =
    place === "center"
      ? { position: "absolute", inset: 0, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 30, textAlign: "center" }
      : { position: "absolute", left: FIELD, right: FIELD, bottom: 96, display: "flex", flexDirection: "column", gap: 20 };
  return (
    <>
      {place === "low" ? <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 640, background: "linear-gradient(180deg, rgba(6,5,12,0) 0%, rgba(6,5,12,.93) 38%, rgba(6,5,12,.985) 62%, rgba(6,5,12,.99) 100%)" }} /> : null}
      <div style={box}>
        {w.logo ? (
          <Slam frame={frame} at={at}>
            <Mark height={170} />
          </Slam>
        ) : null}
        {w.kicker ? (
          <Arrive frame={frame} at={at}>
            <div style={{ ...small, fontFamily: face(w.kicker), textAlign: align, textShadow: `0 2px 18px ${color.ink}` }}>{w.kicker}</div>
          </Arrive>
        ) : null}
        <Slam frame={frame} at={at + 1} style={{ transformOrigin: place === "center" ? "50% 50%" : "0% 50%" }}>
          <div style={{ ...head(size, w.tint), fontFamily: face(w.head), textAlign: align, textShadow: `0 4px 40px ${color.ink}` }}>{headText(w, frame)}</div>
        </Slam>
        {w.sub ? (
          <Arrive frame={frame} at={w.logo ? 0 : 10}>
            <div style={w.logo ? { ...head(96), fontFamily: FONT.num, textTransform: "none", letterSpacing: "0.01em" } : { ...sub, fontSize: 56, textAlign: align, textShadow: `0 2px 18px ${color.ink}` }}>{w.sub}</div>
          </Arrive>
        ) : null}
        {w.foot ? (
          <Arrive frame={frame} at={8}>
            <div style={{ ...small, marginTop: 34 }}>{w.foot}</div>
          </Arrive>
        ) : null}
      </div>
    </>
  );
}

// ——— A shot ———

function ShotView({ shot }: { shot: Shot }) {
  const frame = useCurrentFrame();
  const len = barFrame(shot.at + shot.len) - barFrame(shot.at);
  const starts = shot.beats.map((b) => barFrame(shot.at + b.at) - barFrame(shot.at));
  let i = 0;
  while (i + 1 < starts.length && starts[i + 1]! <= frame) i++;
  const beat = shot.beats[i]!;
  const since = frame - starts[i]!;
  const shake = beat.shake ? shakeOf(since, beat.shake) : { x: 0, y: 0, s: 0 };
  const picture = shot.pic.kind === "reel" ? <Reel pic={shot.pic} frame={frame} len={len} layout={shot.layout} /> : <Still shot={shot} frame={frame} len={len} />;
  return (
    <AbsoluteFill style={{ overflow: "hidden", background: color.ink }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: W, height: heightOf(shot.layout), overflow: "hidden", translate: `${shake.x}px ${shake.y}px`, scale: `${1 + shake.s}` }}>
        <div style={{ position: "absolute", inset: shot.blur ? -2 * shot.blur : 0, filter: shot.blur ? `blur(${shot.blur}px)` : undefined }}>
          <div style={{ position: "absolute", inset: shot.blur ? 2 * shot.blur : 0 }}>
            {picture}
          </div>
        </div>
        {shot.taps ? <Taps taps={shot.taps} frame={frame} /> : null}
        {shot.veil ? <AbsoluteFill style={{ background: `rgba(6,5,12,${shot.veil})` }} /> : null}
        {shot.layout === "full" ? <AbsoluteFill style={{ background: "radial-gradient(75% 80% at 50% 50%, rgba(6,5,12,0) 55%, rgba(6,5,12,.7) 100%)" }} /> : null}
      </div>
      {shot.layout === "bar" ? <Bar w={beat.words} frame={since} /> : beat.words ? <Full w={beat.words} frame={since} /> : null}
      {beat.flash ? <Flash frame={since} /> : null}
    </AbsoluteFill>
  );
}

export type DemoProps = { data: DemoData; music: string | null };

export function Demo({ data, music }: DemoProps) {
  return (
    <AbsoluteFill style={{ background: color.ink }}>
      {shots(data).map((s, i) => (
        <Sequence key={i} from={barFrame(s.at)} durationInFrames={barFrame(s.at + s.len) - barFrame(s.at)} layout="none">
          <ShotView shot={s} />
        </Sequence>
      ))}
      {music ? <Html5Audio src={staticFile(music)} volume={(f) => interpolate(f, [0, 2, DURATION - 40, DURATION - 2], [0, 1, 1, 0], clamp)} /> : null}
    </AbsoluteFill>
  );
}
