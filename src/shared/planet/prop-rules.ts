import type { PlanetDef, PlanetType } from '../galaxy/system-gen.ts';
import type { V3 } from '../math/vec.ts';
import { scatter, type Scattered } from './resources.ts';
import { heightAt } from './terrain.ts';
import { sphereToCube } from './cubesphere.ts';
import { inSite, sitesNear } from './sites.ts';

/**
 * Placement rules for decorative props. Kind order must match the geometry
 * lists in client/planet/prop-kits.ts.
 */
export interface PropRule {
  weight: number;
  scale: [number, number];
  /** Max slope (1 - n·up); height band as a fraction of planet maxHeight. */
  slopeMax: number;
  hMin: number;
  hMax: number;
  /** How far the base is pushed into the ground (× scale). */
  sink: number;
  /** Collision radius for pilots on foot (× scale); 0 = walk through. */
  solid: number;
  /** Height of the obstacle above its base (× scale); Infinity = too tall to climb over. */
  top: number;
}
export interface TierRule { density: number; grid: number; radius: number; salt: number; kinds: PropRule[] }
export interface PlanetPropRules { big: TierRule; small: TierRule }

const tree = (weight: number, scale: [number, number], hMax = 0.5, solid = 0.4): PropRule => ({ weight, scale, slopeMax: 0.28, hMin: 0, hMax, sink: 0.25, solid, top: Infinity });
const any = (weight: number, scale: [number, number], solid = 1.1, top = 1.3): PropRule => ({ weight, scale, slopeMax: 1, hMin: -1, hMax: 2, sink: 0.2, solid, top });
const small = (weight: number, scale: [number, number]): PropRule => ({ weight, scale, slopeMax: 0.45, hMin: -1, hMax: 0.7, sink: 0.04, solid: 0, top: 0 });
const big = (density: number, kinds: PropRule[]): TierRule => ({ density, grid: 420, radius: 620, salt: 0x3c, kinds });
const sm = (density: number, kinds: PropRule[]): TierRule => ({ density, grid: 1700, radius: 110, salt: 0x5d, kinds });

export const PROP_RULES: Record<PlanetType, PlanetPropRules> = {
  terran: {
    big: big(0.34, [tree(0.4, [0.7, 1.5]), tree(0.32, [0.7, 1.3]), tree(0.13, [0.6, 1.3], 0.5, 0), any(0.15, [0.6, 2.2])]),
    small: sm(0.5, [small(0.68, [0.7, 1.4]), small(0.1, [0.8, 1.3]), small(0.1, [0.8, 1.3]), small(0.12, [0.6, 1.8])]),
  },
  ocean: {
    big: big(0.3, [tree(0.42, [0.8, 1.4], 0.14, 0.35), tree(0.28, [0.7, 1.3]), tree(0.15, [0.6, 1.2], 0.5, 0), any(0.15, [0.6, 2.0])]),
    small: sm(0.45, [small(0.72, [0.7, 1.4]), small(0.13, [0.8, 1.3]), small(0.15, [0.6, 1.8])]),
  },
  alien: {
    big: big(0.3, [tree(0.3, [0.7, 1.6], 0.5, 0.5), tree(0.3, [0.7, 1.6], 0.5, 0.5), tree(0.2, [0.8, 1.5], 0.5, 0), any(0.2, [0.7, 1.6], 0.6, 2.2)]),
    small: sm(0.42, [small(0.45, [0.7, 1.5]), small(0.2, [0.7, 1.5]), small(0.35, [0.7, 1.4])]),
  },
  desert: {
    big: big(0.1, [tree(0.45, [0.7, 1.4], 0.9, 0.45), any(0.55, [0.8, 2.6])]),
    small: sm(0.22, [small(0.5, [0.7, 1.4]), small(0.5, [0.6, 2.0])]),
  },
  ice: {
    big: big(0.12, [any(0.55, [0.6, 1.5], 0.9, Infinity), any(0.45, [0.8, 2.2], 1.1, 1.1)]),
    small: sm(0.25, [small(0.5, [0.7, 1.6]), small(0.5, [0.7, 1.8])]),
  },
  lava: {
    big: big(0.13, [any(0.5, [0.6, 1.4], 1.2, 2.4), any(0.5, [0.7, 1.8], 1.1, 1.4)]),
    small: sm(0.22, [small(0.35, [0.7, 1.5]), small(0.65, [0.6, 2.0])]),
  },
  barren: {
    big: big(0.1, [any(1, [0.6, 3.0])]),
    small: sm(0.28, [small(1, [0.6, 2.2])]),
  },
};

/**
 * Floats per placed instance: kind, x, y, z (planet-relative), upX, upY, upZ, yaw, scale, tint,
 * exact terrain height h, and the cube-face coordinates face, u, v of the base (so the client can
 * snap the prop onto whatever level of detail of the terrain is currently drawn).
 */
export const PROP_STRIDE = 14;

function slopeAt(p: PlanetDef, d: V3, h: number): number {
  const e = 3 / p.radius;
  const ax = Math.abs(d.y) < 0.9 ? 0 : 1, ay = ax ? 0 : 1;
  // t1 = normalize(d × a), t2 = d × t1
  let t1x = d.y * 0 - d.z * ay, t1y = d.z * ax - d.x * 0, t1z = d.x * ay - d.y * ax;
  const l = Math.hypot(t1x, t1y, t1z) || 1;
  t1x /= l; t1y /= l; t1z /= l;
  const t2x = d.y * t1z - d.z * t1y, t2y = d.z * t1x - d.x * t1z, t2z = d.x * t1y - d.y * t1x;
  const h1 = heightAt(p, d.x + t1x * e, d.y + t1y * e, d.z + t1z * e);
  const h2 = heightAt(p, d.x + t2x * e, d.y + t2y * e, d.z + t2z * e);
  const g1 = (h1 - h) / 3, g2 = (h2 - h) / 3;
  return 1 - 1 / Math.sqrt(1 + g1 * g1 + g2 * g2);
}

interface Placed { kind: number; scale: number; r: number }

function placeOne(p: PlanetDef, rule: TierRule, total: number, pt: Scattered): Placed | null {
  let pick = pt.r[0] * total, ki = 0;
  while (ki < rule.kinds.length - 1 && pick > rule.kinds[ki].weight) { pick -= rule.kinds[ki].weight; ki++; }
  const k = rule.kinds[ki];
  const hf = pt.h / p.maxHeight;
  if (hf < k.hMin || hf > k.hMax) return null;
  if (inSite(p, pt.dir)) return null;
  if (k.slopeMax < 1 && slopeAt(p, pt.dir, pt.h) > k.slopeMax) return null;
  const scale = k.scale[0] + (k.scale[1] - k.scale[0]) * pt.r[2];
  return { kind: ki, scale, r: p.radius + pt.h - k.sink * scale };
}

const totalWeight = (rule: TierRule) => rule.kinds.reduce((s, k) => s + k.weight, 0);

/** Places a tier of props around unit direction `d`; returns packed instance data. */
export function placeProps(p: PlanetDef, d: V3, tier: 'big' | 'small'): Float32Array {
  const rule = PROP_RULES[p.type][tier];
  const pts = scatter(p, d, rule.radius, rule.grid, rule.density, rule.salt);
  const out = new Float32Array(pts.length * PROP_STRIDE);
  const total = totalWeight(rule);
  const cube = { face: 0, u: 0, v: 0 };
  let n = 0;
  for (const pt of pts) {
    const pl = placeOne(p, rule, total, pt);
    if (!pl) continue;
    const o = n * PROP_STRIDE;
    out[o] = pl.kind;
    out[o + 1] = pt.dir.x * pl.r; out[o + 2] = pt.dir.y * pl.r; out[o + 3] = pt.dir.z * pl.r;
    out[o + 4] = pt.dir.x; out[o + 5] = pt.dir.y; out[o + 6] = pt.dir.z;
    out[o + 7] = pt.r[1] * Math.PI * 2;
    out[o + 8] = pl.scale;
    out[o + 9] = 0.86 + pt.r[3] * 0.26;
    out[o + 10] = pt.h;
    sphereToCube(pt.dir, cube);
    out[o + 11] = cube.face; out[o + 12] = cube.u; out[o + 13] = cube.v;
    n++;
  }
  return out.subarray(0, n * PROP_STRIDE);
}

/**
 * Solid obstacle as a vertical cylinder: base point (planet-relative), radius and height of its
 * top above the base (Infinity for trees and towers that cannot be climbed over).
 */
export interface Collider { x: number; y: number; z: number; r: number; top: number }

const colliderCache = new Map<number, Collider[]>();

/**
 * Solid props within `radiusM` of unit direction `d` (deterministic, shared by
 * client prediction and the server). Results are cached per planet/area.
 */
export function collidersNear(p: PlanetDef, d: V3, radiusM = 4): Collider[] {
  const rule = PROP_RULES[p.type].big;
  const cell = (p.radius * Math.PI) / 2 / rule.grid;
  // cache key: planet + quantised direction (cells are much larger than the query radius)
  const q = cell / p.radius;
  const key = (((p.seed * 31 + Math.round(d.x / q)) * 131 + Math.round(d.y / q)) * 131 + Math.round(d.z / q)) | 0;
  const hit = colliderCache.get(key);
  if (hit) return hit;
  const total = totalWeight(rule);
  const out: Collider[] = [];
  for (const pt of scatter(p, d, radiusM + cell * 2, rule.grid, rule.density, rule.salt)) {
    const pl = placeOne(p, rule, total, pt);
    if (!pl) continue;
    const kind = rule.kinds[pl.kind];
    const solid = kind.solid * pl.scale;
    if (solid <= 0) continue;
    out.push({ x: pt.dir.x * pl.r, y: pt.dir.y * pl.r, z: pt.dir.z * pl.r, r: solid, top: kind.top * pl.scale });
  }
  // pillars, obelisks and turret towers of surface sites
  for (const s of sitesNear(p, d, radiusM + cell * 2)) {
    for (const c of [...s.pillars, ...s.blocks]) {
      const r = p.radius + c.h - 1;
      out.push({ x: c.dir.x * r, y: c.dir.y * r, z: c.dir.z * r, r: c.r, top: c.tall + 1 });
    }
  }
  if (colliderCache.size > 4096) colliderCache.clear();
  colliderCache.set(key, out);
  return out;
}
