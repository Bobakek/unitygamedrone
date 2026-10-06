/**
 * Player ship classes sold at stations. Every pilot owns the fighter; the hauler and the
 * mining ship are bought once and then swapped freely while docked. Upgrades belong to the
 * pilot, so they carry over to whichever ship is flown; each class scales them its own way.
 */
export type HullKey = 'fighter' | 'hauler' | 'miner';
export const HULL_KEYS: readonly HullKey[] = ['fighter', 'hauler', 'miner'];

export interface HullDef {
  key: HullKey;
  name: string;
  /** One line for the shipyard. */
  blurb: string;
  price: number;
  /** Hold at cargo upgrade level 1, plus this much per further level. */
  cargo: number; cargoPerLevel: number;
  /** Multipliers on the upgrade-derived hull, shield and laser numbers. */
  hull: number; shield: number; laser: number;
  /** Multipliers on speeds, acceleration and turn rates. */
  speed: number; accel: number; turn: number; cruise: number;
  /** Collision radius (m) and the height of the origin above the ground when landed. */
  radius: number; land: number;
  /** Mining power: ore pulled from asteroids per point of laser damage (0 = cannot mine). */
  mining: number;
}

export const HULLS: Record<HullKey, HullDef> = {
  fighter: {
    key: 'fighter', name: 'Истребитель «Стриж»', blurb: 'Быстрый и вёрткий, с лучшими пушками. Трюм небольшой.',
    price: 0, cargo: 12, cargoPerLevel: 10, hull: 1, shield: 1, laser: 1, speed: 1, accel: 1, turn: 1, cruise: 1, radius: 5, land: 1.75, mining: 0,
  },
  hauler: {
    key: 'hauler', name: 'Грузовик «Тягач»', blurb: 'Огромный трюм и толстая броня. Медленный, неповоротливый, пушки слабые.',
    price: 3800, cargo: 60, cargoPerLevel: 22, hull: 1.7, shield: 1.25, laser: 0.55, speed: 0.62, accel: 0.5, turn: 0.5, cruise: 0.85, radius: 11, land: 4.2, mining: 0,
  },
  miner: {
    key: 'miner', name: 'Шахтёр «Крот»', blurb: 'Буровые лазеры добывают руду и кристаллы из астероидов. Трюм средний.',
    price: 2600, cargo: 30, cargoPerLevel: 14, hull: 1.3, shield: 1, laser: 0.7, speed: 0.8, accel: 0.8, turn: 0.78, cruise: 0.92, radius: 7, land: 2.7, mining: 1,
  },
};

export const isHull = (k: unknown): k is HullKey => typeof k === 'string' && (HULL_KEYS as readonly string[]).includes(k);

/** Ships a pilot owns, from stored data (the fighter always). */
export function validHangar(list: unknown): HullKey[] {
  const out: HullKey[] = ['fighter'];
  if (Array.isArray(list)) for (const k of list) if (isHull(k) && !out.includes(k)) out.push(k);
  return out;
}

/** Laser damage needed to cut one unit out of an asteroid with mining power 1. */
export const MINE_WORK = 55;
/** Units an asteroid of radius r holds before it is spent (big rocks hold more). */
export const rockUnits = (r: number) => Math.max(3, Math.round(r / 4));
/** Seconds for a spent asteroid to give one more unit. */
export const ROCK_REGEN = 90;
/** Share of crystal-bearing rocks (by seed); the rest give ore. */
export const rockGood = (seed: number): 'ore' | 'crystal' => (seed % 5 === 0 ? 'crystal' : 'ore');

/** The ship flown and the ships owned, from stored data (unknown or unowned → the fighter). */
export function hangarOf(ship: unknown, ships: unknown): { ship: HullKey; ships: HullKey[] } {
  const owned = validHangar(ships);
  return { ships: owned, ship: isHull(ship) && owned.includes(ship) ? ship : 'fighter' };
}
