import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rng } from '../../shared/math/rng.ts';
import type { Blueprint } from '../../shared/ships/blueprint.ts';

/**
 * Procedural low-poly ship construction. Parts are authored nose-towards-+Z
 * (as in the approved reference renders) and the result is rotated so the
 * nose points along -Z, matching the simulation's forward axis.
 */
export interface BuiltShip {
  hull: THREE.BufferGeometry;
  glow: THREE.BufferGeometry;
  engines: { pos: THREE.Vector3; r: number }[];
  radius: number;
}

const SEG = 7;
export type Parts = { hull: THREE.BufferGeometry[]; glow: THREE.BufferGeometry[]; engines: { pos: THREE.Vector3; r: number }[] };
export const newParts = (): Parts => ({ hull: [], glow: [], engines: [] });
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();

/** Adds a transformed, vertex-coloured copy of `geo` to the part list (glow parts are unlit). */
export function add(parts: Parts, geo: THREE.BufferGeometry, color: string, glow: boolean, pos: number[] = [0, 0, 0], rot: number[] = [0, 0, 0], scl: number[] = [1, 1, 1], intensity = 2.4) {
  let g = geo.index ? geo.toNonIndexed() : geo;
  g = g.clone();
  if (g.getAttribute('uv')) g.deleteAttribute('uv');
  _m.compose(_p.set(pos[0], pos[1], pos[2]), _q.setFromEuler(_e.set(rot[0], rot[1], rot[2])), _s.set(scl[0], scl[1], scl[2]));
  g.applyMatrix4(_m);
  g.computeVertexNormals();
  const c = new THREE.Color(color);
  if (glow) c.multiplyScalar(intensity);
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  (glow ? parts.glow : parts.hull).push(g);
}

export function taperedBox(w: number, h: number, l: number, front = 0.3, back = 1, frontY: number | null = null) {
  const g = new THREE.BoxGeometry(w, h, l);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = p.getZ(i) / l + 0.5;
    p.setX(i, p.getX(i) * THREE.MathUtils.lerp(back, front, t));
    p.setY(i, p.getY(i) * THREE.MathUtils.lerp(back, frontY ?? front, t));
  }
  return g;
}

export function wingGeo(span: number, root: number, tip: number, sweep: number, thick: number) {
  const s = new THREE.Shape();
  s.moveTo(0, root / 2);
  s.lineTo(span, root / 2 - sweep);
  s.lineTo(span, root / 2 - sweep - tip);
  s.lineTo(0, -root / 2);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: false });
  g.rotateX(Math.PI / 2);
  g.translate(0, thick / 2, 0);
  return g;
}

const cyl = (rt: number, rb: number, h: number, n = SEG) => new THREE.CylinderGeometry(rt, rb, h, n).rotateX(Math.PI / 2);

function fighter(bp: Blueprint, parts: Parts) {
  const r = new Rng(bp.seed);
  const span = r.range(3.3, 4.1), sweep = r.range(1.6, 2.4), len = r.range(6.6, 7.6), fin = r.range(1.4, 2.0);
  const tipX = 0.5 + span;
  add(parts, taperedBox(1.7, 1.15, len, 0.28, 1, 0.45), bp.hull, false, [0, 0, 0.4]);
  add(parts, new THREE.ConeGeometry(0.3, 1.6, SEG).rotateX(Math.PI / 2), bp.accent, false, [0, 0, 0.4 + len / 2 + 0.8]);
  add(parts, new THREE.SphereGeometry(0.62, SEG, 4), bp.glass, false, [0, 0.42, 1.5], [0, 0, 0], [0.75, 0.75, 2.3]);
  add(parts, taperedBox(0.6, 0.45, 3.2, 0.5, 1), bp.hull2, false, [0, 0.55, -1.4]);
  add(parts, wingGeo(fin, 2.2, 0.8, 1.3, 0.16).rotateZ(Math.PI / 2), bp.accent, false, [0, 0.7, -2.3]);
  for (const s of [-1, 1]) {
    add(parts, wingGeo(s * span, 3.4, 1.1, sweep, 0.2), bp.hull2, false, [s * 0.5, -0.15, -0.6], [0, 0, s * -0.06]);
    add(parts, wingGeo(s * span * 0.8, 1.0, 0.45, sweep * 0.8, 0.24), bp.accent, false, [s * 0.5, -0.15, 0.6], [0, 0, s * -0.06]);
    add(parts, cyl(0.09, 0.09, 2.6, 6), bp.engine, false, [s * tipX, -0.4, 1.1 - sweep]);
    add(parts, taperedBox(0.14, 1.0, 1.4, 0.45, 1), bp.accent, false, [s * tipX, 0.05, -0.2 - sweep]);
    add(parts, new THREE.SphereGeometry(0.1, 5, 3), s < 0 ? '#ff3040' : '#30ff70', true, [s * tipX, 0.6, -0.6 - sweep]);
    add(parts, cyl(0.46, 0.56, 2.6), bp.engine, false, [s * 0.78, -0.05, -3.3]);
    add(parts, cyl(0.4, 0.4, 0.05), bp.glow, true, [s * 0.78, -0.05, -4.62], undefined, undefined, 1.1);
    parts.engines.push({ pos: new THREE.Vector3(s * 0.78, -0.05, -4.65), r: 0.42 });
    add(parts, new THREE.CylinderGeometry(0.07, 0.09, 1.3, 5), bp.engine, false, [s * 1.4, -1.05, -1.8]);
    add(parts, new THREE.CylinderGeometry(0.28, 0.34, 0.1, 7), bp.engine, false, [s * 1.4, -1.7, -1.8]);
  }
  add(parts, new THREE.CylinderGeometry(0.07, 0.09, 1.3, 5), bp.engine, false, [0, -1.05, 2.2]);
  add(parts, new THREE.CylinderGeometry(0.28, 0.34, 0.1, 7), bp.engine, false, [0, -1.7, 2.2]);
}

function pirate(bp: Blueprint, parts: Parts) {
  const r = new Rng(bp.seed);
  const spikes = r.int(2, 4), podLen = r.range(5.5, 7);
  add(parts, taperedBox(3.0, 1.7, 9, 0.4, 0.85, 0.35), bp.hull, false);
  add(parts, taperedBox(3.8, 0.5, 6.5, 0.55, 1), bp.hull2, false, [0, 0.7, -0.6]);
  add(parts, new THREE.BoxGeometry(1.4, 0.28, 0.9), bp.glass, false, [0, 0.45, 3.0], [-0.3, 0, 0]);
  add(parts, cyl(0.75, 0.9, 1.8), bp.engine, false, [0, 0.2, -5.0]);
  add(parts, cyl(0.62, 0.62, 0.05), bp.glow, true, [0, 0.2, -5.92], undefined, undefined, 1.1);
  parts.engines.push({ pos: new THREE.Vector3(0, 0.2, -5.95), r: 0.65 });
  add(parts, new THREE.CylinderGeometry(0.04, 0.04, 2.5, 4), bp.engine, false, [0.9, 1.9, -2.0], [0, 0, 0.2]);
  for (const s of [-1, 1]) {
    add(parts, taperedBox(0.7, 0.9, 5.2, 0.12, 1, 0.3), bp.accent, false, [s * 1.25, -0.2, 5.2], [0, -s * 0.13, 0]);
    add(parts, cyl(0.95, 1.0, podLen), bp.hull2, false, [s * 2.5, -0.35, -1.6]);
    add(parts, new THREE.ConeGeometry(0.95, 1.8, SEG).rotateX(Math.PI / 2), bp.hull, false, [s * 2.5, -0.35, -1.6 + podLen / 2 + 0.9]);
    for (let k = 0; k < spikes; k++) add(parts, new THREE.ConeGeometry(0.22, 1.4, 4), bp.accent, false, [s * 2.7, 1.1, -3.6 + k * 1.6], [0, 0, -s * 0.4]);
    add(parts, cyl(0.55, 0.7, 1.6), bp.engine, false, [s * 2.5, -0.35, -5.4]);
    add(parts, cyl(0.5, 0.5, 0.05), bp.glow, true, [s * 2.5, -0.35, -6.22], undefined, undefined, 1.1);
    parts.engines.push({ pos: new THREE.Vector3(s * 2.5, -0.35, -6.25), r: 0.5 });
    add(parts, cyl(0.12, 0.12, 3, 5), bp.engine, false, [s * 0.9, -0.8, 4.4]);
    add(parts, new THREE.SphereGeometry(0.12, 5, 3), '#ff3040', true, [s * 3.45, -0.35, -1.6]);
  }
}

const cache = new Map<string, BuiltShip>();

export function buildShip(bp: Blueprint): BuiltShip {
  const key = `${bp.cls}:${bp.seed}:${bp.hull}:${bp.hull2}:${bp.accent}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const parts: Parts = { hull: [], glow: [], engines: [] };
  if (bp.cls === 'pirate') pirate(bp, parts); else fighter(bp, parts);
  const hull = mergeGeometries(parts.hull)!;
  const glow = mergeGeometries(parts.glow)!;
  // nose from +Z to -Z
  hull.rotateY(Math.PI);
  glow.rotateY(Math.PI);
  hull.computeBoundingSphere();
  const engines = parts.engines.map((e) => ({ pos: new THREE.Vector3(-e.pos.x, e.pos.y, -e.pos.z), r: e.r }));
  const built = { hull, glow, engines, radius: hull.boundingSphere!.radius };
  cache.set(key, built);
  return built;
}

/** Low-poly astronaut: static body plus pivoting limbs for a procedural walk cycle. */
export interface BuiltAstronaut { body: THREE.BufferGeometry; leg: THREE.BufferGeometry; arm: THREE.BufferGeometry }
let astro: BuiltAstronaut | null = null;
export function buildAstronaut(): BuiltAstronaut {
  if (astro) return astro;
  const body: Parts = { hull: [], glow: [], engines: [] };
  add(body, new THREE.CapsuleGeometry(0.26, 0.36, 3, 7), '#f4f1ea', false, [0, 1.15, 0]);
  add(body, new THREE.BoxGeometry(0.42, 0.52, 0.22), '#f39a4a', false, [0, 1.2, 0.26]);
  add(body, new THREE.SphereGeometry(0.24, 7, 5), '#d9d4c7', false, [0, 1.63, 0]);
  add(body, new THREE.SphereGeometry(0.2, 7, 5), '#ffc85a', false, [0, 1.64, -0.1], [0, 0, 0], [0.95, 0.75, 0.75]);
  add(body, new THREE.SphereGeometry(0.045, 5, 3), '#8ff8ff', true, [0.2, 1.72, -0.08]);
  const leg: Parts = { hull: [], glow: [], engines: [] };
  add(leg, new THREE.CapsuleGeometry(0.12, 0.62, 3, 6), '#f4f1ea', false, [0, -0.4, 0]);
  const arm: Parts = { hull: [], glow: [], engines: [] };
  add(arm, new THREE.CapsuleGeometry(0.085, 0.5, 3, 6), '#f4f1ea', false, [0, -0.3, 0]);
  const bodyGeo = mergeGeometries([...body.hull, ...body.glow])!;
  astro = { body: bodyGeo, leg: mergeGeometries(leg.hull)!, arm: mergeGeometries(arm.hull)! };
  return astro;
}
