import { describe, expect, it } from 'vitest';
import { PilotStore } from '../src/server/db.ts';
import { Game } from '../src/server/game/game.ts';
import type { Transport } from '../src/server/game/session.ts';
import {
  ANOMALY_SCAN_TIME, BASE_BOUNTY, PILOT_HP, vnorm, vsub, CFLAG, aimByte, aimPitch, KIND, MOOD, moodOf, cargoCount, decodeJson, encodeJson, FWD, MSG, nodesNear, PROTOCOL_VERSION, qrot, resourceNode, TICK_RATE, v3, vdist,
  type GameEvent, type Poi, getSystem, heightAt, MODE, lookCode, defaultOutfit, type PilotInfo,
} from '../src/shared/index.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collidersNear } from '../src/shared/planet/prop-rules.ts';
import { inSite, planetSites, SITE_NODE_BASE } from '../src/shared/planet/sites.ts';

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
    me.s.pilot.cargo = { ore: 0, crystal: 0, relic: 0, bio: 0 };
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
    me.s.pilot.cargo = { ore: 4, crystal: 2, relic: 1, bio: 3 };
    sys.fauna.hurt(me.s, 500, 0);
    expect(me.s.char).toBeNull();
    expect(me.s.mode).toBe(0);
    expect(me.s.pilot.cargo).toEqual({ ore: 2, crystal: 1, relic: 1, bio: 2 });
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
    v.items.push('suit-tan', 'lights-eva');
    v.outfit.suit = 'suit-tan';
    v.outfit.lights = 'lights-eva';
    store.save(v);
    store.close();
    const again = new PilotStore(path).find('Veteran')!;
    expect(again.items).toEqual(['suit-tan', 'lights-eva']);
    expect(again.outfit.suit).toBe('suit-tan');
    expect(again.outfit.lights).toBe('lights-eva');
  });
});
