import { describe, expect, it } from 'vitest';
import { PilotStore } from '../src/server/db.ts';
import { Game } from '../src/server/game/game.ts';
import type { Transport } from '../src/server/game/session.ts';
import {
  ANOMALY_SCAN_TIME, cargoCount, decodeJson, encodeJson, FWD, MSG, PROTOCOL_VERSION, qrot, TICK_RATE, v3, vdist, type GameEvent, type Poi,
} from '../src/shared/index.ts';

/** In-process pilot: a fake transport that records what the server sends. */
function pilot(game: Game, name: string) {
  const sent: Uint8Array[] = [];
  const t: Transport = { send: (d) => sent.push(d.slice()), close: () => {}, buffered: 0 };
  const c = game.connect(t);
  c.onMessage(encodeJson(MSG.HELLO, { v: PROTOCOL_VERSION, name }));
  const s = [...game.sessions.values()].find((x) => x.pilot.name === name)!;
  const events = () => sent.filter((d) => d[0] === MSG.EVENTS).flatMap((d) => decodeJson<{ ev: GameEvent[] }>(d).ev);
  const world = () => {
    const last = sent.filter((d) => d[0] === MSG.WORLD).pop();
    return last ? decodeJson<{ pois: Poi[] }>(last).pois : [];
  };
  return { s, sent, events, world };
}

const run = (game: Game, seconds: number) => { for (let i = 0; i < seconds * TICK_RATE; i++) game.step(); };

describe('world events', () => {
  const game = new Game({ store: new PilotStore(':memory:'), dev: true });
  const me = pilot(game, 'Scout');
  const sys = me.s.system;
  /** Moves the pilot's ship into open space far from the station (outside the safe zone). */
  const park = (dx: number) => {
    const st = sys.def.station.pos;
    me.s.ship.state.p = v3(st.x + dx, st.y + 6000, st.z + 9000);
    me.s.ship.state.frame = 0;
    me.s.ship.state.v = v3();
    sys.syncWorld(me.s.ship);
  };

  it('spawns events on its own and announces them', () => {
    run(game, 20);
    const kinds = sys.world.list().map((p) => p.kind);
    expect(kinds).toContain('wreck');
    expect(kinds).toContain('anomaly');
    expect(me.events().some((e) => e.t === 'announce')).toBe(true);
    expect(me.world().length).toBe(sys.world.pois.size);
  });

  it('wrecks can be salvaged once per pilot', () => {
    park(20000);
    const w = sys.world.spawn('wreck', { p: v3(me.s.ship.world.p.x + 80, me.s.ship.world.p.y, me.s.ship.world.p.z), dir: FWD })!;
    const charges = w.charges!;
    const credits = me.s.pilot.credits;
    expect(sys.handleAction(me.s, { a: 'salvage', id: w.id })).toBeNull();
    expect(me.s.pilot.cargo.relic).toBe(1);
    expect(me.s.pilot.credits).toBeGreaterThan(credits);
    expect(w.charges).toBe(charges - 1);
    expect(sys.handleAction(me.s, { a: 'salvage', id: w.id })).toMatch(/уже/);
    // too far away
    const other = sys.world.spawn('wreck', { p: v3(me.s.ship.world.p.x + 5000, me.s.ship.world.p.y, me.s.ship.world.p.z), dir: FWD })!;
    expect(sys.handleAction(me.s, { a: 'salvage', id: other.id })).toMatch(/ближе/);
  });

  it('anomalies reward a completed scan', () => {
    park(-20000);
    const a = sys.world.spawn('anomaly', { p: { ...me.s.ship.world.p }, dir: FWD })!;
    const crystals = me.s.pilot.cargo.crystal, credits = me.s.pilot.credits;
    run(game, ANOMALY_SCAN_TIME + 0.5);
    expect(me.events().some((e) => e.t === 'scan' && e.id === a.id && e.k > 0.5)).toBe(true);
    expect(me.s.pilot.credits).toBeGreaterThan(credits);
    expect(me.s.pilot.cargo.crystal).toBe(crystals + 2);
    // only once per pilot
    const after = me.s.pilot.credits;
    run(game, ANOMALY_SCAN_TIME + 0.5);
    expect(me.s.pilot.credits).toBe(after);
  });

  it('convoys travel, fight back and spill cargo when the freighter dies', () => {
    park(0);
    me.s.pilot.cargo = { ore: 0, crystal: 0, relic: 0 };
    const f0 = qrot(v3(), me.s.ship.world.q, FWD);
    const at = v3(me.s.ship.world.p.x + f0.x * 3000, me.s.ship.world.p.y + f0.y * 3000, me.s.ship.world.p.z + f0.z * 3000);
    const poi = sys.world.spawn('convoy', { p: at, dir: v3(1, 0, 0) })!;
    const freighter = sys.ships.get(poi.ship!)!;
    expect(freighter.bp.cls).toBe('freighter');
    const escorts = [...sys.ships.values()].filter((s) => s.npc?.guard === freighter.id);
    expect(escorts.length).toBe(3);
    const start = { ...freighter.world.p };
    run(game, 5);
    expect(vdist(freighter.world.p, start)).toBeGreaterThan(100);
    // clients get the convoy position about once a second
    const sent = me.world().find((p) => p.id === poi.id)!.pos;
    expect(vdist(v3(sent[0], sent[1], sent[2]), freighter.world.p)).toBeLessThan(freighter.flight.maxSpeed * 1.2);
    // attacking the freighter turns its escorts on the attacker
    sys.damage(freighter, 10, me.s.ship.id);
    expect(escorts.every((e) => e.npc!.target === me.s.ship.id)).toBe(true);
    const bounty = me.s.pilot.credits;
    sys.damage(freighter, 1e6, me.s.ship.id);
    expect(freighter.dead).toBe(true);
    expect(me.s.pilot.credits).toBeGreaterThanOrEqual(bounty + 400);
    const loot = [...sys.world.loot.values()];
    expect(loot.length).toBeGreaterThanOrEqual(7);
    // fly through the containers
    for (const l of loot) {
      me.s.ship.state.p = { ...l.p };
      sys.syncWorld(me.s.ship);
      game.step();
    }
    expect(sys.world.loot.size).toBeLessThan(loot.length);
    expect(cargoCount(me.s.pilot.cargo) + me.s.pilot.credits).toBeGreaterThan(bounty);
    expect(me.events().some((e) => e.t === 'loot')).toBe(true);
    expect(sys.world.pois.get(poi.id)!.ship).toBe(0);
  });
});
