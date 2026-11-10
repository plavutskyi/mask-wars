// The wet floor. A mirror pass from below the plane (an oblique-clipped camera, as three's Reflector does), read back
// with long vertical streaks and patches of wet and less wet, then lost in the dark with distance.
// The simplified tier skips the mirror pass: a dark floor with a pool of light under the vault.

import {
  CanvasTexture,
  Color,
  HalfFloatType,
  LinearFilter,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  RepeatWrapping,
  ShaderMaterial,
  UnsignedByteType,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type Camera,
  type Scene,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { color } from '@maskwars/brand';

function noiseTexture(): Texture {
  const n = 256;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d')!;
  const img = g.createImageData(n, n);
  // Value noise, a few octaves, tileable.
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const grid = (size: number) => Array.from({ length: size * size }, rnd);
  const octaves = [8, 16, 32, 64].map((s) => ({ s, g: grid(s) }));
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let v = 0;
      let amp = 0.55;
      for (const { s, g: gr } of octaves) {
        const fx = (x / n) * s;
        const fy = (y / n) * s;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = fx - x0;
        const ty = fy - y0;
        const at = (i: number, j: number) => gr[((j % s) + s) % s * s + (((i % s) + s) % s)]!;
        const sx = tx * tx * (3 - 2 * tx);
        const sy = ty * ty * (3 - 2 * ty);
        const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
        const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
        v += (a + (b - a) * sy) * amp;
        amp *= 0.5;
      }
      const k = Math.round(Math.min(1, v) * 255);
      const i = (y * n + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = k;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  return t;
}

const vertex = /* glsl */ `
  uniform mat4 textureMatrix;
  varying vec4 vMirror;
  varying vec3 vWorld;
  void main() {
    vMirror = textureMatrix * vec4(position, 1.0);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;

const fragment = /* glsl */ `
  uniform sampler2D tMirror;
  uniform sampler2D tNoise;
  uniform vec3 uBase;
  uniform vec3 uPool;
  uniform vec3 uPoolAt;
  uniform float uPool2;
  uniform float uStrength;
  uniform float uStreak;
  uniform vec3 uCam;
  uniform float uFar;
  uniform vec3 uInk;
  varying vec4 vMirror;
  varying vec3 vWorld;
  void main() {
    float n = texture2D(tNoise, vWorld.xz * 0.11).r;
    float n2 = texture2D(tNoise, vWorld.xz * 0.43 + 0.37).r;
    float wet = smoothstep(0.32, 0.72, n);
    vec3 refl = vec3(0.0);
    float d = distance(vWorld.xz, uCam.xz);
    #if TAPS > 0
      vec2 uv = vMirror.xy / vMirror.w;
      float len = uStreak * mix(1.5, 0.7, wet) * (0.8 + 0.4 * n2);
      // Jitter the taps per pixel: the streak turns into a fine grain instead of stepped copies.
      float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
      float ws = 0.0;
      for (int i = 0; i < TAPS; i++) {
        float t = (float(i) + jitter) / float(TAPS - 1) * 2.0 - 1.0;
        float w = 1.0 - 0.7 * abs(t);
        vec2 o = vec2(t * len * 0.05, t * len);
        refl += texture2D(tMirror, uv + o).rgb * w;
        ws += w;
      }
      refl /= ws;
      // A hot highlight seen from below is a glint in a puddle, not a white block: compress it, keep its hue.
      refl = refl / (1.0 + refl);
      // Fresnel: the floor near the feet barely mirrors, toward the horizon it turns to glass.
      float cosv = clamp((uCam.y - vWorld.y) / max(1e-3, distance(uCam, vWorld)), 0.0, 1.0);
      refl *= 0.18 + 0.82 * pow(1.0 - cosv, 4.0);
    #endif
    float fade = 1.0 - smoothstep(uFar * 0.35, uFar, d);
    // Pool of light under the vault: the floor answers the vault even where no mirror pass runs.
    float pd = distance(vWorld.xz, uPoolAt.xz);
    float pool = exp(-pd * pd * 0.22) * uPool2;
    vec3 col = uBase * (0.6 + 0.6 * n2) + refl * uStrength * mix(0.45, 1.0, wet) + uPool * pool * 0.16 * mix(0.55, 1.0, wet);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    // Lost in the dark: fade to the very colour of the background, after tone mapping, so no seam shows.
    gl_FragColor.rgb = mix(uInk, gl_FragColor.rgb, fade);
  }`;

export interface Floor {
  mesh: Mesh;
  /** Pool of light under the vault: colour and level. */
  pool: { color: Color; level: { value: number } };
  setSize(w: number, h: number): void;
  dispose(): void;
}

/** `scale` is the mirror resolution against the drawing buffer; 0 draws no mirror. */
/** `onMirror` brackets the mirror pass, so the scene can dim what a wet floor would not show. */
export function createFloor(renderer: WebGLRenderer, scale: number, taps: number, poolAt: Vector3, onMirror?: (on: boolean) => void): Floor {
  const geo = new PlaneGeometry(90, 90);
  const noise = noiseTexture();
  const mirror = scale > 0;
  const halfFloat = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
  const target = mirror
    ? new WebGLRenderTarget(4, 4, { type: halfFloat ? HalfFloatType : UnsignedByteType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: true })
    : null;
  const textureMatrix = new Matrix4();
  const poolColor = new Color(color.ice);
  const poolLevel = { value: 0 };
  const mat = new ShaderMaterial({
    defines: { TAPS: mirror ? taps : 0 },
    uniforms: {
      tMirror: { value: target ? target.texture : null },
      tNoise: { value: noise },
      textureMatrix: { value: textureMatrix },
      uBase: { value: new Color(color.ink).multiplyScalar(0.9) },
      uPool: { value: new Color() },
      uPoolAt: { value: poolAt.clone() },
      uPool2: poolLevel,
      uStrength: { value: 1.4 },
      uStreak: { value: 0.024 },
      uCam: { value: new Vector3() },
      uFar: { value: 26 },
      // The background is not tone mapped: compare in output space.
      uInk: { value: new Color(color.ink).convertLinearToSRGB() },
    },
    vertexShader: vertex,
    fragmentShader: fragment,
  });
  const mesh = new Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = -1;

  // Mirror camera, following three's Reflector: reflect the camera in the plane, clip everything under it.
  const mirrorCam = new PerspectiveCamera();
  const plane = new Plane();
  const normal = new Vector3();
  const reflectorPos = new Vector3();
  const camPos = new Vector3();
  const rotation = new Matrix4();
  const lookAt = new Vector3();
  const view = new Vector3();
  const tgt = new Vector3();
  const clip = new Vector4();
  const q = new Vector4();

  mesh.onBeforeRender = (r: WebGLRenderer, scene: Scene, camera: Camera) => {
    const cam = camera as PerspectiveCamera;
    mat.uniforms.uCam!.value.setFromMatrixPosition(cam.matrixWorld);
    mat.uniforms.uPool!.value.copy(poolColor);
    if (!target) return;
    reflectorPos.setFromMatrixPosition(mesh.matrixWorld);
    camPos.setFromMatrixPosition(cam.matrixWorld);
    rotation.extractRotation(mesh.matrixWorld);
    normal.set(0, 0, 1).applyMatrix4(rotation);
    view.subVectors(reflectorPos, camPos);
    if (view.dot(normal) > 0) return;
    view.reflect(normal).negate().add(reflectorPos);
    rotation.extractRotation(cam.matrixWorld);
    lookAt.set(0, 0, -1).applyMatrix4(rotation).add(camPos);
    tgt.subVectors(reflectorPos, lookAt).reflect(normal).negate().add(reflectorPos);
    mirrorCam.position.copy(view);
    mirrorCam.up.set(0, 1, 0).applyMatrix4(rotation).reflect(normal);
    mirrorCam.lookAt(tgt);
    mirrorCam.far = cam.far;
    mirrorCam.updateMatrixWorld();
    mirrorCam.projectionMatrix.copy(cam.projectionMatrix);
    textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    textureMatrix.multiply(mirrorCam.projectionMatrix).multiply(mirrorCam.matrixWorldInverse).multiply(mesh.matrixWorld);
    plane.setFromNormalAndCoplanarPoint(normal, reflectorPos).applyMatrix4(mirrorCam.matrixWorldInverse);
    clip.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const pm = mirrorCam.projectionMatrix;
    q.x = (Math.sign(clip.x) + pm.elements[8]!) / pm.elements[0]!;
    q.y = (Math.sign(clip.y) + pm.elements[9]!) / pm.elements[5]!;
    q.z = -1;
    q.w = (1 + pm.elements[10]!) / pm.elements[14]!;
    clip.multiplyScalar(2 / clip.dot(q));
    pm.elements[2] = clip.x;
    pm.elements[6] = clip.y;
    pm.elements[10] = clip.z + 1 - 0.003;
    pm.elements[14] = clip.w;
    mirrorCam.projectionMatrixInverse.copy(pm).invert();

    mesh.visible = false;
    // Seen from under the floor, glossy faces mirror the studio's key as flat white blocks. A wet floor shows
    // the eyes and the corner light, so the studio and the key dim for this pass.
    const env = scene.environmentIntensity;
    scene.environmentIntensity = env * 0.3;
    onMirror?.(true);
    const current = r.getRenderTarget();
    r.setRenderTarget(target);
    r.state.buffers.depth.setMask(true);
    if (r.autoClear === false) r.clear();
    r.render(scene, mirrorCam);
    r.setRenderTarget(current);
    scene.environmentIntensity = env;
    onMirror?.(false);
    mesh.visible = true;
  };

  return {
    mesh,
    pool: { color: poolColor, level: poolLevel },
    setSize(w, h) {
      if (target) target.setSize(Math.max(2, Math.round(w * scale)), Math.max(2, Math.round(h * scale)));
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      noise.dispose();
      target?.dispose();
    },
  };
}
