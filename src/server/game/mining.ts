import { CARGO_NAMES, cargoCount, combatStats } from '../../shared/economy.ts';
import type { V3 } from '../../shared/math/vec.ts';
import { segmentSphere } from '../../shared/sim/weapons.ts';
import { MINE_WORK, ROCK_REGEN, rockGood, rockUnits } from '../../shared/ships/hulls.ts';
import type { Session } from './session.ts';
import type { SystemInstance } from './system.ts';

/** A laser segment hitting an asteroid: field and rock index, hit parameter along the segment. */
export interface RockHit { field: number; rock: number; t: number }

/**
 * Asteroid mining. Lasers of a mining ship are stopped by the rocks of the asteroid fields;
 * every MINE_WORK points of drilling (laser damage times the ship's mining power) cut one unit
 * of ore, or of crystal from the crystal-bearing rocks, straight into the hold. A rock holds a
 * few units (big ones more) and grows back one unit every ROCK_REGEN seconds, so miners move
 * from rock to rock. Everything is worked out lazily: an untouched field costs nothing.
 */
export class AsteroidMining {
  /** `${field}:${rock}` → units taken and the time the regrowth was last counted. */
  private taken = new Map<string, { n: number; at: number }>();
  /** Drilling progress per pilot (towards the next unit) and the rock it belongs to. */
  private work = new Map<Session, { key: string; w: number }>();
  /** Last time a pilot was told the hold is full or the rock is spent. */
  private told = new Map<Session, number>();

  constructor(private sys: SystemInstance) {}

  /** Nearest rock a segment p0→p1 hits (null when it misses every field). */
  hitTest(p0: V3, p1: V3): RockHit | null {
    let best: RockHit | null = null;
    const len = Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
    for (const f of this.sys.def.fields) {
      const dx = p0.x - f.center.x, dy = p0.y - f.center.y, dz = p0.z - f.center.z;
      if (dx * dx + dy * dy + dz * dz > (f.radius + 300 + len) ** 2) continue;
      for (let i = 0; i < f.rocks.length; i++) {
        const r = f.rocks[i];
        const t = segmentSphere(p0, p1, r, r.r);
        if (t >= 0 && (!best || t < best.t)) best = { field: f.index, rock: i, t };
      }
    }
    return best;
  }

  /** Units a rock still holds. */
  left(field: number, rock: number): number {
    const r = this.sys.def.fields[field].rocks[rock];
    const key = `${field}:${rock}`;
    const e = this.taken.get(key);
    if (!e) return rockUnits(r.r);
    const k = Math.floor((this.sys.time - e.at) / ROCK_REGEN);
    if (k > 0) {
      e.n = Math.max(0, e.n - k);
      e.at += k * ROCK_REGEN;
      if (!e.n) { this.taken.delete(key); return rockUnits(r.r); }
    }
    return rockUnits(r.r) - e.n;
  }

  /** A mining laser of pilot `s` drilled `work` points into a rock at `pos`. */
  drill(s: Session, hit: RockHit, work: number, pos: V3) {
    const rock = this.sys.def.fields[hit.field].rocks[hit.rock];
    const key = `${hit.field}:${hit.rock}`;
    const good = rockGood(rock.seed);
    const ev = { t: 'mine' as const, pos: [pos.x, pos.y, pos.z] as [number, number, number], by: s.ship.id, good: undefined as typeof good | undefined };
    this.sys.events.push(ev);
    const p = s.pilot;
    if (cargoCount(p.cargo) >= combatStats(p.upgrades, p.ship).cargoCap) return this.tell(s, 'Трюм полон — пора на станцию');
    if (this.left(hit.field, hit.rock) <= 0) return this.tell(s, 'Астероид выработан, ищите другой');
    let w = this.work.get(s);
    if (!w || w.key !== key) { w = { key, w: 0 }; this.work.set(s, w); }
    w.w += work;
    if (w.w < MINE_WORK) return;
    w.w -= MINE_WORK;
    const e = this.taken.get(key);
    if (e) e.n++;
    else this.taken.set(key, { n: 1, at: this.sys.time });
    p.cargo[good]++;
    ev.good = good;
    s.sendPilot();
    if (this.left(hit.field, hit.rock) <= 0) this.tell(s, `${CARGO_NAMES[good]}: астероид выработан`);
  }

  forget(s: Session) {
    this.work.delete(s);
    this.told.delete(s);
  }

  private tell(s: Session, text: string) {
    if ((this.told.get(s) ?? -99) > this.sys.time - 4) return;
    this.told.set(s, this.sys.time);
    s.msg(text, 'warn');
  }
}
