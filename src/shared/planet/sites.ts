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
export type SiteKind = 'ruin' | 'base';

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
}

/** Resource-node ids for site caches start here (well above the regular node grid). */
export const SITE_NODE_BASE = 1 << 20;
export const SITE_CACHES = 8;
/** Turret pedestal height; the gun ball sits on top. */
export const TURRET_HEIGHT = 7;
export const TURRET_RANGE = 1500;

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
  cache.set(pl.seed, sites);
  return sites;
}

function layout(pl: PlanetDef, kind: SiteKind, id: number, base: { dir: V3; h: number; east: V3; north: V3 }, radius: number, seed: number): SiteDef {
  const r = new Rng(seed);
  const s: SiteDef = {
    id, planet: pl.index, kind, radius, seed, ...base,
    name: kind === 'ruin' ? `Руины ${makeName(r)}` : `База «${makeName(r)}»`,
    caches: [], turrets: [], pillars: [],
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
  } else {
    // walled compound: landing pad, hangar, three flak towers, loot in the depot
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
      const p = point(pl, s, Math.cos(a) * 36, Math.sin(a) * 36);
      s.turrets.push(p);
      s.pillars.push({ ...p, r: 2.4, tall: TURRET_HEIGHT });
    }
    s.caches.push({ ...point(pl, s, -22, 18), type: 'relic' }, { ...point(pl, s, -26, 12), type: 'crystal' });
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
