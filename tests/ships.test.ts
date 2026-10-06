import { describe, expect, it } from 'vitest';
import { PilotStore } from '../src/server/db.ts';
import { Game } from '../src/server/game/game.ts';
import type { Transport } from '../src/server/game/session.ts';
import { HULLS, MINE_WORK, rockGood, rockUnits, ROCK_REGEN } from '../src/shared/ships/hulls.ts';
import {
  combatStats, defaultUpgrades, DT, emptyInput, encodeJson, flightStats, getSystem, MSG, newShip, PROTOCOL_VERSION, qlook, quat, stepShip,
  surfaceHeight, TICK_RATE, v3, vlen, vnorm, vsub, type SimEnv,
} from '../src/shared/index.ts';

function pilot(game: Game, name: string) {
  const t: Transport = { send: () => {}, close: () => {}, buffered: 0 };
  game.connect(t).onMessage(encodeJson(MSG.HELLO, { v: PROTOCOL_VERSION, name }));
  return [...game.sessions.values()].find((x) => x.pilot.name === name)!;
}

describe('ship classes', () => {
  it('the fighter keeps its old numbers, the hauler carries more and the miner can drill', () => {
    const u = defaultUpgrades();
    expect(combatStats(u, 'fighter')).toEqual({ maxHull: 100, maxShield: 80, shieldRegen: 9, laserDamage: 9, cargoCap: 12 });
    expect(flightStats(u, 'fighter')).toMatchObject({ maxSpeed: 220, boostSpeed: 380, accel: 110, turn: 1.6, radius: 5, land: 1.75 });
    const hauler = combatStats(u, 'hauler'), miner = combatStats(u, 'miner');
    expect(hauler.cargoCap).toBeGreaterThan(miner.cargoCap);
    expect(miner.cargoCap).toBeGreaterThan(12);
    expect(hauler.maxHull).toBeGreaterThan(100);
    expect(hauler.laserDamage).toBeLessThan(9);
    expect(flightStats(u, 'hauler').maxSpeed).toBeLessThan(flightStats(u, 'miner').maxSpeed);
    expect(flightStats(u, 'miner').maxSpeed).toBeLessThan(220);
    expect(HULLS.miner.mining).toBeGreaterThan(0);
    expect(HULLS.hauler.mining + HULLS.fighter.mining).toBe(0);
    // upgrades still pay off on any hull
    expect(combatStats({ ...u, cargo: 3 }, 'hauler').cargoCap).toBe(hauler.cargoCap + 2 * HULLS.hauler.cargoPerLevel);
  });

  it('a big hull lands on its own gear height', () => {
    const sys = getSystem(0);
    const env: SimEnv = { star: sys.star, planets: sys.planets, fields: sys.fields, station: sys.station, time: 0 };
    for (const k of ['hauler', 'miner'] as const) {
      const st = flightStats(defaultUpgrades(), k);
      const p = sys.planets[1];
      const dir = vnorm(v3(), v3(-0.4, 0.7, 0.6));
      const g = p.radius + surfaceHeight(p, dir.x, dir.y, dir.z) + 60;
      const s = newShip(v3(dir.x * g, dir.y * g, dir.z * g));
      s.frame = p.index + 1;
      qlook(s.q, v3(dir.y, -dir.x, 0), dir);
      for (let i = 0; i < 30 * 60 && !s.landed; i++) stepShip(s, emptyInput(), st, env, DT);
      expect(s.landed).toBe(p.index + 1);
      const d = vnorm(v3(), s.p);
      expect(vlen(s.p) - (p.radius + surfaceHeight(p, d.x, d.y, d.z))).toBeCloseTo(HULLS[k].land, 5);
    }
  });
});

describe('shipyard', () => {
  const game = new Game({ store: new PilotStore(':memory:'), dev: true });
  const s = pilot(game, 'Hauler Joe');
  const sys = s.system;

  it('sells ships only to docked pilots with the money', () => {
    expect(sys.handleAction(s, { a: 'buyShip', ship: 'hauler' })).toBe('Нужно пристыковаться');
    sys.devTeleport(s, 'dock');
    expect(sys.handleAction(s, { a: 'dock' })).toBeNull();
    s.pilot.credits = 100;
    expect(sys.handleAction(s, { a: 'buyShip', ship: 'hauler' })).toBe('Недостаточно кредитов');
    expect(sys.handleAction(s, { a: 'setShip', ship: 'hauler' })).toBe('Сначала купите этот корабль');
    expect(s.pilot.ship).toBe('fighter');
  });

  it('buying a ship takes it out at once with its stats and look', () => {
    s.pilot.credits = 10000;
    sys.infos.length = 0;
    expect(sys.handleAction(s, { a: 'buyShip', ship: 'hauler' })).toBeNull();
    expect(s.pilot.credits).toBe(10000 - HULLS.hauler.price);
    expect(s.pilot.ships).toEqual(['fighter', 'hauler']);
    expect(s.pilot.ship).toBe('hauler');
    expect(s.ship.bp.cls).toBe('hauler');
    expect(s.ship.flight.radius).toBe(HULLS.hauler.radius);
    expect(s.ship.combat.cargoCap).toBe(combatStats(s.pilot.upgrades, 'hauler').cargoCap);
    expect(sys.infos.some((i) => i.id === s.ship.id && i.bp?.cls === 'hauler')).toBe(true);
    expect(s.pilotInfo()).toMatchObject({ ship: 'hauler', ships: ['fighter', 'hauler'], cargoCap: s.ship.combat.cargoCap });
    expect(sys.handleAction(s, { a: 'buyShip', ship: 'hauler' })).toBe('Этот корабль уже ваш');
  });

  it('swaps freely, but not into a hold too small for the cargo', () => {
    s.pilot.cargo.ore = 40;
    expect(sys.handleAction(s, { a: 'setShip', ship: 'fighter' })).toMatch(/не поместится/);
    expect(s.pilot.ship).toBe('hauler');
    s.pilot.cargo.ore = 5;
    expect(sys.handleAction(s, { a: 'setShip', ship: 'fighter' })).toBeNull();
    expect(s.ship.bp.cls).toBe('fighter');
    expect(s.ship.flight.radius).toBe(5);
  });

  it('the hangar is saved with the pilot (and old saves get the fighter)', () => {
    const store = new PilotStore(':memory:');
    const p = store.create('Keeper');
    expect(p.ship).toBe('fighter');
    expect(p.ships).toEqual(['fighter']);
    store.save({ ...p, ship: 'miner', ships: ['fighter', 'miner'] });
    expect(store.find('Keeper')).toMatchObject({ ship: 'miner', ships: ['fighter', 'miner'] });
    store.save({ ...p, ship: 'hauler', ships: ['fighter'] });
    expect(store.find('Keeper')!.ship).toBe('fighter');
  });
});

describe('asteroid mining', () => {
  const game = new Game({ store: new PilotStore(':memory:'), dev: true });
  const s = pilot(game, 'Digger');
  s.ship.god = true;
  const sys = s.system;
  const field = sys.def.fields[0];
  // a lone rock at the edge of the field, approached from outside
  const ri = field.rocks.findIndex((r) => r.r < 20);
  const rock = field.rocks[ri];

  /** Parks the ship 60 m off the rock, nose on it, and fires for `seconds`. */
  const drill = (seconds: number) => {
    const out = vnorm(v3(), vsub(v3(), rock, field.center));
    const p = v3(rock.x + out.x * (rock.r + 60), rock.y + out.y * (rock.r + 60), rock.z + out.z * (rock.r + 60));
    s.ship.state = newShip(p, qlook(quat(), vnorm(v3(), vsub(v3(), rock, p)), v3(0, 1, 0)));
    for (let i = 0; i < seconds * TICK_RATE; i++) {
      s.ship.energy = 100;
      s.ship.fireCooldown = 0;
      sys.syncWorld(s.ship);
      sys.tryFire(s.ship);
      game.step();
    }
  };
  const good = rockGood(rock.seed);

  it('a fighter cannot mine', () => {
    drill(3);
    expect(s.pilot.cargo[good]).toBe(0);
  });

  it('a mining ship cuts ore into its hold until the rock is spent', () => {
    s.pilot.ships.push('miner');
    expect(sys.setShip(s, 'miner')).toBeNull();
    drill(4);
    const got = s.pilot.cargo[good];
    expect(got).toBeGreaterThan(0);
    // about one unit per MINE_WORK points of laser damage
    expect(got).toBeLessThanOrEqual(Math.ceil(4 * TICK_RATE * s.ship.combat.laserDamage / MINE_WORK));
    drill(60);
    expect(s.pilot.cargo[good]).toBe(rockUnits(rock.r));
    expect(sys.mining.left(field.index, ri)).toBe(0);
    // and it grows back
    for (let i = 0; i < (ROCK_REGEN + 1) * TICK_RATE; i++) game.step();
    expect(sys.mining.left(field.index, ri)).toBe(1);
  });
});
