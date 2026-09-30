import { emptyInput, type ShipInput } from '../../shared/sim/ship.ts';
import { LASER, leadPoint } from '../../shared/sim/weapons.ts';
import { FWD, qrot, v3, vdist, vnorm, vsub, type V3 } from '../../shared/math/vec.ts';
import { SAFE_ZONE_RADIUS } from '../../shared/constants.ts';
import type { Rng } from '../../shared/math/rng.ts';
import type { ShipEntity } from './entities.ts';

type NpcState = 'patrol' | 'attack' | 'flee';

export class NpcBrain {
  state: NpcState = 'patrol';
  target = 0;
  waypoint: V3;
  rethink = 0;
  fleeUntil = 0;
  jink = 0;
  constructor(public home: V3, public homeRadius: number, private rng: Rng) {
    this.waypoint = this.pickWaypoint();
  }

  pickWaypoint(): V3 {
    const r = this.rng, rad = this.homeRadius * 0.8;
    return v3(this.home.x + r.range(-rad, rad), this.home.y + r.range(-rad, rad) * 0.4, this.home.z + r.range(-rad, rad));
  }

  random(): number {
    return this.rng.float();
  }
}

const tmp = v3(), aim = v3(), fwd = v3(), local = v3();

/** Converts a world-space aim point into yaw/pitch stick input for `ship`. */
function steer(ship: ShipEntity, point: V3, inp: ShipInput) {
  vsub(tmp, point, ship.world.p);
  // world → local: rotate by inverse quaternion
  const q = ship.world.q;
  const inv = { x: -q.x, y: -q.y, z: -q.z, w: q.w };
  qrot(local, inv, tmp);
  const fz = -local.z;
  const yawA = Math.atan2(local.x, fz), pitchA = Math.atan2(local.y, Math.hypot(fz, local.x));
  inp.yaw = Math.max(-1, Math.min(1, yawA * 2.2));
  inp.pitch = Math.max(-1, Math.min(1, pitchA * 2.2));
  if (fz < 0 && Math.abs(local.x) < 1) inp.yaw = 1;
}

export interface NpcWorld {
  time: number;
  stationPos: V3;
  findPrey(from: V3, range: number): ShipEntity | null;
  ship(id: number): ShipEntity | undefined;
}

/** Simple pirate AI: patrol a field, attack nearby players with lead aiming, flee when hurt. Works on world poses. */
export function npcThink(ship: ShipEntity, b: NpcBrain, w: NpcWorld, dt: number): { input: ShipInput; fire: boolean } {
  const inp = emptyInput();
  let fire = false;
  b.rethink -= dt;
  const p = ship.world.p;
  const tgt = b.target ? w.ship(b.target) : undefined;
  const tgtValid = !!tgt && !tgt.dead && !tgt.docked && vdist(tgt.world.p, w.stationPos) > SAFE_ZONE_RADIUS && vdist(tgt.world.p, p) < 4500;

  if (b.rethink <= 0) {
    b.rethink = 0.5;
    if (ship.hull < ship.combat.maxHull * 0.3 && b.state === 'attack') {
      b.state = 'flee';
      b.fleeUntil = w.time + 7;
    }
    if (b.state === 'flee' && w.time > b.fleeUntil) b.state = 'patrol';
    if (b.state !== 'flee') {
      if (!tgtValid) {
        const prey = vdist(p, b.home) < b.homeRadius * 3 ? w.findPrey(p, 2600) : null;
        b.target = prey ? prey.id : 0;
        b.state = prey ? 'attack' : 'patrol';
      }
    }
    if (vdist(p, b.home) > b.homeRadius * 4) { b.state = 'patrol'; b.target = 0; }
  }

  const target = b.target ? w.ship(b.target) : undefined;
  if (b.state === 'attack' && target && !target.dead) {
    leadPoint(p, ship.world.v, target.world.p, target.world.v, LASER.speed, aim);
    const dist = vdist(target.world.p, p);
    if (dist < 220) b.jink = 1.6;
    if (b.jink > 0) {
      b.jink -= dt;
      vsub(tmp, p, target.world.p);
      aim.x = p.x + tmp.x + 400; aim.y = p.y + tmp.y + 250; aim.z = p.z + tmp.z;
      inp.throttle = 1;
      inp.boost = true;
    } else {
      inp.throttle = dist > 900 ? 1 : 0.55;
      inp.boost = dist > 1800 && ship.state.boost > 0.5;
    }
    steer(ship, aim, inp);
    qrot(fwd, ship.world.q, FWD);
    vnorm(tmp, vsub(tmp, aim, p));
    const cos = fwd.x * tmp.x + fwd.y * tmp.y + fwd.z * tmp.z;
    fire = b.jink <= 0 && dist < 1400 && cos > 0.992;
    inp.strafeX = Math.sin(w.time * 1.3 + ship.id) * 0.6;
  } else if (b.state === 'flee' && target) {
    vsub(tmp, p, target.world.p);
    aim.x = p.x + tmp.x; aim.y = p.y + tmp.y; aim.z = p.z + tmp.z;
    steer(ship, aim, inp);
    inp.throttle = 1;
    inp.boost = true;
  } else {
    if (vdist(p, b.waypoint) < 300) b.waypoint = b.pickWaypoint();
    steer(ship, b.waypoint, inp);
    inp.throttle = 0.45;
  }
  return { input: inp, fire };
}
