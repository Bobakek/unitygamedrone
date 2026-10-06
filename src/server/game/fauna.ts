import { CARGO_KEYS, cargoCount, combatStats } from '../../shared/economy.ts';
import { BLASTER, FAUNA, FAUNA_SEA, moodByte, SAMPLE_RANGE, SPECIES, stepCreature, stepSwimmer, type CreatureState, type Mood, type Species } from '../../shared/fauna.ts';
import { hashInts, Rng } from '../../shared/math/rng.ts';
import { qlook, quat, v3, vcross, vdist, vlen, vnorm, vscale, vsub, type V3 } from '../../shared/math/vec.ts';
import { BLASTER_LEVEL, DRONE_LEVEL, EFLAG, KIND, MODE, MSG, type EntityState } from '../../shared/net/protocol.ts';
import { inSite, siteDir, sitePlane, sitesNear, type SiteDef } from '../../shared/planet/sites.ts';
import type { CharEntity } from './entities.ts';
import { footHeight, heightAt, liquidOf } from '../../shared/planet/terrain.ts';
import { planetRot, toWorldDir, toWorldPoint } from '../../shared/sim/frames.ts';
import { segmentSphere } from '../../shared/sim/weapons.ts';
import type { Session } from './session.ts';
import type { PlanetDef } from '../../shared/galaxy/system-gen.ts';
import type { SystemInstance } from './system.ts';

const ALERT = 40;
/** Suit damage per second once the air has run out. */
const DROWN_DMG = 8;

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
  /** Guard drones: the wreck and post they guard, and where they patrol to (site plane). */
  guard?: { site: SiteDef; post: number; x: number; z: number; tx: number; tz: number };
}

/** Guard drones: hover height, how far they see, how far they stray from their post, respawn time. */
const HOVER = 1.7;
const DRONE_SIGHT = 24;
const LEASH = 16;
const DRONE_RESPAWN = 480;
const DRONE = 12;

/** Does a wall of the site stand between two site-plane points? */
function wallBetween(s: SiteDef, a: { x: number; z: number }, b: { x: number; z: number }): boolean {
  const dx = b.x - a.x, dz = b.z - a.z;
  for (const w of s.walls) {
    const ex = w.x1 - w.x0, ez = w.z1 - w.z0;
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((w.x0 - a.x) * ez - (w.z0 - a.z) * ex) / den;
    const u = ((w.x0 - a.x) * dz - (w.z0 - a.z) * dx) / den;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) return true;
  }
  return false;
}

const MAX_NEAR = 8;
/** Sea creatures kept around a pilot near the water; predators attack swimmers within SEA_AGGRO. */
const MAX_SEA_NEAR = 4;
const SEA_AGGRO = 45;
const SEA_SPOOK = 10;
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
  /** `${planet}:${site}:${post}` → when a downed guard drone comes back. */
  private guardRespawn = new Map<string, number>();

  constructor(private sys: SystemInstance) {
    this.rng = new Rng(hashInts(sys.def.seed, 0xfa0a));
  }

  info(c: Creature) {
    return { id: c.id, kind: KIND.CREATURE, name: c.sp.name, species: c.sp.id, npc: c.sp.predator };
  }

  /** Where a session is on a planet surface (body frame), if anywhere. */
  private presence(s: Session): { planet: number; p: V3 } | null {
    if (s.char) return s.char.planet >= 0 ? { planet: s.char.planet, p: s.char.state.p } : null;
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
      this.guardWrecks(q.planet, q.p);
      const kinds = FAUNA[pl.type];
      if (!kinds) continue;
      let near = 0, hunters = 0;
      for (const c of this.creatures.values()) {
        if (c.planet !== q.planet || vdist(c.state.p, q.p) > 450) continue;
        near++;
        if (c.sp.predator) hunters++;
      }
      if (near < MAX_NEAR && this.creatures.size < MAX_TOTAL) {
        const predator = hunters < 2 && this.rng.chance(0.35);
        this.spawnHerd(q.planet, q.p, SPECIES[kinds[predator ? 1 : 0]]);
      }
      // the sea around a pilot in or next to the water
      const sea = FAUNA_SEA[pl.type];
      if (!sea || !this.nearWater(q.planet, q.p)) continue;
      let wet = 0, sharks = 0;
      for (const c of this.creatures.values()) {
        if (!c.sp.aquatic || c.planet !== q.planet || vdist(c.state.p, q.p) > 300) continue;
        wet++;
        if (c.sp.predator) sharks++;
      }
      if (wet >= MAX_SEA_NEAR || this.creatures.size >= MAX_TOTAL) continue;
      const predator = sharks < 1 && this.rng.chance(0.4);
      this.spawnSea(q.planet, q.p, SPECIES[sea[predator ? 1 : 0]]);
    }
  }

  /** Guard drones of the wrecks near a pilot: one per post; a downed one returns after a while. */
  private guardWrecks(planet: number, p: V3) {
    const pl = this.sys.def.planets[planet];
    for (const s of sitesNear(pl, vnorm(v3(), p), 160)) {
      if (s.kind !== 'wreck' || !s.posts) continue;
      s.posts.forEach((_, k) => {
        if ((this.guardRespawn.get(`${planet}:${s.id}:${k}`) ?? 0) > this.sys.time) return;
        for (const c of this.creatures.values()) if (c.guard && c.planet === planet && c.guard.site === s && c.guard.post === k) return;
        this.spawnDrone(planet, s, k);
      });
    }
  }

  private spawnDrone(planet: number, s: SiteDef, k: number): Creature {
    const pl = this.sys.def.planets[planet];
    const post = s.posts![k];
    const d = siteDir(pl, s, post.x, post.z);
    const r = pl.radius + footHeight(pl, d.x, d.y, d.z) + HOVER;
    const c: Creature = {
      id: this.sys.nextId(), sp: SPECIES[DRONE], planet, herd: ++this.herds, home: { ...d }, hp: SPECIES[DRONE].hp, dead: false, deadUntil: 0,
      state: { p: v3(d.x * r, d.y * r, d.z * r), v: v3(), f: { ...s.east } },
      mood: 'wander', moodUntil: this.sys.time, wish: null, target: 0, biteCool: 1,
      guard: { site: s, post: k, x: post.x, z: post.z, tx: post.x, tz: post.z },
    };
    this.creatures.set(c.id, c);
    this.sys.infos.push(this.info(c));
    return c;
  }

  /**
   * A guard drone: patrols around its post inside the wreck; a pilot it can see (no wall in
   * between) within DRONE_SIGHT is engaged from 7–13 m with strafing and a shot every 1.3 s.
   */
  private stepDrone(c: Creature, pl: PlanetDef, dt: number) {
    const g = c.guard!, s = g.site, t = this.sys.time;
    c.biteCool -= dt;
    const me = sitePlane(pl, s, c.state.p);
    let prey: CharEntity | null = null, pd = DRONE_SIGHT;
    for (const ch of this.sys.chars.values()) {
      if (ch.planet !== c.planet || ch.session.ship.god) continue;
      const d = vdist(ch.state.p, c.state.p);
      if (d >= pd || wallBetween(s, me, sitePlane(pl, s, ch.state.p))) continue;
      prey = ch; pd = d;
    }
    let gx = g.tx, gz = g.tz, speed = c.sp.walk;
    if (prey) {
      c.mood = 'hunt';
      c.target = prey.session.id;
      const pp = sitePlane(pl, s, prey.state.p);
      const dx = pp.x - me.x, dz = pp.z - me.z, dl = Math.hypot(dx, dz) || 1;
      const want = pd > 13 ? 1 : pd < 7 ? -1 : 0;
      const strafe = Math.sin(t * 0.9 + c.id);
      gx = me.x + (dx / dl) * want * 3 - (dz / dl) * strafe * 2;
      gz = me.z + (dz / dl) * want * 3 + (dx / dl) * strafe * 2;
      if (Math.hypot(gx - g.x, gz - g.z) > LEASH) { gx = g.x; gz = g.z; }
      speed = c.sp.run;
      if (c.biteCool <= 0) { c.biteCool = 1.3; this.droneShot(c, prey, pl); }
    } else {
      c.mood = 'wander';
      if (t > c.moodUntil || Math.hypot(g.tx - me.x, g.tz - me.z) < 0.5) {
        c.moodUntil = t + this.rng.range(3, 6);
        g.tx = g.x + this.rng.range(-5, 5); g.tz = g.z + this.rng.range(-4, 4);
      }
      gx = g.tx; gz = g.tz;
    }
    // move in the site plane, never through a wall
    const mx = gx - me.x, mz = gz - me.z, ml = Math.hypot(mx, mz);
    const step = Math.min(ml, speed * dt);
    const nx = ml > 0.05 ? me.x + (mx / ml) * step : me.x, nz = ml > 0.05 ? me.z + (mz / ml) * step : me.z;
    const moveTo = wallBetween(s, me, { x: nx, z: nz }) ? me : { x: nx, z: nz };
    if (moveTo === me && !prey) c.moodUntil = t;
    const d = siteDir(pl, s, moveTo.x, moveTo.z);
    const r = pl.radius + footHeight(pl, d.x, d.y, d.z) + HOVER + Math.sin(t * 2.1 + c.id) * 0.12;
    const np = v3(d.x * r, d.y * r, d.z * r);
    c.state.v = dt > 0 ? vscale(v3(), vsub(v3(), np, c.state.p), 1 / dt) : v3();
    c.state.p = np;
    // face the pilot it fights, else where it goes
    vnorm(up, np);
    const look = prey ? vsub(v3(), prey.state.p, np) : c.state.v;
    const lu = look.x * up.x + look.y * up.y + look.z * up.z;
    const f = v3(look.x - up.x * lu, look.y - up.y * lu, look.z - up.z * lu);
    if (vlen(f) > 0.05) this.face(c, vnorm(f, f), dt * 2);
  }

  /** A drone's bolt at a pilot: most hit the chest, the rest fly a little wide. */
  private droneShot(c: Creature, prey: CharEntity, pl: PlanetDef) {
    const hit = this.rng.chance(0.7);
    vnorm(up, prey.state.p);
    const aim = v3(prey.state.p.x + up.x * 1.2, prey.state.p.y + up.y * 1.2, prey.state.p.z + up.z * 1.2);
    if (!hit) { aim.x += this.rng.range(-1.6, 1.6); aim.y += this.rng.range(-1.6, 1.6); aim.z += this.rng.range(-1.6, 1.6); }
    const d = vnorm(v3(), vsub(v3(), aim, c.state.p));
    const R = planetRot(pl, this.sys.time, rot);
    toWorldPoint(pl, R, c.state.p, wp);
    toWorldDir(R, d, wv);
    const sp = BLASTER.speed * 0.8;
    this.sys.shots.push({ shooter: c.id, px: wp.x, py: wp.y, pz: wp.z, vx: wv.x * sp, vy: wv.y * sp, vz: wv.z * sp, level: DRONE_LEVEL });
    if (hit) this.hurt(prey.session, c.sp.bite, c.id);
  }

  /** In the water, or within 150 m of water at least 5 m deep. */
  private nearWater(planet: number, p: V3): boolean {
    const pl = this.sys.def.planets[planet];
    const d = vnorm(v3(), p);
    if (heightAt(pl, d.x, d.y, d.z) < -2) return true;
    const t1 = vnorm(v3(), vcross(v3(), d, Math.abs(d.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0))), t2 = vcross(v3(), d, t1);
    for (const m of [80, 150]) {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const q = vnorm(v3(), v3(d.x * pl.radius + (t1.x * Math.cos(a) + t2.x * Math.sin(a)) * m, d.y * pl.radius + (t1.y * Math.cos(a) + t2.y * Math.sin(a)) * m, d.z * pl.radius + (t1.z * Math.cos(a) + t2.z * Math.sin(a)) * m));
        if (heightAt(pl, q.x, q.y, q.z) < -5) return true;
      }
    }
    return false;
  }

  /** A few sea creatures in water at least 5 m deep, 50–140 m from `near` (or `dist`). */
  private spawnSea(planet: number, near: V3, sp: Species, dist?: number): Creature[] {
    const pl = this.sys.def.planets[planet];
    const r = this.rng;
    const n0 = vnorm(v3(), near);
    const t1 = vnorm(v3(), vcross(v3(), n0, Math.abs(n0.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0)));
    const t2 = vcross(v3(), n0, t1);
    for (let tries = 0; tries < 40; tries++) {
      const a = r.range(0, Math.PI * 2), d = dist ?? r.range(50, 140);
      const c0 = vnorm(v3(), v3(near.x + (t1.x * Math.cos(a) + t2.x * Math.sin(a)) * d, near.y + (t1.y * Math.cos(a) + t2.y * Math.sin(a)) * d, near.z + (t1.z * Math.cos(a) + t2.z * Math.sin(a)) * d));
      if (heightAt(pl, c0.x, c0.y, c0.z) > -5) continue;
      const herd = ++this.herds;
      const out: Creature[] = [];
      const count = r.int(sp.herd[0], sp.herd[1]);
      for (let i = 0; i < count; i++) {
        const o = i === 0 ? v3() : v3((r.float() - 0.5) * 16, 0, (r.float() - 0.5) * 16);
        const dd = vnorm(v3(), v3(c0.x * pl.radius + t1.x * o.x + t2.x * o.z, c0.y * pl.radius + t1.y * o.x + t2.y * o.z, c0.z * pl.radius + t1.z * o.x + t2.z * o.z));
        const h = heightAt(pl, dd.x, dd.y, dd.z);
        if (h > -4) continue;
        const depth = Math.min(-h - 1.8, 2.5 + r.float() * 9);
        const f = vnorm(v3(), v3(t1.x * Math.cos(i + a) + t2.x * Math.sin(i + a), t1.y * Math.cos(i + a) + t2.y * Math.sin(i + a), t1.z * Math.cos(i + a) + t2.z * Math.sin(i + a)));
        const c: Creature = {
          id: this.sys.nextId(), sp, planet, herd, home: { ...c0 }, hp: sp.hp, dead: false, deadUntil: 0,
          state: { p: vscale(v3(), dd, pl.radius - depth), v: v3(), f },
          mood: 'wander', moodUntil: this.sys.time + r.range(1, 4), wish: { ...f }, target: 0, biteCool: 0,
        };
        this.creatures.set(c.id, c);
        this.sys.infos.push(this.info(c));
        out.push(c);
      }
      return out;
    }
    return [];
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
      // out of air: the suit floods a little every second
      if (ch.state.air <= 0) {
        ch.drown += dt;
        if (ch.drown >= 1) { ch.drown -= 1; this.hurt(ch.session, DROWN_DMG, 0); }
      } else ch.drown = 0;
      const g = ch.session.gear();
      if (ch.hp < ch.maxHp && t - ch.hurtAt > g.regenDelay) ch.hp = Math.min(ch.maxHp, ch.hp + g.regenRate * dt);
    }

    for (const c of [...this.creatures.values()]) {
      if (c.dead) {
        if (t > c.deadUntil) this.remove(c);
        else if (c.sp.drone) {
          // a downed drone drops to the deck
          const pl = this.sys.def.planets[c.planet];
          vnorm(up, c.state.p);
          const floor = pl.radius + footHeight(pl, up.x, up.y, up.z) + 0.35, l = vlen(c.state.p);
          if (l > floor) vscale(c.state.p, up, Math.max(floor, l - 4 * dt));
        }
        else if (c.sp.aquatic) {
          // a carcass floats up to the surface
          const R = this.sys.def.planets[c.planet].radius, l = vlen(c.state.p), to = Math.min(R - 0.35, l + 0.5 * dt);
          if (to > l) vscale(c.state.p, c.state.p, to / l);
        }
        continue;
      }
      const pl = this.sys.def.planets[c.planet];
      if (c.sp.drone) { this.stepDrone(c, pl, dt); continue; }
      if (c.sp.aquatic) { this.stepSea(c, pl, dt); continue; }
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
        if (c.mood !== 'flee' && c.mood !== 'hunt' && prey && pd < AGGRO) {
          c.mood = 'hunt';
          c.target = prey.id;
          this.sys.events.push({ t: 'roar', id: c.id });
        }
        if (c.mood === 'hunt' && (!prey || pd > AGGRO * 1.6)) { c.mood = 'wander'; c.moodUntil = t; }
      } else if (c.mood !== 'flee' && prey && pd < SPOOK) this.scare(c, prey.char!.state.p);
      else if (c.mood !== 'flee' && prey && pd < ALERT) {
        // heads up: freeze and watch the pilot before bolting
        if (c.mood !== 'alert') { c.mood = 'alert'; c.moodUntil = t + 2; }
        this.face(c, this.tangent(vsub(tmp, prey.char!.state.p, c.state.p)), dt);
      } else if (c.mood === 'alert') { c.mood = 'graze'; c.moodUntil = t + this.rng.range(1, 3); }

      if (c.mood === 'flee' && t > c.moodUntil) { c.mood = 'wander'; c.moodUntil = t; }
      let speed = 0;
      if (c.mood === 'hunt' && prey?.char) {
        c.wish = this.tangent(vsub(tmp, prey.char.state.p, c.state.p));
        // close in, then hold at jaw's length instead of walking through the pilot
        const reach = 1.3 + c.sp.size * 1.1;
        speed = pd > 6 ? c.sp.run : pd > reach ? c.sp.walk : 0;
        if (speed === 0) this.face(c, c.wish, dt * 1.5);
        if (pd < reach + 0.5 && c.biteCool <= 0) {
          c.biteCool = 1.3;
          this.sys.events.push({ t: 'bite', id: c.id });
          this.hurt(prey, c.sp.bite, c.id);
        }
      } else if (c.mood === 'flee') {
        speed = c.sp.run;
      } else if (c.mood === 'alert') {
        speed = 0;
      } else {
        if (t > c.moodUntil) {
          // alternate between grazing in place and ambling around the herd's home
          if (c.mood === 'graze' && !c.sp.predator && this.rng.chance(0.2)) {
            // lie down for a while
            c.mood = 'rest';
            c.moodUntil = t + this.rng.range(8, 15);
            c.wish = null;
          } else if (c.mood === 'graze' || c.mood === 'rest') {
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

  /** Sea creatures: cruise around their home waters, bolt from swimmers, sharks hunt them. */
  private stepSea(c: Creature, pl: PlanetDef, dt: number) {
    const t = this.sys.time;
    c.biteCool -= dt;
    vnorm(up, c.state.p);
    // closest pilot in the water (their body, not their feet)
    let prey: Session | null = null, pd = 1e9;
    const body = v3();
    for (const ch of this.sys.chars.values()) {
      if (ch.planet !== c.planet || !ch.state.swim) continue;
      const u = vnorm(tmp, ch.state.p);
      const b = v3(ch.state.p.x + u.x * 0.9, ch.state.p.y + u.y * 0.9, ch.state.p.z + u.z * 0.9);
      const d = vdist(b, c.state.p);
      if (d < pd) { pd = d; prey = ch.session; body.x = b.x; body.y = b.y; body.z = b.z; }
    }
    if (c.sp.predator) {
      if (c.mood !== 'flee' && c.mood !== 'hunt' && prey && pd < SEA_AGGRO) {
        c.mood = 'hunt';
        c.target = prey.id;
        this.sys.events.push({ t: 'roar', id: c.id });
      }
      if (c.mood === 'hunt' && (!prey || pd > SEA_AGGRO * 1.6)) { c.mood = 'wander'; c.moodUntil = t; }
    } else if (c.mood !== 'flee' && prey && pd < SEA_SPOOK) this.scare(c, body);
    if (c.mood === 'flee' && t > c.moodUntil) { c.mood = 'wander'; c.moodUntil = t; }

    let speed = 0;
    if (c.mood === 'hunt' && prey) {
      c.wish = vnorm(v3(), vsub(v3(), body, c.state.p));
      const reach = 1.1 + c.sp.size * 0.9;
      speed = pd > 7 ? c.sp.run : pd > reach ? c.sp.walk * 1.4 : 0;
      if (speed === 0) c.state.f = vnorm(v3(), v3(c.state.f.x + c.wish.x * dt * 3, c.state.f.y + c.wish.y * dt * 3, c.state.f.z + c.wish.z * dt * 3));
      if (pd < reach + 0.5 && c.biteCool <= 0) {
        c.biteCool = 1.4;
        this.sys.events.push({ t: 'bite', id: c.id });
        this.hurt(prey, c.sp.bite, c.id);
      }
    } else if (c.mood === 'flee') {
      speed = c.sp.run;
    } else {
      if (t > c.moodUntil) {
        // cruise in a new direction, gently climbing or diving; drift back towards home waters
        const slow = !c.sp.predator && this.rng.chance(0.3);
        c.mood = slow ? 'graze' : 'wander';
        c.moodUntil = t + this.rng.range(4, 9);
        const R = pl.radius;
        const off = vdist(vnorm(dir, c.state.p), c.home) * R;
        const w = off > 50 ? vsub(v3(), v3(c.home.x * R, c.home.y * R, c.home.z * R), c.state.p) : v3(this.rng.range(-1, 1), this.rng.range(-1, 1), this.rng.range(-1, 1));
        const tg = this.tangent(w);
        const vert = this.rng.range(-0.35, 0.35);
        c.wish = vnorm(v3(), v3(tg.x + up.x * vert, tg.y + up.y * vert, tg.z + up.z * vert));
      }
      speed = c.mood === 'graze' ? c.sp.walk * 0.45 : c.sp.walk;
    }
    if (!stepSwimmer(c.state, pl, speed > 0 ? c.wish : null, speed, dt)) c.wish = { ...c.state.f };
  }

  /** Turns a creature in place towards tangent direction `d`. */
  private face(c: Creature, d: V3, dt: number) {
    const k = Math.min(1, dt * 4);
    c.state.f.x += (d.x - c.state.f.x) * k; c.state.f.y += (d.y - c.state.f.y) * k; c.state.f.z += (d.z - c.state.f.z) * k;
  }

  /** Projects a vector onto the local tangent plane (uses `up`). */
  private tangent(v: V3): V3 {
    const k = v.x * up.x + v.y * up.y + v.z * up.z;
    return vnorm(v3(), v3(v.x - up.x * k, v.y - up.y * k, v.z - up.z * k));
  }

  /** Makes a grazer (and its herd) bolt away from `from` (sea creatures also dive or climb away). */
  private scare(c: Creature, from: V3) {
    const t = this.sys.time;
    for (const o of this.creatures.values()) {
      if (o.herd !== c.herd || o.dead || o.sp.predator) continue;
      vnorm(up, o.state.p);
      o.mood = 'flee';
      o.moodUntil = t + this.rng.range(5, 8);
      o.wish = o.sp.aquatic ? vnorm(v3(), vsub(v3(), o.state.p, from)) : this.tangent(vsub(tmp, o.state.p, from));
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
    // terrain stops the bolt (water does not)
    const ground = liquidOf(pl) === 'water' ? heightAt : footHeight;
    let reach: number = BLASTER.range;
    for (let k = 1; k <= 14; k++) {
      const d = (BLASTER.range * k) / 14;
      const px = o.x + dir.x * d, py = o.y + dir.y * d, pz = o.z + dir.z * d;
      const l = Math.hypot(px, py, pz);
      if (l < pl.radius + ground(pl, px / l, py / l, pz / l)) { reach = d; break; }
    }
    const end = v3(o.x + dir.x * reach, o.y + dir.y * reach, o.z + dir.z * reach);
    let hit: Creature | null = null, best = 2;
    for (const c of this.creatures.values()) {
      if (c.planet !== ch.planet || c.dead) continue;
      const cu = vnorm(tmp, c.state.p);
      const lift = c.sp.aquatic || c.sp.drone ? 0 : c.sp.size * 0.8;
      const center = v3(c.state.p.x + cu.x * lift, c.state.p.y + cu.y * lift, c.state.p.z + cu.z * lift);
      const tt = segmentSphere(o, end, center, c.sp.drone ? 0.9 : c.sp.size * 1.05);
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
    if (c.sp.drone) c.target = by.id;
    else if (c.sp.predator) {
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
      if (c.guard) this.guardRespawn.set(`${c.planet}:${c.guard.site.id}:${c.guard.post}`, this.sys.time + DRONE_RESPAWN);
      by.msg(c.sp.drone ? 'Дрон-охранник сбит — подойдите и нажмите F, чтобы разобрать его' : `${c.sp.name} повержен — подойдите и нажмите F, чтобы взять биообразцы`, 'good');
      this.sys.contracts.onCreatureKill(by, c.sp.id, c.planet);
    }
  }

  /** Collect bio samples from a carcass. */
  sample(s: Session, id: number): string | null {
    const ch = s.char;
    const c = this.creatures.get(id);
    if (!ch || !c || !c.dead || c.planet !== ch.planet) return 'Здесь нечего брать';
    if (vdist(c.state.p, ch.state.p) > SAMPLE_RANGE + c.sp.size) return 'Подойдите ближе';
    const free = combatStats(s.pilot.upgrades, s.pilot.ship).cargoCap - cargoCount(s.pilot.cargo);
    if (c.sp.drone) {
      // a downed drone is stripped for crystals and saleable parts
      const n = Math.min(free, this.rng.int(1, 2)), credits = this.rng.int(30, 60);
      s.pilot.cargo.crystal += n;
      s.pilot.credits += credits;
      s.sendPilot();
      this.remove(c);
      const pl = this.sys.def.planets[c.planet];
      toWorldPoint(pl, planetRot(pl, this.sys.time, rot), c.state.p, wp);
      s.sendJson(MSG.EVENTS, { ev: [{ t: 'loot', text: `Дрон разобран: ${n ? `кристаллы ×${n}, ` : ''}+${credits} кр`, pos: [wp.x, wp.y, wp.z] }] });
      return null;
    }
    if (free <= 0) return 'Трюм полон';
    const n = Math.min(free, c.sp.samples + s.gear().samples);
    s.pilot.cargo.bio += n;
    s.sendPilot();
    this.remove(c);
    const pl = this.sys.def.planets[c.planet];
    toWorldPoint(pl, planetRot(pl, this.sys.time, rot), c.state.p, wp);
    s.sendJson(MSG.EVENTS, { ev: [{ t: 'loot', text: `Биообразцы ×${n}`, pos: [wp.x, wp.y, wp.z] }] });
    return null;
  }

  /** Suit damage; a pilot who drops to zero is hauled back to the ship and loses half the cargo. */
  /**
   * Weather damage (`dmg` for this tick): mild exposure lets the suit keep repairing itself,
   * the client hears about it every couple of seconds rather than every tick.
   */
  hazard(s: Session, dmg: number, stopsRegen: boolean, cause: string) {
    const ch = s.char;
    if (!ch || s.ship.god || dmg <= 0) return;
    const t = this.sys.time;
    if (stopsRegen) ch.hurtAt = t;
    ch.hp -= dmg;
    if (t - (ch.hazardAt ?? -99) > 2) { ch.hazardAt = t; s.sendJson(MSG.EVENTS, { ev: [{ t: 'hurt', dmg: Math.round(dmg * 4), by: 0 }] }); }
    if (ch.hp <= 0) this.down(s, `Скафандр не выдержал (${cause})`);
  }

  hurt(s: Session, dmg: number, by: number) {
    const ch = s.char;
    if (!ch || s.ship.god) return;
    ch.hp -= dmg;
    ch.hurtAt = this.sys.time;
    s.sendJson(MSG.EVENTS, { ev: [{ t: 'hurt', dmg, by }] });
    if (ch.hp > 0) return;
    this.down(s, 'Скафандр пробит');
  }

  /** The suit gave out: a rescue drone hauls the pilot back to the ship, half the cargo is lost. */
  private down(s: Session, why: string) {
    let lost = 0;
    for (const k of CARGO_KEYS) { const n = Math.floor(s.pilot.cargo[k] / 2); s.pilot.cargo[k] -= n; lost += n; }
    this.sys.recallPilot(s);
    s.sendPilot();
    s.msg(lost ? `${why} — спасательный дрон вернул вас на корабль. Потеряно груза: ${lost} ед.` : `${why} — спасательный дрон вернул вас на корабль.`, 'warn');
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
        hull: c.hp / c.sp.hp, shield: 0, throttle: moodByte(c.mood),
      });
    }
  }

  /** Test/dev helper: spawn a herd of a species right next to a point (sea species in nearby water). */
  devSpawn(planet: number, near: V3, species: number, dist = 40) {
    const sp = SPECIES[species];
    return sp.aquatic ? this.spawnSea(planet, near, sp, dist) : this.spawnHerd(planet, near, sp, dist);
  }
}
