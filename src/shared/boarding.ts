/**
 * Boarding NPC ships. A pirate or a convoy ship shot down to a quarter of its hull is
 * disabled: engines and guns dead, it drifts to a stop. A pilot who flies up close can
 * dock with it and go aboard; inside, the crew fights back with hand blasters. Once
 * the crew is down the hold is there to be emptied and the ship can be claimed as a
 * prize, which any station's shipyard buys.
 *
 * The inside is the same for every boardable ship: a walkable deck in ship-local
 * coordinates (x to starboard, y up from the floor, −z towards the bow, like the ship's
 * own axes), FLOOR_Y metres below the ship's centre. The airlock is at the stern, then a
 * corridor with the hold to port, the crew quarters and the engine room to starboard,
 * and the bridge in the bow. tools/blender/build_boarding.py models it to these numbers.
 */
import type { DeckLayout, Room } from './station/deck.ts';

/** The deck lies this far below the ship's centre. */
export const FLOOR_Y = -1.6;

export type ShipRoom = 'airlock' | 'corridor' | 'hold' | 'quarters' | 'engine' | 'bridge';
export const SHIP_ROOMS: (Room & { key: ShipRoom })[] = [
  { key: 'airlock', name: 'Шлюз', x0: -2, z0: 10, x1: 2, z1: 16, ceil: 3 },
  { key: 'corridor', name: 'Коридор', x0: -1.75, z0: -10, x1: 1.75, z1: 10, ceil: 3 },
  { key: 'hold', name: 'Трюм', x0: -13, z0: -4, x1: -1.75, z1: 9, ceil: 5.5 },
  { key: 'quarters', name: 'Кубрик', x0: 1.75, z0: 1, x1: 11, z1: 9, ceil: 3 },
  { key: 'engine', name: 'Машинное отделение', x0: 1.75, z0: -9, x1: 11, z1: -1, ceil: 4 },
  { key: 'bridge', name: 'Мостик', x0: -6, z0: -20, x1: 6, z1: -10, ceil: 3.6 },
];

/** Doorways: a point just inside the room and one in the corridor opposite. */
export const SHIP_DOORS: Record<Exclude<ShipRoom, 'corridor'>, { in: { x: number; z: number }; out: { x: number; z: number } }> = {
  airlock: { in: { x: 0, z: 11.5 }, out: { x: 0, z: 8.5 } },
  hold: { in: { x: -3.4, z: 2.5 }, out: { x: 0, z: 2.5 } },
  quarters: { in: { x: 3.4, z: 4.5 }, out: { x: 0, z: 4.5 } },
  engine: { in: { x: 3.4, z: -5 }, out: { x: 0, z: -5 } },
  bridge: { in: { x: 0, z: -11.5 }, out: { x: 0, z: -8.5 } },
};

/** Where a boarder comes in (and goes back to their ship), the hold's strongbox and the helm. */
export const SHIP_HATCH = { x: 0, z: 14 };
export const SHIP_CHEST = { x: -8, z: 2.5 };
export const SHIP_HELM = { x: 0, z: -16.6 };
/** How close to stand to use them. */
export const SHIP_REACH = 2.6;

export const SHIP_WALLS: [number, number, number, number][] = [
  // airlock: the outer hatch (shut behind the boarder) and the inner one at z = 10
  [-2, 16, 2, 16], [-2, 10, -2, 16], [2, 10, 2, 16], [-2, 10, -1.2, 10], [1.2, 10, 2, 10],
  // corridor (doorways: hold z 1..4, quarters z 3.5..5.5, engine room z −6..−4; the bridge is open)
  [-1.75, -10, -1.75, 1], [-1.75, 4, -1.75, 10],
  [1.75, -10, 1.75, -6], [1.75, -4, 1.75, 3.5], [1.75, 5.5, 1.75, 10],
  // hold
  [-13, -4, -13, 9], [-13, 9, -1.75, 9], [-13, -4, -1.75, -4],
  // quarters
  [1.75, 9, 11, 9], [11, 1, 11, 9], [1.75, 1, 11, 1],
  // engine room
  [1.75, -1, 11, -1], [11, -9, 11, -1], [1.75, -9, 11, -9],
  // bridge
  [-6, -10, -1.75, -10], [1.75, -10, 6, -10], [-6, -20, -6, -10], [6, -20, 6, -10], [-6, -20, 6, -20],
];

export const SHIP_POSTS: { x: number; z: number; r: number }[] = [
  // hold: the strongbox and stacks of crates
  { x: SHIP_CHEST.x, z: SHIP_CHEST.z, r: 1.1 },
  { x: -11, z: 7, r: 1.2 }, { x: -11, z: -2, r: 1.2 }, { x: -5, z: 7.2, r: 0.9 }, { x: -6, z: -2.4, r: 0.9 },
  // quarters: two bunks along the far wall, a mess table
  { x: 4.6, z: 7.9, r: 0.9 }, { x: 8.6, z: 7.9, r: 0.9 }, { x: 6.6, z: 3.6, r: 0.8 },
  // engine room: the reactor
  { x: 7, z: -5, r: 1.7 },
  // bridge: helm and the side consoles
  { x: SHIP_HELM.x, z: SHIP_HELM.z - 1.2, r: 0.9 }, { x: -4.2, z: -17.6, r: 0.7 }, { x: 4.2, z: -17.6, r: 0.7 },
];

export const SHIP_DECK: DeckLayout = { rooms: SHIP_ROOMS, walls: SHIP_WALLS, posts: SHIP_POSTS };

export const shipRoomAt = (x: number, z: number) => SHIP_ROOMS.find((r) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1) ?? null;

/** Does the line from a to b (deck plane) pass no wall? */
export function deckSight(ax: number, az: number, bx: number, bz: number, walls = SHIP_WALLS): boolean {
  const dx = bx - ax, dz = bz - az;
  for (const [x0, z0, x1, z1] of walls) {
    const ex = x1 - x0, ez = z1 - z0, den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((x0 - ax) * ez - (z0 - az) * ex) / den, u = ((x0 - ax) * dz - (z0 - az) * dx) / den;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) return false;
  }
  return true;
}

/** How far along a→b (0..1) the first wall is (1: none). */
export function deckReach(ax: number, az: number, bx: number, bz: number, walls = SHIP_WALLS): number {
  const dx = bx - ax, dz = bz - az;
  let best = 1;
  for (const [x0, z0, x1, z1] of walls) {
    const ex = x1 - x0, ez = z1 - z0, den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((x0 - ax) * ez - (z0 - az) * ex) / den, u = ((x0 - ax) * dz - (z0 - az) * dx) / den;
    if (t > 0 && t < best && u >= 0 && u <= 1) best = t;
  }
  return best;
}

/** The next point to walk to on the way from `from` to `to` through the doorways. */
export function deckWaypoint(from: { x: number; z: number }, to: { x: number; z: number }): { x: number; z: number } {
  if (deckSight(from.x, from.z, to.x, to.z)) return to;
  const rf = shipRoomAt(from.x, from.z)?.key ?? 'corridor', rt = shipRoomAt(to.x, to.z)?.key ?? 'corridor';
  const near = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z) < 0.9;
  if (rf !== 'corridor' && rf !== rt) {
    const d = SHIP_DOORS[rf];
    return near(from, d.in) || deckSight(from.x, from.z, d.out.x, d.out.z) ? d.out : d.in;
  }
  if (rt !== 'corridor') {
    const d = SHIP_DOORS[rt];
    return near(from, d.out) || deckSight(from.x, from.z, d.in.x, d.in.z) ? d.in : d.out;
  }
  return to;
}

// ------------------------------------------------------------------ rules
/** A ship is disabled (instead of blown up) when a pilot's fire takes its hull below this share. */
export const DISABLE_HULL = 0.25;
/** Seconds a disabled ship stays dead in space with nobody aboard before its crew restarts it. */
export const DISABLE_TIME = 90;
/** Seconds after being disabled during which further hits do nothing (the volley already in flight). */
export const DISABLE_GRACE = 1.5;
/** How close (m, from the hull) and how slow (m/s) a pilot must be to dock with a disabled ship. */
export const BOARD_RANGE = 140;
export const BOARD_SPEED = 40;

/** The crew: hit points, blaster damage and time between shots. */
export const CREW = {
  hp: 42, captainHp: 75, dmg: 7, captainDmg: 10, cooldown: 1.35, sight: 26, hitR: 0.5, height: 1.8,
} as const;

export type PrizeKind = 'pirate' | 'freighter';
/** A captured ship waiting in the station shipyard to be sold. */
export interface Prize { id: string; name: string; kind: PrizeKind; value: number }
export const PRIZE_NAMES: Record<PrizeKind, string> = { pirate: 'Пиратский истребитель', freighter: 'Грузовик' };
/** What a shipyard pays for a prize (credits, range). */
export const PRIZE_VALUE: Record<PrizeKind, [number, number]> = { pirate: [700, 1100], freighter: [2200, 3000] };
export const MAX_PRIZES = 6;

export function validPrizes(v: unknown): Prize[] {
  if (!Array.isArray(v)) return [];
  return v.filter((p): p is Prize => !!p && typeof p.id === 'string' && typeof p.name === 'string' && (p.kind === 'pirate' || p.kind === 'freighter') && typeof p.value === 'number' && p.value > 0)
    .slice(0, MAX_PRIZES).map((p) => ({ id: p.id, name: p.name, kind: p.kind, value: Math.floor(p.value) }));
}
