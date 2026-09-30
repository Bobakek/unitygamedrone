import type { PlanetDef, PlanetType } from './galaxy/system-gen.ts';
import { vcross, vdot, vlen, vnorm, v3, type V3 } from './math/vec.ts';
import { footHeight, heightAt } from './planet/terrain.ts';

/** Body plans the client knows how to rig. */
export type BodyPlan = 'quad' | 'hex' | 'biped';

export interface Species {
  id: number;
  name: string;
  plan: BodyPlan;
  predator: boolean;
  hp: number;
  /** Overall scale (1 ≈ a 1.4 m tall animal). */
  size: number;
  walk: number;
  run: number;
  /** Body, belly/limbs, accent (eyes, crest, glow spots). */
  colors: [string, string, string];
  herd: [number, number];
  /** Suit damage per bite (predators). */
  bite: number;
  /** Bio samples a carcass yields. */
  samples: number;
  /** Extra shape flags for the rig. */
  tail?: boolean;
  horns?: boolean;
  glow?: boolean;
}

export const SPECIES: Species[] = [
  { id: 0, name: 'Травник', plan: 'quad', predator: false, hp: 40, size: 1.25, walk: 1.8, run: 10, colors: ['#9a6a42', '#e8d8b8', '#f4f0e8'], herd: [3, 5], bite: 0, samples: 1, horns: true },
  { id: 1, name: 'Клыкач', plan: 'biped', predator: true, hp: 70, size: 1.15, walk: 2.6, run: 8.4, colors: ['#4a7a3a', '#d8c870', '#ff4a2a'], herd: [1, 2], bite: 12, samples: 2, tail: true },
  { id: 2, name: 'Прыгун', plan: 'hex', predator: false, hp: 28, size: 0.8, walk: 2.2, run: 9.5, colors: ['#2aa8a0', '#f08ac8', '#8affe8'], herd: [4, 6], bite: 0, samples: 1, glow: true },
  { id: 3, name: 'Жнец', plan: 'hex', predator: true, hp: 110, size: 1.6, walk: 2.4, run: 8, colors: ['#3a2450', '#1a1420', '#ff3060'], herd: [1, 1], bite: 16, samples: 3, glow: true },
  { id: 4, name: 'Панцирник', plan: 'hex', predator: false, hp: 60, size: 1.1, walk: 1.4, run: 6.5, colors: ['#c89a58', '#6a4a2a', '#f0d8a0'], herd: [2, 4], bite: 0, samples: 1 },
  { id: 5, name: 'Скорпид', plan: 'hex', predator: true, hp: 80, size: 1.3, walk: 2.2, run: 8.2, colors: ['#a0482a', '#4a2418', '#ffd24a'], herd: [1, 2], bite: 14, samples: 2, tail: true },
  { id: 6, name: 'Мохнач', plan: 'quad', predator: false, hp: 60, size: 1.6, walk: 1.5, run: 7.5, colors: ['#e8e4dc', '#9a948a', '#5a5048'], herd: [2, 4], bite: 0, samples: 2, horns: true },
  { id: 7, name: 'Ледяной волк', plan: 'quad', predator: true, hp: 60, size: 1.05, walk: 2.8, run: 8.8, colors: ['#8a98a8', '#dfe8f0', '#6affff'], herd: [2, 3], bite: 11, samples: 2, tail: true },
];

/** [peaceful, predator] species per planet type; barren and lava worlds are lifeless. */
export const FAUNA: Partial<Record<PlanetType, [number, number]>> = {
  terran: [0, 1], ocean: [0, 1], alien: [2, 3], desert: [4, 5], ice: [6, 7],
};

export const PILOT_HP = 100;
export const BLASTER = { damage: 14, cooldown: 0.24, range: 140, speed: 320 } as const;
export const SAMPLE_RANGE = 4;

/** Creature on a planet surface, in the planet's body frame. */
export interface CreatureState { p: V3; v: V3; f: V3 }

const up = v3(), side = v3();

/**
 * Moves a creature over the planet: turns its heading toward `wish` (a
 * tangent direction, or null to stand), walks at `speed`, keeps to dry land
 * and snaps to the ground. Returns false if it refused to enter water.
 */
export function stepCreature(c: CreatureState, pl: PlanetDef, wish: V3 | null, speed: number, dt: number): boolean {
  vnorm(up, c.p);
  let ok = true;
  if (wish && speed > 0) {
    // steer the heading toward the wish direction
    const k = Math.min(1, dt * 4);
    c.f.x += (wish.x - c.f.x) * k; c.f.y += (wish.y - c.f.y) * k; c.f.z += (wish.z - c.f.z) * k;
  }
  const fu = vdot(c.f, up);
  c.f.x -= up.x * fu; c.f.y -= up.y * fu; c.f.z -= up.z * fu;
  if (vlen(c.f) < 1e-6) vcross(c.f, up, Math.abs(up.x) < 0.9 ? v3(1, 0, 0) : v3(0, 0, 1));
  vnorm(c.f, c.f);
  const tv = wish ? speed : 0;
  // accelerate along the heading, damp sideways drift
  const k = Math.min(1, dt * 5);
  c.v.x += (c.f.x * tv - c.v.x) * k; c.v.y += (c.f.y * tv - c.v.y) * k; c.v.z += (c.f.z * tv - c.v.z) * k;
  const nx = c.p.x + c.v.x * dt, ny = c.p.y + c.v.y * dt, nz = c.p.z + c.v.z * dt;
  const l = Math.hypot(nx, ny, nz);
  const dx = nx / l, dy = ny / l, dz = nz / l;
  if (pl.sea && heightAt(pl, dx, dy, dz) < 0.3) {
    // shoreline: stop and turn around
    c.v.x = c.v.y = c.v.z = 0;
    vcross(side, up, c.f);
    c.f.x = -c.f.x * 0.3 + side.x; c.f.y = -c.f.y * 0.3 + side.y; c.f.z = -c.f.z * 0.3 + side.z;
    vnorm(c.f, c.f);
    ok = false;
  } else {
    const g = pl.radius + footHeight(pl, dx, dy, dz);
    c.p.x = dx * g; c.p.y = dy * g; c.p.z = dz * g;
  }
  return ok;
}
