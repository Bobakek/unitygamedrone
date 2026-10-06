import { describe, expect, it } from 'vitest';
import { PilotStore } from '../src/server/db.ts';
import { Game } from '../src/server/game/game.ts';
import { ArenaInstance } from '../src/server/game/arena.ts';
import type { Session, Transport } from '../src/server/game/session.ts';
import {
  ARENA, arenaLayout, decodeJson, encodeJson, getSystem, MODE, MSG, PROTOCOL_VERSION, spawnSlot, SYSTEM_COUNT, TICK_RATE, vdist, type ArenaMsg,
} from '../src/shared/index.ts';

function pilot(game: Game, name: string) {
  const got: Uint8Array[] = [];
  const t: Transport = { send: (d) => { got.push(d); }, close: () => {}, buffered: 0 };
  const conn = game.connect(t);
  conn.onMessage(encodeJson(MSG.HELLO, { v: PROTOCOL_VERSION, name }));
  const s = [...game.sessions.values()].find((x) => x.pilot.name === name)!;
  const act = (a: object) => conn.onMessage(encodeJson(MSG.ACTION, a));
  const chat = (text: string) => conn.onMessage(encodeJson(MSG.CHAT, { text }));
  const arena = () => got.filter((d) => d[0] === MSG.ARENA).map((d) => decodeJson<ArenaMsg>(d));
  const events = () => got.filter((d) => d[0] === MSG.EVENTS).flatMap((d) => decodeJson<{ ev: { t: string; text?: string }[] }>(d).ev);
  return { s, act, chat, arena, events, conn };
}

/** Puts the pilot at the station, docked. */
function dock(p: ReturnType<typeof pilot>) {
  p.chat('/tp dock');
  p.act({ a: 'dock' });
  expect(p.s.mode).toBe(MODE.DOCKED);
}

function run(game: Game, seconds: number, until?: () => boolean) {
  for (let i = 0; i < seconds * TICK_RATE; i++) {
    game.step();
    if (until?.()) return true;
  }
  return false;
}

describe('arena 3×3', () => {
  it('lays out the arena in empty space, the same every time, with the start zones clear', () => {
    for (let id = 0; id < SYSTEM_COUNT; id++) {
      const sys = getSystem(id);
      const a = arenaLayout(sys, 1), b = arenaLayout(sys, 1);
      expect(b).toBe(a);
      for (const pl of sys.planets) expect(vdist(a.center, pl.center)).toBeGreaterThan(pl.radius * 3 + ARENA.radius);
      expect(vdist(a.center, sys.station.pos)).toBeGreaterThan(ARENA.radius + 3000);
      expect(a.field.rocks.length).toBeGreaterThan(30);
      for (const team of [0, 1] as const) {
        for (let i = 0; i < ARENA.team; i++) {
          const p = spawnSlot(a, team, i);
          for (const r of a.field.rocks) expect(vdist(p, r)).toBeGreaterThan(r.r + 50);
        }
      }
    }
  });

  it('a lone pilot gets a match with bots, plays it out and comes back to the station with a reward', () => {
    const game = new Game({ store: new PilotStore(':memory:'), dev: true });
    const p = pilot(game, 'Арен');
    const home = p.s.system;
    // not from open space
    p.act({ a: 'arena' });
    expect(game.arena.queued(p.s)).toBe(false);
    dock(p);
    p.act({ a: 'arena' });
    expect(game.arena.queued(p.s)).toBe(true);
    expect(p.arena().at(-1)?.phase).toBe('queue');
    expect(run(game, ARENA.wait + 2, () => p.s.system instanceof ArenaInstance)).toBe(true);
    const a = p.s.system as ArenaInstance;
    expect(p.s.mode).toBe(MODE.SHIP);
    expect(p.s.pilot.system).toBe(home.def.id);
    expect(a.seats.size).toBe(ARENA.team * 2);
    const st = p.arena().at(-1)!;
    expect(st.phase).toBe('warmup');
    expect(st.players!.filter((x) => x.bot)).toHaveLength(5);
    expect(st.players!.filter((x) => x.team === st.team)).toHaveLength(3);
    // the ship stands at its team's start, nobody can be hurt before the round
    expect(vdist(p.s.ship.world.p, a.layout.spawns[st.team!])).toBeLessThan(200);
    const credits = p.s.pilot.credits;
    // the bots fight it out (the player just sits there and gets shot now and then)
    const done = run(game, 60 * 12, () => p.s.mode === MODE.DOCKED);
    expect(done).toBe(true);
    expect(p.s.system).toBe(home);
    expect(game.arena.arenas.size).toBe(0);
    const phases = new Set(p.arena().map((m) => m.phase));
    expect(phases).toContain('fight');
    expect(phases).toContain('over');
    const over = p.arena().filter((m) => m.phase === 'over').at(-1)!;
    expect(Math.max(...over.rounds!)).toBe(ARENA.rounds);
    expect(p.s.pilot.credits).toBeGreaterThanOrEqual(credits + ARENA.loseCredits);
    expect(p.arena().at(-1)?.phase).toBe('none');
  }, 60000);

  it('no friendly fire, the edge of the field burns, and a leaver is replaced by a bot', () => {
    const game = new Game({ store: new PilotStore(':memory:'), dev: true });
    const pa = pilot(game, 'Альфа'), pb = pilot(game, 'Браво');
    dock(pa); dock(pb);
    pa.act({ a: 'arena' }); pb.act({ a: 'arena' });
    run(game, ARENA.wait + 2, () => pa.s.system instanceof ArenaInstance);
    const a = pa.s.system as ArenaInstance;
    expect(pb.s.system).toBe(a);
    const sa = a.seatOf(pa.s)!, sb = a.seatOf(pb.s)!;
    expect(sa.team).not.toBe(sb.team);
    run(game, ARENA.warmup + 0.5);
    expect(a.phase).toBe('fight');
    const mate = [...a.seats.values()].find((x) => x.team === sa.team && x !== sa)!;
    const hull = mate.ship.hull, shield = mate.ship.shield;
    a.damage(mate.ship, 30, pa.s.ship.id);
    expect([mate.ship.hull, mate.ship.shield]).toEqual([hull, shield]);
    const foe = [...a.seats.values()].find((x) => x.team !== sa.team && !x.session)!;
    a.damage(foe.ship, 30, pa.s.ship.id);
    expect(foe.ship.shield).toBeLessThan(foe.ship.combat.maxShield);
    // fly the pilot out of the field: the hull burns
    pa.s.ship.god = false;
    pa.s.ship.state.p.x = a.layout.center.x + ARENA.radius + 400;
    a.syncWorld(pa.s.ship);
    const h0 = pa.s.ship.hull;
    run(game, 0.5);
    expect(pa.s.ship.hull).toBeLessThan(h0);
    // Браво leaves: a bot takes the seat, the match goes on
    pb.chat('/arena');
    expect(pb.s.mode).toBe(MODE.DOCKED);
    expect(a.seats.size).toBe(ARENA.team * 2);
    expect([...a.seats.values()].filter((x) => x.session)).toHaveLength(1);
    // the last pilot leaving closes the match
    pa.act({ a: 'arenaLeave' });
    expect(game.arena.arenas.size).toBe(0);
    expect(pa.s.mode).toBe(MODE.DOCKED);
  });

  it('keeps group mates on one team', () => {
    const game = new Game({ store: new PilotStore(':memory:'), dev: true });
    const ps = ['Один', 'Два', 'Три'].map((n) => pilot(game, n));
    ps[0].chat('/invite Два');
    ps[1].act({ a: 'groupAnswer', yes: true });
    ps.forEach((p) => dock(p));
    // the lone pilot signs up first
    for (const i of [2, 0, 1]) ps[i].act({ a: 'arena' });
    run(game, ARENA.wait + 2, () => ps[0].s.system instanceof ArenaInstance);
    const a = ps[0].s.system as ArenaInstance;
    const team = (s: Session) => a.seatOf(s)!.team;
    expect(team(ps[0].s)).toBe(team(ps[1].s));
    expect(team(ps[2].s)).not.toBe(team(ps[0].s));
  });
});
