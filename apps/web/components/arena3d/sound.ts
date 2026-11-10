// Sound of the arena: a low quiet bed, the click of the lock, the hit of a payout. Off until the visitor turns it on.
// Every sound is synthesised here. A recorded file takes a sound's place only once it is in /public/audio and named in
// AUDIO below: the page never asks for a file that is not there.

import type { ArenaSound } from './types';

type Clip = 'bed' | 'click' | 'hit';

/**
 * Recorded sounds, when there are any. Put the file in /public/audio, then name it here:
 * - `bed`: a loop of 20–40 s, seamless, a low dark bed under the arena (`/audio/arena-bed.mp3`);
 * - `click`: one dry mechanical click of a vault lock, under 150 ms;
 * - `hit`: the payout, one deep hit with a short metallic tail, about 1 s.
 */
export const AUDIO: Readonly<Partial<Record<Clip, string>>> = {};

const BED_GAIN = 0.32;

export class ArenaAudio {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private bedGain: GainNode | null = null;
  private bedStop: (() => void) | null = null;
  private clips: Partial<Record<Clip, AudioBuffer | null>> = {};
  private noise: AudioBuffer | null = null;
  private loading: Promise<void> | null = null;
  on = false;

  /** Call from the click that turns sound on: browsers only start audio inside a gesture. */
  async enable(): Promise<void> {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      this.out = this.ctx.createGain();
      this.out.gain.value = 0.8;
      this.out.connect(comp).connect(this.ctx.destination);
      this.noise = this.makeNoise();
    }
    this.on = true;
    await this.ctx.resume();
    this.loading ??= this.load();
    this.startBed();
    await this.loading;
    // A file may have arrived after the synth bed started: swap to it.
    if (this.on && this.clips.bed && this.bedStop) {
      this.stopBed(0.4);
      this.startBed();
    }
  }

  disable() {
    this.on = false;
    this.stopBed(0.35);
  }

  /** Pause with the page: no sound from a hidden tab. */
  setHidden(hidden: boolean) {
    if (!this.ctx) return;
    if (hidden) void this.ctx.suspend();
    else if (this.on) void this.ctx.resume();
  }

  play(s: ArenaSound, gain = 1) {
    const ctx = this.ctx;
    if (!this.on || !ctx || !this.out || ctx.state !== 'running') return;
    const t = ctx.currentTime + 0.005;
    if (s === 'click') return this.clip('click', t, 0.55 * gain, 1) || this.synthClick(t, 0.55 * gain, 1);
    if (s === 'bolt') return this.clip('click', t, 0.8 * gain, 0.62) || this.synthClick(t, 0.8 * gain, 0.55);
    if (s === 'hit') return this.clip('hit', t, 0.9 * gain, 1) || this.synthHit(t, 0.9 * gain);
    if (s === 'lock') {
      const a = this.clip('click', t, 0.85 * gain, 0.5) || this.synthClick(t, 0.85 * gain, 0.45);
      this.clip('hit', t + 0.07, 0.45 * gain, 0.72) || this.synthHit(t + 0.07, 0.4 * gain, 0.6);
      return a;
    }
  }

  dispose() {
    this.stopBed(0);
    void this.ctx?.close();
    this.ctx = null;
  }

  // ------------------------------------------------------------ files

  private async load() {
    const ctx = this.ctx!;
    await Promise.all(
      (Object.keys(AUDIO) as Clip[]).map(async (k) => {
        try {
          const res = await fetch(AUDIO[k]!);
          if (!res.ok) throw new Error(String(res.status));
          this.clips[k] = await ctx.decodeAudioData(await res.arrayBuffer());
        } catch {
          this.clips[k] = null;
        }
      }),
    );
  }

  private clip(k: Clip, t: number, gain: number, rate: number): boolean {
    const buf = this.clips[k];
    if (!buf || !this.ctx || !this.out) return false;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.out);
    src.start(t);
    return true;
  }

  // ------------------------------------------------------------ bed

  private startBed() {
    const ctx = this.ctx;
    if (!ctx || !this.out || this.bedStop) return;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(BED_GAIN, ctx.currentTime + 1.6);
    g.connect(this.out);
    this.bedGain = g;
    const buf = this.clips.bed;
    if (buf) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(g);
      src.start();
      this.bedStop = () => src.stop();
      return;
    }
    // Synth bed: two low tones a fifth apart and a breath of dark noise, through a slowly moving filter.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 240;
    lp.Q.value = 0.6;
    lp.connect(g);
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.06;
    lfoGain.gain.value = 70;
    lfo.connect(lfoGain).connect(lp.frequency);
    const tones = [55, 82.4, 110.2].map((f, i) => {
      const o = ctx.createOscillator();
      o.type = i === 1 ? 'triangle' : 'sine';
      o.frequency.value = f;
      o.detune.value = i * 4 - 4;
      const og = ctx.createGain();
      og.gain.value = [0.5, 0.22, 0.08][i]!;
      o.connect(og).connect(lp);
      return o;
    });
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    n.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 160;
    bp.Q.value = 0.8;
    const ng = ctx.createGain();
    ng.gain.value = 0.5;
    n.connect(bp).connect(ng).connect(lp);
    const all = [lfo, n, ...tones];
    for (const o of all) o.start();
    this.bedStop = () => all.forEach((o) => o.stop());
  }

  private stopBed(fade: number) {
    const ctx = this.ctx;
    const g = this.bedGain;
    const stop = this.bedStop;
    this.bedStop = null;
    this.bedGain = null;
    if (!ctx || !g || !stop) return;
    const now = ctx.currentTime;
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(g.gain.value, now);
    g.gain.linearRampToValueAtTime(0, now + fade);
    window.setTimeout(() => {
      try {
        stop();
      } catch {
        /* already stopped */
      }
      g.disconnect();
    }, fade * 1000 + 60);
  }

  // ------------------------------------------------------------ synth hits

  private makeNoise(): AudioBuffer {
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      // Brownish: soft, low.
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
    return buf;
  }

  private env(t: number, peak: number, attack: number, decay: number): GainNode {
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    g.connect(this.out!);
    return g;
  }

  private tone(t: number, type: OscillatorType, f0: number, f1: number, dur: number, g: GainNode) {
    const o = this.ctx!.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    o.connect(g);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** A lock's click: a dry tick, a little metal, a small thump. `pitch` below 1 makes it heavier. */
  private synthClick(t: number, gain: number, pitch: number): boolean {
    const ctx = this.ctx!;
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'bandpass';
    hp.frequency.value = 3200 * pitch;
    hp.Q.value = 3;
    n.connect(hp).connect(this.env(t, 0.9 * gain, 0.001, 0.03 / pitch));
    n.start(t, Math.random(), 0.08);
    this.tone(t, 'sine', 1500 * pitch, 1100 * pitch, 0.05, this.env(t, 0.12 * gain, 0.001, 0.04));
    this.tone(t, 'sine', 150 * pitch, 70 * pitch, 0.09, this.env(t, 0.5 * gain, 0.002, 0.08 / pitch));
    return true;
  }

  /** The payout: a deep falling hit, a short body of noise, a faint high ring. */
  private synthHit(t: number, gain: number, pitch = 1): boolean {
    const ctx = this.ctx!;
    this.tone(t, 'sine', 170 * pitch, 40 * pitch, 0.7, this.env(t, 0.9 * gain, 0.004, 1.1));
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    n.connect(lp).connect(this.env(t, 0.6 * gain, 0.003, 0.22));
    n.start(t, Math.random(), 0.4);
    this.tone(t + 0.01, 'triangle', 1318 * pitch, 1310 * pitch, 0.9, this.env(t + 0.01, 0.035 * gain, 0.004, 0.9));
    this.tone(t + 0.01, 'sine', 1976 * pitch, 1970 * pitch, 0.7, this.env(t + 0.01, 0.02 * gain, 0.004, 0.7));
    return true;
  }
}
