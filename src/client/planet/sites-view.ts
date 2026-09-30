import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { PlanetDef, PlanetType } from '../../shared/galaxy/system-gen.ts';
import { Rng } from '../../shared/math/rng.ts';
import { siteDir, TURRET_HEIGHT, type SiteDef } from '../../shared/planet/sites.ts';
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
    if (s.kind === 'ruin') this.ruin(p); else this.base(p);
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
        const fa = r.range(0, Math.PI * 2);
        const fp = this.at(x + Math.cos(fa) * 4, z + Math.sin(fa) * 4, 0.6);
        add(p, new THREE.CylinderGeometry(c.r * 0.85, c.r * 0.85, r.range(3, 5), 6), stone, false, fp, [0, fa, Math.PI / 2]);
      }
    });
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
    // perimeter wall with gaps and spikes
    const segs = 12, R = 50;
    for (let k = 0; k < segs; k++) {
      if (k === 2 || k === 8) continue;
      const a0 = (k / segs) * Math.PI * 2, a1 = ((k + 1) / segs) * Math.PI * 2;
      const w0 = this.at(Math.cos(a0) * R, Math.sin(a0) * R, -1.5), w1 = this.at(Math.cos(a1) * R, Math.sin(a1) * R, -1.5);
      const lo = Math.min(w0[1], w1[1]), hi = Math.max(w0[1], w1[1]) + 5.5;
      this.beam(p, w0, w1, (lo + hi) / 2, hi - lo, 1.4, k % 2 ? hull : steel, -0.5);
      for (const f of [0.2, 0.5, 0.8]) {
        add(p, new THREE.ConeGeometry(0.35, 1.8, 4), accent, false, [w0[0] + (w1[0] - w0[0]) * f, Math.max(w0[1], w1[1]) + 6.2, w0[2] + (w1[2] - w0[2]) * f]);
      }
    }
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
    // antenna mast and banner
    const m = this.at(18, -20, -1);
    add(p, new THREE.CylinderGeometry(0.25, 0.45, 26, 5), steel, 'metal', [m[0], m[1] + 13, m[2]]);
    add(p, new THREE.BoxGeometry(5, 3, 0.15), accent, false, [m[0] + 2.6, m[1] + 22, m[2]]);
    add(p, new THREE.BoxGeometry(1.4, 1.4, 0.2), dark, false, [m[0] + 2.6, m[1] + 22, m[2] + 0.1]);
    this.light([m[0], m[1] + 26.5, m[2]], new THREE.Color(3, 0.4, 0.3), 5, true);
    // floodlights
    for (const [x, z] of [[30, 30], [-34, -26], [36, -14]]) {
      const f = this.at(x, z, -1);
      add(p, new THREE.CylinderGeometry(0.2, 0.3, 9, 5), steel, 'metal', [f[0], f[1] + 4.5, f[2]]);
      this.light([f[0], f[1] + 9.3, f[2]], new THREE.Color(2.2, 1.9, 1.4), 6);
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
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); if (o instanceof THREE.Sprite) o.material.dispose(); });
  }
}
