import { hexToLinear } from '../color.ts';
import type { PlanetDef, PlanetType } from '../galaxy/system-gen.ts';
import { fbm, noiseFor, ridged, smoothstep } from '../math/noise.ts';
import { hashInts } from '../math/rng.ts';

interface Profile { seaBias: number; mountain: number; hills: number; terrace: number }

const PROFILES: Record<PlanetType, Profile> = {
  terran: { seaBias: 0.02, mountain: 1.0, hills: 0.1, terrace: 0 },
  ocean: { seaBias: -0.22, mountain: 0.8, hills: 0.08, terrace: 0 },
  alien: { seaBias: 0.06, mountain: 0.85, hills: 0.14, terrace: 0 },
  desert: { seaBias: 0.25, mountain: 0.7, hills: 0.12, terrace: 16 },
  ice: { seaBias: 0.0, mountain: 1.2, hills: 0.1, terrace: 0 },
  lava: { seaBias: -0.04, mountain: 1.3, hills: 0.1, terrace: 0 },
  barren: { seaBias: 0.15, mountain: 0.6, hills: 0.25, terrace: 0 },
};

/** Impact craters: frequencies of the cell layers and depth as a fraction of maxHeight. */
const CRATERS: Partial<Record<PlanetType, { freq: number[]; depth: number }>> = {
  barren: { freq: [4.5, 10, 22], depth: 0.5 },
  ice: { freq: [6, 15], depth: 0.25 },
  desert: { freq: [8], depth: 0.15 },
};

/** Worley-style crater field: bowl + raised rim around hashed cell centres. */
function craters(seed: number, x: number, y: number, z: number, freq: number[], depth: number): number {
  let h = 0;
  for (let li = 0; li < freq.length; li++) {
    const f = freq[li];
    const px = x * f, py = y * f, pz = z * f;
    const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
    const scale = depth * (freq[0] / f);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const cx = ix + dx, cy = iy + dy, cz = iz + dz;
      const hs = hashInts(seed, li, cx, cy, cz);
      if ((hs & 255) > 100) continue;
      const hs2 = hashInts(hs, 7);
      const ox = cx + ((hs >>> 8) & 255) / 255, oy = cy + ((hs >>> 16) & 255) / 255, oz = cz + ((hs2 >>> 8) & 255) / 255;
      const r = 0.22 + ((hs2 >>> 16) & 255) / 255 * 0.26;
      const q = Math.sqrt((px - ox) ** 2 + (py - oy) ** 2 + (pz - oz) ** 2) / r;
      if (q >= 1.6) continue;
      const bowl = q < 1 ? -(1 - q * q) : 0;
      const rim = 0.32 * Math.exp(-(((q - 1) / 0.22) ** 2));
      h += (bowl + rim) * scale;
    }
  }
  return h;
}

/**
 * Terrain height in metres above the planet radius for unit direction (x, y, z).
 * Deterministic: the server uses it for collisions, client workers for meshes.
 */
export function heightAt(p: PlanetDef, x: number, y: number, z: number): number {
  const n = noiseFor(p.seed);
  const pr = PROFILES[p.type];
  const c = fbm(n, x * 1.15 + 11.3, y * 1.15 - 4.7, z * 1.15 + 2.9, 5) + pr.seaBias;
  const land = smoothstep(c, -0.02, 0.3);
  const m = ridged(n, x * 3.3 + 5.1, y * 3.3 + 1.7, z * 3.3 - 8.2, 6);
  const hills = fbm(n, x * 9 + 3.1, y * 9, z * 9 - 1.3, 4);
  let h = (c * 0.5 + m * m * pr.mountain * land + hills * pr.hills) * p.maxHeight;
  if (pr.terrace > 0 && h > 0) {
    const t = h / pr.terrace, f = Math.floor(t);
    h = (f + smoothstep(t - f, 0.7, 1)) * pr.terrace;
  }
  const cr = CRATERS[p.type];
  if (cr) h += craters(p.seed ^ 0x5a5a, x, y, z, cr.freq, cr.depth) * p.maxHeight;
  const k1 = p.radius / 70;
  h += fbm(n, x * k1 + 7.7, y * k1 - 2.2, z * k1 + 5.5, 3) * 6;
  const k2 = p.radius / 11;
  h += fbm(n, x * k2 - 3.3, y * k2 + 9.1, z * k2, 2) * 0.7;
  return h;
}

/** Ground for a pilot on foot: wade in shallows, float with the head above deep water. */
export function footHeight(p: PlanetDef, x: number, y: number, z: number): number {
  const h = heightAt(p, x, y, z);
  return p.sea && h < -1.3 ? -1.3 : h;
}

/** Height of the walkable/collidable surface (liquid is flat at 0). */
export function surfaceHeight(p: PlanetDef, x: number, y: number, z: number): number {
  const h = heightAt(p, x, y, z);
  return p.sea && h < 0 ? 0 : h;
}

type RGB = [number, number, number];
interface Palette { deep: RGB; shallow: RGB; sand: RGB; low: RGB; low2: RGB; high: RGB; peak: RGB; rock: RGB }
const pal = (o: Record<keyof Palette, string>): Palette =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, hexToLinear(v)])) as unknown as Palette;

const PALETTES: Record<PlanetType, Palette> = {
  terran: pal({ deep: '#15407e', shallow: '#3aa6c8', sand: '#e3cf94', low: '#7bb04a', low2: '#3f7f45', high: '#8c8279', peak: '#f3f3f3', rock: '#7d7268' }),
  ocean: pal({ deep: '#103a7a', shallow: '#38b4d0', sand: '#f0dca0', low: '#6cc070', low2: '#3a8f5a', high: '#9a8f80', peak: '#f0f0f0', rock: '#857a6c' }),
  alien: pal({ deep: '#1a4f9a', shallow: '#3de0c8', sand: '#f7e39c', low: '#c070e0', low2: '#8a4fc0', high: '#6e4a9c', peak: '#ffe6ff', rock: '#5e3b8c' }),
  desert: pal({ deep: '#000000', shallow: '#000000', sand: '#e0b27a', low: '#d99a5c', low2: '#c27a45', high: '#a85f38', peak: '#f0cfa0', rock: '#6e4030' }),
  ice: pal({ deep: '#8cc4e8', shallow: '#cfeaff', sand: '#e8f4ff', low: '#f4f8ff', low2: '#d4e6f4', high: '#9fb4c8', peak: '#ffffff', rock: '#6a8098' }),
  lava: pal({ deep: '#ff4a10', shallow: '#ffa030', sand: '#3a2a26', low: '#2e2426', low2: '#443228', high: '#5a4a44', peak: '#8a7a70', rock: '#1e1a1c' }),
  barren: pal({ deep: '#000000', shallow: '#000000', sand: '#9a948e', low: '#8e8a86', low2: '#76726e', high: '#a8a4a0', peak: '#cfcbc6', rock: '#5e5a58' }),
};

function mix(o: RGB, a: RGB, b: RGB, t: number): RGB {
  o[0] = a[0] + (b[0] - a[0]) * t;
  o[1] = a[1] + (b[1] - a[1]) * t;
  o[2] = a[2] + (b[2] - a[2]) * t;
  return o;
}

const tmp: RGB = [0, 0, 0];
/**
 * Biome colour (linear RGB) for a surface point. `h` is the raw (unclamped)
 * height, `slope` is 1 - dot(faceNormal, up).
 */
export function surfaceColor(p: PlanetDef, x: number, y: number, z: number, h: number, slope: number, out: RGB, water = false): RGB {
  const P = PALETTES[p.type];
  const H = p.maxHeight;
  if (p.sea && h < 0) {
    if (water) {
      mix(out, P.shallow, P.deep, smoothstep(-h, 0, H * 0.25));
      if (p.type === 'lava') { out[0] *= 2.2; out[1] *= 2.2; out[2] *= 2.2; }
      return out;
    }
    // sea bed: sand in the shallows, darker rock further down
    mix(out, P.sand, P.rock, smoothstep(-h, 1, H * 0.15));
    const k = p.type === 'lava' ? 0.35 : 0.85 - 0.35 * smoothstep(-h, 0, H * 0.3);
    out[0] *= k; out[1] *= k; out[2] *= k;
    return out;
  }
  const n = noiseFor(p.seed + 17);
  const moist = fbm(n, x * 4.1, y * 4.1, z * 4.1, 3);
  if (p.sea && h < H * 0.012) {
    mix(out, P.sand, P.low, smoothstep(h, H * 0.006, H * 0.012));
  } else {
    mix(out, P.low, P.low2, smoothstep(moist, -0.15, 0.25));
    mix(out, out, P.high, smoothstep(h, H * 0.28, H * 0.5));
    mix(out, out, P.peak, smoothstep(h, H * 0.58, H * 0.72));
  }
  // cliffs show layered rock strata
  const rockK = smoothstep(slope, 0.22, 0.42) * 0.9;
  if (rockK > 0) {
    const band = 0.8 + 0.2 * Math.sin(h * 0.42 + moist * 4);
    mix(tmp, out, [P.rock[0] * band, P.rock[1] * band, P.rock[2] * band], 1);
    mix(out, out, tmp, rockK);
  }
  if (p.type !== 'lava' && p.type !== 'desert') {
    const polar = smoothstep(Math.abs(y) + moist * 0.12, 0.84, 0.9);
    mix(out, out, mix(tmp, P.peak, [1, 1, 1], 0.5), polar);
  }
  return out;
}
