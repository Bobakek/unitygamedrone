import { DT } from '../../shared/constants.ts';
import type { PlanetDef } from '../../shared/galaxy/system-gen.ts';
import { qslerp, v3, vcopy, vlerp, type Quat, type V3 } from '../../shared/math/vec.ts';
import { MODE, type InputMsg, type Snapshot } from '../../shared/net/protocol.ts';
import { copyChar, newChar, stepChar, type CharState } from '../../shared/sim/character.ts';
import type { SimEnv } from '../../shared/sim/env.ts';
import { cloneShip, copyShip, newShip, stepShip, type ShipState, type ShipStats } from '../../shared/sim/ship.ts';

/**
 * Client-side prediction for the local ship/character. Inputs are applied
 * immediately with the shared deterministic sim, and replayed on top of each
 * authoritative snapshot (server reconciliation). Position corrections are
 * smoothed out visually.
 */
export class Predictor {
  mode: number = MODE.SHIP;
  ship: ShipState = newShip(v3());
  prevShip: ShipState = newShip(v3());
  char: CharState | null = null;
  prevChar: CharState | null = null;
  charPlanet = -1;
  private pending: InputMsg[] = [];
  private teleport = -1;
  private smooth = v3();
  ready = false;

  constructor(private env: () => SimEnv, private stats: () => ShipStats) {}

  get planets(): PlanetDef[] {
    return this.env().planets;
  }

  onSnapshot(s: Snapshot) {
    const me = s.self;
    const hard = !this.ready || me.teleport !== this.teleport || me.mode !== this.mode || (me.char === null) !== (this.char === null);
    this.teleport = me.teleport;
    this.mode = me.mode;
    this.charPlanet = me.charPlanet;
    this.pending = this.pending.filter((p) => p.seq > s.ack);
    if (hard) {
      this.pending.length = 0;
      this.ship = cloneShip(me.ship);
      copyShip(this.prevShip, this.ship);
      this.char = me.char ? copyChar(newChar(v3(), v3()), me.char) : null;
      this.prevChar = me.char ? copyChar(newChar(v3(), v3()), me.char) : null;
      this.smooth = v3();
      this.ready = true;
      return;
    }
    const before = this.mode === MODE.FOOT && this.char ? { ...this.char.p } : { ...this.ship.p };
    const frameBefore = this.ship.frame;
    copyShip(this.ship, me.ship);
    if (me.char && this.char) copyChar(this.char, me.char);
    for (const m of this.pending) this.apply(m);
    const after = this.mode === MODE.FOOT && this.char ? this.char.p : this.ship.p;
    const ex = before.x - after.x, ey = before.y - after.y, ez = before.z - after.z;
    // The correction offset lives in the ship's frame; drop it if the frame changed.
    if (ex * ex + ey * ey + ez * ez > 60 * 60 || frameBefore !== this.ship.frame) this.smooth = v3();
    else { this.smooth.x += ex; this.smooth.y += ey; this.smooth.z += ez; }
  }

  private apply(m: InputMsg) {
    if (this.mode === MODE.SHIP && m.mode === MODE.SHIP) {
      const env = this.env();
      env.time = m.t;
      stepShip(this.ship, m.ship, this.stats(), env, DT);
    }
    else if (this.mode === MODE.FOOT && m.mode === MODE.FOOT && this.char && this.charPlanet >= 0) stepChar(this.char, m.char, this.planets[this.charPlanet], DT);
  }

  /** Called once per fixed tick with the (already quantised) input that was sent. */
  step(m: InputMsg) {
    if (!this.ready) return;
    copyShip(this.prevShip, this.ship);
    if (this.char && this.prevChar) copyChar(this.prevChar, this.char);
    if (this.mode !== MODE.SHIP && this.mode !== MODE.FOOT) return;
    this.pending.push(m);
    if (this.pending.length > 120) this.pending.shift();
    this.apply(m);
  }

  decay(dt: number) {
    const k = Math.exp(-dt * 10);
    this.smooth.x *= k; this.smooth.y *= k; this.smooth.z *= k;
  }

  /** Interpolated render pose of the ship between the last two fixed ticks (in `ship.frame`). */
  shipPose(alpha: number, p: V3, q: Quat) {
    if (this.prevShip.frame !== this.ship.frame) copyShip(this.prevShip, this.ship);
    vlerp(p, this.prevShip.p, this.ship.p, alpha);
    if (this.mode === MODE.SHIP) { p.x += this.smooth.x; p.y += this.smooth.y; p.z += this.smooth.z; }
    qslerp(q, this.prevShip.q, this.ship.q, alpha);
  }

  /** Interpolated pilot pose in its planet's body frame. */
  charPose(alpha: number, p: V3, f: V3) {
    if (!this.char || !this.prevChar) return false;
    vlerp(p, this.prevChar.p, this.char.p, alpha);
    p.x += this.smooth.x; p.y += this.smooth.y; p.z += this.smooth.z;
    vcopy(f, this.char.f);
    return true;
  }
}

