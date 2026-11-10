// The arena engine. Imperative three.js behind a tiny surface: `set` takes the props, `resize` the box,
// `setActive` pauses it offscreen. It owns no data and no DOM besides its canvas.

import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  FogExp2,
  Group,
  HemisphereLight,
  PerspectiveCamera,
  PointLight,
  SpotLight,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type Mesh,
  type RingGeometry,
  type ShaderMaterial,
  type Sprite,
  type WebGLRenderTarget,
} from 'three';
import { color } from '@maskwars/brand';
import { compose, DOOR_R, VAULT_R, type Composition } from '../layout';
import { CORNERS, lookKey, lookOf } from '../looks';
import { MASK_ASPECT } from '../silhouette';
import { T } from '../timing';
import type { Anchors, ArenaMask, ArenaQuality, ArenaSound, ArenaState, MaskAnchor, MaskSlot } from '../types';
import { studio } from './env';
import { createFloor, type Floor } from './floor';
import { glowSprite, ringMesh } from './fx';
import { createMask, FRAMED, loadFrames, syncHalos, type MaskRig } from './mask';
import { clamp01, easeInOutCubic, easeOutCubic, easeOutExpo, span, Spring } from './motion';
import { down, guessTier, TIERS, type Tier } from './tier';
import { createVault, type VaultRig } from './vault';

export interface EngineInput {
  state: ArenaState;
  masks: readonly [ArenaMask, ArenaMask, ArenaMask];
  attempts: readonly [number, number, number];
  winner: MaskSlot | null;
  reduced: boolean;
  quality: ArenaQuality;
}

export interface EngineEvents {
  anchors(a: Anchors): void;
  /** First frame on screen. */
  ready(): void;
  sound(s: ArenaSound, gain: number): void;
  tier(t: Tier): void;
  lost(): void;
  /** Frames stay slow even on the simplest tier (or far too slow on any): this device is better off without the scene. */
  slow?(): void;
}

interface Frame {
  w: number;
  h: number;
  top: number;
  bottom: number;
}

/** Jump to a peak and fall back to where it rests. */
function flash(s: Spring, peak: number, rest: number) {
  s.snap(peak);
  s.set(rest);
}

const ICE = new Color(color.ice);
const AMBER = new Color(color.amber);

const OPEN: ReadonlySet<ArenaState> = new Set(['breach', 'paid']);
const OUT: ReadonlySet<ArenaState> = new Set(['live', 'breach', 'paid']);

/** The frame a mask wears: a mask of the catalog with no look of its own. */
const frameId = (m: ArenaMask): string | null => (!m.look && FRAMED.has(m.id.toLowerCase()) ? m.id.toLowerCase() : null);

interface MaskMotion {
  rig: MaskRig;
  presence: Spring;
  eyes: Spring;
  z: Spring;
  scale: Spring;
  lastStrike: number;
  phase: number;
}

export class ArenaEngine {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(30, 1, 0.1, 80);
  private env: WebGLRenderTarget | null = null;
  private floor: Floor | null = null;
  private vault: VaultRig | null = null;
  private masks: MaskMotion[] = [];
  private world = new Group();
  private comp: Composition;
  private frame: Frame = { w: 1, h: 1, top: 0, bottom: 0 };
  private input: EngineInput | null = null;
  private tier: Tier;
  private forced: boolean;
  private raf = 0;
  private active = false;
  private disposed = false;
  private readyFired = false;
  private last = 0;
  private t = 0;
  private queue: Array<{ at: number; fn: () => void }> = [];
  private lastAnchors = '';
  private samples: number[] = [];
  private sampled = 0;
  private warmup = 0;
  private gaveUp = false;

  // Lights.
  private key = new DirectionalLight(new Color(color.ice), 1.3);
  private rimL = new DirectionalLight(new Color(color.ember), 2.6);
  private rimR = new DirectionalLight(new Color(color.violet), 2.6);
  private fill = new HemisphereLight(new Color(color.ice), new Color(color.ink), 0.05);
  // Light out of the open vault: a cone toward the masks, so it warms their faces and never burns the ring.
  private coreLight = new SpotLight(new Color(color.amber), 0, 0, 1.0, 1, 2);
  private cometLight = new PointLight(new Color(color.money), 0, 0, 2);

  // Moments.
  private bell!: Mesh<RingGeometry, ShaderMaterial>;
  private landing!: Mesh<RingGeometry, ShaderMaterial>;
  private comet: Sprite[] = [];
  private haze: Sprite[] = [];
  private cometFrom = new Vector3();
  private head = new Vector3();
  private tail = new Vector3();
  private cometTo = new Vector3();
  private cometAt = -1;
  private bellAt = -1;
  private landingAt = -1;
  private crackAt = -1;

  // Continuous values.
  private split = new Spring(0, 0.9, 0.82);
  private bolts = new Spring(0, 0.35, 1);
  private seam = new Spring(0.35, 0.4, 1);
  private core = new Spring(0, 0.8, 1);
  private pool = new Spring(0.2, 0.8, 1);
  private ringFlash = new Spring(0, 0.3, 1);
  private zoom = new Spring(1, 0.35, 0.55);
  private dolly = new Spring(1.06, 1.6, 1);
  private pan = new Spring(0, 1.6, 1);
  private lights = new Spring(0.7, 1.2, 1);
  private seamTone = new Color(color.ice);
  private seamToneUntil = 0;

  private canvas: HTMLCanvasElement;
  private events: EngineEvents;

  constructor(canvas: HTMLCanvasElement, events: EngineEvents, quality: ArenaQuality) {
    this.canvas = canvas;
    this.events = events;
    this.forced = quality !== 'auto';
    this.tier = quality === 'auto' ? guessTier() : quality;
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setClearColor(new Color(color.ink), 1);
    this.scene.background = new Color(color.ink);
    this.scene.fog = new FogExp2(new Color(color.ink), 0.028);
    this.scene.add(this.world);
    this.comp = compose({ w: 1, h: 1 });

    canvas.addEventListener('webglcontextlost', this.onLost, false);

    this.env = studio(this.renderer);
    this.scene.environment = this.env.texture;

    for (const l of [this.key, this.rimL, this.rimR]) {
      this.scene.add(l);
      this.scene.add(l.target);
    }
    this.key.position.set(-5, 8, 7);
    this.rimL.position.set(-7, 3.5, -6);
    this.rimR.position.set(7, 3.5, -6);
    this.scene.add(this.fill, this.coreLight, this.coreLight.target, this.cometLight);

    this.bell = ringMesh(color.ice);
    this.landing = ringMesh(color.money);
    this.landing.rotation.x = -Math.PI / 2;
    this.scene.add(this.bell, this.landing);
    // The payout comet: a white-hot core, its money-coloured halo, and a streak.
    for (const hex of [color.ice, color.money, color.money]) {
      const s = glowSprite(hex, 0);
      s.visible = false;
      this.comet.push(s);
      this.scene.add(s);
    }

    // Corner haze at the far edge of the arena, Ember left, Violet right, low over the floor so the wet floor
    // answers it with long streaks, as in the arena frame.
    for (const [hex, x] of [
      [color.ember, -1],
      [color.violet, 1],
    ] as const) {
      const haze = glowSprite(hex, 0.26);
      haze.scale.set(12, 3.2, 1);
      haze.position.set(x * 9, 0.7, -13);
      this.haze.push(haze);
      this.scene.add(haze);
    }

    this.build();
    this.events.tier(this.tier);
  }

  // ---------------------------------------------------------------- lifecycle

  private build() {
    const spec = TIERS[this.tier];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, spec.dpr));
    this.vault = createVault(this.tier);
    this.world.add(this.vault.group);
    this.floor = createFloor(this.renderer, spec.mirror, spec.taps, new Vector3(), (on) => {
      this.key.intensity = on ? 0 : 1.3 * this.lights.value;
    });
    this.scene.add(this.floor.mesh);
    this.applyFrame();
  }

  private teardown() {
    if (this.vault) {
      this.world.remove(this.vault.group);
      this.vault.dispose();
      this.vault = null;
    }
    if (this.floor) {
      this.scene.remove(this.floor.mesh);
      this.floor.dispose();
      this.floor = null;
    }
    for (const m of this.masks) {
      this.world.remove(m.rig.group);
      m.rig.dispose();
    }
    this.masks = [];
  }

  private setTier(t: Tier) {
    if (t === this.tier) return;
    this.tier = t;
    const input = this.input;
    this.teardown();
    this.build();
    if (input) {
      this.input = null;
      this.set(input, true);
    }
    this.events.tier(t);
  }

  dispose() {
    this.disposed = true;
    this.stop();
    this.canvas.removeEventListener('webglcontextlost', this.onLost, false);
    // The masks' shape is shared by every arena on the page and stays: a few hundred triangles.
    this.teardown();
    this.bell.geometry.dispose();
    this.bell.material.dispose();
    this.landing.geometry.dispose();
    this.landing.material.dispose();
    for (const s of this.comet) s.material.dispose();
    for (const s of this.haze) s.material.dispose();
    this.env?.dispose();
    this.renderer.dispose();
  }

  private onLost = (e: Event) => {
    e.preventDefault();
    this.stop();
    this.events.lost();
  };

  // ---------------------------------------------------------------- inputs

  resize(frame: Frame) {
    this.frame = frame;
    this.applyFrame();
    this.wake();
  }

  private applyFrame() {
    const { w, h, top, bottom } = this.frame;
    this.renderer.setSize(w, h, false);
    const c = compose({ w, h, top, bottom });
    this.comp = c;
    this.camera.fov = c.fov;
    this.camera.aspect = w / h;
    this.camera.setViewOffset(w, h, 0, c.offsetY, w, h);
    this.camera.updateProjectionMatrix();
    const pr = this.renderer.getPixelRatio();
    this.floor?.setSize(w * pr, h * pr);

    if (this.vault) this.vault.group.position.set(c.vault.x, c.vault.y, c.vault.z);
    this.coreLight.position.set(c.vault.x, c.vault.y, c.vault.z + 0.25);
    this.coreLight.target.position.set(c.vault.x, c.masks[1].y, c.masks[1].z);
    for (const l of [this.key, this.rimL, this.rimR]) l.target.position.set(0, c.vault.y * 0.6, 0);
    this.bell.position.set(c.vault.x, c.vault.y, c.vault.z + 0.12);
    if (this.floor) (this.floor.mesh.material as ShaderMaterial).uniforms.uPoolAt!.value.set(c.vault.x, 0, c.vault.z + 0.6);
    this.placeMasks();
  }

  private placeMasks() {
    this.masks.forEach((m, i) => {
      const p = this.comp.masks[i]!;
      m.rig.group.scale.setScalar(p.size * m.scale.value);
      m.rig.group.rotation.set(p.pitch, p.yaw, 0);
    });
  }

  /** Props in. Diffs against the last input and plays the moment the change calls for. */
  set(input: EngineInput, rebuilt = false) {
    const prev = this.input;
    this.input = input;

    // Masks: rebuild the rigs when a look changed.
    const keys = input.masks.map(lookKey);
    if (!prev || rebuilt || keys.some((k, i) => lookKey(prev.masks[i]!) !== k) || this.masks.length !== 3) {
      for (const m of this.masks) {
        this.world.remove(m.rig.group);
        m.rig.dispose();
      }
      this.masks = input.masks.map((mask, i) => {
        const rig = createMask(lookOf(mask.id, mask.look), this.tier, frameId(mask));
        this.world.add(rig.group);
        return {
          rig,
          presence: new Spring(0.46, 0.6, 1),
          eyes: new Spring(0.72, 0.5, 0.8),
          z: new Spring(-0.6, 0.75, 0.78),
          scale: new Spring(1, 0.4, 0.6),
          lastStrike: -1,
          phase: i * 1.7,
        };
      });
      this.placeMasks();
      // A frame that was not here yet: fetch it and dress the mask in it when it arrives, motion untouched.
      const want = input.masks.map(frameId).filter((f): f is string => f !== null);
      if (want.length) void loadFrames(want).then(() => this.redress(keys));
    }

    const first = !prev || rebuilt;
    if (first) {
      // Arrive in the final pose of whatever state we land in; only a live race plays its entrance.
      this.pose(input.state, true);
      if (input.state === 'live' && !input.reduced && !rebuilt) {
        this.pose('idle', true);
        this.queue = [];
        this.at(0.45, () => this.entrance());
      }
      this.wake();
      return;
    }

    if (prev.state !== input.state || prev.winner !== input.winner) {
      this.transition(prev.state, input.state);
    } else if (input.state === 'live') {
      // Strikes: every new attempt clicks the lock.
      input.attempts.forEach((n, i) => {
        if (n > prev.attempts[i]!) this.strike(i);
      });
    }
    this.wake();
  }

  /**
   * Before the first frame: the masks' frames are fetched and every shader compiled, without blocking the page where
   * the browser compiles in parallel. The arena shows only once this is done.
   */
  async warm(): Promise<void> {
    const ids = (this.input?.masks ?? []).map(frameId).filter((f): f is string => f !== null);
    await loadFrames(ids);
    if (this.disposed) return;
    if (this.input) this.redress(this.input.masks.map(lookKey));
    try {
      await this.renderer.compileAsync(this.scene, this.camera);
    } catch {
      /* the first frame compiles what is left */
    }
  }

  /** New rigs for the same masks (their frames arrived), keeping where each one is in its motion. */
  private redress(keys: string[]) {
    const input = this.input;
    if (this.disposed || !input || input.masks.map(lookKey).join() !== keys.join() || this.masks.length !== 3) return;
    if (this.masks.every((m, i) => m.rig.framed === (frameId(input.masks[i]!) !== null))) return;
    this.masks.forEach((m, i) => {
      const mask = input.masks[i]!;
      this.world.remove(m.rig.group);
      m.rig.dispose();
      m.rig = createMask(lookOf(mask.id, mask.look), this.tier, frameId(mask));
      this.world.add(m.rig.group);
    });
    this.placeMasks();
    this.wake();
  }

  setActive(on: boolean) {
    this.active = on;
    if (on) this.wake();
    else this.stop();
  }

  // ---------------------------------------------------------------- states

  /** Targets of a state at rest. `snap` jumps there without motion. */
  private pose(state: ArenaState, snap = false) {
    const win = this.input?.winner ?? null;
    const go = (s: Spring, v: number) => (snap ? s.snap(v) : s.set(v));
    const out = OUT.has(state);
    this.masks.forEach((m, i) => {
      const isWin = win === i;
      // Waiting masks stand back, not out of sight: their faces and eyes still read on the first frame.
      let presence = out ? 1 : state === 'held' ? 0.38 : 0.46;
      let eyes = out ? 1 : state === 'held' ? 0.5 : 0.72;
      let z = out ? 0 : state === 'held' ? -0.35 : -0.6;
      if (state === 'breach') {
        presence = isWin ? 1.1 : 0.85;
        eyes = isWin ? 1.45 : 0.85;
      }
      if (state === 'paid') {
        presence = isWin ? 1.12 : 0.3;
        eyes = isWin ? 1.35 : 0.4;
        z = isWin ? 0.1 : -0.18;
      }
      go(m.presence, presence);
      go(m.eyes, eyes);
      go(m.z, z);
      go(m.scale, 1);
    });
    const open = OPEN.has(state);
    go(this.split, open ? 1 : 0);
    go(this.bolts, open ? 1 : 0);
    go(this.seam, open ? 0 : state === 'held' ? 0.85 : state === 'live' ? 0.55 : 0.35);
    go(this.core, state === 'breach' ? 1 : state === 'paid' ? 0.6 : 0);
    go(this.pool, open ? 0.9 : state === 'held' ? 0.45 : state === 'live' ? 0.32 : 0.22);
    go(this.dolly, state === 'idle' ? 1.06 : state === 'held' ? 1.05 : state === 'breach' ? 0.97 : state === 'paid' ? 0.985 : 1);
    go(this.pan, state === 'paid' && win !== null ? (win - 1) * 0.22 : 0);
    go(this.lights, state === 'idle' ? 0.72 : state === 'held' ? 0.8 : 1);
    go(this.ringFlash, 0);
    if (snap) {
      if (this.vault) this.vault.cracks.reveal.value = open ? 1 : 0;
      this.crackAt = -1;
      this.cometAt = -1;
      this.bellAt = -1;
      this.landingAt = -1;
    }
  }

  private transition(from: ArenaState, to: ArenaState) {
    this.queue = [];
    const reduced = this.input?.reduced ?? false;
    if (reduced) {
      this.pose(to);
      if (this.vault) this.vault.cracks.reveal.value = OPEN.has(to) ? 1 : 0;
      return;
    }
    const wasOpen = OPEN.has(from);
    const wasOut = OUT.has(from);

    if (to === 'idle') {
      this.pose('idle');
      if (this.vault) this.vault.cracks.reveal.value = 0;
      return;
    }
    if (to === 'live') {
      if (wasOpen && this.vault) this.vault.cracks.reveal.value = 0;
      if (!wasOut) this.entrance();
      else this.pose('live');
      return;
    }
    if (to === 'breach') {
      if (!wasOut) this.entrance(true);
      if (!wasOpen) this.breach();
      else this.pose('breach');
      return;
    }
    if (to === 'paid') {
      if (!wasOut) this.entrance(true);
      if (!wasOpen) {
        this.breach();
        this.at(T.payoutAfterBreach / 1000, () => this.payout());
      } else this.payout();
      return;
    }
    if (to === 'held') {
      this.lock(wasOpen);
    }
  }

  private at(delay: number, fn: () => void) {
    this.queue.push({ at: this.t + delay, fn });
  }

  // ---------------------------------------------------------------- the three moments

  /** One: the masks come out of the dark, one by one, eyes igniting. */
  private entrance(fast = false) {
    this.pose('live');
    // Hold them in the dark, then release with a stagger.
    this.masks.forEach((m) => {
      m.presence.set(m.presence.value);
      m.z.set(m.z.value);
      m.eyes.set(m.eyes.value);
    });
    const order = [0, 2, 1];
    order.forEach((i, k) => {
      const delay = (fast ? 0.06 : T.entranceStagger[k]! / 1000) as number;
      this.at(delay, () => {
        const m = this.masks[i];
        if (!m) return;
        const state = this.input?.state ?? 'live';
        const win = this.input?.winner ?? null;
        m.presence.set(state === 'breach' ? (win === i ? 1.1 : 0.85) : state === 'paid' ? (win === i ? 1.12 : 0.3) : 1);
        m.z.set(state === 'paid' ? (win === i ? 0.1 : -0.18) : 0);
        flash(m.eyes, 1.9, state === 'paid' ? (win === i ? 1.35 : 0.4) : state === 'breach' ? (win === i ? 1.45 : 0.85) : 1);
        this.events.sound('click', 0.5);
      });
    });
  }

  /** Two: the bell, the bolts, cracks along the seam, then the halves part and the light floods out. */
  private breach() {
    const v = this.vault;
    flash(this.seam, 2.6, 1.2);
    this.seamTone.set(color.ice);
    this.zoom.kick(0.41);
    flash(this.ringFlash, 1, 0);
    this.bellAt = this.t;
    this.events.sound('bolt', 0.9);
    this.at(0.04, () => this.bolts.set(1));
    for (let k = 0; k < 4; k++) this.at(0.05 + k * 0.06, () => this.events.sound('click', 0.7));
    this.at(T.breachCrack / 1000, () => {
      this.crackAt = this.t;
      if (v) v.cracks.reveal.value = 0;
    });
    this.at(T.breachSplit / 1000, () => {
      this.split.set(1);
      this.core.set(1);
      this.pool.set(0.9);
      this.seam.set(0);
      this.dolly.set(0.97);
      this.zoom.kick(0.25);
      const win = this.input?.winner ?? null;
      this.masks.forEach((m, i) => {
        m.eyes.set(win === i ? 1.45 : 0.85);
        m.presence.set(win === i ? 1.1 : 0.85);
      });
      this.events.sound('hit', 0.55);
    });
  }

  /** Three: one pulse of money from the open vault to the winner, the landing, one number. */
  private payout() {
    const win = this.input?.winner ?? null;
    const target = win === null ? null : this.masks[win];
    if (!target) {
      this.pose('paid');
      return;
    }
    this.core.set(0.6);
    this.cometAt = this.t;
    this.at(T.payoutFlight / 1000, () => {
      this.events.sound('hit', 1);
      this.landingAt = this.t;
      target.scale.kick(1.6);
      flash(target.eyes, 2.4, 1.35);
      this.zoom.kick(0.3);
      this.pose('paid');
    });
  }

  /** The vault held: bolts slam home, the seam goes cold and steady, the masks fall back into the dark. */
  private lock(wasOpen: boolean) {
    if (wasOpen) {
      this.split.set(0);
      this.core.set(0);
      if (this.vault) this.vault.cracks.reveal.value = 0;
    }
    this.bolts.snap(Math.max(this.bolts.value, 0.55));
    this.bolts.set(0);
    this.at(0.12, () => {
      this.events.sound('lock', 1);
      this.bellAt = this.t;
      flash(this.ringFlash, 0.8, 0);
      flash(this.seam, 1.8, 0.85);
      this.seamTone.set(color.ice);
      this.zoom.kick(0.3);
    });
    this.at(0.2, () => this.pose('held'));
  }

  /** A strike in a live race: the mask's eyes jump, it leans in, the seam flickers in its corner colour. */
  private strike(i: number) {
    const m = this.masks[i];
    if (!m || this.t - m.lastStrike < 0.12) return;
    m.lastStrike = this.t;
    if (!this.input?.reduced) {
      m.eyes.kick(5);
      m.z.kick(0.9);
      this.seam.kick(4);
      this.seamTone.set(CORNERS[i]!);
      this.seamToneUntil = this.t + 0.35;
    }
    this.events.sound('click', 0.6);
  }

  // ---------------------------------------------------------------- loop

  private wake() {
    if (!this.active || this.disposed || this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  private stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private tick = (now: number) => {
    this.raf = 0;
    if (!this.active || this.disposed) return;
    // Clamped, so a tab coming back does not jump; loose enough that a slow device still keeps time.
    let dt = Math.min(0.25, Math.max(0, (now - this.last) / 1000));
    // Development only: `window.__arenaSlow = 0.1` plays the moments at a tenth of their speed, frame by frame.
    if (process.env.NODE_ENV !== 'production') dt *= (window as Window & { __arenaSlow?: number }).__arenaSlow ?? 1;
    this.last = now;
    this.t += dt;
    const busy = this.update(dt);
    this.renderer.render(this.scene, this.camera);
    this.emitAnchors();
    if (!this.readyFired) {
      this.readyFired = true;
      this.events.ready();
    }
    this.measure(dt);
    // Reduced motion: once everything has settled there is nothing to draw until the next change.
    if (busy || !this.input?.reduced) this.raf = requestAnimationFrame(this.tick);
  };

  /** Advance everything. Returns whether anything is still moving. */
  private update(dt: number): boolean {
    const t = this.t;
    const input = this.input;
    const reduced = input?.reduced ?? false;
    if (this.queue.length) {
      const due = this.queue.filter((q) => q.at <= t);
      this.queue = this.queue.filter((q) => q.at > t);
      for (const q of due) q.fn();
    }
    const springs = [this.split, this.bolts, this.seam, this.core, this.pool, this.ringFlash, this.zoom, this.dolly, this.pan, this.lights];
    for (const s of springs) s.step(reduced ? dt * 2.5 : dt);
    let busy = this.queue.length > 0 || springs.some((s) => !s.settled);

    const c = this.comp;
    const v = this.vault;
    if (v) {
      // The halves part like The Split: each swings open on its outer hinge, the cracked face still to the
      // camera; where the screen has room they also slide a little apart.
      const sp = this.split.value;
      const swing = sp * 0.98;
      const slide = sp * Math.max(0, c.split - 0.3) * 0.6;
      v.halves[0].position.x = -(DOOR_R + slide);
      v.halves[1].position.x = DOOR_R + slide;
      v.halves[0].rotation.y = -swing;
      v.halves[1].rotation.y = swing;
      v.doorLight.value = 1 - 0.9 * clamp01(sp);
      v.bolts.value = clamp01(this.bolts.value);
      v.seam.level.value = Math.max(0, this.seam.value);
      if (t > this.seamToneUntil) this.seamTone.lerp(ICE, Math.min(1, dt * 6));
      v.seam.color.copy(this.seamTone);
      v.core.value = Math.max(0, this.core.value);
      v.ringFlash.value = Math.max(0, this.ringFlash.value);
      if (this.crackAt >= 0) {
        const k = span(t, this.crackAt, 0.55);
        v.cracks.reveal.value = easeOutCubic(k) * 1.02;
        v.cracks.heat.value = 1 + 1.5 * (1 - k);
        if (k >= 1) this.crackAt = -1;
        busy = true;
      }
      v.update();
    }
    this.coreLight.intensity = Math.max(0, this.core.value) * 14;
    if (this.floor) {
      this.floor.pool.level.value = Math.max(0, this.pool.value);
      this.floor.pool.color.copy(ICE).lerp(AMBER, clamp01(this.core.value / 0.6));
    }

    // Masks: presence, eyes, a breath of motion.
    const breathe = reduced ? 0 : 1;
    this.masks.forEach((m, i) => {
      for (const s of [m.presence, m.eyes, m.z, m.scale]) s.step(reduced ? dt * 2.5 : dt);
      if (!m.presence.settled || !m.eyes.settled || !m.z.settled || !m.scale.settled) busy = true;
      const p = c.masks[i]!;
      const bob = Math.sin(t * 1.15 + m.phase) * 0.012 * breathe * p.size;
      // Stepping back into the dark also sinks a little; coming out rises into the light.
      m.rig.group.position.set(p.x, p.y + bob + Math.min(0, m.z.value) * p.size * 0.22, p.z + m.z.value * p.size * 1.4);
      m.rig.group.scale.setScalar(p.size * m.scale.value);
      m.rig.group.rotation.set(p.pitch + Math.sin(t * 0.7 + m.phase) * 0.012 * breathe, p.yaw + Math.sin(t * 0.43 + m.phase) * 0.03 * breathe, 0);
      // Eyes breathe on a 7 s cycle, ±6 % (BRANDBOOK §9).
      const cycle = 1 + 0.06 * Math.sin((t * 2 * Math.PI) / 7 + m.phase) * breathe;
      m.rig.eyes.value = Math.max(0, m.eyes.value) * cycle;
      m.rig.presence.value = Math.max(0.02, m.presence.value);
      syncHalos(m.rig);
    });

    // Lights follow the mood.
    const L = this.lights.value;
    this.key.intensity = 1.3 * L;
    this.rimL.intensity = 2.6 * L;
    this.rimR.intensity = 2.6 * L;
    this.scene.environmentIntensity = 0.75 + 0.35 * L;

    // Bell: a ring that runs out from the seam.
    if (this.bellAt >= 0) {
      const k = span(t, this.bellAt, 0.7);
      this.bell.visible = k < 1;
      const r = VAULT_R * (1.02 + 0.85 * easeOutExpo(k));
      this.bell.scale.setScalar(r);
      this.bell.material.uniforms.uAlpha!.value = (1 - k) * (1 - k) * 0.9;
      if (k >= 1) this.bellAt = -1;
      busy = true;
    } else this.bell.visible = false;

    // Payout: one comet of money, a hot head and a streak along its path. Not a rain of particles.
    if (this.cometAt >= 0 && input?.winner != null) {
      const m = this.masks[input.winner];
      if (m) {
        this.cometFrom.set(c.vault.x, c.vault.y + 0.1, c.vault.z + 0.35);
        this.cometTo.copy(m.rig.group.position);
        const k = (t - this.cometAt) / (T.payoutFlight / 1000);
        const e = easeInOutCubic(clamp01(k));
        const life = k < 1 ? 1 : Math.max(0, 1 - (k - 1) * 4);
        this.curve(e, this.head);
        this.curve(Math.max(0, e - 0.09), this.tail);
        const [core, halo, streak] = this.comet as [Sprite, Sprite, Sprite];
        const swell = 0.75 + 0.25 * Math.sin(Math.PI * clamp01(k));
        core.position.copy(this.head);
        core.scale.setScalar(0.26 * swell);
        core.material.opacity = life;
        halo.position.copy(this.head);
        halo.scale.setScalar(0.6 * swell);
        halo.material.opacity = 0.45 * life;
        // The streak lies along the path on screen.
        const a = this.toNdc(this.head);
        const b = this.toNdc(this.tail);
        const aspect = this.frame.w / this.frame.h;
        streak.material.rotation = Math.atan2(a.y - b.y, (a.x - b.x) * aspect);
        streak.position.lerpVectors(this.head, this.tail, 0.5);
        streak.scale.set(Math.max(0.2, this.head.distanceTo(this.tail) * 1.5), 0.16 * swell, 1);
        streak.material.opacity = 0.7 * life * (k < 1 ? 1 : 0);
        for (const sp of this.comet) sp.visible = sp.material.opacity > 0.01;
        this.cometLight.position.copy(this.head);
        this.cometLight.intensity = (k < 1 ? 1.4 + 1.6 * Math.sin(Math.PI * clamp01(k)) : 3 * life) * 0.8;
        if (k > 1.3) {
          this.cometAt = -1;
          for (const sp of this.comet) sp.visible = false;
          this.cometLight.intensity = 0;
        }
        busy = true;
      }
    } else {
      for (const sp of this.comet) sp.visible = false;
      this.cometLight.intensity = 0;
    }

    // Landing ring at the winner's feet.
    if (this.landingAt >= 0 && input?.winner != null) {
      const m = this.masks[input.winner];
      const k = span(t, this.landingAt, 0.8);
      if (m) {
        this.landing.position.set(m.rig.group.position.x, 0.004, m.rig.group.position.z);
        const size = c.masks[input.winner]!.size;
        this.landing.scale.setScalar(size * (0.25 + 1.3 * easeOutExpo(k)));
        this.landing.material.uniforms.uAlpha!.value = (1 - k) * 2.4;
        this.landing.visible = k < 1;
      }
      if (k >= 1) this.landingAt = -1;
      busy = true;
    } else this.landing.visible = false;

    this.updateCamera(t, reduced);
    return busy || this.masks.some((m) => !m.presence.settled);
  }

  /** The payout's path: out of the vault, up, and down onto the winner. */
  private mid = new Vector3();

  private curve(e: number, out: Vector3) {
    const a = this.cometFrom;
    const b = this.cometTo;
    const mid = this.mid.set((a.x + b.x) / 2, Math.max(a.y, b.y) + 0.9, (a.z + b.z) / 2 + 0.4);
    const u = 1 - e;
    out.set(
      u * u * a.x + 2 * u * e * mid.x + e * e * b.x,
      u * u * a.y + 2 * u * e * mid.y + e * e * b.y,
      u * u * a.z + 2 * u * e * mid.z + e * e * b.z,
    );
  }

  private updateCamera(t: number, reduced: boolean) {
    const c = this.comp;
    const drift = reduced ? 0 : 1;
    const d = c.camera.z - c.vault.z;
    const dolly = this.dolly.value;
    // A phone has no side room: the side masks stand near its edges, so the orbit and the turn to the winner are smaller.
    const amp = c.portrait ? 0.4 : 1;
    const dx = (Math.sin((t * 2 * Math.PI) / 23) * 0.22 + this.pan.value * d * 0.12) * drift * amp + (reduced ? this.pan.value * d * 0.12 * amp : 0);
    const dy = Math.sin((t * 2 * Math.PI) / 17 + 1) * 0.045 * drift;
    this.camera.position.set(c.camera.x + dx, c.camera.y + dy, c.vault.z + d * dolly);
    // Turn back toward the vault by most of the drift, so the move reads as a slow orbit. Level, no roll.
    this.camera.rotation.set(0, Math.atan2(dx, d) * 0.8, 0);
    // A kick on the zoom spring is the punch of a bell: 1 → 1.012 in ~60 ms and back on a spring (BRANDBOOK §9).
    this.camera.zoom = Math.max(0.95, this.zoom.value);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  // ---------------------------------------------------------------- anchors and measuring

  private v = new Vector3();

  private toNdc(p: Vector3): { x: number; y: number } {
    this.v.copy(p).project(this.camera);
    return { x: this.v.x, y: this.v.y };
  }

  private toScreen(x: number, y: number, z: number): { x: number; y: number } {
    this.v.set(x, y, z).project(this.camera);
    return { x: ((this.v.x + 1) / 2) * this.frame.w, y: ((1 - this.v.y) / 2) * this.frame.h };
  }

  private emitAnchors() {
    const c = this.comp;
    const vc = this.toScreen(c.vault.x, c.vault.y, c.vault.z);
    const ve = this.toScreen(c.vault.x + DOOR_R, c.vault.y, c.vault.z);
    const lift = this.toScreen(c.vault.x, c.vault.y + VAULT_R * 0.4, c.vault.z + 0.05);
    const masks = this.masks.map((m, i): MaskAnchor => {
      const p = m.rig.group.position;
      const s = c.masks[i]!.size * m.scale.value;
      const top = this.toScreen(p.x, p.y + s / 2, p.z);
      const bot = this.toScreen(p.x, p.y - s / 2, p.z);
      const side = this.toScreen(p.x + (s * MASK_ASPECT) / 2, p.y, p.z);
      const mid = this.toScreen(p.x, p.y, p.z);
      return { x: mid.x, top: top.y, bottom: bot.y, half: Math.abs(side.x - mid.x) };
    });
    if (masks.length !== 3) return;
    const a: Anchors = {
      vault: { x: vc.x, y: vc.y, r: Math.abs(ve.x - vc.x) },
      lift,
      masks: masks as unknown as Anchors['masks'],
    };
    const key = [a.vault.x, a.vault.y, a.vault.r, ...masks.flatMap((m) => [m.x, m.top, m.bottom])].map((n) => n.toFixed(1)).join();
    if (key === this.lastAnchors) return;
    this.lastAnchors = key;
    this.events.anchors(a);
  }

  /**
   * Auto quality, in time rather than frames so a slow device is found out fast: after a short warm-up, the median
   * frame of the next second and a half steps the scene down one tier. Under 24 frames a second on the simplest tier,
   * or under 12 on any, tells the page, once, that the scene is too much for this device.
   */
  private measure(dt: number) {
    if (this.forced || this.gaveUp || this.input?.reduced) return;
    this.warmup += dt;
    if (this.warmup < 0.6) return;
    this.samples.push(dt);
    this.sampled += dt;
    if (this.samples.length < 12 || this.sampled < 1.5) return;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    this.samples = [];
    this.sampled = 0;
    this.warmup = 0;
    if (median > 1 / 12 || (this.tier === 'low' && median > 1 / 24)) {
      if (!this.events.slow) return;
      this.gaveUp = true;
      // Out of the frame: the page may dispose the engine in answer.
      window.setTimeout(() => this.events.slow?.(), 0);
      return;
    }
    if (this.tier !== 'low' && median > 1 / 42) this.setTier(down(this.tier));
  }
}
