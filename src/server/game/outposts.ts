import {
  BASE_BOUNTY, GENERATOR_COMBAT, GENERATOR_FLIGHT, TURRET_COMBAT, TURRET_FLIGHT,
} from '../../shared/economy.ts';
import {
  baseKey, basePocket, BUNKER, CAPTURE_BOUNTY, DEPOT_CAP, DEPOT_EVERY, DOOR_REACH, FIRST_WAVE, GARRISON, GENERATOR, HOLD_TIME, PAD_FUEL_EVERY,
  PAD_R, PAD_REPAIR, REBUILD, WAVE_EVERY, waveSize, type BaseInfo, type BaseState,
} from '../../shared/base-assault.ts';
import { makeName } from '../../shared/galaxy/names.ts';
import { tankOf } from '../../shared/jump.ts';
import { hashInts, Rng } from '../../shared/math/rng.ts';
import { qlook, quat, v3, vdist, vnorm, vsub, type V3 } from '../../shared/math/vec.ts';
import { MODE } from '../../shared/net/protocol.ts';
import { footHeight } from '../../shared/planet/terrain.ts';
import { planetSites, siteDir, sitePlane, TURRET_HEIGHT, TURRET_RANGE, type SiteDef } from '../../shared/planet/sites.ts';
import { newPose, planetRot, toBodyQuat, toWorldPoint } from '../../shared/sim/frames.ts';
import { emptyInput, newShip } from '../../shared/sim/ship.ts';
import { LASER, leadPoint } from '../../shared/sim/weapons.ts';
import { generatorBlueprint, turretBlueprint } from '../../shared/ships/blueprint.ts';
import { cargoCount } from '../../shared/economy.ts';
import type { Hulk } from './boarding.ts';
import type { ShipEntity } from './entities.ts';
import { NpcBrain } from './npc.ts';
import type { Session } from './session.ts';
import type { SystemInstance } from './system.ts';
import { awardTrophy } from './trophies.ts';

/** A flak tower (slot 0–2) or the shield generator (gen) of a base. */
interface Tower { base: Base; slot: number; gen: boolean; ship: ShipEntity | null; respawnAt: number; burst: number; cool: number }

interface Base {
  site: SiteDef; key: number; towers: Tower[]; state: BaseState;
  /** Held: captors, when it goes back, the next counterattack, how many came so far, raiders alive, next depot top-up. */
  owners: string[]; until: number; nextWave: number; waves: number; raiders: ShipEntity[]; depotAt: number;
  /** Pilots being serviced on the pad (last fuel cell given at). */
  pad: Map<Session, number>;
}

const TURRET_RESPAWN = 600;
const BURST = 3;
const aim = v3(), up = v3(), dir = v3(), wq = quat(), rot = quat();

/**
 * Pirate outposts on planet surfaces. Each base has three flak towers (static NPC "ships"
 * parked in the planet's body frame) that shoot at pilots flying nearby, and a shield
 * generator that seals its command bunker. Silencing all of them pays a bounty and opens
 * the bunker for a few minutes: a pilot on foot can storm it (boarding.ts) and take the
 * base at its command console. A held base turns its towers against the pirates, fills its
 * depot, services its captors' ships on the pad and has to be defended against raids until
 * the Syndicate gets it back (see shared/base-assault.ts for the rules).
 */
export class Outposts {
  private bases: Base[] = [];
  private rng: Rng;
  private infoKey = '';

  constructor(private sys: SystemInstance) {
    this.rng = new Rng(hashInts(sys.def.seed, 0x7a11));
    for (const pl of sys.def.planets) {
      for (const site of planetSites(pl)) {
        if (site.kind !== 'base') continue;
        const b: Base = {
          site, key: baseKey(pl.index, site.id), towers: [], state: 'pirate',
          owners: [], until: 0, nextWave: 0, waves: 0, raiders: [], depotAt: 0, pad: new Map(),
        };
        site.turrets.forEach((_, slot) => b.towers.push({ base: b, slot, gen: false, ship: null, respawnAt: 0, burst: 0, cool: this.rng.range(0, 2) }));
        b.towers.push({ base: b, slot: -1, gen: true, ship: null, respawnAt: 0, burst: 0, cool: 0 });
        for (const t of b.towers) this.spawn(t);
        this.bases.push(b);
      }
    }
  }

  private spawn(t: Tower) {
    const site = t.base.site, held = t.base.state === 'held';
    const pl = this.sys.def.planets[site.planet];
    let p: V3, d: V3;
    if (t.gen) {
      d = siteDir(pl, site, GENERATOR.x, GENERATOR.z);
      const r = pl.radius + footHeight(pl, d.x, d.y, d.z) + GENERATOR.h * 0.45;
      p = v3(d.x * r, d.y * r, d.z * r);
    } else {
      const tp = site.turrets[t.slot];
      d = tp.dir;
      const r = pl.radius + tp.h + TURRET_HEIGHT + 1.6;
      p = v3(d.x * r, d.y * r, d.z * r);
    }
    const q = qlook(quat(), vnorm(v3(), site.east), d);
    const brain = new NpcBrain(v3(), 0, new Rng(this.rng.int(0, 1e9)));
    brain.role = 'turret';
    const flight = t.gen ? GENERATOR_FLIGHT : TURRET_FLIGHT, combat = t.gen ? GENERATOR_COMBAT : TURRET_COMBAT;
    const seed = this.rng.int(0, 1e9);
    const ship: ShipEntity = {
      id: this.sys.nextId(), name: t.gen ? (held ? 'Генератор щита базы' : 'Генератор щита') : held ? 'Турель базы' : 'Турель',
      bp: t.gen ? generatorBlueprint(seed, held) : turretBlueprint(seed, held),
      state: newShip(p, q), world: newPose(), flight, combat,
      hull: combat.maxHull, shield: combat.maxShield, energy: 100, lastHit: -99, fireCooldown: 0, gun: 0,
      throttle: 0, boosting: false, dead: false, respawnAt: 0, docked: false, god: false, session: null,
      npc: brain, lastInput: emptyInput(), transient: true, bounty: t.gen ? 160 : 110, base: t.base.key,
    };
    ship.state.frame = ship.state.landed = pl.index + 1;
    t.ship = ship;
    this.sys.addNpc(ship);
  }

  private baseOf(planet: number, site: number): Base | undefined {
    return this.bases.find((b) => b.site.planet === planet && b.site.id === site);
  }

  /** World position of a point of a site at the current time. */
  private siteWorld(site: SiteDef, x: number, z: number, lift: number, out: V3): V3 {
    const pl = this.sys.def.planets[site.planet];
    const d = siteDir(pl, site, x, z);
    const r = pl.radius + footHeight(pl, d.x, d.y, d.z) + lift;
    return toWorldPoint(pl, planetRot(pl, this.sys.time, rot), v3(d.x * r, d.y * r, d.z * r), out);
  }

  /** Called when any NPC dies; handles towers and raiders. */
  onKill(target: ShipEntity, killer: ShipEntity | undefined) {
    for (const b of this.bases) {
      const i = b.raiders.indexOf(target);
      if (i >= 0) b.raiders.splice(i, 1);
    }
    const t = this.towers().find((x) => x.ship === target);
    if (!t) return;
    const b = t.base;
    t.ship = null;
    if (b.state === 'held') {
      t.respawnAt = this.sys.time + REBUILD;
      this.checkLost(b);
      return;
    }
    t.respawnAt = this.sys.time + TURRET_RESPAWN;
    if (killer?.session && !t.gen) this.sys.contracts.onTurretKill(killer.session, b.site.planet, b.site.id);
    if (t.gen) this.sys.events.push({ t: 'announce', text: 'Генератор щита уничтожен', sub: `${b.site.name}: силовой купол над бункером погас${this.standing(b) ? ` — осталось турелей: ${this.standing(b)}` : ''}`, kind: 'good' });
    if (b.towers.some((x) => x.ship)) { this.changed(); return; }
    // everything down: the bunker is open for a while
    b.state = 'open';
    const s = killer?.session;
    const share = s ? this.sys.reward(s, target.world.p, BASE_BOUNTY, 'База подавлена') : 0;
    const who = s ? (s.group ? `группа ${s.pilot.name}` : s.pilot.name) : '';
    this.sys.events.push({ t: 'announce', text: 'Пиратская база подавлена', sub: `${b.site.name}${s ? ` — ${who} получает ${share === BASE_BOUNTY ? BASE_BOUNTY : `по ${share}`} кр` : ''}. Бункер открыт: приземлитесь и идите на штурм`, kind: 'good' });
    this.changed();
  }

  /** Pirate towers (not the generator) still standing. */
  private standing(b: Base): number {
    return b.towers.filter((t) => !t.gen && t.ship).length;
  }

  private towers(): Tower[] {
    return this.bases.flatMap((b) => b.towers);
  }

  /** Sites whose towers and generator are all down (for HUD / tests). */
  silenced(site: SiteDef): boolean {
    return !this.towers().some((t) => t.base.site === site && t.ship);
  }

  /** Standing towers (and generator) of a site. */
  towersOf(site: SiteDef): ShipEntity[] {
    return this.towers().filter((t) => t.base.site === site && t.ship).map((t) => t.ship!);
  }

  state(planet: number, site: number): BaseState | null {
    return this.baseOf(planet, site)?.state ?? null;
  }

  // ------------------------------------------------------------------ the bunker
  /** Does `s` (or their group) hold the base? */
  private owns(b: Base, s: Session): boolean {
    if (b.owners.includes(s.pilot.name)) return true;
    for (const o of this.sys.sessions) if (b.owners.includes(o.pilot.name) && this.sys.allies(s, o)) return true;
    return false;
  }

  /** A pilot on foot at a base's blast door goes down into the bunker. */
  enter(s: Session): string | null {
    const c = s.char;
    if (s.mode !== MODE.FOOT || !c || c.planet < 0) return null;
    const pl = this.sys.def.planets[c.planet];
    const l = Math.hypot(c.state.p.x, c.state.p.y, c.state.p.z) || 1;
    const b = this.bases.find((x) => x.site.planet === c.planet && (x.site.dir.x * c.state.p.x + x.site.dir.y * c.state.p.y + x.site.dir.z * c.state.p.z) / l > Math.cos(200 / pl.radius));
    if (!b) return 'Рядом нет пиратской базы';
    const q = sitePlane(pl, b.site, c.state.p);
    if (Math.hypot(q.x - BUNKER.door.x, q.z - BUNKER.door.z) > DOOR_REACH) return 'Подойдите к двери бункера';
    if (b.state === 'held' && !this.owns(b, s)) return 'Эту базу удерживает другой пилот';
    if (b.state === 'pirate') {
      const gen = b.towers.find((t) => t.gen)?.ship, n = this.standing(b);
      if (gen) return 'Дверь закрыта силовым куполом: уничтожьте генератор щита базы';
      return `Бункер заблокирован, пока стреляют турели: осталось ${n}`;
    }
    let h = this.sys.boarding.bunker(b.site.planet, b.site.id);
    if (!h) h = this.sys.boarding.openBunker(b.site.planet, b.site.id, this.pocket(b));
    this.sys.boarding.enter(s, h);
    const alive = h.crew.filter((x) => !x.dead).length;
    if (b.state === 'held') s.msg(`Бункер базы ${b.site.name}. Склад — налево по галерее, пульт — в конце`, 'info');
    else s.msg(alive ? `Бункер базы ${b.site.name}: гарнизон — ${alive} чел. Пульт захвата — в командном пункте в конце галереи` : `Бункер базы ${b.site.name}: гарнизона нет. Пульт — в командном пункте`, alive ? 'warn' : 'info');
    // nobody rebuilds the towers while the bunker is being stormed
    this.changed();
    return null;
  }

  private pocket(b: Base): { p: V3; q: { x: number; y: number; z: number; w: number } } {
    return { p: basePocket(this.sys.def.station.pos, b.site.planet, b.site.id, v3()), q: { x: 0, y: 0, z: 0, w: 1 } };
  }

  /** Where a pilot coming out of the bunker stands: in front of the blast door, facing the yard. */
  exitPoint(planet: number, site: number): { p: V3; f: V3 } {
    const pl = this.sys.def.planets[planet];
    const s = planetSites(pl)[site];
    const d = siteDir(pl, s, BUNKER.door.x - 1.6, BUNKER.door.z);
    const g = pl.radius + footHeight(pl, d.x, d.y, d.z) + 0.05;
    return { p: v3(d.x * g, d.y * g, d.z * g), f: v3(-s.east.x, -s.east.y, -s.east.z) };
  }

  /** The garrison is down and `s` is at the console: the base changes hands. */
  capture(s: Session, planet: number, site: number): string | null {
    const b = this.baseOf(planet, site);
    if (!b || b.state !== 'open') return 'Базу сейчас не захватить';
    const t = this.sys.time;
    const at = this.siteWorld(b.site, 0, 0, 2, v3());
    const crew = this.sys.crew(s, at);
    // whoever stormed the bunker with them counts too
    const h = this.sys.boarding.bunker(planet, site);
    for (const o of h?.boarders ?? []) if (!crew.includes(o)) crew.push(o);
    b.state = 'held';
    b.owners = [...new Set([s.pilot.name, ...crew.map((m) => m.pilot.name)])];
    b.until = t + HOLD_TIME;
    b.nextWave = t + FIRST_WAVE;
    b.waves = 0;
    b.depotAt = t + DEPOT_EVERY;
    // the old towers' wreckage gets patched up in the captors' colours
    for (const tw of b.towers) tw.respawnAt = t + (tw.gen ? 30 : 20);
    this.sys.reward(s, at, CAPTURE_BOUNTY, 'База захвачена');
    for (const m of new Set([s, ...crew])) if (awardTrophy(m, `relic:${this.sys.def.id}:${planet}:${site}`)) m.sendPilot();
    const who = b.owners.length > 1 ? `группа ${s.pilot.name}` : s.pilot.name;
    this.sys.events.push({ t: 'announce', text: 'Пиратская база захвачена', sub: `${b.site.name} — теперь её держит ${who}. Пираты попытаются её отбить`, kind: 'good' });
    for (const m of crew) {
      m.msg(`База ваша на ${Math.round(HOLD_TIME / 60)} мин: турели перейдут на вашу сторону, склад в бункере пополняется добычей, корабль на площадке чинится и заправляется. Отбивайтесь от налётов: если пираты собьют все турели, база потеряна`, 'good');
    }
    this.changed();
    return null;
  }

  /** The pirates take the base back: the bunker is lost, fresh pirate towers and garrison. */
  private revert(b: Base, text: string, sub: string) {
    b.state = 'pirate';
    b.owners = [];
    b.pad.clear();
    for (const r of b.raiders) if (r.npc) { r.npc.home = { ...r.world.p }; r.npc.homeRadius = 1500; }
    b.raiders = [];
    const h = this.sys.boarding.bunker(b.site.planet, b.site.id);
    if (h) this.sys.boarding.closeBunker(h, 'Пираты вернули базу: лифт поднял вас наверх');
    for (const tw of b.towers) {
      if (tw.ship) { const sh = tw.ship; tw.ship = null; this.sys.despawn(sh); }
      this.spawn(tw);
    }
    this.sys.events.push({ t: 'announce', text, sub, kind: 'warn' });
    this.changed();
  }

  /** A held base whose towers all fell while raiders are about is lost. */
  private checkLost(b: Base) {
    if (b.state !== 'held' || this.standing(b)) { this.changed(); return; }
    if (!b.raiders.some((r) => !r.dead)) { this.changed(); return; }
    this.revert(b, 'Пираты отбили базу', `${b.site.name}: все турели сбиты, Синдикат вернул себе базу`);
  }

  // ------------------------------------------------------------------ simulation
  step(dt: number) {
    const t = this.sys.time;
    for (const b of this.bases) {
      if (b.state === 'held') this.hold(b, dt);
      // towers are not rebuilt while someone storms the bunker
      const storming = b.state === 'open' && !!this.sys.boarding.bunker(b.site.planet, b.site.id)?.boarders.size;
      for (const tw of b.towers) {
        if (!tw.ship) {
          if (storming) tw.respawnAt = Math.max(tw.respawnAt, t + 30);
          if (t >= tw.respawnAt) {
            this.spawn(tw);
            if (b.state === 'open') { b.state = 'pirate'; this.sys.events.push({ t: 'announce', text: 'Пираты восстановили оборону', sub: `${b.site.name}: бункер снова закрыт`, kind: 'warn' }); }
            this.changed();
          }
          continue;
        }
        if (!tw.gen) this.aimAndFire(tw, dt);
      }
    }
    if (this.sys.ticks % 30 === 0) this.changed();
  }

  private aimAndFire(tw: Tower, dt: number) {
    const ship = tw.ship!, t = this.sys.time;
    ship.fireCooldown -= dt;
    tw.cool -= dt;
    const target = tw.base.state === 'held' ? this.pickPirate(ship) : this.pick(ship);
    if (!target) { tw.burst = 0; return; }
    // aim with lead, plus a little scatter so fast flying beats the guns
    leadPoint(ship.world.p, ship.world.v, target.world.p, target.world.v, LASER.speed, aim);
    const sp = 7 + vdist(aim, ship.world.p) * 0.012;
    aim.x += this.rng.range(-sp, sp); aim.y += this.rng.range(-sp, sp); aim.z += this.rng.range(-sp, sp);
    const pl = this.sys.def.planets[ship.state.frame - 1];
    vnorm(up, vsub(up, ship.world.p, pl.center));
    qlook(wq, vnorm(dir, vsub(dir, aim, ship.world.p)), up);
    toBodyQuat(planetRot(pl, t, rot), wq, ship.state.q);
    this.sys.syncWorld(ship);
    if (tw.cool > 0) return;
    if (ship.fireCooldown <= 0) {
      ship.fireCooldown = 0;
      this.sys.tryFire(ship);
      ship.fireCooldown = 0.16;
      if (++tw.burst >= BURST) { tw.burst = 0; tw.cool = this.rng.range(1.1, 1.6); }
    }
  }

  /** Is `p` above the tower's horizon? */
  private above(tower: ShipEntity, p: V3, d: number): boolean {
    const pl = this.sys.def.planets[tower.state.frame - 1];
    vnorm(up, vsub(up, tower.world.p, pl.center));
    vsub(dir, p, tower.world.p);
    return (dir.x * up.x + dir.y * up.y + dir.z * up.z) / (d || 1) >= -0.05;
  }

  /** Nearest player ship in range and above the tower's horizon. */
  private pick(tower: ShipEntity): ShipEntity | null {
    let best: ShipEntity | null = null, bd = TURRET_RANGE;
    for (const s of this.sys.sessions) {
      const sh = s.ship;
      if (s.mode !== MODE.SHIP || sh.dead || sh.docked || sh.god || this.sys.truce(sh)) continue;
      const d = vdist(sh.world.p, tower.world.p);
      if (d >= bd || !this.above(tower, sh.world.p, d)) continue;
      bd = d;
      best = sh;
    }
    return best;
  }

  /** A held base's tower: the nearest pirate in range. */
  private pickPirate(tower: ShipEntity): ShipEntity | null {
    let best: ShipEntity | null = null, bd = TURRET_RANGE;
    for (const sh of this.sys.ships.values()) {
      if (!sh.npc || sh.dead || sh.disabled || sh.bp.cls !== 'pirate') continue;
      const d = vdist(sh.world.p, tower.world.p);
      if (d >= bd || !this.above(tower, sh.world.p, d)) continue;
      bd = d;
      best = sh;
    }
    return best;
  }

  /** A held base: timers, raids, the depot and the pad. */
  private hold(b: Base, dt: number) {
    const t = this.sys.time;
    if (t >= b.until) {
      this.revert(b, 'Пираты вернули базу', `${b.site.name}: срок удержания вышел, гарнизон Синдиката вернулся`);
      return;
    }
    b.raiders = b.raiders.filter((r) => !r.dead && this.sys.ships.get(r.id) === r);
    if (t >= b.nextWave) this.raid(b);
    if (this.sys.ticks % 30 === 0) this.steerRaiders(b);
    if (t >= b.depotAt) {
      b.depotAt = t + DEPOT_EVERY;
      const h = this.sys.boarding.bunker(b.site.planet, b.site.id);
      if (h && cargoCount(h.loot) < DEPOT_CAP) {
        const r = this.rng;
        h.loot.ore += r.int(2, 4); h.loot.crystal += r.int(1, 2); h.loot.bio += r.int(0, 1);
        if (r.float() < 0.2) h.loot.relic++;
        h.credits += r.int(40, 90);
        h.looted = false;
        this.sys.boarding.tellAll(h);
        this.changed();
      }
    }
    this.servicePad(b, dt);
  }

  /** A wave of raiders drops in from above the base. */
  private raid(b: Base) {
    const t = this.sys.time, r = this.rng;
    b.nextWave = t + WAVE_EVERY + r.range(-60, 60);
    const n = waveSize(b.waves++);
    const centre = this.siteWorld(b.site, 0, 0, 900, v3());
    const pl = this.sys.def.planets[b.site.planet];
    const upw = vnorm(v3(), vsub(v3(), centre, pl.center));
    for (let i = 0; i < n; i++) {
      // 2.5 km out, high above the horizon
      const a = r.range(0, Math.PI * 2);
      const side = vnorm(v3(), v3(b.site.east.x * Math.cos(a) + b.site.north.x * Math.sin(a), b.site.east.y * Math.cos(a) + b.site.north.y * Math.sin(a), b.site.east.z * Math.cos(a) + b.site.north.z * Math.sin(a)));
      const p = v3(centre.x + side.x * 2200 + upw.x * 600, centre.y + side.y * 2200 + upw.y * 600, centre.z + side.z * 2200 + upw.z * 600);
      const ship = this.sys.spawnPirate(p, `Налётчик ${makeName(r)}`);
      ship.transient = true;
      if (ship.npc) { ship.npc.home = { ...centre }; ship.npc.homeRadius = 900; }
      b.raiders.push(ship);
    }
    this.steerRaiders(b);
    const owners = [...this.sys.sessions].filter((s) => b.owners.includes(s.pilot.name));
    this.sys.events.push({ t: 'announce', text: 'Пираты идут отбивать базу', sub: `${b.site.name}: налётчиков — ${n}. Если они собьют все турели, база будет потеряна`, kind: 'warn' });
    for (const s of owners) s.msg(`Налёт на базу ${b.site.name}: ${n} пиратов атакуют турели`, 'warn');
    this.changed();
  }

  /** Raiders go for the base's towers, or for its captors flying nearby. */
  private steerRaiders(b: Base) {
    const towers = b.towers.filter((tw) => tw.ship).map((tw) => tw.ship!);
    for (const r of b.raiders) {
      const brain = r.npc;
      if (!brain || r.disabled || brain.state === 'flee') continue;
      const cur = brain.target ? this.sys.ships.get(brain.target) : undefined;
      if (cur && !cur.dead && brain.state === 'attack') continue;
      let best: ShipEntity | null = null, bd = Infinity;
      for (const tw of towers) {
        const d = vdist(tw.world.p, r.world.p);
        if (d < bd) { bd = d; best = tw; }
      }
      if (best) { brain.target = best.id; brain.state = 'attack'; }
    }
  }

  /** Captors' ships landed on the pad get repaired and refuelled. */
  private servicePad(b: Base, dt: number) {
    const pl = this.sys.def.planets[b.site.planet];
    const t = this.sys.time;
    for (const s of this.sys.sessions) {
      const sh = s.ship;
      const on = sh.state.landed === pl.index + 1 && !sh.dead && this.owns(b, s) && (() => {
        const q = sitePlane(pl, b.site, sh.state.p);
        return Math.hypot(q.x, q.z) < PAD_R;
      })();
      if (!on) { b.pad.delete(s); continue; }
      if (!b.pad.has(s)) {
        b.pad.set(s, t);
        s.msg('Площадка базы: ремонт и заправка', 'info');
      }
      const c = sh.combat;
      sh.hull = Math.min(c.maxHull, sh.hull + c.maxHull * PAD_REPAIR * dt);
      sh.shield = Math.min(c.maxShield, sh.shield + c.maxShield * PAD_REPAIR * dt);
      if (t - b.pad.get(s)! >= PAD_FUEL_EVERY && s.pilot.fuel < tankOf(s.pilot.ship)) {
        b.pad.set(s, t);
        s.pilot.fuel++;
        s.sendPilot();
      }
    }
  }

  // ------------------------------------------------------------------ clients
  infos(): BaseInfo[] {
    return this.bases.map((b) => {
      const h = this.sys.boarding.bunker(b.site.planet, b.site.id);
      const info: BaseInfo = {
        planet: b.site.planet, site: b.site.id, name: b.site.name, state: b.state,
        shield: !!b.towers.find((t) => t.gen)?.ship && b.state !== 'held',
        towers: this.standing(b), garrison: h ? h.crew.filter((c) => !c.dead).length : GARRISON + 1,
      };
      if (b.state === 'held') {
        info.owners = b.owners;
        info.until = b.until;
        info.raid = b.raiders.length;
        info.depot = h ? cargoCount(h.loot) : 0;
      }
      return info;
    });
  }

  /** Sends the list to everyone in the system when something they see changed. */
  changed() {
    const list = this.infos();
    const key = JSON.stringify(list);
    if (key === this.infoKey) return;
    this.infoKey = key;
    this.sys.events.push({ t: 'bases', list });
  }

  // ------------------------------------------------------------------ dev
  /** Dev: knocks out the towers and the generator of the nearest base (or a given one). */
  devOpen(s: Session): string {
    const b = this.nearest(s);
    if (!b) return 'В системе нет баз';
    for (const tw of b.towers) if (tw.ship) this.sys.damage(tw.ship, 1e6, s.ship.id);
    return `${b.site.name}: оборона снята`;
  }

  /** Dev: the nearest base becomes `s`'s at once. */
  devCapture(s: Session): string {
    const b = this.nearest(s);
    if (!b) return 'В системе нет баз';
    if (b.state === 'pirate') this.devOpen(s);
    let h = this.sys.boarding.bunker(b.site.planet, b.site.id);
    if (!h) h = this.sys.boarding.openBunker(b.site.planet, b.site.id, this.pocket(b));
    for (const c of h.crew) c.dead = true;
    h.claimed = true;
    return this.capture(s, b.site.planet, b.site.id) ?? `${b.site.name} ваша`;
  }

  /** Dev: the next raid on a held base right now. */
  devRaid(s: Session): string {
    const b = this.bases.find((x) => x.state === 'held' && this.owns(x, s));
    if (!b) return 'У вас нет базы';
    this.raid(b);
    return 'Налёт начался';
  }

  /** Dev: the held base's time runs out. */
  devExpire(s: Session): string {
    const b = this.bases.find((x) => x.state === 'held' && this.owns(x, s));
    if (!b) return 'У вас нет базы';
    b.until = this.sys.time;
    return 'Срок удержания вышел';
  }

  /** Dev: on foot at the blast door of the nearest base. */
  devDoor(s: Session): string {
    const b = this.nearest(s);
    if (!b) return 'В системе нет баз';
    if (s.mode === MODE.BOARD) this.sys.recallPilot(s);
    if (s.char) { this.sys.chars.delete(s.char.id); this.sys.gone.push(s.char.id); s.char = null; }
    const at = this.exitPoint(b.site.planet, b.site.id);
    this.sys.putOnFoot(s, b.site.planet, at.p, at.f);
    return `У двери бункера: ${b.site.name}`;
  }

  private nearest(s: Session): Base | null {
    const at = this.sys.focusOf(s);
    let best: Base | null = null, bd = Infinity;
    for (const b of this.bases) {
      const d = vdist(this.siteWorld(b.site, 0, 0, 0, v3()), at);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  /** Test helper: the bunker hulk of a base. */
  bunkerOf(planet: number, site: number): Hulk | null {
    return this.sys.boarding.bunker(planet, site);
  }
}
