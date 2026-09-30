import * as THREE from 'three';
import { glowTexture } from '../world/textures.ts';

/**
 * Low-poly astronaut with a full procedural rig: hips → spine → head, arms
 * (shoulder/elbow/hand) and legs (hip/knee/ankle). Poses are blended from
 * idle, walk, run, jump, fall, jetpack, landing and harvesting layers.
 * Local frame: forward = -Z, up = +Y, origin at the soles.
 */

const MAT = {
  suit: new THREE.MeshStandardMaterial({ color: '#f1eee6', flatShading: true, roughness: 0.72 }),
  accent: new THREE.MeshStandardMaterial({ color: '#f39a4a', flatShading: true, roughness: 0.6 }),
  joint: new THREE.MeshStandardMaterial({ color: '#59606c', flatShading: true, roughness: 0.55, metalness: 0.35 }),
  visor: new THREE.MeshStandardMaterial({ color: '#ffc24a', flatShading: true, roughness: 0.12, metalness: 0.9, emissive: '#2a1a00' }),
  tool: new THREE.MeshStandardMaterial({ color: '#343944', flatShading: true, roughness: 0.4, metalness: 0.6 }),
  glow: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 2.2, 2.6), toneMapped: false }),
};

function part(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, p: number[] = [0, 0, 0], r: number[] = [0, 0, 0], s: number[] = [1, 1, 1]) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(p[0], p[1], p[2]);
  m.rotation.set(r[0], r[1], r[2]);
  m.scale.set(s[0], s[1], s[2]);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

function joint(parent: THREE.Object3D, x: number, y: number, z: number) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

const G = {
  pelvis: new THREE.BoxGeometry(0.36, 0.2, 0.24),
  torso: new THREE.CapsuleGeometry(0.25, 0.3, 3, 7),
  chest: new THREE.BoxGeometry(0.34, 0.26, 0.08),
  pack: new THREE.BoxGeometry(0.4, 0.5, 0.2),
  nozzle: new THREE.CylinderGeometry(0.05, 0.07, 0.1, 6),
  helmet: new THREE.SphereGeometry(0.235, 8, 6),
  visor: new THREE.SphereGeometry(0.2, 8, 5),
  lamp: new THREE.SphereGeometry(0.035, 5, 3),
  upperArm: new THREE.CapsuleGeometry(0.085, 0.2, 2, 6),
  foreArm: new THREE.CapsuleGeometry(0.075, 0.18, 2, 6),
  hand: new THREE.SphereGeometry(0.075, 6, 4),
  thigh: new THREE.CapsuleGeometry(0.11, 0.24, 2, 6),
  shin: new THREE.CapsuleGeometry(0.095, 0.24, 2, 6),
  knee: new THREE.SphereGeometry(0.1, 6, 4),
  boot: new THREE.BoxGeometry(0.15, 0.11, 0.27),
  toolBody: new THREE.BoxGeometry(0.08, 0.1, 0.26),
  toolBarrel: new THREE.CylinderGeometry(0.025, 0.035, 0.16, 6).rotateX(Math.PI / 2),
  flame: new THREE.ConeGeometry(0.06, 0.5, 6, 1, true).translate(0, -0.25, 0),
  beam: new THREE.CylinderGeometry(0.02, 0.02, 1, 5, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2),
};

export interface AnimInput {
  /** Horizontal speed, m/s. */
  speed: number;
  /** Vertical (radial) velocity, m/s. */
  vUp: number;
  ground: boolean;
  jet: boolean;
  /** Look pitch (radians, + = up) for the head. */
  look: number;
  /** Heading change rate, rad/s. */
  turn: number;
}

const sstep = (x: number, a: number, b: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class AstronautView {
  readonly group = new THREE.Group();
  private hips: THREE.Group;
  private spine: THREE.Group;
  private head: THREE.Group;
  private sh: THREE.Group[] = [];
  private el: THREE.Group[] = [];
  private hip: THREE.Group[] = [];
  private kn: THREE.Group[] = [];
  private an: THREE.Group[] = [];
  private tool = new THREE.Group();
  private toolTip = new THREE.Object3D();
  private beam: THREE.Mesh;
  private beamGlow: THREE.Sprite;
  private flames: THREE.Mesh[] = [];
  private flameGlow: THREE.Sprite;

  private t = Math.random() * 10;
  private phase = 0;
  private w = { walk: 0, run: 0, air: 0, jet: 0, rise: 0, land: 0, harvest: 0 };
  private airTime = 0;
  private landing = 0;
  private harvestT = 0;
  private harvestTarget: THREE.Vector3 | null = null;
  private lastSin = [0, 0];
  /** Called on each footfall (0 = left, 1 = right). */
  onStep: ((side: number) => void) | null = null;
  /** Called when landing after a fall/jump with the impact strength 0..1. */
  onLand: ((k: number) => void) | null = null;

  constructor() {
    const root = this.group;
    this.hips = joint(root, 0, 0.97, 0);
    part(this.hips, G.pelvis, MAT.joint);
    this.spine = joint(this.hips, 0, 0.08, 0);
    part(this.spine, G.torso, MAT.suit, [0, 0.24, 0]);
    part(this.spine, G.chest, MAT.accent, [0, 0.3, -0.24]);
    part(this.spine, G.pack, MAT.accent, [0, 0.3, 0.26]);
    for (const s of [-1, 1]) {
      part(this.spine, G.nozzle, MAT.joint, [s * 0.11, 0.02, 0.3]);
      const f = part(this.spine, G.flame, new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 1.8, 2.4), transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), [s * 0.11, -0.03, 0.3]);
      f.castShadow = false;
      this.flames.push(f);
    }
    this.flameGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color(0.8, 1.8, 2.4), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
    this.flameGlow.position.set(0, -0.15, 0.3);
    this.flameGlow.scale.setScalar(0.9);
    this.spine.add(this.flameGlow);

    this.head = joint(this.spine, 0, 0.58, 0);
    part(this.head, G.helmet, MAT.suit, [0, 0.12, 0]);
    part(this.head, G.visor, MAT.visor, [0, 0.13, -0.08], [0, 0, 0], [0.95, 0.78, 0.8]);
    part(this.head, G.lamp, MAT.glow, [0.2, 0.2, -0.06]);

    for (const s of [-1, 1]) {
      const sh = joint(this.spine, s * 0.33, 0.44, 0);
      part(sh, G.knee, MAT.joint, [0, 0, 0], [0, 0, 0], [0.9, 0.9, 0.9]);
      part(sh, G.upperArm, MAT.suit, [0, -0.16, 0]);
      const el = joint(sh, 0, -0.33, 0);
      part(el, G.foreArm, MAT.suit, [0, -0.14, 0]);
      const hand = joint(el, 0, -0.29, 0);
      part(hand, G.hand, MAT.accent);
      if (s > 0) {
        this.tool.position.set(0, -0.04, -0.06);
        hand.add(this.tool);
        part(this.tool, G.toolBody, MAT.tool, [0, 0, -0.06]);
        part(this.tool, G.toolBarrel, MAT.joint, [0, 0.02, -0.26]);
        part(this.tool, G.lamp, MAT.glow, [0, 0.02, -0.34]);
        this.toolTip.position.set(0, 0.02, -0.35);
        this.tool.add(this.toolTip);
        this.tool.rotation.x = -Math.PI / 2;
      }
      this.sh.push(sh);
      this.el.push(el);
      const hip = joint(this.hips, s * 0.12, -0.06, 0);
      part(hip, G.thigh, MAT.suit, [0, -0.2, 0]);
      const kn = joint(hip, 0, -0.42, 0);
      part(kn, G.knee, MAT.joint);
      part(kn, G.shin, MAT.suit, [0, -0.2, 0]);
      const an = joint(kn, 0, -0.41, 0);
      part(an, G.boot, MAT.joint, [0, -0.04, -0.04]);
      this.hip.push(hip);
      this.kn.push(kn);
      this.an.push(an);
    }
    this.tool.visible = false;

    this.beam = new THREE.Mesh(G.beam, new THREE.MeshBasicMaterial({ color: new THREE.Color(0.8, 2.4, 2.8), transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.beam.visible = false;
    this.beamGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color(1, 2.2, 2.6), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
    this.beamGlow.visible = false;
    root.add(this.beam, this.beamGlow);
  }

  /** Plays the harvesting animation; `target` is the node position in scene (origin-relative) space. */
  harvest(target: THREE.Vector3 | null) {
    this.harvestT = 1.1;
    this.harvestTarget = target ? target.clone() : null;
  }

  /** Scene-space target updates as the floating origin moves. */
  setHarvestTarget(target: THREE.Vector3 | null) {
    if (this.harvestT > 0) this.harvestTarget = target;
  }

  update(dt: number, a: AnimInput) {
    this.t += dt;
    const w = this.w;
    const k = (rate: number) => 1 - Math.exp(-dt * rate);
    const ground = a.ground;

    // --- state weights (smoothed)
    if (!ground) this.airTime += dt;
    else {
      if (this.airTime > 0.3) {
        this.landing = Math.min(1, 0.4 + this.airTime * 0.5);
        this.onLand?.(this.landing);
      }
      this.airTime = 0;
    }
    this.landing = Math.max(0, this.landing - dt * 3.5);
    this.harvestT = Math.max(0, this.harvestT - dt);
    const tw = {
      walk: ground ? sstep(a.speed, 0.15, 1.4) : 0,
      run: ground ? sstep(a.speed, 5.2, 8.5) : 0,
      air: ground || this.airTime < 0.08 ? 0 : 1,
      jet: !ground && a.jet ? 1 : 0,
      rise: a.vUp > 0.5 ? 1 : 0,
      land: this.landing,
      harvest: this.harvestT > 0 ? sstep(this.harvestT, 0, 0.25) * sstep(1.1 - this.harvestT, 0, 0.2) : 0,
    };
    w.walk += (tw.walk - w.walk) * k(10);
    w.run += (tw.run - w.run) * k(6);
    w.air += (tw.air - w.air) * k(10);
    w.jet += (tw.jet - w.jet) * k(8);
    w.rise += (tw.rise - w.rise) * k(6);
    w.land = tw.land;
    w.harvest += (tw.harvest - w.harvest) * k(14);

    // --- gait phase
    const stride = 1.35 + w.run * 1.0;
    if (ground) this.phase += (dt * a.speed * Math.PI * 2) / stride;
    if (ground && a.speed < 0.6 && Math.abs(a.turn) > 0.4) this.phase += dt * Math.min(6, Math.abs(a.turn) * 3);
    const ph = this.phase;
    const sL = Math.sin(ph), sR = Math.sin(ph + Math.PI), cL = Math.cos(ph), cR = Math.cos(ph + Math.PI);
    const gw = Math.max(w.walk, ground && Math.abs(a.turn) > 0.4 ? 0.35 : 0) * (1 - w.air);

    // footfalls
    if (gw > 0.4) {
      const now = [sL, sR];
      for (let i = 0; i < 2; i++) {
        if (this.lastSin[i] > 0 && now[i] <= 0) this.onStep?.(i);
        this.lastSin[i] = now[i];
      }
    }

    const breath = Math.sin(this.t * 1.7);
    const idle = 1 - gw;
    const legAmp = (0.42 + 0.4 * w.run) * gw;
    const kneeAmp = (0.55 + 0.85 * w.run) * gw;
    const armAmp = (0.32 + 0.6 * w.run) * gw;

    // --- base locomotion pose
    let hipsY = 0.97 - 0.004 * breath * idle - (0.035 + 0.05 * w.run) * gw * (sL * sL);
    let hipsYaw = 0.1 * sL * gw;
    let hipsRoll = Math.sin(this.t * 0.55) * 0.025 * idle;
    let spineX = -0.03 + 0.012 * breath * idle - (0.05 * w.walk + 0.2 * w.run);
    let spineYaw = -0.16 * sL * gw;
    const thigh = [legAmp * sL, legAmp * sR];
    const knee = [-(kneeAmp * Math.max(0, cL) + 0.1 * gw + 0.04), -(kneeAmp * Math.max(0, cR) + 0.1 * gw + 0.04)];
    const shoulder = [-armAmp * sL + 0.05 * idle, -armAmp * sR + 0.05 * idle];
    const roll = [0.14 + 0.02 * breath * idle, 0.14 + 0.02 * breath * idle];
    const elbow = [0.2 + w.run * 1.1 + 0.25 * gw * Math.max(0, -sL), 0.2 + w.run * 1.1 + 0.25 * gw * Math.max(0, -sR)];
    let headX = Math.max(-0.5, Math.min(0.6, a.look * 0.55));
    let headYaw = Math.sin(this.t * 0.31) * 0.28 * idle * (1 - w.harvest) - a.turn * 0.08;

    // --- airborne layers: jump / fall / jetpack
    const air = w.air;
    if (air > 0.001) {
      const jet = w.jet, rise = w.rise * (1 - jet), fall = (1 - w.rise) * (1 - jet);
      const tuck = [0.2 * jet + 0.65 * rise + 0.3 * fall, 0.1 * jet + 0.45 * rise + 0.15 * fall];
      const kneeAir = [-(0.5 * jet + 1.1 * rise + 0.45 * fall), -(0.35 * jet + 0.8 * rise + 0.3 * fall)];
      for (let i = 0; i < 2; i++) {
        thigh[i] += (tuck[i] - thigh[i]) * air;
        knee[i] += (kneeAir[i] - knee[i]) * air;
        shoulder[i] += ((0.15 * jet + 0.7 * rise + 0.25 * fall) - shoulder[i]) * air;
        roll[i] += ((0.55 * jet + 0.35 * rise + 0.9 * fall) - roll[i]) * air;
        elbow[i] += ((0.5 * jet + 0.5 * rise + 0.3 * fall) - elbow[i]) * air;
      }
      spineX += (-(0.12 * jet + Math.min(0.35, a.speed * 0.03)) - spineX) * air * (0.4 + jet * 0.6);
      hipsYaw *= 1 - air;
      spineYaw *= 1 - air;
    }

    // --- landing squash
    if (w.land > 0) {
      const l = Math.sin(w.land * Math.PI * 0.5);
      hipsY -= 0.2 * l;
      spineX -= 0.25 * l;
      for (let i = 0; i < 2; i++) {
        thigh[i] += 0.75 * l;
        knee[i] -= 1.35 * l;
        roll[i] += 0.3 * l;
      }
    }

    // --- harvesting: crouch, aim the tool, fire the beam
    const h = w.harvest;
    if (h > 0.001) {
      hipsY -= 0.34 * h;
      spineX -= 0.32 * h;
      thigh[0] += (1.25 - thigh[0]) * h;
      thigh[1] += (0.55 - thigh[1]) * h;
      knee[0] += (-1.35 - knee[0]) * h;
      knee[1] += (-1.75 - knee[1]) * h;
      shoulder[1] += (1.15 - shoulder[1]) * h;
      roll[1] += (0.05 - roll[1]) * h;
      elbow[1] += (0.2 - elbow[1]) * h;
      shoulder[0] += (0.55 - shoulder[0]) * h;
      elbow[0] += (1.1 - elbow[0]) * h;
      headX += (-0.35 - headX) * h;
      hipsRoll *= 1 - h;
    }

    // --- apply
    this.hips.position.y = hipsY;
    this.hips.rotation.set(0, hipsYaw, hipsRoll);
    this.spine.rotation.set(spineX, spineYaw, 0);
    this.head.rotation.set(headX - spineX * 0.6, headYaw - spineYaw * 0.5, 0);
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      this.hip[i].rotation.set(thigh[i] - spineX * 0.1, 0, side * 0.03);
      this.kn[i].rotation.x = knee[i];
      this.an[i].rotation.x = -(thigh[i] + knee[i]) * 0.75 + (w.air > 0.5 ? 0.35 : 0);
      this.sh[i].rotation.set(shoulder[i], 0, side * roll[i]);
      this.el[i].rotation.x = elbow[i];
    }

    // jetpack flames
    const jetOn = w.jet > 0.1;
    const fl = 0.8 + Math.sin(this.t * 47) * 0.15 + Math.sin(this.t * 31) * 0.1;
    for (const f of this.flames) {
      f.visible = jetOn;
      f.scale.set(1, fl * (0.6 + w.jet), 1);
    }
    this.flameGlow.visible = jetOn;
    this.flameGlow.scale.setScalar(0.6 + w.jet * 0.6 * fl);

    // tool + beam
    this.tool.visible = h > 0.05;
    const beamOn = h > 0.6 && this.harvestT > 0.15 && this.harvestT < 0.95 && !!this.harvestTarget;
    this.beam.visible = beamOn;
    this.beamGlow.visible = beamOn;
    if (beamOn) {
      this.group.updateMatrixWorld(true);
      const from = this.toolTip.getWorldPosition(new THREE.Vector3());
      const to = this.harvestTarget!.clone();
      this.group.worldToLocal(from);
      this.group.worldToLocal(to);
      const d = to.clone().sub(from);
      this.beam.position.copy(from);
      this.beam.scale.set(1 + Math.sin(this.t * 60) * 0.4, 1, d.length());
      this.beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), d.normalize());
      this.beamGlow.position.copy(to);
      this.beamGlow.scale.setScalar(0.8 + Math.sin(this.t * 35) * 0.25);
    }
  }

  dispose() {
    this.group.removeFromParent();
  }
}
