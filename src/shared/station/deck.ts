/**
 * The walkable inside of a station: a hangar in the docking bay, an airlock
 * corridor and the promenade in the hub, the same in every station. Deck
 * coordinates: x and z along the station's local axes (−z towards the docking
 * bay, +z towards the planet), y up from the deck floor, which lies DECK_Y
 * metres below the station's axis.
 */
import type { CharInput, CharState } from '../sim/character.ts';

export const DECK_Y = -12;
export type TerminalKind = 'trade' | 'upgrades' | 'contracts' | 'wardrobe' | 'trophies';
export interface Terminal { kind: TerminalKind; x: number; z: number; name: string }
export interface Room { name: string; x0: number; z0: number; x1: number; z1: number; ceil: number }

export const ROOMS: Room[] = [
  { name: 'Ангар', x0: -30, z0: -108, x1: 30, z1: -80, ceil: 18 },
  { name: 'Шлюз', x0: -4, z0: -80, x1: 4, z1: -40, ceil: 4.5 },
  { name: 'Променад', x0: -26, z0: -40, x1: 26, z1: 30, ceil: 9 },
  { name: 'Каюта', x0: -22, z0: -56, x1: -8, z1: -40, ceil: 4.2 },
];
/**
 * The pilot's own cabin, off the promenade's back wall beside the airlock: the
 * same room on every station, with the trophies of whoever stands in it (and
 * only them: pilots in a cabin do not see each other, see system.ts). Door,
 * bed and desk positions match tools/blender/build_cabin.py.
 */
export const CABIN = { x0: -22, z0: -56, x1: -8, z1: -40, door: { x: -15, z: -40, half: 1.5 }, bed: { x: -9.6, z: -52.6 }, desk: { x: -9.2, z: -45.5 }, table: { x: -15, z: -50 } };
export const inCabin = (p: { x: number; z: number }) => p.x > CABIN.x0 && p.x < CABIN.x1 && p.z > CABIN.z0 && p.z < CABIN.z1;
/** Where the pilot's ship stands in the hangar (nose towards the bay door) and where the ramp lets them out. */
export const PAD = { x: 0, z: -96 };
export const RAMP = { x: 8.5, z: -88 };
export const TERMINALS: Terminal[] = [
  { kind: 'trade', x: -19, z: -24, name: 'Торговля и ремонт' },
  { kind: 'upgrades', x: -19, z: -2, name: 'Улучшения' },
  { kind: 'contracts', x: 19, z: -24, name: 'Контракты' },
  { kind: 'wardrobe', x: 19, z: -2, name: 'Гардероб' },
  { kind: 'trophies', x: -20.6, z: -42.2, name: 'Коллекция' },
];
export const TERMINAL_REACH = 2.6;
export const BOARD_REACH = 13;

/** Walls of the deck as segments (x0, z0, x1, z1); the gaps are the doorways. */
export const DECK_WALLS: [number, number, number, number][] = [
  // hangar (the bay door at z = −108 is a force field: solid to walkers)
  [-30, -108, 30, -108], [-30, -108, -30, -80], [30, -108, 30, -80], [-30, -80, -4, -80], [4, -80, 30, -80],
  // airlock corridor
  [-4, -80, -4, -40], [4, -80, 4, -40],
  // promenade (the cabin door at x = −15)
  [-26, -40, CABIN.door.x - CABIN.door.half, -40], [CABIN.door.x + CABIN.door.half, -40, -4, -40], [4, -40, 26, -40], [-26, -40, -26, 30], [26, -40, 26, 30], [-26, 30, 26, 30],
];
/** Round obstacles: the ship on its pad, terminals, the holo-map, planters and benches. */
export const DECK_POSTS: { x: number; z: number; r: number }[] = [
  { x: PAD.x, z: PAD.z, r: 6.5 },
  ...TERMINALS.map((t) => ({ x: t.x, z: t.z, r: 0.9 })),
  { x: 0, z: -12, r: 3 },
  ...[-16, 0, 16].map((x) => ({ x, z: 24, r: 1.1 })),
  ...[-22, 22].flatMap((x) => [-30, 12].map((z) => ({ x, z, r: 1 }))),
  // cabin: the bed (two posts along it), the desk, the display table with medals
  { x: CABIN.bed.x, z: CABIN.bed.z - 1, r: 1 }, { x: CABIN.bed.x, z: CABIN.bed.z + 1, r: 1 },
  { x: CABIN.desk.x, z: CABIN.desk.z, r: 0.9 }, { x: CABIN.table.x, z: CABIN.table.z, r: 0.85 },
];

const WALK = 4.4, RUN = 7.5, GRAVITY = 9.8, JUMP = 4.2, R = 0.35;

/** The room a deck point is in (null outside the deck). */
export function roomAt(x: number, z: number): Room | null {
  return ROOMS.find((r) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1) ?? null;
}

export const nearTerminal = (p: { x: number; z: number }) => TERMINALS.find((t) => Math.hypot(t.x - p.x, t.z - p.z) < TERMINAL_REACH) ?? null;

/**
 * Walking on the deck: a flat floor under artificial gravity, a hop, walls and
 * fixtures to bump into. Uses the same input and state as walking on a planet
 * (the heading turns about +y).
 */
export function stepDeck(c: CharState, inp: CharInput, dt: number): void {
  c.air = Math.min(1, c.air + 0.3 * dt);
  c.swim = 0; c.scramble = 0; c.climbMode = 0;
  const th = -inp.yawDelta, cs = Math.cos(th), sn = Math.sin(th);
  const fx = c.f.x * cs + c.f.z * sn, fz = c.f.z * cs - c.f.x * sn, fl = Math.hypot(fx, fz) || 1;
  c.f.x = fx / fl; c.f.y = 0; c.f.z = fz / fl;
  // right = f × up
  const rx = -c.f.z, rz = c.f.x;
  const mx = Math.max(-1, Math.min(1, inp.mx)), mz = Math.max(-1, Math.min(1, inp.mz));
  let wx = c.f.x * mz + rx * mx, wz = c.f.z * mz + rz * mx;
  const wl = Math.hypot(wx, wz);
  if (wl > 1) { wx /= wl; wz /= wl; }
  const spd = inp.sprint ? RUN : WALK;
  const k = Math.min(1, (c.ground ? 12 : 2) * dt);
  c.v.x += (wx * spd - c.v.x) * k;
  c.v.z += (wz * spd - c.v.z) * k;
  if (c.ground) {
    c.v.y = 0;
    if (inp.jump) { c.v.y = JUMP; c.ground = 0; }
  } else c.v.y -= GRAVITY * dt;
  c.p.x += c.v.x * dt; c.p.y += c.v.y * dt; c.p.z += c.v.z * dt;
  // fixtures and walls push the pilot back out
  for (const o of DECK_POSTS) push(c, o.x, o.z, o.r + R);
  for (const [x0, z0, x1, z1] of DECK_WALLS) {
    const ex = x1 - x0, ez = z1 - z0, l2 = ex * ex + ez * ez;
    const t = Math.max(0, Math.min(1, ((c.p.x - x0) * ex + (c.p.z - z0) * ez) / l2));
    push(c, x0 + ex * t, z0 + ez * t, R + 0.15);
  }
  const room = roomAt(c.p.x, c.p.z);
  if (room && c.p.y > room.ceil - 2) { c.p.y = room.ceil - 2; if (c.v.y > 0) c.v.y = 0; }
  if (c.p.y <= 0) { c.p.y = 0; c.v.y = 0; c.ground = 1; } else c.ground = 0;
}

function push(c: CharState, x: number, z: number, r: number) {
  const dx = c.p.x - x, dz = c.p.z - z, d = Math.hypot(dx, dz);
  if (d >= r || d < 1e-6) return;
  const nx = dx / d, nz = dz / d;
  c.p.x = x + nx * r; c.p.z = z + nz * r;
  const vn = c.v.x * nx + c.v.z * nz;
  if (vn < 0) { c.v.x -= nx * vn; c.v.z -= nz * vn; }
}
