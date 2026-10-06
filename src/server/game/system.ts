import { DOCK_RANGE, DT, EXIT_RANGE, GATE_RANGE, HARVEST_RANGE, INTEREST_RADIUS, NODE_RESPAWN, SAFE_ZONE_RADIUS, SHIP_LAND_HEIGHT } from '../../shared/constants.ts';
import {
  BOUNTY, CARGO_KEYS, combatStats, emptyCargo, flightStats, MAX_LEVEL, MAX_MISSILES, MISSILE_COST, PIRATE_COMBAT, PIRATE_FLIGHT,
  REPAIR_COST_PER_HP, UPGRADE_COST, UPGRADE_KEYS, cargoCount, type UpgradeKey,
} from '../../shared/economy.ts';
import { getSystem, type SystemDef } from '../../shared/galaxy/system-gen.ts';
import { makeName } from '../../shared/galaxy/names.ts';
import { hashInts, Rng } from '../../shared/math/rng.ts';
import {
  FWD, qlook, qrot, quat, v3, vcross, vdist, vdistSq, vdot, vlen, vnorm, vscale, vsub, type Quat, type V3,
} from '../../shared/math/vec.ts';
import {
  aimByte, CFLAG, DECK_FRAME, DECK_PLANET, EFLAG, IFLAG, KIND, MODE, ROVER_SPEED_MAX, steerByte, type Action, type EntityInfo, type EntityState, type GameEvent, type Harvested, type Shot, type Snapshot,
} from '../../shared/net/protocol.ts';
import { nodesNear, resourceNode } from '../../shared/planet/resources.ts';
import { planetSites, SITE_NODE_BASE, siteCache, siteDir, sitesNear, wreckAt, wreckZone } from '../../shared/planet/sites.ts';
import { footHeight, heightAt, liquidOf, surfaceHeight } from '../../shared/planet/terrain.ts';
import { charQuat, climbProgress, copyChar, emptyCharInput, HEAD_UNDER, newChar, stepChar } from '../../shared/sim/character.ts';
import { newRover, rightRover, ROVER, roverGround, roverOverturned, stepRover } from '../../shared/sim/rover.ts';
import type { SimEnv } from '../../shared/sim/env.ts';
import { newPose, planetRot, toBodyDir, toWorldPoint, worldPose } from '../../shared/sim/frames.ts';
import { emptyInput, isCruising, newShip, stepShip, type StepOut } from '../../shared/sim/ship.ts';
import { ENERGY_REGEN, GUN_OFFSETS, LASER, leadPoint, MISSILE, segmentSphere, SHIELD_DELAY } from '../../shared/sim/weapons.ts';
import { pirateBlueprint, playerBlueprint } from '../../shared/ships/blueprint.ts';
import type { PilotRecord } from '../storage.ts';
import type { CharEntity, Laser, Missile, RoverEntity, ShipEntity } from './entities.ts';
import { NpcBrain, npcThink, type NpcWorld } from './npc.ts';
import { WorldEvents } from './world-events.ts';
import { Outposts } from './outposts.ts';
import { Fauna } from './fauna.ts';
import { item, lookCode, owns, repNeedText, repOk, SLOT_NAMES } from '../../shared/outfit.ts';
import { isPirateFriend, isWanted, WANTED_BOUNTY } from '../../shared/contracts.ts';
import { ContractDesk } from './contracts.ts';
import { StationMarket } from './market.ts';
import { GROUP_BONUS, SHARE_RANGE } from './groups.ts';
import type { MarketQuote } from '../../shared/market.ts';
import { BOARD_REACH, inCabin, PAD, RAMP, stepDeck } from '../../shared/station/deck.ts';
import { awardTrophy } from './trophies.ts';
import { WeatherDesk } from './weather.ts';
import type { Weather } from '../../shared/weather.ts';
import type { Session } from './session.ts';

export interface GameContext {
  time: number;
  tick: number;
  respawnDelay: number;
  nextId(): number;
  /** Wall-clock milliseconds (the contract board changes every 10 minutes of real time). */
  now(): number;
  /** Is the convoy event `poi` of system `system` still under way? */
  convoyAlive(system: number, poi: number): boolean;
  /** Current prices at the stations of these systems. */
  quotes(systems: number[]): MarketQuote[];
  /** The pilot and the members of their group in the same system within `range` of `at` (kill credit). */
  crew(s: Session, at: V3, range: number): Session[];
  /** Are the two pilots in one group? */
  allies(a: Session, b: Session): boolean;
}

const tmp = v3(), tmp2 = v3(), aim = v3(), rot = quat();
const stepOut: StepOut = { impact: 0 };
const charWeather: Weather = { kind: 'clear', k: 0, wind: v3() };
const DECK_UP = v3(0, 1, 0);
/** Docked, in the cockpit or walking about the station. */
const atStation = (s: Session) => s.mode === MODE.DOCKED || s.mode === MODE.DECK;
/** Radiation per second in a wreck's reactor room. */
const REACTOR_DOSE = 2.5;
const idleRover = emptyCharInput();

export class SystemInstance implements NpcWorld {
  readonly def: SystemDef;
  readonly env: SimEnv;
  ships = new Map<number, ShipEntity>();
  chars = new Map<number, CharEntity>();
  rovers = new Map<number, RoverEntity>();
  missiles = new Map<number, Missile>();
  lasers: Laser[] = [];
  sessions = new Set<Session>();
  /** `${planet}:${node}` → time when the node becomes available again. */
  harvested = new Map<string, number>();
  shots: Shot[] = [];
  events: GameEvent[] = [];
  infos: EntityInfo[] = [];
  gone: number[] = [];
  private npcRespawn: number[] = [];
  private rng: Rng;
  readonly world: WorldEvents;
  readonly outposts: Outposts;
  readonly fauna: Fauna;
  readonly contracts: ContractDesk;
  readonly market: StationMarket;
  readonly weather: WeatherDesk;

  constructor(private ctx: GameContext, id: number) {
    this.def = getSystem(id);
    this.env = { star: this.def.star, planets: this.def.planets, fields: this.def.fields, station: this.def.station, time: 0 };
    this.rng = new Rng(hashInts(this.def.seed, 0xabc));
    for (let i = 0; i < this.def.pirates; i++) this.spawnPirate();
    this.world = new WorldEvents(this);
    this.outposts = new Outposts(this);
    this.fauna = new Fauna(this);
    this.contracts = new ContractDesk(this);
    this.market = new StationMarket(this);
    this.weather = new WeatherDesk(this);
  }

  /** Inside a derelict's hull (shelter from the weather). */
  shelter(planet: number, p: V3): boolean {
    const w = wreckAt(this.def.planets[planet], p);
    return !!w && Math.hypot(p.x, p.y, p.z) < w.roof && wreckZone(w.site, w.x, w.z) !== 'rad';
  }

  /** Radiation (per second) from derelict reactors at a body-frame point. */
  reactorDose(planet: number, p: V3): number {
    const w = wreckAt(this.def.planets[planet], p);
    return w && Math.hypot(p.x, p.y, p.z) < w.roof && wreckZone(w.site, w.x, w.z) === 'rad' ? REACTOR_DOSE : 0;
  }

  nextId() { return this.ctx.nextId(); }

  /** Registers an NPC ship built elsewhere (event spawns). */
  addNpc(ship: ShipEntity) {
    this.syncWorld(ship);
    this.ships.set(ship.id, ship);
    this.infos.push(this.shipInfo(ship));
  }

  /** Removes an NPC without an explosion (jumped out). */
  despawn(ship: ShipEntity) {
    this.ships.delete(ship.id);
    this.gone.push(ship.id);
  }

  get time() { return this.ctx.time; }
  now() { return this.ctx.now(); }
  convoyAlive(system: number, poi: number) { return this.ctx.convoyAlive(system, poi); }
  get stationPos() { return this.def.station.pos; }
  ship(id: number) { return this.ships.get(id); }
  inSafeZone(p: V3) { return vdistSq(p, this.def.station.pos) < SAFE_ZONE_RADIUS * SAFE_ZONE_RADIUS; }

  /** Refreshes a ship's cached world pose (its state may live in a rotating planet frame). */
  syncWorld(ship: ShipEntity) {
    worldPose(ship.state, this.def.planets, this.time, ship.world);
  }

  /** World position of a pilot on foot (on the deck: the station). */
  charWorld(c: CharEntity, out: V3 = v3()): V3 {
    if (c.planet < 0) return Object.assign(out, this.def.station.pos);
    const pl = this.def.planets[c.planet];
    return toWorldPoint(pl, planetRot(pl, this.time, rot), c.state.p, out);
  }

  /** World position a session is viewed from (pilot on foot or ship). */
  focusOf(s: Session): V3 {
    return s.char ? this.charWorld(s.char) : s.ship.world.p;
  }

  // ------------------------------------------------------------------ entities
  spawnPirate(near?: V3): ShipEntity {
    const field = this.def.fields[this.rng.int(0, this.def.fields.length - 1)];
    const r = field.radius;
    const pos = near ? { ...near } : v3(field.center.x + this.rng.range(-r, r), field.center.y + this.rng.range(-r, r) * 0.3, field.center.z + this.rng.range(-r, r));
    const id = this.ctx.nextId();
    const q = qlook(quat(), vnorm(v3(), v3(this.rng.range(-1, 1), 0, this.rng.range(-1, 1))), v3(0, 1, 0));
    const ship: ShipEntity = {
      id, name: `Пират ${makeName(this.rng)}`, bp: pirateBlueprint(this.rng.int(0, 1e9)),
      state: newShip(pos, q), world: newPose(), flight: PIRATE_FLIGHT, combat: PIRATE_COMBAT,
      hull: PIRATE_COMBAT.maxHull, shield: PIRATE_COMBAT.maxShield, energy: 100, lastHit: -99, fireCooldown: 0, gun: 0,
      throttle: 0, boosting: false, dead: false, respawnAt: 0, docked: false, god: false, session: null,
      npc: new NpcBrain(field.center, field.radius, new Rng(this.rng.int(0, 1e9))), lastInput: emptyInput(),
    };
    this.syncWorld(ship);
    this.ships.set(id, ship);
    this.infos.push(this.shipInfo(ship));
    return ship;
  }

  createPlayerShip(pilot: PilotRecord, pos: V3, q: Quat): ShipEntity {
    const c = combatStats(pilot.upgrades);
    const ship: ShipEntity = {
      id: this.ctx.nextId(), name: pilot.name, bp: playerBlueprint(pilot.name),
      state: newShip(pos, q), world: newPose(), flight: flightStats(pilot.upgrades), combat: c,
      hull: c.maxHull, shield: c.maxShield, energy: 100, lastHit: -99, fireCooldown: 0, gun: 0,
      throttle: 0, boosting: false, dead: false, respawnAt: 0, docked: false, god: false, session: null, npc: null, lastInput: emptyInput(),
    };
    return ship;
  }

  shipInfo(s: ShipEntity): EntityInfo {
    return { id: s.id, kind: KIND.SHIP, name: s.name, bp: s.bp, npc: !!s.npc, owner: s.session?.id, wanted: s.session && isWanted(s.session.pilot.career) ? true : undefined };
  }

  allInfos(): EntityInfo[] {
    const out: EntityInfo[] = [];
    for (const s of this.ships.values()) out.push(this.shipInfo(s));
    for (const c of this.chars.values()) out.push({ id: c.id, kind: KIND.CHAR, name: c.name, owner: c.session.id, look: lookCode(c.session.pilot.outfit) });
    for (const r of this.rovers.values()) out.push(this.roverInfo(r));
    for (const m of this.missiles.values()) out.push({ id: m.id, kind: KIND.MISSILE, name: '', owner: m.owner });
    for (const l of this.world.loot.values()) out.push({ id: l.id, kind: KIND.LOOT, name: 'Контейнер' });
    for (const c of this.fauna.creatures.values()) out.push(this.fauna.info(c));
    return out;
  }

  spawnPoint(): { p: V3; q: Quat } {
    const st = this.def.station.pos;
    const p = v3(this.def.spawn.x + this.rng.range(-120, 120), this.def.spawn.y + this.rng.range(-60, 60), this.def.spawn.z + this.rng.range(-120, 120));
    // Face the station so new pilots see it (and the nav marker) right away.
    return { p, q: qlook(quat(), vnorm(v3(), vsub(v3(), st, p)), v3(0, 1, 0)) };
  }

  addSession(s: Session, at?: { p: V3; q: Quat }) {
    const sp = at ?? this.spawnPoint();
    s.system = this;
    s.ship.state = newShip(sp.p, sp.q);
    s.ship.session = s;
    s.ship.dead = false;
    s.ship.docked = false;
    this.syncWorld(s.ship);
    this.sessions.add(s);
    this.ships.set(s.ship.id, s.ship);
    this.infos.push(this.shipInfo(s.ship));
    s.mode = MODE.SHIP;
    s.pilot.system = this.def.id;
  }

  removeSession(s: Session) {
    this.sessions.delete(s);
    this.removeRover(s);
    if (s.char) {
      this.chars.delete(s.char.id);
      this.gone.push(s.char.id);
      s.char = null;
    }
    this.ships.delete(s.ship.id);
    this.gone.push(s.ship.id);
  }

  harvestedList(): Harvested[] {
    const out: Harvested[] = [];
    for (const [k, until] of this.harvested) {
      if (until <= this.time) continue;
      const [planet, node] = k.split(':').map(Number);
      out.push({ planet, node, left: until - this.time });
    }
    return out;
  }

  // ------------------------------------------------------------------ combat
  tryFire(ship: ShipEntity) {
    if (ship.fireCooldown > 0 || ship.energy < LASER.cost || (ship.state.landed && ship.bp.cls !== 'turret') || isCruising(ship.state)) return;
    const w = ship.world;
    if (this.inSafeZone(w.p)) return;
    ship.fireCooldown = LASER.cooldown;
    ship.energy -= LASER.cost;
    const guns = GUN_OFFSETS[ship.bp.cls];
    const g = guns[ship.gun++ % guns.length];
    qrot(tmp, w.q, g);
    const p = v3(w.p.x + tmp.x, w.p.y + tmp.y, w.p.z + tmp.z);
    qrot(tmp2, w.q, FWD);
    const v = v3(w.v.x + tmp2.x * LASER.speed, w.v.y + tmp2.y * LASER.speed, w.v.z + tmp2.z * LASER.speed);
    this.lasers.push({ owner: ship.id, p, v, life: LASER.life, dmg: ship.combat.laserDamage });
    this.shots.push({ shooter: ship.id, px: p.x, py: p.y, pz: p.z, vx: v.x, vy: v.y, vz: v.z, level: ship.session ? ship.session.pilot.upgrades.weapons : 0 });
  }

  fireMissile(ship: ShipEntity, targetId: number): string | null {
    const s = ship.session;
    if (!s || s.pilot.missiles <= 0) return 'Нет ракет';
    const w = ship.world;
    if (this.inSafeZone(w.p)) return 'Оружие заблокировано в зоне станции';
    const t = this.ships.get(targetId);
    if (!t || t === ship || t.dead || t.docked) return 'Нет цели';
    if (t.session && this.ctx.allies(s, t.session)) return 'Это пилот вашей группы';
    vsub(tmp, t.world.p, w.p);
    const d = vlen(tmp);
    if (d > MISSILE.range * 1.1) return 'Цель слишком далеко';
    qrot(tmp2, w.q, FWD);
    if (vdot(tmp, tmp2) / d < MISSILE.coneCos * 0.97) return 'Цель вне конуса захвата';
    s.pilot.missiles--;
    const id = this.ctx.nextId();
    const p = v3(w.p.x + tmp2.x * 8, w.p.y + tmp2.y * 8 - 1.5, w.p.z + tmp2.z * 8);
    const v = v3(w.v.x + tmp2.x * 60, w.v.y + tmp2.y * 60, w.v.z + tmp2.z * 60);
    this.missiles.set(id, { id, owner: ship.id, target: targetId, p, v, life: MISSILE.life });
    this.infos.push({ id, kind: KIND.MISSILE, name: '', owner: ship.id });
    this.events.push({ t: 'missile', id, target: targetId });
    s.sendPilot();
    return null;
  }

  damage(target: ShipEntity, dmg: number, attacker: number, pos?: V3) {
    if (target.dead || target.docked || target.god) return;
    if (target.session && (target.session.mode === MODE.FOOT || target.session.mode === MODE.ROVER)) return;
    if (this.inSafeZone(target.world.p)) return;
    // no friendly fire inside a group
    const by = attacker ? this.ships.get(attacker)?.session : undefined;
    if (by && target.session && this.ctx.allies(by, target.session)) return;
    target.lastHit = this.time;
    target.state.cruiseBlock = Math.max(target.state.cruiseBlock, 4);
    const absorbed = Math.min(target.shield, dmg);
    target.shield -= absorbed;
    target.hull -= dmg - absorbed;
    const hp = pos ?? target.world.p;
    this.events.push({ t: 'hit', target: target.id, pos: [hp.x, hp.y, hp.z], shield: absorbed >= dmg - 1e-9, dmg: Math.round(dmg), by: attacker });
    this.world.onHit(target, attacker);
    if (target.npc && attacker) {
      const a = this.ships.get(attacker);
      if (a && !a.npc) {
        // shooting at pirates ends any truce with them for a while
        a.provokedAt = this.time;
        if (target.npc.state !== 'flee') { target.npc.target = attacker; target.npc.state = 'attack'; }
      }
    }
    if (target.hull <= 0) this.kill(target, attacker);
  }

  kill(target: ShipEntity, attacker: number) {
    target.dead = true;
    target.hull = 0;
    const p = target.world.p;
    this.events.push({ t: 'boom', id: target.id, pos: [p.x, p.y, p.z], big: true });
    const killer = this.ships.get(attacker);
    this.events.push({ t: 'kill', killer: killer?.name ?? 'Столкновение', victim: target.name });
    if (target.session) {
      const s = target.session;
      s.pilot.deaths++;
      const lost = cargoCount(s.pilot.cargo);
      s.pilot.cargo = emptyCargo();
      target.respawnAt = this.time + this.ctx.respawnDelay;
      s.mode = MODE.DEAD;
      s.resync();
      s.sendPilot();
      s.msg(lost ? `Корабль уничтожен. Потерян груз: ${lost} ед.` : 'Корабль уничтожен.', 'warn');
    } else {
      this.ships.delete(target.id);
      this.gone.push(target.id);
      if (!target.transient) this.npcRespawn.push(this.time + 40);
      this.world.onKill(target, killer);
      this.outposts.onKill(target, killer);
    }
    if (killer?.session && killer !== target) {
      // a pilot wanted by the Federation carries an extra price on their head
      const wanted = target.session && isWanted(target.session.pilot.career) ? WANTED_BOUNTY : 0;
      const bounty = (target.bounty ?? (target.npc ? BOUNTY.npc : BOUNTY.player)) + wanted;
      killer.session.pilot.kills++;
      this.reward(killer.session, p, bounty, wanted ? 'Разыскиваемый пилот уничтожен' : 'Цель уничтожена');
      if (target.npc && target.npc.role !== 'turret') this.contracts.onPirateKill(killer.session);
    }
  }

  /** The pilot and group mates near `at` (or near the pilot) who share kills. */
  crew(s: Session, at: V3 = this.focusOf(s)): Session[] {
    return this.ctx.crew(s, at, SHARE_RANGE);
  }

  /**
   * Pays a bounty earned by `s` near `at`: split evenly between them and the group mates
   * nearby, with a bonus for every extra pilot.
   */
  reward(s: Session, at: V3, credits: number, text: string): number {
    const crew = this.crew(s, at);
    const share = Math.round((credits * (1 + GROUP_BONUS * (crew.length - 1))) / crew.length);
    for (const m of crew) {
      m.pilot.credits += share;
      m.sendPilot();
      m.msg(crew.length > 1 ? `${text}: +${share} кр (доля группы ×${crew.length})` : `${text}: +${share} кр`, 'good');
    }
    return share;
  }

  /** Sends the station's prices (and the neighbours' through the gates) to a docked pilot. */
  sendMarket(s: Session) {
    this.market.send(s, this.ctx.quotes(this.def.gates.map((g) => g.target)));
  }

  /** After a trade: everyone at the station sees the new prices. */
  private marketTrade() {
    this.market.changed();
    this.broadcastMarket();
  }

  private broadcastMarket() {
    for (const o of this.sessions) if (atStation(o)) this.sendMarket(o);
  }

  respawn(s: Session) {
    const ship = s.ship;
    const sp = this.spawnPoint();
    ship.state = newShip(sp.p, sp.q);
    this.syncWorld(ship);
    ship.dead = false;
    ship.hull = ship.combat.maxHull;
    ship.shield = ship.combat.maxShield;
    ship.energy = 100;
    s.mode = MODE.SHIP;
    s.resync();
  }

  // ------------------------------------------------------------------ NPC world
  findPrey(from: V3, range: number): ShipEntity | null {
    let best: ShipEntity | null = null, bd = range * range;
    for (const s of this.ships.values()) {
      if (s.npc || s.dead || s.docked || s.state.landed || !s.session || s.session.mode !== MODE.SHIP) continue;
      if (this.inSafeZone(s.world.p) || this.truce(s)) continue;
      const d = vdistSq(s.world.p, from);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  /** Pirates leave alone pilots on good terms with the Syndicate, unless they shot at pirates recently. */
  truce(ship: ShipEntity): boolean {
    return !!ship.session && isPirateFriend(ship.session.pilot.career) && this.time - (ship.provokedAt ?? -1e9) > 60;
  }

  // ------------------------------------------------------------------ tick
  step() {
    const t = this.time;
    // Ships parked in a planet frame move with its rotation even without input.
    for (const ship of this.ships.values()) this.syncWorld(ship);
    for (const s of this.sessions) this.processInputs(s);
    this.stepRovers();

    this.env.time = t;
    for (const ship of this.ships.values()) {
      if (!ship.npc || ship.dead || ship.npc.role === 'turret') continue;
      const { input, fire } = npcThink(ship, ship.npc, this, DT);
      stepShip(ship.state, input, ship.flight, this.env, DT, stepOut);
      this.syncWorld(ship);
      ship.throttle = input.throttle;
      ship.boosting = input.boost;
      ship.fireCooldown -= DT;
      if (fire) this.tryFire(ship);
    }

    this.stepLasers();
    this.stepMissiles();
    this.world.step(DT);
    this.outposts.step(DT);
    this.fauna.step(DT);
    if (this.ctx.tick % 15 === 0) { this.contracts.checkSites(); this.weather.step(0.5); }
    if (this.ctx.tick % 30 === 0) {
      // a fresh board (new epoch, a convoy came or went) goes to everyone docked
      if (this.contracts.board().changed) for (const s of this.sessions) if (s.mode === MODE.DOCKED) this.contracts.sendBoard(s);
      for (const s of this.sessions) this.contracts.expire(s);
      // prices drift each epoch and recover from trade: docked pilots see them move
      if (this.market.changed()) this.broadcastMarket();
    }

    for (const ship of this.ships.values()) {
      if (ship.dead) {
        if (ship.session && t >= ship.respawnAt) this.respawn(ship.session);
        continue;
      }
      ship.energy = Math.min(100, ship.energy + ENERGY_REGEN * DT);
      if (t - ship.lastHit > SHIELD_DELAY) ship.shield = Math.min(ship.combat.maxShield, ship.shield + ship.combat.shieldRegen * DT);
    }

    for (let i = this.npcRespawn.length - 1; i >= 0; i--) {
      if (t >= this.npcRespawn[i]) {
        this.npcRespawn.splice(i, 1);
        this.spawnPirate();
      }
    }
  }

  private processInputs(s: Session) {
    // One input per tick on average; a small budget lets a lagging client catch up
    // without allowing a speed hack by flooding inputs.
    s.budget = Math.min(6, s.budget + 1);
    while (s.inputs.length && s.budget >= 1) {
      const m = s.inputs.shift()!;
      if (m.seq <= s.lastSeq) continue;
      s.budget--;
      s.lastSeq = m.seq;
      const ship = s.ship;
      if (s.mode === MODE.SHIP && m.mode === MODE.SHIP && !ship.dead && !ship.docked) {
        // The client stamps inputs with its server-time estimate; prediction replays with the
        // same value, so frame changes match exactly. Clamped so it cannot be abused.
        this.env.time = Math.max(this.time - 2, Math.min(this.time + 1, m.t));
        stepShip(ship.state, m.ship, ship.flight, this.env, DT, stepOut);
        this.syncWorld(ship);
        ship.throttle = m.ship.throttle;
        ship.boosting = m.ship.boost;
        ship.lastInput = m.ship;
        if (stepOut.impact > 40) this.damage(ship, (stepOut.impact - 40) * 1.2, 0);
        ship.fireCooldown -= DT;
        if (m.flags & 1) this.tryFire(ship);
      } else if (s.mode === MODE.DECK && m.mode === MODE.DECK && s.char) {
        stepDeck(s.char.state, m.char, DT);
        s.char.pitch = m.char.pitch;
        s.char.aim = false;
      } else if (s.mode === MODE.FOOT && m.mode === MODE.FOOT && s.char) {
        // the client stamps inputs with server time: the same wind as its prediction
        const wt = Math.max(this.time - 2, Math.min(this.time + 1, m.t));
        stepChar(s.char.state, m.char, this.def.planets[s.char.planet], DT, s.gear(), this.weather.at(s.char.planet, wt, charWeather));
        s.char.pitch = m.char.pitch;
        s.char.aim = !!(m.flags & IFLAG.AIM);
        if (m.flags & IFLAG.FIRE && !s.char.state.climbMode) this.fauna.shoot(s, m.char.pitch);
      } else if (s.mode === MODE.ROVER && m.mode === MODE.ROVER && s.rover && s.char) {
        stepRover(s.rover.state, m.char, this.def.planets[s.rover.planet], DT);
        this.seatDriver(s);
      }
    }
  }

  // ------------------------------------------------------------------ rovers
  roverInfo(r: RoverEntity): EntityInfo {
    return { id: r.id, kind: KIND.ROVER, name: `Ровер ${r.owner.pilot.name}`, owner: r.owner.id };
  }

  /** Parked rovers keep settling and rolling; a rover whose ship left the planet goes back into the hold. */
  private stepRovers() {
    for (const r of this.rovers.values()) {
      const s = r.owner;
      const away = s.ship.dead || (s.ship.state.landed !== r.planet + 1 && s.mode !== MODE.ROVER && s.mode !== MODE.FOOT);
      if (away) {
        this.removeRover(s);
        s.msg('Ровер погружен в трюм');
        continue;
      }
      if (s.mode !== MODE.ROVER) stepRover(r.state, idleRover, this.def.planets[r.planet], DT);
    }
  }

  /** The driver rides in the seat: their pilot follows the rover (fauna, weather, interest use it). */
  private seatDriver(s: Session) {
    const r = s.rover!.state, c = s.char!.state;
    qrot(tmp, r.q, ROVER.seat);
    c.p.x = r.p.x + tmp.x; c.p.y = r.p.y + tmp.y; c.p.z = r.p.z + tmp.z;
    c.v.x = r.v.x; c.v.y = r.v.y; c.v.z = r.v.z;
    const up = vnorm(tmp2, c.p);
    qrot(tmp, r.q, FWD);
    const fu = vdot(tmp, up);
    tmp.x -= up.x * fu; tmp.y -= up.y * fu; tmp.z -= up.z * fu;
    if (vlen(tmp) > 1e-3) vnorm(c.f, tmp);
    c.ground = 1; c.swim = 0; c.climbMode = 0; c.climb = 0; c.scramble = 0;
  }

  removeRover(s: Session) {
    const r = s.rover;
    if (!r) return;
    this.rovers.delete(r.id);
    this.gone.push(r.id);
    s.rover = null;
    if (s.mode === MODE.ROVER) {
      // stepping out where the rover was
      s.mode = s.char ? MODE.FOOT : MODE.SHIP;
      s.resync();
    }
  }

  private stepLasers() {
    const dt = DT;
    const reach = LASER.speed * dt + 60;
    for (let i = this.lasers.length - 1; i >= 0; i--) {
      const L = this.lasers[i];
      const p1 = v3(L.p.x + L.v.x * dt, L.p.y + L.v.y * dt, L.p.z + L.v.z * dt);
      let hit: ShipEntity | null = null, bestT = 2;
      for (const sh of this.ships.values()) {
        if (sh.id === L.owner || sh.dead || sh.docked) continue;
        if (vdistSq(sh.world.p, L.p) > reach * reach) continue;
        const tt = segmentSphere(L.p, p1, sh.world.p, sh.flight.radius + 1.5);
        if (tt >= 0 && tt < bestT) { bestT = tt; hit = sh; }
      }
      if (hit) {
        const hp = v3(L.p.x + (p1.x - L.p.x) * bestT, L.p.y + (p1.y - L.p.y) * bestT, L.p.z + (p1.z - L.p.z) * bestT);
        this.damage(hit, L.dmg, L.owner, hp);
        this.lasers.splice(i, 1);
        continue;
      }
      L.p = p1;
      L.life -= dt;
      if (L.life <= 0) this.lasers.splice(i, 1);
    }
  }

  private stepMissiles() {
    const dt = DT;
    for (const m of this.missiles.values()) {
      const tg = this.ships.get(m.target);
      const alive = tg && !tg.dead && !tg.docked;
      if (alive) {
        leadPoint(m.p, v3(), tg.world.p, tg.world.v, MISSILE.speed, aim);
        vnorm(tmp, vsub(tmp, aim, m.p));
        vnorm(tmp2, m.v);
        const cos = Math.max(-1, Math.min(1, vdot(tmp, tmp2)));
        const ang = Math.acos(cos), maxA = MISSILE.turn * dt;
        const k = ang > maxA ? maxA / ang : 1;
        tmp2.x += (tmp.x - tmp2.x) * k; tmp2.y += (tmp.y - tmp2.y) * k; tmp2.z += (tmp.z - tmp2.z) * k;
        vnorm(tmp2, tmp2);
      } else vnorm(tmp2, m.v);
      const spd = Math.min(MISSILE.speed, vlen(m.v) + 400 * dt);
      vscale(m.v, tmp2, spd);
      m.p.x += m.v.x * dt; m.p.y += m.v.y * dt; m.p.z += m.v.z * dt;
      m.life -= dt;
      let done = m.life <= 0;
      if (alive && vdist(m.p, tg.world.p) < tg.flight.radius + 6) {
        this.damage(tg, MISSILE.damage, m.owner, m.p);
        done = true;
      }
      if (done) {
        this.missiles.delete(m.id);
        this.gone.push(m.id);
        this.events.push({ t: 'boom', id: m.id, pos: [m.p.x, m.p.y, m.p.z], big: false });
      }
    }
  }

  // ------------------------------------------------------------------ snapshots
  buildSnapshot(s: Session): Snapshot {
    const focus = this.focusOf(s);
    const r2 = INTEREST_RADIUS * INTEREST_RADIUS;
    const cw = v3();
    const radarTick = this.ctx.tick % 15 === 0;
    const entities: EntityState[] = [];
    for (const sh of this.ships.values()) {
      if (sh === s.ship || sh.dead || sh.docked) continue;
      const d2 = vdistSq(sh.world.p, focus);
      if (!radarTick && d2 > r2) continue;
      // static towers only matter up close
      if (sh.bp.cls === 'turret' && d2 > 8000 * 8000) continue;
      let flags = 0;
      if (sh.state.landed) flags |= EFLAG.LANDED;
      if (isCruising(sh.state)) flags |= EFLAG.CRUISE;
      if (sh.boosting) flags |= EFLAG.BOOST;
      if (sh.npc) flags |= EFLAG.NPC;
      if (this.inSafeZone(sh.world.p)) flags |= EFLAG.SAFE;
      // Ships inside a planet frame are sent in body coordinates so they stay glued to the ground.
      const st = sh.state;
      entities.push({
        id: sh.id, kind: KIND.SHIP, flags, frame: st.frame, px: st.p.x, py: st.p.y, pz: st.p.z, qx: st.q.x, qy: st.q.y, qz: st.q.z, qw: st.q.w,
        vx: st.v.x, vy: st.v.y, vz: st.v.z, hull: Math.max(0, sh.hull / sh.combat.maxHull), shield: sh.shield / sh.combat.maxShield,
        throttle: st.landed ? 0 : isCruising(st) ? 1 : Math.abs(sh.throttle),
      });
    }
    const q = quat();
    const docked = s.mode === MODE.DOCKED || s.mode === MODE.DECK;
    for (const c of this.chars.values()) {
      if (c.session === s || vdistSq(this.charWorld(c, cw), focus) > r2) continue;
      // a driver sits in the rover's model
      if (c.session.mode === MODE.ROVER) continue;
      // pilots on the station deck are seen only from inside the station
      const deck = c.planet < 0;
      if (deck !== docked) continue;
      // a cabin is private: its owner sees no one else, and no one sees them
      if (deck && inCabin(c.state.p) !== (s.mode === MODE.DECK && !!s.char && inCabin(s.char.state.p))) continue;
      if (deck) qlook(q, c.state.f, DECK_UP); else charQuat(c.state, q);
      const cs = c.state;
      const flags = (cs.ground || cs.swim ? 0 : CFLAG.AIR) | (cs.climbMode ? CFLAG.CLIMB : 0) | (cs.scramble ? CFLAG.SCRAMBLE : 0)
        | (cs.swim ? CFLAG.SWIM : 0) | (cs.swim === 2 ? CFLAG.UNDER : 0) | (c.aim || this.time - c.shotAt < 1.5 ? CFLAG.AIM : 0);
      const prog = climbProgress(cs);
      entities.push({
        id: c.id, kind: KIND.CHAR, flags, frame: deck ? DECK_FRAME : c.planet + 1, px: cs.p.x, py: cs.p.y, pz: cs.p.z,
        qx: q.x, qy: q.y, qz: q.z, qw: q.w, vx: cs.v.x, vy: cs.v.y, vz: cs.v.z, hull: c.hp / c.maxHp, shield: aimByte(c.pitch),
        throttle: cs.climbMode === 2 ? 0.5 + prog * 0.5 : prog * 0.5,
      });
    }
    for (const r of this.rovers.values()) {
      const driven = r.owner.mode === MODE.ROVER;
      if (driven && r.owner === s) continue;
      const pl = this.def.planets[r.planet];
      if (vdistSq(toWorldPoint(pl, planetRot(pl, this.time, rot), r.state.p, cw), focus) > r2) continue;
      const st = r.state;
      entities.push({
        id: r.id, kind: KIND.ROVER, flags: driven ? EFLAG.BOOST : 0, frame: r.planet + 1, px: st.p.x, py: st.p.y, pz: st.p.z,
        qx: st.q.x, qy: st.q.y, qz: st.q.z, qw: st.q.w, vx: st.v.x, vy: st.v.y, vz: st.v.z,
        hull: 1, shield: steerByte(st.steer), throttle: Math.min(1, vlen(st.v) / ROVER_SPEED_MAX),
      });
    }
    for (const m of this.missiles.values()) {
      if (vdistSq(m.p, focus) > r2) continue;
      qlook(q, m.v, Math.abs(m.v.y) > Math.abs(m.v.x) ? v3(1, 0, 0) : v3(0, 1, 0));
      entities.push({ id: m.id, kind: KIND.MISSILE, flags: 0, frame: 0, px: m.p.x, py: m.p.y, pz: m.p.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w, vx: m.v.x, vy: m.v.y, vz: m.v.z, hull: 1, shield: 0, throttle: 1 });
    }
    this.fauna.entities(s, entities);
    for (const l of this.world.loot.values()) {
      if (vdistSq(l.p, focus) > r2) continue;
      entities.push({ id: l.id, kind: KIND.LOOT, flags: 0, frame: 0, px: l.p.x, py: l.p.y, pz: l.p.z, qx: 0, qy: 0, qz: 0, qw: 1, vx: l.v.x, vy: l.v.y, vz: l.v.z, hull: 1, shield: 0, throttle: 0 });
    }
    const ship = s.ship;
    return {
      tick: this.ctx.tick, time: this.time, ack: s.lastSeq, entities,
      self: {
        shipId: ship.id, mode: s.mode, teleport: s.teleport, ship: ship.state,
        hull: Math.max(0, ship.hull), maxHull: ship.combat.maxHull, shield: ship.shield, maxShield: ship.combat.maxShield,
        energy: ship.energy, missiles: s.pilot.missiles,
        charId: s.char?.id ?? 0, char: s.char?.state ?? null, charPlanet: s.char ? (s.char.planet < 0 ? DECK_PLANET : s.char.planet) : -1, suit: s.char ? (s.char.hp / s.char.maxHp) * 100 : 100,
        roverId: s.mode === MODE.ROVER && s.rover ? s.rover.id : 0, rover: s.mode === MODE.ROVER && s.rover ? s.rover.state : null,
      },
    };
  }

  /** Walks the docked pilot out of the ship onto the hangar deck. */
  putOnDeck(s: Session): CharEntity {
    const hp = s.gear().hp;
    const f = vnorm(v3(), v3(0, 0, 1));
    const c: CharEntity = { id: this.ctx.nextId(), name: s.pilot.name, state: newChar(v3(RAMP.x, 0, RAMP.z), f), planet: -1, session: s, hp, maxHp: hp, hurtAt: -99, cool: 0, pitch: 0, aim: false, shotAt: -99, drown: 0 };
    s.char = c;
    this.chars.set(c.id, c);
    this.infos.push({ id: c.id, kind: KIND.CHAR, name: s.pilot.name, owner: s.id, look: lookCode(s.pilot.outfit) });
    s.mode = MODE.DECK;
    s.resync();
    return c;
  }

  /** Puts the session's pilot on foot at body-frame `pos` facing tangent `f`. */
  private putOnFoot(s: Session, planet: number, pos: V3, f: V3): CharEntity {
    const hp = s.gear().hp;
    const c: CharEntity = { id: this.ctx.nextId(), name: s.pilot.name, state: newChar(pos, f), planet, session: s, hp, maxHp: hp, hurtAt: -99, cool: 0, pitch: 0, aim: false, shotAt: -99, drown: 0 };
    s.char = c;
    this.chars.set(c.id, c);
    this.infos.push({ id: c.id, kind: KIND.CHAR, name: s.pilot.name, owner: s.id, look: lookCode(s.pilot.outfit) });
    s.mode = MODE.FOOT;
    s.resync();
    return c;
  }

  // ------------------------------------------------------------------ actions
  handleAction(s: Session, act: Action): string | null {
    const ship = s.ship;
    const p = s.pilot;
    this.syncWorld(ship);
    switch (act.a) {
      case 'exit': {
        if (s.mode !== MODE.SHIP || !ship.state.landed) return 'Сначала приземлитесь';
        // Landed ships live in the planet's body frame: everything below is planet-relative.
        const pl = this.def.planets[ship.state.landed - 1];
        const st = ship.state;
        const up = vnorm(v3(), st.p);
        const right = qrot(v3(), st.q, v3(1, 0, 0));
        const fwd = qrot(v3(), st.q, FWD);
        const d = vnorm(v3(), v3(st.p.x - 6 * right.x, st.p.y - 6 * right.y, st.p.z - 6 * right.z));
        const g = pl.radius + footHeight(pl, d.x, d.y, d.z) + 0.05;
        const pos = vscale(v3(), d, g);
        const f = vnorm(v3(), v3(fwd.x - up.x * vdot(fwd, up), fwd.y - up.y * vdot(fwd, up), fwd.z - up.z * vdot(fwd, up)));
        this.putOnFoot(s, pl.index, pos, f);
        return null;
      }
      case 'disembark': {
        // out of the ship onto the hangar deck, by the ramp
        if (s.mode !== MODE.DOCKED) return null;
        this.putOnDeck(s);
        return null;
      }
      case 'board': {
        if (s.mode === MODE.DECK && s.char) {
          if (Math.hypot(s.char.state.p.x - PAD.x, s.char.state.p.z - PAD.z) > BOARD_REACH) return 'Подойдите к кораблю';
          this.recallPilot(s);
          s.mode = MODE.DOCKED;
          s.sendPilot();
          return null;
        }
        if (s.mode !== MODE.FOOT || !s.char) return null;
        const near = ship.state.frame === s.char.planet + 1 && vdist(s.char.state.p, ship.state.p) <= EXIT_RANGE + 6;
        if (!near) return 'Подойдите ближе к кораблю';
        this.recallPilot(s);
        return null;
      }
      case 'rover': {
        // unload the rover next to the landed ship, or load it back in
        if (s.mode !== MODE.FOOT || !s.char || s.char.planet < 0) return null;
        const pl = this.def.planets[s.char.planet];
        if (s.rover) {
          if (vdist(s.rover.state.p, s.char.state.p) > ROVER.reach + 3) return 'Подойдите к роверу';
          if (vdist(s.rover.state.p, ship.state.p) > ROVER.load) return 'Подгоните ровер к кораблю';
          this.removeRover(s);
          s.msg('Ровер погружен в трюм');
          return null;
        }
        if (ship.state.landed !== pl.index + 1) return 'Ровер выгружается из приземлившегося корабля';
        if (vdist(s.char.state.p, ship.state.p) > ROVER.load) return 'Подойдите к кораблю';
        const st = ship.state;
        const right = qrot(v3(), st.q, v3(1, 0, 0)), fwd = qrot(v3(), st.q, FWD);
        const d = vnorm(v3(), v3(st.p.x + right.x * 9, st.p.y + right.y * 9, st.p.z + right.z * 9));
        const g = pl.radius + roverGround(pl, d.x, d.y, d.z) + 1.2;
        const fu = vdot(fwd, d);
        const f = vnorm(v3(), v3(fwd.x - d.x * fu, fwd.y - d.y * fu, fwd.z - d.z * fu));
        const r: RoverEntity = { id: this.ctx.nextId(), owner: s, state: newRover(vscale(v3(), d, g), qlook(quat(), f, d)), planet: pl.index };
        s.rover = r;
        this.rovers.set(r.id, r);
        this.infos.push(this.roverInfo(r));
        s.msg('Ровер выгружен: G рядом с ним — за руль, R у корабля — погрузить обратно', 'good');
        return null;
      }
      case 'drive': {
        if (s.mode !== MODE.FOOT || !s.char || !s.rover || s.rover.planet !== s.char.planet) return null;
        if (vdist(s.rover.state.p, s.char.state.p) > ROVER.reach) return 'Подойдите к роверу';
        if (roverOverturned(s.rover.state)) return 'Ровер перевернулся: R — поставить на колёса';
        s.mode = MODE.ROVER;
        this.seatDriver(s);
        s.resync();
        return null;
      }
      case 'leave': {
        if (s.mode !== MODE.ROVER || !s.rover || !s.char) return null;
        // out on the driver's (left) side, onto the ground
        const pl = this.def.planets[s.rover.planet];
        const r = s.rover.state;
        const left = qrot(v3(), r.q, v3(-2.2, 0, -0.3));
        const d = vnorm(v3(), v3(r.p.x + left.x, r.p.y + left.y, r.p.z + left.z));
        const pos = vscale(v3(), d, pl.radius + footHeight(pl, d.x, d.y, d.z) + 0.05);
        const f = qrot(v3(), r.q, FWD);
        const fu = vdot(f, d);
        copyChar(s.char.state, newChar(pos, vnorm(v3(), v3(f.x - d.x * fu, f.y - d.y * fu, f.z - d.z * fu))));
        s.mode = MODE.FOOT;
        s.resync();
        return null;
      }
      case 'flip': {
        const r = s.rover;
        if (!r || (s.mode !== MODE.ROVER && !(s.mode === MODE.FOOT && s.char && vdist(r.state.p, s.char.state.p) <= ROVER.reach + 3))) return null;
        if (!roverOverturned(r.state)) return 'Ровер стоит на колёсах';
        if (vlen(r.state.v) > 3) return 'Дождитесь, пока ровер остановится';
        rightRover(r.state, this.def.planets[r.planet]);
        if (s.mode === MODE.ROVER) { this.seatDriver(s); s.resync(); }
        return null;
      }
      case 'dock': {
        if (s.mode !== MODE.SHIP) return null;
        if (vdist(ship.world.p, this.def.station.pos) > DOCK_RANGE) return 'Слишком далеко от станции';
        ship.docked = true;
        ship.state.v = v3();
        s.mode = MODE.DOCKED;
        s.resync();
        s.sendPilot();
        this.contracts.deliver(s);
        this.contracts.sendBoard(s);
        this.sendMarket(s);
        return null;
      }
      case 'undock': {
        if (s.mode === MODE.DECK) { this.recallPilot(s); s.mode = MODE.DOCKED; }
        if (s.mode !== MODE.DOCKED) return null;
        const st = this.def.station.pos;
        const away = vnorm(v3(), vsub(v3(), this.def.spawn, st));
        ship.state = newShip(v3(st.x + away.x * 320, st.y + away.y * 320, st.z + away.z * 320), qlook(quat(), away, v3(0, 1, 0)));
        this.syncWorld(ship);
        ship.docked = false;
        s.mode = MODE.SHIP;
        s.resync();
        return null;
      }
      case 'sell': {
        if (!atStation(s)) return 'Нужно пристыковаться';
        const key = act.key && CARGO_KEYS.includes(act.key) ? act.key : undefined;
        const err = this.market.sell(s, key, act.n === undefined ? undefined : Number(act.n));
        if (!err) this.marketTrade();
        return err;
      }
      case 'buy': {
        if (!atStation(s)) return 'Нужно пристыковаться';
        if (!CARGO_KEYS.includes(act.key)) return null;
        const err = this.market.buy(s, act.key, Number(act.n));
        if (!err) this.marketTrade();
        return err;
      }
      case 'repair': {
        if (!atStation(s)) return 'Нужно пристыковаться';
        const missing = ship.combat.maxHull - ship.hull;
        if (missing <= 0.5) return 'Корпус цел';
        const hp = Math.min(missing, Math.floor(p.credits / REPAIR_COST_PER_HP));
        if (hp <= 0) return 'Недостаточно кредитов';
        p.credits -= Math.ceil(hp * REPAIR_COST_PER_HP);
        ship.hull += hp;
        s.sendPilot();
        return null;
      }
      case 'buyMissiles': {
        if (!atStation(s)) return 'Нужно пристыковаться';
        const n = Math.min(MAX_MISSILES - p.missiles, Math.floor(p.credits / MISSILE_COST));
        if (n <= 0) return p.missiles >= MAX_MISSILES ? 'Ракетный отсек полон' : 'Недостаточно кредитов';
        p.missiles += n;
        p.credits -= n * MISSILE_COST;
        s.sendPilot();
        return null;
      }
      case 'buyItem': {
        // suit parts from the station wardrobe: bought once, worn at once
        if (!atStation(s)) return 'Нужно пристыковаться';
        const it = item(String(act.id));
        if (!it) return null;
        if (owns(p.items, it.id)) return 'Уже куплено';
        if (!repOk(it, p.career.rep)) return `Нужна репутация: ${repNeedText(it)}`;
        if (p.credits < it.price) return 'Недостаточно кредитов';
        p.credits -= it.price;
        p.items.push(it.id);
        p.outfit[it.slot] = it.id;
        s.sendPilot();
        s.msg(`Куплено: ${it.name}`, 'good');
        return null;
      }
      case 'equip': {
        if (!atStation(s)) return 'Нужно пристыковаться';
        const it = item(String(act.id));
        if (!it) return null;
        if (!owns(p.items, it.id)) return 'Сначала купите';
        p.outfit[it.slot] = it.id;
        s.sendPilot();
        s.msg(`${SLOT_NAMES[it.slot]}: ${it.name}`);
        return null;
      }
      case 'upgrade': {
        if (!atStation(s)) return 'Нужно пристыковаться';
        const key = act.key as UpgradeKey;
        if (!UPGRADE_KEYS.includes(key)) return null;
        const lvl = p.upgrades[key];
        if (lvl >= MAX_LEVEL) return 'Максимальный уровень';
        const cost = UPGRADE_COST[lvl + 1];
        if (p.credits < cost) return 'Недостаточно кредитов';
        p.credits -= cost;
        p.upgrades[key] = lvl + 1;
        this.applyStats(s);
        s.sendPilot();
        s.msg(`Улучшение установлено (${lvl + 1} ур.)`, 'good');
        return null;
      }
      case 'harvest': {
        if (s.mode !== MODE.FOOT || !s.char) return null;
        const pl = this.def.planets[s.char.planet];
        const node = resourceNode(pl, act.node);
        if (!node) return null;
        const key = `${pl.index}:${node.id}`;
        if ((this.harvested.get(key) ?? 0) > this.time) return 'Ресурс уже собран';
        const np = vscale(v3(), node.dir, pl.radius + node.h);
        if (vdist(np, s.char.state.p) > HARVEST_RANGE + 1.5) return 'Слишком далеко';
        if (cargoCount(p.cargo) >= combatStats(p.upgrades).cargoCap) return 'Трюм полон';
        p.cargo[node.type]++;
        this.harvested.set(key, this.time + NODE_RESPAWN);
        this.events.push({ t: 'harvest', planet: pl.index, node: node.id, left: NODE_RESPAWN, by: s.id });
        // the first relic from a site goes on the cabin shelf
        const cache = node.type === 'relic' ? siteCache(pl, node.id) : null;
        if (cache) awardTrophy(s, `relic:${this.def.id}:${pl.index}:${cache.site.id}`);
        s.sendPilot();
        return null;
      }
      case 'readLog': {
        // the log console on a wreck's bridge (the client shows the text itself)
        if (s.mode !== MODE.FOOT || !s.char) return null;
        const pl = this.def.planets[s.char.planet];
        const w = wreckAt(pl, s.char.state.p);
        if (!w || wreckZone(w.site, w.x, w.z) !== 'bridge' || Math.hypot(w.x - w.site.goal.x, w.z - w.site.goal.z) > 3.5) return null;
        if (awardTrophy(s, `log:${this.def.id}:${pl.index}:${w.site.id}`)) s.sendPilot();
        return null;
      }
      case 'missile':
        if (s.mode !== MODE.SHIP) return null;
        return this.fireMissile(ship, act.target);
      case 'respawn':
        if (ship.dead && this.time >= ship.respawnAt) this.respawn(s);
        return null;
      case 'sample':
        if (s.mode !== MODE.FOOT) return null;
        return this.fauna.sample(s, Number(act.id));
      case 'salvage':
        if (s.mode !== MODE.SHIP || ship.dead) return null;
        return this.world.salvage(s, Number(act.id));
      case 'takeContract':
        return this.contracts.take(s, String(act.id));
      case 'dropContract':
        return this.contracts.drop(s, String(act.id));
      default:
        return null;
    }
  }

  /** Puts a pilot on foot back into their ship. */
  recallPilot(s: Session) {
    if (s.char) {
      this.chars.delete(s.char.id);
      this.gone.push(s.char.id);
      s.char = null;
    }
    s.mode = MODE.SHIP;
    s.resync();
  }

  applyStats(s: Session) {
    const ship = s.ship;
    ship.flight = flightStats(s.pilot.upgrades);
    ship.combat = combatStats(s.pilot.upgrades);
    ship.hull = ship.combat.maxHull;
    ship.shield = ship.combat.maxShield;
  }

  gateInRange(p: V3) {
    return this.def.gates.find((g) => vdist(g.pos, p) < GATE_RANGE) ?? null;
  }

  // ------------------------------------------------------------------ dev helpers
  /** Dev: from a landed ship (or on foot by it) straight to the wheel of the rover. */
  devRover(s: Session): string | null {
    if (s.mode === MODE.ROVER) return null;
    if (s.mode === MODE.SHIP) {
      const e = this.handleAction(s, { a: 'exit' });
      if (e) return e;
    }
    if (!s.char || s.mode !== MODE.FOOT) return 'Сначала приземлитесь';
    if (!s.rover) {
      s.char.state.p = { ...s.ship.state.p };
      const e = this.handleAction(s, { a: 'rover' });
      if (e) return e;
    }
    s.char.state.p = { ...s.rover!.state.p };
    return this.handleAction(s, { a: 'drive' });
  }

  /** Dev teleports; planet targets accept `when` = day (default, station side) | dusk | night. */
  devTeleport(s: Session, target: string, when?: string): string {
    const ship = s.ship;
    if (s.char) {
      this.chars.delete(s.char.id);
      this.gone.push(s.char.id);
      s.char = null;
    }
    ship.docked = false;
    ship.dead = false;
    s.mode = MODE.SHIP;
    if (target === 'beach' || target === 'dive') return this.devShore(s, target === 'dive', when);
    if (target === 'station') {
      const sp = this.spawnPoint();
      ship.state = newShip(sp.p, sp.q);
    } else if (target === 'dock') {
      const st = this.def.station.pos;
      const away = vnorm(v3(), vsub(v3(), this.def.spawn, st));
      ship.state = newShip(v3(st.x + away.x * 320, st.y + away.y * 320, st.z + away.z * 320), qlook(quat(), vscale(v3(), away, -1), v3(0, 1, 0)));
    } else if (target === 'gate') {
      const g = this.def.gates[0];
      const toSt = vnorm(v3(), vsub(v3(), this.def.station.pos, g.pos));
      ship.state = newShip(v3(g.pos.x + toSt.x * 200, g.pos.y + toSt.y * 200, g.pos.z + toSt.z * 200), qlook(quat(), vscale(v3(), toSt, -1), v3(0, 1, 0)));
    } else if (target === 'open') {
      // empty space beyond the station, looking away from its planet
      const st = this.def.station.pos;
      const out = vnorm(v3(), vsub(v3(), st, this.def.planets[this.def.station.planet].center));
      ship.state = newShip(v3(st.x + out.x * 9000, st.y + out.y * 9000 + 1500, st.z + out.z * 9000), qlook(quat(), out, v3(0, 1, 0)));
    } else if (target === 'field') {
      const f = this.def.fields[0];
      const out = vnorm(v3(), vsub(v3(), this.def.station.pos, f.center));
      const p = v3(f.center.x + out.x * (f.radius + 2500), f.center.y + out.y * (f.radius + 2500) + 400, f.center.z + out.z * (f.radius + 2500));
      ship.state = newShip(p, qlook(quat(), vscale(v3(), out, -1), v3(0, 1, 0)));
    } else {
      const idx = Number(target.replace(/\D/g, ''));
      const pl = this.def.planets[idx];
      if (!pl) return 'Нет такой планеты';
      const land = target.startsWith('land');
      // Planet targets are built in the body frame, on the side currently facing the station
      // (or at local noon / dusk / midnight).
      const R = planetRot(pl, this.time, rot);
      const toSun = toBodyDir(R, vnorm(v3(), vsub(v3(), this.def.star.pos, pl.center)), v3());
      let aim = toBodyDir(R, vnorm(v3(), vsub(v3(), this.def.station.pos, pl.center)), v3());
      if (when === 'night') aim = vscale(v3(), toSun, -1);
      else if (when === 'day') {
        // mid-morning: the whole afternoon still ahead
        const eve = vnorm(v3(), vcross(v3(), pl.spinAxis, toSun));
        aim = vnorm(v3(), v3(toSun.x - eve.x * 0.7, toSun.y - eve.y * 0.7, toSun.z - eve.z * 0.7));
      }
      else if (when === 'dusk') {
        // on the evening terminator: the ground there is turning away from the sun
        const eve = vnorm(v3(), vcross(v3(), pl.spinAxis, toSun));
        aim = vnorm(v3(), v3(eve.x + toSun.x * 0.1, eve.y + toSun.y * 0.1, eve.z + toSun.z * 0.1));
      }
      let d = aim;
      const site = /^(ruin|base|wreck)/.test(target) ? planetSites(pl).find((x) => target.startsWith(x.kind)) : undefined;
      if (/^(ruin|base|wreck)/.test(target) && !site) return 'На планете нет такого объекта';
      if (site) {
        // land just outside the site, facing its centre
        d = siteDir(pl, site, 0, -(site.radius + 30));
      } else if (land) {
        // pick the resource node on dry land closest to the aim point, away from pirate outposts
        const nodes = nodesNear(pl, aim, pl.radius * 0.6).filter((n) => n.h > 2 && n.h < pl.maxHeight * 0.4 && n.id < SITE_NODE_BASE
          && !sitesNear(pl, n.dir, 2000).some((x) => x.kind === 'base'));
        nodes.sort((x, y) => vdot(y.dir, aim) - vdot(x.dir, aim));
        if (nodes.length) d = nodes[0].dir;
      }
      let tangent = vnorm(v3(), qrot(v3(), qlook(quat(), d, v3(0, 1, 0)), v3(0, 1, 0)));
      if (site) tangent = vscale(v3(), site.north, -1);
      const frame = pl.index + 1;
      if (land || site) {
        const off = vnorm(v3(), v3(d.x + tangent.x * (14 / pl.radius), d.y + tangent.y * (14 / pl.radius), d.z + tangent.z * (14 / pl.radius)));
        const g = pl.radius + surfaceHeight(pl, off.x, off.y, off.z) + SHIP_LAND_HEIGHT;
        ship.state = newShip(vscale(v3(), off, g), qlook(quat(), vscale(v3(), tangent, -1), off));
        ship.state.landed = frame;
      } else if (target.startsWith('low')) {
        // level flight ~180 m above the terrain, heading along the surface
        const g = pl.radius + Math.max(0, surfaceHeight(pl, d.x, d.y, d.z)) + 180;
        ship.state = newShip(vscale(v3(), d, g), qlook(quat(), tangent, d));
      } else {
        const g = pl.radius + pl.maxHeight + 900;
        ship.state = newShip(vscale(v3(), d, g), qlook(quat(), vscale(v3(), d, -1), tangent));
      }
      ship.state.frame = frame;
    }
    this.syncWorld(ship);
    s.resync();
    return 'Телепорт выполнен';
  }

  /**
   * Dev: lands next to a sandy shore of a water world (planet `which`, or the first ocean /
   * water world) and puts the pilot on foot on the beach facing the sea, or 8 m under water.
   */
  private devShore(s: Session, dive: boolean, which?: string): string {
    const wet = this.def.planets.filter((p) => liquidOf(p) === 'water').sort((a, b) => Number(b.type === 'ocean') - Number(a.type === 'ocean'));
    const pl = which !== undefined && which !== '' ? this.def.planets[Number(which)] : wet[0];
    if (!pl || liquidOf(pl) !== 'water') return 'Нет планеты с водой';
    const R = planetRot(pl, this.time, rot);
    const aim = toBodyDir(R, vnorm(v3(), vsub(v3(), this.def.station.pos, pl.center)), v3());
    const rng = new Rng(hashInts(pl.seed, 0xbea));
    const h = (d: V3) => heightAt(pl, d.x, d.y, d.z);
    const at = (d: V3, t: V3, m: number) => vnorm(v3(), v3(d.x * pl.radius + t.x * m, d.y * pl.radius + t.y * m, d.z * pl.radius + t.z * m));
    for (let i = 0; i < 8000; i++) {
      const spread = 0.02 + (i / 8000) * 1.2;
      const d = vnorm(v3(), v3(aim.x + rng.range(-1, 1) * spread, aim.y + rng.range(-1, 1) * spread, aim.z + rng.range(-1, 1) * spread));
      const hd = h(d);
      if (hd < 0.3 || hd > 1.2) continue;
      const t1 = vnorm(v3(), vcross(v3(), d, Math.abs(d.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0)));
      const t2 = vcross(v3(), d, t1);
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        const t = v3(t1.x * Math.cos(a) + t2.x * Math.sin(a), t1.y * Math.cos(a) + t2.y * Math.sin(a), t1.z * Math.cos(a) + t2.z * Math.sin(a));
        if (h(at(d, t, 25)) > -1.5 || h(at(d, t, 70)) > -5 || h(at(d, t, -45)) < 1.5) continue;
        // ship on dry land behind the beach, pilot at the waterline (or out at sea, under water)
        const ship = s.ship;
        if (s.char) { this.chars.delete(s.char.id); this.gone.push(s.char.id); s.char = null; }
        ship.docked = false;
        ship.dead = false;
        const L = at(d, t, -45);
        const g = pl.radius + surfaceHeight(pl, L.x, L.y, L.z) + SHIP_LAND_HEIGHT;
        const tl = vnorm(v3(), v3(t.x - L.x * vdot(t, L), t.y - L.y * vdot(t, L), t.z - L.z * vdot(t, L)));
        ship.state = newShip(vscale(v3(), L, g), qlook(quat(), vscale(v3(), tl, -1), L));
        ship.state.landed = ship.state.frame = pl.index + 1;
        this.syncWorld(ship);
        let pos = vscale(v3(), d, pl.radius + footHeight(pl, d.x, d.y, d.z) + 0.05), f = t;
        if (dive) {
          // the deepest water within 600 m straight out to sea
          let bm = 25, bh = 0;
          for (let m = 25; m <= 600 && bh > -16; m += 10) {
            const hm = h(at(d, t, m));
            if (hm > 0) break;
            if (hm < bh) { bh = hm; bm = m; }
          }
          const P = at(d, t, bm);
          pos = vscale(v3(), P, pl.radius - Math.min(8, -bh * 0.55));
          f = vnorm(v3(), v3(t.x - P.x * vdot(t, P), t.y - P.y * vdot(t, P), t.z - P.z * vdot(t, P)));
        } else f = vnorm(v3(), v3(t.x - d.x * vdot(t, d), t.y - d.y * vdot(t, d), t.z - d.z * vdot(t, d)));
        const c = this.putOnFoot(s, pl.index, pos, f);
        if (dive) c.state.swim = pl.radius - vlen(pos) > HEAD_UNDER ? 2 : 1;
        return dive ? 'Под водой' : 'Пляж';
      }
    }
    return 'Не нашёл берег';
  }
}
