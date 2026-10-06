import { describe, expect, it } from 'vitest';
import { PilotStore } from '../src/server/db.ts';
import { Game } from '../src/server/game/game.ts';
import type { Transport } from '../src/server/game/session.ts';
import { GROUP_BONUS, GROUP_MAX } from '../src/server/game/groups.ts';
import {
  BASE_BOUNTY, BOARD_EPOCH_MS, BOUNTY, CARGO_KEYS, decodeJson, encodeJson, getSystem, MARKET_RANGE, marketProfile, marketQuote, MODE, MSG,
  PRICES, PROTOCOL_VERSION, SYSTEM_COUNT, TICK_RATE, v3, type ActiveContract, type GameEvent, type GroupMsg, type MarketMsg,
} from '../src/shared/index.ts';

function pilot(game: Game, name: string) {
  const sent: Uint8Array[] = [];
  const t: Transport = { send: (d) => sent.push(d.slice()), close: () => {}, buffered: 0 };
  const c = game.connect(t);
  c.onMessage(encodeJson(MSG.HELLO, { v: PROTOCOL_VERSION, name }));
  const s = [...game.sessions.values()].find((x) => x.pilot.name === name)!;
  const last = <T>(type: number) => {
    const d = sent.filter((x) => x[0] === type).pop();
    return d ? decodeJson<T>(d) : null;
  };
  const events = () => sent.filter((d) => d[0] === MSG.EVENTS).flatMap((d) => decodeJson<{ ev: GameEvent[] }>(d).ev);
  return {
    s, sent, c, last, events,
    act: (a: object) => c.onMessage(encodeJson(MSG.ACTION, a)),
    say: (text: string) => c.onMessage(encodeJson(MSG.CHAT, { text })),
  };
}
const run = (game: Game, seconds: number) => { for (let i = 0; i < seconds * TICK_RATE; i++) game.step(); };

describe('station markets', () => {
  it('every system values goods its own way, and arbitrage exists for every good', () => {
    for (const k of CARGO_KEYS) {
      const mults = Array.from({ length: SYSTEM_COUNT }, (_, i) => marketProfile(i).mult[k]);
      expect(Math.min(...mults)).toBeCloseTo(MARKET_RANGE[0]);
      expect(Math.max(...mults)).toBeCloseTo(MARKET_RANGE[1]);
      // somebody sells it
      expect(Array.from({ length: SYSTEM_COUNT }, (_, i) => marketProfile(i).exports.includes(k)).some(Boolean)).toBe(true);
    }
    for (let i = 0; i < SYSTEM_COUNT; i++) {
      expect(marketProfile(i).exports.length).toBeGreaterThan(0);
      const q = marketQuote(i, 7);
      for (const k of CARGO_KEYS) {
        expect(q.goods[k].sell).toBeGreaterThan(0);
        if (q.goods[k].buy) expect(q.goods[k].buy!).toBeGreaterThan(q.goods[k].sell);
      }
    }
  });

  it('prices are deterministic, drift between epochs and react to trade', () => {
    expect(marketQuote(1, 3)).toEqual(marketQuote(1, 3));
    const drift = CARGO_KEYS.some((k) => marketQuote(1, 3).goods[k].sell !== marketQuote(1, 4).goods[k].sell);
    expect(drift).toBe(true);
    expect(marketQuote(1, 3, { relic: 20 }).goods.relic.sell).toBeLessThan(marketQuote(1, 3).goods.relic.sell);
    expect(marketQuote(1, 3, { relic: -20 }).goods.relic.sell).toBeGreaterThan(marketQuote(1, 3).goods.relic.sell);
  });

  const game = new Game({ store: new PilotStore(':memory:'), dev: true, now: () => 5 * BOARD_EPOCH_MS + 1000 });
  const me = pilot(game, 'Trader');
  const sys = me.s.system;
  const dock = () => { sys.devTeleport(me.s, 'dock'); expect(sys.handleAction(me.s, { a: 'dock' })).toBeNull(); };

  it('docking sends this station and its neighbours through the gates', () => {
    dock();
    const m = me.last<MarketMsg>(MSG.MARKET)!;
    expect(m.here.system).toBe(sys.def.id);
    expect(m.others.map((o) => o.system).sort()).toEqual(getSystem(sys.def.id).gates.map((g) => g.target).sort());
    expect(m.next).toBeGreaterThan(0);
  });

  it('selling pushes the price down, and it recovers with time', () => {
    const k = CARGO_KEYS.find((x) => !marketProfile(sys.def.id).exports.includes(x)) ?? 'relic';
    const before = sys.market.quote().goods[k].sell;
    me.s.pilot.cargo[k] = 10;
    const credits = me.s.pilot.credits;
    expect(sys.handleAction(me.s, { a: 'sell', key: k, n: 10 })).toBeNull();
    expect(me.s.pilot.cargo[k]).toBe(0);
    const got = me.s.pilot.credits - credits;
    // the first unit at the full price, the rest a little cheaper each
    expect(got).toBeLessThan(before * 10);
    expect(got).toBeGreaterThan(before * 10 * 0.8);
    const after = sys.market.quote().goods[k].sell;
    expect(after).toBeLessThan(before);
    run(game, 600);
    expect(sys.market.quote().goods[k].sell).toBeGreaterThan(after);
    expect(sys.handleAction(me.s, { a: 'sell', key: k })).toBe('Трюм пуст');
    // junk from the wire never breaks the hold
    me.s.pilot.cargo[k] = 2;
    sys.handleAction(me.s, { a: 'sell', key: k, n: 'x' as unknown as number });
    sys.handleAction(me.s, { a: 'buy', key: k, n: 'x' as unknown as number });
    for (const c of CARGO_KEYS) expect(Number.isFinite(me.s.pilot.cargo[c])).toBe(true);
    expect(Number.isFinite(me.s.pilot.credits)).toBe(true);
  });

  it('the station sells its exports, within the hold and the purse', () => {
    const prof = marketProfile(sys.def.id);
    const ex = prof.exports[0];
    const no = CARGO_KEYS.find((x) => !prof.exports.includes(x));
    if (no) expect(sys.handleAction(me.s, { a: 'buy', key: no, n: 1 })).toBe('Станция это не продаёт');
    for (const k of CARGO_KEYS) me.s.pilot.cargo[k] = 0;
    me.s.pilot.credits = 100000;
    const price = sys.market.quote().goods[ex].buy!;
    expect(sys.handleAction(me.s, { a: 'buy', key: ex, n: 999 })).toBeNull();
    expect(me.s.pilot.cargo[ex]).toBe(me.s.pilotInfo().cargoCap);
    expect(sys.market.quote().goods[ex].buy!).toBeGreaterThan(price);
    expect(sys.handleAction(me.s, { a: 'buy', key: ex, n: 1 })).toBe('Трюм полон');
    me.s.pilot.cargo[ex] = 0;
    me.s.pilot.credits = 0;
    expect(sys.handleAction(me.s, { a: 'buy', key: ex, n: 1 })).toBe('Недостаточно кредитов');
  });

  it('a hold bought cheap sells for more where the good is scarce', () => {
    const k = 'ore';
    const cheap = [...Array(SYSTEM_COUNT).keys()].sort((a, b) => marketProfile(a).mult[k] - marketProfile(b).mult[k]);
    const ep = 5;
    const from = marketQuote(cheap[0], ep), to = marketQuote(cheap[cheap.length - 1], ep);
    expect(from.goods[k].buy).toBeTruthy();
    expect(to.goods[k].sell * 12).toBeGreaterThan(from.goods[k].buy! * 12 + PRICES[k] * 3);
  });
});

describe('pilot groups', () => {
  const game = new Game({ store: new PilotStore(':memory:'), dev: true });
  const a = pilot(game, 'Lead');
  const b = pilot(game, 'Wing');
  const c = pilot(game, 'Loner');
  const sys = a.s.system;
  const park = (s: typeof a.s, dx: number) => {
    const st = sys.def.station.pos;
    s.ship.state.p = v3(st.x + dx, st.y + 6000, st.z + 9000);
    s.ship.state.frame = 0;
    s.ship.state.v = v3();
    sys.syncWorld(s.ship);
  };

  it('invite by name, accept, and both see the group', () => {
    a.say('/invite wing');
    expect(b.s.invite?.from).toBe(a.s);
    expect(b.last<GroupMsg>(MSG.GROUP)!.invite?.from).toBe('Lead');
    b.act({ a: 'groupAnswer', yes: true });
    expect(a.s.group).toBeTruthy();
    expect(a.s.group).toBe(b.s.group);
    expect(a.s.group!.leader).toBe(a.s);
    const g = a.last<GroupMsg>(MSG.GROUP)!;
    expect(g.members.map((m) => m.name).sort()).toEqual(['Lead', 'Wing']);
    expect(g.members.find((m) => m.name === 'Lead')!.leader).toBe(true);
    // only the leader invites
    expect(game.groups.invite(b.s, c.s)).toMatch(/лидер/);
  });

  it('members get positions once a second; group chat reaches the group only', () => {
    run(game, 1.1);
    expect(a.last<GroupMsg>(MSG.GROUP)!.members.every((m) => m.pos)).toBe(true);
    a.say('/g на базу');
    const hit = (p: typeof a) => p.events().some((e) => e.t === 'chat' && e.text === 'на базу');
    expect(hit(a) && hit(b)).toBe(true);
    expect(hit(c)).toBe(false);
  });

  it('no friendly fire inside a group; outsiders still get hurt', () => {
    park(a.s, 20000); park(b.s, 20100); park(c.s, 20200);
    a.s.mode = b.s.mode = c.s.mode = MODE.SHIP;
    const hb = b.s.ship.hull + b.s.ship.shield;
    sys.damage(b.s.ship, 30, a.s.ship.id);
    expect(b.s.ship.hull + b.s.ship.shield).toBe(hb);
    expect(sys.fireMissile(a.s.ship, b.s.ship.id)).toMatch(/группы/);
    const hc = c.s.ship.hull + c.s.ship.shield;
    sys.damage(c.s.ship, 30, a.s.ship.id);
    expect(c.s.ship.hull + c.s.ship.shield).toBeLessThan(hc);
  });

  it('a kill is split between members nearby with a bonus, and counts for their contracts', () => {
    const pirate = [...sys.ships.values()].find((s) => s.npc && s.npc.role !== 'turret')!;
    pirate.state.p = { ...a.s.ship.state.p };
    sys.syncWorld(pirate);
    const job = (): ActiveContract => ({
      id: `p${Math.random()}`, kind: 'pirates', faction: 'fed', tier: 1, title: 'Охота', system: sys.def.id, need: 3, have: 0,
      reward: { credits: 100, xp: 10, rep: 2 },
    } as ActiveContract);
    a.s.pilot.career.active = [job()];
    b.s.pilot.career.active = [job()];
    c.s.pilot.career.active = [job()];
    const ca = a.s.pilot.credits, cb = b.s.pilot.credits, cc = c.s.pilot.credits;
    sys.kill(pirate, a.s.ship.id);
    const share = Math.round((BOUNTY.npc * (1 + GROUP_BONUS)) / 2);
    expect(a.s.pilot.credits - ca).toBe(share);
    expect(b.s.pilot.credits - cb).toBe(share);
    expect(c.s.pilot.credits).toBe(cc);
    expect(a.s.pilot.career.active[0].have).toBe(1);
    expect(b.s.pilot.career.active[0].have).toBe(1);
    expect(c.s.pilot.career.active[0].have).toBe(0);
    expect(a.s.pilot.kills).toBe(1);
    expect(b.s.pilot.kills).toBe(0);
  });

  it('a mate far away gets nothing', () => {
    park(b.s, 90000);
    const pirate = [...sys.ships.values()].find((s) => s.npc && s.npc.role !== 'turret')!;
    const cb = b.s.pilot.credits, ca = a.s.pilot.credits;
    sys.kill(pirate, a.s.ship.id);
    expect(b.s.pilot.credits).toBe(cb);
    expect(a.s.pilot.credits - ca).toBe(BOUNTY.npc);
    expect(BASE_BOUNTY).toBeGreaterThan(0);
  });

  it('declining, expiry and the size limit', () => {
    a.act({ a: 'groupInvite', entity: c.s.ship.id });
    expect(c.s.invite?.from).toBe(a.s);
    c.say('/decline');
    expect(c.s.invite).toBeNull();
    expect(c.s.group).toBeNull();
    a.say('/invite Loner');
    run(game, 61);
    expect(c.s.invite).toBeNull();
    expect(GROUP_MAX).toBeGreaterThanOrEqual(3);
  });

  it('the leader leaving hands the lead over; a group of one breaks up', () => {
    a.say('/invite Loner');
    c.say('/accept');
    expect(a.s.group!.members.length).toBe(3);
    a.say('/leave');
    expect(a.s.group).toBeNull();
    expect(b.s.group!.leader).toBe(b.s);
    b.say('/kick loner');
    expect(b.s.group).toBeNull();
    expect(c.s.group).toBeNull();
    expect(b.last<GroupMsg>(MSG.GROUP)!.members).toEqual([]);
  });

  it('going offline leaves the group', () => {
    a.say('/invite wing');
    b.say('/accept');
    expect(a.s.group).toBeTruthy();
    b.c.onClose();
    expect(a.s.group).toBeNull();
  });
});
