import type { PlanetDef } from '../galaxy/system-gen.ts';
import { hashFloat, hashInts } from '../math/rng.ts';
import { v3, type V3 } from '../math/vec.ts';
import { gnomonic, invGnomonic } from './cubesphere.ts';
import { heightAt } from './terrain.ts';
import { inSite, SITE_CACHES, SITE_NODE_BASE, siteCache, sitesNear } from './sites.ts';

export type ResourceType = 'ore' | 'crystal' | 'relic';
export const RESOURCE_TYPES: readonly ResourceType[] = ['ore', 'crystal', 'relic'];

export interface ResourceNode { id: number; type: ResourceType; dir: V3; h: number }

/** Resource cells per cube-face edge (~150–250 m cells). */
export const RES_GRID = 40;

export function resourceNode(p: PlanetDef, id: number): ResourceNode | null {
  if (id >= SITE_NODE_BASE) {
    const sc = siteCache(p, id);
    return sc ? { id, type: sc.cache.type, dir: sc.cache.dir, h: sc.cache.h } : null;
  }
  const per = RES_GRID * RES_GRID;
  if (id < 0 || id >= per * 6 || !Number.isInteger(id)) return null;
  const face = Math.floor(id / per);
  const rem = id - face * per;
  const i = Math.floor(rem / RES_GRID), j = rem % RES_GRID;
  const h0 = hashInts(p.seed, face, i, j, 0x77);
  if (hashFloat(h0, 0) >= p.resources) return null;
  const cell = 2 / RES_GRID;
  const u = -1 + (i + 0.15 + 0.7 * hashFloat(h0, 1)) * cell;
  const v = -1 + (j + 0.15 + 0.7 * hashFloat(h0, 2)) * cell;
  const dir = gnomonic(face, u, v, v3());
  const h = heightAt(p, dir.x, dir.y, dir.z);
  if (p.sea && h < 1) return null;
  if (inSite(p, dir, 4)) return null;
  const r = hashFloat(h0, 3);
  const type: ResourceType = r < 0.08 ? 'relic' : r < 0.36 ? 'crystal' : 'ore';
  return { id, type, dir, h };
}

function cellsNear(grid: number, p: PlanetDef, d: V3, radiusM: number, fn: (face: number, i: number, j: number) => void) {
  const cellM = (p.radius * (Math.PI / 2)) / grid;
  const k = Math.ceil(radiusM / cellM) + 1;
  for (let face = 0; face < 6; face++) {
    const g = invGnomonic(face, d);
    if (!g || Math.abs(g.u) > 1.3 || Math.abs(g.v) > 1.3) continue;
    const ci = Math.floor(((g.u + 1) / 2) * grid), cj = Math.floor(((g.v + 1) / 2) * grid);
    for (let dj = -k; dj <= k; dj++) {
      for (let di = -k; di <= k; di++) {
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= grid || j >= grid) continue;
        fn(face, i, j);
      }
    }
  }
}

/** Resource nodes within `radiusM` metres (great-circle) of unit direction `d`. */
export function nodesNear(p: PlanetDef, d: V3, radiusM: number): ResourceNode[] {
  const out: ResourceNode[] = [];
  const seen = new Set<number>();
  const cosMax = Math.cos(radiusM / p.radius);
  cellsNear(RES_GRID, p, d, radiusM, (face, i, j) => {
    const id = face * RES_GRID * RES_GRID + i * RES_GRID + j;
    if (seen.has(id)) return;
    seen.add(id);
    const n = resourceNode(p, id);
    if (n && n.dir.x * d.x + n.dir.y * d.y + n.dir.z * d.z >= cosMax) out.push(n);
  });
  // caches inside ruins and pirate outposts
  for (const s of sitesNear(p, d, radiusM)) {
    s.caches.forEach((c, k) => {
      if (c.dir.x * d.x + c.dir.y * d.y + c.dir.z * d.z >= cosMax) out.push({ id: SITE_NODE_BASE + s.id * SITE_CACHES + k, type: c.type, dir: c.dir, h: c.h });
    });
  }
  return out;
}

export interface Scattered { id: number; dir: V3; h: number; r: [number, number, number, number] }

/**
 * Deterministic scatter of decoration points (client side). `grid` cells per
 * face edge, `density` = chance that a cell holds a point. Submerged points are skipped.
 */
export function scatter(p: PlanetDef, d: V3, radiusM: number, grid: number, density: number, salt: number): Scattered[] {
  const out: Scattered[] = [];
  const cosMax = Math.cos(radiusM / p.radius);
  const seen = new Set<number>();
  const cell = 2 / grid;
  cellsNear(grid, p, d, radiusM, (face, i, j) => {
    const id = (face * grid + i) * grid + j;
    if (seen.has(id)) return;
    seen.add(id);
    const hh = hashInts(p.seed, face, i, j, salt);
    if (hashFloat(hh, 0) >= density) return;
    const dir = gnomonic(face, -1 + (i + hashFloat(hh, 1)) * cell, -1 + (j + hashFloat(hh, 2)) * cell, v3());
    if (dir.x * d.x + dir.y * d.y + dir.z * d.z < cosMax) return;
    const h = heightAt(p, dir.x, dir.y, dir.z);
    if (p.sea && h < 0.6) return;
    out.push({ id, dir, h, r: [hashFloat(hh, 3), hashFloat(hh, 4), hashFloat(hh, 5), hashFloat(hh, 6)] });
  });
  return out;
}
