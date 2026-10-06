/**
 * Arena balance lab: whole bot-only matches of the arena 3×3, team against team with fixed
 * weapon module loadouts, to see what a module is worth against plain lasers.
 *
 *     npx tsx tools/balance/arena-lab.ts [matches per pairing, default 12]
 *
 * Prints rounds won by each side, kills by weapon and the average time to kill.
 */
import { PilotStore } from '../../src/server/db.ts';
import { Game } from '../../src/server/game/game.ts';
import { ArenaInstance } from '../../src/server/game/arena.ts';
import * as M from '../../src/shared/modules.ts';
import type { ModuleKey } from '../../src/shared/modules.ts';

// TUNE='{"EMP":{"jam":0}}' tries other numbers without editing modules.ts
for (const [k, v] of Object.entries(JSON.parse(process.env.TUNE ?? '{}'))) Object.assign((M as unknown as Record<string, object>)[k], v);
const ONLY = process.env.ONLY;

const N = Number(process.argv[2] ?? 12);
const PAIRS: [string, ModuleKey[], ModuleKey[]][] = [
  ['лазеры vs лазеры', [], []],
  ['рельсотрон vs лазеры', ['railgun'], []],
  ['мины vs лазеры', ['mines'], []],
  ['ЭМИ vs лазеры', ['emp'], []],
  ['рельс+ЭМИ vs лазеры', ['railgun', 'emp'], []],
  ['рельс+мины vs лазеры', ['railgun', 'mines'], []],
  ['мины+ЭМИ vs лазеры', ['mines', 'emp'], []],
  ['рельс+ЭМИ vs рельс+мины', ['railgun', 'emp'], ['railgun', 'mines']],
  ['рельс+ЭМИ vs мины+ЭМИ', ['railgun', 'emp'], ['mines', 'emp']],
];

let match = 1000;
for (const [label, a, b] of PAIRS) {
  if (ONLY && !label.includes(ONLY)) continue;
  const rounds = [0, 0], kills = [0, 0];
  const by: Record<string, number> = { laser: 0, rail: 0, mine: 0, emp: 0 };
  let ticks = 0, roundsPlayed = 0;
  for (let m = 0; m < N; m++) {
    const game = new Game({ store: new PilotStore(':memory:'), dev: true });
    // alternate sides so the start positions even out
    const flip = m % 2 === 1;
    const arena = new ArenaInstance(game, m % 24, ++match, game.arena);
    game.arena.arenas.set(arena.match, arena);
    for (const team of [0, 1] as const) for (let i = 0; i < 3; i++) arena.seatBot(team, i);
    for (const seat of arena.seats.values()) {
      seat.ship.mods = [...((seat.team === 0) !== flip ? a : b)];
      seat.ship.mineAmmo = 6;
    }
    // which weapon dealt each blow, to put a kill down to it
    let source = '';
    const arms = arena.arms as unknown as Record<string, (...x: unknown[]) => unknown>;
    for (const [fn, tag] of [['detonate', 'mine'], ['emp', 'emp']] as const) {
      const orig = arms[fn].bind(arena.arms);
      arms[fn] = (...x: unknown[]) => { source = tag; try { return orig(...x); } finally { source = ''; } };
    }
    const damage = arena.damage.bind(arena);
    arena.damage = (t, d, at, p, mul) => {
      const before = t.dead;
      damage(t, d, at, p, mul);
      if (!before && t.dead && at) by[mul ? 'rail' : source || 'laser']++;
    };
    for (let i = 0; i < 60 * 30 * 12 && game.arena.arenas.has(arena.match); i++) {
      game.step();
      if (arena.phase === 'fight') ticks++;
    }
    for (const seat of arena.seats.values()) kills[(seat.team === 0) !== flip ? 1 : 0] += seat.deaths;
    rounds[0] += flip ? arena.rounds[1] : arena.rounds[0];
    rounds[1] += flip ? arena.rounds[0] : arena.rounds[1];
    roundsPlayed += arena.rounds[0] + arena.rounds[1];
    game.stop?.();
  }
  const total = by.laser + by.rail + by.mine + by.emp;
  const pct = (x: number) => `${Math.round((100 * x) / Math.max(1, total))}%`;
  console.log(`${label.padEnd(26)} раунды ${rounds[0]}:${rounds[1]} (${Math.round((100 * rounds[0]) / Math.max(1, rounds[0] + rounds[1]))}%)  сбито ${kills[0]}:${kills[1]}  ` +
    `добило: лазер ${pct(by.laser)}, рельс ${pct(by.rail)}, мина ${pct(by.mine)}, ЭМИ ${pct(by.emp)}  раунд ≈ ${Math.round(ticks / 30 / Math.max(1, roundsPlayed))} с`);
}
