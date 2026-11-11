/**
 * What is filmed for a round: the real 3D arena at the break and the payout, and the pages of the site. The same list
 * films any round whose record the site can replay.
 *
 * Two kinds of arena shot. `home` is the home page exactly as a person sees it: the arena's own camera, the page's
 * own type. The others are the same scene on the same page at the same moments, seen by a film camera placed for the
 * shot, with the page's type hidden: the clip lays the round's numbers over them itself.
 */

export type Shot = {
  name: string;
  path: string;
  /** The CSS viewport and its pixel scale: `width × scale` is always 1920, `height × scale` 1080. */
  viewport: { width: number; height: number; scale: number };
  /** `arena`: waits for the 3D arena and is cut around one of its moments. `page`: filmed from the page's first paint. */
  kind: "arena" | "page";
  /**
   * The film camera: the source of a function `(f, film) => void` run in the page for every frame of the scene, after
   * the arena's own camera is placed (`FilmFrame` in apps/web arena3d/engine). `film.marks` has the page time, ms, of
   * `ready`, `idle`, `breach`, `paid`; `film.now()` is the page time now.
   */
  camera?: string;
  /** Extra CSS for the shot. */
  css?: string;
  /** Seconds of page time after the arena is ready (a page: after its first paint) that are not written to disk. */
  lead?: number;
  /** The frames kept: from `from` to `to` seconds of film around the mark (`start` for a page). */
  cut: { mark: string; from: number; to: number };
  /** Slow motion: from `from` seconds after `mark`, a film second shows `rate` seconds of the page. */
  slow?: { mark: string; from: number; rate: number };
  /**
   * A page shot filmed close: only a band of the page, the full width of one element and 1080 px tall on film, at
   * `scale` film pixels per CSS pixel. The reel is wider than the frame, and the clip pans along it. `shift` moves
   * the band down from the element's middle, CSS px.
   */
  strip?: { selector: string; scale: number; shift?: number; pad?: number };
};

/** The page at 1920×1080 as it is laid out for a 1440 px desk, the width the site is checked at: its type is a third larger on film. */
const DESK = { width: 1440, height: 810, scale: 4 / 3 } as const;
/** The 3D arena at the full frame. */
const FULL = { width: 1920, height: 1080, scale: 1 } as const;

/** A film shot shows the scene alone: the page's header, deck and the type over the arena are not in it. */
const SCENE_ONLY = `header, footer, section[aria-label="Arena"] > div:last-of-type, section[aria-label="Arena"] > button { visibility: hidden !important; }`;

/** What a film camera is handed for every frame: `FilmFrame` of apps/web arena3d/engine, as far as a shot uses it. */
type Cam = {
  camera: {
    position: { set(x: number, y: number, z: number): void };
    lookAt(x: number, y: number, z: number): void;
    fov: number;
    zoom: number;
    clearViewOffset(): void;
    /** A lens shift: the picture is the window `(x, y, w, h)` of a full frame `fw × fh`. */
    setViewOffset(fw: number, fh: number, x: number, y: number, w: number, h: number): void;
  };
  vault: { x: number; y: number; z: number };
  masks: readonly { x: number; y: number; z: number }[];
};
type Film = { marks: Record<string, number>; now(): number };

/* Each camera below is serialised into the page: it may use nothing but its two arguments. Distances are in the
   scene's own units: the vault's radius is 1, a mask is about 0.45 tall. */

/** The vault door, close: a slow push on the white seam, a hard punch in when the halves part, then into the light. */
function crackCamera(f: Cam, film: Film): void {
  const t = film.marks["breach"] === undefined ? -1 : (film.now() - film.marks["breach"]) / 1000;
  const ease = (a: number, b: number, x: number) => {
    const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return k * k * (3 - 2 * k);
  };
  const split = 0.56;
  const far = 4.25 - 0.35 * ease(-1, split, t);
  const z = far - 0.32 * (1 - Math.pow(1 - ease(split, split + 0.14, t), 3)) - 0.25 * ease(split + 0.14, 3.2, t);
  const x = -1.05 + 0.75 * ease(-1, 3.2, t);
  f.camera.clearViewOffset();
  f.camera.fov = 30;
  f.camera.position.set(f.vault.x + x, f.vault.y - 0.5, f.vault.z + z);
  f.camera.lookAt(f.vault.x, f.vault.y + 0.02, f.vault.z);
}

/** The winner's eyes, macro: out of the dark as the vault cracks, and they light. */
function eyeCamera(f: Cam, film: Film): void {
  // The winner's place on the stage, as the page marks it on the mask's name plate.
  const m = f.masks[Number(document.querySelector('section[aria-label="Arena"] [data-win]')?.getAttribute("data-slot") ?? 1)] ?? f.masks[1]!;
  const t = film.marks["breach"] === undefined ? -1 : (film.now() - film.marks["breach"]) / 1000;
  const k = Math.min(1, Math.max(0, (t + 0.6) / 2.4));
  f.camera.clearViewOffset();
  f.camera.fov = 13;
  f.camera.position.set(m.x + 0.22 - 0.14 * k, m.y + 0.03, m.z + 1.08 - 0.22 * k);
  f.camera.lookAt(m.x, m.y + 0.035, m.z);
}

/** The winner from the floor, the open vault alight behind it: a slow push in. */
function heroCamera(f: Cam, film: Film): void {
  // The winner's place on the stage, as the page marks it on the mask's name plate.
  const m = f.masks[Number(document.querySelector('section[aria-label="Arena"] [data-win]')?.getAttribute("data-slot") ?? 1)] ?? f.masks[1]!;
  const t = film.marks["paid"] === undefined ? 0 : (film.now() - film.marks["paid"]) / 1000;
  const k = Math.min(1, Math.max(0, (t - 1) / 3.4));
  // A lens shift puts the mask right of the middle, and the camera stands to its right, so the vault behind it is on
  // the right too: the left field stays dark for the name.
  f.camera.setViewOffset(1920, 1080, -330, 0, 1920, 1080);
  f.camera.fov = 30;
  f.camera.position.set(m.x + 0.36 - 0.2 * k, 0.07, m.z + 1.08 - 0.26 * k);
  f.camera.lookAt(m.x, m.y + 0.07, m.z);
}

/** The payout: the camera follows the light out of the vault, over the floor and down onto the winner. */
function flowCamera(f: Cam, film: Film): void {
  // The winner's place on the stage, as the page marks it on the mask's name plate.
  const m = f.masks[Number(document.querySelector('section[aria-label="Arena"] [data-win]')?.getAttribute("data-slot") ?? 1)] ?? f.masks[1]!;
  const t = film.marks["paid"] === undefined ? 0 : (film.now() - film.marks["paid"]) / 1000;
  // The light's own path (arena3d engine `curve`): out of the vault, up, and down onto the mask in 0.82 s.
  const k = Math.min(1, Math.max(0, t / 0.82));
  const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  const a = { x: f.vault.x, y: f.vault.y + 0.1, z: f.vault.z + 0.35 };
  const mid = { x: (a.x + m.x) / 2, y: Math.max(a.y, m.y) + 0.9, z: (a.z + m.z) / 2 + 0.4 };
  const u = 1 - e;
  const at = (p: "x" | "y" | "z") => u * u * a[p] + 2 * u * e * mid[p] + e * e * m[p];
  // A lens shift keeps the light left of the middle all the way: the right field stays dark for the sum.
  f.camera.setViewOffset(1920, 1080, 340, 0, 1920, 1080);
  f.camera.fov = 30;
  f.camera.position.set(-1.3 + 0.9 * e, 1.15 - 0.6 * e, 6.2 - 1.7 * e);
  f.camera.lookAt(at("x") * 0.8, at("y") * 0.86 + 0.1, at("z"));
}

/**
 * The shots of a round. The home page plays the round's break the first time it shows it: the vault with its sum, the
 * crack 2.2 s after the scene appears, the payout 2.4 s after the crack (apps/web Stage `useShown`). Every arena shot
 * is cut around those two moments; `crack`, `eye`, `hero` and `flow` stand in the clip where the generated footage of
 * the same names goes when there is any.
 */
export function shotsOf(round: { id: string; winner: string }): Shot[] {
  const film = (name: string, camera: (f: Cam, film: Film) => void, rest: Pick<Shot, "lead" | "cut" | "slow">): Shot => ({ name, path: "/", viewport: FULL, kind: "arena", camera: camera.toString(), css: SCENE_ONLY, ...rest });
  return [
    { name: "home", path: "/", viewport: FULL, kind: "arena", lead: 0.9, cut: { mark: "breach", from: -1.2, to: 6.2 } },
    // Cut before the payout begins: the clip plays this shot backwards too, and the vault must shut on nothing but its own light.
    film("crack", crackCamera, { lead: 1.2, cut: { mark: "breach", from: -0.6, to: 2.4 } }),
    film("eye", eyeCamera, { lead: 1.2, cut: { mark: "breach", from: -0.6, to: 1.9 } }),
    film("hero", heroCamera, { lead: 3.6, cut: { mark: "paid", from: 1.2, to: 4.2 } }),
    film("flow", flowCamera, {
      lead: 3.6,
      cut: { mark: "paid", from: -0.3, to: 3.4 }, // Slowed so the flight takes a beat and a half at 120 BPM: the light lands on a beat.
    slow: { mark: "paid", from: 0, rate: 0.547 } }),
    // The league's rows from the first one down, close enough that the page's smallest type is 56 px on film and the
    // table's small head is out of the band: the clip pans from the name to the sum.
    { name: "league", path: "/league", viewport: DESK, kind: "page", cut: { mark: "start", from: 0, to: 3 }, strip: { selector: 'section[aria-label="League table"] ol > li:first-child', scale: 4, shift: 82, pad: 24 } },
    { name: "league-page", path: "/league", viewport: DESK, kind: "page", cut: { mark: "start", from: 0, to: 3 } },
    { name: "mask", path: `/mask/${round.winner.toLowerCase()}`, viewport: DESK, kind: "page", cut: { mark: "start", from: 0, to: 3 } },
    { name: "race", path: `/race/${round.id}`, viewport: DESK, kind: "page", cut: { mark: "start", from: 0, to: 3 } },
  ];
}
