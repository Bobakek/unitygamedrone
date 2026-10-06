import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import gateUrl from '../assets/bunker-gate.glb?url';
import { BUNKER, DOME_R, type BaseInfo } from '../../shared/base-assault.ts';
import type { PlanetDef, PlanetType } from '../../shared/galaxy/system-gen.ts';
import { Rng } from '../../shared/math/rng.ts';
import { siteDir, TURRET_HEIGHT, WALL_HEIGHT, WRECK_ROOF, type SiteDef } from '../../shared/planet/sites.ts';
import { heightAt } from '../../shared/planet/terrain.ts';
import { add, newParts, taperedBox, type Parts } from '../entities/ship-builder.ts';
import { glowTexture } from '../world/textures.ts';
import type { PlanetView } from './planet-view.ts';

const solidMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.88, metalness: 0.05 });
const metalMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.45, metalness: 0.6 });
const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });

const STONE: Record<PlanetType, [string, string]> = {
  terran: ['#b8ad98', '#7f8a6a'], ocean: ['#b8ad98', '#7f8a6a'], alien: ['#a898b8', '#6a5a8a'], desert: ['#d0b488', '#a8845a'],
  ice: ['#c8d4dc', '#8aa0b0'], lava: ['#6a6060', '#3a3434'], barren: ['#9a948c', '#6a6560'],
};
const GLYPH: Record<PlanetType, string> = { terran: '#6af0ff', ocean: '#6af0ff', alien: '#ff7ae0', desert: '#ffb84a', ice: '#8ad8ff', lava: '#ff6a3a', barren: '#b0ff7a' };

const tmp = new THREE.Vector3();
let gateTemplate: Promise<THREE.Object3D> | null = null;
/** The bunker's blockhouse, modelled in Blender (tools/blender/build_bunker.py → assets/bunker-gate.glb). */
function loadGate(): Promise<THREE.Object3D> {
  gateTemplate ??= new GLTFLoader().loadAsync(gateUrl).then((g) => {
    g.scene.traverse((o) => { if (o instanceof THREE.Mesh) { o.castShadow = true; o.receiveShadow = true; } });
    return g.scene;
  });
  return gateTemplate;
}
/** Door lamps of a base's blockhouse: sealed, open for a storm, held by the local pilot, held by someone else. */
const DOOR_COLORS = { sealed: '#ff2a12', open: '#ffb020', mine: '#30ff70', theirs: '#40c8ff' } as const;
const box3 = (s: number) => new THREE.BoxGeometry(s, s * 0.7, s * 0.9);

/**
 * Buildings of one surface site, built in the site's local frame (x east,
 * y up, z south) and parented to the rotating planet group, so they turn with
 * the ground they stand on.
 */
export class SiteView {
  readonly group = new THREE.Group();
  private blink: THREE.Sprite[] = [];
  private inv = new THREE.Quaternion();
  private center = new THREE.Vector3();
  private up = new THREE.Vector3();
  private lod = -1;
  /** Pirate bases: the force dome over the bunker, the blockhouse's door lamps and the flag. */
  private dome: THREE.Mesh | null = null;
  private doorMat: THREE.MeshStandardMaterial | null = null;
  private flag: THREE.Mesh | null = null;
  private gate: THREE.Object3D | null = null;
  private baseKey = '';
  private doorColor = new THREE.Color(DOOR_COLORS.sealed);

  constructor(private pl: PlanetDef, readonly site: SiteDef) {
    const s = site;
    const up = new THREE.Vector3(s.dir.x, s.dir.y, s.dir.z);
    const east = new THREE.Vector3(s.east.x, s.east.y, s.east.z);
    const south = new THREE.Vector3(-s.north.x, -s.north.y, -s.north.z);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(east, up, south));
    this.up.copy(up);
    this.center.copy(up).multiplyScalar(pl.radius + s.h);
    this.group.position.copy(this.center);
    this.group.quaternion.copy(q);
    this.inv.copy(q).invert();
    const p = newParts();
    if (s.kind === 'ruin') this.ruin(p); else if (s.kind === 'wreck') this.wreck(p); else this.base(p);
    for (const [list, mat] of [[[...p.hull, ...p.glass], solidMat], [p.metal, metalMat], [p.glow, glowMat]] as const) {
      if (!list.length) continue;
      const m = new THREE.Mesh(mergeGeometries(list as THREE.BufferGeometry[])!, mat);
      m.castShadow = mat !== glowMat;
      m.receiveShadow = true;
      this.group.add(m);
    }
  }

  /** Local position of the ground `x` m east and `z` m north of the centre (plus `lift`). */
  private at(x: number, z: number, lift = 0): number[] {
    const d = siteDir(this.pl, this.site, x, z);
    const h = heightAt(this.pl, d.x, d.y, d.z);
    tmp.set(d.x, d.y, d.z).multiplyScalar(this.pl.radius + h).sub(this.center).applyQuaternion(this.inv);
    return [tmp.x, tmp.y + lift, tmp.z];
  }

  private light(pos: number[], color: THREE.Color, size: number, blink = false) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
    sp.position.set(pos[0], pos[1], pos[2]);
    sp.scale.setScalar(size);
    this.group.add(sp);
    if (blink) this.blink.push(sp);
  }

  private ruin(p: Parts) {
    const s = this.site, r = new Rng(s.seed);
    const [stone, moss] = STONE[this.pl.type];
    const glyph = GLYPH[this.pl.type];
    // cracked floor slabs
    for (let i = 0; i < 16; i++) {
      const a = r.range(0, Math.PI * 2), d = Math.sqrt(r.float()) * 22;
      const pos = this.at(Math.cos(a) * d, Math.sin(a) * d, -0.15);
      add(p, new THREE.BoxGeometry(r.range(2.5, 5), 0.6, r.range(2.5, 5)), r.chance(0.3) ? moss : stone, false, pos, [r.range(-0.08, 0.08), r.range(0, 3), r.range(-0.08, 0.08)]);
    }
    const ring = s.pillars.slice(0, -1);
    ring.forEach((c, i) => {
      const a = (i / ring.length) * Math.PI * 2;
      const x = Math.cos(a) * 20, z = Math.sin(a) * 20;
      const base = this.at(x, z, -2);
      const h = c.tall + 2;
      add(p, new THREE.CylinderGeometry(c.r * 0.9, c.r, h, 6), stone, false, [base[0], base[1] + h / 2, base[2]]);
      add(p, new THREE.BoxGeometry(c.r * 2.6, 0.6, c.r * 2.6), moss, false, [base[0], base[1] + 2.2, base[2]]);
      if (c.tall > 6) {
        add(p, new THREE.BoxGeometry(c.r * 2.4, 0.8, c.r * 2.4), stone, false, [base[0], base[1] + h + 0.4, base[2]]);
        // lintel to the next standing pillar
        const n = ring[(i + 1) % ring.length];
        if (n.tall > 6 && r.chance(0.7)) {
          const a2 = (((i + 1) % ring.length) / ring.length) * Math.PI * 2;
          const b2 = this.at(Math.cos(a2) * 20, Math.sin(a2) * 20, -2);
          const y = Math.min(base[1] + h, b2[1] + n.tall + 2) + 1.2;
          this.beam(p, base, b2, y, 1, 1.6, stone);
        }
      } else {
        add(p, new THREE.ConeGeometry(c.r, 1.4, 5), stone, false, [base[0], base[1] + h + 0.5, base[2]], [0.3, 0, 0.2]);
        // rubble at its foot (low enough to step over)
        for (let k = 0; k < 3; k++) {
          const fa = r.range(0, Math.PI * 2), fd = r.range(2, 3.5);
          add(p, box3(r.range(0.4, 0.7)), stone, false, this.at(x + Math.cos(fa) * fd, z + Math.sin(fa) * fd, 0.1), [r.range(0, 1), r.range(0, 3), r.range(0, 1)]);
        }
      }
    });
    // fallen blocks — solid, vaultable (see SiteDef.blocks)
    for (const b of s.blocks) {
      const loc = this.local(b.dir, b.h, -0.4);
      add(p, new THREE.BoxGeometry(b.r * 2.1, b.tall + 0.4, b.r * 1.7), r.chance(0.3) ? moss : stone, false, [loc[0], loc[1] + (b.tall + 0.4) / 2, loc[2]], [r.range(-0.05, 0.05), r.range(0, Math.PI), r.range(-0.05, 0.05)]);
    }
    // obelisk with glowing glyph bands
    const o = this.at(0, 0, -2);
    add(p, new THREE.BoxGeometry(6, 1.2, 6), moss, false, [o[0], o[1] + 2.2, o[2]]);
    add(p, taperedBox(3.2, 16, 3.2, 0.55, 1).rotateX(Math.PI / 2), stone, false, [o[0], o[1] + 10, o[2]]);
    add(p, new THREE.ConeGeometry(1.25, 2.4, 4), glyph, true, [o[0], o[1] + 19.2, o[2]], [0, Math.PI / 4, 0], undefined, 2);
    for (const y of [6, 9.5, 13]) add(p, new THREE.BoxGeometry(3.3 - y * 0.09, 0.25, 3.3 - y * 0.09), glyph, true, [o[0], o[1] + y, o[2]], undefined, undefined, 1.6);
    this.light([o[0], o[1] + 19.5, o[2]], new THREE.Color(glyph).multiplyScalar(1.5), 10);
    // plinths under the relic caches
    for (const c of s.caches) {
      const loc = this.local(c.dir, c.h, -0.3);
      add(p, new THREE.BoxGeometry(1.8, 0.8, 1.8), stone, false, loc);
    }
  }

  private base(p: Parts) {
    const s = this.site, r = new Rng(s.seed);
    const hull = '#5a4a5e', dark = '#2a2430', accent = '#e8485a', steel = '#6a6670';
    // landing pad on a plinth, levelled to the highest ground under it
    const c = this.at(0, 0);
    let top = c[1];
    for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; top = Math.max(top, this.at(Math.cos(a) * 13, Math.sin(a) * 13)[1]); }
    add(p, new THREE.CylinderGeometry(13, 13, 1.4, 8), steel, 'metal', [c[0], top + 0.7, c[2]]);
    add(p, new THREE.CylinderGeometry(9, 9, 0.1, 8), dark, false, [c[0], top + 1.45, c[2]]);
    add(p, new THREE.CylinderGeometry(10, 12, top - c[1] + 4, 8), dark, false, [c[0], (top + c[1]) / 2 - 1.5, c[2]]);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
      add(p, new THREE.BoxGeometry(1.2, 0.3, 0.5), '#ffb040', true, [c[0] + Math.cos(a) * 12.2, top + 1.5, c[2] + Math.sin(a) * 12.2], [0, -a, 0]);
    }
    // hangar with a curved roof
    const hg = this.at(-24, 16);
    const hb = hg[1] - 2;
    add(p, new THREE.BoxGeometry(16, 9, 12), hull, false, [hg[0], hb + 4.5, hg[2]]);
    add(p, new THREE.CylinderGeometry(6.2, 6.2, 16.4, 8, 1, false, 0, Math.PI).rotateZ(Math.PI / 2), dark, 'metal', [hg[0], hb + 9, hg[2]]);
    add(p, new THREE.BoxGeometry(10, 6, 0.4), '#141018', false, [hg[0] + 3, hb + 5, hg[2] + 6.1]);
    add(p, new THREE.BoxGeometry(10, 0.3, 0.3), accent, true, [hg[0] + 3, hb + 8.3, hg[2] + 6.3]);
    // loot depot crates next to it
    for (let k = 0; k < 5; k++) {
      const cp = this.at(-30 + r.range(-3, 3), 6 + r.range(-3, 3), 0.9);
      add(p, new THREE.BoxGeometry(1.8, 1.8, 1.8), r.pick(['#8a6a3a', '#5a6a4a', steel]), false, cp, [0, r.range(0, 1.5), 0]);
    }
    // perimeter wall sections (climbable height), following the ground in short pieces
    s.walls.forEach((w, k) => {
      const pieces = 4;
      for (let j = 0; j < pieces; j++) {
        const t0 = j / pieces, t1 = (j + 1) / pieces;
        const w0 = this.at(w.x0 + (w.x1 - w.x0) * t0, w.z0 + (w.z1 - w.z0) * t0, -1.2);
        const w1 = this.at(w.x0 + (w.x1 - w.x0) * t1, w.z0 + (w.z1 - w.z0) * t1, -1.2);
        const lo = Math.min(w0[1], w1[1]), hi = Math.max(w0[1], w1[1]) + 1.2 + WALL_HEIGHT;
        this.beam(p, w0, w1, (lo + hi) / 2, hi - lo, 1.4, (k + j) % 2 ? hull : steel, 0.1);
        this.beam(p, w0, w1, hi + 0.12, 0.25, 1.6, accent, 0.1);
      }
    });
    // flak towers (the gun balls themselves are networked entities)
    for (const t of s.turrets) {
      const loc = this.local(t.dir, t.h, -2);
      const h = TURRET_HEIGHT + 2;
      add(p, new THREE.CylinderGeometry(1.8, 2.6, h, 6), hull, false, [loc[0], loc[1] + h / 2, loc[2]]);
      add(p, new THREE.CylinderGeometry(3, 3, 0.6, 8), steel, 'metal', [loc[0], loc[1] + h, loc[2]]);
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2;
        add(p, new THREE.BoxGeometry(0.4, h * 0.8, 0.4), dark, 'metal', [loc[0] + Math.cos(a) * 2.4, loc[1] + h * 0.4, loc[2] + Math.sin(a) * 2.4], [Math.sin(a) * 0.25, 0, -Math.cos(a) * 0.25]);
      }
      this.light([loc[0], loc[1] + h + 0.6, loc[2]], new THREE.Color(2.4, 0.4, 0.3), 3, true);
    }
    // antenna mast and its banner (recoloured when the base changes hands)
    const m = this.at(18, -20, -1);
    add(p, new THREE.CylinderGeometry(0.25, 0.45, 26, 5), steel, 'metal', [m[0], m[1] + 13, m[2]]);
    this.flag = new THREE.Mesh(new THREE.BoxGeometry(5, 3, 0.15), new THREE.MeshStandardMaterial({ color: accent, roughness: 0.8 }));
    this.flag.position.set(m[0] + 2.6, m[1] + 22, m[2]);
    this.flag.castShadow = true;
    this.group.add(this.flag);
    add(p, new THREE.BoxGeometry(1.4, 1.4, 0.2), dark, false, [m[0] + 2.6, m[1] + 22, m[2] + 0.1]);
    this.light([m[0], m[1] + 26.5, m[2]], new THREE.Color(3, 0.4, 0.3), 5, true);
    // the command bunker's blockhouse and the force dome its generator keeps over it
    const bx = (BUNKER.x0 + BUNKER.x1) / 2, bz = (BUNKER.z0 + BUNKER.z1) / 2;
    const g = this.at(bx, bz);
    let floor = g[1];
    for (const [x, z] of [[BUNKER.x0, BUNKER.z0], [BUNKER.x1, BUNKER.z0], [BUNKER.x0, BUNKER.z1], [BUNKER.x1, BUNKER.z1]]) floor = Math.max(floor, this.at(x, z)[1]);
    loadGate().then((t) => {
      const o = t.clone(true);
      o.traverse((x) => {
        if (!(x instanceof THREE.Mesh) || (x.material as THREE.Material).name !== 'DoorGlow') return;
        this.doorMat ??= (x.material as THREE.MeshStandardMaterial).clone();
        this.doorMat.emissive.copy(this.doorColor);
        this.doorMat.color.copy(this.doorColor);
        x.material = this.doorMat;
      });
      o.position.set(g[0], floor - 0.2, g[2]);
      this.gate = o;
      this.group.add(o);
    }).catch((e) => console.warn('bunker blockhouse model failed to load', e));
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(DOME_R, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: '#ff6a3a', transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
    );
    dome.position.set(g[0] - 1.5, floor - 0.5, g[2]);
    dome.renderOrder = 2;
    this.group.add(dome);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(DOME_R, 0.12, 6, 48).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#ff8a5a', toneMapped: false }));
    ring.position.y = 0.4;
    dome.add(ring);
    this.dome = dome;
    // floodlights
    for (const [x, z] of [[30, 30], [-34, -26], [36, -14]]) {
      const f = this.at(x, z, -1);
      add(p, new THREE.CylinderGeometry(0.2, 0.3, 9, 5), steel, 'metal', [f[0], f[1] + 4.5, f[2]]);
      this.light([f[0], f[1] + 9.3, f[2]], new THREE.Color(2.2, 1.9, 1.4), 6);
    }
  }

  /**
   * A crashed ship lying on its belly: ribbed hull with a torn stern, a breach in the side,
   * roof panels (a couple missing over the hold), and inside — bridge consoles, bunks,
   * cargo, the cracked reactor glowing green, emergency strips and sparking panels.
   */
  private wreck(p: Parts) {
    const s = this.site, r = new Rng(s.seed);
    const hull = '#7c8188', dark = '#2a2e34', inner = '#3c424a', rust = '#7a4a30', stripe = '#d08030', burnt = '#1e1c1c', deck = '#4a4f56';
    const top = WRECK_ROOF;
    // walls: the hull outline and the bulkheads, in short pieces that follow the ground
    s.walls.forEach((w, k) => {
      const len = Math.hypot(w.x1 - w.x0, w.z1 - w.z0), pieces = Math.max(1, Math.round(len / 4));
      const outer = k < s.walls.length - 10;
      for (let j = 0; j < pieces; j++) {
        const t0 = j / pieces, t1 = (j + 1) / pieces;
        const a = this.at(w.x0 + (w.x1 - w.x0) * t0, w.z0 + (w.z1 - w.z0) * t0, -1);
        const b = this.at(w.x0 + (w.x1 - w.x0) * t1, w.z0 + (w.z1 - w.z0) * t1, -1);
        const lo = Math.min(a[1], b[1]);
        const color = outer ? (r.chance(0.12) ? rust : r.chance(0.1) ? burnt : hull) : inner;
        this.beam(p, a, b, (lo + top + 0.3) / 2, top + 0.3 - lo, outer ? 0.6 : 0.35, color, 0.15);
        if (outer && r.chance(0.5)) this.beam(p, a, b, top - 1.6, 0.35, 0.7, stripe, 0.1);
      }
    });
    // roof panels over the hull, two missing above the hold; the nose as a wedge
    for (let x = -36; x < 30; x += 6) {
      if (x === -12 || x === 0) continue;
      const c = this.at(x + 3, 0);
      add(p, new THREE.BoxGeometry(6.05, 0.5, 20.6), r.chance(0.15) ? burnt : hull, 'metal', [c[0], top + 0.25, c[2]]);
    }
    const nose = this.at(37, 0);
    add(p, taperedBox(20.6, 0.5, 14, 0.15, 1).rotateY(Math.PI / 2), hull, 'metal', [nose[0], top + 0.25, nose[2]]);
    // a spine and ribs over the roof and down the sides
    const sp0 = this.at(-34, 0), sp1 = this.at(32, 0);
    this.beam(p, sp0, sp1, top + 0.9, 1.1, 2.2, dark);
    for (let x = -30; x <= 24; x += 6) {
      for (const z of [-10.4, 10.4]) {
        const g = this.at(x, z, -1);
        add(p, new THREE.BoxGeometry(0.9, top + 1.4 - g[1], 0.5), dark, 'metal', [g[0], (g[1] + top + 0.4) / 2, g[2]]);
      }
      const c = this.at(x, 0);
      add(p, new THREE.BoxGeometry(0.9, 0.5, 21.4), dark, 'metal', [c[0], top + 0.6, c[2]]);
    }
    // cockpit canopy: dark glass across the nose
    const cv = this.at(40, 0);
    add(p, new THREE.BoxGeometry(5, 1.4, 9), '#1a2a38', 'metal', [cv[0], top - 1.2, cv[2]], [0, 0, -0.25]);
    // the torn stern: broken engine bells, one lying apart, and the furrow it ploughed
    for (const z of [-5.5, 5.5]) {
      const e = this.at(-38, z, 1.5);
      add(p, new THREE.CylinderGeometry(2.4, 3.2, 4, 10, 1, true).rotateZ(Math.PI / 2), dark, 'metal', [e[0], e[1] + 1, e[2]], [0, r.range(-0.2, 0.2), r.range(-0.3, 0.3)]);
    }
    const loose = this.at(-52, -9, 1);
    add(p, new THREE.CylinderGeometry(2.2, 3, 4, 10, 1, true).rotateZ(Math.PI / 2), burnt, 'metal', [loose[0], loose[1] + 0.6, loose[2]], [0.4, 0.8, 0.5]);
    for (let k = 0; k < 9; k++) {
      const f = this.at(-44 - k * 5, r.range(-2, 2), -0.6);
      add(p, new THREE.BoxGeometry(5.5, 0.8, r.range(5, 8)), burnt, false, f, [r.range(-0.05, 0.05), r.range(-0.1, 0.1), 0]);
    }
    // a broken wing dug into the ground north of the hull
    const wg = this.at(-2, 16, 0.5);
    add(p, taperedBox(14, 0.6, 9, 0.4, 1).rotateY(Math.PI / 2), hull, 'metal', [wg[0], wg[1] + 1.4, wg[2]], [0.35, 0.15, 0]);
    // debris scattered around
    for (let k = 0; k < 14; k++) {
      const a = r.range(0, Math.PI * 2), d = r.range(16, 40);
      const g = this.at(Math.cos(a) * d * 1.4, Math.sin(a) * d * 0.7, 0.2);
      add(p, box3(r.range(0.5, 1.6)), r.pick([hull, dark, rust, burnt]), false, g, [r.range(0, 3), r.range(0, 3), r.range(0, 3)]);
    }
    // --- inside: deck plates per room
    for (const zn of s.zones ?? []) {
      const c = this.at((zn.x0 + zn.x1) / 2, (zn.z0 + zn.z1) / 2, 0.05);
      add(p, new THREE.BoxGeometry(zn.x1 - zn.x0 - 0.6, 0.2, zn.z1 - zn.z0 - 0.6), deck, 'metal', c);
    }
    // bridge: consoles along the nose with screens, two seats, the captain's console with the log
    for (const [x, z, yaw] of [[33, -6, 0.6], [33, 6, -0.6], [36, -3.5, 0.3], [36, 3.5, -0.3]]) {
      const c = this.at(x, z);
      add(p, new THREE.BoxGeometry(1.8, 1.1, 0.8), dark, 'metal', [c[0], c[1] + 0.55, c[2]], [0, yaw, 0]);
      add(p, new THREE.BoxGeometry(1.5, 0.6, 0.05), r.chance(0.5) ? '#4ad8ff' : '#ff8a3a', true, [c[0], c[1] + 1.35, c[2]], [-0.4, yaw, 0], undefined, 1.2);
    }
    for (const z of [-2, 2]) {
      const c = this.at(31, z);
      add(p, new THREE.BoxGeometry(0.8, 0.9, 0.8), rust, false, [c[0], c[1] + 0.45, c[2]]);
      add(p, new THREE.BoxGeometry(0.8, 1, 0.2), rust, false, [c[0] - 0.4, c[1] + 1.2, c[2]], [0, 0, -0.2]);
    }
    const lg = this.at(s.goal.x, s.goal.z);
    add(p, new THREE.CylinderGeometry(0.6, 0.8, 1.1, 8), dark, 'metal', [lg[0], lg[1] + 0.55, lg[2]]);
    add(p, new THREE.CylinderGeometry(0.5, 0.5, 0.05, 12), '#6af0ff', true, [lg[0], lg[1] + 1.15, lg[2]], undefined, undefined, 2);
    this.light([lg[0], lg[1] + 1.6, lg[2]], new THREE.Color(0.5, 1.6, 2.2), 2.2, true);
    // quarters: bunks and lockers
    for (const [x, z] of [[13, 8], [19, 8], [13, -8], [24, -8]]) {
      const c = this.at(x, z);
      add(p, new THREE.BoxGeometry(3.4, 0.6, 1.4), inner, false, [c[0], c[1] + 0.5, c[2]]);
      add(p, new THREE.BoxGeometry(3.4, 0.6, 1.4), inner, false, [c[0], c[1] + 2, c[2]]);
    }
    for (const [x, z] of [[24.8, 6], [24.8, 4], [11, -4]]) {
      const c = this.at(x, z);
      add(p, new THREE.BoxGeometry(0.6, 2.2, 1.1), rust, false, [c[0], c[1] + 1.1, c[2]], [0, 0, r.range(-0.15, 0.15)]);
    }
    // hold: containers (the solid low blocks) and a crane rail
    for (const b of s.blocks.filter((x) => x.r > 0.8 && x.tall < 2)) {
      const loc = this.local(b.dir, b.h, -0.2);
      add(p, new THREE.BoxGeometry(2.2, 1.6, 1.7), r.pick(['#8a6a3a', '#5a6a4a', '#4a5a7a', rust]), false, [loc[0], loc[1] + 0.8, loc[2]], [0, r.range(-0.3, 0.3), 0]);
    }
    const cr0 = this.at(-15, 0), cr1 = this.at(9, 0);
    this.beam(p, cr0, cr1, top - 0.6, 0.5, 0.6, dark);
    // reactor: the cracked core, pipes, green glow
    const rc = this.at(-26, 0, -0.5);
    add(p, new THREE.CylinderGeometry(2.2, 2.4, 5.5, 10), dark, 'metal', [rc[0], rc[1] + 2.75, rc[2]]);
    for (const y of [1.2, 2.6, 4]) add(p, new THREE.TorusGeometry(2.3, 0.18, 6, 14).rotateX(Math.PI / 2), '#7aff6a', true, [rc[0], rc[1] + y, rc[2]], undefined, undefined, 2.2);
    add(p, new THREE.BoxGeometry(0.5, 3.4, 1.4), '#9aff6a', true, [rc[0] + 2.2, rc[1] + 2.6, rc[2] + 0.4], [0, 0, 0.1], undefined, 2.6);
    for (const z of [-7, 7]) {
      const a = this.at(-34, z), b = this.at(-18, z);
      this.beam(p, a, b, a[1] + 3.6, 0.5, 0.5, rust);
    }
    this.light([rc[0], rc[1] + 3, rc[2]], new THREE.Color(0.8, 2.6, 0.6), 9);
    // emergency strips along the corridor ceiling and sparking panels
    for (let x = -14; x <= 30; x += 4) {
      const c = this.at(x, 0);
      add(p, new THREE.BoxGeometry(1.6, 0.12, 0.25), '#ff3030', true, [c[0], top - 0.35, c[2]], undefined, undefined, 1.6);
    }
    for (const [x, z] of [[8, -9.6], [-15.6, 6], [26, 3]]) {
      const c = this.at(x, z);
      this.light([c[0], c[1] + 2.4, c[2]], new THREE.Color(2.2, 1.8, 0.8), 1.4, true);
    }
  }

  /** Horizontal box spanning two local points (centre height `y`). */
  private beam(p: Parts, a: number[], b: number[], y: number, h: number, depth: number, color: string, trim = 1) {
    const dx = b[0] - a[0], dz = b[2] - a[2];
    add(p, new THREE.BoxGeometry(Math.hypot(dx, dz) + trim, h, depth), color, false, [(a[0] + b[0]) / 2, y, (a[2] + b[2]) / 2], [0, Math.atan2(-dz, dx), 0]);
  }

  private local(dir: { x: number; y: number; z: number }, h: number, lift: number): number[] {
    tmp.set(dir.x, dir.y, dir.z).multiplyScalar(this.pl.radius + h).sub(this.center).applyQuaternion(this.inv);
    return [tmp.x, tmp.y + lift, tmp.z];
  }

  /** Sits the whole site on the terrain as currently drawn (coarse LOD far away). */
  ground(pv: PlanetView) {
    if (pv.lodVersion === this.lod) return;
    this.lod = pv.lodVersion;
    this.group.position.copy(this.center).addScaledVector(this.up, pv.groundDelta(this.site.dir, this.site.h));
  }

  update(time: number) {
    const on = Math.sin(time * 3 + this.site.seed) > 0;
    for (const b of this.blink) b.visible = on;
    if (this.dome?.visible) (this.dome.material as THREE.MeshBasicMaterial).opacity = 0.12 + 0.06 * Math.sin(time * 2.2 + this.site.seed);
  }

  /** A pirate base's state: dome up while its generator stands, door lamps and flag by who holds it. */
  setBase(info: BaseInfo | undefined, mine: boolean) {
    if (!info) return;
    const key = `${info.state}:${info.shield}:${mine}`;
    if (key === this.baseKey) return;
    this.baseKey = key;
    if (this.dome) this.dome.visible = info.shield;
    this.doorColor.set(info.state === 'held' ? (mine ? DOOR_COLORS.mine : DOOR_COLORS.theirs) : info.state === 'open' ? DOOR_COLORS.open : DOOR_COLORS.sealed);
    if (this.doorMat) { this.doorMat.emissive.copy(this.doorColor); this.doorMat.color.copy(this.doorColor); }
    if (this.flag) (this.flag.material as THREE.MeshStandardMaterial).color.set(info.state === 'held' ? '#2a8ad8' : '#e8485a');
  }

  dispose() {
    this.group.removeFromParent();
    // the blockhouse shares its geometry with every other copy of the model
    this.gate?.removeFromParent();
    this.doorMat?.dispose();
    this.group.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); if (o instanceof THREE.Sprite) o.material.dispose(); });
  }
}
