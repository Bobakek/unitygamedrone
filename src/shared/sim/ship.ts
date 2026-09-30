import { SHIP_LAND_HEIGHT } from '../constants.ts';
import { surfaceHeight } from '../planet/terrain.ts';
import {
  FWD, qaxisAngle, qlook, qmul, qnorm, qrot, quat, RIGHT, UP, v3, vaddScaled, vclampLen, vdot, vlen, vnorm, vscale, vsub,
  type Quat, type V3,
} from '../math/vec.ts';
import type { SimEnv } from './env.ts';

export interface ShipState {
  p: V3;
  v: V3;
  q: Quat;
  /** Boost energy 0..1. */
  boost: number;
  /** Cruise spool timer; cruise is active once it reaches CRUISE_SPOOL. */
  cruise: number;
  /** Seconds during which cruise is blocked (set by the server when hit). */
  cruiseBlock: number;
  /** Planet index + 1 while landed, 0 while flying. */
  landed: number;
}

export interface ShipInput {
  yaw: number; pitch: number; roll: number;
  throttle: number; strafeX: number; strafeY: number;
  boost: boolean; cruise: boolean;
}

export interface ShipStats {
  maxSpeed: number; boostSpeed: number; accel: number; strafe: number;
  turn: number; roll: number; cruiseSpeed: number; radius: number;
}

export const CRUISE_SPOOL = 2;
export const BASE_STATS: ShipStats = {
  maxSpeed: 220, boostSpeed: 380, accel: 110, strafe: 70, turn: 1.6, roll: 2.4, cruiseSpeed: 3200, radius: 5,
};

export const emptyInput = (): ShipInput => ({ yaw: 0, pitch: 0, roll: 0, throttle: 0, strafeX: 0, strafeY: 0, boost: false, cruise: false });

export function newShip(p: V3, q: Quat = quat()): ShipState {
  return { p: { ...p }, v: v3(), q: { ...q }, boost: 1, cruise: 0, cruiseBlock: 0, landed: 0 };
}

export function copyShip(dst: ShipState, s: ShipState): ShipState {
  dst.p.x = s.p.x; dst.p.y = s.p.y; dst.p.z = s.p.z;
  dst.v.x = s.v.x; dst.v.y = s.v.y; dst.v.z = s.v.z;
  dst.q.x = s.q.x; dst.q.y = s.q.y; dst.q.z = s.q.z; dst.q.w = s.q.w;
  dst.boost = s.boost; dst.cruise = s.cruise; dst.cruiseBlock = s.cruiseBlock; dst.landed = s.landed;
  return dst;
}
export const cloneShip = (s: ShipState): ShipState => copyShip(newShip(s.p), s);
export const isCruising = (s: ShipState) => s.cruise >= CRUISE_SPOOL;

/** True near large masses where the cruise drive cannot operate. */
export function cruiseInhibited(p: V3, env: SimEnv): boolean {
  for (const pl of env.planets) {
    const dx = p.x - pl.center.x, dy = p.y - pl.center.y, dz = p.z - pl.center.z;
    if (dx * dx + dy * dy + dz * dz < (pl.radius * 1.7) ** 2) return true;
  }
  const s = env.station.pos;
  if ((p.x - s.x) ** 2 + (p.y - s.y) ** 2 + (p.z - s.z) ** 2 < 3500 ** 2) return true;
  const st = env.star;
  if (p.x * p.x + p.y * p.y + p.z * p.z < (st.radius * 3) ** 2) return true;
  return false;
}

export interface StepOut { impact: number }

const f = v3(), r = v3(), u = v3(), d = v3(), desired = v3(), dv = v3(), qa = quat();

function collideSphere(s: ShipState, cx: number, cy: number, cz: number, rad: number, out?: StepOut) {
  const dx = s.p.x - cx, dy = s.p.y - cy, dz = s.p.z - cz;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= rad * rad) return;
  const dl = Math.sqrt(d2) || 1;
  const nx = dx / dl, ny = dy / dl, nz = dz / dl;
  s.p.x = cx + nx * rad; s.p.y = cy + ny * rad; s.p.z = cz + nz * rad;
  const vn = s.v.x * nx + s.v.y * ny + s.v.z * nz;
  if (vn < 0) {
    s.v.x -= nx * vn; s.v.y -= ny * vn; s.v.z -= nz * vn;
    if (out) out.impact = Math.max(out.impact, -vn);
  }
}

/** Advances a ship by dt. Shared verbatim by client prediction and the authoritative server. */
export function stepShip(s: ShipState, inp: ShipInput, st: ShipStats, env: SimEnv, dt: number, out?: StepOut): void {
  if (out) out.impact = 0;
  if (s.landed) {
    const pl = env.planets[s.landed - 1];
    if (inp.throttle > 0.05 || inp.strafeY > 0.2) {
      s.landed = 0;
      vnorm(d, vsub(d, s.p, pl.center));
      vscale(s.v, d, 14);
    } else {
      s.v.x = s.v.y = s.v.z = 0;
      s.cruise = 0;
      s.boost = Math.min(1, s.boost + 0.2 * dt);
      s.cruiseBlock = Math.max(0, s.cruiseBlock - dt);
      return;
    }
  }

  const cruising = s.cruise >= CRUISE_SPOOL;
  const tk = cruising ? 0.35 : 1;
  qmul(s.q, s.q, qaxisAngle(qa, 1, 0, 0, inp.pitch * st.turn * tk * dt));
  qmul(s.q, s.q, qaxisAngle(qa, 0, 1, 0, -inp.yaw * st.turn * tk * dt));
  qmul(s.q, s.q, qaxisAngle(qa, 0, 0, 1, -inp.roll * st.roll * dt));
  qnorm(s.q, s.q);
  qrot(f, s.q, FWD); qrot(r, s.q, RIGHT); qrot(u, s.q, UP);

  s.cruiseBlock = Math.max(0, s.cruiseBlock - dt);
  if (inp.cruise && s.cruiseBlock <= 0 && !cruiseInhibited(s.p, env)) s.cruise = Math.min(CRUISE_SPOOL, s.cruise + dt);
  else s.cruise = 0;
  const cruiseNow = s.cruise >= CRUISE_SPOOL;

  const boosting = inp.boost && !cruiseNow && s.boost > 0.01;
  if (boosting) s.boost = Math.max(0, s.boost - 0.3 * dt);
  else s.boost = Math.min(1, s.boost + 0.12 * dt);

  if (cruiseNow) {
    vscale(desired, f, st.cruiseSpeed);
  } else {
    const spd = boosting ? st.boostSpeed : st.maxSpeed;
    vscale(desired, f, inp.throttle * spd);
    vaddScaled(desired, desired, r, inp.strafeX * st.strafe);
    vaddScaled(desired, desired, u, inp.strafeY * st.strafe);
  }
  const speed = vlen(s.v);
  let accel = st.accel * (boosting ? 1.6 : 1);
  if (cruiseNow) accel = 900;
  else if (speed > st.boostSpeed * 1.05) accel = 2600;
  vsub(dv, desired, s.v);
  vclampLen(dv, dv, accel * dt);
  s.v.x += dv.x; s.v.y += dv.y; s.v.z += dv.z;
  vaddScaled(s.p, s.p, s.v, dt);

  // Planets: terrain collision and landing.
  for (const pl of env.planets) {
    vsub(d, s.p, pl.center);
    const dist = vlen(d);
    if (dist > pl.radius + pl.maxHeight * 1.5 + 60) continue;
    vscale(d, d, 1 / dist);
    const ground = pl.radius + surfaceHeight(pl, d.x, d.y, d.z);
    const minAlt = st.radius * 0.5;
    if (dist - ground < minAlt) {
      s.p.x = pl.center.x + d.x * (ground + minAlt);
      s.p.y = pl.center.y + d.y * (ground + minAlt);
      s.p.z = pl.center.z + d.z * (ground + minAlt);
      const vn = vdot(s.v, d);
      if (vn < 0) {
        vaddScaled(s.v, s.v, d, -vn);
        if (out) out.impact = Math.max(out.impact, -vn);
      }
    }
    const alt = vlen(vsub(dv, s.p, pl.center)) - ground;
    if (alt < SHIP_LAND_HEIGHT + 3.5 && vlen(s.v) < 25 && vdot(s.v, d) < 2 && inp.throttle <= 0.05 && !cruiseNow) {
      s.landed = pl.index + 1;
      s.v.x = s.v.y = s.v.z = 0;
      s.cruise = 0;
      s.p.x = pl.center.x + d.x * (ground + SHIP_LAND_HEIGHT);
      s.p.y = pl.center.y + d.y * (ground + SHIP_LAND_HEIGHT);
      s.p.z = pl.center.z + d.z * (ground + SHIP_LAND_HEIGHT);
      vaddScaled(f, f, d, -vdot(f, d));
      if (vlen(f) < 1e-3) vaddScaled(f, r, d, -vdot(r, d));
      vnorm(f, f);
      qlook(s.q, f, d);
    }
  }

  for (const fl of env.fields) {
    const dx = s.p.x - fl.center.x, dy = s.p.y - fl.center.y, dz = s.p.z - fl.center.z;
    if (dx * dx + dy * dy + dz * dz > (fl.radius + 300) ** 2) continue;
    for (const rock of fl.rocks) collideSphere(s, rock.x, rock.y, rock.z, rock.r + st.radius * 0.6, out);
  }
  collideSphere(s, env.station.pos.x, env.station.pos.y, env.station.pos.z, 70 + st.radius, out);
  collideSphere(s, env.star.pos.x, env.star.pos.y, env.star.pos.z, env.star.radius * 1.02, out);
}
