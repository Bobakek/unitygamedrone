import { describe, expect, it } from 'vitest';
import { PilotStore } from '../src/server/db.ts';
import { Game } from '../src/server/game/game.ts';
import { ArenaInstance } from '../src/server/game/arena.ts';
import type { ShipEntity } from '../src/server/game/entities.ts';
import type { Transport } from '../src/server/game/session.ts';
import {
  decodeJson, DT, EMP, encodeJson, fitOf, FWD, MINE, MODE, MODULE_SLOTS, MODULES, MSG, newArms, PROTOCOL_VERSION, qrot, RAIL, railDamage, toggleFit, v3, validArms,
  type GameEvent,
} from '../src/shared/index.ts';

function pilot(game: Game, name: string) {
  const got: Uint8Array[] = [];
  const t: Transport = { send: (d) => { got.push(d); }, close: () => {}, buffered: 0 };
  const conn = game.connect(t);
  conn.onMessage(encodeJson(MSG.HELLO, { v: PROTOCOL_VERSION, name }));
  const s = [...game.sessions.values()].find((x) => x.pilot.name === name)!;
  const act = (a: object) => conn.onMessage(encodeJson(MSG.ACTION, a));
  const events = () => got.filter((d) => d[0] === MSG.EVENTS).flatMap((d) => decodeJson<{ ev: GameEvent[] }>(d).ev);
  return { s, act, events, chat: (text: string) => conn.onMessage(encodeJson(MSG.CHAT, { text })) };
}

/** A pirate parked `d` metres ahead of the ship (no brain: it stays where it is put). */
function pirateAhead(game: Game, ship: ShipEntity, d: number, side = 0): ShipEntity {
  const sys = [...game.sessions.values()].find((x) => x.ship === ship)!.system;
  sys.syncWorld(ship);
  const f = qrot(v3(), ship.world.q, FWD), w = ship.world.p;
  const p = sys.spawnPirate(v3(w.x + f.x * d + side, w.y + f.y * d, w.z + f.z * d));
  p.npc = null;
  sys.syncWorld(p);
  return p;
}

describe('weapon modules: owning and fitting', () => {
  it('fits only owned modules, no more than the ship has slots, and survives bad data', () => {
    const a = newArms();
    expect(toggleFit(a, 'fighter', 'railgun')).toMatch(/не куплен/);
    a.owned.push('railgun', 'emp', 'mines');
    expect(toggleFit(a, 'fighter', 'railgun')).toBeNull();
    expect(toggleFit(a, 'fighter', 'emp')).toBeNull();
    expect(toggleFit(a, 'fighter', 'mines')).toMatch(/слоты/);
    expect(fitOf(a, 'fighter')).toEqual(['railgun', 'emp']);
    // the mining ship has a single slot
    expect(MODULE_SLOTS.miner).toBe(1);
    expect(toggleFit(a, 'miner', 'mines')).toBeNull();
    expect(toggleFit(a, 'miner', 'emp')).toMatch(/слоты/);
    // removing frees the slot
    expect(toggleFit(a, 'fighter', 'railgun')).toBeNull();
    expect(fitOf(a, 'fighter')).toEqual(['emp']);
    expect(validArms({ owned: ['railgun', 'laser', 'railgun'], fits: { fighter: ['railgun', 'emp', 'x'], miner: ['railgun', 'railgun'] }, mines: 99 }))
      .toEqual({ owned: ['railgun'], fits: { fighter: ['railgun'], miner: ['railgun'] }, mines: MINE.cap });
    expect(validArms('junk')).toEqual(newArms());
  });

  it('modules are bought and fitted at the station, kept in the database', () => {
    const store = new PilotStore(':memory:');
    const game = new Game({ store, dev: true });
    const p = pilot(game, 'Оружейник');
    const sys = p.s.system;
    expect(sys.handleAction(p.s, { a: 'buyModule', key: 'railgun' })).toMatch(/пристыковаться/);
    p.chat('/tp dock');
    p.act({ a: 'dock' });
    expect(p.s.mode).toBe(MODE.DOCKED);
    expect(sys.handleAction(p.s, { a: 'buyModule', key: 'railgun' })).toMatch(/кредитов/);
    p.s.pilot.credits = 10000;
    expect(sys.handleAction(p.s, { a: 'buyModule', key: 'railgun' })).toBeNull();
    expect(sys.handleAction(p.s, { a: 'buyModule', key: 'mines' })).toBeNull();
    expect(p.s.pilot.credits).toBe(10000 - MODULES.railgun.price - MODULES.mines.price);
    // straight into the free slots, with a full magazine of mines
    expect(p.s.ship.mods).toEqual(['railgun', 'mines']);
    expect(p.s.pilot.arms.mines).toBe(MINE.cap);
    expect(sys.handleAction(p.s, { a: 'buyModule', key: 'emp' })).toBeNull();
    expect(p.s.ship.mods).toEqual(['railgun', 'mines']);
    // swap: take the mines off, the EMP goes in
    expect(sys.handleAction(p.s, { a: 'fitModule', key: 'mines' })).toBeNull();
    expect(sys.handleAction(p.s, { a: 'fitModule', key: 'emp' })).toBeNull();
    expect(p.s.ship.mods).toEqual(['railgun', 'emp']);
    expect(sys.shipInfo(p.s.ship).mods).toEqual(['railgun', 'emp']);
    expect(sys.handleAction(p.s, { a: 'buyMines' })).toMatch(/полна/);
    p.s.pilot.arms.mines = 2;
    const cr = p.s.pilot.credits;
    expect(sys.handleAction(p.s, { a: 'buyMines' })).toBeNull();
    expect(p.s.pilot.credits).toBe(cr - (MINE.cap - 2) * MINE.price);
    store.save(p.s.pilot);
    const back = store.find('Оружейник')!;
    expect(back.arms).toEqual(p.s.pilot.arms);
    expect(fitOf(back.arms, 'fighter')).toEqual(['railgun', 'emp']);
    // another ship class keeps its own fit
    p.s.pilot.ships.push('hauler');
    expect(sys.setShip(p.s, 'hauler')).toBeNull();
    expect(p.s.ship.mods).toEqual([]);
    expect(sys.setShip(p.s, 'fighter')).toBeNull();
    expect(p.s.ship.mods).toEqual(['railgun', 'emp']);
  });
});

describe('weapon modules in space', () => {
  const game = new Game({ store: new PilotStore(':memory:'), dev: true });
  const p = pilot(game, 'Канонир');
  const sys = p.s.system;
  const ship = p.s.ship;
  const tick = (secs: number) => { for (let i = 0; i < secs / DT; i++) game.step(); };
  const arm = (...mods: ('railgun' | 'mines' | 'emp')[]) => {
    p.s.pilot.arms = { owned: [...mods], fits: { fighter: [...mods] }, mines: MINE.cap };
    sys.refreshMods(p.s);
    ship.energy = 100;
    ship.modReady = [];
  };

  it('the railgun strikes along the nose: soft on shields, hard on bare hull, then recharges', () => {
    p.chat('/tp open');
    arm('railgun');
    const t = pirateAhead(game, ship, 1500, 15);
    const dmg = railDamage(p.s.pilot.upgrades.weapons);
    // off the nose by 15 m at 1.5 km: the slug misses unless the target is selected (aim assist)
    expect(sys.handleAction(p.s, { a: 'module', slot: 0 })).toBeNull();
    expect(t.shield).toBe(t.combat.maxShield);
    expect(ship.energy).toBeCloseTo(100 - MODULES.railgun.energy, 5);
    expect(p.events().some((e) => e.t === 'module' && e.slot === 0 && e.cd === MODULES.railgun.cooldown)).toBe(true);
    // recharging: nothing happens
    ship.energy = 100;
    sys.handleAction(p.s, { a: 'module', slot: 0, target: t.id });
    expect(t.shield).toBe(t.combat.maxShield);
    expect(ship.energy).toBe(100);
    ship.modReady = [];
    sys.handleAction(p.s, { a: 'module', slot: 0, target: t.id });
    expect(t.shield).toBeCloseTo(t.combat.maxShield - dmg * RAIL.shieldMul, 5);
    expect(t.hull).toBe(t.combat.maxHull);
    // shield down: the hull takes it × hullMul
    t.shield = 0;
    ship.modReady = [];
    sys.handleAction(p.s, { a: 'module', slot: 0, target: t.id });
    expect(t.hull).toBeCloseTo(t.combat.maxHull - dmg * RAIL.hullMul, 5);
    // beyond its range it reaches nothing
    const far = pirateAhead(game, ship, RAIL.range + 300);
    ship.modReady = [];
    sys.handleAction(p.s, { a: 'module', slot: 0, target: far.id });
    expect(far.shield).toBe(far.combat.maxShield);
    sys.despawn(t);
    sys.despawn(far);
  });

  it('a mine is dropped astern, arms, and goes off next to an enemy ship', () => {
    arm('mines');
    ship.state.v = v3();
    expect(sys.handleAction(p.s, { a: 'module', slot: 0 })).toBeNull();
    expect(p.s.pilot.arms.mines).toBe(MINE.cap - 1);
    expect(sys.arms.mines.size).toBe(1);
    const mine = [...sys.arms.mines.values()][0];
    sys.syncWorld(ship);
    const f = qrot(v3(), ship.world.q, FWD);
    const back = { x: mine.p.x - ship.world.p.x, y: mine.p.y - ship.world.p.y, z: mine.p.z - ship.world.p.z };
    expect(back.x * f.x + back.y * f.y + back.z * f.z).toBeLessThan(0);
    // the owner's own ship never sets it off
    tick(MINE.arm + 0.5);
    expect(sys.arms.mines.size).toBe(1);
    // a pirate drifting by: boom
    const t = sys.spawnPirate(v3(mine.p.x + 30, mine.p.y, mine.p.z));
    t.npc = null;
    sys.syncWorld(t);
    tick(0.2);
    expect(sys.arms.mines.size).toBe(0);
    expect(t.shield + t.hull).toBeLessThan(t.combat.maxShield + t.combat.maxHull - MINE.damage * 0.5);
    sys.despawn(t);
    // the magazine runs dry
    p.s.pilot.arms.mines = 0;
    ship.modReady = [];
    expect(sys.handleAction(p.s, { a: 'module', slot: 0 })).toMatch(/кончились/);
  });

  it('the EMP burns off enemy shields, jams their guns and spares group mates', () => {
    arm('emp');
    const mate = pilot(game, 'Ведомый');
    p.act({ a: 'groupInvite', name: 'Ведомый' });
    mate.act({ a: 'groupAnswer', yes: true });
    sys.syncWorld(ship);
    const w = ship.world.p;
    mate.s.ship.state.p = v3(w.x + 120, w.y, w.z);
    sys.syncWorld(mate.s.ship);
    const t = pirateAhead(game, ship, 250);
    const far = pirateAhead(game, ship, EMP.radius + 200);
    expect(sys.handleAction(p.s, { a: 'module', slot: 0 })).toBeNull();
    expect(t.shield).toBe(Math.max(0, t.combat.maxShield - EMP.shield));
    expect(t.jamUntil).toBeGreaterThan(sys.time);
    expect(far.shield).toBe(far.combat.maxShield);
    expect(mate.s.ship.shield).toBe(mate.s.ship.combat.maxShield);
    // jammed guns stay silent
    const lasers = sys.lasers.length;
    t.fireCooldown = 0;
    sys.tryFire(t);
    expect(sys.lasers.length).toBe(lasers);
    // and the shield does not start coming back right away
    tick(EMP.shieldLock - 0.5);
    expect(t.shield).toBe(Math.max(0, t.combat.maxShield - EMP.shield));
    tick(1.5);
    expect(t.shield).toBeGreaterThan(Math.max(0, t.combat.maxShield - EMP.shield));
  });

  it('modules are locked in the station zone and while cruising', () => {
    arm('railgun');
    p.chat('/tp station');
    expect(sys.handleAction(p.s, { a: 'module', slot: 0 })).toMatch(/зоне станции/);
    expect(sys.handleAction(p.s, { a: 'module', slot: 1 })).toMatch(/пуст/);
  });
});

describe('weapon modules on the arena', () => {
  it('bots carry a module each and use them in a fight', () => {
    const game = new Game({ store: new PilotStore(':memory:'), dev: true });
    const a = new ArenaInstance(game, 3, 77, game.arena);
    game.arena.arenas.set(a.match, a);
    for (const team of [0, 1] as const) for (let i = 0; i < 3; i++) a.seatBot(team, i);
    for (const seat of a.seats.values()) expect(seat.ship.mods).toHaveLength(1);
    const seen = new Set<string>();
    for (let i = 0; i < 30 * 150 && game.arena.arenas.has(a.match); i++) {
      game.step();
      // events are flushed each step: look at what the arena kept from this one
      for (const m of a.arms.mines.values()) if (m) seen.add('mine');
      for (const seat of a.seats.values()) if ((seat.ship.modReady ?? []).some((x) => x > game.time)) seen.add(seat.ship.mods![0]);
    }
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });
});
