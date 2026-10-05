import type { PlanetDef } from '../galaxy/system-gen.ts';
import { footHeight, heightAt, liquidOf } from '../planet/terrain.ts';
import { collidersNear } from '../planet/prop-rules.ts';
import { wreckAt } from '../planet/sites.ts';
import { qlook, v3, vcross, vdot, vlen, vnorm, type Quat, type V3 } from '../math/vec.ts';
import { DEFAULT_GEAR, type GearStats } from '../outfit.ts';

/** Pilot on foot. Always expressed in its planet's rotating body frame (planet centre = origin). */
export interface CharState {
  p: V3;
  v: V3;
  /** Heading: unit vector tangent to the planet surface. */
  f: V3;
  ground: number;
  fuel: number;
  /** Obstacle traversal: 0 none, 1 vault (low, on the run), 2 climb over (higher, with jump). */
  climbMode: number;
  /** Seconds left of the traversal, of its rising part, and its speeds (m/s). */
  climb: number;
  climbRise: number;
  climbFwd: number;
  climbUp: number;
  /** 1 while scrambling up a steep slope (slower, hands down). */
  scramble: number;
  /** Swimming in deep water: 0 no, 1 at the surface, 2 under water (head submerged). */
  swim: number;
  /** Suit air supply 0..1 (drains while the head is under water). */
  air: number;
}
/**
 * `pitch` is the view elevation (radians): it aims the blaster and, under water, steers the
 * swim direction. `dive` (C / Ctrl) swims down; `jump` swims up.
 */
export interface CharInput { mx: number; mz: number; yawDelta: number; pitch: number; jump: boolean; sprint: boolean; dive: boolean }

export const WALK_SPEED = 5;
export const SPRINT_SPEED = 9;
/** Traversal timings (s) and limits (m). */
export const VAULT_TIME = 0.55;
export const CLIMB_TIME = 1.05;
export const VAULT_MAX = 1.35;
export const CLIMB_MAX = 3.2;
const STEP_MAX = 0.35;
const RADIUS = 0.35;
/** Grade (rise / run) above which the pilot scrambles on all fours. */
export const SCRAMBLE_GRADE = 0.9;
/** Water deeper than this (m) is swum in rather than waded through. */
export const WADE_MAX = 1.3;
/** Feet depth below the surface of a pilot floating at the surface (head and shoulders out). */
export const FLOAT_DEPTH = 1.2;
/** Feet depth at which the head goes under. */
export const HEAD_UNDER = FLOAT_DEPTH + 0.35;
export const SWIM_SPEED = 2.6;
export const SWIM_SPRINT = 4.2;
/** Seconds of air in the standard suit (gear can extend it). */
export const AIR_TIME = DEFAULT_GEAR.airTime;
/** The part of a pilot's gear the movement simulation needs. */
export type CharGear = Pick<GearStats, 'airTime' | 'fuelDrain'>;

/** Progress 0..1 of the current traversal. */
export const climbProgress = (c: CharState) => (c.climbMode ? 1 - c.climb / (c.climbMode === 1 ? VAULT_TIME : CLIMB_TIME) : 0);

export const emptyCharInput = (): CharInput => ({ mx: 0, mz: 0, yawDelta: 0, pitch: 0, jump: false, sprint: false, dive: false });
export function newChar(p: V3, f: V3): CharState {
  return { p: { ...p }, v: v3(), f: { ...f }, ground: 1, fuel: 1, climbMode: 0, climb: 0, climbRise: 0, climbFwd: 0, climbUp: 0, scramble: 0, swim: 0, air: 1 };
}
export function copyChar(dst: CharState, s: CharState): CharState {
  dst.p.x = s.p.x; dst.p.y = s.p.y; dst.p.z = s.p.z;
  dst.v.x = s.v.x; dst.v.y = s.v.y; dst.v.z = s.v.z;
  dst.f.x = s.f.x; dst.f.y = s.f.y; dst.f.z = s.f.z;
  dst.ground = s.ground; dst.fuel = s.fuel;
  dst.climbMode = s.climbMode; dst.climb = s.climb; dst.climbRise = s.climbRise; dst.climbFwd = s.climbFwd; dst.climbUp = s.climbUp;
  dst.scramble = s.scramble;
  dst.swim = s.swim; dst.air = s.air;
  return dst;
}

const up = v3(), right = v3(), tmp = v3(), wish = v3(), ahead = v3();

export function charUp(c: CharState, out: V3): V3 {
  return vnorm(out, c.p);
}
export function charQuat(c: CharState, out: Quat): Quat {
  return qlook(out, c.f, charUp(c, tmp));
}

/** What the weather adds to the simulation: wind in the planet's body frame (m/s). */
export interface CharEnv { wind: V3 }
const CALM: CharEnv = { wind: { x: 0, y: 0, z: 0 } };

/**
 * On-foot movement over a spherical planet with gravity, a small jetpack and swimming.
 * `gear` (air supply, jetpack consumption) comes from the pilot's outfit; `env.wind`
 * (see weather.ts) pushes the pilot along the ground and drifts them in the air.
 */
export function stepChar(c: CharState, inp: CharInput, pl: PlanetDef, dt: number, gear: CharGear = DEFAULT_GEAR, env: CharEnv = CALM): void {
  // the suit's air drains while the head is under water and refills above it
  c.air = c.swim === 2 ? Math.max(0, c.air - dt / gear.airTime) : Math.min(1, c.air + 0.3 * dt);
  charUp(c, up);
  // Turn heading about local up (positive yawDelta turns right).
  const th = -inp.yawDelta, cs = Math.cos(th), sn = Math.sin(th);
  vcross(tmp, up, c.f);
  const ud = vdot(up, c.f);
  c.f.x = c.f.x * cs + tmp.x * sn + up.x * ud * (1 - cs);
  c.f.y = c.f.y * cs + tmp.y * sn + up.y * ud * (1 - cs);
  c.f.z = c.f.z * cs + tmp.z * sn + up.z * ud * (1 - cs);
  const fu = vdot(c.f, up);
  c.f.x -= up.x * fu; c.f.y -= up.y * fu; c.f.z -= up.z * fu;
  if (vlen(c.f) < 1e-6) vcross(c.f, up, Math.abs(up.x) < 0.9 ? v3(1, 0, 0) : v3(0, 0, 1));
  vnorm(c.f, c.f);
  vcross(right, c.f, up);

  // --- scripted traversal over an obstacle: rise, then carry forward; no gravity or collisions
  if (c.climbMode) {
    const rising = c.climbRise > 0;
    c.climb = Math.max(0, c.climb - dt);
    c.climbRise = Math.max(0, c.climbRise - dt);
    const fwd = rising && c.climbMode === 2 ? c.climbFwd * 0.15 : c.climbFwd;
    const vu = rising ? c.climbUp : 0;
    c.v.x = c.f.x * fwd + up.x * vu; c.v.y = c.f.y * fwd + up.y * vu; c.v.z = c.f.z * fwd + up.z * vu;
    c.p.x += c.v.x * dt; c.p.y += c.v.y * dt; c.p.z += c.v.z * dt;
    charUp(c, up);
    const g = pl.radius + footHeight(pl, up.x, up.y, up.z);
    if (vlen(c.p) < g) { c.p.x = up.x * g; c.p.y = up.y * g; c.p.z = up.z * g; }
    c.ground = 0;
    if (c.climb <= 0) { c.climbMode = 0; c.climbRise = 0; }
    return;
  }

  const mx = Math.max(-1, Math.min(1, inp.mx)), mz = Math.max(-1, Math.min(1, inp.mz));
  // --- deep water: swim at the surface or dive
  if (liquidOf(pl) === 'water') {
    const seabed = heightAt(pl, up.x, up.y, up.z);
    if (seabed < -WADE_MAX && (c.swim || pl.radius - vlen(c.p) > FLOAT_DEPTH - 0.4)) {
      stepSwim(c, inp, pl, dt, mx, mz);
      return;
    }
  }
  c.swim = 0;
  // --- walking into a low obstacle: vault it on the run (or with jump); higher ones need jump to
  // climb — also from a jump/jetpack hop when the ledge is within reach
  if ((c.ground || inp.jump) && mz > 0.3 && startTraversal(c, inp, pl)) return;
  wish.x = c.f.x * mz + right.x * mx; wish.y = c.f.y * mz + right.y * mx; wish.z = c.f.z * mz + right.z * mx;
  const wl = vlen(wish);
  const inWater = pl.sea && heightAt(pl, up.x, up.y, up.z) < 0;
  if (wl > 1) { wish.x /= wl; wish.y /= wl; wish.z /= wl; }
  // steep uphill: scramble on hands and feet at half speed
  c.scramble = 0;
  if (c.ground && wl > 0.1) {
    const k = 0.8 / pl.radius / Math.min(1, wl);
    ahead.x = up.x + wish.x * k; ahead.y = up.y + wish.y * k; ahead.z = up.z + wish.z * k;
    vnorm(ahead, ahead);
    const grade = (footHeight(pl, ahead.x, ahead.y, ahead.z) - footHeight(pl, up.x, up.y, up.z)) / 0.8;
    if (grade > SCRAMBLE_GRADE) c.scramble = 1;
  }
  const spd = (inp.sprint ? SPRINT_SPEED : WALK_SPEED) * (inWater ? 0.45 : 1) * (c.scramble ? 0.5 : 1);
  wish.x *= spd; wish.y *= spd; wish.z *= spd;
  // wind: a push along the ground, a stronger drift in the air
  const w = env.wind, wu = vdot(w, up), wk = c.ground ? 0.15 : 0.45;
  wish.x += (w.x - up.x * wu) * wk; wish.y += (w.y - up.y * wu) * wk; wish.z += (w.z - up.z * wu) * wk;

  const vr = vdot(c.v, up);
  const tx = c.v.x - up.x * vr, ty = c.v.y - up.y * vr, tz = c.v.z - up.z * vr;
  const k = Math.min(1, (c.ground ? 12 : 2) * dt);
  let nvr = vr;
  if (c.ground) {
    nvr = 0;
    c.fuel = Math.min(1, c.fuel + 0.4 * dt);
    if (inp.jump) { nvr = 5.5; c.ground = 0; }
  } else {
    nvr -= pl.gravity * dt;
    if (inp.jump && c.fuel > 0) {
      nvr += (pl.gravity + 8) * dt;
      c.fuel = Math.max(0, c.fuel - gear.fuelDrain * dt);
    }
  }
  c.v.x = tx + (wish.x - tx) * k + up.x * nvr;
  c.v.y = ty + (wish.y - ty) * k + up.y * nvr;
  c.v.z = tz + (wish.z - tz) * k + up.z * nvr;

  c.p.x += c.v.x * dt; c.p.y += c.v.y * dt; c.p.z += c.v.z * dt;

  // Trunks and boulders are solid: push out horizontally (in the local tangent plane).
  charUp(c, up);
  for (const col of collidersNear(pl, up)) {
    const dx = c.p.x - col.x, dy = c.p.y - col.y, dz = c.p.z - col.z;
    const du = dx * up.x + dy * up.y + dz * up.z;
    if (du < -1 || du > 6 * col.r + 3) continue;
    const hx = dx - up.x * du, hy = dy - up.y * du, hz = dz - up.z * du;
    const hd = Math.sqrt(hx * hx + hy * hy + hz * hz);
    const rr = col.r + 0.35;
    if (hd >= rr || hd < 1e-6) continue;
    const k = (rr - hd) / hd;
    c.p.x += hx * k; c.p.y += hy * k; c.p.z += hz * k;
    const vn = (c.v.x * hx + c.v.y * hy + c.v.z * hz) / hd;
    if (vn < 0) { c.v.x -= (hx / hd) * vn; c.v.y -= (hy / hd) * vn; c.v.z -= (hz / hd) * vn; }
  }

  charUp(c, up);
  let dist = vlen(c.p);
  let ground = pl.radius + footHeight(pl, up.x, up.y, up.z);
  // a wrecked hull: its roof is a ceiling from inside and a floor from on top
  const hull = wreckAt(pl, c.p);
  if (hull) {
    if (dist >= hull.roof - 0.6) ground = Math.max(ground, hull.roof);
    else {
      const ceil = hull.roof - 2.0;
      if (dist > ceil && ceil > ground) {
        c.p.x = up.x * ceil; c.p.y = up.y * ceil; c.p.z = up.z * ceil;
        dist = ceil;
        const vu = vdot(c.v, up);
        if (vu > 0) { c.v.x -= up.x * vu; c.v.y -= up.y * vu; c.v.z -= up.z * vu; }
      }
    }
  }
  const alt = dist - ground;
  const falling = vdot(c.v, up) <= 0.01;
  if (alt <= 0 || (c.ground && alt < 0.7 && falling)) {
    c.p.x = up.x * ground; c.p.y = up.y * ground; c.p.z = up.z * ground;
    const vn = vdot(c.v, up);
    if (vn < 0) { c.v.x -= up.x * vn; c.v.y -= up.y * vn; c.v.z -= up.z * vn; }
    c.ground = 1;
  } else {
    c.ground = 0;
  }
}

/**
 * Swimming: at the surface the pilot floats with the head out and swims along it; looking
 * down while swimming forward (or holding dive) goes under, where forward follows the view
 * and jump / dive swim straight up / down. Water drags, a little buoyancy lifts an idle
 * diver, and the sea bed and the surface bound the motion.
 */
function stepSwim(c: CharState, inp: CharInput, pl: PlanetDef, dt: number, mx: number, mz: number) {
  c.scramble = 0;
  c.ground = 0;
  c.fuel = Math.min(1, c.fuel + 0.4 * dt);
  const sub = pl.radius - vlen(c.p);
  const under = sub > HEAD_UNDER - 0.1;
  const pc = Math.max(-1.3, Math.min(1.3, inp.pitch));
  const vert = (inp.jump ? 1 : 0) - (inp.dive ? 1 : 0);
  const steer = under || inp.dive || (mz > 0 && pc < -0.35);
  const cp = steer ? Math.cos(pc) : 1, sp = steer ? Math.sin(pc) : 0;
  wish.x = (c.f.x * cp + up.x * sp) * mz + right.x * mx + up.x * vert;
  wish.y = (c.f.y * cp + up.y * sp) * mz + right.y * mx + up.y * vert;
  wish.z = (c.f.z * cp + up.z * sp) * mz + right.z * mx + up.z * vert;
  const wl = vlen(wish);
  const spd = (inp.sprint ? SWIM_SPRINT : SWIM_SPEED) / Math.max(1, wl);
  wish.x *= spd; wish.y *= spd; wish.z *= spd;
  let wu = vdot(wish, up);
  // at the surface: bob on the float line; under water: drift slowly up when not steering up or down
  const want = !steer && vert <= 0 ? Math.max(-1.5, Math.min(2.5, (sub - FLOAT_DEPTH) * 2.5))
    : under && Math.abs(wu) < 0.05 ? 0.25 : wu;
  wish.x += up.x * (want - wu); wish.y += up.y * (want - wu); wish.z += up.z * (want - wu);
  const k = Math.min(1, 2.5 * dt);
  c.v.x += (wish.x - c.v.x) * k; c.v.y += (wish.y - c.v.y) * k; c.v.z += (wish.z - c.v.z) * k;
  c.p.x += c.v.x * dt; c.p.y += c.v.y * dt; c.p.z += c.v.z * dt;
  charUp(c, up);
  const l = vlen(c.p);
  const floor = pl.radius + heightAt(pl, up.x, up.y, up.z) + 0.3;
  const top = pl.radius - (FLOAT_DEPTH - 0.25);
  const lim = l < floor ? floor : l > top ? top : l;
  if (lim !== l) {
    c.p.x = up.x * lim; c.p.y = up.y * lim; c.p.z = up.z * lim;
    wu = vdot(c.v, up);
    if ((lim === floor) === (wu < 0)) { c.v.x -= up.x * wu; c.v.y -= up.y * wu; c.v.z -= up.z * wu; }
  }
  c.swim = pl.radius - lim > HEAD_UNDER ? 2 : 1;
}

/**
 * Checks for a climbable obstacle right in front of a walking pilot and starts
 * a vault (low, automatic when moving fast or on jump) or a climb (higher,
 * needs jump). Returns true if a traversal started.
 */
function startTraversal(c: CharState, inp: CharInput, pl: PlanetDef): boolean {
  const feet = vlen(c.p);
  const hs = Math.hypot(c.v.x - up.x * vdot(c.v, up), c.v.y - up.y * vdot(c.v, up), c.v.z - up.z * vdot(c.v, up));
  for (const col of collidersNear(pl, up)) {
    if (!Number.isFinite(col.top)) continue;
    const dx = col.x - c.p.x, dy = col.y - c.p.y, dz = col.z - c.p.z;
    const du = dx * up.x + dy * up.y + dz * up.z;
    const hx = dx - up.x * du, hy = dy - up.y * du, hz = dz - up.z * du;
    const hd = Math.sqrt(hx * hx + hy * hy + hz * hz);
    if (hd < 1e-6) continue;
    const gap = hd - col.r - RADIUS;
    if (gap > 0.55) continue;
    if ((hx * c.f.x + hy * c.f.y + hz * c.f.z) / hd < 0.6) continue;
    const height = Math.hypot(col.x, col.y, col.z) + col.top - feet;
    if (height < STEP_MAX || height > CLIMB_MAX) continue;
    const vault = height <= VAULT_MAX && (hs > 3 || inp.jump);
    if (!vault && !inp.jump) continue;
    const T = vault ? VAULT_TIME : CLIMB_TIME;
    const rise = vault ? 0.22 : 0.65;
    // far side: the rest of the gap, the obstacle's width and a step beyond
    const dist = Math.max(0, gap) + 2 * col.r + 2 * RADIUS + 0.4;
    c.climbMode = vault ? 1 : 2;
    c.climb = T;
    c.climbRise = rise;
    c.climbUp = (height + 0.3) / rise;
    c.climbFwd = dist / (vault ? T : 0.15 * rise + (T - rise));
    c.ground = 0;
    return true;
  }
  return false;
}
