import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import depositsUrl from '../assets/deposits.glb?url';
import type { PlanetDef } from '../../shared/galaxy/system-gen.ts';
import { depositsNear, SCAN_RANGE, type Deposit, type DepositKind } from '../../shared/planet/deposits.ts';
import type { V3 } from '../../shared/math/vec.ts';
import type { PlanetView } from './planet-view.ts';

/**
 * Rover deposits on the planet being visited, modelled in Blender
 * (tools/blender/build_deposits.py → assets/deposits.glb). Models ride the planet group in its
 * body frame (like ruins and outposts); every deposit within scanner range also gets a tall
 * light pillar so it can be found from afar. A drilled-out deposit keeps its rocks but its glow
 * goes out and its pillar disappears until it regrows.
 */
const NODE: Record<DepositKind, string> = { vein: 'Vein', geode: 'Geode', meteorite: 'Meteorite', probe: 'Probe', fossil: 'Fossil' };
export const DEPOSIT_COLORS: Record<DepositKind, string> = { vein: '#ff8a2a', geode: '#9a7aff', meteorite: '#ff4a10', probe: '#ff3020', fossil: '#ffb030' };
/** Models are drawn this close (m); pillars out to the scanner range. */
const MODEL_RANGE = 1400;

let template: Promise<THREE.Object3D> | null = null;
function loadDeposits(): Promise<THREE.Object3D> {
  template ??= new GLTFLoader().loadAsync(depositsUrl).then((g) => {
    g.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) { o.castShadow = true; o.receiveShadow = true; }
    });
    return g.scene;
  });
  return template;
}

const beamGeo = new THREE.CylinderGeometry(0.45, 0.9, 1, 10, 1, true).translate(0, 0.5, 0);

interface Shown {
  dep: Deposit;
  group: THREE.Group;
  model: THREE.Object3D | null;
  glow: THREE.MeshStandardMaterial[];
  beam: THREE.Mesh;
  lod: number;
  spent: boolean | null;
}

const Y = new THREE.Vector3(0, 1, 0), up = new THREE.Vector3();

export class DepositField {
  private planet: PlanetDef | null = null;
  private shown = new Map<number, Shown>();
  private last = new THREE.Vector3(1e12, 0, 0);
  private tpl: THREE.Object3D | null = null;
  /** Undrilled deposits in scanner range, nearest first (refreshed as the camera moves). */
  inRange: Deposit[] = [];

  constructor() {
    loadDeposits().then((t) => { this.tpl = t; this.last.set(1e12, 0, 0); }).catch((e) => console.warn('deposit models', e));
  }

  clear() {
    for (const s of this.shown.values()) this.drop(s);
    this.shown.clear();
    this.planet = null;
    this.inRange = [];
  }

  /**
   * `cam` = camera in the planet's body frame; `spent(id)` tells drilled-out deposits.
   * Pass a null planet away from any surface.
   */
  update(pv: PlanetView | null, cam: V3, spent: (planet: number, id: number) => boolean, time: number) {
    const planet = pv?.def ?? null;
    if (planet !== this.planet) { this.clear(); this.planet = planet; }
    if (!planet || !pv) return;
    const moved = this.last.distanceTo(tv.set(cam.x, cam.y, cam.z));
    if (moved > 40) {
      this.last.copy(tv);
      const len = Math.hypot(cam.x, cam.y, cam.z);
      const d = { x: cam.x / len, y: cam.y / len, z: cam.z / len };
      const near = depositsNear(planet, d, SCAN_RANGE);
      const ids = new Set(near.map((x) => x.id));
      for (const [id, s] of this.shown) if (!ids.has(id)) { this.drop(s); this.shown.delete(id); }
      for (const dep of near) if (!this.shown.has(dep.id)) this.shown.set(dep.id, this.make(dep, pv));
      const dist = (x: Deposit) => Math.hypot(x.dir.x * (planet.radius + x.h) - cam.x, x.dir.y * (planet.radius + x.h) - cam.y, x.dir.z * (planet.radius + x.h) - cam.z);
      this.inRange = near.sort((a, b) => dist(a) - dist(b));
    }
    this.inRange = this.inRange.filter((x) => !spent(planet.index, x.id));
    for (const s of this.shown.values()) {
      const r = planet.radius + s.dep.h;
      const dd = Math.hypot(s.dep.dir.x * r - cam.x, s.dep.dir.y * r - cam.y, s.dep.dir.z * r - cam.z);
      // the model only near the camera, cloned lazily
      if (dd < MODEL_RANGE && !s.model && this.tpl) this.attach(s);
      if (s.model) s.model.visible = dd < MODEL_RANGE;
      if (s.lod !== pv.lodVersion) {
        s.lod = pv.lodVersion;
        up.set(s.dep.dir.x, s.dep.dir.y, s.dep.dir.z);
        s.group.position.set(s.dep.dir.x * r, s.dep.dir.y * r, s.dep.dir.z * r).addScaledVector(up, pv.groundDelta(s.dep.dir, s.dep.h));
      }
      const off = spent(planet.index, s.dep.id);
      if (off !== s.spent) {
        s.spent = off;
        for (const m of s.glow) { m.emissiveIntensity = off ? 0 : m.userData.glow; m.color.copy(m.userData.base).multiplyScalar(off ? 0.35 : 1); }
      }
      s.beam.visible = !off && dd > 25;
      if (!off) {
        // pillars breathe; thicker far away so they read at a distance
        const w = Math.max(1, dd / 140);
        s.beam.scale.set(w, 160 + 40 * Math.sin(time * 1.3 + s.dep.id), w);
        (s.beam.material as THREE.MeshBasicMaterial).opacity = (dd < 80 ? 0.16 : 0.34) + 0.08 * Math.sin(time * 2.1 + s.dep.id);
      }
    }
  }

  /** Model-space body-frame position of a shown deposit on the drawn ground (for markers). */
  groundPos(id: number, out: THREE.Vector3): THREE.Vector3 | null {
    const s = this.shown.get(id);
    return s ? out.copy(s.group.position) : null;
  }

  private make(dep: Deposit, pv: PlanetView): Shown {
    const group = new THREE.Group();
    up.set(dep.dir.x, dep.dir.y, dep.dir.z);
    group.quaternion.setFromUnitVectors(Y, up);
    // a little spin so the same kind does not always face the same way
    group.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(Y, (dep.id * 2.399) % (Math.PI * 2)));
    const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
      color: DEPOSIT_COLORS[dep.kind], transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }));
    beam.position.y = 1;
    beam.frustumCulled = false;
    group.add(beam);
    pv.group.add(group);
    return { dep, group, model: null, glow: [], beam, lod: -1, spent: null };
  }

  private attach(s: Shown) {
    const src = this.tpl!.getObjectByName(NODE[s.dep.kind]);
    if (!src) return;
    const m = src.clone(true);
    m.position.set(0, 0, 0);
    // per-deposit glow materials, dimmed once drilled out
    m.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const own = mats.map((mt) => {
        if (!(mt instanceof THREE.MeshStandardMaterial) || !mt.name.startsWith('Glow')) return mt;
        const c = mt.clone();
        c.userData.glow = mt.emissiveIntensity || 1;
        c.userData.base = mt.color.clone();
        s.glow.push(c);
        return c;
      });
      o.material = Array.isArray(o.material) ? own : own[0];
    });
    s.model = m;
    s.spent = null;
    s.group.add(m);
  }

  private drop(s: Shown) {
    s.group.removeFromParent();
    (s.beam.material as THREE.Material).dispose();
    for (const m of s.glow) m.dispose();
  }
}

const tv = new THREE.Vector3();
