import { IFLAG, MODE, quantizeInput, type InputMsg } from '../../shared/net/protocol.ts';
import { emptyCharInput } from '../../shared/sim/character.ts';
import { emptyInput } from '../../shared/sim/ship.ts';
import type { Input } from '../core/input.ts';

const DEAD = 0.06;
const shape = (v: number) => {
  const a = Math.abs(v);
  if (a < DEAD) return 0;
  return Math.sign(v) * Math.pow(Math.min(1, (a - DEAD) / (1 - DEAD)), 1.25);
};

/** Maps keyboard/mouse to simulation inputs (ship flight or on-foot). */
export class Controller {
  throttle = 0;
  cruiseOn = false;
  seq = 0;
  footPitch = -0.1;
  private yawAcc = 0;

  constructor(private input: Input) {}

  /** Per-rendered-frame handling of continuous analog controls. */
  frame(dt: number, mode: number) {
    const i = this.input;
    if (i.typing) return;
    if (mode === MODE.SHIP) {
      if (i.down('KeyW')) this.throttle = Math.min(1, this.throttle + 0.8 * dt);
      if (i.down('KeyS')) { this.throttle = Math.max(-0.3, this.throttle - 0.8 * dt); this.cruiseOn = false; }
      if (i.hit('KeyX')) { this.throttle = 0; this.cruiseOn = false; }
      if (i.wheel) this.throttle = Math.max(-0.3, Math.min(1, this.throttle - i.wheel * 0.1));
      if (i.hit('KeyJ')) this.cruiseOn = !this.cruiseOn;
      i.consumeMouse();
    } else if (mode === MODE.FOOT) {
      const m = i.consumeMouse();
      if (i.locked) {
        this.yawAcc += m.dx * 0.0026 * i.sensitivity;
        this.footPitch = Math.max(-1.2, Math.min(1.0, this.footPitch - m.dy * 0.0022 * i.sensitivity));
      } else {
        // Without pointer lock, steer with the cursor offset like a stick.
        this.yawAcc += shape(i.vx) * 2.2 * dt;
        this.footPitch = Math.max(-1.2, Math.min(1.0, this.footPitch - shape(i.vy) * 1.5 * dt));
      }
    } else {
      i.consumeMouse();
    }
  }

  /** Builds the quantised input for one fixed simulation tick; `t` = estimated server time. */
  build(mode: number, t: number): InputMsg {
    const i = this.input;
    const k = (c: string) => (!i.typing && i.down(c) ? 1 : 0);
    const ship = emptyInput();
    const char = emptyCharInput();
    let flags = 0;
    const m = mode === MODE.FOOT ? MODE.FOOT : MODE.SHIP;
    if (m === MODE.SHIP) {
      ship.yaw = shape(i.vx);
      ship.pitch = -shape(i.vy);
      ship.roll = k('KeyE') - k('KeyQ');
      ship.throttle = this.throttle;
      ship.strafeX = k('KeyD') - k('KeyA');
      ship.strafeY = k('Space') - Math.max(k('KeyC'), k('ControlLeft'));
      if (k('ShiftLeft') || k('ShiftRight')) flags |= IFLAG.BOOST;
      if (this.cruiseOn) flags |= IFLAG.CRUISE;
      if (i.mouse(0) && !i.typing) flags |= IFLAG.FIRE;
    } else {
      char.mx = k('KeyD') - k('KeyA');
      char.mz = k('KeyW') - k('KeyS');
      char.yawDelta = Math.max(-0.5, Math.min(0.5, this.yawAcc));
      this.yawAcc -= char.yawDelta;
      char.pitch = this.footPitch;
      if (k('Space')) flags |= IFLAG.JUMP;
      if (k('ShiftLeft') || k('ShiftRight')) flags |= IFLAG.SPRINT;
      if (i.mouse(0) && !i.typing && i.locked) flags |= IFLAG.FIRE;
      if (i.mouse(2) && !i.typing) flags |= IFLAG.AIM;
    }
    return quantizeInput({ seq: ++this.seq, mode: m, flags, t, ship, char });
  }
}
