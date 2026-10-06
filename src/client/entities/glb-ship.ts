import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import haulerUrl from '../assets/hauler.glb?url';
import minerUrl from '../assets/miner.glb?url';
import generatorUrl from '../assets/generator.glb?url';
import type { Blueprint } from '../../shared/ships/blueprint.ts';

/**
 * Ships modelled in Blender (tools/blender/build_ships.py → assets/<class>.glb). Every copy gets
 * its own Hull / Paint / Accent / EngineGlow materials tinted with the pilot's blueprint colours;
 * empties named Thruster_<n> (extras: r) mark where the engine flames go.
 */
/** The pirate base's shield generator pylon comes from tools/blender/build_bunker.py. */
const URLS: Record<string, string> = { hauler: haulerUrl, miner: minerUrl, generator: generatorUrl };
export const isGlbShip = (cls: string) => cls in URLS;

const templates = new Map<string, Promise<THREE.Object3D>>();
function template(cls: string): Promise<THREE.Object3D> {
  let t = templates.get(cls);
  if (!t) {
    t = new GLTFLoader().loadAsync(URLS[cls]).then((g) => {
      g.scene.traverse((o) => {
        if (o instanceof THREE.Mesh) { o.castShadow = true; o.receiveShadow = true; }
      });
      return g.scene;
    });
    templates.set(cls, t);
  }
  return t;
}

export interface GlbShip {
  object: THREE.Object3D;
  engines: { pos: THREE.Vector3; r: number }[];
  radius: number;
  materials: THREE.Material[];
}

const TINT: Record<string, (bp: Blueprint) => string> = {
  Hull: (bp) => bp.hull, Paint: (bp) => bp.hull2, Accent: (bp) => bp.accent,
};

export async function loadGlbShip(bp: Blueprint): Promise<GlbShip> {
  const object = (await template(bp.cls)).clone(true);
  const own = new Map<THREE.Material, THREE.Material>();
  object.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const swap = (m: THREE.Material) => {
      const tint = TINT[m.name];
      if (!tint && m.name !== 'EngineGlow') return m;
      let c = own.get(m);
      if (!c) {
        const sm = m.clone() as THREE.MeshStandardMaterial;
        if (tint) sm.color.set(tint(bp));
        else sm.emissive.set(bp.glow);
        own.set(m, sm);
        c = sm;
      }
      return c;
    };
    o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
  });
  object.updateMatrixWorld(true);
  const engines: GlbShip['engines'] = [];
  object.traverse((o) => {
    if (o.name.startsWith('Thruster_')) engines.push({ pos: o.getWorldPosition(new THREE.Vector3()), r: Number(o.userData.r) || 0.8 });
  });
  const sphere = new THREE.Box3().setFromObject(object).getBoundingSphere(new THREE.Sphere());
  return { object, engines, radius: sphere.center.length() + sphere.radius, materials: [...own.values()] };
}
