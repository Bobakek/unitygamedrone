import type { PlanetDef } from '../galaxy/system-gen.ts';
import { heightAt } from '../planet/terrain.ts';
import { collidersNear } from '../planet/prop-rules.ts';
import { qlook, qnorm, qrot, quat, v3, vcross, vdot, vlen, vnorm, type Quat, type V3 } from '../math/vec.ts';
import type { CharInput } from './character.ts';

/**
 * Planetary rover: a rigid body on four raycast wheels with independent spring-damper
 * suspension, tyre grip limited by a friction circle, all-wheel drive, Ackermann-less
 * front steering, brakes and a handbrake on the rear axle. Body-frame of its planet
 * (centre = origin), the same as pilots on foot; gravity points at the centre.
 *
 * The same code runs on the server and in client prediction, so it must stay deterministic.
 * Model geometry (tools/blender/build_rover.py) matches the numbers below.
 */
export const ROVER = {
  mass: 900,
  /** Principal moments of inertia (kg m²) about local x (pitch), y (yaw), z (roll). */
  inertia: { x: 1300, y: 1600, z: 520 },
  /** Suspension top mounts, body coordinates (x right, y up, -z forward): FL, FR, RL, RR. */
  wheels: [v3(-1.15, -0.02, -1.3), v3(1.15, -0.02, -1.3), v3(-1.15, -0.02, 1.3), v3(1.15, -0.02, 1.3)] as readonly V3[],
  wheelR: 0.47,
  /** Suspension length (top mount → wheel centre): free, bump stop, and as modelled. */
  restLen: 0.5,
  minLen: 0.18,
  modelLen: 0.38,
  spring: 21000,
  damper: 2600,
  maxSteer: 0.55,
  steerRate: 2.2,
  /** Total drive force (N) and top speeds (m/s); boost = the "sprint" key. */
  engine: 6400,
  topSpeed: 16,
  boostSpeed: 23,
  reverseSpeed: 6,
  brake: 9000,
  /** Body points that hit the ground when the rover rolls or bottoms out (roof, bumpers, mast). */
  hull: [
    // roll cage roof, bumpers, the outer faces of the tyres, cage sides and the mast tip
    v3(-0.75, 1.15, -0.1), v3(0.75, 1.15, -0.1), v3(-0.7, 1.1, 0.45), v3(0.7, 1.1, 0.45),
    v3(-0.85, -0.3, -2.05), v3(0.85, -0.3, -2.05), v3(-0.85, -0.3, 2.0), v3(0.85, -0.3, 2.0),
    v3(-1.35, -0.05, -1.3), v3(1.35, -0.05, -1.3), v3(-1.35, -0.05, 1.3), v3(1.35, -0.05, 1.3),
    v3(-1.35, -0.75, -1.3), v3(1.35, -0.75, -1.3), v3(-1.35, -0.75, 1.3), v3(1.35, -0.75, 1.3),
    v3(-0.8, 0.6, -0.1), v3(0.8, 0.6, -0.1), v3(0.62, 1.9, 1.62),
  ] as readonly V3[],
  /** How close (m) a pilot must stand to take the wheel, and the rover must be to its ship to load it. */
  reach: 4.5,
  load: 40,
  /** Where the driver sits (body coordinates). */
  seat: v3(-0.36, 0.0, -0.3),
} as const;

const SUBSTEPS = 4;
/** Share of the side slip a tyre cancels per substep (stiffness of the grip). */
const LATERAL = 0.35;
/** How far above the contact patch the tyre forces act (m): lower = more prone to rolling. */
const ROLL_CENTRE = 0.4;
/** Airborne levelling torque (N m) and spin damping (N m s). */
const GYRO = 2600;
const GYRO_DAMP = 900;

export interface RoverState {
  p: V3;
  v: V3;
  q: Quat;
  /** Angular velocity (rad/s) in planet body coordinates. */
  w: V3;
  /** Front wheel angle (rad, positive = left). */
  steer: number;
  /** Current suspension lengths FL, FR, RL, RR (m). */
  susp: number[];
  /** Number of wheels touching the ground. */
  ground: number;
}

export function newRover(p: V3, q: Quat): RoverState {
  return { p: { ...p }, v: v3(), q: { ...q }, w: v3(), steer: 0, susp: [ROVER.modelLen, ROVER.modelLen, ROVER.modelLen, ROVER.modelLen], ground: 0 };
}

export function copyRover(dst: RoverState, s: RoverState): RoverState {
  dst.p.x = s.p.x; dst.p.y = s.p.y; dst.p.z = s.p.z;
  dst.v.x = s.v.x; dst.v.y = s.v.y; dst.v.z = s.v.z;
  dst.q.x = s.q.x; dst.q.y = s.q.y; dst.q.z = s.q.z; dst.q.w = s.q.w;
  dst.w.x = s.w.x; dst.w.y = s.w.y; dst.w.z = s.w.z;
  dst.steer = s.steer;
  for (let i = 0; i < 4; i++) dst.susp[i] = s.susp[i];
  dst.ground = s.ground;
  return dst;
}

/**
 * Height of the drivable surface: a frozen sea and lava crust are hard; water is forded and,
 * deeper than 0.9 m, the sealed hull floats at that level (see `afloat` in stepRover).
 */
export function roverGround(pl: PlanetDef, x: number, y: number, z: number): number {
  const h = heightAt(pl, x, y, z);
  if (!pl.sea || h >= 0) return h;
  return pl.type === 'ice' || pl.type === 'lava' ? 0 : Math.max(h, -0.9);
}

/** Tyre grip by planet: sand is loose, ice is slippery. */
export function roverGrip(pl: PlanetDef): number {
  return pl.type === 'ice' ? 0.38 : pl.type === 'desert' ? 0.75 : pl.type === 'barren' ? 0.85 : 1.0;
}

/** Is the rover lying on its side or roof? */
export function roverOverturned(r: RoverState): boolean {
  qrot(t0, r.q, UPL);
  vnorm(t1, r.p);
  return vdot(t0, t1) < 0.35;
}

/** Puts an overturned rover back on its wheels, keeping its heading, a little above the ground. */
export function rightRover(r: RoverState, pl: PlanetDef): void {
  const up = vnorm(v3(), r.p);
  const f = qrot(v3(), r.q, FWDL);
  const fu = vdot(f, up);
  let fx = f.x - up.x * fu, fy = f.y - up.y * fu, fz = f.z - up.z * fu;
  if (Math.hypot(fx, fy, fz) < 0.1) { const b = qrot(v3(), r.q, UPL); fx = b.x; fy = b.y; fz = b.z; }
  qlook(r.q, vnorm(v3(), v3(fx, fy, fz)), up);
  const g = pl.radius + Math.max(roverGround(pl, up.x, up.y, up.z), 0) + 1.6;
  r.p.x = up.x * g; r.p.y = up.y * g; r.p.z = up.z * g;
  r.v.x = r.v.y = r.v.z = 0;
  r.w.x = r.w.y = r.w.z = 0;
}

const UPL: V3 = { x: 0, y: 1, z: 0 };
const FWDL: V3 = { x: 0, y: 0, z: -1 };
const t0 = v3(), t1 = v3(), t2 = v3();
const A = v3(), C = v3(), r_ = v3(), vc = v3(), fw = v3(), rt = v3(), F = v3(), T = v3(), f_ = v3(), tau = v3(), upB = v3(), fwdB = v3(), rgtB = v3();
const gP = [v3(), v3(), v3(), v3()], gN = [v3(), v3(), v3(), v3()];
const meanP = v3(), meanN = v3();
const wq = quat(), dq = quat(), qi = quat();

/** Ground point and normal under unit direction `d` (normal from two nearby samples). */
function sampleGround(pl: PlanetDef, d: V3, P: V3, N: V3) {
  const R = pl.radius;
  const g = R + roverGround(pl, d.x, d.y, d.z);
  P.x = d.x * g; P.y = d.y * g; P.z = d.z * g;
  // tangents
  vcross(t1, d, Math.abs(d.y) < 0.9 ? UPL : { x: 1, y: 0, z: 0 });
  vnorm(t1, t1);
  vcross(t2, d, t1);
  const e = 0.7 / R;
  let ax = d.x + t1.x * e, ay = d.y + t1.y * e, az = d.z + t1.z * e;
  let l = Math.hypot(ax, ay, az); ax /= l; ay /= l; az /= l;
  const ga = R + roverGround(pl, ax, ay, az);
  let bx = d.x + t2.x * e, by = d.y + t2.y * e, bz = d.z + t2.z * e;
  l = Math.hypot(bx, by, bz); bx /= l; by /= l; bz /= l;
  const gb = R + roverGround(pl, bx, by, bz);
  const ux = ax * ga - P.x, uy = ay * ga - P.y, uz = az * ga - P.z;
  const wx = bx * gb - P.x, wy = by * gb - P.y, wz = bz * gb - P.z;
  N.x = uy * wz - uz * wy; N.y = uz * wx - ux * wz; N.z = ux * wy - uy * wx;
  vnorm(N, N);
  if (vdot(N, d) < 0) { N.x = -N.x; N.y = -N.y; N.z = -N.z; }
}

/**
 * Advances the rover by `dt`. Input: `mz` throttle (W/S), `mx` steering (D = right),
 * `jump` handbrake (Space), `sprint` boost (Shift).
 */
export function stepRover(r: RoverState, inp: CharInput, pl: PlanetDef, dt: number): void {
  const m = ROVER.mass, I = ROVER.inertia, Rw = ROVER.wheelR;
  const throttle = Math.max(-1, Math.min(1, inp.mz));
  const steerIn = Math.max(-1, Math.min(1, inp.mx));
  const grip = roverGrip(pl);
  const g = pl.gravity;

  // steering: slower at speed so the rover does not flip on every turn
  const speed = vlen(r.v);
  const want = -steerIn * ROVER.maxSteer / (1 + speed / 9);
  const ds = want - r.steer, maxDs = ROVER.steerRate * dt;
  r.steer += Math.max(-maxDs, Math.min(maxDs, ds));

  // ground under each wheel, once per tick: a local plane is good enough for the substeps
  for (let i = 0; i < 4; i++) {
    qrot(A, r.q, ROVER.wheels[i]);
    A.x += r.p.x; A.y += r.p.y; A.z += r.p.z;
    vnorm(t0, A);
    sampleGround(pl, t0, gP[i], gN[i]);
  }
  meanP.x = (gP[0].x + gP[1].x + gP[2].x + gP[3].x) / 4;
  meanP.y = (gP[0].y + gP[1].y + gP[2].y + gP[3].y) / 4;
  meanP.z = (gP[0].z + gP[1].z + gP[2].z + gP[3].z) / 4;
  meanN.x = gN[0].x + gN[1].x + gN[2].x + gN[3].x;
  meanN.y = gN[0].y + gN[1].y + gN[2].y + gN[3].y;
  meanN.z = gN[0].z + gN[1].z + gN[2].z + gN[3].z;
  vnorm(meanN, meanN);
  // deep water: the hull floats on the wheels' water line, the wheels only paddle
  const ml = vlen(meanP);
  const afloat = !!pl.sea && pl.type !== 'ice' && pl.type !== 'lava' && heightAt(pl, meanP.x / ml, meanP.y / ml, meanP.z / ml) < -0.9;

  const h = dt / SUBSTEPS;
  let contacts = r.ground, hullHits = 0;
  for (let s = 0; s < SUBSTEPS; s++) {
    F.x = F.y = F.z = 0;
    T.x = T.y = T.z = 0;
    qrot(upB, r.q, UPL);
    qrot(fwdB, r.q, FWDL);
    vcross(rgtB, fwdB, upB);
    // wheels sharing the load: from the previous substep
    const nContact = Math.max(1, contacts);
    contacts = 0;
    for (let i = 0; i < 4; i++) {
      const n = gN[i];
      qrot(A, r.q, ROVER.wheels[i]);
      A.x += r.p.x; A.y += r.p.y; A.z += r.p.z;
      // distance along the suspension axis (-up) to the ground plane
      const den = -vdot(upB, n);
      const prev = r.susp[i];
      if (den > -0.25) { r.susp[i] = ROVER.restLen; continue; }
      const t = ((gP[i].x - A.x) * n.x + (gP[i].y - A.y) * n.y + (gP[i].z - A.z) * n.z) / den;
      const len = t - Rw;
      if (len >= ROVER.restLen) { r.susp[i] = Math.min(ROVER.restLen, prev + 1.5 * h); continue; }
      contacts++;
      const L = Math.max(ROVER.minLen, len);
      let N = ROVER.spring * (ROVER.restLen - L) + ROVER.damper * (prev - L) / h;
      if (len < ROVER.minLen) N += ROVER.spring * 10 * (ROVER.minLen - len);
      N = Math.max(0, N) * -den;
      r.susp[i] = L;
      // contact point and its velocity
      C.x = A.x - upB.x * t; C.y = A.y - upB.y * t; C.z = A.z - upB.z * t;
      r_.x = C.x - r.p.x; r_.y = C.y - r.p.y; r_.z = C.z - r.p.z;
      vcross(vc, r.w, r_);
      vc.x += r.v.x; vc.y += r.v.y; vc.z += r.v.z;
      // wheel heading in the ground plane (front wheels steer about the body's up)
      if (i < 2) {
        const c = Math.cos(r.steer), sn = Math.sin(r.steer);
        // rotating -z by +steer about +y turns it to the left (-x)
        fw.x = fwdB.x * c - rgtB.x * sn; fw.y = fwdB.y * c - rgtB.y * sn; fw.z = fwdB.z * c - rgtB.z * sn;
      } else { fw.x = fwdB.x; fw.y = fwdB.y; fw.z = fwdB.z; }
      const fn = vdot(fw, n);
      fw.x -= n.x * fn; fw.y -= n.y * fn; fw.z -= n.z * fn;
      vnorm(fw, fw);
      vcross(rt, fw, n);
      const vf = vdot(vc, fw), vs = vdot(vc, rt);
      const share = m / Math.max(1, nContact);
      // sideways: grip cancels slip (half per substep keeps four coupled wheels calm)
      let Fs = -vs * share / h * LATERAL;
      // along the wheel: drive, brakes, rolling resistance, parking hold
      let Fl = -vf * 10;
      const moving = Math.abs(vf) > 0.6;
      if (inp.jump && i >= 2) Fl = -vf * share / h * 0.5;
      else if (throttle !== 0 && moving && Math.sign(throttle) !== Math.sign(vf)) {
        Fl = -Math.sign(vf) * ROVER.brake / 4 * Math.abs(throttle);
        if (Math.abs(Fl * h / share) > Math.abs(vf)) Fl = -vf * share / h;
      } else if (throttle > 0) {
        const top = inp.sprint ? ROVER.boostSpeed : ROVER.topSpeed;
        Fl += throttle * (ROVER.engine / 4) * Math.max(0, Math.min(1, 6 * (1 - vf / top))) * (inp.sprint ? 1.25 : 1) * (afloat ? 0.3 : 1);
      } else if (throttle < 0) {
        Fl += throttle * (ROVER.engine / 4) * 0.7 * Math.max(0, Math.min(1, 1 + vf / ROVER.reverseSpeed)) * (afloat ? 0.3 : 1);
      } else if (!moving && !afloat) Fl = -vf * share / h * 0.4;
      if (inp.jump && i < 2) Fl += -Math.sign(vf) * Math.min(Math.abs(vf) * share / h, ROVER.brake / 8);
      // friction circle
      const lim = grip * N * (afloat ? 0.25 : 1);
      const ft = Math.hypot(Fl, Fs);
      if (ft > lim && ft > 0) { Fl *= lim / ft; Fs *= lim / ft; }
      // load on the contact patch; grip acts higher up, near the roll centre, which keeps the
      // rover from tripping over its own tyres in every hard turn
      f_.x = n.x * N; f_.y = n.y * N; f_.z = n.z * N;
      F.x += f_.x; F.y += f_.y; F.z += f_.z;
      vcross(tau, r_, f_);
      T.x += tau.x; T.y += tau.y; T.z += tau.z;
      f_.x = fw.x * Fl + rt.x * Fs; f_.y = fw.y * Fl + rt.y * Fs; f_.z = fw.z * Fl + rt.z * Fs;
      F.x += f_.x; F.y += f_.y; F.z += f_.z;
      r_.x += upB.x * ROLL_CENTRE; r_.y += upB.y * ROLL_CENTRE; r_.z += upB.z * ROLL_CENTRE;
      vcross(tau, r_, f_);
      T.x += tau.x; T.y += tau.y; T.z += tau.z;
    }
    // hull points against the mean ground plane: rolls end on the roll cage, not inside the ground
    hullHits = 0;
    for (const hp of ROVER.hull) {
      qrot(r_, r.q, hp);
      const px = r.p.x + r_.x, py = r.p.y + r_.y, pz = r.p.z + r_.z;
      const pen = (meanP.x - px) * meanN.x + (meanP.y - py) * meanN.y + (meanP.z - pz) * meanN.z;
      if (pen <= 0) continue;
      hullHits++;
      vcross(vc, r.w, r_);
      vc.x += r.v.x; vc.y += r.v.y; vc.z += r.v.z;
      const vn = vdot(vc, meanN);
      // soft contact; deep penetration (a bad landing) is pushed out instead of exploding
      const N = Math.max(0, 45000 * Math.min(pen, 0.2) - 4000 * vn);
      if (pen > 0.2) { const k = (pen - 0.2) * 0.3; r.p.x += meanN.x * k; r.p.y += meanN.y * k; r.p.z += meanN.z * k; }
      const tx = vc.x - meanN.x * vn, ty = vc.y - meanN.y * vn, tz = vc.z - meanN.z * vn;
      const tl = Math.hypot(tx, ty, tz);
      const Ff = tl > 1e-6 ? Math.min(0.6 * N, tl * m / h * 0.2) / tl : 0;
      f_.x = meanN.x * N - tx * Ff; f_.y = meanN.y * N - ty * Ff; f_.z = meanN.z * N - tz * Ff;
      F.x += f_.x; F.y += f_.y; F.z += f_.z;
      vcross(tau, r_, f_);
      T.x += tau.x; T.y += tau.y; T.z += tau.z;
    }
    // gravity, buoyancy and drag
    vnorm(t0, r.p);
    // gyro stabiliser: in the air it levels the rover towards the local vertical and calms the
    // spin, so most jumps end on the wheels (it is far too weak to stop a roll on the ground)
    if (!contacts && !hullHits) {
      vcross(tau, upB, t0);
      const gk = GYRO * Math.min(1, vlen(tau) * 4) / Math.max(1e-6, vlen(tau));
      T.x += tau.x * gk - r.w.x * GYRO_DAMP; T.y += tau.y * gk - r.w.y * GYRO_DAMP; T.z += tau.z * gk - r.w.z * GYRO_DAMP;
    }
    let ax = F.x / m - t0.x * g, ay = F.y / m - t0.y * g, az = F.z / m - t0.z * g;
    if (afloat) { ax -= r.v.x * 0.6; ay -= r.v.y * 0.6; az -= r.v.z * 0.6; }
    r.v.x += ax * h; r.v.y += ay * h; r.v.z += az * h;
    // angular: torque into body axes, divide by the principal moments, back to the planet frame
    qi.x = -r.q.x; qi.y = -r.q.y; qi.z = -r.q.z; qi.w = r.q.w;
    qrot(tau, qi, T);
    qrot(t1, qi, r.w);
    t1.x += tau.x / I.x * h; t1.y += tau.y / I.y * h; t1.z += tau.z / I.z * h;
    const damp = 1 - (contacts ? 0.6 : 0.15) * h;
    t1.x *= damp; t1.y *= damp; t1.z *= damp;
    qrot(r.w, r.q, t1);
    r.p.x += r.v.x * h; r.p.y += r.v.y * h; r.p.z += r.v.z * h;
    wq.x = r.w.x; wq.y = r.w.y; wq.z = r.w.z; wq.w = 0;
    qmul4(dq, wq, r.q);
    r.q.x += dq.x * 0.5 * h; r.q.y += dq.y * 0.5 * h; r.q.z += dq.z * 0.5 * h; r.q.w += dq.w * 0.5 * h;
    qnorm(r.q, r.q);
  }
  r.ground = contacts;

  // trees, boulders and pillars: three circles along the body push out sideways; the impulse
  // at the contact turns the rover, so a glancing hit swings it off instead of pinning it
  vnorm(t0, r.p);
  qrot(fwdB, r.q, FWDL);
  const cols = collidersNear(pl, t0, 6);
  for (let k = -1; k <= 1; k++) {
    const ox = fwdB.x * k * CIRCLE_OFF, oy = fwdB.y * k * CIRCLE_OFF, oz = fwdB.z * k * CIRCLE_OFF;
    for (const col of cols) {
      const dx = r.p.x + ox - col.x, dy = r.p.y + oy - col.y, dz = r.p.z + oz - col.z;
      const du = dx * t0.x + dy * t0.y + dz * t0.z;
      if (du < -2 || du > 6 * col.r + 3) continue;
      const hx = dx - t0.x * du, hy = dy - t0.y * du, hz = dz - t0.z * du;
      const hd = Math.sqrt(hx * hx + hy * hy + hz * hz);
      const rr = col.r + CIRCLE_R;
      if (hd >= rr || hd < 1e-6) continue;
      const nx = hx / hd, ny = hy / hd, nz = hz / hd;
      r.p.x += nx * (rr - hd); r.p.y += ny * (rr - hd); r.p.z += nz * (rr - hd);
      // contact point relative to the centre of mass and its approach speed
      r_.x = ox - nx * CIRCLE_R; r_.y = oy - ny * CIRCLE_R; r_.z = oz - nz * CIRCLE_R;
      vcross(vc, r.w, r_);
      const vn = (r.v.x + vc.x) * nx + (r.v.y + vc.y) * ny + (r.v.z + vc.z) * nz;
      if (vn >= 0) continue;
      f_.x = nx; f_.y = ny; f_.z = nz;
      const j = -1.2 * vn / effMass(r, r_, f_);
      applyImpulse(r, r_, nx * j, ny * j, nz * j);
    }
  }
  // never fall through the planet (very steep cliffs, numerical accidents)
  const floor = pl.radius + roverGround(pl, t0.x, t0.y, t0.z) + 0.25;
  const l = vlen(r.p);
  if (l < floor) {
    r.p.x = t0.x * floor; r.p.y = t0.y * floor; r.p.z = t0.z * floor;
    const vn = vdot(r.v, t0);
    if (vn < 0) { r.v.x -= t0.x * vn; r.v.y -= t0.y * vn; r.v.z -= t0.z * vn; }
  }
}

const CIRCLE_R = 1.1;
const CIRCLE_OFF = 1.15;

/** 1 / (effective mass) of the rover for an impulse along unit `n` at offset `r` from the centre of mass. */
function effMass(r: RoverState, ro: V3, n: V3): number {
  const I = ROVER.inertia;
  vcross(t1, ro, n);
  qi.x = -r.q.x; qi.y = -r.q.y; qi.z = -r.q.z; qi.w = r.q.w;
  qrot(t2, qi, t1);
  t2.x /= I.x; t2.y /= I.y; t2.z /= I.z;
  qrot(t1, r.q, t2);
  vcross(t2, t1, ro);
  return 1 / ROVER.mass + vdot(n, t2);
}

/** Applies impulse (jx, jy, jz) at offset `ro` from the centre of mass. */
function applyImpulse(r: RoverState, ro: V3, jx: number, jy: number, jz: number) {
  const I = ROVER.inertia;
  r.v.x += jx / ROVER.mass; r.v.y += jy / ROVER.mass; r.v.z += jz / ROVER.mass;
  t1.x = jx; t1.y = jy; t1.z = jz;
  vcross(t2, ro, t1);
  qi.x = -r.q.x; qi.y = -r.q.y; qi.z = -r.q.z; qi.w = r.q.w;
  qrot(t1, qi, t2);
  t1.x /= I.x; t1.y /= I.y; t1.z /= I.z;
  qrot(t2, r.q, t1);
  r.w.x += t2.x; r.w.y += t2.y; r.w.z += t2.z;
}

function qmul4(o: Quat, a: Quat, b: Quat): Quat {
  const x = a.x * b.w + a.w * b.x + a.y * b.z - a.z * b.y;
  const y = a.y * b.w + a.w * b.y + a.z * b.x - a.x * b.z;
  const z = a.z * b.w + a.w * b.z + a.x * b.y - a.y * b.x;
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  o.x = x; o.y = y; o.z = z; o.w = w;
  return o;
}

/**
 * Suspension lengths for drawing a rover seen from afar (remote players): where the wheels
 * would touch the ground for a given pose, without simulating it.
 */
export function roverWheelLengths(pl: PlanetDef, p: V3, q: Quat, out: number[]): number[] {
  qrot(upB, q, UPL);
  for (let i = 0; i < 4; i++) {
    qrot(A, q, ROVER.wheels[i]);
    A.x += p.x; A.y += p.y; A.z += p.z;
    vnorm(t0, A);
    const gr = pl.radius + roverGround(pl, t0.x, t0.y, t0.z);
    // height of the mount above the ground along the radial, projected on the suspension axis
    const hgt = vlen(A) - gr;
    const c = Math.max(0.3, vdot(upB, t0));
    out[i] = Math.max(ROVER.minLen, Math.min(ROVER.restLen, hgt / c - ROVER.wheelR));
  }
  return out;
}
