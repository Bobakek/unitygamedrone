/** Minimal double-precision vector/quaternion helpers for deterministic simulation. */
export interface V3 { x: number; y: number; z: number }
export interface Quat { x: number; y: number; z: number; w: number }

export const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
export const quat = (x = 0, y = 0, z = 0, w = 1): Quat => ({ x, y, z, w });

export function vset(o: V3, x: number, y: number, z: number): V3 { o.x = x; o.y = y; o.z = z; return o; }
export function vcopy(o: V3, a: V3): V3 { o.x = a.x; o.y = a.y; o.z = a.z; return o; }
export function vclone(a: V3): V3 { return { x: a.x, y: a.y, z: a.z }; }
export function vadd(o: V3, a: V3, b: V3): V3 { o.x = a.x + b.x; o.y = a.y + b.y; o.z = a.z + b.z; return o; }
export function vsub(o: V3, a: V3, b: V3): V3 { o.x = a.x - b.x; o.y = a.y - b.y; o.z = a.z - b.z; return o; }
export function vscale(o: V3, a: V3, s: number): V3 { o.x = a.x * s; o.y = a.y * s; o.z = a.z * s; return o; }
export function vaddScaled(o: V3, a: V3, b: V3, s: number): V3 { o.x = a.x + b.x * s; o.y = a.y + b.y * s; o.z = a.z + b.z * s; return o; }
export function vdot(a: V3, b: V3): number { return a.x * b.x + a.y * b.y + a.z * b.z; }
export function vlen(a: V3): number { return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z); }
export function vlenSq(a: V3): number { return a.x * a.x + a.y * a.y + a.z * a.z; }
export function vdist(a: V3, b: V3): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
export function vdistSq(a: V3, b: V3): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}
export function vcross(o: V3, a: V3, b: V3): V3 {
  const x = a.y * b.z - a.z * b.y, y = a.z * b.x - a.x * b.z, z = a.x * b.y - a.y * b.x;
  o.x = x; o.y = y; o.z = z; return o;
}
export function vnorm(o: V3, a: V3): V3 {
  const l = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  if (l < 1e-12) { o.x = 0; o.y = 1; o.z = 0; return o; }
  o.x = a.x / l; o.y = a.y / l; o.z = a.z / l; return o;
}
export function vlerp(o: V3, a: V3, b: V3, t: number): V3 {
  o.x = a.x + (b.x - a.x) * t; o.y = a.y + (b.y - a.y) * t; o.z = a.z + (b.z - a.z) * t; return o;
}
/** Clamp vector length to max. */
export function vclampLen(o: V3, a: V3, max: number): V3 {
  const l = vlen(a);
  if (l > max && l > 0) return vscale(o, a, max / l);
  return vcopy(o, a);
}

export function qcopy(o: Quat, a: Quat): Quat { o.x = a.x; o.y = a.y; o.z = a.z; o.w = a.w; return o; }
export function qmul(o: Quat, a: Quat, b: Quat): Quat {
  const x = a.x * b.w + a.w * b.x + a.y * b.z - a.z * b.y;
  const y = a.y * b.w + a.w * b.y + a.z * b.x - a.x * b.z;
  const z = a.z * b.w + a.w * b.z + a.x * b.y - a.y * b.x;
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  o.x = x; o.y = y; o.z = z; o.w = w; return o;
}
export function qnorm(o: Quat, a: Quat): Quat {
  const l = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z + a.w * a.w) || 1;
  o.x = a.x / l; o.y = a.y / l; o.z = a.z / l; o.w = a.w / l; return o;
}
export function qaxisAngle(o: Quat, ax: number, ay: number, az: number, angle: number): Quat {
  const h = angle / 2, s = Math.sin(h);
  o.x = ax * s; o.y = ay * s; o.z = az * s; o.w = Math.cos(h); return o;
}
/** Rotate vector v by quaternion q. */
export function qrot(o: V3, q: Quat, v: V3): V3 {
  const ix = q.w * v.x + q.y * v.z - q.z * v.y;
  const iy = q.w * v.y + q.z * v.x - q.x * v.z;
  const iz = q.w * v.z + q.x * v.y - q.y * v.x;
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  const x = ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y;
  const y = iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z;
  const z = iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x;
  o.x = x; o.y = y; o.z = z; return o;
}
/** Quaternion from orthonormal basis (columns right, up, back). */
export function qfromBasis(o: Quat, r: V3, u: V3, b: V3): Quat {
  const m00 = r.x, m01 = u.x, m02 = b.x;
  const m10 = r.y, m11 = u.y, m12 = b.y;
  const m20 = r.z, m21 = u.z, m22 = b.z;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    o.w = 0.25 / s; o.x = (m21 - m12) * s; o.y = (m02 - m20) * s; o.z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    o.w = (m21 - m12) / s; o.x = 0.25 * s; o.y = (m01 + m10) / s; o.z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    o.w = (m02 - m20) / s; o.x = (m01 + m10) / s; o.y = 0.25 * s; o.z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    o.w = (m10 - m01) / s; o.x = (m02 + m20) / s; o.y = (m12 + m21) / s; o.z = 0.25 * s;
  }
  return qnorm(o, o);
}
/** Orientation whose -Z axis points along `fwd` with +Y as close to `up` as possible. */
export function qlook(o: Quat, fwd: V3, up: V3): Quat {
  const b = vnorm(v3(), vscale(v3(), fwd, -1));
  const r = vcross(v3(), up, b);
  if (vlenSq(r) < 1e-10) vcross(r, Math.abs(b.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0), b);
  vnorm(r, r);
  const u = vcross(v3(), b, r);
  return qfromBasis(o, r, u, b);
}
export function qslerp(o: Quat, a: Quat, b: Quat, t: number): Quat {
  let bx = b.x, by = b.y, bz = b.z, bw = b.w;
  let cos = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let k0: number, k1: number;
  if (cos > 0.9995) { k0 = 1 - t; k1 = t; }
  else {
    const th = Math.acos(cos), s = Math.sin(th);
    k0 = Math.sin((1 - t) * th) / s; k1 = Math.sin(t * th) / s;
  }
  o.x = a.x * k0 + bx * k1; o.y = a.y * k0 + by * k1; o.z = a.z * k0 + bz * k1; o.w = a.w * k0 + bw * k1;
  return qnorm(o, o);
}

export const FWD: Readonly<V3> = { x: 0, y: 0, z: -1 };
export const UP: Readonly<V3> = { x: 0, y: 1, z: 0 };
export const RIGHT: Readonly<V3> = { x: 1, y: 0, z: 0 };
