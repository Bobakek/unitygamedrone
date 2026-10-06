import * as THREE from 'three';
import { qlook, quat, v3, vcross, vnorm, type Quat, type V3 } from '../../shared/math/vec.ts';

const _q = quat();

/** Chase / third-person / orbit cameras. Produces a world position (double) and orientation. */
export class CameraRig {
  readonly pos = v3();
  readonly quat = new THREE.Quaternion();
  private lag = new THREE.Quaternion();
  private ready = false;
  private orbitA = 0;
  private dist = 16;
  /** Camera shake (hits, recoil, nearby blasts), decaying; `shakeT` drives its wobble. */
  private shakeK = 0;
  private shakeT = 0;
  private shakeQ = new THREE.Quaternion();
  private shakeE = new THREE.Euler();

  /** Adds a jolt (0..1 is a solid hit; it saturates). */
  shake(k: number) {
    this.shakeK = Math.min(1.2, this.shakeK + k);
  }

  /** Chase camera behind the ship; `size` (collision radius) pulls it back for big hulls. */
  ship(dt: number, p: V3, q: Quat, speed: number, cruising: boolean, landed: boolean, size = 5) {
    const k = 1 + Math.max(0, size - 5) * 0.24;
    const target = new THREE.Quaternion(q.x, q.y, q.z, q.w);
    if (!this.ready) { this.lag.copy(target); this.ready = true; }
    this.lag.slerp(target, 1 - Math.exp(-dt * 7));
    const want = (landed ? 20 : 15 + Math.min(speed / 60, 8) + (cruising ? 10 : 0)) * k;
    this.dist += (want - this.dist) * (1 - Math.exp(-dt * 3));
    const off = new THREE.Vector3(0, (landed ? 6 : 4.2) * k, this.dist).applyQuaternion(this.lag);
    this.pos.x = p.x + off.x; this.pos.y = p.y + off.y; this.pos.z = p.z + off.z;
    this.quat.copy(this.lag).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), landed ? -0.2 : -0.07));
    if (this.shakeK > 0.002) {
      const s = this.shakeK * this.shakeK, t = (this.shakeT += dt);
      this.shakeE.set(
        (Math.sin(t * 47) + Math.sin(t * 83 + 1.3) * 0.6) * 0.012 * s,
        (Math.sin(t * 53 + 2.1) + Math.sin(t * 91) * 0.5) * 0.012 * s,
        Math.sin(t * 37 + 0.7) * 0.016 * s,
      );
      this.quat.multiply(this.shakeQ.setFromEuler(this.shakeE));
      this.shakeK *= Math.exp(-dt * 6);
    }
  }

  /**
   * Third-person camera orbiting a point at the pilot's right shoulder. `dist` is the
   * wheel-set distance, `aim` (0..1) pulls it in over the shoulder, `pivotH` is the pivot's
   * height above `p` (lower while swimming), and `clear(x, y, z)` returns how far a world
   * point is above the ground so the camera slides in instead of sinking into a slope.
   */
  foot(dt: number, p: V3, up: V3, fwd: V3, pitch: number, dist: number, aim = 0, pivotH = 1.5, clear?: (x: number, y: number, z: number) => number) {
    const right = vnorm(v3(), vcross(v3(), fwd, up));
    const c = Math.cos(pitch), s = Math.sin(pitch);
    const dir = v3(fwd.x * c + up.x * s, fwd.y * c + up.y * s, fwd.z * c + up.z * s);
    // the camera swings less than the view: looking down does not hoist it high above the pilot
    const op = pitch * 0.7, oc = Math.cos(op), os = Math.sin(op);
    const orb = v3(fwd.x * oc + up.x * os, fwd.y * oc + up.y * os, fwd.z * oc + up.z * os);
    const side = 0.45 + 0.2 * aim;
    const px = p.x + up.x * pivotH + right.x * side, py = p.y + up.y * pivotH + right.y * side, pz = p.z + up.z * pivotH + right.z * side;
    const want = dist + (1.35 - dist) * aim;
    let d = want;
    if (clear) {
      for (let k = 1; k <= 5; k++) {
        const t = (want * k) / 5;
        if (clear(px - orb.x * t + up.x * 0.15, py - orb.y * t + up.y * 0.15, pz - orb.z * t + up.z * 0.15) < 0.3) { d = Math.max(1.1, t - want / 5); break; }
      }
    }
    // slide in at once when blocked, ease back out
    this.footD = !this.footReady || d < this.footD ? d : this.footD + (d - this.footD) * (1 - Math.exp(-dt * 3));
    this.footReady = true;
    this.pos.x = px - orb.x * this.footD + up.x * 0.15;
    this.pos.y = py - orb.y * this.footD + up.y * 0.15;
    this.pos.z = pz - orb.z * this.footD + up.z * 0.15;
    qlook(_q, dir, up);
    this.quat.set(_q.x, _q.y, _q.z, _q.w);
    this.lag.copy(this.quat);
  }

  private footD = 3.2;
  private footReady = false;

  orbit(dt: number, center: V3, radius: number) {
    this.orbitA += dt * 0.08;
    const off = v3(Math.cos(this.orbitA) * radius, radius * 0.35, Math.sin(this.orbitA) * radius);
    this.pos.x = center.x + off.x; this.pos.y = center.y + off.y; this.pos.z = center.z + off.z;
    qlook(_q, v3(-off.x, -off.y, -off.z), v3(0, 1, 0));
    this.quat.set(_q.x, _q.y, _q.z, _q.w);
    this.lag.copy(this.quat);
  }

  /** A fixed camera at `pos` looking at `target` with `up` as up. */
  look(pos: V3, target: V3, up: V3) {
    this.pos.x = pos.x; this.pos.y = pos.y; this.pos.z = pos.z;
    qlook(_q, v3(target.x - pos.x, target.y - pos.y, target.z - pos.z), up);
    this.quat.set(_q.x, _q.y, _q.z, _q.w);
    this.lag.copy(this.quat);
  }

  /** Keeps the camera's distance from `center` within [lo, hi]. */
  clampRadius(center: V3, lo: number, hi: number) {
    const dx = this.pos.x - center.x, dy = this.pos.y - center.y, dz = this.pos.z - center.z;
    const d = Math.hypot(dx, dy, dz);
    const k = d < lo ? lo / d : d > hi ? hi / d : 1;
    if (k === 1) return;
    this.pos.x = center.x + dx * k; this.pos.y = center.y + dy * k; this.pos.z = center.z + dz * k;
  }

  /** Keeps the camera above terrain: `ground` is the surface radius under the camera. */
  clampAbove(center: V3, ground: number, margin: number) {
    const dx = this.pos.x - center.x, dy = this.pos.y - center.y, dz = this.pos.z - center.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < ground + margin) {
      const k = (ground + margin) / d;
      this.pos.x = center.x + dx * k; this.pos.y = center.y + dy * k; this.pos.z = center.z + dz * k;
    }
  }
}
