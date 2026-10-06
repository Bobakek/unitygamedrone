import { MAX_NAME, PROTOCOL_VERSION, SYSTEM_COUNT, TICK_RATE } from '../../shared/constants.ts';
import { HULL_KEYS, isHull } from '../../shared/ships/hulls.ts';
import { qlook, qrot, quat, v3, vdist, vnorm, vscale, vsub } from '../../shared/math/vec.ts';
import { planetSites, siteDir } from '../../shared/planet/sites.ts';
import { RAMP, TERMINALS } from '../../shared/station/deck.ts';
import { footHeight } from '../../shared/planet/terrain.ts';
import {
  decodeInput, decodeJson, encodeJson, encodeShots, encodeSnapshot, MODE, MSG, type Action, type Welcome,
} from '../../shared/net/protocol.ts';
import type { PilotStorage } from '../storage.ts';
import { SPECIES } from '../../shared/fauna.ts';
import { item } from '../../shared/outfit.ts';
import { WEATHER, type WeatherKind } from '../../shared/weather.ts';
import { boardEpoch, CONTRACT_KINDS, FACTIONS, newCareer, rankOf, RANKS, type ContractKind, type Faction } from '../../shared/contracts.ts';
import { Session, type Transport } from './session.ts';
import { SystemInstance, type GameContext } from './system.ts';
import { Groups } from './groups.ts';
import { marketQuote, type MarketQuote } from '../../shared/market.ts';
import type { V3 } from '../../shared/math/vec.ts';

export interface GameOptions {
  store: PilotStorage;
  dev?: boolean;
  respawnDelay?: number;
  log?: (msg: string) => void;
  /** Wall clock in ms (tests move it to change the contract board). */
  now?: () => number;
}

export interface Connection {
  onMessage(data: Uint8Array): void;
  onClose(): void;
}

/** Seconds an empty system keeps running (lets pirates and events settle) before it sleeps. */
const SLEEP_AFTER = 120;
const NAME_RE = /^[\p{L}\p{N}_\- ]+$/u;
const MOTD = 'Добро пожаловать в Nova Frontier! Нажмите H — управление.';

export class Game implements GameContext {
  time = 0;
  tick = 0;
  respawnDelay: number;
  readonly dev: boolean;
  /** Star systems, created when a pilot first comes there. */
  private instances = new Map<number, SystemInstance>();
  /** Server time each system last had a pilot in it (empty ones fall asleep). */
  private busyAt = new Map<number, number>();
  readonly sessions = new Map<number, Session>();
  private ids = 1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private store: PilotStorage;
  private log: (m: string) => void;
  readonly now: () => number;
  readonly groups = new Groups(this);

  constructor(opts: GameOptions) {
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
    this.dev = !!opts.dev;
    this.respawnDelay = opts.respawnDelay ?? 5;
    this.log = opts.log ?? (() => {});
    this.system(0);
  }

  /** The instance of a system (created on first use). */
  system(id: number): SystemInstance {
    let sys = this.instances.get(id);
    if (!sys) {
      sys = new SystemInstance(this, id);
      this.instances.set(id, sys);
      this.busyAt.set(id, this.time);
    }
    return sys;
  }

  /** Systems that have been visited since the server started. */
  get systems(): SystemInstance[] {
    return [...this.instances.values()];
  }

  /** A system with nobody in it for a while is not simulated (it wakes when a pilot arrives). */
  asleep(sys: SystemInstance): boolean {
    return !sys.sessions.size && this.time - (this.busyAt.get(sys.def.id) ?? 0) > SLEEP_AFTER;
  }

  nextId() {
    return this.ids++;
  }

  convoyAlive(system: number, poi: number) {
    const p = this.instances.get(system)?.world.pois.get(poi);
    return !!p && p.kind === 'convoy' && !!p.ship;
  }

  quotes(systems: number[]): MarketQuote[] {
    // a system without a running instance has seen no trade: its plain prices
    return systems.filter((i) => i >= 0 && i < SYSTEM_COUNT)
      .map((i) => this.systems.find((x) => x.def.id === i)?.market.quote() ?? marketQuote(i, boardEpoch(this.now())));
  }

  crew(s: Session, at: V3, range: number): Session[] {
    return this.groups.crew(s, at, range);
  }

  allies(a: Session, b: Session): boolean {
    return this.groups.allies(a, b);
  }

  private byName(name: string): Session | undefined {
    const n = name.trim().toLowerCase();
    for (const o of this.sessions.values()) if (o.pilot.name.toLowerCase() === n) return o;
    return undefined;
  }

  /** The pilot whose ship or pilot entity this is (in the inviter's system). */
  private byEntity(s: Session, id: number): Session | undefined {
    for (const o of s.system.sessions) if (o.ship.id === id || o.char?.id === id) return o;
    return undefined;
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
    const sys = this.system(Math.max(0, Math.min(SYSTEM_COUNT - 1, pilot.system | 0)));
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
    const ov = s.system.weather.activeOverrides();
    if (ov.length) s.sendJson(MSG.EVENTS, { ev: ov.map((o) => ({ t: 'weather', ...o })) });
  }

  private disconnect(s: Session) {
    if (s.closed) return;
    s.closed = true;
    s.system.removeSession(s);
    this.sessions.delete(s.id);
    this.groups.drop(s);
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
        const err = act.a.startsWith('group') ? this.groupAction(s, act) : s.system.handleAction(s, act);
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

  private groupAction(s: Session, act: Action): string | null {
    switch (act.a) {
      case 'groupInvite': return this.groups.invite(s, act.entity ? this.byEntity(s, Number(act.entity)) : this.byName(String(act.name ?? '')));
      case 'groupAnswer': return this.groups.answer(s, !!act.yes);
      case 'groupLeave': return this.groups.leave(s);
      case 'groupKick': return this.groups.kick(s, String(act.name ?? ''));
    }
    return null;
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
    const say = (err: string | null) => { if (err) s.msg(err, 'warn'); };
    switch (cmd) {
      case 'invite': say(this.groups.invite(s, this.byName(args.join(' ')))); return;
      case 'accept': say(this.groups.answer(s, true)); return;
      case 'decline': say(this.groups.answer(s, false)); return;
      case 'leave': say(this.groups.leave(s)); return;
      case 'kick': say(this.groups.kick(s, args.join(' '))); return;
      case 'group': s.msg(this.groups.list(s)); return;
      case 'g': case 'p': { const t = args.join(' ').trim(); if (t) this.groups.say(s, t); return; }
      case 'help':
        s.msg('Команды: /who, /help, группа: /invite <имя>, /accept, /decline, /leave, /kick <имя>, /group, /g <текст>' + (this.dev ? ' | dev: /tp <n|lowN|ruinN|baseN|wreckN|station|dock|field|rock|gate|open> [dusk|night], /land <n> [day|dusk|night], /event <convoy|wreck|anomaly>, /fauna <0-12>, /weather <вид|clear> [сила], /strike [1], /rover, /inside <hold|bridge|quarters|rad>, /deck <trade|upgrades|contracts|wardrobe|window|ramp>, /credits <n>, /god, /pirate, /system <n>, /wear <id>, /rep <fed|guild|pirate> <n>, /xp <n>, /contract <вид>, /finish, /cargo <вид> <n>, /ship <fighter|hauler|miner>' : ''));
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
      case 'wear': {
        // dev: grant and wear a suit part anywhere
        const it = item(args[0] ?? '');
        if (!it) { s.msg('/wear <id> — см. src/shared/outfit.ts', 'warn'); break; }
        if (!s.pilot.items.includes(it.id) && it.price) s.pilot.items.push(it.id);
        s.pilot.outfit[it.slot] = it.id;
        s.sendPilot();
        s.msg(`Надето: ${it.name}`);
        break;
      }
      case 'rep': {
        const f = args[0] as Faction;
        if (!FACTIONS.includes(f)) { s.msg('/rep fed|guild|pirate <значение -100..100>', 'warn'); break; }
        sys.contracts.rep(s, f, (Number(args[1]) || 0) - s.pilot.career.rep[f]);
        s.sendPilot();
        s.msg(`Репутация (${f}): ${s.pilot.career.rep[f]}`);
        break;
      }
      case 'xp': s.pilot.career.xp = Math.max(0, Number(args[0]) || 0); s.sendPilot(); s.msg(`Звание: ${RANKS[rankOf(s.pilot.career.xp)].name}`); break;
      case 'career': s.pilot.career = newCareer(); s.sendPilot(); s.msg('Карьера сброшена'); break;
      case 'contract': {
        // dev: take an offer of a kind from the current board anywhere, ignoring rank
        const kind = args[0] as ContractKind;
        const def = sys.contracts.board().offers.find((o) => o.kind === kind && !s.pilot.career.active.some((a) => a.id === o.id));
        if (!CONTRACT_KINDS.includes(kind) || !def) { s.msg(`Нет такого предложения. Виды: ${CONTRACT_KINDS.join(', ')}`, 'warn'); break; }
        s.pilot.career.active.push({ ...structuredClone(def), have: 0 });
        s.sendPilot();
        s.msg(`Контракт выдан: ${def.title}`);
        break;
      }
      case 'finish': {
        const c = s.pilot.career.active[0];
        if (!c) { s.msg('Нет активных контрактов', 'warn'); break; }
        sys.contracts.devFinish(s, c);
        break;
      }
      case 'ship': {
        // dev: grant a ship class and fly it at once, anywhere
        const k = args[0];
        if (!isHull(k)) { s.msg(`/ship ${HULL_KEYS.join('|')}`, 'warn'); break; }
        if (!s.pilot.ships.includes(k)) s.pilot.ships.push(k);
        const err = sys.setShip(s, k);
        if (err) s.msg(err, 'warn');
        break;
      }
      case 'cargo': {
        const k = args[0] as keyof typeof s.pilot.cargo;
        if (!(k in s.pilot.cargo)) { s.msg('/cargo ore|crystal|relic|bio <n>', 'warn'); break; }
        s.pilot.cargo[k] += Number(args[1]) || 1;
        s.sendPilot();
        break;
      }
      case 'weather': {
        // dev: force the weather on the planet the pilot is on (or nearest to)
        const kind = (args[0] ?? 'clear') as WeatherKind;
        if (kind !== 'clear' && !(kind in WEATHER)) { s.msg(`/weather clear|${Object.keys(WEATHER).join('|')} [сила 0..1] [секунд]`, 'warn'); break; }
        const planet = s.char ? s.char.planet : s.ship.state.frame ? s.ship.state.frame - 1 : -1;
        if (planet < 0) { s.msg('Нужно быть у планеты', 'warn'); break; }
        sys.weather.override(planet, kind, args[1] ? Number(args[1]) : 1, args[2] ? Number(args[2]) : 600);
        s.msg(`Погода: ${kind === 'clear' ? 'ясно' : WEATHER[kind].name}`);
        break;
      }
      case 'deck': {
        // dev: on the station deck, step next to a terminal (or the ramp)
        const ch = s.char;
        if (!ch || ch.planet >= 0) { s.msg('Сначала выйдите на станцию', 'warn'); break; }
        // a terminal, the promenade's window on the planet, or the ramp
        const t = TERMINALS.find((x) => x.kind === args[0]);
        const to = t ? { x: t.x + (t.x < 0 ? 1.8 : -1.8), z: t.z } : args[0] === 'window' ? { x: 4, z: 4 } : RAMP;
        ch.state.p = v3(to.x, 0, to.z);
        ch.state.v = v3();
        if (t) ch.state.f = vnorm(v3(), v3(t.x - to.x, 0, 0));
        else if (args[0] === 'window') ch.state.f = v3(0, 0, 1);
        s.resync();
        break;
      }
      case 'inside': {
        // dev: put the pilot on foot inside the nearest wreck (hold | bridge | quarters | rad)
        const ch = s.char;
        if (!ch || ch.planet < 0) { s.msg('Выйдите из корабля', 'warn'); break; }
        const pl = sys.def.planets[ch.planet];
        const site = planetSites(pl).filter((x) => x.kind === 'wreck')
          .sort((a, b) => vdist(ch.state.p, vscale(v3(), b.dir, pl.radius)) - vdist(ch.state.p, vscale(v3(), a.dir, pl.radius))).pop();
        const zone = site?.zones?.find((z) => z.kind === (args[0] ?? 'hold'));
        if (!site || !zone) { s.msg('Рядом нет обломков', 'warn'); break; }
        const x = args[0] === 'bridge' ? site.goal.x - 2 : (zone.x0 + zone.x1) / 2, z = (zone.z0 + zone.z1) / 2 + (zone.kind === 'hold' ? 0 : 0.5);
        const d = siteDir(pl, site, x, z);
        ch.state.p = vscale(v3(), d, pl.radius + footHeight(pl, d.x, d.y, d.z) + 0.05);
        ch.state.v = v3();
        const e = siteDir(pl, site, x + 5, z);
        const f = vsub(v3(), e, d);
        const fu = f.x * d.x + f.y * d.y + f.z * d.z;
        ch.state.f = vnorm(v3(), v3(f.x - d.x * fu, f.y - d.y * fu, f.z - d.z * fu));
        s.resync();
        break;
      }
      case 'rover': s.msg(sys.devRover(s) ?? 'За рулём'); break;
      case 'strike': {
        if (!s.char || s.char.planet < 0) { s.msg('Выйдите из корабля', 'warn'); break; }
        const p = s.char.state.p, d = Number(args[0]) || 0;
        sys.weather.strike(s.char.planet, s, d ? undefined : { ...p });
        break;
      }
      case 'fauna': {
        if (!s.char || s.char.planet < 0) { s.msg('Выйдите из корабля', 'warn'); break; }
        const n = sys.fauna.devSpawn(s.char.planet, s.char.state.p, Math.max(0, Math.min(SPECIES.length - 1, Number(args[0]) || 0)), Number(args[1]) || 40).length;
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
    const to = this.system(target);
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
    for (const sys of this.instances.values()) {
      if (sys.sessions.size) this.busyAt.set(sys.def.id, this.time);
      if (!this.asleep(sys)) sys.step();
    }
    for (const sys of this.instances.values()) this.flush(sys);
    if (this.tick % TICK_RATE === 0) this.groups.step();
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
