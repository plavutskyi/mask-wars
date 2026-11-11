/**
 * The clip's own hits, made here: the repository holds no sound effects, and a wordless clip without a hit on the
 * break is a slideshow with music. Each sound is computed from a few sines and seeded noise, so a render sounds the
 * same on any machine. Pure but for `writeWav`.
 *
 * Heavy things only, as the brand book has it: a vault door and its bolts, no whooshing sparks.
 */

import { writeFileSync } from "node:fs";

export const SAMPLE_RATE = 48_000;

/** A noise that is the same every time. */
function noise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x80000000 - 1;
  };
}

function make(seconds: number, fn: (t: number, i: number) => number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < out.length; i++) out[i] = fn(i / SAMPLE_RATE, i);
  return out;
}

/** One-pole low-pass over a signal, cutoff in Hz that may move in time. */
function lowpass(x: Float32Array, cutoff: (t: number) => number): Float32Array {
  const out = new Float32Array(x.length);
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    const a = 1 - Math.exp((-2 * Math.PI * cutoff(i / SAMPLE_RATE)) / SAMPLE_RATE);
    y += a * (x[i]! - y);
    out[i] = y;
  }
  return out;
}

const TAU = 2 * Math.PI;
const soft = (x: number): number => Math.tanh(x);

/** The vault splits: a sub drop under a slab of low noise, and the door's own metal on top. */
export function impact(weight = 1): Float32Array {
  const n = noise(7);
  const body = lowpass(make(1.6, () => n()), (t) => 900 * Math.exp(-t * 9) + 70);
  let phase = 0;
  return make(1.6, (t, i) => {
    // 110 Hz falling to 34 Hz: the weight of the door.
    const f = 34 + 76 * Math.exp(-t * 14);
    phase += (TAU * f) / SAMPLE_RATE;
    const sub = Math.sin(phase) * Math.exp(-t * 2.6);
    const slab = body[i]! * Math.exp(-t * 7) * 2.4;
    const metal = [311, 523, 847, 1291].reduce((s, hz, k) => s + Math.sin(TAU * hz * t + k) * Math.exp(-t * (6 + k * 3)), 0) * 0.07;
    const click = t < 0.004 ? 1 - t / 0.004 : 0;
    return soft((sub * 1.25 + slab + metal + click * 0.5) * weight) * 0.92;
  });
}

/** A bolt: the short hard click of a lock, for a cut. */
export function bolt(): Float32Array {
  const n = noise(11);
  const hiss = lowpass(make(0.22, () => n()), () => 5200);
  return make(0.22, (t, i) => {
    const tick = Math.sin(TAU * 1870 * t) * Math.exp(-t * 90) * 0.6 + Math.sin(TAU * 2930 * t) * Math.exp(-t * 130) * 0.35;
    const thud = Math.sin(TAU * 140 * t) * Math.exp(-t * 38) * 0.7;
    return soft(tick + thud + hiss[i]! * Math.exp(-t * 70) * 0.9) * 0.7;
  });
}

/** The pull before a hit: low noise and a tone that climb into it, and stop dead on the hit. */
export function rise(seconds: number): Float32Array {
  const n = noise(23);
  const air = lowpass(make(seconds, () => n()), (t) => 180 + 5200 * (t / seconds) ** 3);
  let phase = 0;
  return make(seconds, (t, i) => {
    const k = t / seconds;
    phase += (TAU * (46 + 150 * k * k)) / SAMPLE_RATE;
    const gain = k ** 1.6;
    const cut = Math.min(1, (seconds - t) / 0.006);
    return soft((air[i]! * 1.5 + Math.sin(phase) * 0.6) * gain) * 0.75 * cut;
  });
}

/** The payout lands: a lighter hit with one clear bell over it. */
export function landing(): Float32Array {
  const low = impact(0.6);
  return make(1.6, (t, i) => {
    const bell = (Math.sin(TAU * 784 * t) * 0.5 + Math.sin(TAU * 1176 * t) * 0.3 + Math.sin(TAU * 1568 * t) * 0.16) * Math.exp(-t * 3.4);
    return soft(low[i]! * 0.8 + bell * 0.42) * 0.9;
  });
}

/** Mono samples → a 16-bit stereo WAV file. */
export function writeWav(file: string, samples: Float32Array): void {
  const data = Buffer.alloc(samples.length * 4);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767);
    data.writeInt16LE(v, i * 4);
    data.writeInt16LE(v, i * 4 + 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(2, 22);
  head.writeUInt32LE(SAMPLE_RATE, 24);
  head.writeUInt32LE(SAMPLE_RATE * 4, 28);
  head.writeUInt16LE(4, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([head, data]));
}

/**
 * The tempo of a track nobody wrote down: the beat period its onsets repeat at, and where a beat falls. `samples` is
 * mono. Looks between 90 and 180 BPM; a track with no pulse gives a low `confidence`, and the caller keeps 120.
 */
export function estimateTempo(samples: Float32Array, sampleRate: number): { bpm: number; offset: number; confidence: number } {
  const hop = Math.round(sampleRate / 200);
  const win = hop * 4;
  const n = Math.max(0, Math.floor((samples.length - win) / hop));
  const env = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    let e = 0;
    for (let j = 0; j < win; j++) e += samples[i * hop + j]! ** 2;
    const level = Math.log(1 + (1000 * e) / win);
    env[i] = Math.max(0, level - prev);
    prev = level;
  }
  const rate = sampleRate / hop;
  const at = (x: number): number => {
    const k = Math.floor(x);
    return k < 0 || k + 1 >= n ? 0 : env[k]! * (1 - (x - k)) + env[k + 1]! * (x - k);
  };
  let best = { bpm: 120, score: 0 };
  let total = 0;
  let count = 0;
  for (let bpm = 90; bpm <= 180; bpm += 0.5) {
    const lag = (rate * 60) / bpm;
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += env[i]! * at(i + lag);
    const score = n > lag ? s / (n - lag) : 0;
    total += score;
    count++;
    if (score > best.score) best = { bpm, score };
  }
  // Where the beat falls: the phase at which a comb of that period gathers the most onsets.
  const period = (rate * 60) / best.bpm;
  let phase = 0;
  let most = -1;
  for (let p = 0; p < period; p++) {
    let s = 0;
    for (let x = p; x < n; x += period) s += at(x);
    if (s > most) [most, phase] = [s, p];
  }
  const mean = count ? total / count : 0;
  return { bpm: best.bpm, offset: (phase * hop) / sampleRate, confidence: mean > 0 ? best.score / mean : 0 };
}
