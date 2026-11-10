// The vault: the one object. A titanium ring, a stone door split by the seam of The Split, twelve bolts that
// lock it into the ring, hairline cracks that run from the seam when it breaks, and a light inside that floods
// out when the halves part.

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedMesh,
  BoxGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Quaternion,
  RepeatWrapping,
  ShaderMaterial,
  ShapeUtils,
  SRGBColorSpace,
  Vector2,
  Vector3,
  type Material,
  type Sprite,
  type Texture,
} from 'three';
import { color } from '@maskwars/brand';
import { DOOR_R } from '../layout';
import { glowSprite } from './fx';
import type { Tier } from './tier';

type Profile = ReadonlyArray<readonly [number, number]>; // (radius, z)

/**
 * Revolve a profile around the z axis between two angles. Every profile segment gets its own vertices, so steps
 * stay crisp; planar UVs so textures lie flat on the face.
 */
function revolve(profile: Profile, segments: number, phi0: number, phi1: number): BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  for (let k = 0; k < profile.length - 1; k++) {
    const [r0, z0] = profile[k]!;
    const [r1, z1] = profile[k + 1]!;
    const dr = r1 - r0;
    const dz = z1 - z0;
    const len = Math.hypot(dr, dz) || 1;
    const nr = -dz / len;
    const nz = dr / len;
    const ring = (r: number, z: number, phi: number) => {
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      return { p: [r * c, r * s, z], n: [nr * c, nr * s, nz], t: [r * c * 0.5 + 0.5, r * s * 0.5 + 0.5] };
    };
    for (let j = 0; j < segments; j++) {
      const a0 = phi0 + ((phi1 - phi0) * j) / segments;
      const a1 = phi0 + ((phi1 - phi0) * (j + 1)) / segments;
      const v00 = ring(r0, z0, a0);
      const v01 = ring(r0, z0, a1);
      const v10 = ring(r1, z1, a0);
      const v11 = ring(r1, z1, a1);
      const quad = [v00, v10, v11, v00, v11, v01];
      // Wind so the geometric normal agrees with the profile normal.
      const e1 = new Vector3(...(v10.p as [number, number, number])).sub(new Vector3(...(v00.p as [number, number, number])));
      const e2 = new Vector3(...(v11.p as [number, number, number])).sub(new Vector3(...(v00.p as [number, number, number])));
      const g = e1.cross(e2);
      const want = new Vector3(...(v00.n as [number, number, number])).add(new Vector3(...(v11.n as [number, number, number])));
      const order = g.dot(want) >= 0 || g.lengthSq() === 0 ? quad : [v00, v11, v10, v00, v01, v11];
      for (const v of order) {
        pos.push(...v.p);
        nrm.push(...v.n);
        uv.push(...v.t);
      }
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  geo.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  return geo;
}

// Ring cross-section: inner back → inner front → front steps → outer front → outer back → back.
const RING: Profile = [
  [0.84, -0.12],
  [0.84, 0.03],
  [0.865, 0.06],
  [0.905, 0.06],
  [0.912, 0.082],
  [0.968, 0.082],
  [1.0, 0.05],
  [1.0, -0.2],
  [0.96, -0.24],
  [0.84, -0.12],
];

// Door face: centre out, two shallow steps, the rim, then the back.
const DOOR: Profile = [
  [0.0, 0.0],
  [0.27, 0.0],
  [0.272, 0.014],
  [0.52, 0.014],
  [0.523, 0.028],
  [0.79, 0.028],
  [0.81, 0.012],
  [DOOR_R, 0.0],
  [DOOR_R, -0.1],
  [0.0, -0.1],
];

/** Height of the door's front face at radius r. */
function doorZ(r: number): number {
  for (let k = 0; k < 7; k++) {
    const [r0, z0] = DOOR[k]!;
    const [r1, z1] = DOOR[k + 1]!;
    if (r >= r0 && r <= r1) return r1 === r0 ? Math.max(z0, z1) : z0 + ((z1 - z0) * (r - r0)) / (r1 - r0);
  }
  return 0;
}

/** The flat face where a half meets the other, at x = 0. */
function seamCap(side: 1 | -1): BufferGeometry {
  const front = DOOR.slice(0, 8);
  const pts: Vector2[] = [];
  // In (y, z): bottom back → bottom front (rim to centre) → top front (centre to rim) → top back.
  pts.push(new Vector2(-DOOR_R, -0.1));
  for (let k = front.length - 1; k >= 0; k--) pts.push(new Vector2(-front[k]![0], front[k]![1]));
  for (let k = 1; k < front.length; k++) pts.push(new Vector2(front[k]![0], front[k]![1]));
  pts.push(new Vector2(DOOR_R, -0.1));
  const clean = pts.filter((p, i) => i === 0 || p.distanceTo(pts[i - 1]!) > 1e-6);
  const faces = ShapeUtils.triangulateShape(clean, []);
  const pos: number[] = [];
  for (const f of faces) {
    const tri = [clean[f[0]!]!, clean[f[1]!]!, clean[f[2]!]!];
    const n = new Vector3(0, tri[1]!.x - tri[0]!.x, tri[1]!.y - tri[0]!.y).cross(new Vector3(0, tri[2]!.x - tri[0]!.x, tri[2]!.y - tri[0]!.y));
    // The cap of the right half faces −x, of the left +x.
    const order = n.x * -side >= 0 ? tri : [tri[0]!, tri[2]!, tri[1]!];
    for (const p of order) pos.push(0, p.x, p.y);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  geo.computeVertexNormals();
  return geo;
}

/** Faint veins in black stone, drawn once. */
function stoneTexture(): Texture {
  const n = 512;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d')!;
  g.fillStyle = '#7a7a7a';
  g.fillRect(0, 0, n, n);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 26; i++) {
    let x = rnd() * n;
    let y = rnd() * n;
    let a = rnd() * Math.PI * 2;
    g.strokeStyle = `rgba(255,255,255,${0.08 + rnd() * 0.16})`;
    g.lineWidth = 0.6 + rnd() * 0.9;
    g.beginPath();
    g.moveTo(x, y);
    const steps = 20 + Math.floor(rnd() * 40);
    for (let s = 0; s < steps; s++) {
      a += (rnd() - 0.5) * 0.9;
      x += Math.cos(a) * 6;
      y += Math.sin(a) * 6;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** Cracks from the seam outwards, one half. A `reveal` uniform draws them from the seam to their tips. */
function cracks(side: 1 | -1): BufferGeometry {
  let seed = side > 0 ? 11 : 29;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pos: number[] = [];
  const along: number[] = [];
  const ribbon = (pts: Vector2[], t0: number, t1: number, width: number) => {
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += pts[i]!.distanceTo(pts[i - 1]!);
    let run = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const d = b.clone().sub(a);
      const l = d.length();
      const nx = (-d.y / l) * width;
      const ny = (d.x / l) * width;
      const ta = t0 + ((t1 - t0) * run) / total;
      run += l;
      const tb = t0 + ((t1 - t0) * run) / total;
      const za = doorZ(a.length()) + 0.004;
      const zb = doorZ(b.length()) + 0.004;
      const q = [
        [a.x + nx, a.y + ny, za, ta],
        [b.x + nx, b.y + ny, zb, tb],
        [b.x - nx, b.y - ny, zb, tb],
        [a.x - nx, a.y - ny, za, ta],
      ] as const;
      for (const k of [0, 2, 1, 0, 3, 2]) {
        pos.push(q[k]![0], q[k]![1], q[k]![2]);
        along.push(q[k]![3]);
      }
    }
  };
  const starts = [-0.62, -0.34, -0.08, 0.18, 0.44, 0.66];
  for (const y0 of starts) {
    const pts: Vector2[] = [new Vector2(0.004 * side, y0 + (rnd() - 0.5) * 0.06)];
    let a = (rnd() - 0.5) * 1.2;
    while (pts.length < 14) {
      const last = pts[pts.length - 1]!;
      a += (rnd() - 0.5) * 0.9;
      const step = 0.05 + rnd() * 0.05;
      const next = new Vector2(last.x + Math.cos(a) * step * side, last.y + Math.sin(a) * step);
      if (next.length() > 0.8 || Math.abs(next.x) < 0.004) break;
      pts.push(next);
    }
    if (pts.length < 3) continue;
    ribbon(pts, 0, 1, 0.0026);
    // One branch from the middle.
    const mid = pts[Math.floor(pts.length / 2)]!;
    const br: Vector2[] = [mid.clone()];
    let b = a + (rnd() > 0.5 ? 0.9 : -0.9);
    for (let i = 0; i < 5; i++) {
      const last = br[br.length - 1]!;
      b += (rnd() - 0.5) * 0.8;
      const next = new Vector2(last.x + Math.cos(b) * 0.05 * side, last.y + Math.sin(b) * 0.05);
      if (next.length() > 0.8) break;
      br.push(next);
    }
    if (br.length > 1) ribbon(br, 0.5, 1, 0.0018);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('along', new BufferAttribute(new Float32Array(along), 1));
  return geo;
}

function crackMaterial(reveal: { value: number }, heat: { value: number }) {
  return new ShaderMaterial({
    uniforms: { uReveal: reveal, uHeat: heat, uColor: { value: new Color(color.amber) }, uCore: { value: new Color(color.ice) } },
    vertexShader: /* glsl */ `
      attribute float along;
      varying float vAlong;
      void main() {
        vAlong = along;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uReveal;
      uniform float uHeat;
      uniform vec3 uColor;
      uniform vec3 uCore;
      varying float vAlong;
      void main() {
        if (vAlong > uReveal) discard;
        float front = smoothstep(uReveal - 0.12, uReveal, vAlong);
        vec3 c = mix(uColor, uCore, front * 0.6) * (0.7 + 2.4 * front) * uHeat;
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: DoubleSide,
  });
}

export interface VaultRig {
  group: Group;
  /** The two hinges, at x = ∓DOOR_R; each carries its half of the door. */
  halves: [Group, Group];
  /** Seam light: colour and level. */
  seam: { color: Color; level: { value: number } };
  /** 0 locked into the ring, 1 drawn back. */
  bolts: { value: number };
  cracks: { reveal: { value: number }; heat: { value: number } };
  /** Light inside the vault, seen when the halves part. */
  core: { value: number };
  /** Ring brightness multiplier for flashes. */
  ringFlash: { value: number };
  /** How much light the door's stone takes, 1 closed, less when swung open. */
  doorLight: { value: number };
  update(): void;
  dispose(): void;
}

const BOLTS = 6;

export function createVault(tier: Tier): VaultRig {
  const group = new Group();
  const materials: Material[] = [];
  const geos: BufferGeometry[] = [];
  const own = <T extends Material>(m: T) => (materials.push(m), m);
  const geo = <T extends BufferGeometry>(g: T) => (geos.push(g), g);

  const ringFlash = { value: 0 };
  const ringMat = own(
    tier === 'low'
      ? new MeshStandardMaterial({ color: new Color('#a3a8b3'), metalness: 1, roughness: 0.3 })
      : new MeshPhysicalMaterial({ color: new Color('#a3a8b3'), metalness: 1, roughness: 0.28, clearcoat: 0.4, clearcoatRoughness: 0.2 }),
  );
  ringMat.emissive = new Color(color.ice);
  ringMat.emissiveIntensity = 0;
  const ring = new Mesh(geo(revolve(RING, 160, 0, Math.PI * 2)), ringMat);
  group.add(ring);

  const stone = stoneTexture();
  const doorMat = own(
    tier === 'low'
      ? new MeshStandardMaterial({ color: new Color('#16141d'), map: stone, roughness: 0.58, metalness: 0.05 })
      : new MeshPhysicalMaterial({ color: new Color('#16141d'), map: stone, roughness: 0.56, metalness: 0.05, clearcoat: 0.22, clearcoatRoughness: 0.4 }),
  );
  // Swung open, the stone faces the corner lights head-on. The corner may colour an edge, never the material
  // (BRANDBOOK §3): the open doors take a fraction of the light.
  const doorLight = { value: 1 };
  doorMat.onBeforeCompile = (shader) => {
    shader.uniforms.uDoor = doorLight;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uDoor;')
      .replace('#include <opaque_fragment>', 'outgoingLight *= uDoor;\n#include <opaque_fragment>');
  };
  doorMat.customProgramCacheKey = () => 'door';
  const capMat = own(new MeshStandardMaterial({ color: new Color('#0d0c12'), roughness: 0.6, metalness: 0.2 }));
  const boltMat = own(new MeshStandardMaterial({ color: new Color('#9aa0ab'), metalness: 1, roughness: 0.3 }));

  const bolts = { value: 0 };
  const reveal = { value: 0 };
  const heat = { value: 1 };
  const crackMat = own(crackMaterial(reveal, heat));
  const boltGeo = geo(new BoxGeometry(0.075, 0.032, 0.03));

  // Each half hangs on a hinge at its outer edge, like the doors of a real vault: it swings toward the camera
  // and never leaves the ring, on any screen.
  const halves: [Group, Group] = [new Group(), new Group()];
  const boltMeshes: InstancedMesh[] = [];
  for (const [i, side] of [
    [0, -1],
    [1, 1],
  ] as const) {
    const hinge = halves[i];
    hinge.position.x = side * DOOR_R;
    const h = new Group();
    h.position.x = -side * DOOR_R;
    hinge.add(h);
    const phi0 = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    h.add(new Mesh(geo(revolve(DOOR, 80, phi0, phi0 + Math.PI)), doorMat));
    h.add(new Mesh(geo(seamCap(side)), capMat));
    h.add(new Mesh(geo(cracks(side)), crackMat));
    const im = new InstancedMesh(boltGeo, boltMat, BOLTS);
    h.add(im);
    boltMeshes.push(im);
    group.add(hinge);
  }

  // The seam: a hairline of light down the middle, and its soft glow.
  const seamColor = new Color(color.ice);
  const seamLevel = { value: 0.5 };
  const seamMat = own(new MeshBasicMaterial({ color: seamColor.clone() }));
  const seamGeo = new BufferGeometry();
  {
    const pts: number[] = [];
    const ys: number[] = [];
    for (let k = 7; k >= 0; k--) ys.push(-DOOR[k]![0]);
    for (let k = 1; k <= 7; k++) ys.push(DOOR[k]![0]);
    const w = 0.0035;
    for (let i = 0; i < ys.length - 1; i++) {
      const y0 = ys[i]!;
      const y1 = ys[i + 1]!;
      const z0 = doorZ(Math.abs(y0)) + 0.002;
      const z1 = doorZ(Math.abs(y1)) + 0.002;
      pts.push(-w, y0, z0, w, y0, z0, w, y1, z1, -w, y0, z0, w, y1, z1, -w, y1, z1);
    }
    seamGeo.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
  }
  const seamMesh = new Mesh(geo(seamGeo), seamMat);
  group.add(seamMesh);
  const seamGlow: Sprite = glowSprite(color.ice, 0.6);
  seamGlow.scale.set(0.16, 1.9, 1);
  seamGlow.position.set(0, 0, 0.06);
  group.add(seamGlow);
  materials.push(seamGlow.material);

  // The light inside: a disc behind the door and a soft bloom in front of it.
  const core = { value: 0 };
  // The inside: a deep cavity, dark at the rim, warm at its heart. Never a flat white disc.
  const coreLevel = { value: 0 };
  const coreMat = own(
    new ShaderMaterial({
      uniforms: { uColor: { value: new Color(color.amber) }, uDeep: { value: new Color(color.ink) }, uLevel: coreLevel },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform vec3 uDeep;
        uniform float uLevel;
        varying vec2 vUv;
        void main() {
          float r = length(vUv - 0.5) * 2.0;
          float heart = exp(-r * r * 4.5);
          float glow = exp(-r * r * 1.4);
          vec3 c = uDeep * 0.5 + uColor * uLevel * (heart * 0.55 + glow * 0.12);
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }),
  );
  const coreDisc = new Mesh(geo(new CircleGeometry(DOOR_R * 0.99, 96)), coreMat);
  coreDisc.position.z = -0.09;
  group.add(coreDisc);
  const coreGlow = glowSprite(color.amber, 0);
  coreGlow.scale.set(1.5, 1.5, 1);
  coreGlow.position.set(0, 0, 0.05);
  group.add(coreGlow);
  materials.push(coreGlow.material);

  const m = new Matrix4();
  const q = new Quaternion();
  const s = new Vector3(1, 1, 1);
  const p = new Vector3();
  const zAxis = new Vector3(0, 0, 1);

  const placeBolts = () => {
    const r = 0.795 - bolts.value * 0.075;
    for (const [i, side] of [
      [0, -1],
      [1, 1],
    ] as const) {
      const im = boltMeshes[i]!;
      for (let b = 0; b < BOLTS; b++) {
        // Spread over the half, away from the seam.
        const a = (side > 0 ? -Math.PI / 2 : Math.PI / 2) + ((b + 0.5) / BOLTS) * Math.PI;
        p.set(Math.cos(a) * r, Math.sin(a) * r, 0.043);
        q.setFromAxisAngle(zAxis, a);
        m.compose(p, q, s);
        im.setMatrixAt(b, m);
      }
      im.instanceMatrix.needsUpdate = true;
    }
  };
  placeBolts();

  let lastBolts = -1;
  return {
    group,
    halves,
    seam: { color: seamColor, level: seamLevel },
    bolts,
    cracks: { reveal, heat },
    core,
    ringFlash,
    doorLight,
    update() {
      if (bolts.value !== lastBolts) {
        placeBolts();
        lastBolts = bolts.value;
      }
      seamMat.color.copy(seamColor).multiplyScalar(0.4 + seamLevel.value * 5);
      seamMesh.visible = seamLevel.value > 0.001;
      seamGlow.material.color.copy(seamColor);
      seamGlow.material.opacity = Math.min(1, seamLevel.value * 0.9);
      seamGlow.visible = seamLevel.value > 0.001;
      coreLevel.value = core.value;
      coreGlow.material.opacity = Math.min(1, core.value * 0.38);
      coreGlow.visible = core.value > 0.001;
      ringMat.emissiveIntensity = ringFlash.value * 0.22;
    },
    dispose() {
      for (const mat of materials) mat.dispose();
      for (const g of geos) g.dispose();
      stone.dispose();
      for (const im of boltMeshes) im.dispose();
    },
  };
}

