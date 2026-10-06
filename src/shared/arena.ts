import { hashInts, Rng } from './math/rng.ts';
import { v3, vdist, vnorm, vsub, type V3 } from './math/vec.ts';
import type { AsteroidField, Rock, SystemDef } from './galaxy/system-gen.ts';

/**
 * Arena 3×3: a match in its own instance, out in empty space of the system the first pilot
 * signed up in. Rounds are team deathmatches to `kills`; the first team to win `rounds` of them
 * takes the match. Empty seats are flown by bots.
 */
export const ARENA = {
  team: 3,
  /** Kills that win a round, rounds that win the match. */
  kills: 5,
  rounds: 2,
  /** Seconds: before a round (no damage), a round's length, between rounds, after the match. */
  warmup: 6,
  roundTime: 180,
  pause: 6,
  over: 10,
  respawn: 3,
  /** Seconds the queue waits for other pilots before bots take the seats. */
  wait: 8,
  /** The playing field (a sphere around the centre) and how far apart the teams start. */
  radius: 2600,
  gap: 2000,
  /** Weapons hit harder on the arena: short, sharp fights. */
  damage: 1.6,
  /** Hull damage per second outside the field. */
  outside: 18,
  /** Rewards (credits, experience). */
  winCredits: 600, loseCredits: 150, killCredits: 50,
  winXp: 60, loseXp: 20,
} as const;

export const TEAM_NAMES = ['Синие', 'Красные'] as const;
export const TEAM_COLORS = ['#4aa8ff', '#ff5a4a'] as const;

export type ArenaPhase = 'queue' | 'warmup' | 'fight' | 'pause' | 'over' | 'none';

export interface ArenaPlayer {
  /** Ship id in the arena. */
  ship: number;
  name: string;
  team: 0 | 1;
  bot: boolean;
  kills: number;
  deaths: number;
}

/** State of the pilot's arena match (MSG.ARENA), sent whenever something on the scoreboard changes. */
export interface ArenaMsg {
  phase: ArenaPhase;
  /** Server time the phase ends (`queue`: when bots take the empty seats; 0 = open-ended). */
  until: number;
  match?: number;
  /** System the arena lies in (its geometry comes from `arenaLayout`). */
  system?: number;
  round?: number;
  /** Kills in the current round and rounds won, per team. */
  score?: [number, number];
  rounds?: [number, number];
  players?: ArenaPlayer[];
  /** The receiving pilot's team. */
  team?: 0 | 1;
  /** Round or match winner (−1: draw), during `pause` and `over`. */
  winner?: number;
  /** Pilots waiting in the queue (`queue`). */
  waiting?: number;
  /** Sudden death: the round time ran out on an even score, the next kill decides. */
  overtime?: boolean;
}

export interface ArenaLayout {
  center: V3;
  /** Cover: an asteroid cluster around the centre, kept clear of the start zones. */
  field: AsteroidField;
  /** Start points of the two teams and where they face (the centre). */
  spawns: [V3, V3];
}

const layouts = new Map<string, ArenaLayout>();

/**
 * The arena of a system: a point in empty space well clear of the planets, the station, the
 * gates and the asteroid fields, with a cluster of rocks for cover. Deterministic: client and
 * server collide with the same rocks.
 */
export function arenaLayout(sys: SystemDef, match: number): ArenaLayout {
  const key = `${sys.id}:${match}`;
  const hit = layouts.get(key);
  if (hit) return hit;
  const rng = new Rng(hashInts(sys.seed, 0xa7e, match));
  const st = sys.station.pos;
  const home = sys.planets[sys.station.planet];
  const out = vnorm(v3(), vsub(v3(), st, home.center));
  const clear = (p: V3) => sys.planets.every((pl) => vdist(p, pl.center) > pl.radius * 3 + 6000)
    && vdist(p, sys.star.pos) > sys.star.radius * 5
    && vdist(p, st) > 9000
    && sys.gates.every((g) => vdist(g.pos, p) > 8000)
    && sys.fields.every((f) => vdist(f.center, p) > f.radius + 6000);
  let center = v3(st.x + out.x * 16000, st.y + 6000, st.z + out.z * 16000);
  for (let i = 0; i < 400 && !clear(center); i++) {
    const a = rng.range(0, Math.PI * 2), d = rng.range(12000, 30000);
    center = v3(st.x + Math.cos(a) * d, st.y + rng.range(3000, 9000), st.z + Math.sin(a) * d);
  }
  // teams start on either side along a horizontal axis
  const a = rng.range(0, Math.PI * 2), h = ARENA.gap / 2;
  const spawns: [V3, V3] = [
    v3(center.x + Math.cos(a) * h, center.y, center.z + Math.sin(a) * h),
    v3(center.x - Math.cos(a) * h, center.y, center.z - Math.sin(a) * h),
  ];
  const rocks: Rock[] = [];
  // a few big boulders in the middle, smaller ones scattered further out
  for (let tries = 0; rocks.length < 46 && tries < 2000; tries++) {
    const big = rocks.length < 9;
    const rr = big ? rng.range(0, 600) : Math.cbrt(rng.float()) * (ARENA.radius - 300);
    const u = rng.range(-1, 1), th = rng.range(0, Math.PI * 2), sq = Math.sqrt(1 - u * u);
    const p = v3(center.x + Math.cos(th) * sq * rr, center.y + u * rr * 0.55, center.z + Math.sin(th) * sq * rr);
    const r = big ? rng.range(45, 85) : rng.range(12, 34) * (rng.chance(0.2) ? 1.8 : 1);
    if (spawns.some((s) => vdist(s, p) < 420 + r)) continue;
    if (rocks.some((o) => vdist(o, p) < o.r + r + 40)) continue;
    rocks.push({ x: p.x, y: p.y, z: p.z, r, seed: rng.int(0, 1e9) });
  }
  const layout: ArenaLayout = { center, field: { index: sys.fields.length, center, radius: ARENA.radius, rocks }, spawns };
  layouts.set(key, layout);
  return layout;
}

/** Start slot `i` (0..team-1) of a team: a short line abreast, facing the other side. */
export function spawnSlot(l: ArenaLayout, team: 0 | 1, i: number): V3 {
  const s = l.spawns[team];
  const to = vnorm(v3(), vsub(v3(), l.center, s));
  const side = vnorm(v3(), v3(-to.z, 0, to.x));
  const k = (i - (ARENA.team - 1) / 2) * 48;
  return v3(s.x + side.x * k, s.y + (i % 2) * 18, s.z + side.z * k);
}
