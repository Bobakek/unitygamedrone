import type { PlanetDef } from '../galaxy/system-gen.ts';
import { qaxisAngle, qmul, qrot, quat, v3, type Quat, type V3 } from '../math/vec.ts';

/**
 * Rotating planet reference frames.
 *
 * Planets spin about a tilted axis. Close to a planet (inside FRAME_IN radii)
 * ships and pilots live in that planet's body frame: coordinates relative to
 * its centre that rotate with the ground, so terrain, landing and walking are
 * time-independent. Everything else (station, gates, fields, lasers, missiles)
 * stays in the static world frame. Conversions happen at a known time `t`.
 */
export const FRAME_IN = 2.0;
export const FRAME_OUT = 2.1;

export interface Pose { p: V3; v: V3; q: Quat }
export const newPose = (): Pose => ({ p: v3(), v: v3(), q: quat() });

/** Body → world rotation of a planet at time t. */
export function planetRot(pl: PlanetDef, t: number, out: Quat = quat()): Quat {
  return qaxisAngle(out, pl.spinAxis.x, pl.spinAxis.y, pl.spinAxis.z, pl.spinPhase + pl.spinRate * t);
}

const inv = quat(), w = v3(), rp = v3();
const conj = (q: Quat): Quat => { inv.x = -q.x; inv.y = -q.y; inv.z = -q.z; inv.w = q.w; return inv; };

/** out = centre + R·pb */
export function toWorldPoint(pl: PlanetDef, R: Quat, pb: V3, out: V3): V3 {
  qrot(out, R, pb);
  out.x += pl.center.x; out.y += pl.center.y; out.z += pl.center.z;
  return out;
}

/** out = R⁻¹·(pw − centre) */
export function toBodyPoint(pl: PlanetDef, R: Quat, pw: V3, out: V3): V3 {
  w.x = pw.x - pl.center.x; w.y = pw.y - pl.center.y; w.z = pw.z - pl.center.z;
  return qrot(out, conj(R), w);
}

/** Direction (no translation): out = R·db */
export function toWorldDir(R: Quat, db: V3, out: V3): V3 { return qrot(out, R, db); }
/** Direction (no translation): out = R⁻¹·dw */
export function toBodyDir(R: Quat, dw: V3, out: V3): V3 { return qrot(out, conj(R), dw); }

/** World velocity of a body-frame point: R·vb + ω × (R·pb). */
export function toWorldVel(pl: PlanetDef, R: Quat, pb: V3, vb: V3, out: V3): V3 {
  qrot(rp, R, pb);
  const a = pl.spinAxis, k = pl.spinRate;
  const cx = (a.y * rp.z - a.z * rp.y) * k, cy = (a.z * rp.x - a.x * rp.z) * k, cz = (a.x * rp.y - a.y * rp.x) * k;
  qrot(out, R, vb);
  out.x += cx; out.y += cy; out.z += cz;
  return out;
}

/** Body velocity of a world point: R⁻¹·(vw − ω × (pw − centre)). */
export function toBodyVel(pl: PlanetDef, R: Quat, pw: V3, vw: V3, out: V3): V3 {
  const a = pl.spinAxis, k = pl.spinRate;
  const rx = pw.x - pl.center.x, ry = pw.y - pl.center.y, rz = pw.z - pl.center.z;
  w.x = vw.x - (a.y * rz - a.z * ry) * k;
  w.y = vw.y - (a.z * rx - a.x * rz) * k;
  w.z = vw.z - (a.x * ry - a.y * rx) * k;
  return qrot(out, conj(R), w);
}

export function toWorldQuat(R: Quat, qb: Quat, out: Quat): Quat { return qmul(out, R, qb); }
export function toBodyQuat(R: Quat, qw: Quat, out: Quat): Quat { return qmul(out, conj(R), qw); }

/** Minimal shape shared by ships and other frame-aware states. */
export interface Framed { p: V3; v: V3; q: Quat; frame: number }

const R0 = quat();

/** World pose of a framed state at time t. */
export function worldPose(s: Framed, planets: PlanetDef[], t: number, out: Pose): Pose {
  if (!s.frame) {
    out.p.x = s.p.x; out.p.y = s.p.y; out.p.z = s.p.z;
    out.v.x = s.v.x; out.v.y = s.v.y; out.v.z = s.v.z;
    out.q.x = s.q.x; out.q.y = s.q.y; out.q.z = s.q.z; out.q.w = s.q.w;
    return out;
  }
  const pl = planets[s.frame - 1];
  const R = planetRot(pl, t, R0);
  toWorldVel(pl, R, s.p, s.v, out.v);
  toWorldPoint(pl, R, s.p, out.p);
  toWorldQuat(R, s.q, out.q);
  return out;
}

const tp = v3(), tv = v3(), tq = quat();

/** Re-expresses a state in frame `frame` (0 = world) at time t, keeping its world motion. */
export function setFrame(s: Framed, frame: number, planets: PlanetDef[], t: number): void {
  if (s.frame === frame) return;
  if (s.frame) {
    const pl = planets[s.frame - 1];
    const R = planetRot(pl, t, R0);
    toWorldVel(pl, R, s.p, s.v, tv);
    toWorldPoint(pl, R, s.p, tp);
    toWorldQuat(R, s.q, tq);
    s.p.x = tp.x; s.p.y = tp.y; s.p.z = tp.z;
    s.v.x = tv.x; s.v.y = tv.y; s.v.z = tv.z;
    s.q.x = tq.x; s.q.y = tq.y; s.q.z = tq.z; s.q.w = tq.w;
    s.frame = 0;
  }
  if (frame) {
    const pl = planets[frame - 1];
    const R = planetRot(pl, t, R0);
    toBodyVel(pl, R, s.p, s.v, tv);
    toBodyPoint(pl, R, s.p, tp);
    toBodyQuat(R, s.q, tq);
    s.p.x = tp.x; s.p.y = tp.y; s.p.z = tp.z;
    s.v.x = tv.x; s.v.y = tv.y; s.v.z = tv.z;
    s.q.x = tq.x; s.q.y = tq.y; s.q.z = tq.z; s.q.w = tq.w;
    s.frame = frame;
  }
}

/** Enters a planet frame inside FRAME_IN radii and leaves it beyond FRAME_OUT (hysteresis). */
export function updateFrame(s: Framed, planets: PlanetDef[], t: number): boolean {
  if (s.frame) {
    const pl = planets[s.frame - 1];
    if (s.p.x * s.p.x + s.p.y * s.p.y + s.p.z * s.p.z <= (pl.radius * FRAME_OUT) ** 2) return false;
    setFrame(s, 0, planets, t);
    return true;
  }
  for (const pl of planets) {
    const dx = s.p.x - pl.center.x, dy = s.p.y - pl.center.y, dz = s.p.z - pl.center.z;
    if (dx * dx + dy * dy + dz * dz < (pl.radius * FRAME_IN) ** 2) {
      setFrame(s, pl.index + 1, planets, t);
      return true;
    }
  }
  return false;
}
