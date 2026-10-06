import {
  BOARD_RANGE, BOARD_SPEED, CREW, DISABLE_HULL, DISABLE_TIME, deckReach, deckSight, deckWaypoint, FLOOR_Y, MAX_PRIZES, PRIZE_NAMES, PRIZE_VALUE,
  SHIP_CHEST, SHIP_DECK, SHIP_HATCH, SHIP_HELM, SHIP_REACH, SHIP_ROOMS, shipRoomAt, type PrizeKind,
} from '../../shared/boarding.ts';
import { BOUNTY, CARGO_NAMES, cargoCount, combatStats, emptyCargo, type Cargo, type CargoKey } from '../../shared/economy.ts';
import { BLASTER } from '../../shared/fauna.ts';
import { makeName } from '../../shared/galaxy/names.ts';
import { hashInts, Rng } from '../../shared/math/rng.ts';
import { qlook, qrot, quat, v3, vdist, vlen, type V3 } from '../../shared/math/vec.ts';
import {
  aimByte, BLASTER_LEVEL, BOARD_FRAME, CFLAG, DRONE_LEVEL, EFLAG, KIND, MODE, MSG, type EntityInfo, type EntityState, type GameEvent,
} from '../../shared/net/protocol.ts';
import { lookCode, type Outfit } from '../../shared/outfit.ts';
import { emptyCharInput, newChar, type CharState } from '../../shared/sim/character.ts';
import { segmentSphere } from '../../shared/sim/weapons.ts';
import { stepDeck } from '../../shared/station/deck.ts';
import { yieldText } from '../../shared/planet/deposits.ts';
import type { CharEntity, ShipEntity } from './entities.ts';
import type { Session } from './session.ts';
import type { SystemInstance } from './system.ts';

/** One of a boarded ship's crew, walking its deck (ship-local deck coordinates). */
export interface CrewMember {
  id: number; name: string; captain: boolean; look: string;
  state: CharState; hp: number; maxHp: number; dead: boolean;
  /** Where they stand until alarmed. */
  post: { x: number; z: number };
  cool: number;
  /** When they first saw the boarder they are fighting (-1: none in sight), and where they last saw one. */
  seen: number; last: { x: number; z: number } | null;
  pitch: number; shotAt: number;
}

/** A disabled ship and everything aboard it. */
export interface Hulk {
  ship: ShipEntity; kind: PrizeKind;
  /** System time when the crew restarts it (paused while someone is aboard). */
  until: number;
  crew: CrewMember[];
  /** The crew knows it has been boarded. */
  alerted: boolean;
  loot: Cargo; credits: number; looted: boolean; claimed: boolean;
  boarders: Set<Session>;
}

const PIRATE_LOOK: Outfit = { suit: 'suit-raider', helmet: 'helmet-armored', visor: 'visor-amber', pack: 'pack-plss', chest: 'chest-plate', lights: 'lights-eva', patch: 'patch-skull', mod: 'mod-none' };
const CAPTAIN_LOOK: Outfit = { ...PIRATE_LOOK, suit: 'suit-graphite', helmet: 'helmet-panorama', visor: 'visor-silver', pack: 'pack-raider' };
const HAULER_LOOK: Outfit = { suit: 'suit-orange', helmet: 'helmet-dome', visor: 'visor-gold', pack: 'pack-plss', chest: 'chest-rig', lights: 'lights-eva', patch: 'patch-skull', mod: 'mod-none' };
/** Crew posts per room, in the order they are manned. */
const POSTS: { x: number; z: number }[] = [
  { x: 6.5, z: 5.6 }, { x: 5.2, z: -3 }, { x: -6.5, z: 0.5 }, { x: 0, z: -2 }, { x: 9.2, z: 3.2 }, { x: -9.5, z: 4.5 }, { x: 3.5, z: -7.5 },
];
const BRIDGE_POST = { x: 0, z: -13.5 };
const tmp = v3(), wp = v3(), wv = v3();

export class Boarding {
  readonly hulks = new Map<number, Hulk>();
  private rng: Rng;

  constructor(private sys: SystemInstance) {
    this.rng = new Rng(hashInts(sys.def.seed, 0xb0a7d));
  }

  /** Pirates, escorts and convoy freighters can be boarded; turrets cannot. */
  boardable(ship: ShipEntity): boolean {
    return !!ship.npc && ship.npc.role !== 'turret' && (ship.bp.cls === 'pirate' || ship.bp.cls === 'freighter');
  }

  /** After a pilot's hit: knocks the ship out once its hull is low enough. */
  maybeDisable(ship: ShipEntity, by: Session | undefined) {
    if (!by || ship.disabled || ship.dead || !this.boardable(ship) || ship.hull > ship.combat.maxHull * DISABLE_HULL) return;
    this.disable(ship);
    for (const m of this.sys.crew(by, ship.world.p)) m.msg(`${ship.name} выведен из строя: подлетите ближе и нажмите F — абордаж`, 'good');
  }

  disable(ship: ShipEntity): Hulk {
    const kind: PrizeKind = ship.bp.cls === 'freighter' ? 'freighter' : 'pirate';
    const r = this.rng, t = this.sys.time;
    ship.disabled = true;
    ship.disabledAt = t;
    ship.shield = 0;
    ship.throttle = 0;
    ship.boosting = false;
    const loot = emptyCargo();
    if (kind === 'freighter') { loot.ore = r.int(6, 12); loot.crystal = r.int(4, 8); loot.relic = r.int(1, 3); loot.bio = r.int(0, 4); }
    else { loot.ore = r.int(1, 4); loot.crystal = r.int(0, 3); loot.relic = r.float() < 0.3 ? 1 : 0; }
    const credits = kind === 'freighter' ? r.int(150, 350) : r.int(60, 160);
    const h: Hulk = { ship, kind, until: t + DISABLE_TIME, crew: [], alerted: false, loot, credits, looted: false, claimed: false, boarders: new Set() };
    // the captain on the bridge, the rest at their posts
    const n = kind === 'freighter' ? r.int(4, 5) : r.int(2, 3);
    h.crew.push(this.crewman(true, kind, BRIDGE_POST));
    for (let i = 0; i < n; i++) h.crew.push(this.crewman(false, kind, POSTS[i % POSTS.length]));
    this.hulks.set(ship.id, h);
    return h;
  }

  private crewman(captain: boolean, kind: PrizeKind, post: { x: number; z: number }): CrewMember {
    const r = this.rng;
    const look = lookCode(captain ? CAPTAIN_LOOK : kind === 'pirate' ? PIRATE_LOOK : HAULER_LOOK);
    const a = r.range(0, Math.PI * 2);
    const hp = captain ? CREW.captainHp : CREW.hp;
    const c: CrewMember = {
      id: this.sys.nextId(), name: `${captain ? 'Капитан' : kind === 'pirate' ? 'Пират' : 'Матрос'} ${makeName(r)}`, captain, look,
      state: newChar(v3(post.x, 0, post.z), v3(Math.sin(a), 0, Math.cos(a))), hp, maxHp: hp, dead: false, post, cool: r.range(0, 1), seen: -1, last: null, pitch: 0, shotAt: -99,
    };
    this.sys.infos.push(this.crewInfo(c));
    return c;
  }

  crewInfo(c: CrewMember): EntityInfo {
    return { id: c.id, kind: KIND.CHAR, name: c.name, npc: true, look: c.look };
  }

  infos(out: EntityInfo[]) {
    for (const h of this.hulks.values()) for (const c of h.crew) out.push(this.crewInfo(c));
  }

  /** The hulk a session is aboard. */
  of(s: Session): Hulk | null {
    return s.char?.aboard ? this.hulks.get(s.char.aboard) ?? null : null;
  }

  /** Ship-local deck point → world. */
  toWorld(ship: ShipEntity, x: number, y: number, z: number, out: V3): V3 {
    qrot(out, ship.world.q, v3(x, y + FLOOR_Y, z));
    out.x += ship.world.p.x; out.y += ship.world.p.y; out.z += ship.world.p.z;
    return out;
  }

  private dirToWorld(ship: ShipEntity, d: V3, out: V3): V3 {
    return qrot(out, ship.world.q, d);
  }

  // ------------------------------------------------------------------ boarding and leaving
  board(s: Session, id: number): string | null {
    const ship = s.ship;
    if (s.mode !== MODE.SHIP || ship.dead) return null;
    const h = this.hulks.get(id);
    const t = h?.ship;
    if (!h || !t || t.dead || !this.sys.ships.has(id)) return 'Этот корабль не выведен из строя';
    if (h.claimed && !h.boarders.size) return 'Корабль уже захвачен';
    if (vdist(ship.world.p, t.world.p) > BOARD_RANGE + t.flight.radius) return 'Подлетите ближе к кораблю';
    if (vlen(ship.world.v) > BOARD_SPEED) return `Сбросьте скорость до ${BOARD_SPEED} м/с`;
    if (ship.state.frame) return null;
    // our ship clamps on alongside, to starboard, nose the same way
    t.state.v = v3();
    const side = t.flight.radius + ship.flight.radius + 4;
    const right = qrot(v3(), t.world.q, v3(1, 0, 0));
    ship.state.p = v3(t.world.p.x + right.x * side, t.world.p.y + right.y * side, t.world.p.z + right.z * side);
    ship.state.q = { ...t.world.q };
    ship.state.v = v3();
    this.sys.syncWorld(ship);
    // through the airlock, facing the bow
    const hp = s.gear().hp;
    const c: CharEntity = {
      id: this.sys.nextId(), name: s.pilot.name, state: newChar(v3(SHIP_HATCH.x, 0, SHIP_HATCH.z - 0.5), v3(0, 0, -1)), planet: -1, aboard: id,
      session: s, hp, maxHp: hp, hurtAt: -99, cool: 0, pitch: 0, aim: false, shotAt: -99, drown: 0,
    };
    s.char = c;
    this.sys.chars.set(c.id, c);
    this.sys.infos.push({ id: c.id, kind: KIND.CHAR, name: s.pilot.name, owner: s.id, look: lookCode(s.pilot.outfit) });
    s.mode = MODE.BOARD;
    s.resync();
    h.boarders.add(s);
    this.tell(s, h);
    const alive = h.crew.filter((x) => !x.dead).length;
    s.msg(alive ? `На борту: ${t.name}. Экипаж — ${alive} чел., будьте готовы к бою` : `На борту: ${t.name}. Экипажа нет`, alive ? 'warn' : 'info');
    return null;
  }

  /** Back through the airlock into the pilot's own ship. */
  leave(s: Session): string | null {
    const h = this.of(s);
    if (!h || !s.char) return null;
    const p = s.char.state.p;
    if (Math.hypot(p.x - SHIP_HATCH.x, p.z - SHIP_HATCH.z) > SHIP_REACH + 1) return 'Вернитесь к шлюзу';
    this.sys.recallPilot(s);
    return null;
  }

  /** The pilot left the hulk (back in their ship, knocked out, gone): no longer aboard. */
  forget(s: Session) {
    for (const h of this.hulks.values()) {
      if (!h.boarders.delete(s)) continue;
      // a fresh while before the crew can restart it
      h.until = Math.max(h.until, this.sys.time + 30);
      s.sendJson(MSG.EVENTS, { ev: [{ t: 'aboard', id: 0, crew: 0, looted: false, claimed: false } satisfies GameEvent] });
      if (h.claimed && !h.boarders.size) this.prizeAway(h);
    }
  }

  private tell(s: Session, h: Hulk) {
    s.sendJson(MSG.EVENTS, { ev: [{ t: 'aboard', id: h.ship.id, crew: h.crew.filter((c) => !c.dead).length, looted: h.looted, claimed: h.claimed } satisfies GameEvent] });
  }

  private tellAll(h: Hulk) {
    for (const s of h.boarders) this.tell(s, h);
  }

  // ------------------------------------------------------------------ loot and prize
  loot(s: Session): string | null {
    const h = this.of(s);
    if (!h || !s.char) return null;
    const p = s.char.state.p;
    if (Math.hypot(p.x - SHIP_CHEST.x, p.z - SHIP_CHEST.z) > SHIP_REACH) return 'Подойдите к сейфу в трюме';
    if (h.crew.some((c) => !c.dead)) return 'Сейф заперт: сначала обезвредьте экипаж';
    if (h.looted) return 'Трюм уже пуст';
    const pl = s.pilot;
    let free = combatStats(pl.upgrades, pl.ship).cargoCap - cargoCount(pl.cargo);
    const got: Partial<Record<CargoKey, number>> = {};
    for (const k of ['relic', 'crystal', 'bio', 'ore'] as CargoKey[]) {
      const n = Math.min(free, h.loot[k]);
      if (n <= 0) continue;
      h.loot[k] -= n; pl.cargo[k] += n; got[k] = n; free -= n;
    }
    const credits = h.credits;
    h.credits = 0;
    pl.credits += credits;
    const left = cargoCount(h.loot);
    h.looted = left === 0;
    s.sendPilot();
    const txt = [yieldText(got, CARGO_NAMES), credits ? `+${credits} кр` : ''].filter(Boolean).join(', ');
    this.toWorld(h.ship, SHIP_CHEST.x, 1.2, SHIP_CHEST.z, wp);
    s.sendJson(MSG.EVENTS, { ev: [{ t: 'loot', text: `Добыча: ${txt || 'ничего'}`, pos: [wp.x, wp.y, wp.z] }] });
    if (left) s.msg(`В трюм не влезло ещё ${left} ед. — освободите место и возвращайтесь`, 'warn');
    this.tellAll(h);
    return null;
  }

  claim(s: Session): string | null {
    const h = this.of(s);
    if (!h || !s.char) return null;
    const p = s.char.state.p;
    if (Math.hypot(p.x - SHIP_HELM.x, p.z - SHIP_HELM.z) > SHIP_REACH) return 'Подойдите к штурвалу на мостике';
    if (h.crew.some((c) => !c.dead)) return 'На борту ещё остался экипаж';
    if (h.claimed) return 'Корабль уже ваш';
    const pl = s.pilot;
    if (pl.prizes.length >= MAX_PRIZES) return `На верфях уже ждут продажи ${MAX_PRIZES} ваших призов — сначала продайте их`;
    const [a, b] = PRIZE_VALUE[h.kind];
    const value = Math.round(this.rng.range(a, b) / 10) * 10;
    pl.prizes.push({ id: `${this.sys.def.id}-${h.ship.id}-${Math.floor(this.sys.time)}`, name: `${PRIZE_NAMES[h.kind]} «${h.ship.name.replace(/[«»]/g, '').split(' ').slice(1).join(' ') || h.ship.name}»`, kind: h.kind, value });
    h.claimed = true;
    pl.kills++;
    this.sys.captured(h.ship, s);
    this.sys.reward(s, h.ship.world.p, h.kind === 'freighter' ? BOUNTY.npc * 3 : BOUNTY.npc, 'Корабль захвачен');
    s.msg(`Призовая команда поведёт корабль на верфь: продать его можно на любой станции (≈${value} кр)${h.looted ? '' : '. Не забудьте сейф в трюме'}`, 'good');
    this.tellAll(h);
    return null;
  }

  /** Sell a prize at the shipyard (docked). */
  sellPrize(s: Session, id: string): string | null {
    const pl = s.pilot;
    const i = pl.prizes.findIndex((p) => p.id === id);
    if (i < 0) return 'Нет такого приза';
    const [p] = pl.prizes.splice(i, 1);
    pl.credits += p.value;
    s.sendPilot();
    s.msg(`Продан приз: ${p.name} (+${p.value} кр)`, 'good');
    return null;
  }

  /** The prize crew takes a claimed ship away once the last boarder is off it. */
  private prizeAway(h: Hulk) {
    this.drop(h);
    this.sys.despawn(h.ship);
  }

  /** Forgets a hulk: crew entities go, anyone still aboard is put back in their ship. */
  private drop(h: Hulk) {
    this.hulks.delete(h.ship.id);
    for (const c of h.crew) this.sys.gone.push(c.id);
    h.crew = [];
    for (const s of [...h.boarders]) {
      h.boarders.delete(s);
      if (s.mode === MODE.BOARD) this.sys.recallPilot(s);
    }
  }

  /** The hulk blew up (someone kept shooting at it): whoever is aboard is thrown clear. */
  onDestroyed(ship: ShipEntity) {
    const h = this.hulks.get(ship.id);
    if (!h) return;
    const aboard = [...h.boarders];
    this.drop(h);
    for (const s of aboard) s.msg('Корабль взорвался — аварийный шлюз выбросил вас к вашему кораблю', 'warn');
  }

  // ------------------------------------------------------------------ simulation
  step(dt: number) {
    const t = this.sys.time;
    for (const h of [...this.hulks.values()]) {
      const ship = h.ship;
      if (ship.dead || this.sys.ships.get(ship.id) !== ship) { this.drop(h); continue; }
      // dead in space: drifts to a stop (held still while someone is docked)
      const st = ship.state;
      const k = h.boarders.size ? 0 : Math.exp(-0.8 * dt);
      st.v.x *= k; st.v.y *= k; st.v.z *= k;
      if (!st.frame) { st.p.x += st.v.x * dt; st.p.y += st.v.y * dt; st.p.z += st.v.z * dt; }
      this.sys.syncWorld(ship);
      if (h.boarders.size) h.until = Math.max(h.until, t + 1);
      if (h.claimed) { if (!h.boarders.size) this.prizeAway(h); continue; }
      const alive = h.crew.some((c) => !c.dead);
      if (!h.boarders.size && t > h.until) {
        if (alive) this.restart(h);
        else if (t > h.until + DISABLE_TIME) { this.drop(h); this.sys.despawn(ship); }
        continue;
      }
      if (alive && (h.boarders.size || h.alerted)) for (const c of h.crew) if (!c.dead) this.think(h, c, dt);
    }
  }

  /** Nobody came: the crew gets the engines going again and the ship runs. */
  private restart(h: Hulk) {
    const ship = h.ship;
    this.drop(h);
    ship.disabled = false;
    ship.hull = Math.max(ship.hull, ship.combat.maxHull * 0.4);
    if (ship.npc && ship.npc.role !== 'hauler') { ship.npc.state = 'flee'; ship.npc.fleeUntil = this.sys.time + 10; }
  }

  private think(h: Hulk, c: CrewMember, dt: number) {
    const t = this.sys.time, cs = c.state, p = cs.p;
    c.cool -= dt;
    let tgt: Session | null = null, td: number = CREW.sight;
    for (const s of h.boarders) {
      if (s.mode !== MODE.BOARD || !s.char) continue;
      const q = s.char.state.p, d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d < td && deckSight(p.x, p.z, q.x, q.z)) { td = d; tgt = s; }
    }
    const inp = emptyCharInput();
    let goal: { x: number; z: number } | null = null;
    if (tgt) {
      const q = tgt.char!.state.p;
      if (!h.alerted) this.alarm(h);
      if (c.seen < 0) c.seen = t;
      c.last = { x: q.x, z: q.z };
      const dx = q.x - p.x, dz = q.z - p.z, l = Math.hypot(dx, dz) || 1;
      cs.f.x = dx / l; cs.f.z = dz / l;
      c.pitch = Math.atan2(1.2 - 1.45, l);
      // keep a fighting distance and sidestep
      const fwd = td > 9 ? 1 : td < 4 ? -1 : 0;
      inp.mz = fwd;
      inp.mx = Math.sin(t * 1.7 + c.id) * 0.8;
      if (t - c.seen > (c.captain ? 0.5 : 0.8) && c.cool <= 0) this.fire(h, c, tgt, td);
    } else {
      c.seen = -1;
      if (h.alerted) {
        // hunt: towards where a boarder was seen last, else towards the nearest one
        let near: { x: number; z: number } | null = null, nd = Infinity;
        for (const s of h.boarders) {
          if (!s.char) continue;
          const d = Math.hypot(s.char.state.p.x - p.x, s.char.state.p.z - p.z);
          if (d < nd) { nd = d; near = s.char.state.p; }
        }
        goal = c.last && Math.hypot(c.last.x - p.x, c.last.z - p.z) > 1 ? c.last : near;
        if (c.last && Math.hypot(c.last.x - p.x, c.last.z - p.z) <= 1) c.last = null;
        // the captain holds the bridge
        if (c.captain) goal = shipRoomAt(p.x, p.z)?.key === 'bridge' && near && shipRoomAt(near.x, near.z)?.key !== 'bridge' ? null : goal ?? null;
      } else goal = c.post;
    }
    if (goal && Math.hypot(goal.x - p.x, goal.z - p.z) > 0.7) {
      const w = deckWaypoint(p, goal);
      const dx = w.x - p.x, dz = w.z - p.z, l = Math.hypot(dx, dz) || 1;
      cs.f.x = dx / l; cs.f.z = dz / l;
      inp.mz = 1;
      inp.sprint = h.alerted;
    }
    stepDeck(cs, inp, dt, SHIP_DECK);
  }

  /** The whole crew hears the fight. */
  private alarm(h: Hulk) {
    h.alerted = true;
  }

  private fire(h: Hulk, c: CrewMember, s: Session, d: number) {
    const r = this.rng, cs = c.state, q = s.char!.state;
    c.cool = CREW.cooldown * r.range(0.85, 1.2) * (c.captain ? 0.8 : 1);
    c.shotAt = this.sys.time;
    let chance = Math.max(0.3, Math.min(0.85, 0.92 - d * 0.03));
    if (Math.hypot(q.v.x, q.v.z) > 5) chance *= 0.7;
    const hit = r.float() < chance;
    const o = v3(cs.p.x + cs.f.x * 0.5, 1.4, cs.p.z + cs.f.z * 0.5);
    const aim = v3(q.p.x, 1.2, q.p.z);
    if (!hit) {
      // wide: past a shoulder or over the head
      const sx = -(q.p.z - cs.p.z), sz = q.p.x - cs.p.x, sl = Math.hypot(sx, sz) || 1;
      const off = (r.float() < 0.5 ? -1 : 1) * r.range(0.7, 1.4);
      aim.x += (sx / sl) * off; aim.z += (sz / sl) * off; aim.y += r.range(-0.3, 0.9);
    }
    const dir = v3(aim.x - o.x, aim.y - o.y, aim.z - o.z), l = vlen(dir) || 1;
    dir.x /= l; dir.y /= l; dir.z /= l;
    this.toWorld(h.ship, o.x, o.y, o.z, wp);
    this.dirToWorld(h.ship, dir, wv);
    const sp = BLASTER.speed * 0.8;
    this.sys.shots.push({ shooter: c.id, px: wp.x, py: wp.y, pz: wp.z, vx: wv.x * sp, vy: wv.y * sp, vz: wv.z * sp, level: DRONE_LEVEL });
    if (hit) this.sys.fauna.hurt(s, c.captain ? CREW.captainDmg : CREW.dmg, c.id);
  }

  /** A boarder fires the hand blaster along their heading + `pitch` (hitscan, walls stop it). */
  shoot(s: Session, pitch: number) {
    const h = this.of(s), ch = s.char;
    if (!h || !ch || ch.cool > 0) return;
    ch.cool = BLASTER.cooldown;
    ch.shotAt = this.sys.time;
    const cs = ch.state, pc = Math.max(-1.3, Math.min(1.3, pitch));
    const dir = v3(cs.f.x * Math.cos(pc), Math.sin(pc), cs.f.z * Math.cos(pc));
    const o = v3(cs.p.x, 1.45, cs.p.z);
    let reach: number = BLASTER.range;
    const k = deckReach(o.x, o.z, o.x + dir.x * reach, o.z + dir.z * reach);
    reach *= k;
    // floor and ceiling
    const ceil = shipRoomAt(o.x, o.z)?.ceil ?? 3;
    if (dir.y < -1e-3) reach = Math.min(reach, -o.y / dir.y);
    else if (dir.y > 1e-3) reach = Math.min(reach, (ceil - o.y) / dir.y);
    const end = v3(o.x + dir.x * reach, o.y + dir.y * reach, o.z + dir.z * reach);
    let hit: CrewMember | null = null, best = 2;
    for (const c of h.crew) {
      if (c.dead) continue;
      for (const y of [0.55, 1.05, 1.5]) {
        const tt = segmentSphere(o, end, v3(c.state.p.x, y, c.state.p.z), CREW.hitR);
        if (tt >= 0 && tt < best) { best = tt; hit = c; }
      }
    }
    this.toWorld(h.ship, o.x, o.y, o.z, wp);
    this.dirToWorld(h.ship, dir, wv);
    this.sys.shots.push({ shooter: ch.id, px: wp.x, py: wp.y, pz: wp.z, vx: wv.x * BLASTER.speed, vy: wv.y * BLASTER.speed, vz: wv.z * BLASTER.speed, level: BLASTER_LEVEL });
    if (!hit) return;
    const hp = v3(o.x + (end.x - o.x) * best, o.y + (end.y - o.y) * best, o.z + (end.z - o.z) * best);
    this.toWorld(h.ship, hp.x, hp.y, hp.z, wp);
    this.sys.events.push({ t: 'hit', target: hit.id, pos: [wp.x, wp.y, wp.z], shield: false, dmg: BLASTER.damage, by: ch.id });
    this.hurtCrew(h, hit, BLASTER.damage, s);
  }

  hurtCrew(h: Hulk, c: CrewMember, dmg: number, by: Session) {
    if (c.dead) return;
    c.hp -= dmg;
    if (!h.alerted) this.alarm(h);
    // shot from somewhere: turn and look
    if (by.char && c.seen < 0) c.last = { x: by.char.state.p.x, z: by.char.state.p.z };
    if (c.hp > 0) return;
    c.hp = 0;
    c.dead = true;
    c.state.v = v3();
    const left = h.crew.filter((x) => !x.dead).length;
    for (const s of h.boarders) {
      s.msg(left ? `${c.name} обезврежен. Осталось: ${left}` : 'Экипаж обезврежен! Сейф в трюме открыт, штурвал на мостике — захватить корабль', left ? 'info' : 'good');
    }
    this.tellAll(h);
  }

  // ------------------------------------------------------------------ network
  /** The crew of the ship a session is aboard (deck coordinates). */
  entities(s: Session, out: EntityState[]) {
    const h = this.of(s);
    if (!h) return;
    const q = quat();
    for (const c of h.crew) {
      const cs = c.state;
      qlook(q, cs.f, v3(0, 1, 0));
      const engaged = c.seen >= 0 || this.sys.time - c.shotAt < 1.5;
      out.push({
        id: c.id, kind: KIND.CHAR, flags: (c.dead ? EFLAG.DEAD : 0) | (engaged && !c.dead ? CFLAG.AIM : 0), frame: BOARD_FRAME,
        px: cs.p.x, py: cs.p.y, pz: cs.p.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w, vx: cs.v.x, vy: cs.v.y, vz: cs.v.z,
        hull: c.hp / c.maxHp, shield: aimByte(c.pitch), throttle: 0,
      });
    }
  }

  // ------------------------------------------------------------------ dev
  /** Dev: a disabled pirate (or freighter) 110 m ahead of the pilot's ship, ready to board. */
  devSpawn(s: Session, freighter: boolean): string {
    const ship = s.ship;
    if (s.mode !== MODE.SHIP) return 'Сядьте в корабль';
    const f = qrot(tmp, ship.world.q, v3(0, 0, -1));
    const p = v3(ship.world.p.x + f.x * 110, ship.world.p.y + f.y * 110, ship.world.p.z + f.z * 110);
    const npc = freighter ? this.sys.world.devFreighter(p) : this.sys.spawnPirate(p);
    npc.transient = true;
    npc.hull = npc.combat.maxHull * DISABLE_HULL * 0.9;
    this.disable(npc);
    return `${npc.name} выведен из строя прямо по курсу — F для абордажа`;
  }

  /** Dev: straight aboard the nearest disabled ship (or a fresh pirate). */
  devBoard(s: Session, freighter = false): string {
    if (s.mode !== MODE.SHIP) return 'Сядьте в корабль';
    let h = [...this.hulks.values()].filter((x) => !x.claimed).sort((a, b) => vdist(a.ship.world.p, s.ship.world.p) - vdist(b.ship.world.p, s.ship.world.p))[0];
    if (!h || vdist(h.ship.world.p, s.ship.world.p) > 3000) { this.devSpawn(s, freighter); h = [...this.hulks.values()].at(-1)!; }
    s.ship.state.v = v3();
    s.ship.state.p = { ...h.ship.world.p, x: h.ship.world.p.x + 60 };
    this.sys.syncWorld(s.ship);
    return this.board(s, h.ship.id) ?? 'На борту';
  }

  /** Dev: knocks out the whole crew aboard. */
  devClear(s: Session): string {
    const h = this.of(s);
    if (!h) return 'Вы не на борту';
    for (const c of h.crew) this.hurtCrew(h, c, 999, s);
    return 'Экипаж обезврежен';
  }

  /** Dev: walks the boarder to a spot (hatch | chest | helm | room name). */
  devGo(s: Session, where: string): string {
    const h = this.of(s);
    if (!h || !s.char) return 'Вы не на борту';
    const room = SHIP_ROOMS.find((r) => r.key === where);
    const spot = where === 'chest' ? { x: SHIP_CHEST.x + 1.6, z: SHIP_CHEST.z, fx: -1, fz: 0 } : where === 'helm' ? { x: SHIP_HELM.x, z: SHIP_HELM.z + 1.3, fx: 0, fz: -1 }
      : where === 'hatch' ? { x: SHIP_HATCH.x, z: SHIP_HATCH.z - 0.5, fx: 0, fz: -1 } : room ? { x: (room.x0 + room.x1) / 2, z: (room.z0 + room.z1) / 2, fx: 0, fz: -1 } : null;
    if (!spot) return '/aboard hatch|chest|helm|hold|quarters|engine|bridge|corridor';
    const c = s.char.state;
    c.p = v3(spot.x, 0, spot.z); c.v = v3(); c.f = v3(spot.fx, 0, spot.fz);
    s.resync();
    return 'Готово';
  }
}

