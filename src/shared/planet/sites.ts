import type { PlanetDef } from '../galaxy/system-gen.ts';
import { makeName } from '../galaxy/names.ts';
import { hashInts, Rng } from '../math/rng.ts';
import { v3, vcross, vnorm, type V3 } from '../math/vec.ts';
import { heightAt } from './terrain.ts';

/**
 * Hand-placed-looking surface sites, generated deterministically from the
 * planet seed so the client can draw them and the server can simulate them
 * without any network traffic: ancient ruins with relic caches and fortified
 * pirate outposts guarded by flak turrets.
 */
export type SiteKind = 'ruin' | 'base' | 'wreck';

export interface SitePoint { dir: V3; h: number }
export interface SiteCache extends SitePoint { type: 'relic' | 'crystal' }
export interface SitePillar extends SitePoint { r: number; tall: number }

export interface SiteDef {
  /** Index within the planet. */
  id: number;
  planet: number;
  kind: SiteKind;
  name: string;
  dir: V3;
  /** Terrain height at the centre. */
  h: number;
  radius: number;
  seed: number;
  /** Local tangent frame at the centre (already rotated by the site's yaw). */
  east: V3;
  north: V3;
  caches: SiteCache[];
  turrets: SitePoint[];
  /** Solid vertical cylinders pilots on foot collide with. */
  pillars: SitePillar[];
  /** Low solid obstacles pilots can vault or climb over (fallen blocks, wall sections). */
  blocks: SitePillar[];
  /** Straight wall sections in the site plane (x east, z north), height WALL_HEIGHT. */
  walls: { x0: number; z0: number; x1: number; z1: number }[];
  /** Where a survey is done: the centre of ruins, the bridge console of a wreck (site plane). */
  goal: { x: number; z: number };
  /** Wrecks: the hull outline (site plane) and areas inside it. */
  hull?: { x: number; z: number }[];
  zones?: { kind: 'rad' | 'bridge' | 'hold' | 'quarters'; x0: number; z0: number; x1: number; z1: number }[];
  /** Wrecks: where the guard drones hover (site plane). */
  posts?: { x: number; z: number }[];
}

/** Resource-node ids for site caches start here (well above the regular node grid). */
export const SITE_NODE_BASE = 1 << 20;
export const SITE_CACHES = 8;
/** Turret pedestal height; the gun ball sits on top. */
export const TURRET_HEIGHT = 7;
export const TURRET_RANGE = 1500;
/** Outpost wall height — low enough to climb over. */
export const WALL_HEIGHT = 2.6;
const WALL_RADIUS = 50, WALL_SEGMENTS = 12, WALL_GAPS = [2, 8];

const cache = new Map<number, SiteDef[]>();

/** Unit direction of a point `x` metres east and `z` metres north of a site centre. */
export function siteDir(pl: PlanetDef, s: Pick<SiteDef, 'dir' | 'h' | 'east' | 'north'>, x: number, z: number, out: V3 = v3()): V3 {
  const r = pl.radius + s.h;
  out.x = s.dir.x * r + s.east.x * x + s.north.x * z;
  out.y = s.dir.y * r + s.east.y * x + s.north.y * z;
  out.z = s.dir.z * r + s.east.z * x + s.north.z * z;
  return vnorm(out, out);
}

function point(pl: PlanetDef, s: Pick<SiteDef, 'dir' | 'h' | 'east' | 'north'>, x: number, z: number): SitePoint {
  const dir = siteDir(pl, s, x, z);
  return { dir, h: heightAt(pl, dir.x, dir.y, dir.z) };
}

function frame(dir: V3, yaw: number) {
  const ref = Math.abs(dir.y) < 0.95 ? v3(0, 1, 0) : v3(1, 0, 0);
  const e0 = vnorm(v3(), vcross(v3(), ref, dir));
  const n0 = vcross(v3(), dir, e0);
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return {
    east: v3(e0.x * c + n0.x * s, e0.y * c + n0.y * s, e0.z * c + n0.z * s),
    north: v3(n0.x * c - e0.x * s, n0.y * c - e0.y * s, n0.z * c - e0.z * s),
  };
}

/** All sites of a planet (cached). */
export function planetSites(pl: PlanetDef): SiteDef[] {
  const hit = cache.get(pl.seed);
  if (hit) return hit;
  const rng = new Rng(hashInts(pl.seed, 0x517e));
  const hostile = pl.type !== 'terran' && pl.type !== 'ocean';
  const plan: SiteKind[] = ['ruin', 'ruin', 'ruin', 'base', ...(hostile ? ['ruin', 'base'] as SiteKind[] : [])];
  const sites: SiteDef[] = [];
  for (const kind of plan) {
    const radius = kind === 'ruin' ? 36 : 60;
    for (let tries = 0; tries < 400; tries++) {
      const dir = vnorm(v3(), v3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)));
      if (Math.abs(dir.y) > 0.88) continue;
      const h = heightAt(pl, dir.x, dir.y, dir.z);
      if (h < 5 || h > pl.maxHeight * 0.45) continue;
      if (sites.some((o) => o.dir.x * dir.x + o.dir.y * dir.y + o.dir.z * dir.z > Math.cos(3000 / pl.radius))) continue;
      const f = frame(dir, rng.range(0, Math.PI * 2));
      const base = { dir, h, ...f };
      // needs dry, fairly flat ground across the footprint
      let lo = h, hi = h;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const p = point(pl, base, Math.cos(a) * radius, Math.sin(a) * radius);
        lo = Math.min(lo, p.h); hi = Math.max(hi, p.h);
      }
      if (lo < 3 || hi - lo > radius * 0.3) continue;
      sites.push(layout(pl, kind, sites.length, base, radius, rng.int(0, 1e9)));
      break;
    }
  }
  // crashed ships, placed after the older sites with their own random stream so those stay put
  const wr = new Rng(hashInts(pl.seed, 0x3ec4));
  const wrecks = hostile ? 2 : 1;
  for (let n = 0; n < wrecks; n++) {
    for (let tries = 0; tries < 600; tries++) {
      const dir = vnorm(v3(), v3(wr.range(-1, 1), wr.range(-1, 1), wr.range(-1, 1)));
      if (Math.abs(dir.y) > 0.88) continue;
      const h = heightAt(pl, dir.x, dir.y, dir.z);
      if (h < 4 || h > pl.maxHeight * 0.4) continue;
      if (sites.some((o) => o.dir.x * dir.x + o.dir.y * dir.y + o.dir.z * dir.z > Math.cos(2500 / pl.radius))) continue;
      const base = { dir, h, ...frame(dir, wr.range(0, Math.PI * 2)) };
      // a hull needs nearly flat, dry ground under it
      let lo = h, hi = h;
      for (const [x, z] of [[-36, -10], [-36, 10], [0, -10], [0, 10], [36, -8], [36, 8], [44, 0], [-20, 0], [20, 0]]) {
        const p = point(pl, base, x, z);
        lo = Math.min(lo, p.h); hi = Math.max(hi, p.h);
      }
      if (lo < 3 || hi - lo > 3.5) continue;
      sites.push(wreckLayout(pl, sites.length, base, wr.int(0, 1e9)));
      break;
    }
  }
  cache.set(pl.seed, sites);
  return sites;
}

/** Wreck dimensions: hull from x = −36 (torn stern) to 44 (nose), half-width 10, roof 6.5 m up. */
export const WRECK_ROOF = 6.5;
const HULL: [number, number][] = [[44, 0], [34, 7], [30, 10], [-30, 10], [-36, 8], [-36, -8], [-30, -10], [30, -10], [34, -7]];
/** Gaps in the hull (site plane): a breach in the south side by the hold, and the torn stern. */
const BREACHES: [number, number, number, number][] = [[-11, -10, -4, -10], [-36, -3.2, -36, 3.2]];
/** Inner walls: bulkheads with doorways (gaps) and the corridor walls past the quarters. */
const BULKHEADS: [number, number, number, number][] = [
  // bridge bulkhead at x = 26, door in the middle
  [26, -10, 26, -1.4], [26, 1.4, 26, 10],
  // quarters along the corridor (doors at x 16–18.4 north, 20–22.4 south)
  [10, 2.6, 16, 2.6], [18.4, 2.6, 26, 2.6], [10, -2.6, 20, -2.6], [22.4, -2.6, 26, -2.6],
  [10, 2.6, 10, 10], [10, -2.6, 10, -10],
  // reactor bulkhead at x = −16
  [-16, -10, -16, -1.6], [-16, 1.6, -16, 10],
];

const insidePoly = (poly: { x: number; z: number }[], x: number, z: number) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
};

/** Splits a segment by the gaps that lie on it. */
function withGaps(x0: number, z0: number, x1: number, z1: number, gaps: [number, number, number, number][]): [number, number, number, number][] {
  const len = Math.hypot(x1 - x0, z1 - z0), ux = (x1 - x0) / len, uz = (z1 - z0) / len;
  const cut: [number, number][] = [];
  for (const [a0, b0, a1, b1] of gaps) {
    // gap must lie on this segment's line
    const off0 = Math.abs((a0 - x0) * uz - (b0 - z0) * ux), off1 = Math.abs((a1 - x0) * uz - (b1 - z0) * ux);
    if (off0 > 0.01 || off1 > 0.01) continue;
    const t0 = (a0 - x0) * ux + (b0 - z0) * uz, t1 = (a1 - x0) * ux + (b1 - z0) * uz;
    cut.push([Math.max(0, Math.min(t0, t1)), Math.min(len, Math.max(t0, t1))]);
  }
  cut.sort((a, b) => a[0] - b[0]);
  const out: [number, number, number, number][] = [];
  let t = 0;
  for (const [c0, c1] of cut) {
    if (c0 > t + 0.05) out.push([x0 + ux * t, z0 + uz * t, x0 + ux * c0, z0 + uz * c0]);
    t = Math.max(t, c1);
  }
  if (len > t + 0.05) out.push([x0 + ux * t, z0 + uz * t, x1, z1]);
  return out;
}

function wreckLayout(pl: PlanetDef, id: number, base: { dir: V3; h: number; east: V3; north: V3 }, seed: number): SiteDef {
  const r = new Rng(seed);
  const s: SiteDef = {
    id, planet: pl.index, kind: 'wreck', radius: 46, seed, ...base,
    name: `Разбитый «${makeName(r)}»`,
    caches: [], turrets: [], pillars: [], blocks: [], walls: [],
    goal: { x: 39, z: 0 },
    hull: HULL.map(([x, z]) => ({ x, z })),
    zones: [
      { kind: 'bridge', x0: 26, z0: -10, x1: 44, z1: 10 },
      { kind: 'quarters', x0: 10, z0: -10, x1: 26, z1: 10 },
      { kind: 'hold', x0: -16, z0: -10, x1: 10, z1: 10 },
      { kind: 'rad', x0: -36, z0: -10, x1: -16, z1: 10 },
    ],
    posts: [{ x: -3, z: 0 }, { x: 18, z: 0 }, { x: -25, z: 5 }],
  };
  const segs: [number, number, number, number][] = [];
  for (let i = 0; i < HULL.length; i++) {
    const [x0, z0] = HULL[i], [x1, z1] = HULL[(i + 1) % HULL.length];
    segs.push(...withGaps(x0, z0, x1, z1, BREACHES));
  }
  segs.push(...BULKHEADS);
  for (const [x0, z0, x1, z1] of segs) {
    s.walls.push({ x0, z0, x1, z1 });
    // solid along their length and far too tall to climb
    const len = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.ceil(len / 0.9));
    for (let j = 0; j <= n; j++) {
      const t = j / n;
      s.blocks.push({ ...point(pl, s, x0 + (x1 - x0) * t, z0 + (z1 - z0) * t), r: 0.55, tall: 8 });
    }
  }
  // the reactor core and cargo containers (low enough to vault)
  s.pillars.push({ ...point(pl, s, -26, 0), r: 2.2, tall: 5 });
  for (const [x, z] of [[-12, 6], [-9, 6.5], [-4, -6], [4, 6.5], [6, -6.5]]) s.blocks.push({ ...point(pl, s, x + r.range(-0.6, 0.6), z), r: 0.9, tall: 1.3 });
  // caches: relics in the hold and the captain's cabin, crystals in the hold, one in the hot reactor room
  s.caches.push(
    { ...point(pl, s, -8, -6.5), type: 'relic' },
    { ...point(pl, s, 1, 6.5), type: 'crystal' },
    { ...point(pl, s, 22, 7), type: 'relic' },
    { ...point(pl, s, -32, -6), type: 'relic' },
  );
  return s;
}

/** Site-plane coordinates (x east, z north) of a body-frame point. */
export function sitePlane(pl: PlanetDef, s: SiteDef, p: V3): { x: number; z: number } {
  const r = pl.radius + s.h;
  const dx = p.x - s.dir.x * r, dy = p.y - s.dir.y * r, dz = p.z - s.dir.z * r;
  return { x: dx * s.east.x + dy * s.east.y + dz * s.east.z, z: dx * s.north.x + dy * s.north.y + dz * s.north.z };
}

/**
 * The wreck hull (if any) a body-frame point lies under or on: the radius of its roof and
 * the site, so a pilot inside can't jet through it and one on top can stand on it.
 */
export function wreckAt(pl: PlanetDef, p: V3): { site: SiteDef; roof: number; x: number; z: number } | null {
  const l = Math.hypot(p.x, p.y, p.z) || 1;
  for (const s of planetSites(pl)) {
    if (s.kind !== 'wreck' || !s.hull) continue;
    if ((s.dir.x * p.x + s.dir.y * p.y + s.dir.z * p.z) / l < Math.cos(50 / pl.radius)) continue;
    const q = sitePlane(pl, s, p);
    if (!insidePoly(s.hull, q.x, q.z)) continue;
    return { site: s, roof: pl.radius + s.h + WRECK_ROOF, ...q };
  }
  return null;
}

/** Zone of a wreck a site-plane point is in. */
export function wreckZone(s: SiteDef, x: number, z: number) {
  return s.zones?.find((zn) => x >= zn.x0 && x <= zn.x1 && z >= zn.z0 && z <= zn.z1)?.kind ?? null;
}

function layout(pl: PlanetDef, kind: SiteKind, id: number, base: { dir: V3; h: number; east: V3; north: V3 }, radius: number, seed: number): SiteDef {
  const r = new Rng(seed);
  const s: SiteDef = {
    id, planet: pl.index, kind, radius, seed, ...base,
    name: kind === 'ruin' ? `Руины ${makeName(r)}` : `База «${makeName(r)}»`,
    caches: [], turrets: [], pillars: [], blocks: [], walls: [], goal: { x: 0, z: 0 },
  };
  if (kind === 'ruin') {
    // a broken colonnade around a central obelisk, caches among the stones
    const n = 10;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const p = point(pl, s, Math.cos(a) * 20, Math.sin(a) * 20);
      s.pillars.push({ ...p, r: 1.3, tall: r.chance(0.35) ? r.range(1.5, 4) : r.range(7, 10) });
    }
    s.pillars.push({ ...point(pl, s, 0, 0), r: 2.2, tall: 14 });
    const k = r.int(2, 3);
    for (let i = 0; i < k; i++) {
      const a = r.range(0, Math.PI * 2), d = r.range(7, 14);
      s.caches.push({ ...point(pl, s, Math.cos(a) * d, Math.sin(a) * d), type: 'relic' });
    }
    // fallen stones: low enough to vault over
    for (let i = 0; i < 6; i++) {
      const a = r.range(0, Math.PI * 2), d = r.range(24, 32);
      s.blocks.push({ ...point(pl, s, Math.cos(a) * d, Math.sin(a) * d), r: r.range(0.9, 1.3), tall: r.range(0.8, 1.5) });
    }
  } else {
    // walled compound: landing pad, hangar, three flak towers, loot in the depot
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
      const p = point(pl, s, Math.cos(a) * 36, Math.sin(a) * 36);
      s.turrets.push(p);
      s.pillars.push({ ...p, r: 2.4, tall: TURRET_HEIGHT });
    }
    s.caches.push({ ...point(pl, s, -22, 18), type: 'relic' }, { ...point(pl, s, -26, 12), type: 'crystal' });
    // perimeter wall (with two gates), solid along its length but climbable
    for (let k = 0; k < WALL_SEGMENTS; k++) {
      if (WALL_GAPS.includes(k)) continue;
      const a0 = (k / WALL_SEGMENTS) * Math.PI * 2, a1 = ((k + 1) / WALL_SEGMENTS) * Math.PI * 2;
      const w = { x0: Math.cos(a0) * WALL_RADIUS, z0: Math.sin(a0) * WALL_RADIUS, x1: Math.cos(a1) * WALL_RADIUS, z1: Math.sin(a1) * WALL_RADIUS };
      s.walls.push(w);
      const len = Math.hypot(w.x1 - w.x0, w.z1 - w.z0), n = Math.ceil(len / 1.4);
      for (let j = 0; j <= n; j++) {
        const t = j / n;
        s.blocks.push({ ...point(pl, s, w.x0 + (w.x1 - w.x0) * t, w.z0 + (w.z1 - w.z0) * t), r: 0.85, tall: WALL_HEIGHT });
      }
    }
  }
  return s;
}

/** Sites within `radiusM` metres (great-circle) of unit direction `d`. */
export function sitesNear(pl: PlanetDef, d: V3, radiusM: number): SiteDef[] {
  return planetSites(pl).filter((s) => s.dir.x * d.x + s.dir.y * d.y + s.dir.z * d.z >= Math.cos((radiusM + s.radius) / pl.radius));
}

/** True if `d` lies inside a site footprint (plus margin) — keeps trees and rocks out of buildings. */
export function inSite(pl: PlanetDef, d: V3, margin = 6): boolean {
  for (const s of planetSites(pl)) {
    if (s.dir.x * d.x + s.dir.y * d.y + s.dir.z * d.z >= Math.cos((s.radius + margin) / pl.radius)) return true;
  }
  return false;
}

/** Site that owns a cache node id, if any. */
export function siteCache(pl: PlanetDef, nodeId: number): { site: SiteDef; cache: SiteCache } | null {
  const k = nodeId - SITE_NODE_BASE;
  if (!Number.isInteger(k) || k < 0) return null;
  const site = planetSites(pl)[Math.floor(k / SITE_CACHES)];
  const c = site?.caches[k % SITE_CACHES];
  return c ? { site, cache: c } : null;
}
