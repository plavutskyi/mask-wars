/**
 * THE BREAK: 15 s, 16:9, no words. Moving pictures cut hard on the beat, from the first frame: the vault splits, the
 * winner's eyes light, the winner, the real page at the break, the payout landing, the league's first row, the vault
 * shutting back onto the sign.
 *
 * The frame holds only what the series allows: the mask's name, numbers of the round with their unit, the site's own
 * interface, and the sign with the address, the network and the day. Nothing in it is smaller than 56 px. Pictures
 * come from the render's public dir as frames (`footage/<source>/00001.jpg`); the timeline is `plan.ts`, the numbers
 * are `numbers.ts`.
 */

import { color } from "@maskwars/brand";
import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, Easing, Html5Audio, Img, interpolate, Sequence, staticFile, useCurrentFrame } from "remotion";
import { MARK } from "../cards/mark.ts";
import "../clip/fonts.ts";
import { FONT } from "../clip/fonts.ts";
import { SimulatedBand } from "../clip/SimulatedBand.tsx";
import { SITE } from "../site.ts";
import { breakNumbers, countTo } from "./numbers.ts";
import type { BreakNumbers } from "./numbers.ts";
import type { BreakPlan, Segment } from "./plan.ts";
import { BREAK, sourceFrame } from "./plan.ts";
import type { BreakProps, BreakSounds } from "./props.ts";
import { footageDir, MIN_TYPE } from "./props.ts";

const W = BREAK.width;
const H = BREAK.height;
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const out = Easing.bezier(0.16, 1, 0.3, 1);
/** The side field of the frame, as in the race clip. */
const FIELD = 115;

const word = (size: number, extra: CSSProperties = {}): CSSProperties => ({
  fontFamily: FONT.word,
  fontWeight: 800,
  fontStretch: "125%",
  fontSize: Math.max(MIN_TYPE, size),
  lineHeight: 0.98,
  letterSpacing: "0.01em",
  textTransform: "uppercase",
  whiteSpace: "nowrap",
  ...extra,
});
const num = (size: number, extra: CSSProperties = {}): CSSProperties => ({
  fontFamily: FONT.num,
  fontWeight: 800,
  fontStretch: "125%",
  fontSize: Math.max(MIN_TYPE, size),
  lineHeight: 0.92,
  letterSpacing: "-0.01em",
  fontVariantNumeric: "lining-nums",
  whiteSpace: "nowrap",
  ...extra,
});

const frameFile = (s: Segment, frame: number): string => staticFile(`${footageDir(s.source)}/${String(sourceFrame(s, frame) + 1).padStart(5, "0")}.jpg`);

/** How hard a hit still shakes the frame `dt` frames after it: 1 on the hit, gone in a third of a second. */
const ring = (dt: number): number => (dt < 0 ? 0 : Math.exp(-dt / 3.2));

/** The picture's own move: a steady push in, a punch and a shake on each hit of the shot. */
function camera(frame: number, s: Segment, push: [number, number], hits: readonly { at: number; power: number }[]): { scale: number; x: number; y: number } {
  const k = (frame - s.from) / Math.max(1, s.to - s.from - 1);
  let scale = push[0] + (push[1] - push[0]) * k;
  let x = 0;
  let y = 0;
  for (const h of hits) {
    const dt = frame - h.at;
    const r = ring(dt) * h.power;
    scale += 0.045 * r;
    x += 13 * r * Math.sin(dt * 2.3 + 0.6);
    y += 9 * r * Math.cos(dt * 1.9);
  }
  return { scale, x, y };
}

function Picture({ s, frame, cam, origin = "50% 50%", style }: { s: Segment; frame: number; cam: { scale: number; x: number; y: number }; origin?: string; style?: CSSProperties }) {
  return (
    <Img
      src={frameFile(s, frame)}
      style={{ position: "absolute", left: 0, top: 0, width: W, height: H, objectFit: "cover", transformOrigin: origin, transform: `translate(${cam.x.toFixed(2)}px, ${cam.y.toFixed(2)}px) scale(${cam.scale.toFixed(5)})`, ...style }}
    />
  );
}

/** The seam going to Ice for 80 ms (BRANDBOOK §9): one burst of light out of the hit, the corners left dark. */
function Flash({ frame, at, power = 1, from = "50% 50%" }: { frame: number; at: number; power?: number; from?: string }) {
  const o = interpolate(frame, [at, at + 1, at + 4], [0.5, 0.3, 0], clamp) * power;
  if (frame < at || o <= 0) return null;
  return <AbsoluteFill style={{ background: `radial-gradient(34% 62% at ${from}, ${color.ice} 0%, rgba(238,241,255,.35) 38%, rgba(238,241,255,0) 100%)`, opacity: o, mixBlendMode: "screen" }} />;
}

/**
 * What flies off the door when it splits: a few slabs of obsidian past the lens, black with the vault's light on the
 * edge that faces it, gone in half a second. No sparks, no dust.
 */
const SHARDS: readonly { a: number; v: number; size: number; spin: number; pts: string; facet: string }[] = [
  { a: -0.42, v: 64, size: 210, spin: 2.6, pts: "0,22 58,0 100,40 74,100 14,80", facet: "58,0 100,40 74,100 46,52" },
  { a: 0.38, v: 52, size: 150, spin: -3.8, pts: "8,0 100,24 82,96 28,100 0,50", facet: "8,0 100,24 52,56 0,50" },
  { a: 2.72, v: 68, size: 240, spin: 2.0, pts: "0,32 52,0 100,34 80,100 22,90", facet: "52,0 100,34 80,100 50,48" },
  { a: 3.62, v: 50, size: 130, spin: -3.1, pts: "14,0 90,12 100,72 42,100 0,58", facet: "14,0 90,12 48,50 0,58" },
  { a: 1.18, v: 44, size: 96, spin: 4.6, pts: "0,12 78,0 100,60 50,100 8,72", facet: "78,0 100,60 50,100 44,44" },
  { a: -1.28, v: 48, size: 118, spin: -2.4, pts: "22,0 100,32 74,100 0,80 6,26", facet: "22,0 100,32 50,54 6,26" },
  { a: -2.52, v: 58, size: 176, spin: 1.7, pts: "10,8 88,0 100,66 38,100 0,48", facet: "88,0 100,66 38,100 52,46" },
];

function Shards({ frame, at }: { frame: number; at: number }) {
  const dt = frame - at;
  if (dt < 0 || dt > 17) return null;
  return (
    <AbsoluteFill>
      {SHARDS.map((sh, i) => {
        // Hard out of the seam, then coasting; toward the lens they grow and go soft.
        const d = sh.v * 9 * (1 - Math.exp(-dt / 5)) + dt * 16;
        const x = W / 2 + Math.cos(sh.a) * d * 1.45;
        const y = H * 0.5 + Math.sin(sh.a) * d + dt * dt * 0.7;
        const grow = 0.5 + dt * 0.075;
        const turn = sh.spin * dt * 2.4 + i * 47;
        // The lit edge is the one that looks back at the vault, whichever way the slab has turned.
        const light = (Math.atan2(H * 0.5 - y, W / 2 - x) * 180) / Math.PI - turn;
        const o = interpolate(dt, [0, 1, 14, 17], [0, 1, 1, 0], clamp);
        const px = sh.size * grow;
        return (
          <svg key={i} viewBox="0 0 100 100" style={{ position: "absolute", left: x - px / 2, top: y - px / 2, width: px, height: px, opacity: o, filter: `blur(${(0.6 + dt * 0.32).toFixed(1)}px)`, rotate: `${turn.toFixed(1)}deg`, overflow: "visible" }}>
            <defs>
              <linearGradient id={`shard${i}`} gradientTransform={`rotate(${light.toFixed(1)} 0.5 0.5)`}>
                <stop offset="0" stopColor={color.ink} />
                <stop offset="0.72" stopColor={color.ink2} />
                <stop offset="0.9" stopColor="#3a2a12" />
                <stop offset="1" stopColor={color.amber} />
              </linearGradient>
            </defs>
            <polygon points={sh.pts} fill={`url(#shard${i})`} stroke={color.ice} strokeOpacity={0.16} strokeWidth={0.8} />
            <polygon points={sh.facet} fill={color.ink} fillOpacity={0.55} />
          </svg>
        );
      })}
    </AbsoluteFill>
  );
}

/** The winner's name, slammed in on its beat: the left field, clear of the mask. */
function Name({ frame, at, name }: { frame: number; at: number; name: string }) {
  if (frame < at) return null;
  const size = Math.min(190, Math.floor(770 / (name.length * 0.88)));
  const k = interpolate(frame, [at, at + 5], [0, 1], { ...clamp, easing: out });
  return (
    <div style={{ position: "absolute", left: FIELD, top: 0, bottom: 0, display: "flex", alignItems: "center" }}>
      <div style={word(size, { color: color.ice, opacity: interpolate(frame, [at, at + 2], [0, 1], clamp), transformOrigin: "0% 60%", transform: `scale(${(1.32 - 0.32 * k).toFixed(4)})` })}>{name}</div>
    </div>
  );
}

/** Digits in slots, so a running number never jitters (BRANDBOOK §4). */
function Digits({ text, size, tint }: { text: string; size: number; tint: string }) {
  return (
    <span style={num(size, { color: tint, display: "inline-flex" })}>
      {[...text].map((ch, i) => (
        <span key={i} style={{ display: "inline-block", width: /\d/.test(ch) ? "0.7em" : "0.3em", textAlign: "center" }}>
          {ch}
        </span>
      ))}
    </span>
  );
}

/** A sum with its unit. While it runs its digits stand in slots; at rest it is set as the site sets it. */
function Amount({ digits, size, tint, running }: { digits: string; size: number; tint: string; running: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: size * 0.1 }}>
      {running ? <Digits text={digits} size={size} tint={tint} /> : <span style={num(size, { color: tint })}>{digits}</span>}
      <span style={word(size * 0.43, { color: tint, letterSpacing: "0.02em" })}>NEAR</span>
    </div>
  );
}

/**
 * The money: what the vault gave up stands in Ice while the light flies; when it lands, the contract's payout drops in
 * and the sum runs up to exactly what the site shows for the round.
 */
function Counter({ frame, plan, n }: { frame: number; plan: BreakPlan; n: BreakNumbers }) {
  const { from, to } = plan.counter;
  const k = interpolate(frame, [from, to], [0, 1], { ...clamp, easing: Easing.out(Easing.quad) });
  const landed = frame >= from;
  // The sum is reached: the number takes the hit.
  const hit = ring(frame - to);
  return (
    <div style={{ position: "absolute", right: FIELD, top: 0, bottom: 0, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "flex-end", gap: 30 }}>
      <div style={{ ...num(76, { color: color.money }), display: "flex", alignItems: "baseline", gap: 12, opacity: landed ? interpolate(frame, [from, from + 3], [0, 1], clamp) : 0, translate: `0 ${interpolate(frame, [from, from + 8], [26, 0], { ...clamp, easing: out })}px` }}>
        <span>+{n.paid}</span>
        <span style={word(MIN_TYPE, { color: color.money, letterSpacing: "0.02em" })}>NEAR</span>
      </div>
      <div style={{ transformOrigin: "100% 60%", transform: `scale(${(1 + 0.07 * hit).toFixed(4)})` }}>
        <Amount digits={landed ? countTo(n, k) : n.drained} size={164} tint={landed ? color.money : color.ice} running={landed && k < 1} />
      </div>
    </div>
  );
}

/** The league's first row, close: held on the name, then a whip along the row to the sum. */
function Row({ s, frame, plan }: { s: Segment; frame: number; plan: BreakPlan }) {
  const span = Math.max(0, s.source.width - W);
  // The whip starts on the shot's second beat and takes a third of a second.
  const beat = plan.beats.find((b) => b > s.from) ?? s.from + 15;
  const k = interpolate(frame, [beat, beat + 10], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const drift = interpolate(frame, [s.from, s.to], [0, 1], clamp);
  const x = -(span * (0.02 * drift + 0.96 * k + 0.02 * drift * k));
  // A whip smears: the faster the pan, the longer the smear.
  const speed = Math.abs(interpolate(frame + 0.5, [beat, beat + 10], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) }) - interpolate(frame - 0.5, [beat, beat + 10], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) }));
  const smear = speed * span * 0.35;
  return (
    <AbsoluteFill style={{ background: color.ink }}>
      <Img src={frameFile(s, frame)} style={{ position: "absolute", left: 0, top: 0, width: s.source.width, height: H, maxWidth: "none", transform: `translateX(${x.toFixed(2)}px)`, filter: smear > 1 ? `blur(${Math.min(40, smear / 14).toFixed(1)}px)` : undefined }} />
    </AbsoluteFill>
  );
}

/** The sign: the mark and the name, the address, the network and the day. */
function Sign({ frame, at, stamp }: { frame: number; at: number; stamp: string }) {
  if (frame < at) return null;
  const arrive = (delay: number): CSSProperties => ({
    opacity: interpolate(frame, [at + delay, at + delay + 4], [0, 1], clamp),
    translate: `0 ${interpolate(frame, [at + delay, at + delay + 10], [28, 0], { ...clamp, easing: out })}px`,
  });
  const mark = 168;
  return (
    <AbsoluteFill style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 54 }}>
      <div style={{ display: "flex", alignItems: "center", gap: (mark * 240) / 280 / 4, ...arrive(0) }}>
        <svg viewBox="0 0 240 280" style={{ height: mark, width: "auto", display: "block" }}>
          <path fill={color.ice} d={MARK} />
        </svg>
        <div style={word(mark * 0.47, { color: color.ice, letterSpacing: "0.02em", lineHeight: 1.04 })}>
          MASK
          <br />
          WARS
        </div>
      </div>
      <div style={{ ...num(112, { color: color.ice, fontStretch: "100%", fontWeight: 700, letterSpacing: "0" }), ...arrive(3) }}>{SITE}</div>
      <div style={{ ...word(MIN_TYPE, { color: color.ice60, letterSpacing: "0.07em" }), ...arrive(6) }}>
        {stamp.split(/(\d+)/).map((part, i) => (i % 2 ? <span key={i} style={{ fontFamily: FONT.num }}>{part}</span> : part))}
      </div>
    </AbsoluteFill>
  );
}

/** A soft dark over the corners: the eye stays on the middle, as on the arena. */
function Vignette() {
  return <AbsoluteFill style={{ background: `radial-gradient(72% 78% at 50% 50%, rgba(6,5,12,0) 58%, rgba(6,5,12,.62) 100%)` }} />;
}

function Shot({ s, frame, plan, n }: { s: Segment; frame: number; plan: BreakPlan; n: BreakNumbers }) {
  const h = plan.hits;
  const wrap = (children: ReactNode) => <AbsoluteFill style={{ background: color.ink, overflow: "hidden" }}>{children}</AbsoluteFill>;
  switch (s.id) {
    case "crack":
      return wrap(
        <>
          <Picture s={s} frame={frame} cam={camera(frame, s, [1.03, 1.07], [{ at: h.crack, power: 1 }])} />
          <Shards frame={frame} at={h.crack} />
          <Vignette />
          <Flash frame={frame} at={h.crack} />
        </>,
      );
    case "eye":
      return wrap(
        <>
          <Picture s={s} frame={frame} cam={camera(frame, s, [1.03, 1.12], [{ at: h.ignite, power: 0.5 }])} />
          <Vignette />
        </>,
      );
    case "hero":
      return wrap(
        <>
          <Picture s={s} frame={frame} cam={camera(frame, s, [1.03, 1.09], [{ at: h.name, power: 0.7 }])} origin="62% 50%" />
          {/* The left field goes a little darker under the name, so it reads on any footage. */}
          <AbsoluteFill style={{ background: `linear-gradient(90deg, rgba(6,5,12,.72) 0%, rgba(6,5,12,.38) 34%, rgba(6,5,12,0) 56%)` }} />
          <Vignette />
          <Name frame={frame} at={h.name} name={n.winner} />
        </>,
      );
    case "arena":
      return wrap(
        <>
          {/* The page whole, as a person sees it: no push that would cut its own edges, only the hit. */}
          <Picture s={s} frame={frame} cam={camera(frame, s, [1.0, 1.0], [{ at: h.split, power: 0.4 }])} origin="50% 34%" />
          <Flash frame={frame} at={h.split} power={0.5} from="50% 34%" />
        </>,
      );
    case "flow":
      return wrap(
        <>
          <Picture s={s} frame={frame} cam={camera(frame, s, [1.03, 1.06], [{ at: h.land, power: 0.9 }, { at: h.sum, power: 0.4 }])} origin="40% 55%" />
          {/* The right field goes dark under the sum: a rival standing there is not read through the digits. */}
          <AbsoluteFill style={{ background: `linear-gradient(270deg, rgba(6,5,12,.94) 0%, rgba(6,5,12,.86) 26%, rgba(6,5,12,.4) 44%, rgba(6,5,12,0) 60%)` }} />
          <Vignette />
          <Counter frame={frame} plan={plan} n={n} />
          <Flash frame={frame} at={h.land} power={0.6} from="34% 56%" />
        </>,
      );
    case "league":
      return wrap(<Row s={s} frame={frame} plan={plan} />);
    case "end": {
      // The light goes down under the sign; when the vault shuts, the door behind it is nearly dark.
      const dim = interpolate(frame, [s.from, h.sign, h.lock, h.lock + 6], [0.1, 0.7, 0.7, 0.8], clamp);
      return wrap(
        <>
          <Picture s={s} frame={frame} cam={camera(frame, s, [1.07, 1.03], [{ at: h.lock, power: 0.8 }])} />
          <AbsoluteFill style={{ background: color.ink, opacity: dim }} />
          <Vignette />
          <Sign frame={frame} at={h.sign} stamp={n.stamp} />
          <Flash frame={frame} at={h.lock} power={0.3} />
        </>,
      );
    }
  }
}

function Sound({ plan, sounds }: { plan: BreakPlan; sounds: BreakSounds }) {
  const h = plan.hits;
  const end = plan.durationInFrames;
  // Each hard hit pushes the music down for a moment, so the hit is what is heard.
  const hard = [h.crack, h.split, h.land, h.sum, h.sign, h.lock];
  const music = (f: number): number => {
    const duck = Math.max(0, ...hard.map((at) => (f >= at ? Math.exp(-(f - at) / 5) : 0)));
    return 0.86 * (1 - 0.45 * duck) * interpolate(f, [end - 5, end], [1, 0.2], clamp);
  };
  const once = (at: number, src: string, volume: number, key: string) => (
    <Sequence key={key} from={at} layout="none">
      <Html5Audio src={staticFile(src)} volume={volume} />
    </Sequence>
  );
  return (
    <>
      {sounds.music ? <Html5Audio src={staticFile(sounds.music)} volume={music} /> : null}
      {h.crack > 2 ? once(0, sounds.rise, 0.7, "rise") : null}
      {once(h.crack, sounds.impact, 1, "crack")}
      {plan.cuts.map((c, i) => once(c, sounds.bolt, 0.6, `cut${i}`))}
      {once(h.ignite, sounds.bolt, 0.45, "ignite")}
      {once(h.name, sounds.impact, 0.62, "name")}
      {once(h.split, sounds.impact, 0.85, "split")}
      {once(h.land, sounds.landing, 1, "land")}
      {once(h.sum, sounds.impact, 0.7, "sum")}
      {once(h.sign, sounds.impact, 0.6, "sign")}
      {once(h.lock, sounds.bolt, 1, "lock")}
    </>
  );
}

export function Break({ record, plan, sounds }: BreakProps) {
  const frame = useCurrentFrame();
  const n = breakNumbers(record);
  const s = plan.segments.find((x) => frame >= x.from && frame < x.to) ?? plan.segments[plan.segments.length - 1]!;
  return (
    <AbsoluteFill style={{ background: color.ink, overflow: "hidden" }}>
      <Shot s={s} frame={frame} plan={plan} n={n} />
      {sounds ? <Sound plan={plan} sounds={sounds} /> : null}
      {record.source === "SIMULATED" ? <SimulatedBand width={W} /> : null}
    </AbsoluteFill>
  );
}
