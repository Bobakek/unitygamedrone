import { DT } from '../../shared/constants.ts';
import { FWD, qrot, v3, vdist, vdistSq, vdot, vlen, vnorm, vsub, type V3 } from '../../shared/math/vec.ts';
import { EMP, MINE, MODULES, RAIL, railDamage, railMuzzle, type ModuleKey } from '../../shared/modules.ts';
import { KIND, MODE, MSG, type EntityInfo, type EntityState, type GameEvent } from '../../shared/net/protocol.ts';
import { isCruising } from '../../shared/sim/ship.ts';
import { segmentSphere } from '../../shared/sim/weapons.ts';
import type { ShipEntity } from './entities.ts';
import type { SystemInstance } from './system.ts';

/** A proximity mine floating where it was dropped. */
export interface MineEntity {
  id: number;
  /** Ship that laid it. */
  owner: number;
  p: V3;
  v: V3;
  born: number;
}

const tmp = v3(), fwd = v3();

/** Weapon modules in one system: firing them, the mines in space and their part of the snapshot. */
export class Armory {
  readonly mines = new Map<number, MineEntity>();

  constructor(private sys: SystemInstance) {}

  get time() { return this.sys.time; }

  /** Fires the module in slot `slot` of `ship` (the selected target helps the railgun aim); an error text or null. */
  use(ship: ShipEntity, slot: number, target?: number): string | null {
    const key = ship.mods?.[slot];
    if (!key) return slot === 0 || slot === 1 ? `Слот ${slot + 1} пуст: модули ставят в оружейной на станции` : null;
    if (ship.dead || ship.docked || ship.disabled) return null;
    if (ship.session && ship.session.mode !== MODE.SHIP) return null;
    const def = MODULES[key];
    ship.modReady ??= [];
    if (this.time < (ship.modReady[slot] ?? 0) - 0.05) return null;
    if (ship.state.landed) return 'Сначала взлетите';
    if (isCruising(ship.state)) return 'Модули не работают в крейсерском режиме';
    if (this.sys.inSafeZone(ship.world.p)) return 'Оружие заблокировано в зоне станции';
    if (!this.sys.armed(ship)) return null;
    if ((ship.jamUntil ?? 0) > this.time) return 'Системы оружия заглушены ЭМИ';
    if (ship.energy < def.energy) return 'Не хватает энергии';
    if (key === 'mines' && this.ammo(ship) <= 0) return 'Мины кончились: пополните кассету на станции';
    ship.energy -= def.energy;
    ship.modReady[slot] = this.time + def.cooldown;
    if (key === 'railgun') this.rail(ship, slot, target);
    else if (key === 'mines') this.layMine(ship);
    else this.emp(ship);
    this.tell(ship, slot, key);
    return null;
  }

  /** Mines left: the arena hands out its own magazine (`mineAmmo`), elsewhere it is the pilot's. */
  ammo(ship: ShipEntity): number {
    if (ship.mineAmmo !== undefined) return ship.mineAmmo;
    return ship.session?.pilot.arms.mines ?? 0;
  }

  /** Cooldown and ammo of the slot, to the pilot who fired it. */
  private tell(ship: ShipEntity, slot: number, key: ModuleKey) {
    const s = ship.session;
    if (!s) return;
    const ev: GameEvent = { t: 'module', slot, cd: MODULES[key].cooldown, ammo: key === 'mines' ? this.ammo(ship) : undefined };
    s.sendJson(MSG.EVENTS, { ev: [ev] });
    if (key === 'mines' && ship.mineAmmo === undefined) s.sendPilot();
  }

  // ------------------------------------------------------------------ railgun
  private rail(ship: ShipEntity, slot: number, targetId?: number) {
    const w = ship.world;
    const m = railMuzzle(ship.bp.cls, slot);
    qrot(tmp, w.q, m);
    const p0 = v3(w.p.x + tmp.x, w.p.y + tmp.y, w.p.z + tmp.z);
    qrot(fwd, w.q, FWD);
    // aim assist: a selected target close to the nose is struck dead centre
    const t = targetId ? this.sys.ships.get(targetId) : undefined;
    if (t && t !== ship && !t.dead && !t.docked) {
      vsub(tmp, t.world.p, p0);
      const d = vlen(tmp);
      if (d < RAIL.range && d > 1 && vdot(tmp, fwd) / d > Math.cos(RAIL.assist)) vnorm(fwd, tmp);
    }
    const p1 = v3(p0.x + fwd.x * RAIL.range, p0.y + fwd.y * RAIL.range, p0.z + fwd.z * RAIL.range);
    let hit: ShipEntity | null = null, best = 2;
    for (const o of this.sys.ships.values()) {
      if (o === ship || o.dead || o.docked) continue;
      const tt = segmentSphere(p0, p1, o.world.p, o.flight.radius + 2.5);
      if (tt >= 0 && tt < best) { best = tt; hit = o; }
    }
    const cover = this.sys.cover(p0, p1);
    if (cover >= 0 && cover < best) { best = cover; hit = null; }
    const end = best <= 1 ? v3(p0.x + (p1.x - p0.x) * best, p0.y + (p1.y - p0.y) * best, p0.z + (p1.z - p0.z) * best) : p1;
    this.sys.events.push({ t: 'rail', by: ship.id, from: [p0.x, p0.y, p0.z], to: [end.x, end.y, end.z], hit: hit?.id ?? (best <= 1 ? -1 : 0) });
    if (hit) {
      const lvl = ship.session ? ship.session.pilot.upgrades.weapons : ship.npc ? 1 : 2;
      this.sys.damage(hit, railDamage(lvl), ship.id, end, { shield: RAIL.shieldMul, hull: RAIL.hullMul });
    }
  }

  // ------------------------------------------------------------------ mines
  private layMine(ship: ShipEntity) {
    if (ship.mineAmmo !== undefined) ship.mineAmmo--;
    else if (ship.session) ship.session.pilot.arms.mines--;
    const w = ship.world;
    qrot(fwd, w.q, FWD);
    const back = ship.flight.radius + 3;
    const id = this.sys.nextId();
    const mine: MineEntity = {
      id, owner: ship.id, born: this.time,
      p: v3(w.p.x - fwd.x * back, w.p.y - fwd.y * back, w.p.z - fwd.z * back),
      v: v3(w.v.x - fwd.x * MINE.toss, w.v.y - fwd.y * MINE.toss, w.v.z - fwd.z * MINE.toss),
    };
    this.mines.set(id, mine);
    this.sys.infos.push(this.info(mine));
    // only so many mines of one pilot at a time: the oldest one goes off harmlessly
    const own = [...this.mines.values()].filter((m) => m.owner === ship.id);
    if (own.length > MINE.maxLive) this.remove(own[0], true);
  }

  info(m: MineEntity): EntityInfo {
    return { id: m.id, kind: KIND.MINE, name: 'Мина', owner: m.owner };
  }

  private remove(m: MineEntity, fizzle: boolean) {
    this.mines.delete(m.id);
    this.sys.gone.push(m.id);
    if (fizzle) this.sys.events.push({ t: 'boom', id: m.id, pos: [m.p.x, m.p.y, m.p.z], big: false });
  }

  /** A mine goes off: everything hostile to its owner within the blast takes damage, falling off to 40% at the edge. */
  private detonate(m: MineEntity, owner: ShipEntity | undefined) {
    this.mines.delete(m.id);
    this.sys.gone.push(m.id);
    this.sys.events.push({ t: 'blast', id: m.id, pos: [m.p.x, m.p.y, m.p.z], r: MINE.blast });
    if (!owner) return;
    for (const o of [...this.sys.ships.values()]) {
      if (o === owner || o.dead || o.docked || !this.sys.hostile(owner, o)) continue;
      const d = vdist(o.world.p, m.p) - o.flight.radius;
      if (d > MINE.blast) continue;
      const k = 1 - 0.6 * Math.max(0, d) / MINE.blast;
      this.sys.damage(o, MINE.damage * k, owner.id, o.world.p);
    }
  }

  step() {
    const t = this.time;
    for (const m of [...this.mines.values()]) {
      const drag = Math.exp(-MINE.drag * DT);
      m.v.x *= drag; m.v.y *= drag; m.v.z *= drag;
      m.p.x += m.v.x * DT; m.p.y += m.v.y * DT; m.p.z += m.v.z * DT;
      const owner = this.sys.ships.get(m.owner);
      if (t - m.born > MINE.life || !owner) { this.remove(m, true); continue; }
      if (t - m.born < MINE.arm) continue;
      for (const o of this.sys.ships.values()) {
        if (o === owner || o.dead || o.docked || o.disabled) continue;
        const r = MINE.trigger + o.flight.radius;
        if (vdistSq(o.world.p, m.p) > r * r || !this.sys.hostile(owner, o)) continue;
        this.detonate(m, owner);
        break;
      }
    }
  }

  // ------------------------------------------------------------------ EMP
  private emp(ship: ShipEntity) {
    const p = ship.world.p;
    const hit: number[] = [];
    for (const o of [...this.sys.ships.values()]) {
      if (o === ship || o.dead || o.docked || !this.sys.hostile(ship, o)) continue;
      if (vdist(o.world.p, p) - o.flight.radius > EMP.radius) continue;
      hit.push(o.id);
      // shields collapse and stay down; the guns and modules go quiet for a moment
      o.shield = Math.max(0, o.shield - EMP.shield);
      o.jamUntil = this.time + EMP.jam;
      this.sys.damage(o, EMP.hull, ship.id, o.world.p);
      o.lastHit = Math.max(o.lastHit, this.time + EMP.shieldLock - 3);
      if (o.session && o !== ship) o.session.msg('ЭМИ-удар: щит пробит, оружие заглушено', 'warn');
    }
    // hostile missiles and mines in the pulse burn out
    for (const mi of [...this.sys.missiles.values()]) {
      const by = this.sys.ships.get(mi.owner);
      if (by && by !== ship && this.sys.hostile(ship, by) && vdist(mi.p, p) < EMP.radius) {
        this.sys.missiles.delete(mi.id);
        this.sys.gone.push(mi.id);
        this.sys.events.push({ t: 'boom', id: mi.id, pos: [mi.p.x, mi.p.y, mi.p.z], big: false });
      }
    }
    for (const m of [...this.mines.values()]) {
      const by = this.sys.ships.get(m.owner);
      if (m.owner !== ship.id && (!by || this.sys.hostile(ship, by)) && vdist(m.p, p) < EMP.radius) this.remove(m, true);
    }
    this.sys.events.push({ t: 'emp', id: ship.id, pos: [p.x, p.y, p.z], r: EMP.radius, hit });
  }

  // ------------------------------------------------------------------ net
  infos(out: EntityInfo[]) {
    for (const m of this.mines.values()) out.push(this.info(m));
  }

  entities(focus: V3, r2: number, out: EntityState[]) {
    for (const m of this.mines.values()) {
      if (vdistSq(m.p, focus) > r2) continue;
      const armed = this.time - m.born >= MINE.arm ? 1 : 0;
      out.push({ id: m.id, kind: KIND.MINE, flags: 0, frame: 0, px: m.p.x, py: m.p.y, pz: m.p.z, qx: 0, qy: 0, qz: 0, qw: 1, vx: m.v.x, vy: m.v.y, vz: m.v.z, hull: 1, shield: 0, throttle: armed });
    }
  }

  /** Everything goes (a new arena round). */
  clear() {
    for (const m of [...this.mines.values()]) this.remove(m, false);
  }
}
