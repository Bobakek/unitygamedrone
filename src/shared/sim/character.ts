import type { PlanetDef } from '../galaxy/system-gen.ts';
import { heightAt, surfaceHeight } from '../planet/terrain.ts';
import { qlook, v3, vcross, vdot, vlen, vnorm, vsub, type Quat, type V3 } from '../math/vec.ts';

export interface CharState {
  p: V3;
  v: V3;
  /** Heading: unit vector tangent to the planet surface. */
  f: V3;
  ground: number;
  fuel: number;
}
export interface CharInput { mx: number; mz: number; yawDelta: number; jump: boolean; sprint: boolean }

export const WALK_SPEED = 5;
export const SPRINT_SPEED = 9;

export const emptyCharInput = (): CharInput => ({ mx: 0, mz: 0, yawDelta: 0, jump: false, sprint: false });
export function newChar(p: V3, f: V3): CharState {
  return { p: { ...p }, v: v3(), f: { ...f }, ground: 1, fuel: 1 };
}
export function copyChar(dst: CharState, s: CharState): CharState {
  dst.p.x = s.p.x; dst.p.y = s.p.y; dst.p.z = s.p.z;
  dst.v.x = s.v.x; dst.v.y = s.v.y; dst.v.z = s.v.z;
  dst.f.x = s.f.x; dst.f.y = s.f.y; dst.f.z = s.f.z;
  dst.ground = s.ground; dst.fuel = s.fuel;
  return dst;
}

const up = v3(), right = v3(), tmp = v3(), wish = v3();

export function charUp(c: CharState, pl: PlanetDef, out: V3): V3 {
  return vnorm(out, vsub(out, c.p, pl.center));
}
export function charQuat(c: CharState, pl: PlanetDef, out: Quat): Quat {
  return qlook(out, c.f, charUp(c, pl, tmp));
}

/** On-foot movement over a spherical planet with gravity and a small jetpack. */
export function stepChar(c: CharState, inp: CharInput, pl: PlanetDef, dt: number): void {
  charUp(c, pl, up);
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

  const mx = Math.max(-1, Math.min(1, inp.mx)), mz = Math.max(-1, Math.min(1, inp.mz));
  wish.x = c.f.x * mz + right.x * mx; wish.y = c.f.y * mz + right.y * mx; wish.z = c.f.z * mz + right.z * mx;
  const wl = vlen(wish);
  const inWater = pl.sea && heightAt(pl, up.x, up.y, up.z) < 0;
  const spd = (inp.sprint ? SPRINT_SPEED : WALK_SPEED) * (inWater ? 0.45 : 1);
  if (wl > 1) { wish.x /= wl; wish.y /= wl; wish.z /= wl; }
  wish.x *= spd; wish.y *= spd; wish.z *= spd;

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
      c.fuel = Math.max(0, c.fuel - 0.45 * dt);
    }
  }
  c.v.x = tx + (wish.x - tx) * k + up.x * nvr;
  c.v.y = ty + (wish.y - ty) * k + up.y * nvr;
  c.v.z = tz + (wish.z - tz) * k + up.z * nvr;

  c.p.x += c.v.x * dt; c.p.y += c.v.y * dt; c.p.z += c.v.z * dt;

  charUp(c, pl, up);
  const dist = vlen(vsub(tmp, c.p, pl.center));
  const ground = pl.radius + surfaceHeight(pl, up.x, up.y, up.z);
  const alt = dist - ground;
  const falling = vdot(c.v, up) <= 0.01;
  if (alt <= 0 || (c.ground && alt < 0.7 && falling)) {
    c.p.x = pl.center.x + up.x * ground; c.p.y = pl.center.y + up.y * ground; c.p.z = pl.center.z + up.z * ground;
    const vn = vdot(c.v, up);
    if (vn < 0) { c.v.x -= up.x * vn; c.v.y -= up.y * vn; c.v.z -= up.z * vn; }
    c.ground = 1;
  } else {
    c.ground = 0;
  }
}
