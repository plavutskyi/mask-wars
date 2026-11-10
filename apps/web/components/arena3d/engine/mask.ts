// A mask in 3D, in the outline of the season's frames (`../silhouette`). A cut front of planar facets with a ridge
// down the middle, a bevel that catches the contour light, solid walls, and eyes: blades of light along the frames'
// own eye slits. A mask of the catalog wears its frame on the front, projected straight on, so the arena shows the
// very face of the posts and the site; a forged mask is built from its one material, one eye colour and one modifier
// (BRANDBOOK §5).

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  ShaderChunk,
  ShaderMaterial,
  ShapeUtils,
  SRGBColorSpace,
  Vector2,
  Vector3,
  type Material,
  type Sprite,
  type Texture,
} from 'three';
import type { MaskLook } from '../looks';
import { CROP, EYE, OUTLINE, type Pt, uvOf } from '../silhouette';
import { glowSprite } from './fx';
import type { Tier } from './tier';

const BEVEL = 0.013; // inset of the front face, in mask heights
const BEVEL_DEPTH = 0.026; // how far the outline falls back behind the front
const WALL = 0.05; // shell thickness behind the outline
const ROW = 0.016; // the finest band of the front
const COLS = 36; // columns across the face; half as many across each ear and each point of the chin

const mirror = ([x, y]: Pt): Pt => [-x, y];
/** Frame units → mask space: centred, y up, one unit tall. */
const toV = ([x, y]: Pt, z: number) => new Vector3(x, 0.5 - y, z);

/**
 * The relief: the lowest of a few planes, mirrored, so the front is cut into flat facets with crisp creases, as in the
 * frames. The ridge leads; the brow falls back toward the ears, the cheeks toward the chin, the sides steeply.
 */
const PLANES: ReadonlyArray<readonly [number, number, number]> = [
  // z = c + a·|x| + b·y
  [0.112, -0.42, 0], // ridge
  [-0.035, -0.3, 0.35], // brow, back toward the ear tips
  [0.33, -0.28, -0.4], // cheek, back toward the chin
  [0.237, -0.95, 0], // side
];

export function surface(x: number, y: number): number {
  const a = Math.abs(x);
  let z = Infinity;
  for (const [c, ka, kb] of PLANES) z = Math.min(z, c + ka * a + kb * y);
  return z;
}

/** Inward offset of a closed outline. Miter clamped at sharp tips. */
function inset(points: readonly Pt[], d: number): Pt[] {
  const n = points.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[(i + 1) % n]!;
    area += x0 * y1 - x1 * y0;
  }
  const s = area > 0 ? 1 : -1;
  return points.map((p, i) => {
    const a = points[(i - 1 + n) % n]!;
    const b = points[(i + 1) % n]!;
    const e1 = new Vector2(p[0] - a[0], p[1] - a[1]).normalize();
    const e2 = new Vector2(b[0] - p[0], b[1] - p[1]).normalize();
    const n1 = new Vector2(-e1.y * s, e1.x * s);
    const n2 = new Vector2(-e2.y * s, e2.x * s);
    const m = n1.clone().add(n2);
    const len = Math.max(0.35, (1 + n1.dot(n2)) / 2);
    m.normalize().multiplyScalar(Math.min(d / Math.sqrt(len), d * 2.4));
    return [p[0] + m.x, p[1] + m.y] as Pt;
  });
}

/** A triangle list with positions and the frame's texture coordinates. */
class Soup {
  pos: number[] = [];
  uv: number[] = [];
  /** One triangle, wound to face `want`. */
  tri(a: Vector3, b: Vector3, c: Vector3, want: Vector3) {
    const n = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a));
    for (const v of n.dot(want) < 0 ? [a, c, b] : [a, b, c]) {
      this.pos.push(v.x, v.y, v.z);
      const [u, w] = uvOf([v.x, 0.5 - v.y]);
      this.uv.push(u, w);
    }
  }
  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2));
    g.computeVertexNormals();
    return g;
  }
}

/** Where a horizontal line meets the outline's edges, left to right: the spans of the face on that line. */
function spansAt(poly: readonly Pt[], y: number): Array<[number, number]> {
  const xs: Array<{ x: number; edge: number }> = [];
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i]!;
    const [x1, y1] = poly[(i + 1) % poly.length]!;
    if ((y0 <= y && y < y1) || (y1 <= y && y < y0)) xs.push({ x: x0 + ((y - y0) / (y1 - y0)) * (x1 - x0), edge: i });
  }
  xs.sort((a, b) => a.x - b.x);
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i]!.edge, xs[i + 1]!.edge]);
  return out;
}

const edgeX = (poly: readonly Pt[], i: number, y: number) => {
  const [x0, y0] = poly[i]!;
  const [x1, y1] = poly[(i + 1) % poly.length]!;
  return y1 === y0 ? x0 : x0 + ((y - y0) / (y1 - y0)) * (x1 - x0);
};

interface Built {
  front: BufferGeometry;
  trim: BufferGeometry;
  walls: BufferGeometry;
  eyes: BufferGeometry;
  /** Eye centres and the blade's angle on screen, mask space. */
  eyeAt: Array<{ pos: Vector3; angle: number; length: number }>;
}

let cached: Built | null = null;

/** Every row the front is cut at: each corner of the inset outline, and enough between them. */
function rows(poly: readonly Pt[]): number[] {
  const ys = [...new Set(poly.map(([, y]) => y))].sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 0; i < ys.length - 1; i++) {
    const a = ys[i]!;
    const b = ys[i + 1]!;
    const n = Math.max(1, Math.ceil((b - a) / ROW));
    for (let k = 0; k < n; k++) out.push(a + ((b - a) * k) / n);
  }
  out.push(ys.at(-1)!);
  return out;
}

function build(): Built {
  if (cached) return cached;
  const inner = inset(OUTLINE, BEVEL);
  const toward = new Vector3(0, 0, 1);
  const at = (p: Pt, dz = 0) => toV(p, surface(p[0], p[1]) + dz);

  // The front: band by band between the rows, each span of the face a strip of quads. Every span has the same
  // number of columns, so neighbouring bands share their vertices exactly and the face has no cracks.
  const front = new Soup();
  const ys = rows(inner);
  for (let r = 0; r < ys.length - 1; r++) {
    const y0 = ys[r]!;
    const y1 = ys[r + 1]!;
    const spans = spansAt(inner, (y0 + y1) / 2);
    const cols = spans.length > 1 ? COLS / 2 : COLS;
    for (const [l, rt] of spans) {
      const xl0 = edgeX(inner, l, y0);
      const xr0 = edgeX(inner, rt, y0);
      const xl1 = edgeX(inner, l, y1);
      const xr1 = edgeX(inner, rt, y1);
      for (let c = 0; c < cols; c++) {
        const t0 = c / cols;
        const t1 = (c + 1) / cols;
        const a = at([xl0 + (xr0 - xl0) * t0, y0]);
        const b = at([xl0 + (xr0 - xl0) * t1, y0]);
        const d = at([xl1 + (xr1 - xl1) * t0, y1]);
        const e = at([xl1 + (xr1 - xl1) * t1, y1]);
        front.tri(a, b, e, toward);
        front.tri(a, e, d, toward);
      }
    }
  }

  // Bevel all round and the walls behind it, each edge cut at the same rows as the front so they meet it exactly.
  const trim = new Soup();
  const walls = new Soup();
  const n = OUTLINE.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const fi = inner[i]!;
    const fj = inner[j]!;
    const oi = OUTLINE[i]!;
    const oj = OUTLINE[j]!;
    const lo = Math.min(fi[1], fj[1]);
    const hi = Math.max(fi[1], fj[1]);
    const ts = [0, 1, ...ys.filter((y) => y > lo && y < hi).map((y) => (y - fi[1]) / (fj[1] - fi[1]))].sort((a, b) => a - b);
    const lerp = (p: Pt, q: Pt, t: number): Pt => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    // Outward on screen, for the winding: from the inset edge toward the outline.
    const out2 = new Vector2((oi[0] + oj[0] - fi[0] - fj[0]) / 2, -(oi[1] + oj[1] - fi[1] - fj[1]) / 2).normalize();
    const out = new Vector3(out2.x, out2.y, 0);
    const bevelWant = out.clone().add(toward).normalize();
    for (let k = 0; k < ts.length - 1; k++) {
      const f0 = at(lerp(fi, fj, ts[k]!));
      const f1 = at(lerp(fi, fj, ts[k + 1]!));
      const p0 = lerp(oi, oj, ts[k]!);
      const p1 = lerp(oi, oj, ts[k + 1]!);
      const o0 = at(p0, -BEVEL_DEPTH);
      const o1 = at(p1, -BEVEL_DEPTH);
      const b0 = at(p0, -BEVEL_DEPTH - WALL);
      const b1 = at(p1, -BEVEL_DEPTH - WALL);
      trim.tri(f0, f1, o1, bevelWant);
      trim.tri(f0, o1, o0, bevelWant);
      walls.tri(o0, o1, b1, out);
      walls.tri(o0, b1, b0, out);
    }
  }
  // The back.
  const faces = ShapeUtils.triangulateShape(
    OUTLINE.map(([x, y]) => new Vector2(x, y)),
    [],
  );
  for (const f of faces) {
    const [a, b, c] = f.map((k) => at(OUTLINE[k]!, -BEVEL_DEPTH - WALL)) as [Vector3, Vector3, Vector3];
    walls.tri(a, b, c, new Vector3(0, 0, -1));
  }

  // Eyes: a blade of light along each slit of the frames, pointed at both ends.
  const eyePos: number[] = [];
  const eyeGlow: number[] = [];
  const eyeAt: Built['eyeAt'] = [];
  const steps = 18;
  for (const side of [0, 1]) {
    const m = (p: Pt) => (side ? mirror(p) : p);
    const o: Pt = m([EYE.outer[0] + (EYE.inner[0] - EYE.outer[0]) * 0.02, EYE.outer[1] + (EYE.inner[1] - EYE.outer[1]) * 0.02]);
    const e: Pt = m([EYE.outer[0] + (EYE.inner[0] - EYE.outer[0]) * 0.98, EYE.outer[1] + (EYE.inner[1] - EYE.outer[1]) * 0.98]);
    const dir = new Vector2(e[0] - o[0], e[1] - o[1]);
    const len = dir.length();
    dir.normalize();
    const nrm = new Vector2(-dir.y, dir.x);
    // Half-height of the blade: fullest a third of the way in, a point at each end.
    const half = (u: number) => 0.0155 * Math.pow(Math.sin(Math.PI * Math.min(1, u)), 0.7) * (1 - 0.3 * u);
    // Rows across the blade: dark rim, glow, core, glow, dark rim.
    const across = [-1.9, -0.55, 0, 0.55, 1.9];
    const level = [0, 0.4, 1, 0.4, 0];
    const pt = (u: number, r: number): Vector3 => {
      const cx = o[0] + dir.x * len * u + nrm.x * half(u) * r;
      const cy = o[1] + dir.y * len * u + nrm.y * half(u) * r;
      return toV([cx, cy], surface(cx, cy) + 0.004);
    };
    const along = (u: number) => 0.6 + 0.4 * Math.sin(Math.PI * Math.min(1, u * 1.2));
    for (let k = 0; k < steps; k++) {
      const u0 = k / steps;
      const u1 = (k + 1) / steps;
      for (let r = 0; r < across.length - 1; r++) {
        const q = [pt(u0, across[r]!), pt(u1, across[r]!), pt(u1, across[r + 1]!), pt(u0, across[r + 1]!)];
        const g = [level[r]! * along(u0), level[r]! * along(u1), level[r + 1]! * along(u1), level[r + 1]! * along(u0)];
        const nz = new Vector3().subVectors(q[1]!, q[0]!).cross(new Vector3().subVectors(q[2]!, q[0]!)).z;
        for (const i of nz >= 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]) {
          eyePos.push(q[i]!.x, q[i]!.y, q[i]!.z);
          eyeGlow.push(g[i]!);
        }
      }
    }
    const a = toV(o, 0);
    const b = toV(e, 0);
    eyeAt.push({ pos: pt(0.42, 0), angle: Math.atan2(b.y - a.y, b.x - a.x) + (side ? Math.PI : 0), length: a.distanceTo(b) });
  }
  const eyes = new BufferGeometry();
  eyes.setAttribute('position', new BufferAttribute(new Float32Array(eyePos), 3));
  eyes.setAttribute('glow', new BufferAttribute(new Float32Array(eyeGlow), 1));

  cached = { front: front.geometry(), trim: trim.geometry(), walls: walls.geometry(), eyes, eyeAt };
  return cached;
}

/** Thin ribbons lying on the relief. Polylines in frame units, width in mask heights. */
function ribbons(lines: readonly (readonly Pt[])[], width: number, lift: number): BufferGeometry {
  const out = new Soup();
  const toward = new Vector3(0, 0, 1);
  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i++) {
      const a = new Vector2(...line[i]!);
      const b = new Vector2(...line[i + 1]!);
      const d = b.clone().sub(a).normalize();
      const w = width / 2;
      const l0 = new Vector2(a.x - d.y * w, a.y + d.x * w);
      const l1 = new Vector2(b.x - d.y * w, b.y + d.x * w);
      const r1 = new Vector2(b.x + d.y * w, b.y - d.x * w);
      const r0 = new Vector2(a.x + d.y * w, a.y - d.x * w);
      // In a few steps, so the ribbon follows the relief and never sinks into a facet.
      const steps = Math.max(2, Math.ceil(a.distanceTo(b) / 0.01));
      const on = (p: Vector2) => toV([p.x, p.y], surface(p.x, p.y) + lift);
      for (let k = 0; k < steps; k++) {
        const t0 = k / steps;
        const t1 = (k + 1) / steps;
        const q0 = on(l0.clone().lerp(l1, t0));
        const q1 = on(l0.clone().lerp(l1, t1));
        const q2 = on(r0.clone().lerp(r1, t1));
        const q3 = on(r0.clone().lerp(r1, t0));
        out.tri(q0, q1, q2, toward);
        out.tri(q0, q2, q3, toward);
      }
    }
  }
  return out.geometry();
}

const both = (lines: readonly (readonly Pt[])[]) => lines.flatMap((l) => [l, l.map(mirror)]);

/** Creases that carry a seam of light on a forged mask: the ridge, the brow, the cheek. */
const CREASES: readonly (readonly Pt[])[] = [
  [
    [0, 0.2],
    [0, 0.42],
  ],
  [
    [0, 0.56],
    [0, 0.864],
  ],
  ...both([
    [
      [-0.2, 0.06],
      [-0.135, 0.27],
      [-0.1, 0.4],
    ],
    [
      [-0.15, 0.86],
      [-0.125, 0.7],
      [-0.095, 0.55],
    ],
  ]),
];

/** Hairline cracks: from the brow and the cheek, never across the eyes. */
const CRACKS: readonly (readonly Pt[])[] = [
  [
    [-0.13, 0.1],
    [-0.115, 0.17],
    [-0.13, 0.23],
    [-0.1, 0.3],
    [-0.11, 0.36],
  ],
  [
    [-0.115, 0.17],
    [-0.07, 0.2],
    [-0.05, 0.26],
  ],
  [
    [0.155, 0.08],
    [0.14, 0.16],
    [0.16, 0.22],
    [0.13, 0.31],
  ],
  [
    [-0.2, 0.6],
    [-0.16, 0.65],
    [-0.17, 0.73],
    [-0.13, 0.8],
  ],
  [
    [0.21, 0.58],
    [0.19, 0.66],
    [0.2, 0.74],
  ],
];

export interface MaskRig {
  group: Group;
  /** The mask's own light level, 0..1+: the dark before the entrance, the dim of the losers. */
  presence: { value: number };
  /** Eye light, 1 = normal. */
  eyes: { value: number };
  look: MaskLook;
  /** It wears its frame. */
  framed: boolean;
  dispose(): void;
}

/**
 * The facet a point of the front lies on, worked out per pixel from the same planes as the relief: the creases stay
 * straight and crisp at any size, wherever the triangles of the front happen to run. The point itself is lifted from
 * the triangle onto the facet too, so a highlight's edge never steps along the triangles that cross a crease.
 */
const FACETS = /* glsl */ `
  varying vec3 vMaskPos;
  varying vec3 vNm0;
  varying vec3 vNm1;
  varying vec3 vNm2;
  varying vec3 vZv;
  float facetZ;
  vec3 facetNormal() {
    // About one pixel of the mask: the width a crease is smoothed over, so it never shows the pixel stairs.
    float px = max(1e-4, 0.8 * max(fwidth(vMaskPos.x), fwidth(vMaskPos.y)));
    float s = vMaskPos.x < 0.0 ? -1.0 : 1.0;
    float a = abs(vMaskPos.x);
    float y = 0.5 - vMaskPos.y;
    float z[${PLANES.length}];
    vec3 n[${PLANES.length}];
    ${PLANES.map(([c, ka, kb], i) => `z[${i}] = ${c.toFixed(4)} + ${ka.toFixed(4)} * a + ${kb.toFixed(4)} * y; n[${i}] = normalize(vec3(${(-ka).toFixed(4)} * s, ${kb.toFixed(4)}, 1.0));`).join('\n    ')}
    float best = z[0];
    for (int i = 1; i < ${PLANES.length}; i++) best = min(best, z[i]);
    vec3 sum = vec3(0.0);
    for (int i = 0; i < ${PLANES.length}; i++) sum += n[i] * exp(-(z[i] - best) / px);
    facetZ = best;
    return normalize(mat3(vNm0, vNm1, vNm2) * normalize(sum));
  }`;

/** Three's lighting setup with the view position taken on the facet rather than on the triangle. */
const LIGHTS_ON_FACETS = ShaderChunk.lights_fragment_begin.replace(
  'vec3 geometryPosition = - vViewPosition;',
  'vec3 facetView = vViewPosition - vZv * ( facetZ - vMaskPos.z );\nvec3 geometryPosition = - facetView;',
).replace('normalize( vViewPosition )', 'normalize( facetView )');

/** The mask's light level on a material; `facets`: its normals come from the relief's planes (the front only). */
function withPresence<T extends Material>(m: T, presence: { value: number }, facets = false): T {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uPresence = presence;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uPresence;${facets ? FACETS : ''}`)
      .replace('#include <opaque_fragment>', 'outgoingLight *= uPresence;\n#include <opaque_fragment>');
    if (facets) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = facetNormal();\nnonPerturbedNormal = normal;')
        .replace('#include <lights_fragment_begin>', LIGHTS_ON_FACETS);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vMaskPos;\nvarying vec3 vNm0;\nvarying vec3 vNm1;\nvarying vec3 vNm2;\nvarying vec3 vZv;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvMaskPos = position;\nvNm0 = normalMatrix[0];\nvNm1 = normalMatrix[1];\nvNm2 = normalMatrix[2];\nvZv = ( modelViewMatrix * vec4( 0.0, 0.0, 1.0, 0.0 ) ).xyz;',
        );
    }
  };
  m.customProgramCacheKey = () => (facets ? 'presence-facets' : 'presence');
  return m;
}

const FINISH = {
  matte: { roughness: 0.55, metalness: 0.2, clearcoat: 0, clearcoatRoughness: 0.4 },
  gloss: { roughness: 0.22, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.1 },
  lacquer: { roughness: 0.14, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.04 },
  satin: { roughness: 0.36, metalness: 0.4, clearcoat: 0.3, clearcoatRoughness: 0.3 },
  porcelain: { roughness: 0.32, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.15 },
} as const;

function shellMaterial(look: MaskLook, tier: Tier, presence: { value: number }, facets = false) {
  const f = FINISH[look.finish];
  // The arena's key is a wide softbox: on a glossy brow it reads as a white sheet, so the shell takes half of it.
  // A flat facet magnifies its reflection: below ~0.25 roughness the edges of the softboxes show the env map's texels.
  const base = { color: new Color(look.shell), flatShading: true, roughness: Math.max(0.3, f.roughness), metalness: f.metalness, envMapIntensity: 0.5 };
  return withPresence(
    tier === 'low'
      ? new MeshStandardMaterial(base)
      : new MeshPhysicalMaterial({ ...base, clearcoat: f.clearcoat, clearcoatRoughness: Math.max(0.34, f.clearcoatRoughness) }),
    presence,
    facets,
  );
}

/**
 * The frame on the front: the picture is the light (emissive, as the frame was lit), with a thin coat over it that
 * still answers the arena's own lights and reflections, so the face moves with the camera and the corners.
 */
function artMaterial(art: Texture, look: MaskLook, tier: Tier, presence: { value: number }, facets = false) {
  const base = {
    color: new Color(0x000000),
    emissive: new Color(0xffffff),
    emissiveMap: art,
    emissiveIntensity: 1.18,
    roughness: 0.46,
    metalness: 0,
    envMapIntensity: 0.32,
    flatShading: true,
  };
  return withPresence(
    tier === 'low'
      ? new MeshStandardMaterial(base)
      : new MeshPhysicalMaterial({ ...base, specularIntensity: 0.35, clearcoat: look.finish === 'matte' ? 0 : 0.12, clearcoatRoughness: 0.25 }),
    presence,
    facets,
  );
}

function eyeMaterial(look: MaskLook, intensity: { value: number }) {
  return new ShaderMaterial({
    uniforms: { uColor: { value: new Color(look.eyes) }, uCore: { value: new Color(look.eyesCore) }, uI: intensity },
    vertexShader: /* glsl */ `
      attribute float glow;
      varying float vGlow;
      void main() {
        vGlow = glow;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform vec3 uCore;
      uniform float uI;
      varying float vGlow;
      void main() {
        float g = clamp(vGlow, 0.0, 1.0);
        float heat = pow(g, 2.2);
        vec3 c = mix(uColor, uCore, pow(g, 6.0) * 0.75) * (0.015 + 4.0 * heat) * uI;
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

// ---------------------------------------------------------------------------------------------- the frames

/** The masks with a frame of their own in /public/art. */
export const FRAMED = new Set(['onyx', 'nova', 'oracle', 'wraith', 'ronin', 'volt']);

const frames = new Map<string, Promise<Texture | null>>();

/**
 * A mask's frame as a texture: the mask cut out of its 1280² frame and uploaded at 512×768. Fetched once per page;
 * `null` when it cannot be read, and the mask is then built from its look.
 */
export function frameOf(id: string): Promise<Texture | null> {
  const key = id.toLowerCase();
  let p = frames.get(key);
  if (p) return p;
  p = new Promise<Texture | null>((resolve) => {
    if (!FRAMED.has(key)) return resolve(null);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = 512;
      c.height = 768;
      const g = c.getContext('2d');
      if (!g) return resolve(null);
      g.drawImage(img, CROP.x, CROP.y, CROP.w, CROP.h, 0, 0, c.width, c.height);
      const t = new CanvasTexture(c);
      t.colorSpace = SRGBColorSpace;
      t.flipY = false;
      t.anisotropy = 4;
      resolve(t);
    };
    img.onerror = () => resolve(null);
    img.src = `/art/${key}.webp`;
  });
  frames.set(key, p);
  return p;
}

/** A frame already fetched, or null. */
const ready = new Map<string, Texture | null>();
export async function loadFrames(ids: readonly string[]): Promise<void> {
  await Promise.all(ids.map(async (id) => ready.set(id.toLowerCase(), await frameOf(id))));
}

// ---------------------------------------------------------------------------------------------- the rig

/** `frame`: the id of the mask's frame when it wears one; fetch it first with `loadFrames`, else it is built from its look. */
export function createMask(look: MaskLook, tier: Tier, frame: string | null): MaskRig {
  const built = build();
  const presence = { value: 1 };
  const eyes = { value: 1 };
  const group = new Group();
  const materials: Material[] = [];
  const geos: BufferGeometry[] = [];
  const add = (g: BufferGeometry, mat: Material, own = false) => {
    group.add(new Mesh(g, mat));
    materials.push(mat);
    if (own) geos.push(g);
  };
  const art = frame ? (ready.get(frame.toLowerCase()) ?? null) : null;

  const trimMat = withPresence(new MeshStandardMaterial({ color: new Color(look.trim), metalness: look.trimMetal, roughness: 0.24, flatShading: true }), presence);
  if (art) {
    // The frame covers the front and its bevel: its own polished edges are the bevel's light.
    add(built.front, artMaterial(art, look, tier, presence, true));
    add(built.trim, artMaterial(art, look, tier, presence));
    add(built.walls, trimMat);
  } else {
    add(built.front, shellMaterial(look, tier, presence, true));
    add(built.walls, shellMaterial(look, tier, presence));
    add(built.trim, trimMat);
    add(
      ribbons(CREASES, 0.006, 0.002),
      withPresence(
        new MeshStandardMaterial({
          color: new Color(look.trim),
          metalness: look.trimMetal,
          roughness: 0.22,
          emissive: new Color(look.modifier === 'seams' ? look.trim : look.eyes),
          emissiveIntensity: look.modifier === 'seams' ? 0.35 : 0.06,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
        }),
        presence,
      ),
      true,
    );
    if (look.modifier === 'cracks') {
      add(
        ribbons(CRACKS, 0.0032, 0.0015),
        new MeshStandardMaterial({ color: new Color(look.shell), emissive: new Color(look.eyesCore), emissiveIntensity: 0.35, roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -1 }),
        true,
      );
    }
    if (look.modifier === 'stripe') {
      add(
        ribbons(
          [
            [
              [0, 0.2],
              [0, 0.42],
            ],
            [
              [0, 0.56],
              [0, 0.86],
            ],
          ],
          0.016,
          0.003,
        ),
        new MeshStandardMaterial({ color: new Color(look.shell), emissive: new Color(look.eyes), emissiveIntensity: 0.8, polygonOffset: true, polygonOffsetFactor: -2 }),
        true,
      );
    }
    if (look.modifier === 'brow') {
      add(
        ribbons(
          [
            [
              [-0.21, 0.07],
              [-0.13, 0.27],
              [0, 0.34],
              [0.13, 0.27],
              [0.21, 0.07],
            ],
          ],
          0.026,
          0.003,
        ),
        withPresence(new MeshStandardMaterial({ color: new Color(look.trim), metalness: 1, roughness: 0.3, polygonOffset: true, polygonOffsetFactor: -2 }), presence),
        true,
      );
    }
  }
  add(built.eyes, eyeMaterial(look, eyes));

  if (look.thirdEye) {
    // A small diamond of light on the ridge of the forehead, between the notch and the eyes.
    const y = 0.315;
    const pts: Pt[] = [
      [0, y - 0.032],
      [-0.017, y],
      [0, y + 0.032],
      [0.017, y],
    ];
    const v = pts.map((p) => toV(p, surface(p[0], p[1]) + 0.005));
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([v[0]!, v[1]!, v[3]!, v[1]!, v[2]!, v[3]!].flatMap((p) => [p.x, p.y, p.z])), 3));
    g.setAttribute('glow', new BufferAttribute(new Float32Array([0.5, 0.3, 0.3, 0.3, 0.5, 0.3]), 1));
    add(g, eyeMaterial(look, eyes), true);
  }

  const halos: Sprite[] = [];
  for (const e of built.eyeAt) {
    const s = glowSprite(look.eyes, 0.5);
    s.position.copy(e.pos).setZ(e.pos.z + 0.05);
    s.scale.set(e.length * 1.25, e.length * 0.32, 1);
    s.material.rotation = e.angle;
    group.add(s);
    halos.push(s);
    materials.push(s.material);
  }
  group.userData.halos = halos;

  return {
    group,
    presence,
    eyes,
    look,
    framed: art !== null,
    dispose() {
      for (const m of new Set(materials)) m.dispose();
      for (const g of geos) g.dispose();
    },
  };
}

/** Halo opacity follows the eyes; called by the engine each frame. */
export function syncHalos(rig: MaskRig) {
  const halos = rig.group.userData.halos as Sprite[];
  const o = Math.min(0.85, 0.32 * rig.eyes.value);
  for (const s of halos) s.material.opacity = o;
}
