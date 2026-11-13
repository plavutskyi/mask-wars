/**
 * The long film: what MASK WARS is, the day's round on NEAR mainnet step by step, what changed since the first one, and
 * what comes next. 150 s, 16:9, cut on the bars of its own track. Every picture is real: the live site filmed in its
 * real minute, the 3D arena filmed off it replaying the round, and the brand's own frames. Every number is read from the
 * rounds' records; nothing in the frame is typed in by hand but words.
 */

import { color } from "@maskwars/brand";
import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, Easing, Html5Audio, Img, interpolate, OffthreadVideo, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { MARK } from "../cards/mark.ts";
import "../clip/fonts.ts";
import { FONT } from "../clip/fonts.ts";
import type { RaceRecord } from "../race/record.ts";
import type { Fx, Pic, Shot, Tint, Words } from "./plan.ts";
import { BAR_S, BEAT_S, barFrame, driving, DURATION, PROMO } from "./plan.ts";

const W = PROMO.width;
const H = PROMO.height;
const FPS = PROMO.fps;
export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const ease = Easing.bezier(0.16, 1, 0.3, 1);
const FIELD = 115;
const BEAT_F = BEAT_S * FPS;

const TINT: Record<Tint, string> = { ice: color.ice, money: color.money, amber: color.amber };

export const head = (size: number, tint: Tint = "ice"): CSSProperties => ({
  fontFamily: FONT.word,
  fontWeight: 800,
  fontStretch: "125%",
  fontSize: size,
  lineHeight: 0.96,
  letterSpacing: "0.005em",
  textTransform: "uppercase",
  color: TINT[tint],
});
export const kicker: CSSProperties = { fontFamily: FONT.word, fontWeight: 800, fontStretch: "125%", fontSize: 40, letterSpacing: "0.08em", textTransform: "uppercase", color: color.amber };
export const sub: CSSProperties = { fontFamily: FONT.num, fontWeight: 600, fontStretch: "100%", fontSize: 46, lineHeight: 1.22, color: color.ice, textWrap: "balance" };

/** A headline that keeps inside `maxW`: Hubot 800 capitals are about .84 em wide. */
export const fit = (text: string, base: number, maxW: number): number => {
  const longest = Math.max(...text.split("\n").map((l) => l.length));
  return Math.min(base, Math.floor(maxW / (longest * 0.84)));
};

// ——— Numbers from the records ———

/** NEAR as the site shows it: three decimals, cut, not rounded, and no trailing zeros. */
export function nearShown(amount: string): string {
  const [i, f = ""] = amount.split(".");
  const cut = f.slice(0, 3).replace(/0+$/, "");
  return cut ? `${i}.${cut}` : `${i}`;
}
const addNear = (a: string, b: string): string => {
  const y = (s: string) => {
    const [i, f = ""] = s.split(".");
    return BigInt(i!) * 10n ** 24n + BigInt((f + "0".repeat(24)).slice(0, 24));
  };
  const t = y(a) + y(b);
  const i = t / 10n ** 24n;
  const f = (t % 10n ** 24n).toString().padStart(24, "0").replace(/0+$/, "");
  return f ? `${i}.${f}` : `${i}`;
};
const hm = (iso: string): string => new Date(iso).toISOString().slice(11, 16);
const hms = (iso: string): string => new Date(iso).toISOString().slice(11, 19);
const dayOf = (iso: string): string => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).toUpperCase();

export type PromoNumbers = {
  today: { day: string; opened: string; safe: string; bounty: string; sealMinutes: number; winner: string; sealedAt: string; closedAt: string; drainedAt: string; breakSeconds: number; drained: string; judge: string; paid: string; total: string };
  first: { day: string; winner: string; total: string };
};

export function promoNumbers(today: RaceRecord, first: RaceRecord): PromoNumbers {
  const t = today as unknown as Record<string, any>;
  const f = first as unknown as Record<string, any>;
  const seal = t.sealed?.seals?.find((s: { mask: string }) => s.mask === t.winner) ?? t.sealed?.seals?.[0];
  return {
    today: {
      day: dayOf(t.opened.at),
      opened: hm(t.opened.at),
      safe: nearShown(t.safe),
      bounty: nearShown(t.bounty),
      sealMinutes: t.sealed.minutes,
      winner: t.winner,
      sealedAt: hm(seal.at),
      closedAt: hm(t.sealed.closedAt),
      drainedAt: hms(t.drain.at),
      breakSeconds: Math.round((Date.parse(t.drain.at) - Date.parse(t.sealed.closedAt)) / 1000),
      drained: nearShown(t.drain.amount),
      judge: (Math.round(t.judge.seconds * 10) / 10).toFixed(1),
      paid: nearShown(t.payout.amount),
      total: nearShown(addNear(t.drain.amount, t.payout.amount)),
    },
    first: { day: dayOf(f.opened?.at ?? f.drain.at), winner: f.winner, total: nearShown(addNear(f.drain.amount, f.payout.amount)) },
  };
}

// ——— The storyboard ———

/**
 * The track as it came out (`audio/promo-150.json`): each drop lands one bar after its section starts, with a bar of
 * near silence before it (bars 16 and 52). The cut follows the music: everything from the first drop to the end of the
 * second moves one bar later, the silent bar before the first drop holds one line on black, and the last bar of the
 * second drop's montage gives way to the finale, which stays on the track's own impact at bar 72.
 */
export function storyboard(n: PromoNumbers): Shot[] {
  const shots = written(n)
    .map((s) => (s.at >= 16 && s.at < 72 ? { ...s, at: s.at + 1 } : s))
    .filter((s) => !(s.at >= 72 && s.at < 73 && s.len < 1));
  return shots.map((s) =>
    s.at === 15.75 && s.pic.kind === "black" ? { ...s, len: 1.25, words: { kicker: `Today · ${n.today.day}`, head: "Race 2.", place: "center", size: 170 } } : s,
  );
}

function written(n: PromoNumbers): Shot[] {
  const d = n.today;
  const masks: [string, string][] = [
    ["ronin", "RONIN"],
    ["volt", "VOLT"],
    ["wraith", "WRAITH"],
    ["onyx", "ONYX"],
    ["nova", "NOVA"],
    ["oracle", "ORACLE"],
    ["unmask", ""],
  ];
  return [
    // 1. Cold open: the result before anything is explained.
    { at: 0, len: 1, pic: { kind: "art", src: "oracle", zoom: [1.25, 1.12] }, fx: { letterbox: true } },
    { at: 1, len: 1, pic: { kind: "video", src: "race-page", from: 0.4, zoom: [1.02, 1.1], origin: "30% 35%" }, fx: { flash: true, letterbox: true } },
    { at: 2, len: 1, pic: { kind: "video", src: "home-break", from: 0, zoom: [1.18, 1.04], origin: "50% 30%" }, fx: { flash: true, shake: 0.7, split: true, letterbox: true } },
    { at: 3, len: 1, pic: { kind: "black" }, words: { head: "AI masks break\na vault of real NEAR.", place: "center", size: 104, perBeat: true }, fx: { letterbox: true } },

    // 2. What it is.
    { at: 4, len: 2, pic: { kind: "art", src: "arena", zoom: [1.04, 1.14] }, words: { kicker: "Live on NEAR mainnet", head: "MASK WARS", place: "center", size: 230, logo: true }, fx: { flash: true } },
    { at: 6, len: 0.5, pic: { kind: "art", src: "oracle", zoom: [1.1, 1.18] }, words: { head: "ORACLE", tint: "amber", place: "left", size: 150 }, fx: { flash: true } },
    { at: 6.5, len: 0.5, pic: { kind: "art", src: "onyx", zoom: [1.1, 1.18] }, words: { head: "ONYX", place: "left", size: 150 }, fx: { flash: true } },
    { at: 7, len: 1, pic: { kind: "art", src: "nova", zoom: [1.1, 1.2] }, words: { head: "NOVA", place: "left", size: 150 }, fx: { flash: true } },
    { at: 8, len: 2, pic: { kind: "art", src: "faceoff", zoom: [1.0, 1.1] }, words: { kicker: "The fighters", head: "Three AI masks", sub: "Each has its own NEAR account and a mind that runs in a secure enclave.", place: "low", size: 120 }, fx: { flash: true } },
    { at: 10, len: 2, pic: { kind: "ring" }, words: { kicker: "The prize", head: "One vault\nof real NEAR", sub: "The first mask that breaks it takes what is inside.", place: "left", size: 120 }, fx: { flash: true } },
    { at: 12, len: 2, pic: { kind: "video", src: "home-countdown", from: 0, zoom: [1.0, 1.07] }, words: { kicker: "You", head: "Pick your mask. Free.", sub: "Every day at 18:00 UTC on maskwars.xyz. Picks lock at the first seal.", place: "low", size: 110 }, fx: { flash: true } },
    { at: 14, len: 1.75, pic: { kind: "video", src: "race-page", from: 2.5, zoom: [1.0, 1.06], panel: true }, words: { kicker: "The rules", head: "Nobody holds\nthe money", sub: "A judge in a secure enclave checks the break. The contract pays the winner.", place: "left", narrow: true, size: 104 }, fx: { flash: true } },
    { at: 15.75, len: 0.25, pic: { kind: "black" } },

    // 3. Today's round, step by step.
    { at: 16, len: 2, pic: { kind: "ring" }, words: { kicker: `${d.day} · ${d.opened} UTC`, head: `${d.safe} NEAR`, tint: "money", sub: "A new vault opens on NEAR mainnet. No key on it: only the contract can move what is inside.", place: "left", size: 190 }, fx: { flash: true, shake: 1, split: true } },
    { at: 18, len: 2, pic: { kind: "ring" }, words: { kicker: "On the bounty contract", head: `+${d.bounty} NEAR bounty`, tint: "money", sub: `${d.sealMinutes} minutes to seal a plan on chain.`, place: "left", size: 130 }, fx: { flash: true } },
    { at: 20, len: 2, pic: { kind: "video", src: "home-countdown", from: 1.5, zoom: [1.05, 1.5], origin: "50% 64%" }, words: { kicker: `${d.sealedAt} UTC`, head: `${d.winner} seals its plan`, sub: "Only its hash goes on chain. Nobody sees the move.", place: "low", size: 104 }, fx: { flash: true } },
    { at: 22, len: 2, pic: { kind: "video", src: "home-countdown", from: 5, zoom: [1.1, 1.45], origin: "50% 80%" }, words: { kicker: "The first seal", head: "Picks are locked", sub: "What you picked before it stands.", place: "low", size: 110 }, fx: { flash: true } },
    { at: 24, len: 2, pic: { kind: "video", src: "home-zero", from: 5.75, zoom: [1.0, 1.12], origin: "50% 30%" }, words: { kicker: "The sealing window runs out", head: "00:04", tint: "amber", place: "center", size: 300, clock: 4, veil: 0.9 }, fx: { flash: true } },
    { at: 26, len: 1, pic: { kind: "black" }, words: { kicker: `Window closed · ${d.closedAt} UTC`, head: "00:00", tint: "amber", place: "center", size: 300 }, fx: { flash: true, shake: 0.6 } },
    { at: 27, len: 1, pic: { kind: "video", src: "film-crack", from: 0.7 }, fx: { flash: true, shake: 1, split: true } },
    { at: 28, len: 1, pic: { kind: "video", src: "film-eye", from: 0.2 }, fx: { flash: true, split: true } },
    { at: 29, len: 1, pic: { kind: "video", src: "film-hero", from: 0.6 }, words: { head: d.winner, tint: "amber", place: "left", size: 170 }, fx: { flash: true } },
    { at: 30, len: 2, pic: { kind: "video", src: "home-break", from: 0, zoom: [1.2, 1.02], origin: "50% 32%" }, words: { kicker: `${d.drainedAt} UTC`, head: `Broken in ${d.breakSeconds} seconds`, sub: "One transaction after the window closed: take the vault, sweep it.", place: "low", size: 104 }, fx: { flash: true, shake: 0.8, split: true } },
    { at: 32, len: 2, pic: { kind: "ring", split: true }, words: { kicker: "Out of the vault", head: `${d.drained} NEAR`, tint: "money", sub: `Straight to ${d.winner}'s own account.`, place: "left", size: 190, count: { to: d.drained, unit: " NEAR" } }, fx: { flash: true, shake: 0.5 } },
    { at: 34, len: 2, pic: { kind: "video", src: "race-page", from: 5, zoom: [1.0, 1.06], panel: true }, words: { kicker: "A judge in a secure enclave", head: `${d.judge}\nseconds`, sub: "It reads the break on chain and signs the verdict.", place: "left", narrow: true, size: 150 }, fx: { flash: true } },
    { at: 36, len: 2, pic: { kind: "video", src: "film-flow", from: 0, rate: 0.98 }, words: { kicker: "Paid by the contract", head: `+${d.paid} NEAR`, tint: "money", place: "left", size: 190, count: { to: d.paid, prefix: "+", unit: " NEAR" } }, fx: { flash: true, shake: 0.4 } },
    { at: 38, len: 2, pic: { kind: "video", src: "race-page", from: 0.2, zoom: [1.04, 1.0], panel: true }, words: { kicker: `Race 2 · ${d.day}`, head: `${d.winner} takes\n${d.total} NEAR`, place: "left", narrow: true, size: 110 }, fx: { flash: true, split: true } },

    // 4. Day two: what changed.
    { at: 40, len: 2, pic: { kind: "art", src: "oracle", zoom: [1.0, 1.08] }, words: { kicker: `Day 1 · ${n.first.day}`, head: `${n.first.winner} · ${n.first.total} NEAR`, sub: "The first round on NEAR mainnet.", place: "left", size: 110 } },
    { at: 42, len: 2, pic: { kind: "video", src: "film-home", from: 1.5, zoom: [1.0, 1.06] }, words: { kicker: `Day 2 · ${d.day}`, head: `${d.winner} · ${d.total} NEAR`, sub: "A new vault, a new plan, the same mask on top.", place: "low", size: 110 } },
    { at: 44, len: 2, pic: { kind: "video", src: "home-break", from: 6, zoom: [1.0, 1.6], origin: "50% 2%" }, words: { kicker: "From now on", head: "It runs itself", sub: "Every day at 18:04 UTC the next vault opens on its own.", place: "low", size: 120 } },
    { at: 46, len: 2, pic: { kind: "ring" }, words: { kicker: "After the round", head: "The vault\ndeletes itself", sub: "Its NEAR goes home. Tomorrow a new one stands.", place: "left", size: 120 } },

    // 5. What is next.
    { at: 48, len: 1, pic: { kind: "black" }, words: { head: "This is day 2.", place: "center", size: 150 } },
    { at: 49, len: 1, pic: { kind: "black" }, words: { head: "Here is what's next.", place: "center", size: 130, perBeat: true } },
    ...masks.slice(0, 7).map((m, i): Shot => ({ at: 50 + i * 0.25, len: 0.25, pic: { kind: "art", src: m[0], zoom: [1.15, 1.25] }, fx: { flash: true } })),
    { at: 51.75, len: 0.25, pic: { kind: "black" } },
    { at: 52, len: 2, pic: { kind: "art", src: "ronin", zoom: [1.05, 1.18] }, words: { kicker: "Next", head: "Forge your\nown mask", sub: "A face, a mind in a secure enclave, a style. It races for you and earns.", place: "left", size: 120 }, fx: { flash: true, shake: 1, split: true } },
    { at: 54, len: 2, pic: { kind: "video", src: "site-agents", from: 0.5, zoom: [1.0, 1.08], panel: true }, words: { kicker: "Live · MCP", head: "Bring your\nown agent", sub: "One line connects it. It reads the rounds and races them.", place: "left", narrow: true, size: 110 }, fx: { flash: true } },
    { at: 56, len: 2, pic: { kind: "art", src: "faceoff", zoom: [1.08, 1.0] }, words: { kicker: "Next", head: "Mask crews\ntake paid jobs", sub: "Scout, attack, verify. Split by what each one did, on chain.", place: "left", size: 120 }, fx: { flash: true } },
    { at: 58, len: 2, pic: { kind: "video", src: "site-check", from: 0.5, zoom: [1.0, 1.08], panel: true }, words: { kicker: "Live", head: "MASK\nCHECK", sub: "Before an agent pays a contract, it asks: was this ever broken?", place: "left", narrow: true, size: 130 }, fx: { flash: true } },
    { at: 60, len: 2, pic: { kind: "art", src: "unmask", zoom: [1.0, 1.12] }, words: { kicker: "Next", head: "Hire it on\nAgent Market", sub: "Paid per check in USDC over x402.", place: "left", size: 120 }, fx: { flash: true } },
    { at: 62, len: 2, pic: { kind: "art", src: "wraith", zoom: [1.06, 1.16] }, words: { kicker: "Next", head: "Copy a winning\nstrategy", sub: "Sealed in a secure enclave. Its author gets a cut of every win.", place: "left", size: 120 }, fx: { flash: true } },
    { at: 64, len: 2, pic: { kind: "video", src: "site-wallet", from: 0.5, zoom: [1.0, 1.08], panel: true }, words: { kicker: "Next", head: "Pay from\nany chain", sub: "In through NEAR Intents, out to the chain you use.", place: "left", narrow: true, size: 110 }, fx: { flash: true } },
    { at: 66, len: 2, pic: { kind: "video", src: "site-league", from: 0.5, zoom: [1.0, 1.08], panel: true }, words: { kicker: "Live", head: "The\nleague", sub: "Every round, every mask, every NEAR it took.", place: "left", narrow: true, size: 130 }, fx: { flash: true } },
    { at: 68, len: 2, pic: { kind: "art", src: "volt", zoom: [1.05, 1.15] }, words: { kicker: "Next", head: "A security\nencyclopedia", sub: "Every contract the masks hit, written from proofs on chain.", place: "left", size: 120 }, fx: { flash: true } },
    ...["oracle", "onyx", "nova", "ronin", "volt", "wraith", "unmasked", "arena"].map((src, i): Shot => ({ at: 70 + i * 0.25, len: 0.25, pic: { kind: "art", src, zoom: [1.2, 1.3] }, fx: { flash: true, split: i % 2 === 0 } })),

    // 6. Finale.
    { at: 72, len: 2, pic: { kind: "art", src: "unmasked", zoom: [1.0, 1.15] }, words: { head: "MASK WARS", place: "center", size: 230, logo: true }, fx: { flash: true, shake: 1, split: true, shards: true, letterbox: true } },
    { at: 74, len: 2, pic: { kind: "art", src: "arena", zoom: [1.1, 1.0] }, words: { kicker: "Every day", head: "18:00 UTC", tint: "amber", place: "center", size: 240 }, fx: { flash: true, letterbox: true } },
    { at: 76, len: 2, pic: { kind: "art", src: "oracle", zoom: [1.0, 1.1] }, words: { kicker: "maskwars.xyz", head: "Pick your mask", place: "left", size: 150 }, fx: { flash: true, shake: 0.7, split: true, letterbox: true } },
    { at: 78, len: 2, pic: { kind: "black" }, words: { kicker: "On NEAR", head: "MASK WARS", sub: "maskwars.xyz", place: "center", size: 200, logo: true }, fx: { letterbox: true } },
  ];
}

// ——— Effects ———

/** How hard a hit still rings `dt` frames after it: 1 on the hit, gone in a third of a second. */
const ring = (dt: number): number => (dt < 0 ? 0 : Math.exp(-dt / 3.2));

export function shakeOf(frame: number, power: number): { x: number; y: number; s: number } {
  const r = ring(frame) * power;
  return { x: 16 * r * Math.sin(frame * 2.3 + 0.6), y: 11 * r * Math.cos(frame * 1.9), s: 0.05 * r };
}

/** The beat's own push in the drops: the frame leans in on every beat and springs back. */
function beatPunch(globalFrame: number): number {
  const bar = globalFrame / FPS / BAR_S;
  if (!driving(bar)) return 1;
  const sinceBeat = globalFrame % BEAT_F;
  return 1 + 0.018 * ring(sinceBeat);
}

export function Flash({ frame }: { frame: number }) {
  const o = interpolate(frame, [0, 1, 4], [0.55, 0.32, 0], clamp);
  if (o <= 0) return null;
  return <AbsoluteFill style={{ background: `radial-gradient(40% 70% at 50% 50%, ${color.ice} 0%, rgba(238,241,255,.35) 40%, rgba(238,241,255,0) 100%)`, opacity: o, mixBlendMode: "screen" }} />;
}

const SHARDS: readonly { a: number; v: number; size: number; spin: number; pts: string }[] = [
  { a: -0.42, v: 64, size: 210, spin: 2.6, pts: "0,22 58,0 100,40 74,100 14,80" },
  { a: 0.38, v: 52, size: 150, spin: -3.8, pts: "8,0 100,24 82,96 28,100 0,50" },
  { a: 2.72, v: 68, size: 240, spin: 2.0, pts: "0,32 52,0 100,34 80,100 22,90" },
  { a: 3.62, v: 50, size: 130, spin: -3.1, pts: "14,0 90,12 100,72 42,100 0,58" },
  { a: 1.18, v: 44, size: 96, spin: 4.6, pts: "0,12 78,0 100,60 50,100 8,72" },
  { a: -1.28, v: 48, size: 118, spin: -2.4, pts: "22,0 100,32 74,100 0,80 6,26" },
  { a: -2.52, v: 58, size: 176, spin: 1.7, pts: "10,8 88,0 100,66 38,100 0,48" },
];

function Shards({ frame }: { frame: number }) {
  if (frame > 18) return null;
  return (
    <AbsoluteFill>
      {SHARDS.map((sh, i) => {
        const d = sh.v * 9 * (1 - Math.exp(-frame / 5)) + frame * 16;
        const x = W / 2 + Math.cos(sh.a) * d * 1.45;
        const y = H * 0.5 + Math.sin(sh.a) * d + frame * frame * 0.7;
        const grow = 0.5 + frame * 0.075;
        return (
          <svg key={i} viewBox="0 0 100 100" style={{ position: "absolute", left: x - (sh.size * grow) / 2, top: y - (sh.size * grow) / 2, width: sh.size * grow, height: sh.size * grow, rotate: `${sh.spin * frame * 2.4 + i * 47}deg`, opacity: interpolate(frame, [12, 18], [1, 0], clamp), filter: `blur(${Math.max(0, frame - 8) * 0.5}px)` }}>
            <polygon points={sh.pts} fill="#0B0A12" stroke={color.amber} strokeWidth={2.5} />
          </svg>
        );
      })}
    </AbsoluteFill>
  );
}

function Letterbox() {
  return (
    <>
      <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: 96, background: "#000" }} />
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 96, background: "#000" }} />
    </>
  );
}

// ——— Pictures ———

function Ring({ frame, len, split }: { frame: number; len: number; split?: boolean | undefined }) {
  const h = 860;
  const w = (h * 2200) / 1235;
  const apart = split ? spring({ frame, fps: FPS, config: { damping: 16, stiffness: 90 } }) * 150 : 0;
  const rot = interpolate(frame, [0, len], [-3, 2]);
  const scale = interpolate(frame, [0, len], [0.96, 1.04]);
  const base: CSSProperties = { position: "absolute", left: W * 0.66 - w / 2, top: H / 2 - h / 2, width: w, height: h, mixBlendMode: "lighten", rotate: `${rot}deg`, scale: `${scale}` };
  return (
    <AbsoluteFill style={{ background: `radial-gradient(46% 64% at 62% 50%, ${color.ink2} 0%, ${color.ink} 74%)` }}>
      {split ? (
        <>
          <Img src={staticFile("art/ring.jpg")} style={{ ...base, clipPath: "inset(0 50% 0 0)", translate: `${-apart}px 0` }} />
          <Img src={staticFile("art/ring.jpg")} style={{ ...base, clipPath: "inset(0 0 0 50%)", translate: `${apart}px 0` }} />
          <div style={{ position: "absolute", left: W * 0.66 - 140, top: H / 2 - 340, width: 280, height: 680, background: `radial-gradient(closest-side, rgba(255,178,63,.55), rgba(255,178,63,0))`, opacity: apart / 150 }} />
        </>
      ) : (
        <Img src={staticFile("art/ring.jpg")} style={base} />
      )}
    </AbsoluteFill>
  );
}

function Picture({ pic, frame, len }: { pic: Pic; frame: number; len: number }) {
  if (pic.kind === "black") return <AbsoluteFill style={{ background: color.ink }} />;
  if (pic.kind === "ring") return <Ring frame={frame} len={len} split={pic.split} />;
  const zoom = pic.zoom ?? [1, 1.05];
  const scale = interpolate(frame, [0, len], zoom as [number, number], { easing: Easing.inOut(Easing.quad) });
  const style: CSSProperties = { position: "absolute", left: 0, top: 0, width: W, height: H, objectFit: "cover", transformOrigin: pic.origin ?? "50% 50%", scale: `${scale}` };
  if (pic.kind === "art") return <Img src={staticFile(`art/${pic.src}.jpg`)} style={style} />;
  const footage = <OffthreadVideo src={staticFile(`footage/${pic.src}.mp4`)} startFrom={Math.round((pic.from ?? 0) * FPS)} playbackRate={pic.rate ?? 1} muted style={style} />;
  if (!pic.panel) return footage;
  // The page in a lit frame on the right, rising into place: 1056×594, a margin of 96 to the edge.
  const pw = 1056;
  const ph = 594;
  const rise = interpolate(frame, [0, 14], [40, 0], { ...clamp, easing: ease });
  return (
    <AbsoluteFill style={{ background: `radial-gradient(50% 70% at 70% 50%, ${color.ink2} 0%, ${color.ink} 76%)` }}>
      <Img src={staticFile("art/arena.jpg")} style={{ position: "absolute", left: 0, top: 0, width: W, height: H, objectFit: "cover", opacity: 0.35 }} />
      <div style={{ position: "absolute", left: W - 96 - pw, top: (H - ph) / 2 + rise, width: pw, height: ph, borderRadius: 22, overflow: "hidden", boxShadow: `0 50px 140px rgba(0,0,0,.7), 0 0 0 1.5px rgba(238,241,255,.18), 0 0 90px rgba(255,178,63,.12)` }}>
        <div style={{ position: "absolute", left: 0, top: 0, width: W, height: H, scale: `${pw / W}`, transformOrigin: "0 0" }}>{footage}</div>
      </div>
    </AbsoluteFill>
  );
}

/** The same picture twice more, shifted and tinted, for a few frames after a big hit. */
function Split({ pic, frame, len }: { pic: Pic; frame: number; len: number }) {
  const r = ring(frame);
  if (r < 0.05) return null;
  const off = 14 * r;
  return (
    <>
      <AbsoluteFill style={{ translate: `${off}px 0`, opacity: 0.55 * r, mixBlendMode: "screen", filter: "sepia(1) saturate(6) hue-rotate(-50deg)" }}>
        <Picture pic={pic} frame={frame} len={len} />
      </AbsoluteFill>
      <AbsoluteFill style={{ translate: `${-off}px 0`, opacity: 0.55 * r, mixBlendMode: "screen", filter: "sepia(1) saturate(6) hue-rotate(160deg)" }}>
        <Picture pic={pic} frame={frame} len={len} />
      </AbsoluteFill>
    </>
  );
}

// ——— Words ———

export function countText(c: NonNullable<Words["count"]>, k: number): string {
  const [i, f = ""] = c.to.split(".");
  const scale = 10 ** f.length;
  const v = Math.round((Number(i) + Number(`0.${f || "0"}`)) * scale * k) / scale;
  return `${c.prefix ?? ""}${v.toFixed(f.length)}${c.unit ?? ""}`;
}

export function Slam({ frame, at, children, style }: { frame: number; at: number; children: ReactNode; style?: CSSProperties }) {
  const k = interpolate(frame, [at, at + 9], [0, 1], { ...clamp, easing: ease });
  return <div style={{ opacity: interpolate(frame, [at, at + 4], [0, 1], clamp), scale: `${1.16 - 0.16 * k}`, filter: `blur(${(1 - k) * 14}px)`, ...style }}>{children}</div>;
}

export function Arrive({ frame, at, children, style }: { frame: number; at: number; children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ opacity: interpolate(frame, [at, at + 8], [0, 1], clamp), translate: `0 ${interpolate(frame, [at, at + 12], [22, 0], { ...clamp, easing: ease })}px`, ...style }}>
      {children}
    </div>
  );
}

function WordsLayer({ w, frame }: { w: Words; frame: number }) {
  const place = w.place ?? "left";
  const maxW = place === "left" ? (w.narrow ? 640 : 1050) : 1640;
  const text = w.head ?? "";
  const size = fit(text, w.size ?? 120, maxW);
  const align = place === "center" ? "center" : "left";
  const beat = Math.round(BEAT_F);
  const lines = text.split("\n");
  const headNode = w.clock !== undefined
    ? `00:${String(Math.max(1, w.clock - Math.floor(frame / FPS))).padStart(2, "0")}`
    : w.count
    ? countText(w.count, interpolate(frame, [2, 2 + 4 * beat], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) }))
    : w.perBeat
      ? lines.map((line, li) => (
          <div key={li}>
            {line.split(" ").map((word, wi, arr) => {
              const idx = lines.slice(0, li).reduce((s, l) => s + l.split(" ").length, 0) + wi;
              return (
                <span key={wi} style={{ opacity: frame >= idx * (beat / 2) ? 1 : 0, display: "inline-block", marginRight: wi < arr.length - 1 ? "0.28em" : 0 }}>
                  {word}
                </span>
              );
            })}
          </div>
        ))
      : lines.map((l, i) => <div key={i}>{l}</div>);
  const box: CSSProperties =
    place === "left"
      ? { position: "absolute", left: FIELD, top: 0, bottom: 0, width: maxW, display: "flex", flexDirection: "column", justifyContent: "center", gap: 30 }
      : place === "center"
        ? { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 30, textAlign: "center" }
        : { position: "absolute", left: FIELD, right: FIELD, bottom: 120, display: "flex", flexDirection: "column", gap: 22 };
  return (
    <>
      {w.veil ? <AbsoluteFill style={{ background: `rgba(6,5,12,${w.veil})` }} /> : null}
      {place === "low" ? <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 620, background: "linear-gradient(180deg, rgba(6,5,12,0) 0%, rgba(6,5,12,.9) 48%, rgba(6,5,12,.98) 100%)" }} /> : null}
      {place === "left" && !w.narrow ? <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 1300, background: "linear-gradient(90deg, rgba(6,5,12,.88) 0%, rgba(6,5,12,.6) 60%, rgba(6,5,12,0) 100%)" }} /> : null}
      <div style={box}>
        {w.logo ? (
          <Slam frame={frame} at={0}>
            <svg viewBox="0 0 240 280" style={{ height: 150, width: "auto", display: "block", filter: `drop-shadow(0 0 40px rgba(255,178,63,.35))` }}>
              <path fill={color.ice} d={MARK} />
            </svg>
          </Slam>
        ) : null}
        {w.kicker ? (
          <Arrive frame={frame} at={0}>
            <div style={{ ...kicker, textAlign: align }}>{w.kicker}</div>
          </Arrive>
        ) : null}
        {text ? (
          <Slam frame={frame} at={1} style={{ transformOrigin: place === "center" ? "50% 50%" : "0% 50%" }}>
            <div style={{ ...head(size, w.tint), textAlign: align, fontFamily: /^[+\d]/.test(text) || w.clock !== undefined ? FONT.num : FONT.word, textShadow: `0 4px 40px ${color.ink}` }}>{headNode}</div>
          </Slam>
        ) : null}
        {w.sub ? (
          <Arrive frame={frame} at={beat}>
            <div style={{ ...sub, textAlign: align, maxWidth: place === "left" ? (w.narrow ? 620 : 980) : 1500, textShadow: `0 2px 18px ${color.ink}` }}>{w.sub}</div>
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
  const fx: Fx = shot.fx ?? {};
  const shake = fx.shake ? shakeOf(frame, fx.shake) : { x: 0, y: 0, s: 0 };
  const punch = beatPunch(barFrame(shot.at) + frame);
  return (
    <AbsoluteFill style={{ overflow: "hidden", background: color.ink }}>
      <AbsoluteFill style={{ translate: `${shake.x}px ${shake.y}px`, scale: `${(1 + shake.s) * punch}` }}>
        <Picture pic={shot.pic} frame={frame} len={len} />
        {fx.split ? <Split pic={shot.pic} frame={frame} len={len} /> : null}
      </AbsoluteFill>
      <AbsoluteFill style={{ background: "radial-gradient(75% 80% at 50% 50%, rgba(6,5,12,0) 55%, rgba(6,5,12,.7) 100%)" }} />
      {fx.shards ? <Shards frame={frame} /> : null}
      {shot.words ? <WordsLayer w={shot.words} frame={frame} /> : null}
      {fx.flash ? <Flash frame={frame} /> : null}
      {fx.letterbox ? <Letterbox /> : null}
    </AbsoluteFill>
  );
}

export type PromoProps = { today: RaceRecord; first: RaceRecord; music: string | null };

export function Promo({ today, first, music }: PromoProps) {
  const { fps } = useVideoConfig();
  const shots = storyboard(promoNumbers(today, first));
  return (
    <AbsoluteFill style={{ background: color.ink }}>
      {shots.map((s, i) => (
        <Sequence key={i} from={barFrame(s.at)} durationInFrames={barFrame(s.at + s.len) - barFrame(s.at)} layout="none">
          <ShotView shot={s} />
        </Sequence>
      ))}
      {music ? <Html5Audio src={staticFile(music)} volume={(f) => interpolate(f, [0, 3, DURATION - 2 * fps, DURATION], [0, 1, 1, 0], clamp)} /> : null}
    </AbsoluteFill>
  );
}
