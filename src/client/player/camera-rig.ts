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

  ship(dt: number, p: V3, q: Quat, speed: number, cruising: boolean, landed: boolean) {
    const target = new THREE.Quaternion(q.x, q.y, q.z, q.w);
    if (!this.ready) { this.lag.copy(target); this.ready = true; }
    this.lag.slerp(target, 1 - Math.exp(-dt * 7));
    const want = landed ? 20 : 15 + Math.min(speed / 60, 8) + (cruising ? 10 : 0);
    this.dist += (want - this.dist) * (1 - Math.exp(-dt * 3));
    const off = new THREE.Vector3(0, landed ? 6 : 4.2, this.dist).applyQuaternion(this.lag);
    this.pos.x = p.x + off.x; this.pos.y = p.y + off.y; this.pos.z = p.z + off.z;
    this.quat.copy(this.lag).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), landed ? -0.2 : -0.07));
  }

  foot(p: V3, up: V3, fwd: V3, pitch: number) {
    const right = vnorm(v3(), vcross(v3(), fwd, up));
    const c = Math.cos(pitch), s = Math.sin(pitch);
    const dir = v3(fwd.x * c + up.x * s, fwd.y * c + up.y * s, fwd.z * c + up.z * s);
    const back = 4.6;
    this.pos.x = p.x + up.x * 1.8 - dir.x * back + right.x * 0.6;
    this.pos.y = p.y + up.y * 1.8 - dir.y * back + right.y * 0.6;
    this.pos.z = p.z + up.z * 1.8 - dir.z * back + right.z * 0.6;
    qlook(_q, dir, up);
    this.quat.set(_q.x, _q.y, _q.z, _q.w);
    this.lag.copy(this.quat);
  }

  orbit(dt: number, center: V3, radius: number) {
    this.orbitA += dt * 0.08;
    const off = v3(Math.cos(this.orbitA) * radius, radius * 0.35, Math.sin(this.orbitA) * radius);
    this.pos.x = center.x + off.x; this.pos.y = center.y + off.y; this.pos.z = center.z + off.z;
    qlook(_q, v3(-off.x, -off.y, -off.z), v3(0, 1, 0));
    this.quat.set(_q.x, _q.y, _q.z, _q.w);
    this.lag.copy(this.quat);
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
