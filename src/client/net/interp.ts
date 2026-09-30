import { INTERP_DELAY } from '../../shared/constants.ts';
import { qslerp, quat, v3, type Quat, type V3 } from '../../shared/math/vec.ts';
import type { EntityState } from '../../shared/net/protocol.ts';

interface Sample { t: number; p: V3; q: Quat; v: V3; e: EntityState }

/** Interpolated remote pose in the frame of the returned state (`e.frame`). */

/** Estimates server time and interpolates remote entities ~100 ms in the past. */
export class Timeline {
  private offset: number | null = null;

  onSnapshot(serverTime: number) {
    const local = performance.now() / 1000;
    const off = serverTime - local;
    if (this.offset === null || Math.abs(off - this.offset) > 0.5) this.offset = off;
    // Track the lowest-latency path quickly, drift slowly otherwise.
    else this.offset = off > this.offset ? this.offset + (off - this.offset) * 0.3 : this.offset + (off - this.offset) * 0.02;
  }

  get serverNow() {
    return performance.now() / 1000 + (this.offset ?? 0);
  }

  get renderTime() {
    return this.serverNow - INTERP_DELAY;
  }
}

export class InterpBuffer {
  private samples: Sample[] = [];
  lastSeen = 0;

  push(t: number, e: EntityState) {
    if (this.samples.length && t <= this.samples[this.samples.length - 1].t) return;
    this.samples.push({ t, p: v3(e.px, e.py, e.pz), q: quat(e.qx, e.qy, e.qz, e.qw), v: v3(e.vx, e.vy, e.vz), e });
    if (this.samples.length > 40) this.samples.shift();
    this.lastSeen = t;
  }

  get latest(): EntityState | null {
    return this.samples.length ? this.samples[this.samples.length - 1].e : null;
  }

  /** Writes interpolated pose at time t; returns the nearest raw state for flags. */
  sample(t: number, p: V3, q: Quat): EntityState | null {
    const s = this.samples;
    if (!s.length) return null;
    if (t <= s[0].t) {
      Object.assign(p, s[0].p);
      Object.assign(q, s[0].q);
      return s[0].e;
    }
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i].t <= t) {
        const a = s[i];
        const b: Sample | undefined = s[i + 1];
        // Never blend across a frame change: hold the nearer sample instead.
        if (b && b.e.frame !== a.e.frame) {
          const nb = (t - a.t) / (b.t - a.t) >= 0.5 ? b : a;
          Object.assign(p, nb.p);
          Object.assign(q, nb.q);
          return nb.e;
        }
        if (!b) {
          const dt = Math.min(0.25, t - a.t);
          p.x = a.p.x + a.v.x * dt; p.y = a.p.y + a.v.y * dt; p.z = a.p.z + a.v.z * dt;
          Object.assign(q, a.q);
          return a.e;
        }
        const k = (t - a.t) / (b.t - a.t);
        p.x = a.p.x + (b.p.x - a.p.x) * k; p.y = a.p.y + (b.p.y - a.p.y) * k; p.z = a.p.z + (b.p.z - a.p.z) * k;
        qslerp(q, a.q, b.q, k);
        return k < 0.5 ? a.e : b.e;
      }
    }
    return null;
  }
}
