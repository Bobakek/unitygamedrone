import { hueToHex } from '../color.ts';
import { hashString, Rng } from '../math/rng.ts';
import type { HullKey } from './hulls.ts';

export type ShipClass = HullKey | 'pirate' | 'freighter' | 'turret';

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

/** Flak turret ball on pirate outposts. */
export function turretBlueprint(seed: number): Blueprint {
  const rng = new Rng(seed);
  return {
    cls: 'turret', seed,
    hull: rng.pick(['#5a4a5e', '#4e4650']), hull2: '#2a2430', accent: '#e8485a',
    glass: '#ff6a4a', engine: '#2d2733', glow: '#ff5a3a',
  };
}
