// Motion primitives: springs that keep their velocity when the target changes mid-flight (Apple's rule:
// every motion is interruptible), and a few easing curves for authored moments.

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);
export const easeInCubic = (t: number) => clamp01(t) ** 3;

/** A window [start, start+dur] of a timeline mapped to 0..1. */
export const span = (t: number, start: number, dur: number) => clamp01((t - start) / dur);

/** One damped spring. `response` is the period in seconds, `damping` 1 is critical, below 1 overshoots. */
export class Spring {
  value: number;
  target: number;
  velocity = 0;
  private k: number;
  private c: number;

  constructor(value: number, response = 0.5, damping = 1) {
    this.value = value;
    this.target = value;
    const w = (2 * Math.PI) / response;
    this.k = w * w;
    this.c = 2 * damping * w;
  }

  set(target: number) {
    this.target = target;
  }

  /** Jump without motion. */
  snap(value: number) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
  }

  /** Add velocity: a punch that settles back on the target. */
  kick(v: number) {
    this.velocity += v;
  }

  step(dt: number): number {
    // Semi-implicit Euler in fixed sub-steps: stable at any frame time.
    let left = Math.min(dt, 0.1);
    while (left > 0) {
      const h = Math.min(left, 1 / 240);
      const a = -this.k * (this.value - this.target) - this.c * this.velocity;
      this.velocity += a * h;
      this.value += this.velocity * h;
      left -= h;
    }
    return this.value;
  }

  get settled(): boolean {
    return Math.abs(this.value - this.target) < 1e-4 && Math.abs(this.velocity) < 1e-4;
  }
}
