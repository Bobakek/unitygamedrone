import { hueToHex } from '../color.ts';
import { hashString, Rng } from '../math/rng.ts';
import type { HullKey } from './hulls.ts';

export type ShipClass = HullKey | 'pirate' | 'freighter' | 'turret' | 'generator';

export interface Blueprint {
  cls: ShipClass;
  seed: number;
  hull: string; hull2: string; accent: string; glass: string; engine: string; glow: string;
}

/** Player ship look, derived from the pilot name so everyone sees the same colours on any ship class. */
export function playerBlueprint(name: string, cls: HullKey = 'fighter'): Blueprint {
  const seed = hashString(name.toLowerCase());
  const rng = new Rng(seed);
  const hue = rng.float();
  return {
    cls, seed,
    hull: '#ece6da',
    hull2: hueToHex(hue, 0.62, 0.52),
    accent: hueToHex((hue + 0.08 + rng.range(0.25, 0.45)) % 1, 0.8, 0.6),
    glass: '#8fe3ff', engine: '#4b515c', glow: '#8ff8ff',
  };
}

export function pirateBlueprint(seed: number): Blueprint {
  const rng = new Rng(seed);
  return {
    cls: 'pirate', seed,
    hull: rng.pick(['#6a557c', '#5a4a5e', '#6e5048']),
    hull2: '#3a3046', accent: rng.pick(['#e8485a', '#ff7a2a', '#d83a8a']),
    glass: '#ffcf6b', engine: '#2d2733', glow: '#ff7a3d',
  };
}

/** Slow armoured cargo hauler escorted by pirates. */
export function freighterBlueprint(seed: number): Blueprint {
  const rng = new Rng(seed);
  return {
    cls: 'freighter', seed,
    hull: rng.pick(['#8a7a62', '#6f6a60', '#7c6450']),
    hull2: '#3c3a40', accent: rng.pick(['#e8a23a', '#d0482e', '#c8c030']),
    glass: '#ffd27a', engine: '#2f2c30', glow: '#ffae4a',
  };
}

/** Flak turret ball on pirate outposts (`held`: the base was captured, the towers fly the captors' colours). */
export function turretBlueprint(seed: number, held = false): Blueprint {
  const rng = new Rng(seed);
  if (held) return { cls: 'turret', seed, hull: '#4a5a66', hull2: '#24303a', accent: '#3ad0ff', glass: '#6af0ff', engine: '#26323a', glow: '#5ae8ff' };
  return {
    cls: 'turret', seed,
    hull: rng.pick(['#5a4a5e', '#4e4650']), hull2: '#2a2430', accent: '#e8485a',
    glass: '#ff6a4a', engine: '#2d2733', glow: '#ff5a3a',
  };
}

/** Shield generator pylon of a pirate base (Blender model, see tools/blender/build_bunker.py). */
export function generatorBlueprint(seed: number, held = false): Blueprint {
  return held
    ? { cls: 'generator', seed, hull: '#55606a', hull2: '#2a3640', accent: '#3ad0ff', glass: '#6af0ff', engine: '#26323a', glow: '#5ae8ff' }
    : { cls: 'generator', seed, hull: '#5a4a5e', hull2: '#2a2430', accent: '#e8485a', glass: '#ff9a4a', engine: '#2d2733', glow: '#ff6a3a' };
}
