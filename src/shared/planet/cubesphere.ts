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
