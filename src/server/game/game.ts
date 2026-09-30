import { MAX_NAME, PROTOCOL_VERSION, SYSTEM_COUNT, TICK_RATE } from '../../shared/constants.ts';
import { qlook, qrot, quat, v3, vdist, vnorm, vsub } from '../../shared/math/vec.ts';
import {
  decodeInput, decodeJson, encodeJson, encodeShots, encodeSnapshot, MODE, MSG, type Action, type Welcome,
} from '../../shared/net/protocol.ts';
import type { PilotStorage } from '../storage.ts';
import { Session, type Transport } from './session.ts';
import { SystemInstance, type GameContext } from './system.ts';

export interface GameOptions {
  store: PilotStorage;
  dev?: boolean;
  respawnDelay?: number;
  log?: (msg: string) => void;
}

export interface Connection {
  onMessage(data: Uint8Array): void;
  onClose(): void;
}

const NAME_RE = /^[\p{L}\p{N}_\- ]+$/u;
const MOTD = 'Добро пожаловать в Nova Frontier! Нажмите H — управление.';

export class Game implements GameContext {
  time = 0;
  tick = 0;
  respawnDelay: number;
  readonly dev: boolean;
  readonly systems: SystemInstance[];
  readonly sessions = new Map<number, Session>();
  private ids = 1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private store: PilotStorage;
  private log: (m: string) => void;

  constructor(opts: GameOptions) {
    this.store = opts.store;
    this.dev = !!opts.dev;
    this.respawnDelay = opts.respawnDelay ?? 5;
    this.log = opts.log ?? (() => {});
    this.systems = Array.from({ length: SYSTEM_COUNT }, (_, i) => new SystemInstance(this, i));
  }

  nextId() {
    return this.ids++;
  }

  // ------------------------------------------------------------------ connections
  connect(transport: Transport): Connection {
    let session: Session | null = null;
    let msgCount = 0, windowStart = Date.now();
    const helloTimer = setTimeout(() => { if (!session) transport.close(4000, 'hello timeout'); }, 15000);
    return {
      onMessage: (data) => {
        const now = Date.now();
        if (now - windowStart > 1000) { windowStart = now; msgCount = 0; }
        if (++msgCount > 200) { transport.close(4008, 'rate limit'); return; }
        if (!data.length) return;
        try {
          if (!session) {
            if (data[0] === MSG.HELLO) {
              session = this.login(transport, decodeJson(data));
              if (session) clearTimeout(helloTimer);
            }
            return;
          }
          this.dispatch(session, data);
        } catch (e) {
          this.log(`bad message: ${(e as Error).message}`);
        }
      },
      onClose: () => {
        clearTimeout(helloTimer);
        if (session) this.disconnect(session);
      },
    };
  }

  private login(t: Transport, hello: { v?: number; name?: string; token?: string }): Session | null {
    const fail = (message: string) => { t.send(encodeJson(MSG.ERROR, { message })); t.close(4001, 'login failed'); return null; };
    if (hello.v !== PROTOCOL_VERSION) return fail('Версия клиента устарела — обновите страницу');
    const name = String(hello.name ?? '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > MAX_NAME || !NAME_RE.test(name)) return fail('Имя: 2–16 символов, буквы, цифры, _ и -');
    let pilot = this.store.find(name);
    if (pilot && pilot.token !== hello.token) return fail('Это имя уже занято другим пилотом');
    if (!pilot) pilot = this.store.create(name);
    for (const old of this.sessions.values()) {
      if (old.pilot.id === pilot.id) {
        old.msg('Вход с другого устройства', 'warn');
        old.transport.close(4002, 'replaced');
        this.disconnect(old);
      }
    }
    const sys = this.systems[Math.max(0, Math.min(SYSTEM_COUNT - 1, pilot.system | 0))];
    const sp = sys.spawnPoint();
    const ship = sys.createPlayerShip(pilot, sp.p, sp.q);
    const s = new Session(this.nextId(), t, pilot, sys, ship);
    s.lastSave = this.time;
    this.sessions.set(s.id, s);
    sys.addSession(s, sp);
    this.sendWelcome(s);
    this.log(`+ ${pilot.name} (${this.sessions.size} online)`);
    this.broadcastSystem(sys, { t: 'msg', text: `${pilot.name} в системе`, kind: 'info' }, s);
    return s;
  }

  private sendWelcome(s: Session) {
    const w: Welcome = {
      playerId: s.id, shipId: s.ship.id, token: s.pilot.token, pilot: s.pilotInfo(), system: s.system.def.id,
      dev: this.dev, tick: this.tick, time: this.time, harvested: s.system.harvestedList(), motd: MOTD,
    };
    s.sendJson(MSG.WELCOME, w);
    s.sendJson(MSG.INFO, { list: s.system.allInfos() });
    s.sendJson(MSG.WORLD, { pois: s.system.world.list() });
  }

  private disconnect(s: Session) {
    if (s.closed) return;
    s.closed = true;
    s.system.removeSession(s);
    this.sessions.delete(s.id);
    this.store.save(s.pilot);
    this.log(`- ${s.pilot.name} (${this.sessions.size} online)`);
  }

  private broadcastSystem(sys: SystemInstance, ev: object, except?: Session) {
    const data = encodeJson(MSG.EVENTS, { ev: [ev] });
    for (const o of sys.sessions) if (o !== except) o.send(data);
  }

  private dispatch(s: Session, data: Uint8Array) {
    switch (data[0]) {
      case MSG.INPUT: {
        const m = decodeInput(data);
        if (s.inputs.length > 45) s.inputs.shift();
        s.inputs.push(m);
        break;
      }
      case MSG.ACTION: {
        const act = decodeJson<Action>(data);
        if (act.a === 'jump') { this.jump(s); break; }
        const err = s.system.handleAction(s, act);
        if (err) s.msg(err, 'warn');
        break;
      }
      case MSG.CHAT:
        this.chat(s, String(decodeJson<{ text: string }>(data).text ?? ''));
        break;
      case MSG.PING:
        s.sendJson(MSG.PONG, { c: decodeJson<{ c: number }>(data).c, t: this.time });
        break;
    }
  }

  private chat(s: Session, raw: string) {
    const text = raw.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200);
    if (!text) return;
    const now = Date.now();
    s.chatTimes = s.chatTimes.filter((t) => now - t < 10000);
    if (s.chatTimes.length >= 6) { s.msg('Слишком много сообщений', 'warn'); return; }
    s.chatTimes.push(now);
    if (text.startsWith('/')) { this.command(s, text); return; }
    const data = encodeJson(MSG.EVENTS, { ev: [{ t: 'chat', from: s.pilot.name, text }] });
    for (const o of this.sessions.values()) o.send(data);
  }

  private command(s: Session, text: string) {
    const [cmd, ...args] = text.slice(1).split(/\s+/);
    const sys = s.system;
    switch (cmd) {
      case 'help':
        s.msg('Команды: /who, /help' + (this.dev ? ' | dev: /tp <n|lowN|ruinN|baseN|station|dock|field|gate|open> [dusk|night], /land <n> [dusk|night], /event <convoy|wreck|anomaly>, /fauna <0-7>, /credits <n>, /god, /pirate, /system <n>' : ''));
        return;
      case 'who':
        s.msg(`Онлайн (${this.sessions.size}): ${[...this.sessions.values()].map((o) => o.pilot.name).join(', ')}`);
        return;
    }
    if (!this.dev) { s.msg('Неизвестная команда', 'warn'); return; }
    switch (cmd) {
      case 'tp': s.msg(sys.devTeleport(s, args[0] ?? 'station', args[1])); break;
      case 'land': s.msg(sys.devTeleport(s, `land${args[0] ?? '0'}`, args[1])); break;
      case 'credits': s.pilot.credits += Number(args[0]) || 1000; s.sendPilot(); break;
      case 'god': s.ship.god = !s.ship.god; s.msg(`Бессмертие: ${s.ship.god ? 'вкл' : 'выкл'}`); break;
      case 'pirate': {
        const w = s.ship.world;
        const d = qrot(v3(), w.q, v3(0, 0, -900));
        sys.spawnPirate({ x: w.p.x + d.x, y: w.p.y + d.y, z: w.p.z + d.z });
        break;
      }
      case 'system': this.transfer(s, Number(args[0]) || 0); break;
      case 'fauna': {
        if (!s.char) { s.msg('Выйдите из корабля', 'warn'); break; }
        const n = sys.fauna.devSpawn(s.char.planet, s.char.state.p, Math.max(0, Math.min(7, Number(args[0]) || 0)), Number(args[1]) || 40).length;
        s.msg(n ? `Появилось существ: ${n}` : 'Не удалось');
        break;
      }
      case 'event': {
        const kind = args[0] as 'convoy' | 'wreck' | 'anomaly';
        if (!['convoy', 'wreck', 'anomaly'].includes(kind)) { s.msg('/event convoy|wreck|anomaly', 'warn'); break; }
        s.msg(sys.world.devSpawn(kind, s.ship));
        break;
      }
      default: s.msg('Неизвестная команда', 'warn');
    }
  }

  private jump(s: Session) {
    if (s.mode !== MODE.SHIP) return;
    const gate = s.system.gateInRange(s.ship.world.p);
    if (!gate) { s.msg('Подлетите ближе к вратам', 'warn'); return; }
    this.transfer(s, gate.target);
  }

  transfer(s: Session, target: number) {
    if (target < 0 || target >= SYSTEM_COUNT || target === s.system.def.id) return;
    const from = s.system.def.id;
    s.system.removeSession(s);
    const to = this.systems[target];
    const gate = to.def.gates.find((g) => g.target === from) ?? to.def.gates[0];
    const away = vnorm(v3(), vsub(v3(), to.def.station.pos, gate.pos));
    const p = v3(gate.pos.x + away.x * 600, gate.pos.y + away.y * 600, gate.pos.z + away.z * 600);
    s.ship.state.v = v3();
    to.addSession(s, { p, q: qlook(quat(), away, v3(0, 1, 0)) });
    s.resync();
    this.sendWelcome(s);
    this.store.save(s.pilot);
  }

  // ------------------------------------------------------------------ loop
  step() {
    this.tick++;
    this.time = this.tick / TICK_RATE;
    for (const sys of this.systems) sys.step();
    for (const sys of this.systems) this.flush(sys);
    for (const s of this.sessions.values()) {
      if (this.time - s.lastSave > 30) { s.lastSave = this.time; this.store.save(s.pilot); }
    }
  }

  private flush(sys: SystemInstance) {
    const infos = sys.infos.length ? encodeJson(MSG.INFO, { list: sys.infos }) : null;
    const gone = sys.gone.length ? encodeJson(MSG.GONE, { ids: sys.gone }) : null;
    const events = sys.events.length ? encodeJson(MSG.EVENTS, { ev: sys.events }) : null;
    const world = sys.world.dirty ? encodeJson(MSG.WORLD, { pois: sys.world.list() }) : null;
    sys.world.dirty = false;
    for (const s of sys.sessions) {
      if (infos) s.send(infos);
      if (gone) s.send(gone);
      if (events) s.send(events);
      if (world) s.send(world);
      if (sys.shots.length) {
        const focus = sys.focusOf(s);
        const near = sys.shots.filter((sh) => sh.shooter !== s.ship.id && sh.shooter !== s.char?.id && vdist({ x: sh.px, y: sh.py, z: sh.pz }, focus) < 8000);
        if (near.length) s.send(encodeShots(near));
      }
      if (s.transport.buffered < 1 << 20) s.send(encodeSnapshot(sys.buildSnapshot(s)));
    }
    sys.infos.length = 0;
    sys.gone.length = 0;
    sys.events.length = 0;
    sys.shots.length = 0;
  }

  start() {
    const period = 1000 / TICK_RATE;
    let next = performance.now();
    const loop = () => {
      const now = performance.now();
      let n = 0;
      while (now >= next && n < 5) {
        this.step();
        next += period;
        n++;
      }
      if (now - next > 1000) next = now;
      this.timer = setTimeout(loop, Math.max(0, next - performance.now()));
    };
    loop();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const s of this.sessions.values()) this.store.save(s.pilot);
  }
}
