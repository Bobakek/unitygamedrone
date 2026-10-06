import { qrot, type Quat, type V3 } from '../math/vec.ts';
import type { ShipInput, ShipStats } from './ship.ts';

/**
 * Auto-approach: steers a ship towards a (possibly moving) point and holds a given distance
 * from it. Produces ordinary pilot input, so client prediction and the server stay in step.
 */
export interface AutopilotState {
  /** Cruise drive requested (with hysteresis so it doesn't flicker at the threshold). */
  cruise: boolean;
}

export const newAutopilot = (): AutopilotState => ({ cruise: false });

/** Remaining distance above which the autopilot engages the cruise drive, and below which it drops it. */
export const AUTO_CRUISE_ON = 12000;
export const AUTO_CRUISE_OFF = 6000;

const inv = { x: 0, y: 0, z: 0, w: 1 }, loc = { x: 0, y: 0, z: 0 };
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/**
 * Fills `out` (yaw, pitch, throttle, boost, cruise) to bring a ship at `p`/`v`/`q` within
 * `range` metres of `tp` moving at `tv`. The nose points at `aim` when given (e.g. the lead
 * point for the guns), otherwise at the target itself.
 */
export function steerTo(
  p: V3, v: V3, q: Quat, tp: V3, tv: V3, range: number, st: ShipStats, ap: AutopilotState, out: ShipInput, aim?: V3,
): void {
  const dx = tp.x - p.x, dy = tp.y - p.y, dz = tp.z - p.z;
  const d = Math.hypot(dx, dy, dz) || 1;
  const nx = dx / d, ny = dy / d, nz = dz / d;
  const gap = d - range;

  // Turn: the aim direction in ship-local space (forward = -Z), proportional rate commands.
  const a = aim ?? tp;
  inv.x = -q.x; inv.y = -q.y; inv.z = -q.z; inv.w = q.w;
  qrot(loc, inv, { x: a.x - p.x, y: a.y - p.y, z: a.z - p.z });
  const yawErr = Math.atan2(loc.x, -loc.z);
  const pitchErr = Math.atan2(loc.y, Math.hypot(loc.x, loc.z));
  out.yaw = clamp(yawErr * 3, -1, 1);
  out.pitch = clamp(pitchErr * 3, -1, 1);
  out.roll = 0;
  out.strafeX = 0;
  out.strafeY = 0;
  // How well the nose points at the target (not the aim point): drives how hard we may thrust.
  const fl = Math.hypot(loc.x, loc.y, loc.z) || 1;
  const facing = a === tp ? -loc.z / fl : nx * fwdX(q) + ny * fwdY(q) + nz * fwdZ(q);

  // Closing speed that still lets us brake to a stop at `range`, plus the target's own drift.
  const closing = Math.sign(gap) * Math.sqrt(2 * st.accel * Math.abs(gap)) * 0.8;
  const drift = tv.x * nx + tv.y * ny + tv.z * nz;
  const vf = closing + drift;

  if (ap.cruise ? gap < AUTO_CRUISE_OFF : gap > AUTO_CRUISE_ON && facing > 0.985) ap.cruise = !ap.cruise;
  if (ap.cruise && facing < 0.9) ap.cruise = false;
  out.cruise = ap.cruise;

  out.boost = !ap.cruise && vf > st.maxSpeed * 1.05 && facing > 0.95 && gap > 1500;
  let thr = vf / (out.boost ? st.boostSpeed : st.maxSpeed);
  if (thr > 0) thr *= clamp((facing - 0.3) / 0.6, 0, 1) ** 2;
  // Too close, or the target is coming at us: back off while keeping the nose on it.
  out.throttle = clamp(thr, -0.3, 1);
  // Moving away fast in the wrong direction: kill speed before turning back in.
  if (v.x * nx + v.y * ny + v.z * nz < -st.maxSpeed * 0.5 && facing < 0) out.throttle = 0;
}

function fwdX(q: Quat) { return -2 * (q.x * q.z + q.w * q.y); }
function fwdY(q: Quat) { return -2 * (q.y * q.z - q.w * q.x); }
function fwdZ(q: Quat) { return -(1 - 2 * (q.x * q.x + q.y * q.y)); }
