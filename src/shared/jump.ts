import { getGalaxy } from './galaxy/galaxy.ts';
import { hashInts } from './math/rng.ts';
import type { HullKey } from './ships/hulls.ts';
import { GALAXY_SEED } from './constants.ts';

/**
 * The jump drive: every ship can jump straight to a star within range, gates or not,
 * burning fuel cells bought at station markets. The drive charges for a while first
 * (the ship is out in the open; a hit breaks the charge) and drops the ship a few
 * kilometres from the chosen planet or station. Gates stay free.
 */

/** Longest jump (light years on the galaxy map). */
export const JUMP_RANGE = 25;
/** Light years per fuel cell (a jump costs at least one). */
export const LY_PER_CELL = 10;
/** Seconds the drive charges before the jump. */
export const JUMP_CHARGE = 10;
/** Fuel cells a new pilot starts with. */
export const START_FUEL = 3;
/** Fuel tank (cells) of each ship class. */
export const FUEL_TANK: Record<HullKey, number> = { fighter: 6, miner: 6, hauler: 10 };
export const tankOf = (ship: HullKey) => FUEL_TANK[ship] ?? FUEL_TANK.fighter;
/** Base price of a cell (credits), scaled per system by fuelPrice. */
export const FUEL_PRICE = 45;
/** Arrival this far (m) from the station, or from a planet's surface. */
export const ARRIVAL_RANGE: readonly [number, number] = [3000, 6000];
/** Chance that pirates find a ship dropping out of a jump on the far rim. */
export const AMBUSH_CHANCE = 0.35;

/** Distance on the galaxy map (light years). */
export function jumpDistance(from: number, to: number): number {
  const s = getGalaxy().stars;
  return Math.hypot(s[from].x - s[to].x, s[from].y - s[to].y);
}

/** Fuel cells a jump takes, or -1 out of range. */
export function jumpCost(from: number, to: number): number {
  if (from === to) return -1;
  const d = jumpDistance(from, to);
  return d > JUMP_RANGE ? -1 : Math.max(1, Math.ceil(d / LY_PER_CELL));
}

/** A cell at this system's station: cheap in the core, dear on the rim. */
export function fuelPrice(system: number): number {
  const sec = getGalaxy().stars[system]?.security ?? 'mid';
  const zone = sec === 'core' ? 0.85 : sec === 'mid' ? 1 : 1.35;
  const jitter = 0.9 + (hashInts(GALAXY_SEED, system, 0xf0e1) % 1000) / 5000;
  return Math.round(FUEL_PRICE * zone * jitter);
}

/** Where to come out: the station (-1) or a planet by index. */
export type JumpTarget = number;
