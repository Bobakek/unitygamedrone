import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import roverUrl from '../assets/rover.glb?url';
import { ROVER } from '../../shared/sim/rover.ts';

/**
 * The planetary rover, modelled in Blender (tools/blender/build_rover.py → assets/rover.glb).
 * Moving parts are separate nodes: per corner the wishbones swing about their hinges, the
 * coil-over is re-aimed and compressed, the knuckle rides up and down, the front wheels steer
 * and every wheel spins with the ground speed. The dish turns, the beacon blinks while driven,
 * and the seated pilot shows only when someone is at the wheel.
 */
const CORNERS = ['FL', 'FR', 'RL', 'RR'] as const;
/** Wishbone length: inner hinge to ball joint (see build_rover.py). */
const ARM = 0.41;

let template: Promise<THREE.Object3D> | null = null;
function loadRover(): Promise<THREE.Object3D> {
  template ??= new GLTFLoader().loadAsync(roverUrl).then((g) => {
    g.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) { o.castShadow = true; o.receiveShadow = true; }
    });
    return g.scene;
  });
  return template;
}

interface Corner {
  side: number;
  upper: THREE.Object3D;
  lower: THREE.Object3D;
  shock: THREE.Object3D;
  knuckle: THREE.Object3D;
  steer: THREE.Object3D;
  wheel: THREE.Object3D;
  knuckleRest: THREE.Vector3;
  shockTop: THREE.Vector3;
  /** Rest position of the shock's bottom eye, in corner space. */
  shockBottom: THREE.Vector3;
  shockLen: number;
}

export interface RoverAnim {
  /** Suspension lengths FL, FR, RL, RR (m). */
  susp: readonly number[];
  /** Front wheel angle (rad, + = left). */
  steer: number;
  /** Speed along the rover's nose (m/s). */
  fwd: number;
  driven: boolean;
  /** Headlights and lamp glow. */
  lights: boolean;
}

const DOWN = new THREE.Vector3(0, -1, 0), Z = new THREE.Vector3(0, 0, 1);
const tv = new THREE.Vector3(), tq = new THREE.Quaternion();

export class RoverView {
  readonly group = new THREE.Group();
  private corners: Corner[] = [];
  private spin = [0, 0, 0, 0];
  private dish: THREE.Object3D | null = null;
  private driver: THREE.Object3D | null = null;
  private beacon: THREE.MeshStandardMaterial | null = null;
  private lamp: THREE.MeshStandardMaterial | null = null;
  private tail: THREE.MeshStandardMaterial | null = null;
  private spots: THREE.SpotLight[] = [];
  private t = Math.random() * 10;
  private disposed = false;
  ready = false;

  /** `headlights`: real spot lights (only the local player's rover, they are costly). */
  constructor(private headlights = false) {
    loadRover().then((t) => { if (!this.disposed) this.attach(t.clone(true)); }).catch((e) => console.warn('rover model', e));
  }

  private attach(root: THREE.Object3D) {
    this.group.add(root);
    const find = (n: string) => root.getObjectByName(n);
    for (const tag of CORNERS) {
      const shock = find(`Shock_${tag}`)!, lower = find(`ArmLower_${tag}`)!;
      const len = Number(shock.userData.rest_length) || 0.6;
      const bottom = new THREE.Vector3(0, -len, 0).applyQuaternion(shock.quaternion).add(shock.position);
      const knuckle = find(`Knuckle_${tag}`)!;
      this.corners.push({
        side: tag.endsWith('R') ? 1 : -1, upper: find(`ArmUpper_${tag}`)!, lower, shock, knuckle,
        steer: find(`Steer_${tag}`)!, wheel: find(`Wheel_${tag}`)!, knuckleRest: knuckle.position.clone(),
        shockTop: shock.position.clone(), shockBottom: bottom, shockLen: len,
      });
    }
    this.dish = find('Dish') ?? null;
    this.driver = find('Driver') ?? null;
    // per-rover copies of the glowing materials so each can switch its own lamps
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const own = mats.map((m) => {
        if (!(m instanceof THREE.MeshStandardMaterial) || !['Beacon', 'Headlamp', 'Taillight'].includes(m.name)) return m;
        const c = m.clone();
        if (m.name === 'Beacon') this.beacon = c; else if (m.name === 'Headlamp') this.lamp = c; else this.tail = c;
        return c;
      });
      o.material = Array.isArray(o.material) ? own : own[0];
    });
    if (this.headlights) {
      for (const x of [-0.55, 0.55]) {
        const s = new THREE.SpotLight('#fff1d6', 0, 70, 0.55, 0.45, 1.4);
        s.position.set(x, -0.04, -2.1);
        s.target.position.set(x * 2, -1.6, -24);
        this.group.add(s, s.target);
        this.spots.push(s);
      }
    }
    this.ready = true;
  }

  update(dt: number, a: RoverAnim) {
    this.t += dt;
    if (!this.ready) return;
    for (let i = 0; i < 4; i++) {
      const c = this.corners[i];
      // the wheel centre rides up (+) or drops (−) from where it was modelled
      const dy = Math.max(-0.3, Math.min(0.3, ROVER.modelLen - (a.susp[i] ?? ROVER.modelLen)));
      const ang = Math.asin(Math.max(-0.95, Math.min(0.95, dy / ARM)));
      c.upper.rotation.z = c.side * ang;
      c.lower.rotation.z = c.side * ang;
      // both ball joints swing on arcs: the knuckle pulls in a little at full travel
      c.knuckle.position.set(c.knuckleRest.x - c.side * ARM * (1 - Math.cos(ang)), c.knuckleRest.y + dy, c.knuckleRest.z);
      // coil-over: from its top mount to the eye on the lower arm, compressed or stretched
      tq.setFromAxisAngle(Z, c.side * ang);
      tv.copy(c.shockBottom).sub(c.lower.position).applyQuaternion(tq).add(c.lower.position).sub(c.shockTop);
      const l = tv.length();
      c.shock.quaternion.setFromUnitVectors(DOWN, tv.divideScalar(l));
      c.shock.scale.set(1, l / c.shockLen, 1);
      if (i < 2) c.steer.rotation.y = a.steer;
      // rolling forward turns the wheel top towards the nose: negative about +x
      this.spin[i] = (this.spin[i] - (a.fwd * dt) / ROVER.wheelR) % (Math.PI * 2);
      c.wheel.rotation.x = this.spin[i];
    }
    if (this.dish) this.dish.rotation.y += dt * 0.5;
    if (this.driver) this.driver.visible = a.driven;
    if (this.beacon) this.beacon.emissiveIntensity = a.driven ? (Math.sin(this.t * 6) > 0.2 ? 4 : 0.3) : 0.2;
    if (this.lamp) this.lamp.emissiveIntensity = a.lights ? 6 : 0.4;
    if (this.tail) this.tail.emissiveIntensity = a.driven ? (a.fwd < -0.3 ? 6 : 3) : 0.3;
    for (const s of this.spots) s.intensity = a.lights ? 60 : 0;
  }

  /** Scene-space (origin-relative) positions of the contact patches, for dust. */
  wheelBottoms(out: THREE.Vector3[]): THREE.Vector3[] {
    if (!this.ready) return out;
    this.group.updateWorldMatrix(true, true);
    for (let i = 0; i < 4; i++) {
      out[i] ??= new THREE.Vector3();
      this.corners[i].wheel.getWorldPosition(out[i]);
    }
    return out;
  }

  dispose() {
    this.disposed = true;
    this.group.removeFromParent();
    for (const m of [this.beacon, this.lamp, this.tail]) m?.dispose();
  }
}
