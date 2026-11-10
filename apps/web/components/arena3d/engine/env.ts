// The studio the obsidian reflects: a black room with a few long softboxes. Key from the top left (BRANDBOOK §7),
// Ember strip in the left corner, Violet in the right, a faint low strip in front. Rendered once into a PMREM map,
// so every facet catches real reflections that slide as the camera drifts.

import { BackSide, BoxGeometry, Color, Mesh, MeshBasicMaterial, PlaneGeometry, PMREMGenerator, Scene, type WebGLRenderer, type WebGLRenderTarget } from 'three';
import { color } from '@maskwars/brand';

function panel(scene: Scene, hex: string, power: number, w: number, h: number, pos: [number, number, number], look: [number, number, number]) {
  const m = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ color: new Color(hex).multiplyScalar(power) }));
  m.position.set(...pos);
  m.lookAt(...look);
  scene.add(m);
}

export function studio(renderer: WebGLRenderer): WebGLRenderTarget {
  const scene = new Scene();
  const room = new Mesh(new BoxGeometry(30, 16, 30), new MeshBasicMaterial({ color: new Color(color.ink), side: BackSide }));
  scene.add(room);

  // Key: wide, soft, above and to the left of the camera.
  panel(scene, color.ice, 2.2, 12, 4, [-5, 7, 6], [0, 0, 0]);
  // A soft front-high fill behind the camera: the door and the faces read as surfaces, not holes.
  panel(scene, color.ice, 0.5, 10, 3, [1, 4, 10], [0, 1, 0]);
  // Corners: tall thin strips behind the masks, the light of The Split.
  panel(scene, color.ember, 5, 1.2, 8, [-11, 2, -4], [0, 1, 0]);
  panel(scene, color.violet, 5, 1.2, 8, [11, 2, -4], [0, 1, 0]);
  // A thin top line behind, so ridges catch a hair of light.
  panel(scene, color.ice, 1.6, 14, 0.25, [0, 6.5, -9], [0, 0, 0]);
  // Faint floor bounce in front: lower facets do not die completely.
  panel(scene, color.ice, 0.07, 14, 3, [0, -3, 8], [0, 1, 0]);

  const pmrem = new PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, 0.035);
  pmrem.dispose();
  scene.traverse((o) => {
    if (o instanceof Mesh) {
      o.geometry.dispose();
      (o.material as MeshBasicMaterial).dispose();
    }
  });
  return target;
}
