import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PilotStore } from '../src/server/db.ts';
import { Game } from '../src/server/game/game.ts';
import type { Transport } from '../src/server/game/session.ts';
import { decodeJson, encodeJson, getSystem, MODE, MSG, PROTOCOL_VERSION, TICK_RATE, v3, vscale, type GameEvent } from '../src/shared/index.ts';
import { footHeight } from '../src/shared/planet/terrain.ts';
import { planetSites, SITE_CACHES, SITE_NODE_BASE, siteDir } from '../src/shared/planet/sites.ts';
import { resourceNode } from '../src/shared/planet/resources.ts';
import { CABIN, inCabin, stepDeck } from '../src/shared/station/deck.ts';
import { addTrophy, milestoneTrophies, trophyInfo, validTrophies, type Trophy } from '../src/shared/station/trophies.ts';
import { newChar } from '../src/shared/sim/character.ts';

function pilot(game: Game, name: string) {
  const sent: Uint8Array[] = [];
  const t: Transport = { send: (d) => sent.push(d.slice()), close: () => {}, buffered: 0 };
  const c = game.connect(t);
  c.onMessage(encodeJson(MSG.HELLO, { v: PROTOCOL_VERSION, name }));
  const s = [...game.sessions.values()].find((x) => x.pilot.name === name)!;
  const events = () => sent.filter((d) => d[0] === MSG.EVENTS).flatMap((d) => decodeJson<{ ev: GameEvent[] }>(d).ev);
  return { s, events };
}

/** A system, planet and site of a kind (searching the galaxy from system 0). */
function findSite(pred: (s: ReturnType<typeof planetSites>[number]) => boolean) {
  for (let id = 0; id < 24; id++) {
    for (const pl of getSystem(id).planets) {
      const site = planetSites(pl).find(pred);
      if (site) return { id, pl, site };
    }
  }
  throw new Error('no such site');
}

describe('trophies', () => {
  it('ids say what a trophy is; bad ids are rejected', () => {
    const { id, pl, site } = findSite((s) => s.kind === 'wreck');
    expect(trophyInfo(`log:${id}:${pl.index}:${site.id}`)).toMatchObject({ kind: 'log', site: { system: id, planet: pl.index, site: site.id } });
    expect(trophyInfo(`relic:${id}:${pl.index}:${site.id}`)?.kind).toBe('relic');
    expect(trophyInfo('patch:kills:10')?.name).toMatch(/Десять/);
    expect(trophyInfo('patch:rank:3')?.name).toMatch(/Капитан/);
    expect(trophyInfo('medal:guild:4')?.name).toMatch(/Золотая/);
    expect(trophyInfo('specimen:3')?.name).toMatch(/Жнец/);
    expect(trophyInfo('shard:5')?.kind).toBe('shard');
    for (const bad of ['', 'relic:99:0:0', 'relic:0:0:999', 'patch:kills:7', 'patch:rank:0', 'medal:fed:2', 'medal:xx:3', 'specimen:99', 'shard:-1', 'hat:1']) {
      expect(trophyInfo(bad)).toBeNull();
    }
  });

  it('kills, rank and reputation earn patches and medals once', () => {
    const list: Trophy[] = [];
    const got = milestoneTrophies(list, 12, 950, { fed: 30, guild: 70, pirate: -80 });
    expect(got).toEqual(['patch:kills:1', 'patch:kills:10', 'patch:rank:1', 'patch:rank:2', 'medal:fed:3', 'medal:guild:3', 'medal:guild:4']);
    for (const id of got) expect(addTrophy(list, id, 1)).not.toBeNull();
    expect(addTrophy(list, 'patch:kills:1', 2)).toBeNull();
    expect(milestoneTrophies(list, 12, 950, { fed: 30, guild: 70, pirate: -80 })).toEqual([]);
  });

  it('stored lists are cleaned up', () => {
    expect(validTrophies('nope')).toEqual([]);
    expect(validTrophies([{ id: 'patch:kills:1', at: 5 }, { id: 'patch:kills:1', at: 6 }, { id: 'junk' }, null, { id: 'shard:2' }]))
      .toEqual([{ id: 'patch:kills:1', at: 5 }, { id: 'shard:2', at: 0 }]);
  });

  it('are saved with the pilot, old databases get the column', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'nova-')), 'old.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE pilots (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, token TEXT NOT NULL,
      credits INTEGER NOT NULL DEFAULT 250, cargo TEXT NOT NULL, upgrades TEXT NOT NULL, missiles INTEGER NOT NULL, kills INTEGER NOT NULL DEFAULT 0,
      deaths INTEGER NOT NULL DEFAULT 0, system INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, last_seen INTEGER NOT NULL)`);
    old.prepare(`INSERT INTO pilots (name, token, cargo, upgrades, missiles, created, last_seen) VALUES ('Veteran', 't', '{}', '{}', 4, 0, 0)`).run();
    old.close();
    const store = new PilotStore(path);
    const p = store.find('Veteran')!;
    expect(p.trophies).toEqual([]);
    p.trophies.push({ id: 'patch:kills:1', at: 123 });
    store.save(p);
    store.close();
    expect(new PilotStore(path).find('Veteran')!.trophies).toEqual([{ id: 'patch:kills:1', at: 123 }]);
  });
});

describe('earning trophies in the game', () => {
  const game = new Game({ store: new PilotStore(':memory:'), dev: true });
  const me = pilot(game, 'Collector');

  it('a kill milestone is announced and shows up in the pilot info', () => {
    me.s.pilot.kills = 10;
    me.s.sendPilot();
    expect(me.s.pilot.trophies.map((t) => t.id)).toEqual(expect.arrayContaining(['patch:kills:1', 'patch:kills:10']));
    expect(me.events().some((e) => e.t === 'announce' && e.sub === 'Нашивка «Десять сбитых»')).toBe(true);
    expect(me.s.pilotInfo().trophies.length).toBe(me.s.pilot.trophies.length);
  });

  /** Puts the pilot on foot on `pl` at site-plane point (x, z) of `site`. */
  const standAt = (sysId: number, plIndex: number, site: ReturnType<typeof planetSites>[number], x: number, z: number) => {
    if (me.s.system.def.id !== sysId) game.transfer(me.s, sysId);
    const sys = me.s.system;
    const pl = sys.def.planets[plIndex];
    sys.devTeleport(me.s, `land${plIndex}`);
    expect(sys.handleAction(me.s, { a: 'exit' })).toBeNull();
    const d = siteDir(pl, site, x, z);
    me.s.char!.state.p = vscale(v3(), d, pl.radius + footHeight(pl, d.x, d.y, d.z) + 0.05);
    return sys;
  };

  it("reading a wreck's log on its bridge files it in the cabin", () => {
    const { id, pl, site } = findSite((s) => s.kind === 'wreck');
    const sys = standAt(id, pl.index, site, site.goal.x - 1, site.goal.z);
    expect(sys.handleAction(me.s, { a: 'readLog' })).toBeNull();
    expect(me.s.pilot.trophies.some((t) => t.id === `log:${id}:${pl.index}:${site.id}`)).toBe(true);
    // far from the console: nothing
    const n = me.s.pilot.trophies.length;
    const away = standAt(id, pl.index, site, site.goal.x + 40, site.goal.z + 40);
    away.handleAction(me.s, { a: 'readLog' });
    expect(me.s.pilot.trophies.length).toBe(n);
  });

  it('the first relic from a site cache goes on the shelf', () => {
    const { id, pl, site } = findSite((s) => s.caches.some((c) => c.type === 'relic'));
    const k = site.caches.findIndex((c) => c.type === 'relic');
    const nodeId = SITE_NODE_BASE + site.id * SITE_CACHES + k;
    const node = resourceNode(pl, nodeId)!;
    expect(node.type).toBe('relic');
    const sys = standAt(id, pl.index, site, 0, 0);
    me.s.char!.state.p = vscale(v3(), node.dir, pl.radius + node.h);
    expect(sys.handleAction(me.s, { a: 'harvest', node: nodeId })).toBeNull();
    expect(me.s.pilot.trophies.some((t) => t.id === `relic:${id}:${pl.index}:${site.id}`)).toBe(true);
  });
});

describe('the cabin', () => {
  const game = new Game({ store: new PilotStore(':memory:'), dev: true });
  const me = pilot(game, 'Resident');
  const other = pilot(game, 'Neighbour');
  const sys = me.s.system;
  const onDeck = (s: typeof me.s) => {
    sys.devTeleport(s, 'dock');
    expect(sys.handleAction(s, { a: 'dock' })).toBeNull();
    expect(sys.handleAction(s, { a: 'disembark' })).toBeNull();
  };

  it('is reached through its door in the promenade wall, and only through it', () => {
    const walk = (x: number) => {
      const c = newChar(v3(x, 0, -37), v3(0, 0, -1));
      for (let i = 0; i < 3 * TICK_RATE; i++) stepDeck(c, { mx: 0, mz: 1, yawDelta: 0, pitch: 0, jump: false, sprint: false, dive: false }, 1 / TICK_RATE);
      return c.p;
    };
    const through = walk(CABIN.door.x);
    expect(inCabin(through)).toBe(true);
    expect(through.z).toBeGreaterThan(CABIN.z0);
    // beside the door the wall stops the pilot
    expect(walk(CABIN.door.x - 4).z).toBeGreaterThan(-40.6);
  });

  it('pilots in a cabin do not see the others, nor are they seen', () => {
    onDeck(me.s);
    onDeck(other.s);
    const seen = (a: typeof me.s, b: typeof me.s) => sys.buildSnapshot(a).entities.some((e) => e.id === b.char!.id);
    other.s.char!.state.p = v3(-15, 0, -30);
    me.s.char!.state.p = v3(-15, 0, -32);
    expect(seen(other.s, me.s)).toBe(true);
    me.s.char!.state.p = v3(-15, 0, -48);
    expect(seen(other.s, me.s)).toBe(false);
    expect(seen(me.s, other.s)).toBe(false);
    expect(me.s.mode).toBe(MODE.DECK);
  });
});
