/**
 * Storming pirate bases. Every pirate outpost on a planet (sites.ts) has three flak towers,
 * a shield generator and a command bunker. While the generator stands, a force dome closes
 * the bunker's blast door; with the towers and the generator down, a pilot on foot can open
 * the door and ride the lift down into the bunker, where the garrison fights back like a
 * boarded ship's crew (boarding.ts). Taking the command console captures the base for the
 * pilot and their group for a while: its towers are rebuilt on their side, the depot fills
 * up with plunder, landed ships are repaired and refuelled on its pad. The Syndicate sends
 * raiders to take it back; if they knock out every tower, or the time runs out, the base is
 * pirate again.
 *
 * The bunker is a walkable deck like a boarded ship's (x to the right, y up from the floor,
 * −z forward from the lift), kept in a pocket far out in space, since nothing outside can be
 * seen from it; tools/blender/build_bunker.py models it to these numbers.
 */
import { SHIP_REACH, type BoardLayout } from './boarding.ts';
import type { DeckLayout, Room } from './station/deck.ts';
import type { V3 } from './math/vec.ts';

// ------------------------------------------------------------------ the outpost (site plane: x east, z north)
/** The bunker's blockhouse: a box with the blast door in its west wall. */
export const BUNKER = { x0: 20, x1: 28, z0: -2, z1: 6, h: 5.5, door: { x: 19.2, z: 2 } };
/** The shield generator tower (its pylon is the networked entity, see outposts.ts). */
export const GENERATOR = { x: -14, z: -24, r: 2.8, h: 11 };
/** How close to the blast door a pilot on foot must stand to go in. */
export const DOOR_REACH = 5.5;
/** Radius of the force dome over the blockhouse while the generator stands. */
export const DOME_R = 9;
/** Where a landed ship gets repaired and refuelled (the pad in the middle of the base). */
export const PAD_R = 16;

// ------------------------------------------------------------------ rules
/** How long a captured base stays with its captors (s). */
export const HOLD_TIME = 30 * 60;
/** First counterattack after the capture, then one every WAVE_EVERY (± a minute). */
export const FIRST_WAVE = 4 * 60;
export const WAVE_EVERY = 6 * 60;
/** Raiders in a counterattack: grows with each wave. */
export const waveSize = (n: number) => Math.min(6, 3 + n);
/** A destroyed tower of a held base is rebuilt after this long (s). */
export const REBUILD = 120;
/** The depot gets new plunder this often (s), up to DEPOT_CAP units. */
export const DEPOT_EVERY = 120;
export const DEPOT_CAP = 40;
/** On the pad of a held base: hull and shield per second (share of max), one fuel cell per this many s. */
export const PAD_REPAIR = 0.08;
export const PAD_FUEL_EVERY = 4;
/** Paid to the captors (split as a bounty). */
export const CAPTURE_BOUNTY = 900;
/** Garrison size (plus the commander). */
export const GARRISON = 6;
export const COMMANDER = { hp: 120, dmg: 12 };

/** A base's state as clients see it. */
export type BaseState = 'pirate' | 'open' | 'held';
export interface BaseInfo {
  planet: number; site: number; name: string; state: BaseState;
  /** Shield generator standing (bunker sealed). */
  shield: boolean;
  /** Pirate towers standing; garrison left in the bunker. */
  towers: number; garrison: number;
  /** Held: captors (pilot names) and server time when the pirates get it back. */
  owners?: string[]; until?: number;
  /** Held: a counterattack under way (raiders left). */
  raid?: number;
  /** Held: plunder waiting in the depot (units). */
  depot?: number;
}

export const baseKey = (planet: number, site: number) => planet * 64 + site;

/**
 * Where the bunker deck is kept (world space, its floor centre): a pocket far below the
 * station, one per base.
 */
export function basePocket(station: V3, planet: number, site: number, out: V3): V3 {
  out.x = station.x + (site - 4) * 400;
  out.y = station.y - 90000 - planet * 600;
  out.z = station.z;
  return out;
}

// ------------------------------------------------------------------ the bunker
export type BunkerRoom = 'lift' | 'hall' | 'armory' | 'reactor' | 'barracks' | 'comms' | 'command';
export const BUNKER_ROOMS: (Room & { key: BunkerRoom })[] = [
  { key: 'lift', name: 'Лифт', x0: -2.5, z0: 12, x1: 2.5, z1: 18, ceil: 3.4 },
  { key: 'hall', name: 'Галерея', x0: -3, z0: -14, x1: 3, z1: 12, ceil: 4.5 },
  { key: 'armory', name: 'Склад добычи', x0: -15, z0: 0, x1: -3, z1: 11, ceil: 4 },
  { key: 'reactor', name: 'Генераторная', x0: -15, z0: -12, x1: -3, z1: -2, ceil: 5 },
  { key: 'barracks', name: 'Казарма', x0: 3, z0: 1, x1: 15, z1: 11, ceil: 3.4 },
  { key: 'comms', name: 'Радиорубка', x0: 3, z0: -12, x1: 13, z1: -1, ceil: 3.4 },
  { key: 'command', name: 'Командный пункт', x0: -8, z0: -26, x1: 8, z1: -14, ceil: 4.2 },
];

export const BUNKER_DOORS: Record<Exclude<BunkerRoom, 'hall'>, { in: { x: number; z: number }; out: { x: number; z: number } }> = {
  lift: { in: { x: 0, z: 13.5 }, out: { x: 0, z: 10.5 } },
  armory: { in: { x: -4.4, z: 6 }, out: { x: 0, z: 6 } },
  barracks: { in: { x: 4.4, z: 4 }, out: { x: 0, z: 4 } },
  reactor: { in: { x: -4.4, z: -7 }, out: { x: 0, z: -7 } },
  comms: { in: { x: 4.4, z: -6 }, out: { x: 0, z: -6 } },
  command: { in: { x: 0, z: -15.5 }, out: { x: 0, z: -12.5 } },
};

export const BUNKER_HATCH = { x: 0, z: 16 };
export const BUNKER_CHEST = { x: -11, z: 6 };
export const BUNKER_CONSOLE = { x: 0, z: -22.6 };

export const BUNKER_WALLS: [number, number, number, number][] = [
  // lift (the cage door at z = 12 opens for whoever stands by it)
  [-2.5, 18, 2.5, 18], [-2.5, 12, -2.5, 18], [2.5, 12, 2.5, 18], [-3, 12, -1.2, 12], [1.2, 12, 3, 12],
  // hall (doorways: reactor z −8..−6 and armory z 5..7 to the left, comms z −7..−5 and barracks z 3..5 to the right)
  [-3, -14, -3, -8], [-3, -6, -3, 5], [-3, 7, -3, 12],
  [3, -14, 3, -7], [3, -5, 3, 3], [3, 5, 3, 12],
  // command post (doorway x −1.6..1.6)
  [-8, -14, -1.6, -14], [1.6, -14, 8, -14], [-8, -26, -8, -14], [8, -26, 8, -14], [-8, -26, 8, -26],
  // armory, reactor
  [-15, 0, -15, 11], [-15, 11, -3, 11], [-15, 0, -3, 0],
  [-15, -12, -15, -2], [-15, -2, -3, -2], [-15, -12, -3, -12],
  // barracks, comms
  [15, 1, 15, 11], [3, 11, 15, 11], [3, 1, 15, 1],
  [13, -12, 13, -1], [3, -1, 13, -1], [3, -12, 13, -12],
];

export const BUNKER_POSTS: { x: number; z: number; r: number }[] = [
  // armory: the strongbox, stacked loot and weapon racks
  { x: BUNKER_CHEST.x, z: BUNKER_CHEST.z, r: 1.1 },
  { x: -13.4, z: 9.4, r: 1.2 }, { x: -13.4, z: 1.6, r: 1.2 }, { x: -7, z: 9.7, r: 0.8 }, { x: -7.5, z: 1.2, r: 0.8 },
  // reactor: the shield generator's core
  { x: -9.5, z: -7, r: 2.2 },
  // barracks: bunks along the far wall and by the end wall, a table
  { x: 6.2, z: 9.9, r: 0.9 }, { x: 9.8, z: 9.9, r: 0.9 }, { x: 13.9, z: 7, r: 0.9 }, { x: 9.5, z: 4.6, r: 0.8 },
  // comms: radio racks
  { x: 11.9, z: -4.5, r: 0.8 }, { x: 11.9, z: -9, r: 0.8 }, { x: 7, z: -11, r: 0.8 },
  // command post: the console, the plot table, side screens
  { x: BUNKER_CONSOLE.x, z: BUNKER_CONSOLE.z - 1.2, r: 0.9 }, { x: -4.5, z: -19.5, r: 1.1 }, { x: 4.5, z: -19.5, r: 1.1 },
  { x: -6.9, z: -24.8, r: 0.7 }, { x: 6.9, z: -24.8, r: 0.7 },
];

export const BUNKER_DECK: DeckLayout = { rooms: BUNKER_ROOMS, walls: BUNKER_WALLS, posts: BUNKER_POSTS };

export const BUNKER_LAYOUT: BoardLayout = {
  key: 'base', rooms: BUNKER_ROOMS, hub: 'hall', doors: BUNKER_DOORS, walls: BUNKER_WALLS, deck: BUNKER_DECK,
  hatch: BUNKER_HATCH, chest: BUNKER_CHEST, helm: BUNKER_CONSOLE,
  chestSpot: { x: BUNKER_CHEST.x + 1.6, z: BUNKER_CHEST.z, fx: -1, fz: 0 }, helmSpot: { x: BUNKER_CONSOLE.x, z: BUNKER_CONSOLE.z + 1.3, fx: 0, fz: -1 },
  floorY: 0,
};

/** Garrison posts in the order they are manned, and the commander's. */
export const GARRISON_POSTS: { x: number; z: number }[] = [
  { x: -8, z: 4 }, { x: 8, z: 7.2 }, { x: -7, z: -4.5 }, { x: 8, z: -8 }, { x: 0, z: -3 }, { x: 11.5, z: 3 }, { x: 1.5, z: 8.5 }, { x: -11.5, z: -10 },
];
export const COMMANDER_POST = { x: 0, z: -18.5 };

export { SHIP_REACH as BUNKER_REACH };
