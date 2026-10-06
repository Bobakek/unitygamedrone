import { describe, expect, it } from 'vitest';
import { PilotStore } from '../src/server/db.ts';
import { Game } from '../src/server/game/game.ts';
import type { Transport } from '../src/server/game/session.ts';
import { getGalaxy, jumpsFrom } from '../src/shared/galaxy/galaxy.ts';
import {
  BOARD_EPOCH_MS, combatStats, decodeJson, encodeJson, FREIGHT_FAIL_REP, FREIGHT_JUMPS, FREIGHT_SIZE, freightLoad, freightOffer, generateBoard,
  holdRoom, holdUsed, MODE, MSG, newCareer, PROTOCOL_VERSION, TICK_RATE, validCareer, type ContractDef, type GameEvent,
  emptyCargo,
} from '../src/shared/index.ts';

function pilot(game: Game, name: string) {
  const sent: Uint8Array[] = [];
  const t: Transport = { send: (d) => sent.push(d.slice()), close: () => {}, buffered: 0 };
  game.connect(t).onMessage(encodeJson(MSG.HELLO, { v: PROTOCOL_VERSION, name }));
  const s = [...game.sessions.values()].find((x) => x.pilot.name === name)!;
  const events = () => sent.filter((d) => d[0] === MSG.EVENTS).flatMap((d) => decodeJson<{ ev: GameEvent[] }>(d).ev);
  return { s, sent, events };
}
const run = (game: Game, seconds: number) => { for (let i = 0; i < seconds * TICK_RATE; i++) game.step(); };

describe('freight offers', () => {
  it('every board has long-haul freight from this station, far away, with a deadline and a deposit', () => {
    for (const sysId of [0, 3, 11]) {
      for (let ep = 0; ep < 20; ep++) {
        const board = generateBoard(sysId, ep);
        const freight = board.filter((o) => o.kind === 'freight');
        expect(freight.length).toBeGreaterThanOrEqual(1);
        // the first one is entry level
        expect(freight[0].tier).toBe(1);
        for (const o of freight) {
          const hops = jumpsFrom(sysId)[o.system];
          const [lo, hi] = FREIGHT_JUMPS[o.tier];
          expect(o.origin).toBe(sysId);
          expect(hops === Math.max(...jumpsFrom(sysId)) || (hops >= lo && hops <= hi)).toBe(true);
          expect(hops).toBeGreaterThanOrEqual(2);
          expect(o.need).toBe(FREIGHT_SIZE[o.tier]);
          expect(o.time).toBeGreaterThan(hops * 60_000);
          expect(o.deposit).toBeGreaterThan(0);
          expect(o.deposit).toBeLessThan(o.reward.credits);
        }
      }
    }
  });

  it('tier 1 fits a fighter with one hold upgrade; the rest need the hauler', () => {
    const u = { weapons: 1, shields: 1, hull: 1, engine: 1, cargo: 1 };
    expect(FREIGHT_SIZE[1]).toBeGreaterThan(combatStats(u, 'fighter').cargoCap);
    expect(FREIGHT_SIZE[1]).toBeLessThanOrEqual(combatStats({ ...u, cargo: 2 }, 'fighter').cargoCap);
    expect(FREIGHT_SIZE[3]).toBeGreaterThan(combatStats({ ...u, cargo: 4 }, 'fighter').cargoCap);
    expect(FREIGHT_SIZE[3]).toBeLessThanOrEqual(combatStats(u, 'hauler').cargoCap);
  });

  it('urgent freight (from galaxy events) pays more and gives less time; stored careers keep deadlines', () => {
    const far = jumpsFrom(0).findIndex((h) => h === 3);
    const plain = freightOffer(0, far, 2, 'a');
    const rush = freightOffer(0, far, 2, 'b', { urgent: true, reason: 'Станцию осадили пираты.' });
    expect(rush.reward.credits).toBeGreaterThan(plain.reward.credits);
    expect(rush.time!).toBeLessThan(plain.time!);
    expect(rush.desc).toContain('осадили');
    const c = validCareer({ active: [{ ...rush, have: 0, due: 1_700_000_000_000 }] });
    expect(c.active[0].due).toBe(1_700_000_000_000);
    expect(freightLoad(c)).toBe(rush.need);
  });
});

describe('freight runs', () => {
  let clock = 5000 * BOARD_EPOCH_MS + 1000;
  const game = new Game({ store: new PilotStore(':memory:'), dev: true, now: () => clock });
  const me = pilot(game, 'Trucker');
  const home = me.s.system;
  const career = () => me.s.pilot.career;
  const freight = (tier = 1): ContractDef => home.contracts.board().offers.find((o) => o.kind === 'freight' && o.tier === tier)
    ?? home.contracts.board().offers.find((o) => o.kind === 'freight')!;
  const reset = () => {
    if (me.s.system !== home) game.transfer(me.s, home.def.id);
    me.s.pilot.career = newCareer();
    me.s.pilot.career.xp = 2000;
    me.s.pilot.ship = 'hauler';
    me.s.pilot.ships = ['fighter', 'hauler'];
    me.s.pilot.credits = 5000;
    me.s.pilot.cargo = emptyCargo();
    me.s.ship.dead = false;
    me.s.mode = MODE.DOCKED;
  };
  const take = (o: ContractDef) => home.handleAction(me.s, { a: 'takeContract', id: o.id });
  const dockAt = (sysId: number) => {
    game.transfer(me.s, sysId);
    me.s.system.devTeleport(me.s, 'dock');
    return me.s.system.handleAction(me.s, { a: 'dock' });
  };

  it('taking freight loads containers into the hold and takes the deposit', () => {
    reset();
    me.s.pilot.ship = 'fighter';
    const o = freight();
    expect(take(o)).toMatch(/Нужно 16 мест в трюме/);
    me.s.pilot.ship = 'hauler';
    me.s.pilot.credits = 10;
    expect(take(o)).toMatch(/Нужен залог/);
    me.s.pilot.credits = 5000;
    expect(take(o)).toBeNull();
    expect(me.s.pilot.credits).toBe(5000 - o.deposit!);
    expect(career().active[0].due).toBe(clock + o.time!);
    expect(holdUsed(me.s.pilot)).toBe(o.need);
    // the containers take room other cargo would need
    const room = holdRoom(me.s.pilot);
    me.s.pilot.cargo.ore = room;
    expect(holdRoom(me.s.pilot)).toBe(0);
    me.s.pilot.cargo.ore = 0;
    // dropping it at the loading station gives the deposit back
    expect(home.handleAction(me.s, { a: 'dropContract', id: o.id })).toBeNull();
    expect(me.s.pilot.credits).toBe(5000);
  });

  it('delivered in time: reward, deposit back and a bonus for speed', () => {
    reset();
    const o = freight();
    expect(take(o)).toBeNull();
    const before = me.s.pilot.credits;
    // docking at some other station does not unload it
    const other = getGalaxy().links[home.def.id].find((n) => n !== o.system)!;
    expect(dockAt(other)).toBeNull();
    expect(freightLoad(career())).toBe(o.need);
    expect(dockAt(o.system)).toBeNull();
    expect(career().active).toEqual([]);
    expect(career().done).toContain(o.id);
    const fast = Math.round((o.reward.credits * 0.2) / 10) * 10;
    expect(me.s.pilot.credits).toBe(before + o.reward.credits + o.deposit! + fast);
    expect(career().rep.guild).toBe(o.reward.rep);
  });

  it('late freight fails: the deposit is lost and the Guild is displeased', () => {
    reset();
    const o = freight();
    expect(take(o)).toBeNull();
    const credits = me.s.pilot.credits;
    me.s.mode = MODE.SHIP;
    clock += o.time! + 1000;
    run(game, 1.1);
    expect(career().active).toEqual([]);
    expect(career().rep.guild).toBe(-FREIGHT_FAIL_REP);
    expect(me.s.pilot.credits).toBe(credits);
    expect(me.events().some((e) => e.t === 'announce' && e.text === 'Груз потерян')).toBe(true);
  });

  it('losing the ship loses the freight', () => {
    reset();
    const o = freight();
    expect(take(o)).toBeNull();
    home.devTeleport(me.s, 'open');
    me.s.mode = MODE.SHIP;
    home.kill(me.s.ship, 0);
    expect(career().active).toEqual([]);
    expect(freightLoad(career())).toBe(0);
    run(game, 6);
  });

  it('pirates raid a pilot carrying freight in open space and drop them out of cruise', () => {
    reset();
    const o = freight(2);
    expect(take(o)).toBeNull();
    home.devTeleport(me.s, 'open');
    me.s.mode = MODE.SHIP;
    me.s.ship.state.cruise = 5;
    const n = home.ships.size;
    home.contracts.raid(me.s);
    const raiders = [...home.ships.values()].filter((e) => e.npc && e.npc.target === me.s.ship.id);
    expect(raiders.length).toBe(Math.min(4, o.tier + (home.def.security === 'frontier' ? 1 : 0)));
    expect(home.ships.size).toBe(n + raiders.length);
    expect(raiders.every((e) => e.transient)).toBe(true);
    expect(me.s.ship.state.cruise).toBe(0);
    expect(me.s.ship.state.cruiseBlock).toBeGreaterThan(0);
    // never more than four at once
    home.contracts.raid(me.s);
    home.contracts.raid(me.s);
    expect([...home.ships.values()].filter((e) => e.npc && e.npc.target === me.s.ship.id).length).toBeLessThanOrEqual(4);
    for (const r of raiders) home.kill(r, me.s.ship.id);
  });

  it('pirates wait at the gates of the frontier for convoys, but leave Syndicate friends alone', () => {
    reset();
    const o = freight();
    expect(take(o)).toBeNull();
    const frontier = getGalaxy().stars.find((s) => s.security === 'frontier')!.id;
    const hunted = () => [...me.s.system.ships.values()].filter((e) => e.npc && e.npc.target === me.s.ship.id && !e.dead).length;
    let raids = 0;
    for (let i = 0; i < 12 && !raids; i++) {
      game.transfer(me.s, frontier);
      run(game, 9);
      raids += hunted();
      game.transfer(me.s, home.def.id);
    }
    expect(raids).toBeGreaterThan(0);
    // friends of the Syndicate are let through
    me.s.pilot.career.rep.pirate = 60;
    for (let i = 0; i < 6; i++) {
      game.transfer(me.s, frontier);
      run(game, 9);
      expect(hunted()).toBe(0);
      game.transfer(me.s, home.def.id);
    }
  });
});
