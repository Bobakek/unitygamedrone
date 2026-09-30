import type { V3 } from '../math/vec.ts';

export const LASER = { speed: 1500, life: 1.25, cost: 4, cooldown: 0.11 } as const;
export const MISSILE = { speed: 330, turn: 2.8, life: 9, damage: 55, lockTime: 0.8, coneCos: Math.cos((16 * Math.PI) / 180), range: 3500 } as const;
export const ENERGY_REGEN = 22;
/** Muzzle positions in ship-local space (forward = -Z), alternated when firing. */
export const GUN_OFFSETS: Record<'fighter' | 'pirate' | 'freighter', V3[]> = {
  fighter: [{ x: -4.2, y: -0.4, z: -1.5 }, { x: 4.2, y: -0.4, z: -1.5 }],
  pirate: [{ x: -0.9, y: -0.8, z: -7 }, { x: 0.9, y: -0.8, z: -7 }],
  freighter: [{ x: 0, y: 5, z: -20 }],
};
export const SHIELD_DELAY = 3;

/** Segment p0→p1 against sphere (c, r); returns hit parameter t ∈ [0, 1] or -1. */
export function segmentSphere(p0: V3, p1: V3, c: V3, r: number): number {
  const dx = p1.x - p0.x, dy = p1.y - p0.y, dz = p1.z - p0.z;
  const fx = p0.x - c.x, fy = p0.y - c.y, fz = p0.z - c.z;
  const a = dx * dx + dy * dy + dz * dz;
  const b = 2 * (fx * dx + fy * dy + fz * dz);
  const cc = fx * fx + fy * fy + fz * fz - r * r;
  if (cc <= 0) return 0;
  if (a < 1e-12) return -1;
  const disc = b * b - 4 * a * cc;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= 1 ? t : -1;
}

/** Point to aim at so a projectile of speed `s` intercepts a target moving at constant velocity. */
export function leadPoint(shooter: V3, shooterVel: V3, target: V3, targetVel: V3, s: number, out: V3): V3 {
  const rx = target.x - shooter.x, ry = target.y - shooter.y, rz = target.z - shooter.z;
  const vx = targetVel.x - shooterVel.x, vy = targetVel.y - shooterVel.y, vz = targetVel.z - shooterVel.z;
  const a = vx * vx + vy * vy + vz * vz - s * s;
  const b = 2 * (rx * vx + ry * vy + rz * vz);
  const c = rx * rx + ry * ry + rz * rz;
  let t = 0;
  if (Math.abs(a) < 1e-6) t = b !== 0 ? -c / b : 0;
  else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a);
      t = Math.min(t1, t2) > 0 ? Math.min(t1, t2) : Math.max(t1, t2);
    }
  }
  if (!(t > 0)) t = 0;
  out.x = target.x + vx * t; out.y = target.y + vy * t; out.z = target.z + vz * t;
  return out;
}
