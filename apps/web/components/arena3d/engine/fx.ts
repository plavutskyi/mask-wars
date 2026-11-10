// Light that is not a lamp: soft glows for eyes and the seam, the payout comet, rings. Additive, no particle rain.

import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  DoubleSide,
  Mesh,
  RingGeometry,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  type Texture,
} from 'three';

let glow: Texture | null = null;

/** One shared radial falloff: bright core, long soft tail. Made once per page, a few kilobytes. */
export function glowTexture(): Texture {
  if (glow) return glow;
  const n = 128;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d')!;
  const img = g.createImageData(n, n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (x + 0.5) / n - 0.5;
      const dy = (y + 0.5) / n - 0.5;
      const r = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 2);
      const a = Math.pow(1 - r, 2.4) * 0.85 + Math.exp(-r * r * 40) * 0.6;
      const v = Math.round(255 * Math.min(1, a));
      const i = (y * n + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = v;
    }
  }
  g.putImageData(img, 0, 0);
  glow = new CanvasTexture(c);
  glow.colorSpace = SRGBColorSpace;
  return glow;
}

export function glowSprite(hex: string, opacity = 1): Sprite {
  const m = new SpriteMaterial({
    map: glowTexture(),
    color: new Color(hex),
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
    opacity,
  });
  const s = new Sprite(m);
  s.renderOrder = 10;
  return s;
}

/** A thin ring that expands and fades: the bell from the seam, the landing of a payout. */
export function ringMesh(hex: string): Mesh<RingGeometry, ShaderMaterial> {
  const geo = new RingGeometry(0.985, 1, 160, 1);
  const mat = new ShaderMaterial({
    uniforms: { uColor: { value: new Color(hex) }, uAlpha: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uAlpha;
      void main() {
        gl_FragColor = vec4(uColor * uAlpha, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });
  const m = new Mesh(geo, mat);
  m.visible = false;
  m.renderOrder = 11;
  return m;
}
