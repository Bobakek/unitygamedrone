import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import cabinUrl from '../assets/cabin.glb?url';
import { trophyInfo, type Trophy, type TrophyInfo, type TrophyKind } from '../../shared/station/trophies.ts';

/**
 * The pilot's cabin, modelled in Blender (tools/blender/build_cabin.py → assets/cabin.glb):
 * the furnished room in deck coordinates plus the trophy models, which are cloned onto
 * the room's Slot_<kind>_<n> empties and recoloured from the trophy (materials "Tint" and
 * "Tint2"). Patches are drawn on canvases. When a kind has more trophies than slots the
 * newest are shown; the collection terminal lists them all.
 */
let template: Promise<THREE.Object3D> | null = null;
function loadCabin(): Promise<THREE.Object3D> {
  template ??= new GLTFLoader().loadAsync(cabinUrl).then((g) => {
    g.scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.receiveShadow = true;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (m.name === 'Glass') Object.assign(m, { transparent: true, opacity: 0.16, depthWrite: false });
      }
    });
    return g.scene;
  });
  return template;
}

const MODEL: Partial<Record<TrophyKind, (info: TrophyInfo) => string>> = {
  relic: (i) => `Relic_${i.variant % 3}`,
  log: () => 'Datapad',
  specimen: () => 'Jar',
  shard: () => 'Shard',
  medal: () => 'Medal',
};
/** Kinds whose "Tint" glows. */
const GLOWS: Partial<Record<TrophyKind, number>> = { relic: 0.7, log: 0.9, shard: 1.1 };
/** Models are a bit small for their shelves at 1:1. */
const SCALE: Partial<Record<TrophyKind, number>> = { relic: 1.35, shard: 1.5, medal: 1.2 };

interface Placed { info: TrophyInfo; x: number; z: number; y: number }

export class CabinView {
  readonly group = new THREE.Group();
  private items = new THREE.Group();
  private slots = new Map<TrophyKind, THREE.Object3D[]>();
  private protos = new Map<string, THREE.Object3D>();
  private shown = '';
  private want: Trophy[] = [];
  private placed: Placed[] = [];
  private ready = false;
  private disposed = false;

  constructor() {
    this.group.add(this.items);
    loadCabin().then((scene) => {
      if (this.disposed) return;
      const room = scene.clone(true);
      const protoRoot = room.getObjectByName('Protos');
      if (protoRoot) {
        for (const c of [...protoRoot.children]) this.protos.set(c.name, c);
        protoRoot.removeFromParent();
      }
      for (const o of [...room.children]) {
        const m = /^Slot_(\w+?)_(\d+)$/.exec(o.name);
        if (!m) continue;
        const list = this.slots.get(m[1] as TrophyKind) ?? [];
        list[Number(m[2])] = o;
        this.slots.set(m[1] as TrophyKind, list);
      }
      this.group.add(room);
      this.ready = true;
      this.set(this.want, true);
    }).catch((e) => console.warn('cabin model failed to load', e));
  }

  /** Shows these trophies (cheap when nothing changed). */
  set(trophies: Trophy[], force = false) {
    this.want = trophies;
    const key = trophies.map((t) => t.id).join(',');
    if (!this.ready || (key === this.shown && !force)) return;
    this.shown = key;
    this.clearItems();
    const byKind = new Map<TrophyKind, TrophyInfo[]>();
    for (const t of [...trophies].sort((a, b) => b.at - a.at)) {
      const info = trophyInfo(t.id);
      if (!info) continue;
      const l = byKind.get(info.kind) ?? [];
      l.push(info);
      byKind.set(info.kind, l);
    }
    for (const [kind, infos] of byKind) {
      const slots = this.slots.get(kind) ?? [];
      // newest first into the slots, then shown in a stable order (oldest on the left/top)
      const show = infos.slice(0, slots.length).reverse();
      show.forEach((info, i) => {
        const slot = slots[i];
        if (!slot) return;
        const obj = kind === 'patch' ? this.patch(info) : this.model(info);
        if (!obj) return;
        obj.position.copy(slot.position);
        obj.quaternion.copy(slot.quaternion);
        obj.scale.setScalar(SCALE[kind] ?? 1);
        this.items.add(obj);
        this.placed.push({ info, x: slot.position.x, y: slot.position.y, z: slot.position.z });
      });
    }
  }

  /** The trophy nearest to a deck point on the floor, within `reach` metres. */
  nearest(x: number, z: number, reach = 1.6): TrophyInfo | null {
    let best: Placed | null = null, bd = reach;
    for (const p of this.placed) {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bd) { bd = d; best = p; }
    }
    return best?.info ?? null;
  }

  private model(info: TrophyInfo): THREE.Object3D | null {
    const src = this.protos.get(MODEL[info.kind]?.(info) ?? '');
    if (!src) return null;
    const obj = src.clone(true);
    const glow = GLOWS[info.kind] ?? 0;
    obj.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.castShadow = true;
      const tint = (m: THREE.Material) => {
        if (!(m instanceof THREE.MeshStandardMaterial) || (m.name !== 'Tint' && m.name !== 'Tint2')) return m;
        const c = m.clone();
        const col = new THREE.Color(m.name === 'Tint' ? info.color : info.color2);
        c.color.copy(col);
        if (m.name === 'Tint') {
          c.emissive.copy(col);
          c.emissiveIntensity = glow;
          if (info.kind === 'medal') { c.metalness = 1; c.roughness = 0.25; c.emissiveIntensity = 0.05; }
          if (info.kind === 'specimen') { c.metalness = 0; c.roughness = 0.6; c.emissiveIntensity = 0.15; }
        }
        return c;
      };
      o.material = Array.isArray(o.material) ? o.material.map(tint) : tint(o.material);
    });
    return obj;
  }

  /** A round embroidered patch: rim, field and an emblem (stars for kills, chevrons for ranks). */
  private patch(info: TrophyInfo): THREE.Object3D {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    g.fillStyle = info.color2;
    g.beginPath(); g.arc(64, 64, 62, 0, Math.PI * 2); g.fill();
    g.fillStyle = info.color;
    g.beginPath(); g.arc(64, 64, 54, 0, Math.PI * 2); g.fill();
    g.fillStyle = g.strokeStyle = info.color2;
    if (info.variant >= 10) {
      // rank: chevrons, one per rank
      const n = info.variant - 10;
      g.lineWidth = 9; g.lineJoin = 'round';
      for (let k = 0; k < n; k++) {
        const y = 40 + k * 15 - (n - 1) * 4;
        g.beginPath(); g.moveTo(34, y); g.lineTo(64, y + 16); g.lineTo(94, y); g.stroke();
      }
    } else {
      // kills: wings and as many stars as the milestone's step
      g.beginPath();
      g.moveTo(64, 70); g.quadraticCurveTo(36, 46, 18, 50); g.quadraticCurveTo(36, 60, 64, 82);
      g.quadraticCurveTo(92, 60, 110, 50); g.quadraticCurveTo(92, 46, 64, 70); g.fill();
      const n = info.variant + 1;
      for (let k = 0; k < n; k++) star(g, 64 + (k - (n - 1) / 2) * 15, 38, 7);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.CircleGeometry(0.34, 32), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
    return m;
  }

  private clearItems() {
    for (const o of [...this.items.children]) {
      o.removeFromParent();
      o.traverse((x) => {
        if (!(x instanceof THREE.Mesh)) return;
        // models share geometry with the template; patches own theirs
        if (x.geometry instanceof THREE.CircleGeometry) x.geometry.dispose();
        for (const m of Array.isArray(x.material) ? x.material : [x.material]) {
          if (m.name === 'Tint' || m.name === 'Tint2' || !m.name) { (m as THREE.MeshStandardMaterial).map?.dispose(); m.dispose(); }
        }
      });
    }
    this.placed = [];
  }

  dispose() {
    this.disposed = true;
    this.clearItems();
    this.group.removeFromParent();
  }
}

function star(g: CanvasRenderingContext2D, x: number, y: number, r: number) {
  g.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5, rr = k % 2 ? r * 0.45 : r;
    g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
  g.fill();
}
