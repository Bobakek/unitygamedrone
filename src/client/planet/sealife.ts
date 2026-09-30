import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { PlanetDef, PlanetType } from '../../shared/galaxy/system-gen.ts';
import { qrot, v3, vcross, vnorm, type Quat, type V3 } from '../../shared/math/vec.ts';
import { scatter } from '../../shared/planet/resources.ts';
import { heightAt, liquidOf } from '../../shared/planet/terrain.ts';
import { add, newParts } from '../entities/ship-builder.ts';

interface FishKind { body: string; belly: string; fin: string; size: number; glow: string | null }
const FISH: Partial<Record<PlanetType, FishKind[]>> = {
  terran: [
    { body: '#9ab0c0', belly: '#e8eef2', fin: '#6a8aa0', size: 0.55, glow: null },
    { body: '#f0c83a', belly: '#fff0a0', fin: '#d08a20', size: 0.7, glow: null },
    { body: '#3a6ad0', belly: '#a0d0ff', fin: '#f0f0f0', size: 0.8, glow: null },
  ],
  ocean: [
    { body: '#ff7a2a', belly: '#fff0e0', fin: '#202020', size: 0.6, glow: null },
    { body: '#2a8ae0', belly: '#f0e04a', fin: '#1a4a9a', size: 0.75, glow: null },
    { body: '#c0d0d8', belly: '#ffffff', fin: '#7a9aa8', size: 0.5, glow: null },
  ],
  alien: [
    { body: '#1a6a7a', belly: '#8affe8', fin: '#2ee6c9', size: 0.6, glow: '#2ee6c9' },
    { body: '#6a2a8a', belly: '#ffb0f0', fin: '#ff5ad0', size: 0.75, glow: '#ff5ad0' },
    { body: '#4a7a2a', belly: '#e0ff8a', fin: '#b0ff4a', size: 0.5, glow: '#b0ff4a' },
  ],
};
const JELLY: Partial<Record<PlanetType, string>> = { ocean: '#9ad8ff', alien: '#ff8ae8', terran: '#c8b0ff' };

const uTime = { value: 0 };
const uNight = { value: 0 };

/** Low-poly fish along +Z with an `aTail` weight (0 at the head, 1 at the tail tip). */
function fishGeometry(k: FishKind): THREE.BufferGeometry {
  const p = newParts();
  add(p, new THREE.IcosahedronGeometry(0.5, 0), k.body, false, [0, 0.03, 0], [0, 0, 0], [0.32, 0.5, 1]);
  add(p, new THREE.IcosahedronGeometry(0.42, 0), k.belly, false, [0, -0.08, 0.05], [0, 0, 0], [0.26, 0.3, 0.85]);
  add(p, new THREE.ConeGeometry(0.28, 0.42, 3), k.fin, false, [0, 0.02, -0.62], [-Math.PI / 2, 0, 0], [0.25, 1, 1.25]);
  add(p, new THREE.ConeGeometry(0.12, 0.32, 3), k.fin, false, [0, 0.3, -0.05], [-0.5, 0, 0], [0.25, 1, 1.4]);
  add(p, new THREE.SphereGeometry(0.05, 4, 3), '#101010', false, [0.13, 0.08, 0.33]);
  add(p, new THREE.SphereGeometry(0.05, 4, 3), '#101010', false, [-0.13, 0.08, 0.33]);
  const g = mergeGeometries(p.hull)!;
  const pos = g.getAttribute('position');
  const tail = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) tail[i] = Math.max(0, Math.min(1, (0.25 - pos.getZ(i)) / 0.85));
  g.setAttribute('aTail', new THREE.BufferAttribute(tail, 1));
  g.scale(k.size, k.size, k.size);
  return g;
}

function fishMaterial(k: FishKind): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.45, metalness: 0.25 });
  if (k.glow) { m.emissive.set(k.glow); m.emissiveIntensity = 0.35; }
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uTime;
    sh.vertexShader = 'attribute float aTail;\nuniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vec3 ip = instanceMatrix[3].xyz;
      float ph = uTime * 9.0 + dot(ip, vec3(1.7, 2.3, 3.1));
      transformed.x += sin(ph - position.z * 3.5) * (0.02 + 0.2 * aTail * aTail);`);
  };
  m.customProgramCacheKey = () => 'fish';
  return m;
}

/** Jellyfish: a translucent bell (pulsing) with trailing tentacles; `aTail` weights the sway. */
function jellyGeometry(): THREE.BufferGeometry {
  const p = newParts();
  add(p, new THREE.SphereGeometry(0.42, 9, 5, 0, Math.PI * 2, 0, Math.PI / 2), '#ffffff', false, [0, 0, 0], [0, 0, 0], [1, 0.8, 1]);
  add(p, new THREE.CylinderGeometry(0.2, 0.28, 0.12, 9, 1, true), '#ffffff', false, [0, -0.02, 0]);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2, l = 0.8 + (i % 3) * 0.35;
    add(p, new THREE.CylinderGeometry(0.012, 0.02, l, 3), '#ffffff', false, [Math.cos(a) * 0.26, -l / 2, Math.sin(a) * 0.26]);
  }
  add(p, new THREE.CylinderGeometry(0.06, 0.12, 0.6, 5), '#ffffff', false, [0, -0.32, 0]);
  const g = mergeGeometries(p.hull)!;
  const pos = g.getAttribute('position');
  const w = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) w[i] = Math.max(0, -pos.getY(i));
  g.setAttribute('aTail', new THREE.BufferAttribute(w, 1));
  return g;
}

function jellyMaterial(color: string): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.62, roughness: 0.2, metalness: 0, emissive: color, emissiveIntensity: 0.25, depthWrite: false, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uTime;
    sh.uniforms.uNight = uNight;
    sh.vertexShader = 'attribute float aTail;\nuniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vec3 ip = instanceMatrix[3].xyz;
      float ph = uTime * 2.1 + dot(ip, vec3(0.7, 1.3, 0.9));
      float pulse = sin(ph);
      if (position.y > -0.05) transformed.xz *= 1.0 + 0.16 * pulse; else transformed.y *= 1.0 - 0.1 * pulse;
      transformed.x += sin(ph * 0.8 - position.y * 3.0) * 0.12 * aTail;
      transformed.z += cos(ph * 0.7 - position.y * 2.5) * 0.1 * aTail;`);
    sh.fragmentShader = 'uniform float uNight;\n' + sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      totalEmissiveRadiance *= 1.0 + uNight * 5.0;`);
  };
  m.customProgramCacheKey = () => 'jelly';
  return m;
}

interface School {
  id: number;
  dir: V3; t1: V3; t2: V3;
  depth: number; orbit: number; speed: number; phase: number;
  kind: number; n: number;
  offs: Float32Array;
  flee: Float32Array;
}
interface Jelly { dir: V3; t1: V3; t2: V3; depth: number; phase: number; drift: number }

const MAX_FISH = 520;
const MAX_JELLY = 40;
const REFRESH = 30;

/**
 * Ambient sea life of water worlds, simulated on the client only and seeded
 * from the planet, so everyone sees the same schools in the same waters:
 * schools of fish circling over the sea bed (and scattering from a diver) and
 * drifting, pulsing jellyfish that glow at night.
 */
export class SeaLife {
  readonly group = new THREE.Group();
  private planet: PlanetDef | null = null;
  private fish: THREE.InstancedMesh[] = [];
  private jelly: THREE.InstancedMesh | null = null;
  private schools = new Map<number, School>();
  private jellies: Jelly[] = [];
  private last = v3(1e12, 0, 0);
  private anchor = v3();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private p = new THREE.Vector3();
  private basis = new THREE.Matrix4();

  /** Fish currently drawn (for tests / debugging). */
  count = 0;

  private setPlanet(pl: PlanetDef | null) {
    for (const f of this.fish) { f.removeFromParent(); f.dispose(); }
    this.jelly?.removeFromParent();
    this.jelly?.dispose();
    this.fish = [];
    this.jelly = null;
    this.schools.clear();
    this.jellies = [];
    this.last = v3(1e12, 0, 0);
    this.planet = pl;
    const kinds = pl ? FISH[pl.type] : undefined;
    if (!pl || !kinds) return;
    this.fish = kinds.map((k) => {
      const im = new THREE.InstancedMesh(fishGeometry(k), fishMaterial(k), MAX_FISH);
      im.count = 0;
      im.frustumCulled = false;
      this.group.add(im);
      return im;
    });
    const jc = JELLY[pl.type];
    if (jc) {
      this.jelly = new THREE.InstancedMesh(jellyGeometry(), jellyMaterial(jc), MAX_JELLY);
      this.jelly.count = 0;
      this.jelly.frustumCulled = false;
      this.group.add(this.jelly);
    }
  }

  /**
   * `pl` = planet the camera is near (or null), `camB` = camera in its body frame,
   * `diverB` = the local swimmer (fish scatter away), `day` = daylight 0..1.
   */
  update(pl: PlanetDef | null, camB: V3, diverB: V3 | null, time: number, dt: number, day: number) {
    uTime.value = time;
    uNight.value = 1 - day;
    const wet = pl && liquidOf(pl) === 'water' ? pl : null;
    if (wet !== this.planet) this.setPlanet(wet);
    const alt = wet ? Math.hypot(camB.x, camB.y, camB.z) - wet.radius : 1e9;
    this.group.visible = !!wet && alt < 160;
    if (!wet || !this.group.visible) { this.count = 0; return; }
    if (Math.hypot(camB.x - this.last.x, camB.y - this.last.y, camB.z - this.last.z) > REFRESH) this.refresh(wet, camB);
    this.simulate(wet, diverB, time, dt);
  }

  /** Re-scatters schools and jellyfish around the camera (keeps the ones still in range). */
  private refresh(pl: PlanetDef, camB: V3) {
    this.last = { ...camB };
    this.anchor = { ...camB };
    const l = Math.hypot(camB.x, camB.y, camB.z);
    const d = v3(camB.x / l, camB.y / l, camB.z / l);
    const cellM = 42, grid = Math.round((Math.PI / 2) * pl.radius / cellM);
    const keep = new Map<number, School>();
    for (const pt of scatter(pl, d, 170, grid, 0.34, 0x5f1, true)) {
      if (pt.h > -3) continue;
      const old = this.schools.get(pt.id);
      if (old) { keep.set(pt.id, old); continue; }
      const t1 = vnorm(v3(), vcross(v3(), pt.dir, Math.abs(pt.dir.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0)));
      const t2 = vcross(v3(), pt.dir, t1);
      // shrink the loop until it stays over water at least 2.5 m deep
      let orbit = 4 + pt.r[3] * 11;
      let minDepth = -pt.h;
      for (let tries = 0; tries < 4; tries++) {
        minDepth = -pt.h;
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          const q = vnorm(v3(), v3(pt.dir.x * pl.radius + (t1.x * Math.cos(a) + t2.x * Math.sin(a)) * orbit, pt.dir.y * pl.radius + (t1.y * Math.cos(a) + t2.y * Math.sin(a)) * orbit, pt.dir.z * pl.radius + (t1.z * Math.cos(a) + t2.z * Math.sin(a)) * orbit));
          minDepth = Math.min(minDepth, -heightAt(pl, q.x, q.y, q.z));
        }
        if (minDepth > 2.5) break;
        orbit *= 0.5;
      }
      if (minDepth < 2) continue;
      const n = 8 + Math.floor(pt.r[0] * 20);
      const top = Math.min(minDepth - 1, 24);
      const sc: School = {
        id: pt.id, dir: pt.dir, t1, t2, depth: 1.2 + pt.r[2] * Math.max(0, top - 1.2), orbit, speed: 0.9 + pt.r[1] * 1.4,
        phase: pt.r[1] * Math.PI * 2 + pt.r[3] * 17, kind: Math.floor(pt.r[1] * 2.999), n, offs: new Float32Array(n * 3), flee: new Float32Array(n * 3),
      };
      // fixed places in the school (a loose ellipsoid), from a tiny LCG on the id
      let seed = (pt.id * 2654435761) >>> 0;
      const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
      const spread = 1 + n / 12;
      for (let i = 0; i < n; i++) {
        sc.offs[i * 3] = (rnd() - 0.5) * 2.2 * spread;
        sc.offs[i * 3 + 1] = (rnd() - 0.5) * 0.9 * spread;
        sc.offs[i * 3 + 2] = (rnd() - 0.5) * 2.6 * spread;
      }
      keep.set(pt.id, sc);
    }
    this.schools = keep;
    this.jellies = [];
    if (this.jelly) {
      for (const pt of scatter(pl, d, 140, Math.round((Math.PI / 2) * pl.radius / 26), 0.3, 0x3e11, true)) {
        if (pt.h > -4 || this.jellies.length >= MAX_JELLY) continue;
        const t1 = vnorm(v3(), vcross(v3(), pt.dir, Math.abs(pt.dir.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0)));
        this.jellies.push({ dir: pt.dir, t1, t2: vcross(v3(), pt.dir, t1), depth: 1.5 + pt.r[0] * Math.min(-pt.h - 2.5, 14), phase: pt.r[1] * 20, drift: 0.5 + pt.r[2] * 1.5 });
      }
    }
  }

  private simulate(pl: PlanetDef, diver: V3 | null, time: number, dt: number) {
    const counts = this.fish.map(() => 0);
    const A = this.anchor, R = pl.radius;
    const up = new THREE.Vector3(), fwd = new THREE.Vector3(), right = new THREE.Vector3(), c = new THREE.Vector3(), o = new THREE.Vector3();
    const k = Math.min(1, dt * 1.5);
    for (const sc of this.schools.values()) {
      const im = this.fish[sc.kind];
      if (!im) continue;
      const ang = sc.phase + (time * sc.speed) / sc.orbit;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const r = R - sc.depth + Math.sin(time * 0.3 + sc.phase) * Math.min(0.6, sc.depth * 0.3);
      c.set(sc.dir.x * R + (sc.t1.x * ca + sc.t2.x * sa) * sc.orbit, sc.dir.y * R + (sc.t1.y * ca + sc.t2.y * sa) * sc.orbit, sc.dir.z * R + (sc.t1.z * ca + sc.t2.z * sa) * sc.orbit);
      up.copy(c).normalize();
      c.copy(up).multiplyScalar(r);
      fwd.set(-sc.t1.x * sa + sc.t2.x * ca, -sc.t1.y * sa + sc.t2.y * ca, -sc.t1.z * sa + sc.t2.z * ca);
      fwd.addScaledVector(up, -fwd.dot(up)).normalize();
      right.crossVectors(fwd, up);
      // columns: right, up, -fwd → the fish model faces +Z, so use fwd as +Z
      this.basis.makeBasis(right.clone().negate(), up, fwd);
      this.q.setFromRotationMatrix(this.basis);
      for (let i = 0; i < sc.n && counts[sc.kind] < MAX_FISH; i++) {
        const ox = sc.offs[i * 3], oy = sc.offs[i * 3 + 1], oz = sc.offs[i * 3 + 2];
        // a little individual wander around the fish's place in the school
        const w = time * 0.9 + i * 1.7;
        o.set(ox + Math.sin(w) * 0.3, oy + Math.sin(w * 1.3) * 0.15, oz + Math.cos(w * 0.7) * 0.3);
        this.p.copy(c).addScaledVector(right, -o.x).addScaledVector(up, o.y).addScaledVector(fwd, o.z);
        // scatter from the diver
        if (diver) {
          const dx = this.p.x - diver.x, dy = this.p.y - diver.y, dz = this.p.z - diver.z;
          const d = Math.hypot(dx, dy, dz);
          const push = d < 6 && d > 1e-3 ? (6 - d) * 0.9 / d : 0;
          sc.flee[i * 3] += (dx * push - sc.flee[i * 3]) * k;
          sc.flee[i * 3 + 1] += (dy * push - sc.flee[i * 3 + 1]) * k;
          sc.flee[i * 3 + 2] += (dz * push - sc.flee[i * 3 + 2]) * k;
        }
        this.p.x += sc.flee[i * 3] - A.x; this.p.y += sc.flee[i * 3 + 1] - A.y; this.p.z += sc.flee[i * 3 + 2] - A.z;
        this.m.compose(this.p, this.q, this.s.setScalar(0.85 + ((i * 7) % 5) * 0.08));
        im.setMatrixAt(counts[sc.kind]++, this.m);
      }
    }
    this.count = 0;
    this.fish.forEach((im, i) => { im.count = counts[i]; im.instanceMatrix.needsUpdate = true; this.count += counts[i]; });
    if (this.jelly) {
      let n = 0;
      for (const j of this.jellies) {
        const a = time * 0.05 * j.drift + j.phase;
        const r = R - j.depth + Math.sin(time * 0.4 + j.phase) * 0.8;
        c.set(j.dir.x * R + (j.t1.x * Math.cos(a) + j.t2.x * Math.sin(a)) * 3, j.dir.y * R + (j.t1.y * Math.cos(a) + j.t2.y * Math.sin(a)) * 3, j.dir.z * R + (j.t1.z * Math.cos(a) + j.t2.z * Math.sin(a)) * 3);
        up.copy(c).normalize();
        this.p.copy(up).multiplyScalar(r).sub(o.set(A.x, A.y, A.z));
        this.q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
        this.m.compose(this.p, this.q, this.s.setScalar(0.8 + (j.drift - 0.5) * 0.5));
        this.jelly.setMatrixAt(n++, this.m);
      }
      this.jelly.count = n;
      this.jelly.instanceMatrix.needsUpdate = true;
    }
  }

  /** Places the group (instances are relative to a body-frame anchor) at the render origin. */
  sync(origin: V3, rot: Quat) {
    const pl = this.planet;
    if (!pl) return;
    const t = qrot(v3(), rot, this.anchor);
    this.group.position.set(pl.center.x + t.x - origin.x, pl.center.y + t.y - origin.y, pl.center.z + t.z - origin.z);
    this.group.quaternion.set(rot.x, rot.y, rot.z, rot.w);
  }
}
