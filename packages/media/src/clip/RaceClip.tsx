/**
 * The race clip, 16:9. Frame 0 is the result, ready to be the thumbnail. Then the vault and its bounty, the masks
 * racing a private copy until one breaks through, the real vault cracking open, the contract paying, the call to come
 * next. Captions are burned in for a feed that plays muted. Built from `brand/art/web` and the brand tokens; fonts,
 * frames and music come from the render's public dir.
 */

import { color } from "@maskwars/brand";
import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, continueRender, delayRender, Easing, Html5Audio, Img, interpolate, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { MARK } from "../cards/mark.ts";
import { near } from "../race/near.ts";
import type { RaceRecord } from "../race/record.ts";
import type { RaceStory, StoryMask } from "../race/story.ts";
import { raceStory, SITE } from "../race/story.ts";
import type { RaceClipPlan, Span } from "./race-plan.ts";
import { countUp, planRaceClip, RACE_CLIP, raceClock } from "./race-plan.ts";

const W = RACE_CLIP.width;
const H = RACE_CLIP.height;
const FONT = { word: "'Hubot Sans', system-ui, sans-serif", num: "'Mona Sans', system-ui, sans-serif" } as const;
const ease = Easing.bezier(0.16, 1, 0.3, 1);
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
/** Left field of the frame: 64 px at 1440 wide, scaled to 1920. */
const FIELD = 115;

// Fonts: the render waits for both faces before the first frame.
if (typeof document !== "undefined") {
  const handle = delayRender("fonts");
  Promise.all(
    [
      ["Hubot Sans", "fonts/hubot-sans.woff2"],
      ["Mona Sans", "fonts/mona-sans.woff2"],
    ].map(([family, file]) => {
      const f = new FontFace(family!, `url(${staticFile(file!)})`, { weight: "200 900", stretch: "75% 125%" });
      (document.fonts as unknown as Set<FontFace>).add(f);
      return f.load();
    }),
  ).then(() => continueRender(handle));
}

const word = (size: number, extra: CSSProperties = {}): CSSProperties => ({
  fontFamily: FONT.word,
  fontWeight: 800,
  fontStretch: "125%",
  fontSize: size,
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
  fontSize: size,
  lineHeight: 0.92,
  letterSpacing: "-0.01em",
  // Lining only: Mona's tabular figures draw a dotted zero.
  fontVariantNumeric: "lining-nums",
  whiteSpace: "nowrap",
  ...extra,
});
const label = (size = 43): CSSProperties => word(size, { color: color.ice60, letterSpacing: "0.06em" });

/**
 * A size that keeps one line inside `maxW`. `em` is the width of one character in ems, measured on the brand faces
 * at their widest (Mona 800 numbers ≈ .66, Hubot 800 capitals ≈ .84), with a margin.
 */
const fit = (text: string, base: number, maxW: number, em: number): number => Math.min(base, Math.floor(maxW / (text.length * em)));

/** A square mask portrait, `h` px, placed by its centre. */
function Face({ m, cx, top, h, style }: { m: StoryMask; cx: number; top: number; h: number; style?: CSSProperties }) {
  return <Img src={staticFile(`art/${m.art}.jpg`)} style={{ position: "absolute", left: cx - h / 2, top, width: h, height: h, mixBlendMode: "lighten", ...style }} />;
}

/** The vault: the ring frame, `h` px tall, centred on (cx, cy). Optionally only one half of it. */
function Ring({ h, cx = W / 2, cy = H / 2, half, style }: { h: number; cx?: number; cy?: number; half?: "left" | "right"; style?: CSSProperties }) {
  const w = (h * 2200) / 1235;
  const clip = half === "left" ? "inset(0 50% 0 0)" : half === "right" ? "inset(0 0 0 50%)" : undefined;
  return (
    <Img
      src={staticFile("art/ring.jpg")}
      style={{ position: "absolute", left: cx - w / 2, top: cy - h / 2, width: w, height: h, mixBlendMode: "lighten", clipPath: clip, ...style }}
    />
  );
}

function Sign({ height = 56 }: { height?: number }) {
  return (
    <div style={{ position: "absolute", left: FIELD, bottom: 86, display: "flex", alignItems: "center", gap: height * 0.4 }}>
      <svg viewBox="0 0 240 280" style={{ height, width: "auto", display: "block" }}>
        <path fill={color.ice} d={MARK} />
      </svg>
      <span style={word(height * 0.78, { color: color.ice, letterSpacing: "0.02em" })}>MASK WARS</span>
    </div>
  );
}

function Floor({ at = "74% 52%" }: { at?: string }) {
  return <AbsoluteFill style={{ background: `radial-gradient(46% 64% at ${at}, ${color.ink2} 0%, ${color.ink} 74%)` }} />;
}

/** The ring that runs out from a hit, 700 ms (BRANDBOOK §9). */
function Shock({ frame, at, cx, cy, size, tint = color.amber }: { frame: number; at: number; cx: number; cy: number; size: number; tint?: string }) {
  const k = interpolate(frame, [at, at + 21], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  if (frame < at || k >= 1) return null;
  // It runs out from behind the object, never as a dot on it.
  const d = size * (0.3 + 0.7 * k);
  return <div style={{ position: "absolute", left: cx - d / 2, top: cy - d / 2, width: d, height: d, borderRadius: "50%", border: `3px solid ${tint}`, opacity: 1 - k }} />;
}

/** The hit: the stage jumps 1.2% in 60 ms and springs back in .35 s. */
function punch(frame: number, at: number, fps: number): number {
  if (frame < at) return 1;
  if (frame < at + 2) return interpolate(frame, [at, at + 2], [1, 1.012]);
  return 1 + 0.012 * (1 - spring({ frame: frame - at - 2, fps, config: { damping: 14, stiffness: 180 }, durationInFrames: Math.round(0.35 * fps) }));
}

/** Text that arrives: up 24 px and in, on the brand's ease. */
function Arrive({ frame, at, children, style }: { frame: number; at: number; children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        opacity: interpolate(frame, [at, at + 10], [0, 1], clamp),
        translate: `0 ${interpolate(frame, [at, at + 14], [24, 0], { ...clamp, easing: ease })}px`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** The race clock, each digit in a slot of .72em so it never jitters (BRANDBOOK §4). */
function Clock({ text, size, tint }: { text: string; size: number; tint: string }) {
  return (
    <div style={num(size, { color: tint, display: "flex" })}>
      {[...text].map((ch, i) => (
        <span key={i} style={{ display: "inline-block", width: ch === ":" ? "0.36em" : "0.72em", textAlign: "center" }}>
          {ch}
        </span>
      ))}
    </div>
  );
}

// ——— Scenes. Each gets its local frame. ———

function Result({ s }: { s: RaceStory }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const drained = `${s.drained} NEAR`;
  return (
    <AbsoluteFill>
      <Floor />
      <Face m={s.winner} cx={1404} top={65} h={950} style={{ scale: interpolate(frame, [0, durationInFrames], [1, 1.035]) }} />
      <div style={{ position: "absolute", left: FIELD, top: 0, bottom: 40, width: 1030, display: "flex", flexDirection: "column", justifyContent: "center", gap: 36 }}>
        <div style={label()}>{`RACE ${s.no} · ${s.chain.toUpperCase()}`}</div>
        <div style={num(fit(drained, 252, 960, 0.7), { color: color.money })}>{drained}</div>
        <div style={word(fit(`DRAINED BY ${s.winner.name}`, 77, 1030, 0.86), { color: color.ice })}>DRAINED BY {s.winner.name}</div>
        <div style={word(43, { letterSpacing: "0.04em" })}>
          <span style={num(43, { color: color.money })}>+{s.paid} NEAR</span> <span style={{ color: color.ice60 }}>BOUNTY ON TOP</span>
        </div>
      </div>
      <Sign />
    </AbsoluteFill>
  );
}

/** Where the vault stands in the frame: clear of the captions at the bottom. */
const VAULT = { h: 860, cy: 470 } as const;

function Vault({ s }: { s: RaceStory }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const bounty = `${s.bounty} NEAR`;
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ scale: interpolate(frame, [0, durationInFrames], [0.94, 1], { easing: Easing.out(Easing.quad) }) }}>
        <Floor at="50% 44%" />
        <Ring h={VAULT.h} cy={VAULT.cy} style={{ opacity: interpolate(frame, [0, 12], [0, 1], clamp), rotate: `${interpolate(frame, [0, durationInFrames], [-2.5, 1.5])}deg` }} />
        <div style={{ position: "absolute", left: W / 2 - 300, top: VAULT.cy - 180, width: 600, height: 360, borderRadius: "50%", background: `radial-gradient(closest-side, ${color.ink} 55%, rgba(6,5,12,0) 100%)` }} />
      </AbsoluteFill>
      <div style={{ position: "absolute", left: 0, right: 0, top: VAULT.cy - 150, display: "flex", flexDirection: "column", alignItems: "center", gap: 26 }}>
        <Arrive frame={frame} at={4}>
          <div style={label(34)}>{`RACE ${s.no} · ${s.chain.toUpperCase()}`}</div>
        </Arrive>
        <Arrive frame={frame} at={14}>
          <div style={num(fit(bounty, 160, 560, 0.7), { color: color.money })}>{bounty}</div>
        </Arrive>
        <Arrive frame={frame} at={22}>
          <div style={word(46, { color: color.ice, letterSpacing: "0.06em" })}>BOUNTY</div>
        </Arrive>
      </div>
    </AbsoluteFill>
  );
}

function Race({ s, plan }: { s: RaceStory; plan: RaceClipPlan }) {
  const frame = useCurrentFrame();
  const { durationInFrames, fps } = useVideoConfig();
  const from = plan.scenes.race.from;
  const hit = plan.beats.breach - from;
  const clockFrom = plan.clock.from - from;
  const t = interpolate(frame, [clockFrom, hit], [0, s.breach.ms], clamp);
  const broke = frame >= hit;
  const n = s.masks.length;
  const slot = Math.min(560, (W - 2 * FIELD) / n);
  const size = Math.min(540, slot * 1.02);
  const board = s.record.sandbox.board;
  const status = (m: StoryMask): { text: string; tint: string } => {
    const mine = board.filter((b) => b.mask === m.name && b.atMs <= t);
    const last = mine[mine.length - 1];
    if (last?.verdict === "breach" && broke) return { text: "BREACH", tint: color.amber };
    const attempt = (last ? last.attempt + (last.verdict === "fail" ? 1 : 0) : 1);
    return { text: `ATTEMPT ${attempt}`, tint: color.ice60 };
  };
  const top = 196;
  return (
    <AbsoluteFill>
      {/* One stage: the floor and the masks blend in the same layer, so a portrait's black is the arena's dark. */}
      <AbsoluteFill style={{ scale: punch(frame, hit, fps) * interpolate(frame, [0, durationInFrames], [1, 1.03]) }}>
        <AbsoluteFill style={{ background: color.ink }} />
        <Img
          src={staticFile("art/arena.jpg")}
          style={{ position: "absolute", left: -40, top: 0, width: W + 80, height: H, objectFit: "cover", opacity: 0.7, translate: `${interpolate(frame, [0, durationInFrames], [-28, 28])}px 0` }}
        />
        <AbsoluteFill style={{ background: `linear-gradient(180deg, ${color.ink} 0%, rgba(6,5,12,.5) 26%, rgba(6,5,12,0) 52%, rgba(6,5,12,.55) 74%, ${color.ink} 100%)` }} />
        {s.masks.map((m, i) => {
          // Parallax: the masks drift against the floor, nearer ones further.
          const cx = W / 2 + (i - (n - 1) / 2) * slot + interpolate(frame, [0, durationInFrames], [14, -14]);
          const win = m.name === s.winner.name;
          const dim = broke && !win ? interpolate(frame, [hit, hit + 8], [1, 0.3], clamp) : 1;
          const grow = win && broke ? interpolate(frame, [hit, hit + 12], [1, 1.06], { ...clamp, easing: ease }) : 1;
          const st = status(m);
          return (
            <div key={m.name}>
              <div style={{ position: "absolute", left: cx - size * 0.3, top: top + size * 0.08, width: size * 0.6, height: size * 0.86, borderRadius: "50%", background: `radial-gradient(closest-side, ${color.ink} 62%, rgba(6,5,12,0) 100%)` }} />
              <Face m={m} cx={cx} top={top} h={size} style={{ scale: grow, filter: `brightness(${dim})` }} />
              <div style={{ position: "absolute", left: cx - slot / 2, width: slot, top: top + size * 0.93, display: "flex", flexDirection: "column", alignItems: "center", gap: 14, opacity: 0.35 + 0.65 * ((dim - 0.3) / 0.7) }}>
                <div style={word(52, { color: color.ice })}>{m.name}</div>
                <div style={word(34, { color: st.tint, letterSpacing: "0.08em", opacity: broke && !win ? interpolate(frame, [hit, hit + 8], [1, 0], clamp) : 1 })}>{st.text}</div>
              </div>
            </div>
          );
        })}
        {s.masks.map((m, i) =>
          m.name === s.winner.name ? (
            <Shock key={m.name} frame={frame} at={hit} cx={W / 2 + (i - (n - 1) / 2) * slot + interpolate(frame, [0, durationInFrames], [14, -14])} cy={top + size * 0.465} size={900} />
          ) : null,
        )}
      </AbsoluteFill>
      <div style={{ position: "absolute", left: 0, right: 0, top: 46, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
        <div style={label(32)}>THE SANDBOX · A PRIVATE COPY</div>
        <Clock text={raceClock(t)} size={84} tint={broke ? color.amber : color.ice} />
      </div>
    </AbsoluteFill>
  );
}

function Drain({ s, plan }: { s: RaceStory; plan: RaceClipPlan }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const crack = plan.beats.crack - plan.scenes.drain.from;
  const open = spring({ frame: frame - crack, fps, config: { damping: 16, stiffness: 90 } });
  const apart = frame < crack ? 0 : open * 120;
  const flash = frame < crack ? interpolate(frame, [0, crack], [0, 0.5], { ...clamp, easing: Easing.in(Easing.quad) }) : interpolate(frame, [crack, crack + 2, crack + 10], [1, 1, 0], clamp);
  const out = `${s.drained} NEAR`;
  return (
    <AbsoluteFill style={{ scale: punch(frame, crack, fps) }}>
      <AbsoluteFill style={{ scale: interpolate(frame, [0, crack], [0.97, 1], { ...clamp, easing: Easing.in(Easing.quad) }) }}>
        <Floor at="50% 44%" />
        <Ring h={VAULT.h} cy={VAULT.cy} half="left" style={{ translate: `${-apart}px 0` }} />
        <Ring h={VAULT.h} cy={VAULT.cy} half="right" style={{ translate: `${apart}px 0` }} />
        <div style={{ position: "absolute", left: W / 2 - 3, top: VAULT.cy - 372, width: 6, height: 744, background: color.ice, opacity: flash }} />
      </AbsoluteFill>
      <Shock frame={frame} at={crack} cx={W / 2} cy={VAULT.cy} size={1500} />
      <div style={{ position: "absolute", left: FIELD, top: 86 }}>
        <div style={label(34)}>THE REAL VAULT</div>
      </div>
      {frame >= crack ? (
        <div style={{ position: "absolute", left: 0, right: 0, top: VAULT.cy - 120, display: "flex", flexDirection: "column", alignItems: "center", gap: 28 }}>
          <div
            style={num(fit(out, 200, 700, 0.7), {
              color: color.money,
              scale: interpolate(frame, [crack, crack + 16], [0.6, 1], { ...clamp, easing: ease }),
              opacity: interpolate(frame, [crack, crack + 6], [0, 1], clamp),
            })}
          >
            {out}
          </div>
          <Arrive frame={frame} at={crack + 10}>
            <div style={word(48, { color: color.ice, letterSpacing: "0.06em" })}>OUT OF THE VAULT</div>
          </Arrive>
        </div>
      ) : null}
    </AbsoluteFill>
  );
}

function Paid({ s }: { s: RaceStory }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const k = interpolate(frame, [14, 50], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const paid = `+${countUp(s.paid, k)} NEAR`;
  const total = `${s.winner.name} TAKES ${s.total} NEAR`;
  return (
    <AbsoluteFill>
      <Floor at="72% 60%" />
      <div style={{ position: "absolute", left: 980, right: 0, bottom: 0, height: 520, background: `radial-gradient(50% 60% at 50% 100%, rgba(255,178,63,.20), rgba(255,178,63,0) 72%)` }} />
      <Face m={s.winner} cx={1440} top={40} h={900} style={{ scale: interpolate(frame, [0, durationInFrames], [1.02, 1.07]) }} />
      <div style={{ position: "absolute", left: FIELD, top: 0, bottom: 200, width: 1060, display: "flex", flexDirection: "column", justifyContent: "center", gap: 34 }}>
        <Arrive frame={frame} at={2}>
          <div style={label()}>PAID BY THE CONTRACT</div>
        </Arrive>
        <div style={num(fit(`+${s.paid} NEAR`, 200, 1060, 0.7), { color: color.money, opacity: interpolate(frame, [8, 14], [0, 1], clamp) })}>{paid}</div>
        <Arrive frame={frame} at={56}>
          <div style={word(fit(total, 60, 1060, 0.86), { color: color.ice })}>
            {s.winner.name} TAKES <span style={num(fit(total, 60, 1060, 0.86), { color: color.money })}>{s.total} NEAR</span>
          </div>
        </Arrive>
      </div>
    </AbsoluteFill>
  );
}

function End({ s }: { s: RaceStory }) {
  const frame = useCurrentFrame();
  const n = s.record.next;
  return (
    <AbsoluteFill>
      <Floor at="72% 50%" />
      <Ring h={860} cx={1440} cy={520} style={{ opacity: interpolate(frame, [0, 14], [0, 1], clamp) }} />
      <div style={{ position: "absolute", left: FIELD, top: 0, bottom: 40, width: 940, display: "flex", flexDirection: "column", justifyContent: "center", gap: 40 }}>
        {n ? (
          <>
            <Arrive frame={frame} at={4}>
              <div style={label()}>NEXT</div>
            </Arrive>
            <Arrive frame={frame} at={8}>
              <div style={word(115, { color: color.ice })}>RACE {Number(n.id.slice(5))}</div>
            </Arrive>
            <Arrive frame={frame} at={12}>
              <div style={num(fit(`${near(n.bounty)} NEAR`, 144, 900, 0.7), { color: color.money })}>{near(n.bounty)} NEAR</div>
            </Arrive>
          </>
        ) : (
          <Arrive frame={frame} at={4}>
            <div style={word(115, { color: color.ice, lineHeight: 1.02, whiteSpace: "normal" })}>
              YOUR
              <br />
              CONTRACT
              <br />
              IS NEXT.
            </div>
          </Arrive>
        )}
        <Arrive frame={frame} at={16}>
          <div style={num(67, { color: color.ice, fontStretch: "100%", fontWeight: 700, letterSpacing: 0 })}>{SITE}</div>
        </Arrive>
      </div>
      <Sign />
    </AbsoluteFill>
  );
}

/** The line at the bottom: one at a time, over a band of dark so it reads on any frame. */
function Captions({ plan }: { plan: RaceClipPlan }) {
  const frame = useCurrentFrame();
  const c = plan.captions.find((x) => frame >= x.from && frame < x.to);
  // The band under the lines holds still from the first line to the last, so it never blinks between two.
  const first = plan.captions[0]!.from;
  const last = plan.captions[plan.captions.length - 1]!.to;
  const band = interpolate(frame, [first, first + 6, last - 6, last], [0, 1, 1, 0], clamp);
  return (
    <>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 300, background: `linear-gradient(180deg, rgba(6,5,12,0) 0%, rgba(6,5,12,.86) 72%)`, opacity: band }} />
      {c ? (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 70, display: "flex", justifyContent: "center" }}>
          <div
            style={{
              maxWidth: 1480,
              textAlign: "center",
              fontFamily: FONT.num,
              fontWeight: 600,
              fontStretch: "100%",
              fontSize: 50,
              lineHeight: 1.24,
              textWrap: "balance",
              color: color.ice,
              textShadow: `0 2px 18px ${color.ink}`,
              opacity: interpolate(frame, [c.from, c.from + 6, c.to - 6, c.to], [0, 1, 1, 0], clamp),
              translate: `0 ${interpolate(frame, [c.from, c.from + 10], [14, 0], { ...clamp, easing: ease })}px`,
            }}
          >
            {c.text.replace(/(\d) (?=NEAR\b|s\b|min\b|h\b)/g, "$1\u00a0")}
          </div>
        </div>
      ) : null}
    </>
  );
}

/** A scene in its span: in and out through black, a few frames each way. The first frame of the clip is never faded. */
function Scene({ span, first = false, last = false, children }: { span: Span; first?: boolean; last?: boolean; children: ReactNode }) {
  return (
    <Sequence from={span.from} durationInFrames={span.to - span.from} layout="none">
      <Fade length={span.to - span.from} first={first} last={last}>
        {children}
      </Fade>
    </Sequence>
  );
}

function Fade({ length, first, last, children }: { length: number; first?: boolean; last?: boolean; children: ReactNode }) {
  const frame = useCurrentFrame();
  const inK = first ? 1 : interpolate(frame, [0, 4], [0, 1], clamp);
  const outK = last ? interpolate(frame, [length - 12, length], [1, 0], clamp) : interpolate(frame, [length - 4, length], [1, 0], clamp);
  return <AbsoluteFill style={{ opacity: Math.min(inK, outK) }}>{children}</AbsoluteFill>;
}

function Music({ src, length }: { src: string; length: number }) {
  const { fps } = useVideoConfig();
  return <Html5Audio src={staticFile(src)} volume={(f) => interpolate(f, [0, 6, length - 1.5 * fps, length], [0, 1, 1, 0], clamp)} />;
}

export type RaceClipProps = { record: RaceRecord; music: string | null };

export function RaceClip({ record, music }: RaceClipProps) {
  const s = raceStory(record);
  const plan = planRaceClip(s);
  const sc = plan.scenes;
  return (
    <AbsoluteFill style={{ background: color.ink, overflow: "hidden" }}>
      <Scene span={sc.result} first>
        <Result s={s} />
      </Scene>
      <Scene span={sc.vault}>
        <Vault s={s} />
      </Scene>
      <Scene span={sc.race}>
        <Race s={s} plan={plan} />
      </Scene>
      <Scene span={sc.drain}>
        <Drain s={s} plan={plan} />
      </Scene>
      <Scene span={sc.paid}>
        <Paid s={s} />
      </Scene>
      <Scene span={sc.end} last>
        <End s={s} />
      </Scene>
      <Captions plan={plan} />
      {music ? <Music src={music} length={plan.durationInFrames} /> : null}
      {s.simulated ? (
        <div style={{ position: "absolute", right: 48, top: 40, fontFamily: FONT.num, fontWeight: 700, fontSize: 24, letterSpacing: "0.18em", color: color.ice38 }}>SIMULATED</div>
      ) : null}
    </AbsoluteFill>
  );
}
