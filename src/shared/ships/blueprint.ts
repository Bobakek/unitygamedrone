import { hueToHex } from '../color.ts';
import { hashString, Rng } from '../math/rng.ts';

export type ShipClass = 'fighter' | 'pirate';

export interface Blueprint {
  cls: ShipClass;
  seed: number;
  hull: string; hull2: string; accent: string; glass: string; engine: string; glow: string;
}

/** Player ship look, derived from the pilot name so everyone sees the same colours. */
export function playerBlueprint(name: string): Blueprint {
  const seed = hashString(name.toLowerCase());
  const rng = new Rng(seed);
  const hue = rng.float();
  return {
    cls: 'fighter', seed,
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
