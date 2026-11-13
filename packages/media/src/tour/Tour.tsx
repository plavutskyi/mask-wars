/**
 * The tour: everything MASK WARS does and how to use each thing, in 2:30 of the live site. Ten chapters; each opens
 * with a card (its number and its name over the page it is about, out of focus) and then plays the page as it was
 * used, whole above the caption bar, with one line under it for each step. A ring opens where the film pressed, and
 * the thing a line is about is lit while the rest of the page goes darker.
 *
 * The caption bar, the words over a full frame, the ring and the sign are the demo film's (`demo/Demo.tsx`); the
 * hits and the type are the long film's (`promo/Promo.tsx`). The parts and their words are `cut()` of the data.
 */

import { color } from "@maskwars/brand";
import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, Easing, Html5Audio, Img, interpolate, OffthreadVideo, Sequence, staticFile, useCurrentFrame } from "remotion";
import "../clip/fonts.ts";
import { FONT } from "../clip/fonts.ts";
import { Bar, Full, Mark, Taps } from "../demo/Demo.tsx";
import { barFrame, MIN_TYPE, REGION_H } from "../demo/plan.ts";
import { Arrive, clamp, fit, Flash, head, kicker, shakeOf, Slam } from "../promo/Promo.tsx";
import type { Segment, TourData } from "./plan.ts";
import { beatFrame, CHAPTERS, cut, DURATION, HOOK, tagOf, TOUR } from "./plan.ts";

const W = TOUR.width;
const H = TOUR.height;
const FIELD = 96;
const small: CSSProperties = { ...kicker, fontSize: MIN_TYPE, lineHeight: 1 };
/** The bars the track hits hardest on: the two drops, the finale and its last hit. A part that starts there shakes. */
const HITS: readonly number[] = [17, 53, 72, 76];
/** A ring opens this many frames before the press it marks: the eye is on the control when the page answers. */
const TAP_LEAD = 5;
const vignette = "radial-gradient(75% 80% at 50% 50%, rgba(6,5,12,0) 55%, rgba(6,5,12,.7) 100%)";

/** A page as a backdrop for words in the middle of the frame: darker, and out of focus so its own words do not read. */
function Backdrop({ children, blur, veil }: { children: ReactNode; blur: number; veil: number }) {
  return (
    <AbsoluteFill style={{ overflow: "hidden", background: color.ink }}>
      <div style={{ position: "absolute", inset: -2 * blur, filter: `blur(${blur}px)` }}>
        <div style={{ position: "absolute", inset: 2 * blur }}>{children}</div>
      </div>
      <AbsoluteFill style={{ background: `rgba(6,5,12,${veil})` }} />
      <AbsoluteFill style={{ background: vignette }} />
    </AbsoluteFill>
  );
}

// ——— The first words ———

function Hook({ len }: { len: number }) {
  const frame = useCurrentFrame();
  const second = beatFrame(HOOK.at, HOOK.second * 4);
  const scale = interpolate(frame, [0, len], [1, 1.06], { easing: Easing.inOut(Easing.quad) });
  return (
    <AbsoluteFill style={{ overflow: "hidden", background: color.ink }}>
      <OffthreadVideo src={staticFile("tour/home.mp4")} muted style={{ position: "absolute", left: 0, top: 0, width: W, height: H, objectFit: "cover", transformOrigin: "50% 34%", scale: `${scale}` }} />
      <AbsoluteFill style={{ background: vignette }} />
      {/* Under the words the page is gone: its own small type never shows through the film's. */}
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(6,5,12,0) 49%, rgba(6,5,12,1) 60%)" }} />
      {frame < second ? (
        <Full w={{ place: "low", kicker: "The tour · 10 chapters", head: "Everything\nMASK WARS does.", size: 124, steady: true }} frame={frame} />
      ) : (
        <Full w={{ place: "low", kicker: "The tour · 10 chapters", head: "And how to\nuse each one.", size: 124, steady: "kicker" }} frame={frame - second} />
      )}
      {frame >= second ? <Flash frame={frame - second} /> : null}
    </AbsoluteFill>
  );
}

// ——— A chapter's card ———

/** The ten chapters as a rail: the ones seen, the one that starts, the ones to come. */
function Rail({ no }: { no: number }) {
  const gap = 14;
  const w = (W - 2 * FIELD - gap * (CHAPTERS.length - 1)) / CHAPTERS.length;
  return (
    <div style={{ display: "flex", gap }}>
      {CHAPTERS.map((c) => (
        <div key={c.no} style={{ width: w, height: 10, background: c.no === no ? color.amber : color.ice, opacity: c.no === no ? 1 : c.no < no ? 0.5 : 0.16 }} />
      ))}
    </div>
  );
}

function Card({ seg }: { seg: Extract<Segment, { kind: "card" }> }) {
  const frame = useCurrentFrame();
  const hit = HITS.includes(seg.at);
  const shake = hit ? shakeOf(frame, 1) : { x: 0, y: 0, s: 0 };
  const size = Math.max(MIN_TYPE, fit(seg.name, 150, W - 2 * FIELD - 40));
  const number = String(seg.no).padStart(2, "0");
  return (
    <AbsoluteFill style={{ overflow: "hidden", background: color.ink }}>
      <div style={{ position: "absolute", inset: 0, translate: `${shake.x}px ${shake.y}px`, scale: `${1 + shake.s}` }}>
        <Backdrop blur={22} veil={0.5}>
          <Img src={staticFile(`tour/${seg.poster}.jpg`)} style={{ position: "absolute", left: 0, top: (H - REGION_H * 1.25) / 2, width: W * 1.25, marginLeft: -W * 0.125, maxWidth: "none" }} />
        </Backdrop>
      </div>
      <div style={{ position: "absolute", left: FIELD, right: FIELD, top: 0, bottom: 70, display: "flex", flexDirection: "column", justifyContent: "center", gap: 26 }}>
        <Slam frame={frame} at={0} style={{ transformOrigin: "0% 50%" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 30 }}>
            <div style={{ fontFamily: FONT.num, fontWeight: 800, fontStretch: "125%", fontSize: 300, lineHeight: 0.84, letterSpacing: "-0.02em", color: color.amber }}>{number}</div>
            <div style={{ ...small, color: color.ice, opacity: 0.62, fontFamily: FONT.num }}>of {CHAPTERS.length}</div>
          </div>
        </Slam>
        <Slam frame={frame} at={2} style={{ transformOrigin: "0% 50%" }}>
          <div style={{ ...head(size), textShadow: `0 4px 40px ${color.ink}` }}>
            {seg.name.split("\n").map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        </Slam>
      </div>
      <Arrive frame={frame} at={0} style={{ position: "absolute", left: FIELD, bottom: 96 }}>
        <Rail no={seg.no} />
      </Arrive>
      <Flash frame={frame} />
    </AbsoluteFill>
  );
}

// ——— A page being used ———

function Lit({ seg, frame }: { seg: Extract<Segment, { kind: "reel" }>; frame: number }) {
  const spot = seg.spots.find((s) => frame >= s.from && frame < s.to);
  if (!spot) return null;
  const lit = Math.min(interpolate(frame - spot.from, [0, 9], [0, 1], clamp), interpolate(spot.to - frame, [0, 5], [0, 1], clamp));
  const pad = 14;
  const r = spot.rect;
  const x = Math.max(6, r.x - pad);
  const y = Math.max(6, r.y - pad);
  const right = Math.min(W - 6, r.x + r.w + pad);
  const bottom = Math.min(REGION_H - 6, r.y + r.h + pad);
  if (right <= x || bottom <= y) return null;
  return <div style={{ position: "absolute", left: x, top: y, width: right - x, height: bottom - y, borderRadius: 4, boxShadow: `0 0 0 4000px rgba(6,5,12,${0.36 * lit}), inset 0 0 0 3px rgba(238,241,255,${0.62 * lit})` }} />;
}

function ReelView({ seg }: { seg: Extract<Segment, { kind: "reel" }> }) {
  const frame = useCurrentFrame();
  const starts = seg.lines.map((l) => beatFrame(seg.at, l.beat));
  let i = 0;
  while (i + 1 < starts.length && starts[i + 1]! <= frame) i++;
  const line = seg.lines[i]!;
  const tag = line.kicker ?? tagOf(seg.no);
  const sameTag = i > 0 && (seg.lines[i - 1]!.kicker ?? tagOf(seg.no)) === tag;
  return (
    <AbsoluteFill style={{ overflow: "hidden", background: color.ink }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: W, height: REGION_H, overflow: "hidden" }}>
        <OffthreadVideo src={staticFile(`tour/${seg.reel}.mp4`)} muted style={{ position: "absolute", left: 0, top: 0, width: W, height: REGION_H }} />
        <Lit seg={seg} frame={frame} />
        <Taps taps={seg.taps} frame={frame + TAP_LEAD} />
      </div>
      <Bar w={{ kicker: tag, head: line.head, ...(line.tint ? { tint: line.tint } : {}), steady: sameTag ? "kicker" : false }} frame={frame - starts[i]!} />
      {frame < 6 ? <Flash frame={frame} /> : null}
    </AbsoluteFill>
  );
}

// ——— The end card ———

function End() {
  const frame = useCurrentFrame();
  const shake = shakeOf(frame, 1);
  return (
    <AbsoluteFill style={{ overflow: "hidden", background: color.ink }}>
      <div style={{ position: "absolute", inset: 0, translate: `${shake.x}px ${shake.y}px`, scale: `${1 + shake.s}` }}>
        <Backdrop blur={22} veil={0.8}>
          <OffthreadVideo src={staticFile("tour/home.mp4")} startFrom={8} muted style={{ position: "absolute", left: 0, top: 0, width: W, height: H, objectFit: "cover", transformOrigin: "50% 34%", scale: `${interpolate(frame, [0, 240], [1.08, 1.16], clamp)}` }} />
        </Backdrop>
      </div>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 44 }}>
        <Slam frame={frame} at={0}>
          <Mark height={210} />
        </Slam>
        <Slam frame={frame} at={1}>
          <div style={{ ...head(170), fontFamily: FONT.num, textTransform: "none", letterSpacing: "0.01em", textShadow: `0 4px 40px ${color.ink}` }}>maskwars.xyz</div>
        </Slam>
        <Arrive frame={frame} at={8}>
          <div style={{ ...small, marginTop: 20 }}>Built at NEAR HACKATHON</div>
        </Arrive>
      </div>
      <Flash frame={frame} />
    </AbsoluteFill>
  );
}

export type TourProps = { data: TourData; music: string | null };

export function Tour({ data, music }: TourProps) {
  return (
    <AbsoluteFill style={{ background: color.ink }}>
      {cut(data).map((seg, i) => {
        const len = barFrame(seg.at + seg.len) - barFrame(seg.at);
        return (
          <Sequence key={i} from={barFrame(seg.at)} durationInFrames={len} layout="none">
            {seg.kind === "hook" ? <Hook len={len} /> : seg.kind === "card" ? <Card seg={seg} /> : seg.kind === "reel" ? <ReelView seg={seg} /> : <End />}
          </Sequence>
        );
      })}
      {music ? <Html5Audio src={staticFile(music)} volume={(f) => interpolate(f, [0, 2, DURATION - 40, DURATION - 2], [0, 1, 1, 0], clamp)} /> : null}
    </AbsoluteFill>
  );
}
