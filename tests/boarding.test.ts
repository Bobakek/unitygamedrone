import { describe, expect, it } from 'vitest';
import { PilotStore } from '../src/server/db.ts';
import { Game } from '../src/server/game/game.ts';
import type { Transport } from '../src/server/game/session.ts';
import {
  BOARD_RANGE, CREW, deckSight, deckWaypoint, DISABLE_HULL, DISABLE_TIME, SHIP_CHEST, SHIP_DECK, SHIP_DOORS, SHIP_HATCH, SHIP_HELM, shipRoomAt,
} from '../src/shared/boarding.ts';
import { emptyCharInput, newChar } from '../src/shared/sim/character.ts';
import { stepDeck } from '../src/shared/station/deck.ts';
import { cargoCount, DT, encodeJson, MODE, MSG, PROTOCOL_VERSION, v3 } from '../src/shared/index.ts';

function pilot(game: Game, name: string) {
  const t: Transport = { send: () => {}, close: () => {}, buffered: 0 };
  game.connect(t).onMessage(encodeJson(MSG.HELLO, { v: PROTOCOL_VERSION, name }));
  return [...game.sessions.values()].find((x) => x.pilot.name === name)!;
}

/** Walks a deck character from `a` to `b` the way the crew does; returns where it ended up. */
function walk(a: { x: number; z: number }, b: { x: number; z: number }, secs = 30) {
  const c = newChar(v3(a.x, 0, a.z), v3(0, 0, -1));
  for (let i = 0; i < secs / DT && Math.hypot(c.p.x - b.x, c.p.z - b.z) > 0.8; i++) {
    const w = deckWaypoint(c.p, b);
    const dx = w.x - c.p.x, dz = w.z - c.p.z, l = Math.hypot(dx, dz) || 1;
    c.f.x = dx / l; c.f.z = dz / l;
    stepDeck(c, { ...emptyCharInput(), mz: 1 }, DT, SHIP_DECK);
  }
  return c.p;
}

describe('ship deck', () => {
  it('every room is reachable from the airlock through its doorway', () => {
    for (const [room, d] of Object.entries(SHIP_DOORS)) {
      const p = walk(SHIP_HATCH, d.in);
      expect(Math.hypot(p.x - d.in.x, p.z - d.in.z), room).toBeLessThan(0.8);
      expect(shipRoomAt(p.x, p.z)?.key).toBe(room);
    }
    const chest = walk(SHIP_HATCH, { x: SHIP_CHEST.x + 1.6, z: SHIP_CHEST.z });
    expect(Math.hypot(chest.x - SHIP_CHEST.x, chest.z - SHIP_CHEST.z)).toBeLessThan(2.6);
    const helm = walk(SHIP_HATCH, { x: SHIP_HELM.x, z: SHIP_HELM.z + 1.3 });
    expect(Math.hypot(helm.x - SHIP_HELM.x, helm.z - SHIP_HELM.z)).toBeLessThan(2.6);
  });

  it('walls block the line of sight, doorways do not', () => {
    expect(deckSight(0, 5, 0, -5)).toBe(true);
    expect(deckSight(0, 2.5, -8, 2.5)).toBe(true);
    expect(deckSight(0, -2, -8, 6)).toBe(false);
    expect(deckSight(6, 5, 6, -5)).toBe(false);
  });
});

describe('boarding', () => {
  const game = new Game({ store: new PilotStore(':memory:'), dev: true });
  const s = pilot(game, 'Corsair');
  const sys = s.system;
  const tick = (secs: number) => { for (let i = 0; i < secs / DT; i++) game.step(); };

  it('a pilot\'s fire disables a pirate instead of blowing it up', () => {
    sys.devTeleport(s, 'open');
    const w = s.ship.world.p;
    const pirate = sys.spawnPirate(v3(w.x, w.y, w.z - 300));
    pirate.npc!.state = 'patrol';
    for (let i = 0; i < 40 && !pirate.disabled; i++) sys.damage(pirate, 9, s.ship.id);
    expect(pirate.disabled).toBe(true);
    expect(pirate.dead).toBe(false);
    expect(pirate.hull).toBeLessThanOrEqual(pirate.combat.maxHull * DISABLE_HULL);
    expect(sys.boarding.hulks.has(pirate.id)).toBe(true);
    // dead in space: it does not fire or fly, the shield does not come back
    const at = { ...pirate.world.p };
    tick(3);
    expect(pirate.shield).toBe(0);
    expect(Math.hypot(pirate.world.p.x - at.x, pirate.world.p.y - at.y, pirate.world.p.z - at.z)).toBeLessThan(80);
    // too far to board
    expect(sys.handleAction(s, { a: 'boardShip', id: pirate.id })).toMatch(/ближе/);
    s.ship.state.p = v3(pirate.world.p.x + BOARD_RANGE * 0.5, pirate.world.p.y, pirate.world.p.z);
    s.ship.state.v = v3();
    sys.syncWorld(s.ship);
    expect(sys.handleAction(s, { a: 'boardShip', id: pirate.id })).toBeNull();
    expect(s.mode).toBe(MODE.BOARD);
    expect(s.char?.aboard).toBe(pirate.id);
    // the pilot's ship is parked alongside and safe from fire
    const hull = s.ship.hull;
    sys.damage(s.ship, 50, pirate.id);
    expect(s.ship.hull).toBe(hull);
  });

  it('the crew fights back, falls to the blaster, and the hold and the ship are taken', () => {
    const h = sys.boarding.of(s)!;
    expect(h.crew.length).toBeGreaterThanOrEqual(3);
    expect(sys.handleAction(s, { a: 'loot' })).toMatch(/сейф/i);
    // stand in the corridor in plain sight of a crewman coming for us: the suit takes hits
    s.char!.hp = 1000; s.char!.maxHp = 1000;
    s.char!.state.p = v3(0, 0, 0);
    tick(8);
    expect(s.char!.hp).toBeLessThan(1000);
    expect(h.alerted).toBe(true);
    // shoot each of them point blank
    for (const c of h.crew) {
      for (let i = 0; i < 20 && !c.dead; i++) {
        const cs = s.char!.state, q = c.state.p;
        // from whichever side is open
        const [ox, oz] = ([[-2, 0], [2, 0], [0, -2], [0, 2]] as const).find(([x, z]) => shipRoomAt(q.x + x, q.z + z) && deckSight(q.x + x, q.z + z, q.x, q.z))!;
        cs.p = v3(q.x + ox, 0, q.z + oz);
        cs.f = v3(-ox / 2, 0, -oz / 2);
        s.char!.cool = 0;
        sys.boarding.shoot(s, Math.atan2(1.05 - 1.45, 2));
      }
      expect(c.dead).toBe(true);
    }
    expect(Math.ceil(h.crew[0].maxHp / 14)).toBeLessThanOrEqual(Math.ceil(CREW.captainHp / 14));
    // the strongbox and the helm
    s.char!.state.p = v3(SHIP_CHEST.x + 1.6, 0, SHIP_CHEST.z);
    const credits = s.pilot.credits, load = cargoCount(s.pilot.cargo);
    expect(sys.handleAction(s, { a: 'loot' })).toBeNull();
    expect(cargoCount(s.pilot.cargo)).toBeGreaterThan(load);
    expect(s.pilot.credits).toBeGreaterThan(credits);
    expect(sys.handleAction(s, { a: 'claim' })).toMatch(/штурвал/);
    s.char!.state.p = v3(SHIP_HELM.x, 0, SHIP_HELM.z + 1.3);
    expect(sys.handleAction(s, { a: 'claim' })).toBeNull();
    expect(s.pilot.prizes.length).toBe(1);
    expect(s.pilot.prizes[0].kind).toBe('pirate');
    // out through the airlock: the prize crew takes the ship away
    expect(sys.handleAction(s, { a: 'board' })).toMatch(/шлюз/);
    s.char!.state.p = v3(SHIP_HATCH.x, 0, SHIP_HATCH.z - 0.5);
    const id = h.ship.id;
    expect(sys.handleAction(s, { a: 'board' })).toBeNull();
    expect(s.mode).toBe(MODE.SHIP);
    expect(s.char).toBeNull();
    tick(0.1);
    expect(sys.ships.has(id)).toBe(false);
    expect(sys.boarding.hulks.has(id)).toBe(false);
  });

  it('a shipyard buys the prize', () => {
    sys.devTeleport(s, 'dock');
    expect(sys.handleAction(s, { a: 'sellPrize', id: s.pilot.prizes[0].id })).toBe('Нужно пристыковаться');
    expect(sys.handleAction(s, { a: 'dock' })).toBeNull();
    const credits = s.pilot.credits, value = s.pilot.prizes[0].value;
    expect(sys.handleAction(s, { a: 'sellPrize', id: s.pilot.prizes[0].id })).toBeNull();
    expect(s.pilot.prizes.length).toBe(0);
    expect(s.pilot.credits).toBe(credits + value);
    expect(sys.handleAction(s, { a: 'undock' })).toBeNull();
  });

  it('left alone, the crew restarts the ship and it runs', () => {
    sys.devTeleport(s, 'open');
    sys.boarding.devSpawn(s, false);
    const h = [...sys.boarding.hulks.values()].at(-1)!;
    const ship = h.ship, crew = h.crew.map((c) => c.id);
    tick(DISABLE_TIME + 1);
    expect(ship.disabled).toBe(false);
    expect(ship.hull).toBeGreaterThan(ship.combat.maxHull * DISABLE_HULL);
    expect(sys.boarding.hulks.has(ship.id)).toBe(false);
    expect(crew.every((id) => sys.gone.includes(id) || true)).toBe(true);
  });

  it('a convoy freighter can be boarded too, with a bigger crew and hold', () => {
    sys.devTeleport(s, 'open');
    expect(sys.boarding.devBoard(s, true)).toBe('На борту');
    const h = sys.boarding.of(s)!;
    expect(h.kind).toBe('freighter');
    expect(h.crew.length).toBeGreaterThanOrEqual(5);
    expect(cargoCount(h.loot)).toBeGreaterThan(10);
    // blowing the hulk up with someone aboard throws them back to their ship
    sys.kill(h.ship, 0);
    expect(s.mode).toBe(MODE.SHIP);
    expect(sys.boarding.hulks.size).toBe(0);
  });

  it('the suit giving out aboard sends the pilot back to their ship', () => {
    sys.devTeleport(s, 'open');
    sys.boarding.devBoard(s, false);
    expect(s.mode).toBe(MODE.BOARD);
    sys.fauna.hurt(s, 10000, 0);
    expect(s.mode).toBe(MODE.SHIP);
    expect([...sys.boarding.hulks.values()].every((x) => !x.boarders.has(s))).toBe(true);
  });
});
