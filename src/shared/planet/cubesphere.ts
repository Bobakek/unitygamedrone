import type { V3 } from '../math/vec.ts';

/** Cube faces: outward normal N, tangent axes U and V with U × V = N. */
export const FACES: ReadonlyArray<{ n: V3; u: V3; v: V3 }> = [
  { n: { x: 1, y: 0, z: 0 }, u: { x: 0, y: 0, z: -1 }, v: { x: 0, y: 1, z: 0 } },
  { n: { x: -1, y: 0, z: 0 }, u: { x: 0, y: 0, z: 1 }, v: { x: 0, y: 1, z: 0 } },
  { n: { x: 0, y: 1, z: 0 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: -1 } },
  { n: { x: 0, y: -1, z: 0 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: 1 } },
  { n: { x: 0, y: 0, z: 1 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 } },
  { n: { x: 0, y: 0, z: -1 }, u: { x: -1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 } },
];

/** Maps face coordinates (u, v ∈ [-1, 1]) to a unit direction ("spherified cube"). */
export function cubeToSphere(face: number, u: number, v: number, out: V3): V3 {
  const F = FACES[face];
  const x = F.n.x + u * F.u.x + v * F.v.x;
  const y = F.n.y + u * F.u.y + v * F.v.y;
  const z = F.n.z + u * F.u.z + v * F.v.z;
  const x2 = x * x, y2 = y * y, z2 = z * z;
  out.x = x * Math.sqrt(1 - y2 / 2 - z2 / 2 + (y2 * z2) / 3);
  out.y = y * Math.sqrt(1 - z2 / 2 - x2 / 2 + (z2 * x2) / 3);
  out.z = z * Math.sqrt(1 - x2 / 2 - y2 / 2 + (x2 * y2) / 3);
  return out;
}

/** Simple gnomonic mapping (normalised cube point), invertible — used for resource/prop grids. */
export function gnomonic(face: number, u: number, v: number, out: V3): V3 {
  const F = FACES[face];
  const x = F.n.x + u * F.u.x + v * F.v.x;
  const y = F.n.y + u * F.u.y + v * F.v.y;
  const z = F.n.z + u * F.u.z + v * F.v.z;
  const l = Math.sqrt(x * x + y * y + z * z);
  out.x = x / l; out.y = y / l; out.z = z / l;
  return out;
}

/** Inverse gnomonic for a given face; returns null if the direction is not on that face's hemisphere. */
export function invGnomonic(face: number, d: V3): { u: number; v: number } | null {
  const F = FACES[face];
  const dn = d.x * F.n.x + d.y * F.n.y + d.z * F.n.z;
  if (dn <= 0.05) return null;
  const px = d.x / dn, py = d.y / dn, pz = d.z / dn;
  return { u: px * F.u.x + py * F.u.y + pz * F.u.z, v: px * F.v.x + py * F.v.y + pz * F.v.z };
}

export function chunkKey(face: number, level: number, x: number, y: number): string {
  return `${face}/${level}/${x}/${y}`;
}

/** Deepest quadtree level so that leaf cells are about `cellMeters` wide. */
export function maxLevelFor(radius: number, gridN: number, cellMeters: number): number {
  const faceEdge = (Math.PI / 2) * radius;
  return Math.max(3, Math.ceil(Math.log2(faceEdge / (gridN * cellMeters))));
}

/** Cube face whose region contains unit direction `d` (same regions for gnomonic and spherified maps). */
export function faceOf(d: V3): number {
  const ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z);
  if (ax >= ay && ax >= az) return d.x > 0 ? 0 : 1;
  if (ay >= az) return d.y > 0 ? 2 : 3;
  return d.z > 0 ? 4 : 5;
}

const _p = { x: 0, y: 0, z: 0 }, _pu = { x: 0, y: 0, z: 0 }, _pv = { x: 0, y: 0, z: 0 };

/**
 * Inverse of `cubeToSphere`: face coordinates of a unit direction. Starts from
 * the gnomonic inverse and refines with a few Gauss–Newton steps.
 */
export function sphereToCube(d: V3, out: { face: number; u: number; v: number } = { face: 0, u: 0, v: 0 }) {
  const face = faceOf(d);
  const g = invGnomonic(face, d) ?? { u: 0, v: 0 };
  let u = Math.max(-1, Math.min(1, g.u)), v = Math.max(-1, Math.min(1, g.v));
  const h = 1e-7;
  for (let it = 0; it < 5; it++) {
    cubeToSphere(face, u, v, _p);
    const rx = _p.x - d.x, ry = _p.y - d.y, rz = _p.z - d.z;
    if (rx * rx + ry * ry + rz * rz < 1e-26) break;
    cubeToSphere(face, u + h, v, _pu);
    cubeToSphere(face, u, v + h, _pv);
    const aux = (_pu.x - _p.x) / h, auy = (_pu.y - _p.y) / h, auz = (_pu.z - _p.z) / h;
    const avx = (_pv.x - _p.x) / h, avy = (_pv.y - _p.y) / h, avz = (_pv.z - _p.z) / h;
    // normal equations (JᵀJ) δ = −Jᵀr
    const a = aux * aux + auy * auy + auz * auz, b = aux * avx + auy * avy + auz * avz, c = avx * avx + avy * avy + avz * avz;
    const gu = -(aux * rx + auy * ry + auz * rz), gv = -(avx * rx + avy * ry + avz * rz);
    const det = a * c - b * b;
    if (Math.abs(det) < 1e-30) break;
    u += (c * gu - b * gv) / det;
    v += (a * gv - b * gu) / det;
  }
  out.face = face; out.u = u; out.v = v;
  return out;
}
