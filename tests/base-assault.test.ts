import { describe, expect, it } from 'vitest';
import { PilotStore } from '../src/server/db.ts';
import { Game } from '../src/server/game/game.ts';
import type { Transport } from '../src/server/game/session.ts';
import { deckSight, deckWaypoint, roomAt } from '../src/shared/boarding.ts';
import {
  BUNKER, BUNKER_CHEST, BUNKER_CONSOLE, BUNKER_DECK, BUNKER_DOORS, BUNKER_HATCH, BUNKER_LAYOUT, DEPOT_EVERY, GARRISON, HOLD_TIME, PAD_R, waveSize,
  type BaseInfo,
} from '../src/shared/base-assault.ts';
import { emptyCharInput, newChar } from '../src/shared/sim/character.ts';
import { stepDeck } from '../src/shared/station/deck.ts';
import { planetSites, sitePlane, siteDir } from '../src/shared/planet/sites.ts';
import { footHeight } from '../src/shared/planet/terrain.ts';
import { cargoCount, decodeJson, DT, encodeJson, MODE, MSG, PROTOCOL_VERSION, v3, type GameEvent } from '../src/shared/index.ts';

function pilot(game: Game, name: string) {
  const sent: Uint8Array[] = [];
  const t: Transport = { send: (d) => sent.push(d.slice()), close: () => {}, buffered: 0 };
  game.connect(t).onMessage(encodeJson(MSG.HELLO, { v: PROTOCOL_VERSION, name }));
  const s = [...game.sessions.values()].find((x) => x.pilot.name === name)!;
  const events = () => sent.filter((d) => d[0] === MSG.EVENTS).flatMap((d) => decodeJson<{ ev: GameEvent[] }>(d).ev);
  return { s, events };
}

function walk(a: { x: number; z: number }, b: { x: number; z: number }, secs = 40) {
  const c = newChar(v3(a.x, 0, a.z), v3(0, 0, -1));
  for (let i = 0; i < secs / DT && Math.hypot(c.p.x - b.x, c.p.z - b.z) > 0.8; i++) {
    const w = deckWaypoint(c.p, b, BUNKER_LAYOUT);
    const dx = w.x - c.p.x, dz = w.z - c.p.z, l = Math.hypot(dx, dz) || 1;
    c.f.x = dx / l; c.f.z = dz / l;
    stepDeck(c, { ...emptyCharInput(), mz: 1 }, DT, BUNKER_DECK);
  }
  return c.p;
}

describe('bunker deck', () => {
  it('every room is reachable from the lift through its doorway', () => {
    for (const [room, d] of Object.entries(BUNKER_DOORS)) {
      const p = walk(BUNKER_HATCH, d.in);
      expect(Math.hypot(p.x - d.in.x, p.z - d.in.z), room).toBeLessThan(0.8);
      expect(roomAt(BUNKER_LAYOUT, p.x, p.z)?.key).toBe(room);
    }
    const chest = walk(BUNKER_HATCH, BUNKER_LAYOUT.chestSpot);
    expect(Math.hypot(chest.x - BUNKER_CHEST.x, chest.z - BUNKER_CHEST.z)).toBeLessThan(2.6);
    const console = walk(BUNKER_HATCH, BUNKER_LAYOUT.helmSpot);
    expect(Math.hypot(console.x - BUNKER_CONSOLE.x, console.z - BUNKER_CONSOLE.z)).toBeLessThan(2.6);
  });

  it('walls block the line of sight, doorways do not', () => {
    expect(deckSight(0, 10, 0, -12, BUNKER_LAYOUT.walls)).toBe(true);
    expect(deckSight(0, 6, -10, 6, BUNKER_LAYOUT.walls)).toBe(true);
    expect(deckSight(0, 0, -10, 6, BUNKER_LAYOUT.walls)).toBe(false);
    expect(deckSight(-9, 5, -9, -6, BUNKER_LAYOUT.walls)).toBe(false);
  });
});

describe('pirate base assault', () => {
  const game = new Game({ store: new PilotStore(':memory:'), dev: true });
  const me = pilot(game, 'Stormer');
  const s = me.s;
  const sys = s.system;
  const tick = (secs: number) => { for (let i = 0; i < secs / DT; i++) game.step(); };
  const pl = sys.def.planets.find((p) => planetSites(p).some((x) => x.kind === 'base'))!;
  const site = planetSites(pl).find((x) => x.kind === 'base')!;
  const info = (): BaseInfo => sys.outposts.infos().find((b) => b.planet === pl.index && b.site === site.id)!;
  const lastBases = () => me.events().filter((e): e is Extract<GameEvent, { t: 'bases' }> => e.t === 'bases').at(-1)!.list;
  /** On foot right at the blast door. */
  const atDoor = () => {
    if (s.mode === MODE.BOARD) sys.recallPilot(s);
    if (s.char) { sys.chars.delete(s.char.id); s.char = null; }
    const d = siteDir(pl, site, BUNKER.door.x - 1, BUNKER.door.z);
    const g = pl.radius + footHeight(pl, d.x, d.y, d.z) + 0.05;
    sys.putOnFoot(s, pl.index, v3(d.x * g, d.y * g, d.z * g), v3(1, 0, 0));
  };

  it('sends the bases on arrival', () => {
    const list = lastBases();
    expect(list.length).toBe(sys.outposts.infos().length);
    expect(info().state).toBe('pirate');
    expect(info().shield).toBe(true);
    expect(info().towers).toBe(3);
  });

  it('the shield dome and the towers keep the bunker shut', () => {
    atDoor();
    expect(s.mode).toBe(MODE.FOOT);
    expect(sys.handleAction(s, { a: 'enterBase' })).toMatch(/куполом/);
    const towers = sys.outposts.towersOf(site);
    const gen = towers.find((t) => t.bp.cls === 'generator')!;
    sys.damage(gen, 1e6, s.ship.id);
    expect(info().shield).toBe(false);
    expect(sys.handleAction(s, { a: 'enterBase' })).toMatch(/турели/);
    for (const t of towers) if (t !== gen) sys.damage(t, 1e6, s.ship.id);
    expect(info().state).toBe('open');
    // too far from the door
    const p = s.char!.state.p;
    s.char!.state.p = v3(p.x * 1.0005, p.y * 1.0005, p.z * 1.0005);
    const q = sitePlane(pl, site, s.char!.state.p);
    if (Math.hypot(q.x - BUNKER.door.x, q.z - BUNKER.door.z) > 4) expect(sys.handleAction(s, { a: 'enterBase' })).toMatch(/двери/);
  });

  it('down the lift: the garrison fights, the console takes the base', () => {
    atDoor();
    expect(sys.handleAction(s, { a: 'enterBase' })).toBeNull();
    expect(s.mode).toBe(MODE.BOARD);
    const h = sys.boarding.of(s)!;
    expect(h.base).toEqual({ planet: pl.index, site: site.id });
    expect(h.crew.length).toBe(GARRISON + 1);
    expect(me.events().some((e) => e.t === 'aboard' && e.base?.[0] === pl.index)).toBe(true);
    // the deck lives in its pocket; the pilot is seen there
    const w = sys.charWorld(s.char!);
    expect(Math.abs(w.y - (sys.def.station.pos.y - 90000))).toBeLessThan(2000);
    // walking in: the garrison sees the intruder and shoots
    sys.boarding.devGo(s, 'hall');
    const hp = s.char!.hp;
    tick(6);
    expect(h.alerted).toBe(true);
    if (s.mode === MODE.BOARD) expect(s.char!.hp).toBeLessThan(hp);
    else expect(s.mode).toBe(MODE.SHIP); // knocked out: the rescue drone took them to the ship
    if (s.mode !== MODE.BOARD) { atDoor(); expect(sys.handleAction(s, { a: 'enterBase' })).toBeNull(); }
    s.ship.god = true;
    // the console stays locked while anyone of the garrison stands
    sys.boarding.devGo(s, 'helm');
    expect(sys.handleAction(s, { a: 'claim' })).toMatch(/гарнизон/);
    sys.boarding.devClear(s);
    const credits = s.pilot.credits;
    expect(sys.handleAction(s, { a: 'claim' })).toBeNull();
    expect(info().state).toBe('held');
    expect(info().owners).toContain('Stormer');
    expect(info().until).toBeGreaterThan(sys.time + HOLD_TIME - 5);
    expect(s.pilot.credits).toBeGreaterThan(credits);
    expect(s.pilot.trophies.some((t) => t.id === `relic:${sys.def.id}:${pl.index}:${site.id}`)).toBe(true);
    // the strongbox
    sys.boarding.devGo(s, 'chest');
    const cargo = cargoCount(s.pilot.cargo);
    expect(sys.handleAction(s, { a: 'loot' })).toBeNull();
    expect(cargoCount(s.pilot.cargo)).toBeGreaterThan(cargo);
  });

  it('a held base turns its towers on the pirates and fills its depot', () => {
    tick(31);
    const towers = sys.outposts.towersOf(site);
    expect(towers.length).toBe(4);
    for (const t of towers) {
      expect(t.base).toBeDefined();
      expect(t.bp.accent).toBe('#3ad0ff');
    }
    expect(info().shield).toBe(false);
    // a pirate flying over the base gets shot at
    const tw = towers.find((t) => t.bp.cls === 'turret')!;
    const up = v3(tw.world.p.x - pl.center.x, tw.world.p.y - pl.center.y, tw.world.p.z - pl.center.z);
    const l = Math.hypot(up.x, up.y, up.z);
    const pirate = sys.spawnPirate(v3(tw.world.p.x + (up.x / l) * 400, tw.world.p.y + (up.y / l) * 400, tw.world.p.z + (up.z / l) * 400));
    pirate.transient = true;
    pirate.npc!.state = 'patrol';
    const hp0 = pirate.hull + pirate.shield;
    let hit = false;
    for (let i = 0; i < 8 / DT && !hit; i++) { pirate.state.v = v3(); game.step(); hit = pirate.dead || pirate.disabled || pirate.hull + pirate.shield < hp0; }
    expect(hit).toBe(true);
    if (!pirate.dead) sys.kill(pirate, 0);
    // the depot fills up over time
    const h = sys.boarding.of(s)!;
    expect(h.looted).toBe(true);
    tick(DEPOT_EVERY + 1);
    expect(h.looted).toBe(false);
    expect(info().depot).toBeGreaterThan(0);
  });

  it('up the lift: back on foot at the blast door', () => {
    expect(sys.handleAction(s, { a: 'board' })).toMatch(/лифт/);
    sys.boarding.devGo(s, 'hatch');
    expect(sys.handleAction(s, { a: 'board' })).toBeNull();
    expect(s.mode).toBe(MODE.FOOT);
    const q = sitePlane(pl, site, s.char!.state.p);
    expect(Math.hypot(q.x - BUNKER.door.x, q.z - BUNKER.door.z)).toBeLessThan(4);
    // the captors may go back in
    expect(sys.handleAction(s, { a: 'enterBase' })).toBeNull();
    expect(s.mode).toBe(MODE.BOARD);
    sys.boarding.devGo(s, 'hatch');
    expect(sys.handleAction(s, { a: 'board' })).toBeNull();
  });

  it('a stranger is kept out of a held base', () => {
    const other = pilot(game, 'Stranger').s;
    if (other.system !== sys) game.transfer(other, sys.def.id);
    const d = siteDir(pl, site, BUNKER.door.x - 1, BUNKER.door.z);
    const g = pl.radius + footHeight(pl, d.x, d.y, d.z) + 0.05;
    sys.putOnFoot(other, pl.index, v3(d.x * g, d.y * g, d.z * g), v3(1, 0, 0));
    expect(sys.handleAction(other, { a: 'enterBase' })).toMatch(/другой пилот/);
    sys.recallPilot(other);
  });

  it('the pad repairs and refuels the captors\' ships', () => {
    sys.recallPilot(s);
    const st = s.ship.state;
    const d = siteDir(pl, site, 2, 3);
    const g = pl.radius + footHeight(pl, d.x, d.y, d.z) + 3;
    st.frame = st.landed = pl.index + 1;
    st.p = v3(d.x * g, d.y * g, d.z * g);
    st.v = v3();
    sys.syncWorld(s.ship);
    expect(Math.hypot(sitePlane(pl, site, st.p).x, sitePlane(pl, site, st.p).z)).toBeLessThan(PAD_R);
    s.ship.hull = s.ship.combat.maxHull * 0.3;
    s.pilot.fuel = 0;
    tick(10);
    expect(s.ship.hull).toBeGreaterThan(s.ship.combat.maxHull * 0.9);
    expect(s.pilot.fuel).toBeGreaterThan(0);
    st.landed = 0;
  });

  it('raiders come to take it back; with every tower down the base is lost', () => {
    expect(sys.outposts.devRaid(s)).toMatch(/Налёт/);
    expect(info().raid).toBe(waveSize(0));
    game.step();
    expect(me.events().some((e) => e.t === 'announce' && /отбивать/.test(e.text))).toBe(true);
    for (const t of sys.outposts.towersOf(site)) if (t.bp.cls === 'turret') sys.damage(t, 1e6, 0);
    expect(info().state).toBe('pirate');
    expect(info().shield).toBe(true);
    expect(info().towers).toBe(3);
    expect(sys.boarding.bunker(pl.index, site.id)).toBeNull();
    expect(sys.outposts.towersOf(site).every((t) => t.bp.accent !== '#3ad0ff')).toBe(true);
  });

  it('the hold runs out and the Syndicate gets it back', () => {
    s.ship.god = false;
    atDoor();
    const r = sys.outposts.devCapture(s);
    expect(r).toMatch(/ваша|теперь/i);
    expect(info().state).toBe('held');
    sys.outposts.devExpire(s);
    game.step();
    game.step();
    expect(info().state).toBe('pirate');
    expect(me.events().some((e) => e.t === 'announce' && /вернули/.test(e.text))).toBe(true);
  });
});
