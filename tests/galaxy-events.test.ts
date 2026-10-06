import { describe, expect, it } from 'vitest';
import { PilotStore } from '../src/server/db.ts';
import { Game } from '../src/server/game/game.ts';
import type { Transport } from '../src/server/game/session.ts';
import {
  CARGO_KEYS, encodeJson, decodeJson, EVENT_SLOT_MS, eventOffers, eventPriceMods, galaxyEventsAt, generateBoard, getGalaxy, jumpsFrom,
  marketQuote, MODE, MSG, PROTOCOL_VERSION, SYSTEM_COUNT, TICK_RATE, upcomingEvents, type GameEvent, type GalaxyEvent,
} from '../src/shared/index.ts';

const DAY = 24 * 3600 * 1000;
const T0 = 20_000 * DAY;

describe('galaxy event schedule', () => {
  it('is deterministic, keeps one event per system and a few at a time', () => {
    expect(galaxyEventsAt(T0 + 12345)).toEqual(galaxyEventsAt(T0 + 12345));
    let total = 0, empty = 0;
    const kinds = new Set<string>(), systems = new Set<number>();
    for (let t = T0; t < T0 + DAY; t += 60_000) {
      const list = galaxyEventsAt(t);
      total += list.length;
      if (!list.length) empty++;
      const sys = list.map((e) => e.system);
      expect(new Set(sys).size).toBe(sys.length);
      for (const e of list) {
        expect(t).toBeGreaterThanOrEqual(e.start);
        expect(t).toBeLessThan(e.end);
        expect(e.system).toBeGreaterThanOrEqual(0);
        expect(e.system).toBeLessThan(SYSTEM_COUNT);
        kinds.add(e.kind);
        systems.add(e.system);
        if (e.kind === 'shortage') expect(CARGO_KEYS).toContain(e.good);
      }
    }
    const avg = total / (DAY / 60_000);
    expect(avg).toBeGreaterThan(1);
    expect(avg).toBeLessThan(5);
    expect(empty / (DAY / 60_000)).toBeLessThan(0.25);
    expect([...kinds].sort()).toEqual(['raid', 'shortage', 'storm']);
    expect(systems.size).toBeGreaterThan(SYSTEM_COUNT / 2);
  });

  it('an event stays the same for its whole life', () => {
    const e = upcomingEvents(T0, 1)[0];
    const mid = galaxyEventsAt((e.start + e.end) / 2).find((x) => x.id === e.id);
    expect(mid).toEqual(e);
    expect(galaxyEventsAt(e.start - 1).some((x) => x.id === e.id)).toBe(false);
    expect(galaxyEventsAt(e.end).some((x) => x.id === e.id)).toBe(false);
    expect(e.end - e.start).toBeGreaterThanOrEqual(12 * 60_000);
    expect(e.start).toBeGreaterThanOrEqual(e.id * EVENT_SLOT_MS);
  });

  it('raids hit the border and the frontier much more than the core', () => {
    let core = 0, other = 0;
    for (const e of upcomingEvents(T0, 600)) {
      if (e.kind !== 'raid') continue;
      if (getGalaxy().stars[e.system].security === 'core') core++; else other++;
    }
    expect(other).toBeGreaterThan(core * 2);
  });
});

describe('what events change', () => {
  const near = getGalaxy().links[3][0];
  const shortage: GalaxyEvent = { id: 1, kind: 'shortage', system: 3, good: 'crystal', start: 0, end: 1 };
  const storm: GalaxyEvent = { id: 2, kind: 'storm', system: 5, start: 0, end: 1 };
  const raid: GalaxyEvent = { id: 3, kind: 'raid', system: 7, start: 0, end: 1 };

  it('prices: the shortage good doubles, the neighbours pay a bit more, storms raise ore', () => {
    expect(eventPriceMods(3, [shortage]).crystal).toBe(2);
    expect(eventPriceMods(3, [shortage]).ore).toBe(1);
    expect(eventPriceMods(near, [shortage]).crystal).toBeGreaterThan(1);
    expect(eventPriceMods(5, [storm]).ore).toBeGreaterThan(1.4);
    for (const k of CARGO_KEYS) expect(eventPriceMods(7, [raid])[k]).toBeGreaterThan(1);
    const plain = marketQuote(3, 9).goods.crystal.sell;
    const hit = marketQuote(3, 9, {}, eventPriceMods(3, [shortage])).goods.crystal.sell;
    expect(hit).toBeGreaterThan(plain * 1.8);
  });

  it('boards: urgent offers where the event is and around it', () => {
    const here = eventOffers(3, [shortage]);
    expect(here).toHaveLength(1);
    expect(here[0]).toMatchObject({ kind: 'supply', cargo: 'crystal', system: 3, event: 'shortage', tier: 1 });
    const there = eventOffers(near, [shortage]);
    expect(there[0]).toMatchObject({ kind: 'deliver', cargo: 'crystal', system: 3, event: 'shortage' });
    expect(eventOffers(7, [raid])[0]).toMatchObject({ kind: 'pirates', system: 7, event: 'raid' });
    expect(eventOffers(getGalaxy().links[7][0], [raid])[0]).toMatchObject({ kind: 'deliver', system: 7, cargo: 'ore' });
    // farther out: urgent freight for the guild's sealed containers
    const far = getGalaxy().stars.map((s) => s.id).find((i) => jumpsFrom(i)[7] === 2)!;
    expect(eventOffers(far, [raid])[0]).toMatchObject({ kind: 'freight', system: 7, urgent: true, event: 'raid', origin: far });
    expect(eventOffers(5, [storm])[0]).toMatchObject({ kind: 'supply', cargo: 'ore', event: 'storm' });
    // they ride along with the normal board, with stable ids
    const board = generateBoard(3, 4, [], [shortage]);
    expect(board.filter((o) => o.event)).toEqual(here);
    expect(new Set(board.map((o) => o.id)).size).toBe(board.length);
  });
});

function pilot(game: Game, name: string) {
  const sent: Uint8Array[] = [];
  const t: Transport = { send: (d) => sent.push(d.slice()), close: () => {}, buffered: 0 };
  const c = game.connect(t);
  c.onMessage(encodeJson(MSG.HELLO, { v: PROTOCOL_VERSION, name }));
  const s = [...game.sessions.values()].find((x) => x.pilot.name === name)!;
  const events = () => sent.filter((d) => d[0] === MSG.EVENTS).flatMap((d) => decodeJson<{ ev: GameEvent[] }>(d).ev);
  return { s, sent, events, say: (text: string) => c.onMessage(encodeJson(MSG.CHAT, { text })) };
}
const run = (game: Game, seconds: number) => { for (let i = 0; i < seconds * TICK_RATE; i++) game.step(); };

describe('events on the server', () => {
  // a moment with no scheduled event in system 0, so the dev events are the only ones there
  let now = T0;
  while (galaxyEventsAt(now).some((e) => e.system === 0) || galaxyEventsAt(now + 15 * 60_000).some((e) => e.system === 0)) now += 60_000;
  const game = new Game({ store: new PilotStore(':memory:'), dev: true, now: () => now });

  it('pilots get the list of events on login and news when one begins', () => {
    const me = pilot(game, 'News');
    const first = me.events().find((e) => e.t === 'galaxy');
    expect(first).toBeTruthy();
    me.say('/gevent shortage relic 5');
    run(game, 1.1);
    const news = me.events().filter((e): e is Extract<GameEvent, { t: 'galaxy' }> => e.t === 'galaxy').pop()!;
    const ev = news.list.find((e) => e.system === 0)!;
    expect(ev).toMatchObject({ kind: 'shortage', good: 'relic' });
    expect(news.fresh).toContain(ev.id);
    expect(ev.left).toBeGreaterThan(4 * 60_000);
  });

  it('a shortage raises the price at the station and puts an urgent supply contract on its board', () => {
    const sys = game.system(0);
    pilotSay('/gevent end');
    const plain = sys.market.quote().goods.crystal.sell;
    pilotSay('/gevent shortage crystal');
    expect(sys.market.quote().goods.crystal.sell).toBeGreaterThan(plain * 1.8);
    const offer = sys.contracts.board().offers.find((o) => o.event === 'shortage' && o.kind === 'supply');
    expect(offer).toMatchObject({ kind: 'supply', cargo: 'crystal' });
    // the neighbours' prices seen from another station follow too
    const nb = getGalaxy().links[0][0];
    expect(game.quotes([0])[0].goods.crystal.sell).toBeGreaterThan(plain * 1.8);
    expect(game.system(nb).contracts.board().offers.some((o) => o.event === 'shortage' && o.kind === 'deliver')).toBe(true);
  });

  it('a raid brings raiders to the station; they leave when it ends', () => {
    const sys = game.system(0);
    const before = [...sys.ships.values()].filter((s) => s.npc).length;
    pilotSay('/gevent raid 3');
    run(game, 1.1);
    expect(sys.galaxy.raidersAlive()).toBeGreaterThanOrEqual(3);
    const raiders = [...sys.ships.values()].filter((s) => s.name.startsWith('Налётчик'));
    expect(raiders.length).toBe(sys.galaxy.raidersAlive());
    for (const r of raiders) expect(sys.inSafeZone(r.world.p)).toBe(false);
    expect(sys.contracts.board().offers.some((o) => o.event === 'raid' && o.kind === 'pirates')).toBe(true);
    now += 4 * 60_000;
    run(game, 1.1);
    expect(sys.galaxy.raidersAlive()).toBe(0);
    expect([...sys.ships.values()].filter((s) => s.npc).length).toBeLessThanOrEqual(before);
  });

  it('a storm hits ships in open space and drops fragments to collect', () => {
    const me = pilot(game, 'Stormy');
    const sys = me.s.system;
    pilotSay('/gevent end');
    sys.devTeleport(me.s, 'field');
    expect(me.s.mode).toBe(MODE.SHIP);
    me.s.ship.state.v = { x: 0, y: 0, z: 0 };
    pilotSay('/gevent storm 20');
    const loot = sys.world.loot.size;
    run(game, 90);
    expect(me.events().some((e) => e.t === 'hit' && e.target === me.s.ship.id && e.by === 0)).toBe(true);
    expect(sys.world.loot.size + countPicked(me)).toBeGreaterThan(loot);
    expect(me.events().some((e) => e.t === 'msg' && e.text.includes('метеорит'))).toBe(true);
  });

  function pilotSay(text: string) {
    const s = [...game.sessions.values()][0];
    game['command'](s, text);
  }
  function countPicked(p: ReturnType<typeof pilot>) {
    return p.events().filter((e) => e.t === 'loot').length;
  }
});
