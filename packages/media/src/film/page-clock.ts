/**
 * The page's clock, owned by the film. Runs in the page before any of its scripts.
 *
 * A film frame is 1/30 s of the page's time, however long the machine needs to draw it: software WebGL draws the 3D
 * arena in a fraction of a second per frame, and the footage still plays at full speed and never drops a frame. So
 * the page's timers, its animation frames, `Date` and `performance.now()` all read one counter that only
 * `__film.advance(ms)` moves. CSS animations and transitions are not timers; they are held paused and moved by the
 * same step. A step of less than a frame's time is slow motion, as smooth as the full speed.
 *
 * `__film.marks` keeps the moment the arena reached each state (`data-state` of the arena's section): a shot's camera
 * and its cut are timed from the break, not from the page load.
 */

/** The script, with the wall-clock moment the page believes it starts at (the moment the replayed chain was read). */
export function pageClock(epochMs: number): string {
  return `(${clock.toString()})(${Math.round(epochMs)});`;
}

/* The function below is serialised into the page: it may use nothing from this module. */
function clock(epoch: number): void {
  const w = window as unknown as Record<string, any>;
  const realSetTimeout = window.setTimeout.bind(window);
  const realRaf = window.requestAnimationFrame.bind(window);
  const RealDate = Date;
  let now = 0;
  let seq = 1;
  type Timer = { at: number; fn: unknown; args: unknown[]; every: number };
  const timers = new Map<number, Timer>();
  let frames: { id: number; fn: (t: number) => void }[] = [];
  const marks: Record<string, number> = {};
  const known = new WeakSet<Animation>();

  const later = (fn: unknown, ms: unknown, args: unknown[], repeat: boolean): number => {
    const id = seq++;
    const wait = Math.max(repeat ? 1 : 0, Number(ms) || 0);
    timers.set(id, { at: now + wait, fn, args, every: repeat ? wait : 0 });
    return id;
  };
  w["setTimeout"] = (fn: unknown, ms?: unknown, ...args: unknown[]) => later(fn, ms, args, false);
  w["setInterval"] = (fn: unknown, ms?: unknown, ...args: unknown[]) => later(fn, ms, args, true);
  w["clearTimeout"] = w["clearInterval"] = (id: number) => void timers.delete(id);
  w["requestAnimationFrame"] = (fn: (t: number) => void) => {
    const id = seq++;
    frames.push({ id, fn });
    return id;
  };
  w["cancelAnimationFrame"] = (id: number) => {
    frames = frames.filter((f) => f.id !== id);
  };
  w["requestIdleCallback"] = (fn: (d: unknown) => void) => later(() => fn({ didTimeout: false, timeRemaining: () => 50 }), 1, [], false);
  w["cancelIdleCallback"] = (id: number) => void timers.delete(id);
  performance.now = () => now;
  class FilmDate extends RealDate {
    constructor(...a: unknown[]) {
      if (a.length === 0) super(epoch + now);
      else super(...(a as [number]));
    }
    static override now(): number {
      return epoch + now;
    }
  }
  w["Date"] = FilmDate;

  const say = (e: unknown) => console.error(e);
  /** Every timer due by `until`, in the order a browser would have run them. */
  const runTimers = (until: number) => {
    for (let guard = 0; guard < 20_000; guard++) {
      let id = 0;
      let next: Timer | null = null;
      for (const [k, t] of timers) if (t.at <= until && (next === null || t.at < next.at || (t.at === next.at && k < id))) [id, next] = [k, t];
      if (next === null) break;
      now = Math.max(now, next.at);
      if (next.every) next.at += next.every;
      else timers.delete(id);
      try {
        if (typeof next.fn === "function") (next.fn as (...a: unknown[]) => void)(...next.args);
      } catch (e) {
        say(e);
      }
    }
    now = until;
  };
  /** CSS animations and transitions: held, and moved by the film's step. One met for the first time starts at its start. */
  const stepAnimations = (ms: number) => {
    for (const a of document.getAnimations()) {
      try {
        if (!known.has(a)) {
          known.add(a);
          a.pause();
          a.currentTime = 0;
        } else {
          a.currentTime = Number(a.currentTime ?? 0) + ms;
        }
      } catch {
        /* an animation that ended between the two lines */
      }
    }
  };

  // The arena's states, as the page itself sets them on the arena's section.
  const read = () => {
    const el = document.querySelector('section[aria-label="Arena"]');
    if (!el) return;
    if (el.hasAttribute("data-ready") && marks["ready"] === undefined) marks["ready"] = now;
    const state = el.getAttribute("data-state");
    if (state && marks[state] === undefined) marks[state] = now;
  };
  new MutationObserver(read).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state", "data-ready"] });

  w["__film"] = {
    marks,
    now: () => now,
    /** Moves the page's time by `ms`: timers, then one animation frame, then the CSS animations. */
    advance(ms: number): number {
      runTimers(now + ms);
      const due = frames;
      frames = [];
      for (const f of due) {
        try {
          f.fn(now);
        } catch (e) {
          say(e);
        }
      }
      stepAnimations(ms);
      return now;
    },
    /** Every CSS animation back to its start: a page is filmed from the moment it appears. */
    rewind(): void {
      for (const a of document.getAnimations()) {
        try {
          known.add(a);
          a.pause();
          a.currentTime = 0;
        } catch {
          /* gone */
        }
      }
    },
    /** Resolves when the page has drawn what the last step changed: React has committed and the browser has painted. */
    settled(): Promise<void> {
      return new Promise((done) => realSetTimeout(() => realRaf(() => realSetTimeout(() => realRaf(() => done()), 0)), 0));
    },
  };
}

/**
 * The 3D arena is not started on software WebGL: a person's screen would stutter (apps/web `hardwareGl`). A film frame
 * may take as long as it likes, so the film lets the arena start: it answers that check the way a desk with a GPU does.
 */
export const DESK_GL = `(${desk.toString()})();`;

function desk(): void {
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, attrs?: Record<string, unknown>) {
    return getContext.call(this, type, attrs && attrs["failIfMajorPerformanceCaveat"] ? { ...attrs, failIfMajorPerformanceCaveat: false } : attrs);
  } as typeof getContext;
  const getParameter = WebGL2RenderingContext.prototype.getParameter;
  const UNMASKED_RENDERER_WEBGL = 0x9246;
  WebGL2RenderingContext.prototype.getParameter = function (this: WebGL2RenderingContext, p: number) {
    return p === UNMASKED_RENDERER_WEBGL ? "ANGLE (film)" : getParameter.call(this, p);
  };
  Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
  Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });
}
