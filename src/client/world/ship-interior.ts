import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import boardingUrl from '../assets/boarding.glb?url';
import bunkerUrl from '../assets/bunker.glb?url';
import { roomAt, SHIP_LAYOUT, type BoardLayout } from '../../shared/boarding.ts';
import { BUNKER_LAYOUT } from '../../shared/base-assault.ts';
import type { V3 } from '../../shared/math/vec.ts';

/**
 * The inside of a boarded ship, modelled in Blender (tools/blender/build_boarding.py →
 * assets/boarding.glb) in its deck coordinates (see shared/boarding.ts), drawn where the
 * boarded ship floats. Nodes the game moves: HatchInner_L/R (slide open for the boarder),
 * ChestLid (swings up once the strongbox is emptied); materials it animates: ReactorGlow
 * (pulses), AlarmGlow (blinks red while the crew fights), HelmScreen (turns green once
 * the ship is taken), ChestGlow (red while locked, green when open).
 */
/**
 * Which interior: its model, its layout, where the entrance door's leaves are (deck z) and how
 * the strongbox lid swings (about deck x for the ship's hold, about deck z for the bunker's).
 * The bunker (tools/blender/build_bunker.py → assets/bunker.glb) uses the same node and material
 * names: its lift cage door is HatchInner_L/R, its generator core ReactorGlow, its capture console
 * HelmScreen.
 */
export interface InteriorKind { url: string; layout: BoardLayout; doorZ: number; lidAxis: 'x' | 'z' }
export const SHIP_INTERIOR: InteriorKind = { url: boardingUrl, layout: SHIP_LAYOUT, doorZ: 10, lidAxis: 'x' };
export const BUNKER_INTERIOR: InteriorKind = { url: bunkerUrl, layout: BUNKER_LAYOUT, doorZ: 12, lidAxis: 'z' };

const templates = new Map<string, Promise<THREE.Object3D>>();
function loadInterior(url: string): Promise<THREE.Object3D> {
  let template = templates.get(url);
  if (template) return template;
  template = new GLTFLoader().loadAsync(url).then((g) => {
    g.scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.receiveShadow = true;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        // the bridge window shows real space outside
        if (m.name === 'Glass') Object.assign(m, { transparent: true, opacity: 0.12, depthWrite: false });
      }
    });
    return g.scene;
  });
  templates.set(url, template);
  return template;
}

export interface BoardState { alarm: boolean; looted: boolean; cleared: boolean; claimed: boolean }

export class ShipInteriorView {
  readonly group = new THREE.Group();
  /** Ship orientation (world) this frame. */
  readonly q = new THREE.Quaternion();
  readonly pos = new THREE.Vector3();
  private hatch: { o: THREE.Object3D; x: number; side: number; open: number }[] = [];
  private lid: THREE.Object3D | null = null;
  private lidOpen = 0;
  private mats = new Map<string, THREE.MeshStandardMaterial>();
  private base = new Map<string, THREE.Color>();
  private disposed = false;

  constructor(readonly kind: InteriorKind = SHIP_INTERIOR) {
    this.group.visible = false;
    loadInterior(kind.url).then((scene) => {
      if (this.disposed) return;
      const room = scene.clone(true);
      room.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          // own copies of the animated materials
          const m = o.material as THREE.MeshStandardMaterial;
          if (['ReactorGlow', 'AlarmGlow', 'HelmScreen', 'ChestGlow'].includes(m.name)) {
            let mine = this.mats.get(m.name);
            if (!mine) { mine = m.clone(); this.mats.set(m.name, mine); this.base.set(m.name, mine.emissive.clone()); }
            o.material = mine;
          }
        }
        const h = /^HatchInner_([LR])$/.exec(o.name);
        if (h) this.hatch.push({ o, x: o.position.x, side: h[1] === 'L' ? -1 : 1, open: 0 });
        if (o.name === 'ChestLid') this.lid = o;
      });
      this.group.add(room);
    }).catch((e) => {
      console.warn('ship interior model failed to load', e);
      this.group.add(fallback(kind.layout));
    });
  }

  /** Places the deck at the boarded ship's world pose. */
  setPose(p: V3, q: { x: number; y: number; z: number; w: number }) {
    this.pos.set(p.x, p.y, p.z);
    this.q.set(q.x, q.y, q.z, q.w);
  }

  /** Deck point → world. */
  toWorld(p: V3, out: V3): V3 {
    const v = new THREE.Vector3(p.x, p.y + this.kind.layout.floorY, p.z).applyQuaternion(this.q);
    out.x = this.pos.x + v.x; out.y = this.pos.y + v.y; out.z = this.pos.z + v.z;
    return out;
  }

  /** World point → deck. */
  toDeck(w: V3): THREE.Vector3 {
    return new THREE.Vector3(w.x - this.pos.x, w.y - this.pos.y, w.z - this.pos.z).applyQuaternion(this.q.clone().invert()).add(new THREE.Vector3(0, -this.kind.layout.floorY, 0));
  }

  dirToWorld(d: V3): THREE.Vector3 {
    return new THREE.Vector3(d.x, d.y, d.z).applyQuaternion(this.q);
  }

  ceil(x: number, z: number): number | null {
    return roomAt(this.kind.layout, x, z)?.ceil ?? null;
  }

  /** Hatch slides for whoever is near, the reactor breathes, alarms blink during the fight. */
  update(dt: number, time: number, me: { x: number; z: number } | null, st: BoardState) {
    const near = me ? Math.abs(me.z - this.kind.doorZ) < 3.2 && Math.abs(me.x) < 3 : false;
    for (const h of this.hatch) {
      h.open += ((near ? 1 : 0) - h.open) * Math.min(1, dt * 5);
      h.o.position.x = h.x + h.side * h.open * 1.1;
    }
    this.lidOpen += ((st.looted ? 1 : 0) - this.lidOpen) * Math.min(1, dt * 3);
    if (this.lid) {
      if (this.kind.lidAxis === 'x') this.lid.rotation.x = -this.lidOpen * 1.6;
      else this.lid.rotation.z = this.lidOpen * 1.6;
    }
    const set = (name: string, k: number, color?: string) => {
      const m = this.mats.get(name), b = this.base.get(name);
      if (!m || !b) return;
      if (color) m.emissive.set(color); else m.emissive.copy(b);
      m.emissiveIntensity = k;
    };
    set('ReactorGlow', 1.6 + Math.sin(time * 2.3) * 0.5);
    set('AlarmGlow', st.alarm && !st.cleared ? (Math.sin(time * 7) > 0 ? 3 : 0.15) : 0.1);
    set('HelmScreen', 1.4, st.claimed ? '#40ff8a' : st.cleared ? '#ffd040' : undefined);
    set('ChestGlow', 1.6, st.cleared ? '#40ff8a' : '#ff3020');
  }

  dispose() {
    this.disposed = true;
    this.group.removeFromParent();
  }
}

/** Plain walls and floors if the model did not load. */
function fallback(L: BoardLayout): THREE.Object3D {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: '#6c727c', roughness: 0.6, metalness: 0.3 });
  for (const r of L.rooms) {
    const floor = new THREE.Mesh(new THREE.BoxGeometry(r.x1 - r.x0, 0.1, r.z1 - r.z0), mat);
    floor.position.set((r.x0 + r.x1) / 2, -0.05, (r.z0 + r.z1) / 2);
    const ceil = floor.clone();
    ceil.position.y = r.ceil + 0.05;
    g.add(floor, ceil);
  }
  for (const [x0, z0, x1, z1] of L.walls) {
    const l = Math.hypot(x1 - x0, z1 - z0);
    const w = new THREE.Mesh(new THREE.BoxGeometry(l, 3, 0.15), mat);
    w.position.set((x0 + x1) / 2, 1.5, (z0 + z1) / 2);
    w.rotation.y = -Math.atan2(z1 - z0, x1 - x0);
    g.add(w);
  }
  for (const [p, c] of [[L.chest, '#a03020'], [L.helm, '#2060a0'], [L.hatch, '#30a060']] as const) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1, 1.2), new THREE.MeshStandardMaterial({ color: c }));
    b.position.set(p.x, 0.5, p.z);
    g.add(b);
  }
  return g;
}
