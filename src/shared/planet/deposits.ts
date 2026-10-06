import type { PlanetDef, PlanetType } from '../galaxy/system-gen.ts';
import type { CargoKey } from '../economy.ts';
import { hashFloat, hashInts } from '../math/rng.ts';
import { v3, type V3 } from '../math/vec.ts';
import { faceOf, gnomonic, invGnomonic } from './cubesphere.ts';
import { heightAt, liquidOf } from './terrain.ts';
import { inSite } from './sites.ts';

/**
 * Rover expeditions: rich deposits and finds scattered across a planet, a kilometre or two
 * apart. They are too heavy and too deep for a pilot on foot: only the core drill on the back
 * of a rover gets them out, and the haul rides in the rover's bed until the rover is loaded
 * back into the ship. Like resource nodes they follow from the planet seed alone (client and
 * server agree without any traffic) and share the harvested map, so a drilled deposit
 * disappears for everyone until it regrows.
 */

export type DepositKind = 'vein' | 'geode' | 'meteorite' | 'probe' | 'fossil';
export const DEPOSIT_KINDS: readonly DepositKind[] = ['vein', 'geode', 'meteorite', 'probe', 'fossil'];
export const DEPOSIT_NAMES: Record<DepositKind, string> = {
  vein: 'Рудная жила', geode: 'Кристаллическая жеода', meteorite: 'Метеорит', probe: 'Упавший зонд', fossil: 'Окаменелость',
};

/** Solid radius and height of each kind's model (rovers and pilots bump into it). */
export const DEPOSIT_SOLID: Record<DepositKind, { r: number; top: number }> = {
  vein: { r: 1.7, top: 2.2 }, geode: { r: 1.5, top: 2.4 }, meteorite: { r: 1.6, top: 1.8 }, probe: { r: 1.1, top: 2.2 }, fossil: { r: 1.5, top: 1.6 },
};

export interface Deposit {
  id: number; kind: DepositKind; dir: V3; h: number;
  /** What one drilling yields. */
  yield: Partial<Record<CargoKey, number>>;
}

/** Deposit ids sit above resource nodes (< 6·40²) and site caches (2^20 + …). */
export const DEPOSIT_BASE = 1 << 24;
/** Deposit cells per cube-face edge (~0.8–1.9 km cells). */
export const DEP_GRID = 6;
/** Chance that a cell holds a deposit (before terrain rejects it). */
export const DEP_DENSITY = 0.7;
/** The rover's centre must be this close (m) to the deposit's centre to drill it. */
export const DRILL_RANGE = 8;
/** Seconds of drilling. */
export const DRILL_TIME = 5;
/** The rover must stand nearly still (m/s) while the drill is down. */
export const DRILL_SPEED = 1.2;
/** Units of cargo the rover's bed holds. */
export const ROVER_BED = 24;
/** Seconds until a drilled deposit is back. */
export const DEPOSIT_RESPAWN = 1800;
/** Range (m) of the rover's ground scanner (HUD markers). */
export const SCAN_RANGE = 2500;

/** Kind weights per planet type: what the ground of a world tends to hide. */
const WEIGHTS: Record<PlanetType, Record<DepositKind, number>> = {
  terran: { vein: 2, geode: 1, meteorite: 1, probe: 1, fossil: 3 },
  ocean: { vein: 1, geode: 1, meteorite: 1, probe: 1.5, fossil: 3 },
  alien: { vein: 1, geode: 3, meteorite: 1, probe: 1, fossil: 2 },
  desert: { vein: 3, geode: 1, meteorite: 2, probe: 2, fossil: 1.5 },
  ice: { vein: 1, geode: 3, meteorite: 2, probe: 1.5, fossil: 0.5 },
  lava: { vein: 4, geode: 2, meteorite: 1, probe: 0.5, fossil: 0 },
  barren: { vein: 3, geode: 1.5, meteorite: 3, probe: 2, fossil: 0 },
};

function yieldOf(kind: DepositKind, r: number): Partial<Record<CargoKey, number>> {
  const n = (a: number, b: number) => a + Math.floor(r * (b - a + 1));
  switch (kind) {
    case 'vein': return { ore: n(9, 14) };
    case 'geode': return { crystal: n(4, 7) };
    case 'meteorite': return { ore: n(3, 5), crystal: 2, relic: 1 };
    case 'probe': return { relic: 2, crystal: n(1, 2) };
    case 'fossil': return { bio: n(4, 6), relic: 1 };
  }
}

/** Ground is too steep for the drill to stand on (rise over 6 m). */
function steep(p: PlanetDef, d: V3, h: number): boolean {
  const k = 6 / p.radius;
  // two tangent directions
  const ax = Math.abs(d.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0);
  const t1 = v3(d.y * ax.z - d.z * ax.y, d.z * ax.x - d.x * ax.z, d.x * ax.y - d.y * ax.x);
  const l1 = Math.hypot(t1.x, t1.y, t1.z);
  t1.x /= l1; t1.y /= l1; t1.z /= l1;
  const t2 = v3(d.y * t1.z - d.z * t1.y, d.z * t1.x - d.x * t1.z, d.x * t1.y - d.y * t1.x);
  for (const t of [t1, t2]) {
    for (const s of [-1, 1]) {
      const q = v3(d.x + t.x * k * s, d.y + t.y * k * s, d.z + t.z * k * s);
      if (Math.abs(heightAt(p, q.x, q.y, q.z) - h) > 2.4) return true;
    }
  }
  return false;
}

const cache = new Map<number, Deposit | null>();

export function deposit(p: PlanetDef, id: number): Deposit | null {
  const k = id - DEPOSIT_BASE;
  const per = DEP_GRID * DEP_GRID;
  if (!Number.isInteger(k) || k < 0 || k >= per * 6) return null;
  const key = (p.seed >>> 0) * 4096 + k;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const out = makeDeposit(p, id, k);
  if (cache.size > 4000) cache.clear();
  cache.set(key, out);
  return out;
}

function makeDeposit(p: PlanetDef, id: number, k: number): Deposit | null {
  const per = DEP_GRID * DEP_GRID;
  const face = Math.floor(k / per);
  const i = Math.floor((k - face * per) / DEP_GRID), j = (k - face * per) % DEP_GRID;
  const h0 = hashInts(p.seed, face, i, j, 0x0de9);
  if (hashFloat(h0, 0) >= DEP_DENSITY) return null;
  const cell = 2 / DEP_GRID;
  const liquid = liquidOf(p);
  // a few tries inside the cell for dry, level ground away from ruins and bases
  for (let t = 0; t < 4; t++) {
    const u = -1 + (i + 0.15 + 0.7 * hashFloat(h0, 1 + t * 2)) * cell;
    const v = -1 + (j + 0.15 + 0.7 * hashFloat(h0, 2 + t * 2)) * cell;
    const dir = gnomonic(face, u, v, v3());
    const h = heightAt(p, dir.x, dir.y, dir.z);
    if (liquid && h < 2) continue;
    if (inSite(p, dir, 60) || steep(p, dir, h)) continue;
    const w = WEIGHTS[p.type];
    let r = hashFloat(h0, 20) * DEPOSIT_KINDS.reduce((a, kk) => a + w[kk], 0);
    let kind: DepositKind = 'vein';
    for (const kk of DEPOSIT_KINDS) { r -= w[kk]; if (r < 0) { kind = kk; break; } }
    return { id, kind, dir, h, yield: yieldOf(kind, hashFloat(h0, 21)) };
  }
  return null;
}

/** Deposits within `radiusM` metres (great-circle) of unit direction `d`. */
export function depositsNear(p: PlanetDef, d: V3, radiusM: number): Deposit[] {
  const out: Deposit[] = [];
  const cosMax = Math.cos(radiusM / p.radius);
  const cellM = (p.radius * (Math.PI / 2)) / DEP_GRID;
  const reach = Math.ceil(radiusM / cellM) + 1;
  const seen = new Set<number>();
  for (let face = 0; face < 6; face++) {
    const g = invGnomonic(face, d);
    if (!g || Math.abs(g.u) > 1.6 || Math.abs(g.v) > 1.6) continue;
    const ci = Math.floor(((g.u + 1) / 2) * DEP_GRID), cj = Math.floor(((g.v + 1) / 2) * DEP_GRID);
    for (let di = -reach; di <= reach; di++) {
      for (let dj = -reach; dj <= reach; dj++) {
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= DEP_GRID || j >= DEP_GRID) continue;
        const id = DEPOSIT_BASE + face * DEP_GRID * DEP_GRID + i * DEP_GRID + j;
        if (seen.has(id)) continue;
        seen.add(id);
        const dp = deposit(p, id);
        if (dp && dp.dir.x * d.x + dp.dir.y * d.y + dp.dir.z * d.z >= cosMax) out.push(dp);
      }
    }
  }
  return out;
}

/** Is unit direction `d` within `margin` metres of a deposit's solid outline? (keeps props out) */
export function nearDeposit(p: PlanetDef, d: V3, margin: number): boolean {
  const face = faceOf(d);
  const g = invGnomonic(face, d);
  if (!g) return false;
  const ci = Math.floor(((g.u + 1) / 2) * DEP_GRID), cj = Math.floor(((g.v + 1) / 2) * DEP_GRID);
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= DEP_GRID || j >= DEP_GRID) continue;
      const dp = deposit(p, DEPOSIT_BASE + face * DEP_GRID * DEP_GRID + i * DEP_GRID + j);
      if (dp && dp.dir.x * d.x + dp.dir.y * d.y + dp.dir.z * d.z >= Math.cos((DEPOSIT_SOLID[dp.kind].r + margin) / p.radius)) return true;
    }
  }
  return false;
}

/** Body-frame position of a deposit's centre on the ground. */
export function depositPos(p: PlanetDef, dp: Deposit, out: V3 = v3()): V3 {
  const r = p.radius + dp.h;
  out.x = dp.dir.x * r; out.y = dp.dir.y * r; out.z = dp.dir.z * r;
  return out;
}

/** "Руда ×9, Реликты ×1" */
export function yieldText(y: Partial<Record<CargoKey, number>>, names: Record<CargoKey, string>): string {
  return (Object.keys(y) as CargoKey[]).filter((k) => y[k]).map((k) => `${names[k]} ×${y[k]}`).join(', ');
}
