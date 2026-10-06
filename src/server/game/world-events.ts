import { SAFE_ZONE_RADIUS } from '../../shared/constants.ts';
import { cargoCount, combatStats, FREIGHTER_COMBAT, FREIGHTER_FLIGHT, type Cargo } from '../../shared/economy.ts';
import {
  ANOMALY_SCAN_TIME, describeLoot, EVENT_REWARD, SALVAGE_MAX_SPEED, SALVAGE_RANGE, type LootContents, type Poi, type PoiKind,
} from '../../shared/events.ts';
import { makeName } from '../../shared/galaxy/names.ts';
import { hashInts, Rng } from '../../shared/math/rng.ts';
import { FWD, qlook, qrot, quat, v3, vdist, vlen, vnorm, vsub, type V3 } from '../../shared/math/vec.ts';
import { KIND, MODE, MSG } from '../../shared/net/protocol.ts';
import { emptyInput, isCruising, newShip } from '../../shared/sim/ship.ts';
import { newPose } from '../../shared/sim/frames.ts';
import { freighterBlueprint } from '../../shared/ships/blueprint.ts';
import type { ShipEntity } from './entities.ts';
import { NpcBrain } from './npc.ts';
import type { Session } from './session.ts';
import type { SystemInstance } from './system.ts';
import { awardTrophy } from './trophies.ts';

interface PoiState extends Poi {
  escorts: number[];
  /** Pilot ids that already salvaged this wreck / scanned this anomaly. */
  done: Set<number>;
}

export interface Loot { id: number; p: V3; v: V3; contents: LootContents; until: number }

const LIMIT: Record<PoiKind, number> = { convoy: 1, wreck: 2, anomaly: 1 };
const RESPAWN: Record<PoiKind, [number, number]> = { convoy: [240, 420], wreck: [120, 240], anomaly: [180, 300] };
const ESCORT_SLOTS = [v3(-140, 40, 90), v3(140, 40, 90), v3(0, -70, 220)];

/**
 * Spawns and runs dynamic world events in one star system: pirate convoys whose
 * freighter spills cargo containers, derelict wrecks to salvage (sometimes a
 * pirate ambush) and energy anomalies that reward a scan.
 */
export class WorldEvents {
  readonly pois = new Map<number, PoiState>();
  readonly loot = new Map<number, Loot>();
  /** Set when the POI list changed and must be re-sent. */
  dirty = true;
  private next: Record<PoiKind, number>;
  private rng: Rng;
  private lastSync = 0;
  /** `${poi}:${session}` → seconds spent inside an anomaly. */
  private scans = new Map<string, number>();
  private fullMsg = new Map<number, number>();

  constructor(private sys: SystemInstance) {
    this.rng = new Rng(hashInts(sys.def.seed, 0xe7e));
    const t = sys.time;
    // Stagger the first events so a fresh server has something to do right away.
    this.next = { wreck: t + 4, anomaly: t + 15, convoy: t + 75 };
  }

  list(): Poi[] {
    return [...this.pois.values()].map(({ id, kind, name, pos, radius, until, seed, charges, ship }) => ({ id, kind, name, pos, radius, until, seed, charges, ship }));
  }

  count(kind: PoiKind) {
    let n = 0;
    for (const p of this.pois.values()) if (p.kind === kind) n++;
    return n;
  }

  // ------------------------------------------------------------------ placement
  private clear(p: V3, margin = 0): boolean {
    const d = this.sys.def;
    if (vdist(p, d.station.pos) < SAFE_ZONE_RADIUS + 1500 + margin) return false;
    if (vdist(p, d.star.pos) < d.star.radius * 4) return false;
    for (const pl of d.planets) if (vdist(p, pl.center) < pl.radius * 3 + 1500 + margin) return false;
    for (const f of d.fields) if (vdist(p, f.center) < f.radius + 1200 + margin) return false;
    for (const g of d.gates) if (vdist(p, g.pos) < 2500) return false;
    for (const o of this.pois.values()) if (vdist(p, v3(o.pos[0], o.pos[1], o.pos[2])) < 5000) return false;
    return true;
  }

  private openSpot(minD: number, maxD: number): V3 | null {
    const st = this.sys.def.station.pos, r = this.rng;
    for (let i = 0; i < 300; i++) {
      const a = r.range(0, Math.PI * 2), d = r.range(minD, maxD);
      const p = v3(st.x + Math.cos(a) * d, st.y + r.range(-2500, 2500), st.z + Math.sin(a) * d);
      if (this.clear(p)) return p;
    }
    return null;
  }

  private pathClear(a: V3, b: V3): boolean {
    for (let k = 0; k <= 20; k++) {
      const t = k / 20;
      const p = v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
      for (const pl of this.sys.def.planets) if (vdist(p, pl.center) < pl.radius * 2.6) return false;
      if (vdist(p, this.sys.def.station.pos) < SAFE_ZONE_RADIUS + 800) return false;
      for (const f of this.sys.def.fields) if (vdist(p, f.center) < f.radius + 400) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ spawning
  private announce(text: string, sub: string, kind: 'info' | 'warn' | 'good' = 'info') {
    this.sys.events.push({ t: 'announce', text, sub, kind });
  }

  private addPoi(kind: PoiKind, name: string, pos: V3, radius: number, life: number, extra: Partial<PoiState> = {}): PoiState {
    const poi: PoiState = {
      id: this.sys.nextId(), kind, name, pos: [pos.x, pos.y, pos.z], radius, until: this.sys.time + life, seed: this.rng.int(0, 1e9),
      escorts: [], done: new Set(), ...extra,
    };
    this.pois.set(poi.id, poi);
    this.dirty = true;
    return poi;
  }

  spawn(kind: PoiKind, at?: { p: V3; dir: V3 }): PoiState | null {
    if (kind === 'wreck') {
      const p = at ? at.p : this.openSpot(8000, 26000);
      if (!p) return null;
      const poi = this.addPoi('wreck', `Обломки «${makeName(this.rng)}»`, p, 70, 900, { charges: this.rng.int(3, 5) });
      this.announce('Сигнал бедствия', `${poi.name}: можно разобрать на запчасти`);
      return poi;
    }
    if (kind === 'anomaly') {
      const p = at ? at.p : this.openSpot(10000, 28000);
      if (!p) return null;
      const poi = this.addPoi('anomaly', `Аномалия ${makeName(this.rng)}`, p, 300, 420);
      this.announce('Зафиксирована аномалия', `${poi.name}: влетите внутрь, чтобы просканировать`);
      return poi;
    }
    return this.spawnConvoy(at);
  }

  private spawnConvoy(at?: { p: V3; dir: V3 }): PoiState | null {
    let route: V3[] | null = null;
    if (at) {
      const d = at.dir;
      route = [at.p, v3(at.p.x + d.x * 22000, at.p.y + d.y * 22000, at.p.z + d.z * 22000)];
    } else {
      for (let i = 0; i < 60 && !route; i++) {
        const a = this.openSpot(14000, 30000);
        const b = this.openSpot(14000, 34000);
        if (a && b && vdist(a, b) > 16000 && vdist(a, b) < 30000 && this.pathClear(a, b)) route = [a, b];
      }
    }
    if (!route) return null;
    const [start, end] = route;
    const dir = vnorm(v3(), vsub(v3(), end, start));
    const q = qlook(quat(), dir, v3(0, 1, 0));
    const rng = this.rng;
    const brain = new NpcBrain(start, 500, new Rng(rng.int(0, 1e9)));
    brain.role = 'hauler';
    brain.route = [end];
    const f: ShipEntity = {
      id: this.sys.nextId(), name: `Грузовик «${makeName(rng)}»`, bp: freighterBlueprint(rng.int(0, 1e9)),
      state: newShip(start, q), world: newPose(), flight: FREIGHTER_FLIGHT, combat: FREIGHTER_COMBAT,
      hull: FREIGHTER_COMBAT.maxHull, shield: FREIGHTER_COMBAT.maxShield, energy: 100, lastHit: -99, fireCooldown: 0, gun: 0,
      throttle: 0, boosting: false, dead: false, respawnAt: 0, docked: false, god: false, session: null,
      npc: brain, lastInput: emptyInput(), transient: true, bounty: EVENT_REWARD.freighterBounty,
    };
    this.sys.addNpc(f);
    const poi = this.addPoi('convoy', `Конвой: ${f.name}`, start, 300, Math.ceil(vdist(start, end) / FREIGHTER_FLIGHT.maxSpeed) + 180, { ship: f.id });
    for (const slot of ESCORT_SLOTS) {
      const o = qrot(v3(), q, slot);
      const e = this.sys.spawnPirate(v3(start.x + o.x, start.y + o.y, start.z + o.z));
      e.name = `Эскорт ${makeName(rng)}`;
      e.transient = true;
      e.state.q = { ...q };
      e.npc!.role = 'escort';
      e.npc!.guard = f.id;
      e.npc!.slot = slot;
      poi.escorts.push(e.id);
    }
    this.announce('Пиратский конвой', `${f.name} с охраной идёт через систему — груз достанется тому, кто его остановит`, 'warn');
    return poi;
  }

  // ------------------------------------------------------------------ hooks
  /** A convoy freighter got shot: its escorts turn on the attacker. */
  onHit(target: ShipEntity, attacker: number) {
    if (target.npc?.role !== 'hauler') return;
    const a = this.sys.ships.get(attacker);
    if (!a || a.npc) return;
    for (const poi of this.pois.values()) {
      if (poi.ship !== target.id) continue;
      for (const id of poi.escorts) {
        const e = this.sys.ships.get(id);
        if (e?.npc && e.npc.state !== 'flee') { e.npc.target = attacker; e.npc.state = 'attack'; }
      }
    }
  }

  onKill(target: ShipEntity, killer?: ShipEntity) {
    for (const poi of this.pois.values()) {
      if (poi.kind !== 'convoy' || poi.ship !== target.id) continue;
      if (killer?.session) this.sys.contracts.onFreighterKill(killer.session, poi.id);
      poi.ship = 0;
      poi.name = 'Обломки конвоя';
      poi.until = this.sys.time + 240;
      this.dirty = true;
      this.spill(target);
      this.announce('Грузовик уничтожен', 'Контейнеры с грузом дрейфуют на месте боя — соберите их', 'good');
    }
  }

  private spill(f: ShipEntity) {
    const r = this.rng, t = this.sys.time;
    const n = r.int(7, 10);
    for (let i = 0; i < n; i++) {
      const roll = r.float();
      const cargo: Partial<Cargo> = {};
      let credits = 0;
      if (roll < 0.45) cargo.ore = r.int(2, 4);
      else if (roll < 0.78) cargo.crystal = r.int(1, 3);
      else if (roll < 0.93) cargo.relic = 1;
      else credits = r.int(80, 180);
      const dir = vnorm(v3(), v3(r.range(-1, 1), r.range(-1, 1), r.range(-1, 1)));
      const sp = r.range(4, 14);
      const l: Loot = {
        id: this.sys.nextId(),
        p: v3(f.world.p.x + dir.x * r.range(5, 30), f.world.p.y + dir.y * r.range(5, 30), f.world.p.z + dir.z * r.range(5, 30)),
        v: v3(f.world.v.x * 0.3 + dir.x * sp, f.world.v.y * 0.3 + dir.y * sp, f.world.v.z * 0.3 + dir.z * sp),
        contents: { credits, cargo }, until: t + 240,
      };
      this.loot.set(l.id, l);
      this.sys.infos.push({ id: l.id, kind: KIND.LOOT, name: 'Контейнер' });
    }
  }

  // ------------------------------------------------------------------ rewards
  /** Gives as much of `c` as fits; returns what was actually taken (null if nothing). */
  private grant(s: Session, c: LootContents): LootContents | null {
    const cap = combatStats(s.pilot.upgrades, s.pilot.ship).cargoCap;
    let free = cap - cargoCount(s.pilot.cargo);
    const got: LootContents = { credits: c.credits, cargo: {} };
    for (const k of ['relic', 'crystal', 'ore'] as const) {
      const n = Math.min(free, c.cargo[k] ?? 0);
      if (n > 0) { s.pilot.cargo[k] += n; got.cargo[k] = n; free -= n; }
    }
    if (!got.credits && !Object.keys(got.cargo).length) return null;
    s.pilot.credits += got.credits;
    s.sendPilot();
    return got;
  }

  private cargoFull(s: Session) {
    const last = this.fullMsg.get(s.id) ?? -99;
    if (this.sys.time - last < 5) return;
    this.fullMsg.set(s.id, this.sys.time);
    s.msg('Трюм полон — продайте груз на станции', 'warn');
  }

  salvage(s: Session, id: number): string | null {
    const poi = this.pois.get(id);
    if (!poi || poi.kind !== 'wreck' || !poi.charges) return 'Здесь больше нечего брать';
    const ship = s.ship;
    if (vdist(ship.world.p, v3(poi.pos[0], poi.pos[1], poi.pos[2])) > SALVAGE_RANGE) return 'Подлетите ближе к обломкам';
    if (vlen(ship.world.v) > SALVAGE_MAX_SPEED) return 'Сбросьте скорость для разбора';
    if (poi.done.has(s.pilot.id)) return 'Вы уже обыскали эти обломки';
    const r = this.rng;
    const got = this.grant(s, { credits: r.int(EVENT_REWARD.salvageCredits[0], EVENT_REWARD.salvageCredits[1]), cargo: { relic: 1, crystal: r.int(0, 2) } });
    if (!got) return 'Трюм полон';
    poi.done.add(s.pilot.id);
    poi.charges--;
    if (!poi.charges) poi.until = Math.min(poi.until, this.sys.time + 25);
    this.dirty = true;
    const p = ship.world.p;
    s.sendJson(MSG.EVENTS, { ev: [{ t: 'loot', text: `Добыто из обломков: ${describeLoot(got)}`, pos: [p.x, p.y, p.z] }] });
    if (r.chance(0.28)) this.ambush(s, poi);
    return null;
  }

  private ambush(s: Session, poi: PoiState) {
    const p = s.ship.world.p;
    const dir = vnorm(v3(), v3(this.rng.range(-1, 1), this.rng.range(-0.3, 0.3), this.rng.range(-1, 1)));
    for (let i = 0; i < 2; i++) {
      const at = v3(p.x + dir.x * 1400 + i * 60, p.y + dir.y * 1400 + 40 * i, p.z + dir.z * 1400);
      const e = this.sys.spawnPirate(at);
      e.transient = true;
      e.state.q = qlook(quat(), vnorm(v3(), vsub(v3(), p, at)), v3(0, 1, 0));
      e.npc!.home = v3(poi.pos[0], poi.pos[1], poi.pos[2]);
      e.npc!.homeRadius = 900;
      e.npc!.target = s.ship.id;
      e.npc!.state = 'attack';
      this.sys.syncWorld(e);
    }
    s.msg('Засада! Пираты поджидали у обломков', 'warn');
  }

  // ------------------------------------------------------------------ tick
  step(dt: number) {
    const t = this.sys.time;
    for (const kind of ['wreck', 'anomaly', 'convoy'] as PoiKind[]) {
      if (t < this.next[kind]) continue;
      const [a, b] = RESPAWN[kind];
      this.next[kind] = t + this.rng.range(a, b);
      if (this.count(kind) < LIMIT[kind]) this.spawn(kind);
    }

    for (const poi of [...this.pois.values()]) {
      if (poi.kind === 'convoy' && poi.ship) {
        const f = this.sys.ships.get(poi.ship);
        if (f && !f.dead) {
          poi.pos = [f.world.p.x, f.world.p.y, f.world.p.z];
          if (f.npc?.arrived) {
            this.announce('Конвой ушёл', `${f.name} покинул систему`, 'info');
            this.remove(poi);
            continue;
          }
        }
      }
      if (poi.kind === 'anomaly') this.scan(poi, dt);
      if (t > poi.until) this.remove(poi);
    }

    for (const l of this.loot.values()) {
      const k = Math.exp(-0.25 * dt);
      l.v.x *= k; l.v.y *= k; l.v.z *= k;
      l.p.x += l.v.x * dt; l.p.y += l.v.y * dt; l.p.z += l.v.z * dt;
      if (t > l.until) { this.dropLoot(l); continue; }
      for (const s of this.sys.sessions) {
        if (s.mode !== MODE.SHIP || s.ship.dead || vdist(s.ship.world.p, l.p) > 45) continue;
        const got = this.grant(s, l.contents);
        if (!got) { this.cargoFull(s); continue; }
        s.sendJson(MSG.EVENTS, { ev: [{ t: 'loot', text: `Контейнер: ${describeLoot(got)}`, pos: [l.p.x, l.p.y, l.p.z] }] });
        this.dropLoot(l);
        break;
      }
    }

    // Moving convoys: refresh positions on clients about once a second.
    if (this.dirty || (t - this.lastSync > 1 && [...this.pois.values()].some((p) => p.kind === 'convoy' && p.ship))) {
      this.lastSync = t;
      this.dirty = true;
    }
  }

  private dropLoot(l: Loot) {
    this.loot.delete(l.id);
    this.sys.gone.push(l.id);
  }

  private remove(poi: PoiState) {
    this.pois.delete(poi.id);
    this.dirty = true;
    if (poi.kind === 'convoy') {
      // Survivors jump out with the convoy (unless they are busy fighting).
      for (const id of [poi.ship ?? 0, ...poi.escorts]) {
        const e = this.sys.ships.get(id);
        if (!e || e.dead) continue;
        if (id !== poi.ship && e.npc?.state === 'attack') continue;
        this.sys.despawn(e);
      }
    }
    for (const k of [...this.scans.keys()]) if (k.startsWith(`${poi.id}:`)) this.scans.delete(k);
  }

  private scan(poi: PoiState, dt: number) {
    const c = v3(poi.pos[0], poi.pos[1], poi.pos[2]);
    for (const s of this.sys.sessions) {
      const key = `${poi.id}:${s.id}`;
      const inside = s.mode === MODE.SHIP && !s.ship.dead && !isCruising(s.ship.state) && vdist(s.ship.world.p, c) < poi.radius;
      const prev = this.scans.get(key) ?? 0;
      if (!inside || poi.done.has(s.pilot.id)) {
        if (prev > 0) { this.scans.delete(key); s.sendJson(MSG.EVENTS, { ev: [{ t: 'scan', id: poi.id, k: -1 }] }); }
        continue;
      }
      const acc = prev + dt;
      this.scans.set(key, acc);
      if (Math.floor(acc * 4) !== Math.floor(prev * 4)) s.sendJson(MSG.EVENTS, { ev: [{ t: 'scan', id: poi.id, k: Math.min(1, acc / ANOMALY_SCAN_TIME) }] });
      if (acc >= ANOMALY_SCAN_TIME) {
        this.scans.delete(key);
        poi.done.add(s.pilot.id);
        awardTrophy(s, `shard:${this.sys.def.id}`);
        const got = this.grant(s, { credits: EVENT_REWARD.anomalyCredits, cargo: { crystal: 2 } });
        const p = s.ship.world.p;
        s.sendJson(MSG.EVENTS, { ev: [{ t: 'loot', text: `Аномалия просканирована: ${got ? describeLoot(got) : ''}`, pos: [p.x, p.y, p.z] }] });
      }
    }
  }

  /** Dev helper: spawns an event right in front of a ship. */
  devSpawn(kind: PoiKind, ship: ShipEntity): string {
    const f = qrot(v3(), ship.world.q, FWD);
    const d = kind === 'convoy' ? 420 : kind === 'anomaly' ? 900 : 260;
    const p = v3(ship.world.p.x + f.x * d, ship.world.p.y + f.y * d, ship.world.p.z + f.z * d);
    const side = vnorm(v3(), v3(-f.z, 0, f.x));
    return this.spawn(kind, { p, dir: side }) ? 'Событие создано' : 'Не удалось создать событие';
  }
}
