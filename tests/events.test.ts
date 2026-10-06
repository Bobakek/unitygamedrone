import { describe, expect, it } from 'vitest';
import { PilotStore } from '../src/server/db.ts';
import { Game } from '../src/server/game/game.ts';
import type { Transport } from '../src/server/game/session.ts';
import {
  ANOMALY_SCAN_TIME, BASE_BOUNTY, PILOT_HP, vnorm, vsub, CFLAG, aimByte, aimPitch, KIND, MOOD, moodOf, cargoCount, decodeJson, encodeJson, FWD, MSG, nodesNear, PROTOCOL_VERSION, qrot, resourceNode, TICK_RATE, v3, vdist,
  type GameEvent, type Poi, getSystem, heightAt, MODE, lookCode, defaultOutfit, type PilotInfo,
  BOARD_EPOCH_MS, BOUNTY, newCareer, generateBoard, WANTED_BOUNTY, type BoardMsg, type ContractDef, type ContractKind,
  planetRot, toBodyDir, DECK_FRAME, DECK_PLANET, emptyCargo,
  getGalaxy, jumpCost, tankOf, fuelPrice, START_FUEL, JUMP_CHARGE, ARRIVAL_RANGE,
  galaxyEventsAt,
} from '../src/shared/index.ts';
import { RAMP } from '../src/shared/station/deck.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collidersNear } from '../src/shared/planet/prop-rules.ts';
import { inSite, planetSites, SITE_NODE_BASE, siteDir } from '../src/shared/planet/sites.ts';

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

const getSys = () => getSystem(0);
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
    me.s.pilot.cargo = emptyCargo();
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

  it('outpost towers shoot nearby ships and pay a bounty when silenced', () => {
    const pl = sys.def.planets.find((p) => planetSites(p).some((x) => x.kind === 'base'))!;
    const base = planetSites(pl).find((x) => x.kind === 'base')!;
    const towers = sys.outposts.towersOf(base);
    expect(towers.length).toBe(3);
    // hover 350 m above the base in the planet's frame
    const st = me.s.ship.state;
    const r = pl.radius + base.h + 350;
    st.frame = pl.index + 1; st.landed = 0; st.v = v3();
    st.p = v3(base.dir.x * r, base.dir.y * r, base.dir.z * r);
    me.s.ship.hull = me.s.ship.combat.maxHull; me.s.ship.shield = me.s.ship.combat.maxShield;
    sys.syncWorld(me.s.ship);
    const hp = me.s.ship.hull + me.s.ship.shield;
    run(game, 4);
    expect(me.s.ship.hull + me.s.ship.shield).toBeLessThan(hp);
    const credits = me.s.pilot.credits;
    for (const t of towers) sys.damage(t, 1e6, me.s.ship.id);
    expect(sys.outposts.silenced(base)).toBe(true);
    expect(me.s.pilot.credits).toBeGreaterThanOrEqual(credits + BASE_BOUNTY + 300);
    game.step();
    expect(me.events().some((e) => e.t === 'announce' && /база/i.test(e.text))).toBe(true);
  });
});

describe('surface sites', () => {
  const pl = getSys().planets[1];
  const sites = planetSites(pl);

  it('are deterministic, on dry flat land and far apart', () => {
    expect(sites.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(planetSites({ ...pl }))).toBe(JSON.stringify(sites));
    for (const s of sites) {
      expect(s.h).toBeGreaterThan(3);
      for (const o of sites) if (o !== s) expect(vdist(s.dir, o.dir) * pl.radius).toBeGreaterThan(2500);
    }
    expect(sites.some((s) => s.kind === 'ruin')).toBe(true);
  });

  it('keep trees out, expose caches as harvestable nodes and make pillars solid', () => {
    const ruin = sites.find((s) => s.kind === 'ruin')!;
    expect(inSite(pl, ruin.dir)).toBe(true);
    const nodes = nodesNear(pl, ruin.dir, 200).filter((n) => n.id >= SITE_NODE_BASE);
    expect(nodes.length).toBe(ruin.caches.length);
    for (const n of nodes) expect(resourceNode(pl, n.id)).toEqual(n);
    const cols = collidersNear(pl, ruin.pillars[0].dir);
    expect(cols.some((c) => Math.abs(c.r - ruin.pillars[0].r) < 1e-9)).toBe(true);
  });
});

describe('fauna and on-foot combat', () => {
  const game = new Game({ store: new PilotStore(':memory:'), dev: true });
  const me = pilot(game, 'Ranger');
  const sys = me.s.system;
  const pl = sys.def.planets.find((p) => p.type === 'terran')!;
  sys.devTeleport(me.s, `land${pl.index}`);
  expect(sys.handleAction(me.s, { a: 'exit' })).toBeNull();
  const ch = me.s.char!;

  it('grazers bolt when a pilot comes close', () => {
    const herd = sys.fauna.devSpawn(pl.index, ch.state.p, 0, 12);
    expect(herd.length).toBeGreaterThan(0);
    const d0 = vdist(herd[0].state.p, ch.state.p);
    run(game, 2);
    expect(herd.some((c) => c.mood === 'flee')).toBe(true);
    expect(vdist(herd[0].state.p, ch.state.p)).toBeGreaterThan(d0);
  });

  it('predators hunt and bite, the blaster kills them and carcasses yield samples', () => {
    ch.hp = PILOT_HP;
    const [hunter] = sys.fauna.devSpawn(pl.index, ch.state.p, 1, 25);
    expect(hunter.sp.predator).toBe(true);
    run(game, 6);
    expect(ch.hp).toBeLessThan(PILOT_HP);
    expect(me.events().some((e) => e.t === 'hurt')).toBe(true);
    expect(me.events().some((e) => e.t === 'roar' && e.id === hunter.id)).toBe(true);
    // face the hunter and shoot until it drops
    ch.hp = PILOT_HP;
    for (let i = 0; i < 60 && !hunter.dead; i++) {
      const up = vnorm(v3(), ch.state.p);
      const to = vsub(v3(), hunter.state.p, ch.state.p);
      const k = to.x * up.x + to.y * up.y + to.z * up.z;
      ch.state.f = vnorm(v3(), v3(to.x - up.x * k, to.y - up.y * k, to.z - up.z * k));
      const dist = Math.hypot(to.x, to.y, to.z);
      sys.fauna.shoot(me.s, Math.atan2(k - 1.45 + hunter.sp.size * 0.8, Math.sqrt(Math.max(0, dist * dist - k * k))));
      run(game, 0.3);
    }
    expect(hunter.dead).toBe(true);
    expect(sys.shots.length + me.events().filter((e) => e.t === 'hit').length).toBeGreaterThan(0);
    ch.state.p = { ...hunter.state.p };
    const bio = me.s.pilot.cargo.bio;
    expect(sys.handleAction(me.s, { a: 'sample', id: hunter.id })).toBeNull();
    expect(me.s.pilot.cargo.bio).toBe(bio + hunter.sp.samples);
    expect(sys.fauna.creatures.has(hunter.id)).toBe(false);
  });

  it('other pilots see aiming, pitch and creature moods', () => {
    const watcher = pilot(game, 'Watcher');
    ch.pitch = 0.3;
    sys.fauna.shoot(me.s, 0.3);
    const snap = sys.buildSnapshot(watcher.s);
    const e = snap.entities.find((x) => x.id === ch.id)!;
    expect(e.flags & CFLAG.AIM).toBeTruthy();
    expect(aimPitch(aimByte(0.3))).toBeCloseTo(0.3, 5);
    expect(e.shield).toBeCloseTo(aimByte(0.3), 5);
    const herd = sys.fauna.devSpawn(pl.index, ch.state.p, 6, 30);
    game.step();
    const s2 = sys.buildSnapshot(me.s);
    const c = s2.entities.find((x) => x.id === herd[0].id)!;
    expect(c.kind).toBe(KIND.CREATURE);
    expect([MOOD.graze, MOOD.alert, MOOD.flee, MOOD.wander]).toContain(moodOf(c.throttle));
  });

  it('a pilot whose suit fails is recalled to the ship and loses half the cargo', () => {
    me.s.pilot.cargo = { ...emptyCargo(), ore: 4, crystal: 2, relic: 1, bio: 3 };
    sys.fauna.hurt(me.s, 500, 0);
    expect(me.s.char).toBeNull();
    expect(me.s.mode).toBe(0);
    expect(me.s.pilot.cargo).toEqual({ ...emptyCargo(), ore: 2, crystal: 1, relic: 1, bio: 2 });
  });
});

describe('the sea', () => {
  const game = new Game({ store: new PilotStore(':memory:'), dev: true });
  const me = pilot(game, 'Diver');
  const sys = me.s.system;
  const pl = sys.def.planets.find((p) => p.type === 'terran')!;
  expect(sys.devTeleport(me.s, 'dive', String(pl.index))).toBe('Под водой');
  const ch = me.s.char!;
  const depth = () => pl.radius - Math.hypot(ch.state.p.x, ch.state.p.y, ch.state.p.z);

  it('puts a dev diver under water, where other pilots see them swimming', () => {
    expect(ch.state.swim).toBeGreaterThan(0);
    expect(depth()).toBeGreaterThan(1);
    ch.state.swim = 2;
    const watcher = pilot(game, 'Snorkel');
    const e = sys.buildSnapshot(watcher.s).entities.find((x) => x.id === ch.id)!;
    expect(e.flags & CFLAG.SWIM).toBeTruthy();
    expect(e.flags & CFLAG.UNDER).toBeTruthy();
    expect(e.flags & CFLAG.AIR).toBeFalsy();
  });

  it('sea creatures gather around a swimmer and stay in the water', () => {
    run(game, 4);
    const sea = [...sys.fauna.creatures.values()].filter((c) => c.sp.aquatic && c.planet === pl.index);
    expect(sea.length).toBeGreaterThan(0);
    for (const c of sea) {
      const r = Math.hypot(c.state.p.x, c.state.p.y, c.state.p.z), u = vnorm(v3(), c.state.p);
      expect(r).toBeLessThan(pl.radius - 0.9);
      expect(r).toBeGreaterThan(pl.radius + heightAt(pl, u.x, u.y, u.z) + 1);
    }
  });

  it('rays dart away from a diver', () => {
    const [ray] = sys.fauna.devSpawn(pl.index, ch.state.p, 8, 7);
    expect(ray?.sp.aquatic).toBe(true);
    run(game, 1.5);
    expect(ray.mood).toBe('flee');
  });

  it('sharks hunt and bite pilots in the water, give up on dry ones, and float up when dead', () => {
    ch.hp = PILOT_HP;
    const [shark] = sys.fauna.devSpawn(pl.index, ch.state.p, 9, 18);
    expect(shark.sp.predator && shark.sp.aquatic).toBe(true);
    run(game, 10);
    expect(me.events().some((e) => e.t === 'bite' && e.id === shark.id)).toBe(true);
    expect(ch.hp).toBeLessThan(PILOT_HP);
    // out of the water, the pilot is no prey
    ch.state.swim = 0;
    run(game, 1);
    expect(shark.mood).not.toBe('hunt');
    ch.state.swim = 2;
    sys.fauna.damage(shark, 999, me.s);
    expect(shark.dead).toBe(true);
    run(game, 25);
    expect(Math.hypot(shark.state.p.x, shark.state.p.y, shark.state.p.z)).toBeGreaterThan(pl.radius - 1);
  });

  it('running out of air floods the suit bit by bit', () => {
    ch.hp = PILOT_HP;
    ch.state.air = 0;
    const n0 = me.events().filter((e) => e.t === 'hurt').length;
    run(game, 3.5);
    expect(ch.hp).toBeLessThan(PILOT_HP - 16);
    expect(me.events().filter((e) => e.t === 'hurt').length - n0).toBeGreaterThanOrEqual(3);
  });
});

describe('wardrobe', () => {
  const game = new Game({ store: new PilotStore(':memory:'), dev: true });
  const me = pilot(game, 'Dandy');
  const sys = me.s.system;
  const pl = sys.def.planets.find((p) => p.type === 'terran')!;
  const lastPilot = () => decodeJson<PilotInfo>(me.sent.filter((d) => d[0] === MSG.PILOT).pop()!);

  it('sells suit parts only when docked and paid for, and wears them at once', () => {
    me.s.pilot.credits = 5000;
    expect(sys.handleAction(me.s, { a: 'buyItem', id: 'pack-o2' })).toBe('Нужно пристыковаться');
    me.s.mode = MODE.DOCKED;
    expect(sys.handleAction(me.s, { a: 'equip', id: 'pack-o2' })).toBe('Сначала купите');
    expect(sys.handleAction(me.s, { a: 'buyItem', id: 'pack-o2' })).toBeNull();
    expect(me.s.pilot.credits).toBe(5000 - 900);
    expect(me.s.pilot.outfit.pack).toBe('pack-o2');
    expect(lastPilot().outfit.pack).toBe('pack-o2');
    expect(lastPilot().items).toContain('pack-o2');
    expect(sys.handleAction(me.s, { a: 'buyItem', id: 'pack-o2' })).toBe('Уже куплено');
    // the starter kit is always there; patches are free
    expect(sys.handleAction(me.s, { a: 'equip', id: 'pack-plss' })).toBeNull();
    expect(me.s.pilot.outfit.pack).toBe('pack-plss');
    expect(sys.handleAction(me.s, { a: 'equip', id: 'patch-skull' })).toBeNull();
    me.s.pilot.credits = 10;
    expect(sys.handleAction(me.s, { a: 'buyItem', id: 'chest-plate' })).toBe('Недостаточно кредитов');
    expect(me.s.pilot.outfit.chest).toBe('chest-dcm');
  });

  it('armour raises suit integrity, pouches add samples, other pilots see the outfit', () => {
    me.s.pilot.credits = 5000;
    expect(sys.handleAction(me.s, { a: 'buyItem', id: 'chest-plate' })).toBeNull();
    expect(sys.handleAction(me.s, { a: 'buyItem', id: 'suit-orange' })).toBeNull();
    me.s.mode = MODE.SHIP;
    sys.devTeleport(me.s, `land${pl.index}`);
    expect(sys.handleAction(me.s, { a: 'exit' })).toBeNull();
    const ch = me.s.char!;
    expect(ch.maxHp).toBe(130);
    expect(ch.hp).toBe(130);
    expect(sys.buildSnapshot(me.s).self.suit).toBeCloseTo(100, 5);
    const info = sys.allInfos().find((i) => i.id === ch.id)!;
    expect(info.look).toBe(lookCode(me.s.pilot.outfit));
    expect(info.look).toContain('suit-orange');
    // sample pouches: one more sample from a carcass
    me.s.pilot.items.push('chest-rig');
    me.s.pilot.outfit.chest = 'chest-rig';
    const [beast] = sys.fauna.devSpawn(pl.index, ch.state.p, 0, 10);
    sys.fauna.damage(beast, 999, me.s);
    ch.state.p = { ...beast.state.p };
    const bio = me.s.pilot.cargo.bio;
    expect(sys.handleAction(me.s, { a: 'sample', id: beast.id })).toBeNull();
    expect(me.s.pilot.cargo.bio).toBe(bio + beast.sp.samples + 1);
  });

  it('pilot stores keep items and outfits, and migrate databases from before the wardrobe', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'nova-')), 'old.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE pilots (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, token TEXT NOT NULL,
      credits INTEGER NOT NULL DEFAULT 250, cargo TEXT NOT NULL, upgrades TEXT NOT NULL, missiles INTEGER NOT NULL,
      kills INTEGER NOT NULL DEFAULT 0, deaths INTEGER NOT NULL DEFAULT 0, system INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, last_seen INTEGER NOT NULL)`);
    old.prepare(`INSERT INTO pilots (name, token, cargo, upgrades, missiles, created, last_seen) VALUES ('Veteran', 't', '{}', '{}', 4, 0, 0)`).run();
    old.close();
    const store = new PilotStore(path);
    const v = store.find('Veteran')!;
    expect(v.items).toEqual([]);
    expect(v.outfit).toEqual(defaultOutfit());
    expect(v.career).toEqual(newCareer());
    v.career.xp = 950;
    v.career.rep.guild = 31;
    v.items.push('suit-tan', 'lights-eva');
    v.outfit.suit = 'suit-tan';
    v.outfit.lights = 'lights-eva';
    store.save(v);
    store.close();
    const again = new PilotStore(path).find('Veteran')!;
    expect(again.items).toEqual(['suit-tan', 'lights-eva']);
    expect(again.outfit.suit).toBe('suit-tan');
    expect(again.outfit.lights).toBe('lights-eva');
    expect(again.career.xp).toBe(950);
    expect(again.career.rep.guild).toBe(31);
  });
});

describe('contracts', () => {
  let clock = 3000 * BOARD_EPOCH_MS + 1000;
  const game = new Game({ store: new PilotStore(':memory:'), dev: true, now: () => clock });
  const me = pilot(game, 'Contractor');
  const sys = me.s.system;
  const desk = sys.contracts;
  const career = () => me.s.pilot.career;
  const fresh = () => { me.s.pilot.career = newCareer(); me.s.pilot.career.xp = 2000; me.s.mode = MODE.DOCKED; };
  /** First offer of a kind (and tier) on this or a later board. */
  const offer = (kind: ContractKind, tier?: number): ContractDef => {
    for (let i = 0; i < 80; i++) {
      const o = desk.board().offers.find((x) => x.kind === kind && (tier === undefined || x.tier === tier));
      if (o) return o;
      clock += BOARD_EPOCH_MS;
    }
    throw new Error(`no ${kind} offer`);
  };
  const take = (o: ContractDef) => { me.s.mode = MODE.DOCKED; expect(sys.handleAction(me.s, { a: 'takeContract', id: o.id })).toBeNull(); };
  const done = (o: ContractDef) => career().done.includes(o.id) && !career().active.some((a) => a.id === o.id);
  const onFoot = (planet: number) => {
    me.s.mode = MODE.SHIP;
    sys.devTeleport(me.s, `land${planet}`);
    expect(sys.handleAction(me.s, { a: 'exit' })).toBeNull();
    return me.s.char!;
  };

  it('the board is the same for everyone in an epoch, changes with time and is sent on docking', () => {
    const a = desk.board().offers;
    expect(a.length).toBeGreaterThanOrEqual(5);
    expect(generateBoard(sys.def.id, Math.floor(clock / BOARD_EPOCH_MS), [], galaxyEventsAt(clock))).toEqual(a);
    expect(new Set(a.map((o) => o.faction))).toEqual(new Set(['fed', 'guild', 'pirate']));
    expect(a.some((o) => o.tier === 1 && o.faction === 'guild') && a.some((o) => o.tier === 1 && o.faction === 'fed')).toBe(true);
    sys.devTeleport(me.s, 'dock');
    expect(sys.handleAction(me.s, { a: 'dock' })).toBeNull();
    const msg = decodeJson<BoardMsg>(me.sent.filter((d) => d[0] === MSG.BOARD).pop()!);
    expect(msg.offers.map((o) => o.id)).toEqual(a.map((o) => o.id));
    expect(msg.next).toBeGreaterThan(0);
    expect(msg.next).toBeLessThanOrEqual(BOARD_EPOCH_MS);
    clock += BOARD_EPOCH_MS;
    expect(desk.board().changed).toBe(true);
    expect(desk.board().offers[0].id).not.toBe(a[0].id);
  });

  it('contracts are taken at the station within the limits of the rank', () => {
    me.s.pilot.career = newCareer();
    const o1 = offer('supply', 1);
    me.s.mode = MODE.SHIP;
    expect(sys.handleAction(me.s, { a: 'takeContract', id: o1.id })).toBe('Нужно пристыковаться');
    take(o1);
    expect(sys.handleAction(me.s, { a: 'takeContract', id: o1.id })).toBe('Уже взят');
    expect(sys.handleAction(me.s, { a: 'takeContract', id: 'nope' })).toBe('Предложение устарело');
    const hard = offer('survey', 3);
    expect(sys.handleAction(me.s, { a: 'takeContract', id: hard.id })).toBe('Нужен ранг Капитан');
    const o2 = desk.board().offers.find((x) => x.tier === 1 && x.id !== o1.id)!;
    take(o2);
    const o3 = desk.board().offers.find((x) => x.tier === 1 && x.id !== o1.id && x.id !== o2.id)!;
    expect(sys.handleAction(me.s, { a: 'takeContract', id: o3.id })).toMatch(/Не больше 2/);
    // dropping costs a little standing with the client
    expect(sys.handleAction(me.s, { a: 'dropContract', id: o2.id })).toBeNull();
    expect(career().active.map((a) => a.id)).toEqual([o1.id]);
    expect(career().rep[o2.faction]).toBe(-2);
  });

  it('hunts are counted by kills of the named predator and pay credits, experience and standing', () => {
    fresh();
    const o = offer('hunt', 1);
    take(o);
    const ch = onFoot(o.planet!);
    const credits = me.s.pilot.credits;
    // a wrong species does not count
    const other = (o.species! + 1) % 8;
    const [x] = sys.fauna.devSpawn(o.planet!, ch.state.p, other, 12);
    sys.fauna.damage(x, 999, me.s);
    expect(career().active[0].have).toBe(0);
    let killed = 0;
    while (killed < o.need) {
      for (const b of sys.fauna.devSpawn(o.planet!, ch.state.p, o.species!, 12)) {
        if (killed < o.need) { sys.fauna.damage(b, 999, me.s); killed++; }
      }
    }
    expect(done(o)).toBe(true);
    expect(me.s.pilot.credits).toBe(credits + o.reward.credits);
    expect(career().xp).toBe(2000 + o.reward.xp);
    expect(career().rep.guild).toBe(o.reward.rep);
    expect(me.events().some((e) => e.t === 'announce' && e.text === 'Контракт выполнен')).toBe(true);
  });

  it('clearing a base counts its turrets; pirate kills count for bounty contracts', () => {
    fresh();
    const c = offer('clear');
    take(c);
    const p = offer('pirates', 1);
    take(p);
    const site = planetSites(sys.def.planets[c.planet!])[c.site!];
    for (const t of sys.outposts.towersOf(site).slice(0, c.need)) sys.kill(t, me.s.ship.id);
    expect(done(c)).toBe(true);
    expect(career().rep.pirate).toBe(-4 * c.need - 4);
    const raiders = [...sys.ships.values()].filter((sh) => sh.npc?.role === 'raider').slice(0, p.need);
    expect(raiders.length).toBe(p.need);
    for (const r of raiders) sys.kill(r, me.s.ship.id);
    expect(done(p)).toBe(true);
    expect(career().rep.fed).toBe(c.reward.rep + p.reward.rep + p.need);
  });

  it('a convoy brings an interception offer, which is withdrawn when the convoy leaves', () => {
    fresh();
    sys.devTeleport(me.s, 'open');
    const poi = sys.world.spawn('convoy')!;
    expect(poi).toBeTruthy();
    const o = desk.board().offers.find((x) => x.kind === 'intercept' && x.poi === poi.id)!;
    expect(o).toBeTruthy();
    take(o);
    sys.kill(sys.ships.get(poi.ship!)!, me.s.ship.id);
    expect(done(o)).toBe(true);
    // a second convoy gets away
    const poi2 = sys.world.spawn('convoy')!;
    const o2 = desk.board().offers.find((x) => x.kind === 'intercept' && x.poi === poi2.id)!;
    take(o2);
    const fed = career().rep.fed;
    sys.ships.get(poi2.ship!)!.npc!.arrived = true;
    run(game, 1.2);
    expect(career().active.some((a) => a.id === o2.id)).toBe(false);
    expect(career().rep.fed).toBe(fed);
  });

  it('supplies and deliveries are handed over on docking, partly if need be', () => {
    fresh();
    const o = offer('supply');
    const k = o.cargo!;
    me.s.pilot.cargo[k] = o.need - 1;
    take(o);
    expect(career().active[0].have).toBe(o.need - 1);
    expect(me.s.pilot.cargo[k]).toBe(0);
    me.s.pilot.cargo[k] = 3;
    sys.devTeleport(me.s, 'dock');
    expect(sys.handleAction(me.s, { a: 'dock' })).toBeNull();
    expect(done(o)).toBe(true);
    expect(me.s.pilot.cargo[k]).toBe(2);
    // a delivery is only accepted at the station of the destination system
    const d = offer('deliver');
    take(d);
    me.s.pilot.cargo[d.cargo!] = d.need;
    sys.devTeleport(me.s, 'dock');
    sys.handleAction(me.s, { a: 'dock' });
    expect(career().active[0].have).toBe(0);
    game.transfer(me.s, d.system);
    const there = me.s.system;
    there.devTeleport(me.s, 'dock');
    expect(there.handleAction(me.s, { a: 'dock' })).toBeNull();
    expect(done(d)).toBe(true);
    game.transfer(me.s, sys.def.id);
  });

  it('surveys and contraband are done on foot at the site', () => {
    fresh();
    const sv = offer('survey');
    take(sv);
    const ch = onFoot(sv.planet!);
    const pl = sys.def.planets[sv.planet!];
    const ruin = planetSites(pl)[sv.site!];
    run(game, 0.6);
    expect(done(sv)).toBe(false);
    ch.state.p = { x: ruin.dir.x * (pl.radius + ruin.h + 1), y: ruin.dir.y * (pl.radius + ruin.h + 1), z: ruin.dir.z * (pl.radius + ruin.h + 1) };
    run(game, 0.6);
    expect(done(sv)).toBe(true);

    const sm = offer('smuggle');
    take(sm);
    const ch2 = onFoot(sm.planet!);
    const pl2 = sys.def.planets[sm.planet!];
    const base = planetSites(pl2)[sm.site!];
    me.s.pilot.cargo[sm.cargo!] = sm.need - 1;
    ch2.state.p = { x: base.dir.x * (pl2.radius + base.h + 1), y: base.dir.y * (pl2.radius + base.h + 1), z: base.dir.z * (pl2.radius + base.h + 1) };
    run(game, 0.6);
    expect(done(sm)).toBe(false);
    me.s.pilot.cargo[sm.cargo!] = sm.need;
    run(game, 0.6);
    expect(done(sm)).toBe(true);
    expect(me.s.pilot.cargo[sm.cargo!]).toBe(0);
    expect(career().rep.fed).toBe(-8);
    expect(career().rep.pirate).toBe(sm.reward.rep);
  });

  it('pirates leave their friends alone until provoked', () => {
    fresh();
    sys.devTeleport(me.s, 'open');
    sys.handleAction(me.s, { a: 'undock' });
    me.s.mode = MODE.SHIP;
    const at = me.s.ship.world.p;
    expect(sys.findPrey(at, 500)?.id).toBe(me.s.ship.id);
    me.s.pilot.career.rep.pirate = 30;
    expect(sys.findPrey(at, 500)).toBeNull();
    expect(sys.truce(me.s.ship)).toBe(true);
    const raider = [...sys.ships.values()].find((sh) => sh.npc?.role === 'raider')!;
    sys.damage(raider, 1, me.s.ship.id);
    expect(sys.findPrey(at, 500)?.id).toBe(me.s.ship.id);
    expect(sys.truce(me.s.ship)).toBe(false);
  });

  it('a pilot wanted by the Federation is marked and worth more to other pilots', () => {
    fresh();
    const other = pilot(game, 'Bounty');
    desk.rep(me.s, 'fed', -40);
    expect(sys.shipInfo(me.s.ship).wanted).toBe(true);
    expect(sys.infos.some((i) => i.id === me.s.ship.id && i.wanted)).toBe(true);
    const credits = other.s.pilot.credits;
    me.s.mode = MODE.SHIP;
    sys.kill(me.s.ship, other.s.ship.id);
    expect(other.s.pilot.credits).toBe(credits + BOUNTY.player + WANTED_BOUNTY);
    run(game, 6);
  });

  it('faction gear is sold only to pilots in good standing', () => {
    fresh();
    me.s.pilot.credits = 5000;
    expect(sys.handleAction(me.s, { a: 'buyItem', id: 'suit-navy' })).toBe('Нужна репутация: Федерация — Друг');
    me.s.pilot.career.rep.fed = 30;
    expect(sys.handleAction(me.s, { a: 'buyItem', id: 'suit-navy' })).toBeNull();
    expect(sys.handleAction(me.s, { a: 'buyItem', id: 'chest-aegis' })).toBe('Нужна репутация: Федерация — Союзник');
  });
});

describe('weather hazards', () => {
  const game = new Game({ store: new PilotStore(':memory:'), dev: true });
  const me = pilot(game, 'Stormy');
  const sys = me.s.system;
  const ice = sys.def.planets.find((p) => p.type === 'ice')!;
  const barren = sys.def.planets.find((p) => p.type === 'barren')!;
  const terran = sys.def.planets.find((p) => p.type === 'terran')!;
  const onFoot = (pl: typeof ice) => {
    me.s.mode = MODE.SHIP;
    sys.devTeleport(me.s, `land${pl.index}`);
    expect(sys.handleAction(me.s, { a: 'exit' })).toBeNull();
    return me.s.char!;
  };

  it('a blizzard wears the suit down unless it has a thermal layer', () => {
    sys.weather.override(ice.index, 'blizzard', 1);
    expect(sys.events.some((e) => e.t === 'weather' && e.planet === ice.index)).toBe(true);
    let ch = onFoot(ice);
    run(game, 6);
    expect(ch.hp).toBeLessThan(ch.maxHp - 10);
    // with the thermal layer the suit keeps up
    me.s.pilot.items.push('mod-thermo');
    me.s.pilot.outfit.mod = 'mod-thermo';
    ch = onFoot(ice);
    run(game, 12);
    expect(ch.hp).toBeGreaterThan(ch.maxHp - 2);
    sys.weather.override(ice.index, 'clear', 0);
    me.s.pilot.outfit.mod = 'mod-none';
  });

  it('a radiation storm burns only on the day side', () => {
    sys.weather.override(barren.index, 'radiation', 1);
    const ch = onFoot(barren);
    const R = planetRot(barren, sys.time);
    const sun = toBodyDir(R, vnorm(v3(), vsub(v3(), sys.def.star.pos, barren.center)), v3());
    const put = (d: { x: number; y: number; z: number }) => {
      const u = vnorm(v3(), d);
      ch.state.p = { x: u.x * (barren.radius + heightAt(barren, u.x, u.y, u.z) + 0.05), y: u.y * (barren.radius + heightAt(barren, u.x, u.y, u.z) + 0.05), z: u.z * (barren.radius + heightAt(barren, u.x, u.y, u.z) + 0.05) };
      ch.state.v = v3();
      ch.hp = ch.maxHp;
    };
    put({ x: -sun.x, y: -sun.y, z: -sun.z });
    run(game, 3);
    expect(ch.hp).toBe(ch.maxHp);
    put(sun);
    run(game, 3);
    expect(ch.hp).toBeLessThan(ch.maxHp - 5);
    sys.weather.override(barren.index, 'clear', 0);
  });

  it('lightning strikes near pilots in a thunderstorm and hurts only up close', () => {
    sys.weather.override(terran.index, 'storm', 1);
    const ch = onFoot(terran);
    ch.hp = ch.maxHp;
    sys.events.length = 0;
    const far = { x: ch.state.p.x + 30, y: ch.state.p.y, z: ch.state.p.z };
    sys.weather.strike(terran.index, me.s, far);
    expect(ch.hp).toBe(ch.maxHp);
    sys.weather.strike(terran.index, me.s, { ...ch.state.p });
    expect(ch.hp).toBe(ch.maxHp - 30);
    expect(sys.events.filter((e) => e.t === 'strike').length).toBe(2);
    // the storm itself throws bolts around on its own
    const before = me.events().filter((e) => e.t === 'strike').length;
    run(game, 20);
    expect(me.events().filter((e) => e.t === 'strike').length - before).toBeGreaterThan(1);
    sys.weather.override(terran.index, 'clear', 0);
  });
});

describe('wrecks', () => {
  const game = new Game({ store: new PilotStore(':memory:'), dev: true });
  const me = pilot(game, 'Salvager');
  const sys = me.s.system;
  const pl = sys.def.planets.find((p) => p.type === 'ice')!;
  const site = planetSites(pl).find((s) => s.kind === 'wreck')!;
  const at = (x: number, z: number) => {
    const d = siteDir(pl, site, x, z);
    return { x: d.x * (pl.radius + heightAt(pl, d.x, d.y, d.z) + 0.05), y: d.y * (pl.radius + heightAt(pl, d.x, d.y, d.z) + 0.05), z: d.z * (pl.radius + heightAt(pl, d.x, d.y, d.z) + 0.05) };
  };
  const onFootAt = (x: number, z: number) => {
    me.s.mode = MODE.SHIP;
    sys.devTeleport(me.s, `land${pl.index}`);
    expect(sys.handleAction(me.s, { a: 'exit' })).toBeNull();
    const ch = me.s.char!;
    ch.state.p = at(x, z);
    ch.state.v = v3();
    ch.hp = ch.maxHp;
    return ch;
  };
  const drones = () => [...sys.fauna.creatures.values()].filter((c) => c.sp.drone && c.planet === pl.index);

  it('the hull shelters from a blizzard, the reactor room does not and is radioactive', () => {
    me.s.ship.god = false;
    sys.weather.override(pl.index, 'blizzard', 1);
    let ch = onFootAt(-4, -4);
    me.s.ship.god = true; // keep the drones from shooting in this test: god pilots are ignored
    expect(sys.shelter(pl.index, ch.state.p)).toBe(true);
    me.s.ship.god = false;
    const hp0 = ch.hp;
    sys.weather.step(2);
    expect(ch.hp).toBe(hp0);
    ch = onFootAt(-30, -4);
    expect(sys.reactorDose(pl.index, ch.state.p)).toBeGreaterThan(0);
    sys.weather.step(2);
    expect(ch.hp).toBeLessThan(ch.maxHp - 5);
    sys.weather.override(pl.index, 'clear', 0);
  });

  it('guard drones appear, shoot pilots they can see but not through walls, and are stripped for parts', () => {
    me.s.ship.god = true;
    let ch = onFootAt(40, 14);
    run(game, 1.2);
    const ds = drones();
    expect(ds.length).toBe(site.posts!.length);
    // outside the north wall: no line of sight
    me.s.ship.god = false;
    ch = onFootAt(0, 13);
    run(game, 4);
    expect(ch.hp).toBe(ch.maxHp);
    // in the hold, 8 m from the hold drone
    ch = onFootAt(5, 0);
    run(game, 5);
    expect(ch.hp).toBeLessThan(ch.maxHp);
    expect(me.events().some((e) => e.t === 'hurt' && ds.some((d) => d.id === e.by))).toBe(true);
    // shoot it down and take it apart
    const d = ds.find((x) => Math.hypot(x.guard!.x - -3, x.guard!.z) < 1)!;
    sys.fauna.damage(d, 999, me.s);
    ch.state.p = { ...d.state.p };
    const credits = me.s.pilot.credits, crystal = me.s.pilot.cargo.crystal;
    expect(sys.handleAction(me.s, { a: 'sample', id: d.id })).toBeNull();
    expect(me.s.pilot.credits).toBeGreaterThan(credits);
    expect(me.s.pilot.cargo.crystal).toBeGreaterThan(crystal);
    // it does not come back right away
    run(game, 2);
    expect(drones().length).toBe(site.posts!.length - 1);
  });

  it('a wreck survey is done on the bridge', () => {
    me.s.ship.god = true;
    me.s.pilot.career = newCareer();
    me.s.pilot.career.xp = 2000;
    const def: ContractDef = {
      id: 'test-wreck', kind: 'survey', faction: 'guild', tier: 2, title: 't', desc: 'd', system: sys.def.id, planet: pl.index, site: site.id, need: 1,
      reward: { credits: 100, xp: 10, rep: 1 },
    };
    me.s.pilot.career.active.push({ ...def, have: 0 });
    onFootAt(20, 0);
    run(game, 0.6);
    expect(me.s.pilot.career.done).not.toContain('test-wreck');
    onFootAt(site.goal.x - 1, 0);
    run(game, 0.6);
    expect(me.s.pilot.career.done).toContain('test-wreck');
  });
});

describe('station deck', () => {
  const game = new Game({ store: new PilotStore(':memory:'), dev: true });
  const me = pilot(game, 'Walker');
  const other = pilot(game, 'Watcher');
  const sys = me.s.system;
  let seq = 1000;
  const walk = (s: typeof me.s, mx: number, mz: number, seconds: number, yaw = 0) => {
    for (let i = 0; i < seconds * TICK_RATE; i++) {
      s.inputs.push({ seq: seq++, mode: MODE.DECK, flags: 0, t: sys.time, ship: { yaw: 0, pitch: 0, roll: 0, throttle: 0, strafeX: 0, strafeY: 0, boost: false, cruise: false }, char: { mx, mz, yawDelta: i === 0 ? yaw : 0, pitch: 0, jump: false, sprint: false, dive: false } });
      game.step();
    }
  };
  const dock = (s: typeof me.s) => { sys.devTeleport(s, 'dock'); expect(sys.handleAction(s, { a: 'dock' })).toBeNull(); };

  it('pilots walk out of the ship into the hangar and back, only next to it', () => {
    expect(sys.handleAction(me.s, { a: 'disembark' })).toBeNull();
    expect(me.s.mode).toBe(MODE.SHIP);
    dock(me.s);
    sys.handleAction(me.s, { a: 'disembark' });
    expect(me.s.mode).toBe(MODE.DECK);
    expect(me.s.char!.planet).toBe(-1);
    const snap = sys.buildSnapshot(me.s);
    expect(snap.self.charPlanet).toBe(DECK_PLANET);
    // walk forward (+z) towards the airlock: the char moves on the deck
    const z0 = me.s.char!.state.p.z;
    walk(me.s, 0, 1, 2);
    expect(me.s.char!.state.p.z).toBeGreaterThan(z0 + 5);
    expect(me.s.char!.state.p.y).toBe(0);
    // too far from the ship to board
    expect(sys.handleAction(me.s, { a: 'board' })).toBe('Подойдите к кораблю');
    me.s.char!.state.p = { x: RAMP.x, y: 0, z: RAMP.z };
    expect(sys.handleAction(me.s, { a: 'board' })).toBeNull();
    expect(me.s.mode).toBe(MODE.DOCKED);
    expect(me.s.char).toBeNull();
  });

  it('station services work from the deck, undocking takes the pilot back aboard', () => {
    sys.handleAction(me.s, { a: 'disembark' });
    me.s.pilot.cargo.ore = 3;
    const credits = me.s.pilot.credits;
    expect(sys.handleAction(me.s, { a: 'sell' })).toBeNull();
    expect(me.s.pilot.credits).toBeGreaterThan(credits);
    expect(sys.handleAction(me.s, { a: 'undock' })).toBeNull();
    expect(me.s.mode).toBe(MODE.SHIP);
    expect(me.s.char).toBeNull();
  });

  it('pilots on the deck are seen from inside the station only', () => {
    dock(me.s);
    sys.handleAction(me.s, { a: 'disembark' });
    const id = me.s.char!.id;
    other.s.mode = MODE.SHIP;
    sys.devTeleport(other.s, 'dock');
    expect(sys.buildSnapshot(other.s).entities.some((e) => e.id === id)).toBe(false);
    expect(sys.handleAction(other.s, { a: 'dock' })).toBeNull();
    const e = sys.buildSnapshot(other.s).entities.find((x) => x.id === id)!;
    expect(e).toBeTruthy();
    expect(e.frame).toBe(DECK_FRAME);
  });
});

describe('galaxy', () => {
  it('jumps follow the lanes and empty systems fall asleep', () => {
    const game = new Game({ store: new PilotStore(':memory:'), dev: true });
    const me = pilot(game, 'Rover');
    const home = me.s.system;
    expect(game.systems.length).toBe(1);
    const next = home.def.gates[0].target;
    // a jump through a gate lands at the gate back in the next system
    home.devTeleport(me.s, 'gate');
    game['jump'](me.s);
    expect(me.s.system.def.id).toBe(next);
    const back = me.s.system.def.gates.find((g) => g.target === home.def.id)!;
    expect(vdist(me.s.ship.world.p, back.pos)).toBeLessThan(1000);
    expect(game.systems.length).toBe(2);
    // the home system is empty now: it keeps running for a while, then sleeps
    expect(game.asleep(home)).toBe(false);
    run(game, 125);
    expect(game.asleep(home)).toBe(true);
    expect(game.asleep(me.s.system)).toBe(false);
    const npc = [...home.ships.values()].find((x) => x.npc && !x.dead)!;
    const was = { ...npc.state.p };
    run(game, 5);
    expect(npc.state.p).toEqual(was);
    // and wakes up when a pilot comes back
    game.transfer(me.s, home.def.id);
    expect(game.asleep(home)).toBe(false);
  });
});

describe('jump drive', () => {
  it('jumps from the map with fuel, after a charge a hit can break', () => {
    const game = new Game({ store: new PilotStore(':memory:'), dev: true });
    const me = pilot(game, 'Jumper');
    const home = me.s.system.def.id;
    const g = getGalaxy();
    // a star in range that is not a gate neighbour: the drive skips the lanes
    const to = g.stars.map((s) => s.id).find((i) => jumpCost(home, i) > 0 && !g.links[home].includes(i))!;
    const cost = jumpCost(home, to);
    expect(cost).toBeGreaterThan(0);
    // fuel is bought at the station, up to the tank
    me.s.system.devTeleport(me.s, 'dock');
    me.s.system.handleAction(me.s, { a: 'dock' });
    me.s.pilot.credits = 10000;
    expect(me.s.system.handleAction(me.s, { a: 'buyFuel' })).toBeNull();
    expect(me.s.pilot.fuel).toBe(tankOf(me.s.pilot.ship));
    expect(me.s.pilot.credits).toBe(10000 - (tankOf(me.s.pilot.ship) - START_FUEL) * fuelPrice(home));
    // not from the station's zone
    me.s.system.devTeleport(me.s, 'station');
    expect(game.chargeDrive(me.s, to, -1)).toMatch(/станции/);
    me.s.system.devTeleport(me.s, 'open');
    run(game, 0.2);
    // a hit while charging breaks the charge
    expect(game.chargeDrive(me.s, to, 0)).toBeNull();
    run(game, 2);
    me.s.ship.lastHit = game.time;
    run(game, 0.2);
    expect(me.s.charge).toBeNull();
    expect(me.s.system.def.id).toBe(home);
    // a clean charge jumps and burns the fuel; the ship comes out near the planet chosen
    const fuel = me.s.pilot.fuel;
    expect(game.chargeDrive(me.s, to, 0)).toBeNull();
    run(game, JUMP_CHARGE - 1);
    expect(me.s.system.def.id).toBe(home);
    run(game, 1.5);
    expect(me.s.system.def.id).toBe(to);
    expect(me.s.pilot.fuel).toBe(fuel - cost);
    const pl = me.s.system.def.planets[0];
    const d = vdist(me.s.ship.world.p, pl.center) - pl.radius;
    expect(d).toBeGreaterThan(ARRIVAL_RANGE[0]);
    expect(d).toBeLessThan(pl.radius + ARRIVAL_RANGE[1] + 10);
    // out of range or out of fuel: no
    const far = g.stars.map((s) => s.id).find((i) => jumpCost(to, i) < 0 && i !== to)!;
    expect(game.chargeDrive(me.s, far, -1)).toMatch(/далеко/);
    me.s.pilot.fuel = 0;
    const near = g.stars.map((s) => s.id).find((i) => jumpCost(to, i) > 0)!;
    expect(game.chargeDrive(me.s, near, -1)).toMatch(/топлива/);
  });
});
