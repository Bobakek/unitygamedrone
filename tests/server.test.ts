import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { PilotStore } from '../src/server/db.ts';
import { Game } from '../src/server/game/game.ts';
import { wsTransport } from '../src/server/game/session.ts';
import {
  decodeJson, decodeSnapshot, emptyCharInput, emptyInput, encodeInput, encodeJson, IFLAG, MODE, MSG, PROTOCOL_VERSION,
  FWD, KIND, nodesNear, qlook, qrot, quat, v3, vnorm, vdist, vcross, vscale, cargoCount, depositsNear, depositPos, roverGround, copyRover, newRover, type Snapshot, type Welcome,
} from '../src/shared/index.ts';

class Bot {
  ws!: WebSocket;
  welcome: Welcome | null = null;
  snap: Snapshot | null = null;
  events: any[] = [];
  errors: string[] = [];
  seq = 0;
  constructor(private url: string, public name: string) {}
  async connect(token?: string) {
    this.ws = new WebSocket(this.url);
    this.ws.binaryType = 'nodebuffer';
    this.ws.on('message', (d: Buffer) => {
      const u = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
      if (u[0] === MSG.WELCOME) this.welcome = decodeJson(u);
      else if (u[0] === MSG.SNAPSHOT) this.snap = decodeSnapshot(u);
      else if (u[0] === MSG.EVENTS) this.events.push(...decodeJson<{ ev: any[] }>(u).ev);
      else if (u[0] === MSG.ERROR) this.errors.push(decodeJson<{ message: string }>(u).message);
    });
    await new Promise((r) => this.ws.on('open', r));
    this.ws.send(encodeJson(MSG.HELLO, { v: PROTOCOL_VERSION, name: this.name, token }));
    await waitFor(() => !!this.welcome && !!this.snap);
  }
  input(flags = 0, ship = emptyInput()) {
    this.ws.send(encodeInput({ seq: ++this.seq, mode: MODE.SHIP, flags, t: this.snap?.time ?? 0, ship, char: emptyCharInput() }));
  }
  footInput(char = emptyCharInput()) {
    this.ws.send(encodeInput({ seq: ++this.seq, mode: MODE.FOOT, flags: 0, t: this.snap?.time ?? 0, ship: emptyInput(), char }));
  }
  roverInput(char = emptyCharInput(), flags = 0) {
    this.ws.send(encodeInput({ seq: ++this.seq, mode: MODE.ROVER, flags, t: this.snap?.time ?? 0, ship: emptyInput(), char }));
  }
  action(a: object) { this.ws.send(encodeJson(MSG.ACTION, a)); }
  close() { this.ws.close(); }
}

async function waitFor(fn: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 15));
  }
}

let game: Game, wss: WebSocketServer, url = '';
const store = new PilotStore(':memory:');

beforeAll(async () => {
  game = new Game({ store, dev: true, respawnDelay: 0.3 });
  wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => {
    const c = game.connect(wsTransport(ws));
    ws.on('message', (d: Buffer) => c.onMessage(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)));
    ws.on('close', () => c.onClose());
  });
  await new Promise((r) => wss.on('listening', r));
  url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  game.start();
});
afterAll(() => { game.stop(); wss.close(); });

const sessionOf = (b: Bot) => game.sessions.get(b.welcome!.playerId)!;

describe('game server', () => {
  it('rejects bad names and taken names', async () => {
    const bad = new Bot(url, 'x');
    await bad.connect().catch(() => {});
    expect(bad.errors[0]).toMatch(/Имя/);
    const a = new Bot(url, 'Taken');
    await a.connect();
    const b = new Bot(url, 'taken');
    await b.connect().catch(() => {});
    expect(b.errors[0]).toMatch(/занято/);
    // reconnect with token works and restores pilot
    a.close();
    await waitFor(() => game.sessions.size === 0);
    const a2 = new Bot(url, 'Taken');
    await a2.connect(a.welcome!.token);
    expect(a2.welcome!.pilot.name).toBe('Taken');
    a2.close();
    await waitFor(() => game.sessions.size === 0);
  });

  it('two players see each other, fight, die and respawn with bounty', async () => {
    const a = new Bot(url, 'Alpha'), b = new Bot(url, 'Bravo');
    await a.connect(); await b.connect();
    await waitFor(() => !!a.snap?.entities.some((e) => e.id === b.welcome!.shipId));

    // Move both far from the station safe zone, B 400 m in front of A.
    const sa = sessionOf(a), sb = sessionOf(b);
    const sys = sa.system;
    const base = v3(sys.def.station.pos.x + 12000, sys.def.station.pos.y + 9000, sys.def.station.pos.z);
    sa.ship.state.p = { ...base };
    sa.ship.state.q = qlook(quat(), v3(1, 0, 0), v3(0, 1, 0));
    sb.ship.state.p = v3(base.x + 400, base.y, base.z);
    sa.resync(); sb.resync();
    const hp0 = sb.ship.hull + sb.ship.shield;
    for (let i = 0; i < 45; i++) { a.input(IFLAG.FIRE); b.input(); await new Promise((r) => setTimeout(r, 33)); }
    await waitFor(() => sb.ship.hull + sb.ship.shield < hp0 - 20);
    expect(b.events.some((e) => e.t === 'hit' && e.target === b.welcome!.shipId)).toBe(true);

    sb.ship.shield = 0; sb.ship.hull = 5;
    for (let i = 0; i < 30 && !sb.ship.dead; i++) { a.input(IFLAG.FIRE); b.input(); await new Promise((r) => setTimeout(r, 33)); }
    await waitFor(() => a.events.some((e) => e.t === 'kill' && e.victim === 'Bravo'));
    await waitFor(() => sa.pilot.kills === 1 && sa.pilot.credits > 250);
    await waitFor(() => !sb.ship.dead && sb.mode === MODE.SHIP && sb.ship.hull === sb.ship.combat.maxHull, 3000);
    expect(vdist(sb.ship.state.p, sys.def.station.pos)).toBeLessThan(2000);
    a.close(); b.close();
    await waitFor(() => game.sessions.size === 0);
  });

  it('lands, walks, harvests, docks and sells', async () => {
    const c = new Bot(url, 'Miner');
    await c.connect();
    const s = sessionOf(c);
    const sys = s.system;
    // dev landing next to a resource node
    c.ws.send(encodeJson(MSG.CHAT, { text: '/land 1' }));
    await waitFor(() => s.ship.state.landed === 2);
    c.action({ a: 'exit' });
    await waitFor(() => s.mode === MODE.FOOT && !!s.char);
    await waitFor(() => c.snap?.self.mode === MODE.FOOT && !!c.snap.self.char);
    const pl = sys.def.planets[1];
    // landed ship and pilot live in the planet's rotating body frame
    expect(s.ship.state.frame).toBe(2);
    expect(c.snap!.self.ship.frame).toBe(2);
    // teleport the character onto the nearest node and harvest it
    const up = vnorm(v3(), s.char!.state.p);
    const node = nodesNear(pl, up, 200).sort((x, y) => (y.dir.x * up.x + y.dir.y * up.y + y.dir.z * up.z) - (x.dir.x * up.x + x.dir.y * up.y + x.dir.z * up.z))[0];
    expect(node).toBeTruthy();
    const r = pl.radius + node.h;
    s.char!.state.p = v3(node.dir.x * r, node.dir.y * r, node.dir.z * r);
    c.footInput();
    c.action({ a: 'harvest', node: node.id });
    await waitFor(() => s.pilot.cargo[node.type] === 1);
    await waitFor(() => c.events.some((e) => e.t === 'harvest' && e.node === node.id));
    // harvesting the same node again is refused
    c.action({ a: 'harvest', node: node.id });
    await new Promise((r2) => setTimeout(r2, 100));
    expect(s.pilot.cargo[node.type]).toBe(1);

    // walk around a bit
    for (let i = 0; i < 20; i++) { c.footInput({ ...emptyCharInput(), mz: 1 }); await new Promise((r2) => setTimeout(r2, 20)); }
    // back to the ship, board, fly to station and sell
    s.char!.state.p = { ...s.ship.state.p };
    c.action({ a: 'board' });
    await waitFor(() => s.mode === MODE.SHIP);
    s.ship.state.landed = 0;
    s.ship.state.frame = 0;
    s.ship.state.p = v3(sys.def.station.pos.x + 250, sys.def.station.pos.y, sys.def.station.pos.z);
    s.resync();
    c.action({ a: 'dock' });
    await waitFor(() => s.mode === MODE.DOCKED);
    const before = s.pilot.credits;
    c.action({ a: 'sell' });
    await waitFor(() => s.pilot.credits > before);
    c.action({ a: 'undock' });
    await waitFor(() => s.mode === MODE.SHIP);
    c.close();
    await waitFor(() => game.sessions.size === 0);
    expect(store.find('Miner')!.credits).toBeGreaterThan(before);
  });

  it('unloads a rover from the landed ship, drives it, others see it, and it goes back into the hold', async () => {
    const a = new Bot(url, 'Driver');
    const b = new Bot(url, 'Watcher');
    await a.connect();
    await b.connect();
    const s = sessionOf(a), o = sessionOf(b);
    a.ws.send(encodeJson(MSG.CHAT, { text: '/land 1' }));
    await waitFor(() => s.ship.state.landed === 2);
    // no rover from orbit or from the cockpit
    a.action({ a: 'rover' });
    a.action({ a: 'exit' });
    await waitFor(() => s.mode === MODE.FOOT && !!s.char);
    expect(s.rover).toBeNull();
    a.action({ a: 'rover' });
    await waitFor(() => !!s.rover);
    const rover = s.rover!;
    expect(s.system.rovers.get(rover.id)).toBe(rover);
    // too far to take the wheel, then next to it
    a.action({ a: 'drive' });
    await new Promise((r) => setTimeout(r, 80));
    expect(s.mode).toBe(MODE.FOOT);
    s.char!.state.p = { ...rover.state.p };
    a.action({ a: 'drive' });
    await waitFor(() => s.mode === MODE.ROVER && a.snap?.self.mode === MODE.ROVER && !!a.snap.self.rover);
    expect(a.snap!.self.roverId).toBe(rover.id);
    // the watcher, parked on the same planet, sees the rover (driven) but not a pilot walking
    b.ws.send(encodeJson(MSG.CHAT, { text: '/land 1' }));
    await waitFor(() => o.ship.state.landed === 2);
    await waitFor(() => !!b.snap?.entities.some((e) => e.id === rover.id));
    const seen = b.snap!.entities.find((e) => e.id === rover.id)!;
    expect(seen.kind).toBe(KIND.ROVER);
    expect(seen.frame).toBe(2);
    expect(b.snap!.entities.some((e) => e.id === s.char!.id)).toBe(false);
    // drive: it moves, the pilot rides along in the seat
    const p0 = { ...rover.state.p };
    for (let i = 0; i < 45; i++) { a.roverInput({ ...emptyCharInput(), mz: 1 }); await new Promise((r) => setTimeout(r, 33)); }
    await waitFor(() => vdist(rover.state.p, p0) > 3);
    expect(vdist(s.char!.state.p, rover.state.p)).toBeLessThan(1.5);
    // step out next to it, load it back by the ship
    a.action({ a: 'leave' });
    await waitFor(() => s.mode === MODE.FOOT);
    expect(vdist(s.char!.state.p, rover.state.p)).toBeLessThan(4);
    rover.state.p = { ...s.ship.state.p };
    s.char!.state.p = { ...s.ship.state.p };
    a.action({ a: 'rover' });
    await waitFor(() => !s.rover && !s.system.rovers.size);
    // a rover left behind is loaded automatically when the ship takes off
    a.action({ a: 'rover' });
    await waitFor(() => !!s.rover);
    s.char!.state.p = { ...s.ship.state.p };
    a.action({ a: 'board' });
    await waitFor(() => s.mode === MODE.SHIP);
    expect(s.rover).not.toBeNull();
    s.ship.state.landed = 0;
    await waitFor(() => !s.rover && !s.system.rovers.size);
    a.close();
    b.close();
    await waitFor(() => game.sessions.size === 0);
  });

  it('drills a deposit only from a stopped rover, fills the bed and unloads it into the hold with the rover', async () => {
    const a = new Bot(url, 'Prospector');
    await a.connect();
    const s = sessionOf(a);
    a.ws.send(encodeJson(MSG.CHAT, { text: '/land 0 day' }));
    await waitFor(() => s.ship.state.landed === 1);
    a.action({ a: 'exit' });
    await waitFor(() => s.mode === MODE.FOOT && !!s.char);
    const pl = s.system.def.planets[0];
    const dp = depositsNear(pl, vnorm(v3(), s.char!.state.p), 8000)[0];
    expect(dp).toBeTruthy();
    // on foot the drill is out of reach
    a.action({ a: 'drill', id: dp.id });
    await waitFor(() => a.events.some((e) => e.t === 'msg' && /ровера/.test(e.text)));
    a.ws.send(encodeJson(MSG.CHAT, { text: '/deposit' }));
    await waitFor(() => s.mode === MODE.ROVER && a.snap?.self.mode === MODE.ROVER);
    const rover = s.rover!;
    const target = depositsNear(pl, vnorm(v3(), rover.state.p), 100).sort((x, y) => vdist(depositPos(pl, x), rover.state.p) - vdist(depositPos(pl, y), rover.state.p))[0];
    expect(vdist(depositPos(pl, target), rover.state.p)).toBeLessThan(16);
    // too far: drive up to it first (place the rover beside it)
    a.action({ a: 'drill', id: target.id });
    await waitFor(() => a.events.some((e) => e.t === 'msg' && /ближе/.test(e.text)));
    const up = vnorm(v3(), depositPos(pl, target));
    const side = vnorm(v3(), vcross(v3(), up, v3(0, 1, 0)));
    const at = v3(depositPos(pl, target).x + side.x * 5, depositPos(pl, target).y + side.y * 5, depositPos(pl, target).z + side.z * 5);
    const g = pl.radius + roverGround(pl, ...(Object.values(vnorm(v3(), at)) as [number, number, number])) + 0.9;
    copyRover(rover.state, newRover(vscale(v3(), vnorm(v3(), at), g), qlook(quat(), side, vnorm(v3(), at))));
    await new Promise((r) => setTimeout(r, 400));
    // moving the rover stops the drill
    a.action({ a: 'drill', id: target.id });
    await waitFor(() => a.events.some((e) => e.t === 'drill' && e.left > 0));
    rover.state.v = vscale(v3(), side, 4);
    await waitFor(() => a.events.some((e) => e.t === 'drill' && e.left === -1));
    expect(s.drill).toBeNull();
    rover.state.v = v3();
    await new Promise((r) => setTimeout(r, 300));
    // standing still it drills through and the haul lands in the bed
    a.events.length = 0;
    a.action({ a: 'drill', id: target.id });
    await waitFor(() => !!s.drill);
    s.drill!.until = s.system.time + 0.2;
    await waitFor(() => a.events.some((e) => e.t === 'drill' && e.left === 0), 3000);
    const want = Object.values(target.yield).reduce((n, x) => n + (x ?? 0), 0);
    expect(cargoCount(s.pilot.roverBed)).toBe(want);
    expect(a.events.some((e) => e.t === 'harvest' && e.node === target.id)).toBe(true);
    // drilled out: no second haul
    a.action({ a: 'drill', id: target.id });
    await waitFor(() => a.events.some((e) => e.t === 'msg' && /выработана/.test(e.text)));
    // back at the ship the haul goes into the hold with the rover
    const hold0 = cargoCount(s.pilot.cargo), cap = s.pilotInfo().cargoCap;
    a.action({ a: 'leave' });
    await waitFor(() => s.mode === MODE.FOOT);
    rover.state.p = { ...s.ship.state.p };
    s.char!.state.p = { ...s.ship.state.p };
    a.action({ a: 'rover' });
    await waitFor(() => !s.rover);
    expect(cargoCount(s.pilot.cargo)).toBe(Math.min(hold0 + want, cap));
    expect(cargoCount(s.pilot.roverBed)).toBe(Math.max(0, hold0 + want - cap));
    a.close();
    await waitFor(() => game.sessions.size === 0);
    expect(cargoCount(store.find('Prospector')!.roverBed) + cargoCount(store.find('Prospector')!.cargo)).toBe(hold0 + want);
  });

  it('pirates hunt players outside the safe zone', async () => {
    const d = new Bot(url, 'Bait');
    await d.connect();
    const s = sessionOf(d);
    const sys = s.system;
    const pir = [...sys.ships.values()].find((x) => x.npc)!;
    s.ship.state.p = v3(pir.state.p.x + 900, pir.state.p.y, pir.state.p.z);
    s.resync();
    const hp0 = s.ship.hull + s.ship.shield;
    for (let i = 0; i < 400 && s.ship.hull + s.ship.shield >= hp0; i++) {
      d.input();
      await new Promise((r) => setTimeout(r, 33));
    }
    expect(s.ship.hull + s.ship.shield).toBeLessThan(hp0);
    const pirate = [...sys.ships.values()].find((x) => x.npc && x.npc.target === s.ship.id);
    expect(pirate).toBeTruthy();
    const f = qrot(v3(), pirate!.state.q, FWD);
    expect(f).toBeTruthy();
    d.close();
  }, 20000);
});
