import { DT, TICK_RATE } from '../../shared/constants.ts';
import { ARENA, arenaLayout, spawnSlot, TEAM_COLORS, TEAM_NAMES, type ArenaLayout, type ArenaMsg, type ArenaPhase, type ArenaPlayer } from '../../shared/arena.ts';
import { combatStats, flightStats, type Upgrades } from '../../shared/economy.ts';
import { makeName } from '../../shared/galaxy/names.ts';
import { hashInts, Rng } from '../../shared/math/rng.ts';
import { FWD, qlook, qrot, quat, v3, vdist, vnorm, vsub, type V3 } from '../../shared/math/vec.ts';
import { MODE, MSG, type Action, type GameEvent } from '../../shared/net/protocol.ts';
import { newPose } from '../../shared/sim/frames.ts';
import { emptyInput, newShip, stepShip, type ShipInput, type StepOut } from '../../shared/sim/ship.ts';
import { LASER, leadPoint, segmentSphere } from '../../shared/sim/weapons.ts';
import { playerBlueprint } from '../../shared/ships/blueprint.ts';
import { steer } from './npc.ts';
import type { ShipEntity } from './entities.ts';
import type { Session } from './session.ts';
import { SystemInstance, type GameContext } from './system.ts';

/** What the arena needs from the game: systems to send pilots back to, and the welcome message. */
export interface ArenaHost extends GameContext {
  system(id: number): SystemInstance;
  sendWelcome(s: Session): void;
}

interface Seat {
  ship: ShipEntity;
  team: 0 | 1;
  slot: number;
  kills: number;
  deaths: number;
  session: Session | null;
  /** Players: the system they came from and their hull share before the match. */
  back: number;
  wear: number;
  /** Players: told they are outside the field. */
  warned?: boolean;
}

/** Bots fly a fighter with these upgrades. */
const BOT_UPGRADES: Upgrades = { weapons: 2, shields: 2, hull: 2, engine: 2, cargo: 1 };

interface BotBrain {
  target: number;
  rethink: number;
  /** Breaking off after a close pass, swerving around a rock. */
  jink: number;
  evade: number;
  evadeDir: V3;
  /** Aim error (metres per kilometre of range), re-rolled every few seconds. */
  err: V3;
  errT: number;
  phase: number;
}

const stepOut: StepOut = { impact: 0 };
const tmp = v3(), aim = v3(), fwd = v3();

/** One arena match: its own instance in the empty space of a system, teams of three, bots in the empty seats. */
export class ArenaInstance extends SystemInstance {
  readonly layout: ArenaLayout;
  phase: ArenaPhase = 'warmup';
  until = 0;
  round = 1;
  score: [number, number] = [0, 0];
  rounds: [number, number] = [0, 0];
  winner = -1;
  overtime = false;
  /** Ship id → seat. */
  readonly seats = new Map<number, Seat>();
  private bots = new Map<number, BotBrain>();
  private brng: Rng;
  /** Releasing everyone at the end: leaving players are not replaced by bots. */
  closing = false;

  constructor(host: ArenaHost, system: number, readonly match: number, private desk: ArenaDesk) {
    super(host, system, true);
    this.layout = arenaLayout(this.def, match);
    this.env.fields.push(this.layout.field);
    this.brng = new Rng(hashInts(this.def.seed, match, 0xb07));
    this.until = this.time + ARENA.warmup;
  }

  // ------------------------------------------------------------------ seats
  /** Puts a pilot into a seat of the match. */
  seatPlayer(s: Session, team: 0 | 1, slot: number) {
    const back = s.system.def.id;
    const wear = s.ship.hull / s.ship.combat.maxHull;
    s.system.removeSession(s);
    this.addSession(s);
    s.pilot.system = back;
    const seat: Seat = { ship: s.ship, team, slot, kills: 0, deaths: 0, session: s, back, wear };
    this.seats.set(s.ship.id, seat);
    this.spawn(seat);
  }

  /** A bot in the seat. */
  seatBot(team: 0 | 1, slot: number, kills = 0, deaths = 0) {
    const name = `Бот ${makeName(this.brng)}`;
    const bp = { ...playerBlueprint(name, 'fighter'), hull2: TEAM_COLORS[team], glow: TEAM_COLORS[team] };
    const c = combatStats(BOT_UPGRADES, 'fighter');
    const ship: ShipEntity = {
      id: this.ctx.nextId(), name, bp, state: newShip(v3()), world: newPose(), flight: flightStats(BOT_UPGRADES, 'fighter'), combat: c,
      hull: c.maxHull, shield: c.maxShield, energy: 100, lastHit: -99, fireCooldown: 0, gun: 0,
      throttle: 0, boosting: false, dead: false, respawnAt: 0, docked: false, god: false, session: null, npc: null, lastInput: emptyInput(),
    };
    this.ships.set(ship.id, ship);
    this.infos.push(this.shipInfo(ship));
    const seat: Seat = { ship, team, slot, kills, deaths, session: null, back: -1, wear: 1 };
    this.seats.set(ship.id, seat);
    this.bots.set(ship.id, {
      target: 0, rethink: 0, jink: 0, evade: 0, evadeDir: v3(), err: v3(), errT: 0, phase: this.brng.range(0, 6),
    });
    this.spawn(seat);
  }

  seatOf(s: Session): Seat | undefined {
    return this.seats.get(s.ship.id);
  }

  /** At the team's start point, repaired, facing the centre. */
  private spawn(seat: Seat) {
    const ship = seat.ship;
    const p = spawnSlot(this.layout, seat.team, seat.slot);
    ship.state = newShip(p, qlook(quat(), vnorm(v3(), vsub(v3(), this.layout.center, p)), v3(0, 1, 0)));
    this.syncWorld(ship);
    ship.dead = false;
    ship.hull = ship.combat.maxHull;
    ship.shield = ship.combat.maxShield;
    ship.energy = 100;
    ship.lastHit = -99;
    ship.fireCooldown = 0;
    seat.warned = false;
    if (seat.session) {
      seat.session.mode = MODE.SHIP;
      seat.session.resync();
    }
    this.events.push({ t: 'warp', id: ship.id, pos: [p.x, p.y, p.z], team: seat.team });
  }

  override removeSession(s: Session) {
    super.removeSession(s);
    const seat = this.seats.get(s.ship.id);
    if (!seat) return;
    this.seats.delete(s.ship.id);
    if (this.closing) return;
    // the seat goes on with a bot, so the teams stay three on three
    if (this.sessions.size) {
      this.seatBot(seat.team, seat.slot, seat.kills, seat.deaths);
      this.broadcast({ t: 'msg', text: `${s.pilot.name} покинул арену, место занял бот`, kind: 'info' });
      this.sendState();
    } else this.desk.close(this);
  }

  // ------------------------------------------------------------------ rules
  override tryFire(ship: ShipEntity) {
    if (this.phase === 'fight') super.tryFire(ship);
  }

  override damage(target: ShipEntity, dmg: number, attacker: number, pos?: V3) {
    if (this.phase !== 'fight') return;
    const a = this.seats.get(attacker), b = this.seats.get(target.id);
    if (a && b && a !== b && a.team === b.team) return;
    super.damage(target, attacker ? dmg * ARENA.damage : dmg, attacker, pos);
  }

  override kill(target: ShipEntity, attacker: number) {
    if (target.dead) return;
    target.dead = true;
    target.hull = 0;
    target.respawnAt = this.time + ARENA.respawn;
    const p = target.world.p;
    this.events.push({ t: 'boom', id: target.id, pos: [p.x, p.y, p.z], big: true });
    const vs = this.seats.get(target.id), ks = this.seats.get(attacker);
    this.events.push({ t: 'kill', killer: ks?.ship.name ?? 'Столкновение', victim: target.name });
    if (!vs) return;
    vs.deaths++;
    // a kill by the other team scores for it; a crash or the field's edge, for the enemy all the same
    const scorer: 0 | 1 = ks && ks !== vs && ks.team !== vs.team ? ks.team : vs.team === 0 ? 1 : 0;
    if (ks && ks !== vs && ks.team !== vs.team) ks.kills++;
    this.score[scorer]++;
    if (vs.session) {
      vs.session.mode = MODE.DEAD;
      vs.session.resync();
      vs.session.msg(ks && ks !== vs ? `Вас сбил ${ks.ship.name}. Возврат через ${ARENA.respawn} с` : `Корабль разбит. Возврат через ${ARENA.respawn} с`, 'warn');
    }
    if (ks?.session && ks !== vs) ks.session.msg(`Сбит: ${target.name}`, 'good');
    if (this.phase === 'fight' && (this.score[scorer] >= ARENA.kills || this.overtime)) this.endRound(scorer);
    else this.sendState();
  }

  override respawn(_s: Session) {
    // seats come back on their own (see step)
  }

  override handleAction(s: Session, act: Action): string | null {
    if (act.a === 'missile') return super.handleAction(s, act);
    if (act.a === 'respawn') return null;
    return 'На арене это недоступно. Покинуть арену: /arena';
  }

  override gateInRange() {
    return null;
  }

  protected override coverHit(p0: V3, p1: V3): number {
    let best = -1;
    for (const r of this.layout.field.rocks) {
      const t = segmentSphere(p0, p1, r, r.r);
      if (t >= 0 && (best < 0 || t < best)) best = t;
    }
    return best;
  }

  /** Is the line between two points blocked by a rock? */
  private blocked(a: V3, b: V3): boolean {
    for (const r of this.layout.field.rocks) if (segmentSphere(a, b, r, r.r + 4) >= 0) return true;
    return false;
  }

  private endRound(team: 0 | 1) {
    this.rounds[team]++;
    this.winner = team;
    const done = this.rounds[team] >= ARENA.rounds;
    this.phase = done ? 'over' : 'pause';
    this.until = this.time + (done ? ARENA.over : ARENA.pause);
    const tally = `${this.rounds[0]} : ${this.rounds[1]}`;
    if (done) {
      this.broadcast({ t: 'announce', text: `Победа: ${TEAM_NAMES[team]}`, sub: `Матч окончен, раунды ${tally}`, kind: 'good' });
      this.payOut(team);
    } else this.broadcast({ t: 'announce', text: `Раунд ${this.round}: ${TEAM_NAMES[team]}`, sub: `Счёт по раундам ${tally}`, kind: 'info' });
    this.sendState();
  }

  private startRound() {
    this.round++;
    this.score = [0, 0];
    this.overtime = false;
    this.winner = -1;
    this.phase = 'warmup';
    this.until = this.time + ARENA.warmup;
    this.lasers.length = 0;
    for (const seat of this.seats.values()) this.spawn(seat);
    this.sendState();
  }

  private payOut(win: 0 | 1) {
    for (const seat of this.seats.values()) {
      const s = seat.session;
      if (!s) continue;
      const won = seat.team === win;
      const cr = (won ? ARENA.winCredits : ARENA.loseCredits) + seat.kills * ARENA.killCredits;
      s.pilot.credits += cr;
      s.pilot.career.xp += won ? ARENA.winXp : ARENA.loseXp;
      s.sendPilot();
      s.msg(`${won ? 'Победа' : 'Поражение'} на арене: +${cr} кр (сбито ${seat.kills})`, won ? 'good' : 'info');
    }
  }

  // ------------------------------------------------------------------ tick
  override step() {
    const t = this.time;
    for (const ship of this.ships.values()) this.syncWorld(ship);
    for (const s of this.sessions) this.processInputs(s);
    this.env.time = t;
    for (const [id, b] of this.bots) {
      const ship = this.ships.get(id);
      if (!ship || ship.dead) continue;
      const { input, fire } = this.think(ship, b);
      stepShip(ship.state, input, ship.flight, this.env, DT, stepOut);
      this.syncWorld(ship);
      ship.throttle = input.throttle;
      ship.boosting = input.boost;
      if (stepOut.impact > 40) this.damage(ship, (stepOut.impact - 40) * 1.2, 0);
      ship.fireCooldown -= DT;
      if (fire) this.tryFire(ship);
    }
    this.stepLasers();
    this.stepMissiles();

    for (const seat of this.seats.values()) {
      const ship = seat.ship;
      if (ship.dead) {
        if (this.phase === 'fight' && t >= ship.respawnAt) this.spawn(seat);
        continue;
      }
      ship.energy = Math.min(100, ship.energy + 22 * DT);
      if (t - ship.lastHit > 3) ship.shield = Math.min(ship.combat.maxShield, ship.shield + ship.combat.shieldRegen * DT);
      // the field's edge: the hull burns outside it
      const out = vdist(ship.world.p, this.layout.center) > ARENA.radius;
      if (out && seat.session && !seat.warned) seat.session.msg('Вы за границей арены — корпус горит, возвращайтесь!', 'warn');
      seat.warned = out;
      if (out && this.phase === 'fight') {
        ship.lastHit = t;
        ship.hull -= ARENA.outside * DT;
        if (ship.hull <= 0) this.kill(ship, 0);
      }
    }

    if (this.phase === 'warmup' && t >= this.until) {
      this.phase = 'fight';
      this.until = t + ARENA.roundTime;
      this.broadcast({ t: 'announce', text: `Раунд ${this.round}: бой!`, sub: `До ${ARENA.kills} побед в раунде, матч до ${ARENA.rounds} раундов`, kind: 'warn' });
      this.sendState();
    } else if (this.phase === 'fight' && !this.overtime && t >= this.until) {
      if (this.score[0] !== this.score[1]) this.endRound(this.score[0] > this.score[1] ? 0 : 1);
      else {
        this.overtime = true;
        this.until = 0;
        this.broadcast({ t: 'announce', text: 'Овертайм', sub: 'Ничья по времени: следующая победа решает раунд', kind: 'warn' });
        this.sendState();
      }
    } else if (this.phase === 'pause' && t >= this.until) this.startRound();
    else if (this.phase === 'over' && t >= this.until) this.desk.close(this);
  }

  /** Bot pilot: hunts the nearest enemy with lead aiming, breaks off close, steers round rocks and stays in the field. */
  private think(ship: ShipEntity, b: BotBrain): { input: ShipInput; fire: boolean } {
    const inp = emptyInput();
    const p = ship.world.p;
    const me = this.seats.get(ship.id)!;
    b.rethink -= DT;
    b.errT -= DT;
    if (b.errT <= 0) {
      b.errT = 1.5 + this.brng.float() * 2;
      b.err = v3(this.brng.range(-1, 1) * 5, this.brng.range(-1, 1) * 5, this.brng.range(-1, 1) * 5);
    }
    if (b.rethink <= 0) {
      b.rethink = 0.4;
      let best = 0, bs = Infinity;
      for (const o of this.seats.values()) {
        if (o.team === me.team || o.ship.dead) continue;
        // a pilot who shot at us lately is the first to answer
        const sc = vdist(o.ship.world.p, p) - (o.ship.id === b.target ? 300 : 0);
        if (sc < bs) { bs = sc; best = o.ship.id; }
      }
      b.target = best;
    }
    const center = this.layout.center;
    qrot(fwd, ship.world.q, FWD);
    if (this.phase === 'warmup' || this.phase === 'pause' || this.phase === 'over') {
      // hold position, nose to the centre
      steer(ship, center, inp);
      inp.throttle = 0;
      return { input: inp, fire: false };
    }
    if (vdist(p, center) > ARENA.radius * 0.86) {
      steer(ship, center, inp);
      inp.throttle = 1;
      inp.boost = ship.state.boost > 0.3;
      return { input: inp, fire: false };
    }
    // a rock dead ahead: swerve
    if (b.evade <= 0) {
      const look = 140 + Math.hypot(ship.world.v.x, ship.world.v.y, ship.world.v.z) * 0.9;
      const ahead = v3(p.x + fwd.x * look, p.y + fwd.y * look, p.z + fwd.z * look);
      for (const r of this.layout.field.rocks) {
        if (segmentSphere(p, ahead, r, r.r + ship.flight.radius + 25) < 0) continue;
        const away = vsub(v3(), p, r);
        const along = away.x * fwd.x + away.y * fwd.y + away.z * fwd.z;
        b.evadeDir = vnorm(v3(), v3(away.x - fwd.x * along + 1e-3, away.y - fwd.y * along + 30, away.z - fwd.z * along));
        b.evade = 0.7;
        break;
      }
    }
    if (b.evade > 0) {
      b.evade -= DT;
      aim.x = p.x + fwd.x * 120 + b.evadeDir.x * 200; aim.y = p.y + fwd.y * 120 + b.evadeDir.y * 200; aim.z = p.z + fwd.z * 120 + b.evadeDir.z * 200;
      steer(ship, aim, inp);
      inp.throttle = 0.7;
      return { input: inp, fire: false };
    }
    const target = b.target ? this.ships.get(b.target) : undefined;
    if (!target || target.dead) {
      steer(ship, center, inp);
      inp.throttle = 0.5;
      return { input: inp, fire: false };
    }
    leadPoint(p, ship.world.v, target.world.p, target.world.v, LASER.speed, aim);
    const dist = vdist(target.world.p, p);
    const k = dist / 1000;
    aim.x += b.err.x * k; aim.y += b.err.y * k; aim.z += b.err.z * k;
    if (dist < 240) b.jink = 1.3;
    if (b.jink > 0) {
      b.jink -= DT;
      vsub(tmp, p, target.world.p);
      aim.x = p.x + tmp.x + 350 * Math.sin(b.phase); aim.y = p.y + tmp.y + 250; aim.z = p.z + tmp.z + 350 * Math.cos(b.phase);
      inp.throttle = 1;
      inp.boost = true;
    } else {
      inp.throttle = dist > 900 ? 1 : 0.55;
      inp.boost = dist > 1600 && ship.state.boost > 0.5;
    }
    steer(ship, aim, inp);
    vnorm(tmp, vsub(tmp, aim, p));
    const cos = fwd.x * tmp.x + fwd.y * tmp.y + fwd.z * tmp.z;
    // dodge sideways, harder while under fire
    const hot = this.time - ship.lastHit < 1.5 ? 1 : 0.55;
    inp.strafeX = Math.sin(this.time * 1.4 + b.phase) * hot;
    inp.strafeY = Math.cos(this.time * 0.9 + b.phase) * 0.4 * hot;
    // shoot when the bolts would pass close enough to the lead point to have a chance
    const miss = vdist(aim, p) * Math.sqrt(Math.max(0, 1 - cos * cos));
    const fire = b.jink <= 0 && dist < 1300 && cos > 0 && miss < 22 && !this.blocked(p, target.world.p);
    return { input: inp, fire };
  }

  // ------------------------------------------------------------------ messages
  private broadcast(ev: GameEvent) {
    this.events.push(ev);
  }

  state(s: Session | null): ArenaMsg {
    const players: ArenaPlayer[] = [...this.seats.values()]
      .sort((a, b) => a.team - b.team || a.slot - b.slot)
      .map((x) => ({ ship: x.ship.id, name: x.ship.name, team: x.team, bot: !x.session, kills: x.kills, deaths: x.deaths }));
    return {
      phase: this.phase, until: this.until, match: this.match, system: this.def.id, round: this.round,
      score: [...this.score], rounds: [...this.rounds], players, team: s ? this.seatOf(s)?.team : undefined,
      winner: this.phase === 'pause' || this.phase === 'over' ? this.winner : undefined, overtime: this.overtime || undefined,
    };
  }

  sendState() {
    for (const s of this.sessions) s.sendJson(MSG.ARENA, this.state(s));
  }
}

/** The arena queue and the running matches. */
export class ArenaDesk {
  private queue: { s: Session; at: number }[] = [];
  readonly arenas = new Map<number, ArenaInstance>();
  private matches = 0;

  constructor(private host: ArenaHost) {}

  inArena(s: Session): s is Session & { system: ArenaInstance } {
    return s.system instanceof ArenaInstance;
  }

  queued(s: Session) {
    return this.queue.some((q) => q.s === s);
  }

  /** Signs up a docked pilot; their group mates who are docked too come along onto the same team. */
  join(s: Session): string | null {
    if (this.inArena(s)) return 'Вы уже на арене';
    if (this.queued(s)) return 'Вы уже в очереди на арену';
    if (s.mode !== MODE.DOCKED && s.mode !== MODE.DECK) return 'На арену записываются на станции';
    this.queue.push({ s, at: this.host.time });
    s.msg('Вы записались на арену 3×3. Ждём других пилотов, свободные места займут боты', 'good');
    this.sendQueue();
    return null;
  }

  leave(s: Session): string | null {
    if (this.queued(s)) {
      this.queue = this.queue.filter((q) => q.s !== s);
      s.sendJson(MSG.ARENA, { phase: 'none', until: 0 } satisfies ArenaMsg);
      s.msg('Вы вышли из очереди на арену');
      this.sendQueue();
      return null;
    }
    if (!this.inArena(s)) return 'Вы не на арене';
    this.release(s);
    return null;
  }

  /** A pilot disconnected (their arena seat is handled by the instance itself). */
  drop(s: Session) {
    if (this.queued(s)) { this.queue = this.queue.filter((q) => q.s !== s); this.sendQueue(); }
  }

  private sendQueue() {
    const head = this.queue[0];
    for (const q of this.queue) {
      q.s.sendJson(MSG.ARENA, { phase: 'queue', until: head ? head.at + ARENA.wait : 0, waiting: this.queue.length } satisfies ArenaMsg);
    }
  }

  step() {
    if (this.host.tick % TICK_RATE !== 0) return;
    // pilots who left the station (or the server) drop out of the queue
    const gone = this.queue.filter((q) => q.s.closed || (q.s.mode !== MODE.DOCKED && q.s.mode !== MODE.DECK));
    if (gone.length) {
      this.queue = this.queue.filter((q) => !gone.includes(q));
      for (const g of gone) if (!g.s.closed) { g.s.sendJson(MSG.ARENA, { phase: 'none', until: 0 }); g.s.msg('Очередь на арену отменена: вы покинули станцию', 'warn'); }
      this.sendQueue();
    }
    const head = this.queue[0];
    if (!head) return;
    if (this.queue.length >= ARENA.team * 2 || this.host.time >= head.at + ARENA.wait) this.start(this.queue.splice(0, ARENA.team * 2).map((q) => q.s));
    this.sendQueue();
  }

  /** Splits the pilots into two teams (group mates together) and opens a match; bots fill the rest. */
  start(list: Session[]): ArenaInstance {
    const id = ++this.matches;
    const a = new ArenaInstance(this.host, list[0].system.def.id, id, this);
    this.arenas.set(id, a);
    const clusters: Session[][] = [];
    for (const s of list) {
      const c = clusters.find((x) => x.some((o) => o.group && o.group === s.group));
      if (c) c.push(s); else clusters.push([s]);
    }
    clusters.sort((x, y) => y.length - x.length);
    const teams: Session[][] = [[], []];
    for (const c of clusters) {
      for (const s of c) {
        const pref = teams[0].length <= teams[1].length ? 0 : 1;
        // keep the cluster on the team its first member went to while there is room
        const mate = teams.findIndex((t) => t.some((o) => c.includes(o)));
        const t = mate >= 0 && teams[mate].length < ARENA.team ? mate : teams[pref].length < ARENA.team ? pref : 1 - pref;
        teams[t].push(s);
      }
    }
    teams.forEach((t, team) => t.forEach((s, slot) => a.seatPlayer(s, team as 0 | 1, slot)));
    for (const team of [0, 1] as const) for (let slot = teams[team].length; slot < ARENA.team; slot++) a.seatBot(team, slot);
    for (const s of list) {
      this.host.sendWelcome(s);
      s.sendPilot();
    }
    a.sendState();
    a.events.push({ t: 'announce', text: 'Арена 3×3', sub: `Раунды до ${ARENA.kills} побед, матч до ${ARENA.rounds} раундов. Старт через ${ARENA.warmup} с`, kind: 'info' });
    return a;
  }

  /** Back to the station the pilot came from, docked, with the hull as it was before the match. */
  release(s: Session) {
    const a = s.system;
    if (!(a instanceof ArenaInstance)) return;
    const seat = a.seatOf(s);
    const back = seat?.back ?? s.pilot.system;
    const wear = seat?.wear ?? 1;
    a.removeSession(s);
    const sys = this.host.system(back);
    const st = sys.def.station.pos;
    sys.addSession(s, { p: v3(st.x, st.y + 300, st.z), q: quat() });
    const ship = s.ship;
    ship.docked = true;
    ship.state.v = v3();
    ship.hull = Math.max(1, ship.combat.maxHull * Math.min(1, wear));
    ship.shield = ship.combat.maxShield;
    s.mode = MODE.DOCKED;
    s.resync();
    this.host.sendWelcome(s);
    s.sendJson(MSG.ARENA, { phase: 'none', until: 0 } satisfies ArenaMsg);
    s.sendPilot();
    sys.contracts.sendBoard(s);
    sys.sendMarket(s);
  }

  /** The match is over (or empty): everyone goes back to their station. */
  close(a: ArenaInstance) {
    if (a.closing) return;
    a.closing = true;
    for (const s of [...a.sessions]) this.release(s);
    this.arenas.delete(a.match);
  }
}
