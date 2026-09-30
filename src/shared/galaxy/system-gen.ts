import { GALAXY_SEED, SYSTEM_COUNT } from '../constants.ts';
import { hashInts, Rng } from '../math/rng.ts';
import { v3, vdist, vnorm, vscale, vadd, type V3 } from '../math/vec.ts';
import { makeName, ROMAN } from './names.ts';

export type PlanetType = 'terran' | 'ocean' | 'alien' | 'desert' | 'ice' | 'lava' | 'barren';

export interface AtmosphereDef {
  /** Rim/scattering colour seen from space. */
  color: string;
  zenith: string;
  horizon: string;
  /** Shell thickness as a fraction of radius. */
  height: number;
}

export interface PlanetDef {
  index: number;
  name: string;
  seed: number;
  type: PlanetType;
  radius: number;
  center: V3;
  /** Liquid (water/lava/ice sheet) at height 0. */
  sea: boolean;
  maxHeight: number;
  gravity: number;
  atmo: AtmosphereDef | null;
  flora: boolean;
  /** Probability that a resource cell holds a node. */
  resources: number;
}

export interface StationDef { name: string; pos: V3; radius: number; planet: number }
export interface GateDef { index: number; pos: V3; target: number; name: string }
export interface Rock { x: number; y: number; z: number; r: number; seed: number }
export interface AsteroidField { index: number; center: V3; radius: number; rocks: Rock[] }
export interface StarDef { color: string; radius: number; pos: V3 }

export interface SystemDef {
  id: number;
  seed: number;
  name: string;
  star: StarDef;
  planets: PlanetDef[];
  station: StationDef;
  gates: GateDef[];
  fields: AsteroidField[];
  spawn: V3;
  pirates: number;
}

const ATMOS: Record<PlanetType, AtmosphereDef | null> = {
  terran: { color: '#8fc8ff', zenith: '#3f7fe0', horizon: '#cfe6ff', height: 0.16 },
  ocean: { color: '#7fbfff', zenith: '#2f6fd8', horizon: '#c0e4ff', height: 0.16 },
  alien: { color: '#7affe0', zenith: '#4a2aa8', horizon: '#ff9eb5', height: 0.16 },
  desert: { color: '#ffb27a', zenith: '#6a8ab8', horizon: '#f0c090', height: 0.12 },
  ice: { color: '#cfe8ff', zenith: '#6a9ae0', horizon: '#eef6ff', height: 0.12 },
  lava: { color: '#ff6a3a', zenith: '#3a1414', horizon: '#c0502a', height: 0.14 },
  barren: null,
};
const HAS_SEA: Record<PlanetType, boolean> = { terran: true, ocean: true, alien: true, desert: false, ice: true, lava: true, barren: false };
const FLORA: Record<PlanetType, boolean> = { terran: true, ocean: true, alien: true, desert: false, ice: false, lava: false, barren: false };
const STAR_COLORS = ['#fff1d0', '#ffd08a', '#e6eeff', '#ffb080'];

function pickType(rng: Rng, orbit: number, habitableTaken: boolean): PlanetType {
  if (orbit === 0) return rng.pick(['lava', 'desert', 'barren'] as const);
  if (orbit === 1) return habitableTaken ? rng.pick(['desert', 'alien', 'barren'] as const) : rng.pick(['terran', 'alien'] as const);
  if (orbit === 2) return rng.pick(['terran', 'ocean', 'alien', 'desert'] as const);
  return rng.pick(['ice', 'barren', 'ice', 'alien'] as const);
}

export function generateSystem(id: number, galaxySeed = GALAXY_SEED): SystemDef {
  const seed = hashInts(galaxySeed, id, 0x51);
  const rng = new Rng(seed);
  const name = makeName(rng);
  const star: StarDef = { color: rng.pick(STAR_COLORS), radius: rng.range(7000, 11000), pos: v3() };

  const count = rng.int(4, 6);
  const planets: PlanetDef[] = [];
  let dist = rng.range(42000, 55000);
  let habitable = false;
  for (let i = 0; i < count; i++) {
    const type = pickType(rng, Math.min(i, 3), habitable);
    if (type === 'terran' || type === 'ocean') habitable = true;
    const radius = Math.round(rng.range(3200, 7200));
    const ang = rng.range(0, Math.PI * 2);
    const center = v3(Math.cos(ang) * dist, rng.range(-4000, 4000), Math.sin(ang) * dist);
    planets.push({
      index: i,
      name: `${name} ${ROMAN[i]}`,
      seed: hashInts(seed, i, 0x9a),
      type,
      radius,
      center,
      sea: HAS_SEA[type],
      maxHeight: radius * (type === 'barren' ? 0.035 : type === 'desert' ? 0.045 : 0.055),
      gravity: 9.8 * rng.range(0.55, 1.15),
      atmo: ATMOS[type],
      flora: FLORA[type],
      resources: type === 'barren' || type === 'lava' ? 0.55 : 0.4,
    });
    dist += rng.range(30000, 42000);
  }

  // Station orbits the friendliest planet, on its sunlit side.
  const home = planets.find((p) => p.type === 'terran' || p.type === 'ocean') ?? planets.find((p) => p.atmo) ?? planets[1];
  const toSun = vnorm(v3(), vscale(v3(), home.center, -1));
  const tilt = vnorm(v3(), vadd(v3(), toSun, v3(0, 0.35, 0)));
  const stationPos = vadd(v3(), home.center, vscale(v3(), tilt, home.radius * 2.6));
  const station: StationDef = { name: `${home.name} Station`, pos: stationPos, radius: 160, planet: home.index };
  const spawn = vadd(v3(), stationPos, vscale(v3(), tilt, 900));

  const clearOf = (p: V3, margin: number) => planets.every((pl) => vdist(p, pl.center) > pl.radius * 3 + margin) && vdist(p, star.pos) > star.radius * 4;

  const gates: GateDef[] = [];
  let gi = 0;
  for (let k = 1; k < SYSTEM_COUNT; k++) {
    const target = (id + k) % SYSTEM_COUNT;
    for (let tries = 0; tries < 200; tries++) {
      const a = rng.range(0, Math.PI * 2);
      const d = rng.range(26000, 42000);
      const p = v3(stationPos.x + Math.cos(a) * d, stationPos.y + rng.range(-3000, 3000), stationPos.z + Math.sin(a) * d);
      if (clearOf(p, 2000) && gates.every((g) => vdist(g.pos, p) > 15000)) {
        gates.push({ index: gi++, pos: p, target, name: `Gate → ${makeName(new Rng(hashInts(galaxySeed, target, 0x51)))}` });
        break;
      }
    }
  }

  const fields: AsteroidField[] = [];
  for (let f = 0; f < 2; f++) {
    for (let tries = 0; tries < 200; tries++) {
      const a = rng.range(0, Math.PI * 2);
      const d = rng.range(14000, 26000);
      const c = v3(stationPos.x + Math.cos(a) * d, stationPos.y + rng.range(-2000, 2000), stationPos.z + Math.sin(a) * d);
      if (!clearOf(c, 3000) || fields.some((fl) => vdist(fl.center, c) < 8000) || gates.some((g) => vdist(g.pos, c) < 6000)) continue;
      const radius = rng.range(1400, 2000);
      const rocks: Rock[] = [];
      for (let r = 0; r < 110; r++) {
        const u = rng.range(-1, 1), th = rng.range(0, Math.PI * 2), rr = Math.cbrt(rng.float()) * radius;
        const s = Math.sqrt(1 - u * u);
        rocks.push({ x: c.x + Math.cos(th) * s * rr, y: c.y + u * rr * 0.45, z: c.z + Math.sin(th) * s * rr, r: rng.range(8, 16) * (rng.chance(0.15) ? 4 : 1), seed: rng.int(0, 1e9) });
      }
      fields.push({ index: f, center: c, radius, rocks });
      break;
    }
  }

  return { id, seed, name, star, planets, station, gates, fields, spawn, pirates: 7 };
}

const systemCache = new Map<number, SystemDef>();
export function getSystem(id: number): SystemDef {
  let s = systemCache.get(id);
  if (!s) {
    s = generateSystem(id);
    systemCache.set(id, s);
  }
  return s;
}
