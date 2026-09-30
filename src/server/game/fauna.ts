import { CARGO_KEYS, cargoCount, combatStats } from '../../shared/economy.ts';
import { BLASTER, FAUNA, PILOT_HP, SAMPLE_RANGE, SPECIES, stepCreature, type CreatureState, type Species } from '../../shared/fauna.ts';
import { hashInts, Rng } from '../../shared/math/rng.ts';
import { qlook, quat, v3, vcross, vdist, vnorm, vsub, type V3 } from '../../shared/math/vec.ts';
import { BLASTER_LEVEL, EFLAG, KIND, MODE, MSG, type EntityState } from '../../shared/net/protocol.ts';
import { inSite } from '../../shared/planet/sites.ts';
import { footHeight, heightAt } from '../../shared/planet/terrain.ts';
import { planetRot, toWorldDir, toWorldPoint } from '../../shared/sim/frames.ts';
import { segmentSphere } from '../../shared/sim/weapons.ts';
import type { Session } from './session.ts';
import type { SystemInstance } from './system.ts';

type Mood = 'wander' | 'graze' | 'flee' | 'hunt';

interface Creature {
  id: number;
  sp: Species;
  planet: number;
  herd: number;
  state: CreatureState;
  home: V3;
  hp: number;
  dead: boolean;
  deadUntil: number;
  mood: Mood;
  moodUntil: number;
  wish: V3 | null;
  target: number;
  biteCool: number;
}

const MAX_NEAR = 8;
const MAX_TOTAL = 60;
const AGGRO = 70;
const SPOOK = 22;
const rot = quat(), tmp = v3(), up = v3(), dir = v3(), wp = v3(), wv = v3();

/**
 * Wildlife on living worlds. Herds of grazers and a few predators are spawned
 * around pilots on (or just above) the surface and cleaned up when nobody is
 * near. Grazers wander and bolt when approached or shot; predators hunt
 * pilots on foot. Pilots fight back with a hand blaster and harvest bio
 * samples from carcasses.
 */
export class Fauna {
  readonly creatures = new Map<number, Creature>();
  private rng: Rng;
  private acc = 0;
  private herds = 0;

  constructor(private sys: SystemInstance) {
    this.rng = new Rng(hashInts(sys.def.seed, 0xfa0a));
  }

  info(c: Creature) {
    return { id: c.id, kind: KIND.CREATURE, name: c.sp.name, species: c.sp.id, npc: c.sp.predator };
  }

  /** Where a session is on a planet surface (body frame), if anywhere. */
  private presence(s: Session): { planet: number; p: V3 } | null {
    if (s.char) return { planet: s.char.planet, p: s.char.state.p };
    const st = s.ship.state;
    if (s.mode !== MODE.SHIP || !st.frame) return null;
    const pl = this.sys.def.planets[st.frame - 1];
    const l = Math.hypot(st.p.x, st.p.y, st.p.z);
    if (l - pl.radius - heightAt(pl, st.p.x / l, st.p.y / l, st.p.z / l) > 600) return null;
    return { planet: st.frame - 1, p: st.p };
  }

  // ------------------------------------------------------------------ population
  private populate() {
    const pres = [...this.sys.sessions].map((s) => this.presence(s)).filter((x): x is { planet: number; p: V3 } => !!x);
    // despawn what nobody is near
    for (const c of [...this.creatures.values()]) {
      if (!pres.some((q) => q.planet === c.planet && vdist(q.p, c.state.p) < 900)) this.remove(c);
    }
    for (const q of pres) {
      const pl = this.sys.def.planets[q.planet];
      const kinds = FAUNA[pl.type];
      if (!kinds) continue;
      let near = 0, hunters = 0;
      for (const c of this.creatures.values()) {
        if (c.planet !== q.planet || vdist(c.state.p, q.p) > 450) continue;
        near++;
        if (c.sp.predator) hunters++;
      }
      if (near >= MAX_NEAR || this.creatures.size >= MAX_TOTAL) continue;
      const predator = hunters < 2 && this.rng.chance(0.35);
      this.spawnHerd(q.planet, q.p, SPECIES[kinds[predator ? 1 : 0]]);
    }
  }

  private spawnHerd(planet: number, near: V3, sp: Species, dist?: number): Creature[] {
    const pl = this.sys.def.planets[planet];
    const r = this.rng;
    const n0 = vnorm(v3(), near);
    const t1 = vnorm(v3(), vcross(v3(), n0, Math.abs(n0.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0)));
    const t2 = vcross(v3(), n0, t1);
    for (let tries = 0; tries < 20; tries++) {
      const a = r.range(0, Math.PI * 2), d = dist ?? r.range(200, 380);
      const c0 = vnorm(v3(), v3(near.x + (t1.x * Math.cos(a) + t2.x * Math.sin(a)) * d, near.y + (t1.y * Math.cos(a) + t2.y * Math.sin(a)) * d, near.z + (t1.z * Math.cos(a) + t2.z * Math.sin(a)) * d));
      const h = heightAt(pl, c0.x, c0.y, c0.z);
      if (h < 1.5 || inSite(pl, c0, 30)) continue;
      const herd = ++this.herds;
      const out: Creature[] = [];
      const count = r.int(sp.herd[0], sp.herd[1]);
      for (let i = 0; i < count; i++) {
        const o = i === 0 ? v3() : v3((r.float() - 0.5) * 24, 0, (r.float() - 0.5) * 24);
        const dd = vnorm(v3(), v3(c0.x * pl.radius + t1.x * o.x + t2.x * o.z, c0.y * pl.radius + t1.y * o.x + t2.y * o.z, c0.z * pl.radius + t1.z * o.x + t2.z * o.z));
        if (pl.sea && heightAt(pl, dd.x, dd.y, dd.z) < 0.5) continue;
        const g = pl.radius + footHeight(pl, dd.x, dd.y, dd.z);
        const f = vnorm(v3(), v3(t1.x * Math.cos(r.range(0, 6)) + t2.x, t1.y + t2.y * 0.3, t1.z + t2.z));
        const c: Creature = {
          id: this.sys.nextId(), sp, planet, herd, home: { ...c0 }, hp: sp.hp, dead: false, deadUntil: 0,
          state: { p: v3(dd.x * g, dd.y * g, dd.z * g), v: v3(), f },
          mood: 'graze', moodUntil: this.sys.time + r.range(1, 4), wish: null, target: 0, biteCool: 0,
        };
        this.creatures.set(c.id, c);
        this.sys.infos.push(this.info(c));
        out.push(c);
      }
      return out;
    }
    return [];
  }

  private remove(c: Creature) {
    this.creatures.delete(c.id);
    this.sys.gone.push(c.id);
  }

  // ------------------------------------------------------------------ behaviour
  step(dt: number) {
    const t = this.sys.time;
    this.acc += dt;
    if (this.acc >= 1) { this.acc = 0; this.populate(); }

    // suit self-repair
    for (const ch of this.sys.chars.values()) {
      ch.cool -= dt;
      if (ch.hp < PILOT_HP && t - ch.hurtAt > 5) ch.hp = Math.min(PILOT_HP, ch.hp + 4 * dt);
    }

    for (const c of [...this.creatures.values()]) {
      if (c.dead) { if (t > c.deadUntil) this.remove(c); continue; }
      const pl = this.sys.def.planets[c.planet];
      c.biteCool -= dt;
      // closest pilot on foot on this planet
      let prey: Session | null = null, pd = 1e9;
      for (const ch of this.sys.chars.values()) {
        if (ch.planet !== c.planet) continue;
        const d = vdist(ch.state.p, c.state.p);
        if (d < pd) { pd = d; prey = ch.session; }
      }
      vnorm(up, c.state.p);
      if (c.sp.predator) {
        if (c.mood !== 'flee' && prey && pd < AGGRO) { c.mood = 'hunt'; c.target = prey.id; }
        if (c.mood === 'hunt' && (!prey || pd > AGGRO * 1.6)) { c.mood = 'wander'; c.moodUntil = t; }
      } else if (c.mood !== 'flee' && prey && pd < SPOOK) this.scare(c, prey.char!.state.p);

      if (c.mood === 'flee' && t > c.moodUntil) { c.mood = 'wander'; c.moodUntil = t; }
      let speed = 0;
      if (c.mood === 'hunt' && prey?.char) {
        c.wish = this.tangent(vsub(tmp, prey.char.state.p, c.state.p));
        // close in, then hold at jaw's length instead of walking through the pilot
        const reach = 1.3 + c.sp.size * 1.1;
        speed = pd > 6 ? c.sp.run : pd > reach ? c.sp.walk : 0;
        if (speed === 0) { const k = Math.min(1, dt * 6); c.state.f.x += (c.wish.x - c.state.f.x) * k; c.state.f.y += (c.wish.y - c.state.f.y) * k; c.state.f.z += (c.wish.z - c.state.f.z) * k; }
        if (pd < reach + 0.5 && c.biteCool <= 0) {
          c.biteCool = 1.3;
          this.sys.events.push({ t: 'bite', id: c.id });
          this.hurt(prey, c.sp.bite, c.id);
        }
      } else if (c.mood === 'flee') {
        speed = c.sp.run;
      } else {
        if (t > c.moodUntil) {
          // alternate between grazing in place and ambling around the herd's home
          if (c.mood === 'graze') {
            c.mood = 'wander';
            c.moodUntil = t + this.rng.range(3, 7);
            const off = vdist(vnorm(dir, c.state.p), c.home) * pl.radius;
            c.wish = off > 45 ? this.tangent(vsub(tmp, v3(c.home.x * pl.radius, c.home.y * pl.radius, c.home.z * pl.radius), c.state.p))
              : this.tangent(v3(this.rng.range(-1, 1), this.rng.range(-1, 1), this.rng.range(-1, 1)));
          } else {
            c.mood = 'graze';
            c.moodUntil = t + this.rng.range(2, 6);
            c.wish = null;
          }
        }
        speed = c.mood === 'wander' ? c.sp.walk : 0;
      }
      if (!stepCreature(c.state, pl, speed > 0 ? c.wish : null, speed, dt)) c.wish = { ...c.state.f };
    }
  }

  /** Projects a vector onto the local tangent plane (uses `up`). */
  private tangent(v: V3): V3 {
    const k = v.x * up.x + v.y * up.y + v.z * up.z;
    return vnorm(v3(), v3(v.x - up.x * k, v.y - up.y * k, v.z - up.z * k));
  }

  /** Makes a grazer (and its herd) bolt away from `from`. */
  private scare(c: Creature, from: V3) {
    const t = this.sys.time;
    for (const o of this.creatures.values()) {
      if (o.herd !== c.herd || o.dead || o.sp.predator) continue;
      vnorm(up, o.state.p);
      o.mood = 'flee';
      o.moodUntil = t + this.rng.range(5, 8);
      o.wish = this.tangent(vsub(tmp, o.state.p, from));
    }
  }

  // ------------------------------------------------------------------ combat
  /** Pilot fires the hand blaster (hitscan) along heading + `pitch`. */
  shoot(s: Session, pitch: number) {
    const ch = s.char;
    if (!ch || ch.cool > 0) return;
    ch.cool = BLASTER.cooldown;
    ch.shotAt = this.sys.time;
    const pl = this.sys.def.planets[ch.planet];
    const cs = ch.state;
    vnorm(up, cs.p);
    const pc = Math.max(-1.3, Math.min(1.3, pitch));
    dir.x = cs.f.x * Math.cos(pc) + up.x * Math.sin(pc);
    dir.y = cs.f.y * Math.cos(pc) + up.y * Math.sin(pc);
    dir.z = cs.f.z * Math.cos(pc) + up.z * Math.sin(pc);
    const o = v3(cs.p.x + up.x * 1.45, cs.p.y + up.y * 1.45, cs.p.z + up.z * 1.45);
    // terrain stops the bolt
    let reach: number = BLASTER.range;
    for (let k = 1; k <= 14; k++) {
      const d = (BLASTER.range * k) / 14;
      const px = o.x + dir.x * d, py = o.y + dir.y * d, pz = o.z + dir.z * d;
      const l = Math.hypot(px, py, pz);
      if (l < pl.radius + footHeight(pl, px / l, py / l, pz / l)) { reach = d; break; }
    }
    const end = v3(o.x + dir.x * reach, o.y + dir.y * reach, o.z + dir.z * reach);
    let hit: Creature | null = null, best = 2;
    for (const c of this.creatures.values()) {
      if (c.planet !== ch.planet || c.dead) continue;
      const cu = vnorm(tmp, c.state.p);
      const center = v3(c.state.p.x + cu.x * c.sp.size * 0.8, c.state.p.y + cu.y * c.sp.size * 0.8, c.state.p.z + cu.z * c.sp.size * 0.8);
      const tt = segmentSphere(o, end, center, c.sp.size * 1.05);
      if (tt >= 0 && tt < best) { best = tt; hit = c; }
    }
    // everyone nearby sees the bolt (world space)
    const R = planetRot(pl, this.sys.time, rot);
    toWorldPoint(pl, R, o, wp);
    toWorldDir(R, dir, wv);
    this.sys.shots.push({ shooter: ch.id, px: wp.x, py: wp.y, pz: wp.z, vx: wv.x * BLASTER.speed, vy: wv.y * BLASTER.speed, vz: wv.z * BLASTER.speed, level: BLASTER_LEVEL });
    if (!hit) return;
    const hp = v3(o.x + (end.x - o.x) * best, o.y + (end.y - o.y) * best, o.z + (end.z - o.z) * best);
    toWorldPoint(pl, R, hp, wp);
    this.sys.events.push({ t: 'hit', target: hit.id, pos: [wp.x, wp.y, wp.z], shield: false, dmg: BLASTER.damage, by: ch.id });
    this.damage(hit, BLASTER.damage, s);
  }

  damage(c: Creature, dmg: number, by: Session) {
    if (c.dead) return;
    c.hp -= dmg;
    if (c.sp.predator) {
      if (c.hp < c.sp.hp * 0.25) {
        vnorm(up, c.state.p);
        c.mood = 'flee';
        c.moodUntil = this.sys.time + 5;
        c.wish = by.char ? this.tangent(vsub(tmp, c.state.p, by.char.state.p)) : c.state.f;
      } else { c.mood = 'hunt'; c.target = by.id; }
    } else if (by.char) this.scare(c, by.char.state.p);
    if (c.hp <= 0) {
      c.dead = true;
      c.hp = 0;
      c.deadUntil = this.sys.time + 90;
      c.state.v = v3();
      by.msg(`${c.sp.name} повержен — подойдите и нажмите F, чтобы взять биообразцы`, 'good');
    }
  }

  /** Collect bio samples from a carcass. */
  sample(s: Session, id: number): string | null {
    const ch = s.char;
    const c = this.creatures.get(id);
    if (!ch || !c || !c.dead || c.planet !== ch.planet) return 'Здесь нечего брать';
    if (vdist(c.state.p, ch.state.p) > SAMPLE_RANGE + c.sp.size) return 'Подойдите ближе';
    const free = combatStats(s.pilot.upgrades).cargoCap - cargoCount(s.pilot.cargo);
    if (free <= 0) return 'Трюм полон';
    const n = Math.min(free, c.sp.samples);
    s.pilot.cargo.bio += n;
    s.sendPilot();
    this.remove(c);
    const pl = this.sys.def.planets[c.planet];
    toWorldPoint(pl, planetRot(pl, this.sys.time, rot), c.state.p, wp);
    s.sendJson(MSG.EVENTS, { ev: [{ t: 'loot', text: `Биообразцы ×${n}`, pos: [wp.x, wp.y, wp.z] }] });
    return null;
  }

  /** Suit damage; a pilot who drops to zero is hauled back to the ship and loses half the cargo. */
  hurt(s: Session, dmg: number, by: number) {
    const ch = s.char;
    if (!ch || s.ship.god) return;
    ch.hp -= dmg;
    ch.hurtAt = this.sys.time;
    s.sendJson(MSG.EVENTS, { ev: [{ t: 'hurt', dmg, by }] });
    if (ch.hp > 0) return;
    let lost = 0;
    for (const k of CARGO_KEYS) { const n = Math.floor(s.pilot.cargo[k] / 2); s.pilot.cargo[k] -= n; lost += n; }
    this.sys.recallPilot(s);
    s.sendPilot();
    s.msg(lost ? `Скафандр пробит — спасательный дрон вернул вас на корабль. Потеряно груза: ${lost} ед.` : 'Скафандр пробит — спасательный дрон вернул вас на корабль.', 'warn');
  }

  // ------------------------------------------------------------------ network
  /** Creatures visible to a session (same planet, within 1.2 km). */
  entities(s: Session, out: EntityState[]) {
    const pr = this.presence(s);
    if (!pr) return;
    const q = quat();
    for (const c of this.creatures.values()) {
      if (c.planet !== pr.planet || vdist(c.state.p, pr.p) > 1200) continue;
      qlook(q, c.state.f, vnorm(up, c.state.p));
      const st = c.state;
      const fast = Math.hypot(st.v.x, st.v.y, st.v.z) > c.sp.walk * 1.6;
      out.push({
        id: c.id, kind: KIND.CREATURE, flags: (c.dead ? EFLAG.DEAD : 0) | (fast ? EFLAG.BOOST : 0) | (c.sp.predator ? EFLAG.NPC : 0), frame: c.planet + 1,
        px: st.p.x, py: st.p.y, pz: st.p.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w, vx: st.v.x, vy: st.v.y, vz: st.v.z,
        hull: c.hp / c.sp.hp, shield: 0, throttle: 0,
      });
    }
  }

  /** Test/dev helper: spawn a herd of a species right next to a point. */
  devSpawn(planet: number, near: V3, species: number, dist = 40) {
    return this.spawnHerd(planet, near, SPECIES[species], dist);
  }
}
