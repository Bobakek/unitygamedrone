import * as THREE from 'three';
import { glowTexture } from '../world/textures.ts';

/**
 * Low-poly astronaut with a full procedural rig: hips → spine → head, arms
 * (shoulder/elbow/hand) and legs (hip/knee/ankle), carrying a blaster rifle
 * and a mining tool. Poses are blended from layers: directional locomotion
 * (forward, backpedal, strafe, diagonals), jump/fall/jetpack/landing,
 * vaulting and climbing over obstacles, scrambling up slopes, aiming and
 * firing (two-handed, arms solved with IK onto the rifle), harvesting, hit
 * flinches and idle fidgets.
 * Local frame: forward = -Z, up = +Y, origin at the soles.
 */

const MAT = {
  suit: new THREE.MeshStandardMaterial({ color: '#f1eee6', flatShading: true, roughness: 0.72 }),
  accent: new THREE.MeshStandardMaterial({ color: '#f39a4a', flatShading: true, roughness: 0.6 }),
  joint: new THREE.MeshStandardMaterial({ color: '#59606c', flatShading: true, roughness: 0.55, metalness: 0.35 }),
  visor: new THREE.MeshStandardMaterial({ color: '#ffc24a', flatShading: true, roughness: 0.12, metalness: 0.9, emissive: '#2a1a00' }),
  tool: new THREE.MeshStandardMaterial({ color: '#343944', flatShading: true, roughness: 0.4, metalness: 0.6 }),
  glow: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 2.2, 2.6), toneMapped: false }),
  gun: new THREE.MeshStandardMaterial({ color: '#2c3038', flatShading: true, roughness: 0.35, metalness: 0.75 }),
  gunTrim: new THREE.MeshStandardMaterial({ color: '#f39a4a', flatShading: true, roughness: 0.5, metalness: 0.2 }),
  cell: new THREE.MeshBasicMaterial({ color: new THREE.Color(1.15, 0.55, 0.18), toneMapped: false }),
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
  // blaster rifle, local origin at the right-hand grip, muzzle towards -Z
  rBody: new THREE.BoxGeometry(0.075, 0.1, 0.36),
  rStock: new THREE.BoxGeometry(0.06, 0.12, 0.2),
  rGrip: new THREE.BoxGeometry(0.045, 0.1, 0.05),
  rFore: new THREE.BoxGeometry(0.05, 0.06, 0.12),
  rBarrel: new THREE.CylinderGeometry(0.02, 0.024, 0.26, 6).rotateX(Math.PI / 2),
  rEmitter: new THREE.CylinderGeometry(0.034, 0.034, 0.05, 8).rotateX(Math.PI / 2),
  rCell: new THREE.BoxGeometry(0.02, 0.045, 0.12),
  rScope: new THREE.CylinderGeometry(0.022, 0.022, 0.12, 6).rotateX(Math.PI / 2),
};

export interface AnimInput {
  /** Horizontal speed, m/s. */
  speed: number;
  /** Horizontal velocity along the facing and to the right (m/s); default: all forward. */
  fwd?: number;
  side?: number;
  /** Vertical (radial) velocity, m/s. */
  vUp: number;
  ground: boolean;
  jet: boolean;
  /** Look pitch (radians, + = up) for the head. */
  look: number;
  /** Heading change rate, rad/s. */
  turn: number;
  /** Rifle raised (aiming or firing) and its pitch (radians, + = up). */
  aim?: boolean;
  aimPitch?: number;
  /** Obstacle traversal: mode 1 vault, 2 climb over; t = progress 0..1. */
  climb?: { mode: number; t: number } | null;
  /** Scrambling up a steep slope. */
  scramble?: boolean;
}

const sstep = (x: number, a: number, b: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Smooth piecewise keyframe curve: `keys` = [t, value] pairs sorted by t. */
function key(t: number, keys: number[][]): number {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1], [t1, v1] = keys[i];
      const k = (t - t0) / (t1 - t0);
      return v0 + (v1 - v0) * k * k * (3 - 2 * k);
    }
  }
  return keys[keys.length - 1][1];
}

const _S = new THREE.Vector3(), _T = new THREE.Vector3(), _u = new THREE.Vector3(), _w = new THREE.Vector3(), _E = new THREE.Vector3();
const _ua = new THREE.Vector3(), _fa = new THREE.Vector3(), _X = new THREE.Vector3(), _Y = new THREE.Vector3(), _Z = new THREE.Vector3();
const _m = new THREE.Matrix4(), _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _e = new THREE.Euler();

/**
 * Two-bone arm IK in the parent (spine) space: shoulder at S reaches for T with
 * the elbow bending towards `pole`. Writes the shoulder rotation (arm hangs
 * along local -Y, elbow bends about local X towards -Z) and returns the elbow angle.
 */
function solveArm(S: THREE.Vector3, T: THREE.Vector3, pole: THREE.Vector3, L1: number, L2: number, out: THREE.Quaternion): number {
  _u.subVectors(T, S);
  const len = _u.length() || 1e-6;
  _u.divideScalar(len);
  const d = Math.min(L1 + L2 - 1e-3, Math.max(0.05, len));
  const a = Math.acos(Math.max(-1, Math.min(1, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d))));
  _w.copy(pole).addScaledVector(_u, -pole.dot(_u));
  if (_w.lengthSq() < 1e-8) _w.set(0, -1, 0).addScaledVector(_u, _u.y);
  _w.normalize();
  _E.copy(S).addScaledVector(_u, L1 * Math.cos(a)).addScaledVector(_w, L1 * Math.sin(a));
  _ua.subVectors(_E, S).divideScalar(L1);
  _fa.copy(S).addScaledVector(_u, d).sub(_E).normalize();
  _Z.copy(_fa).addScaledVector(_ua, -_fa.dot(_ua));
  if (_Z.lengthSq() < 1e-8) _Z.copy(_w);
  _Z.normalize().negate();
  _Y.copy(_ua).negate();
  _X.crossVectors(_Y, _Z);
  out.setFromRotationMatrix(_m.makeBasis(_X, _Y, _Z));
  return Math.acos(Math.max(-1, Math.min(1, _ua.dot(_fa))));
}

const GRIP_R = new THREE.Vector3(0, -0.03, 0.02);
const GRIP_L = new THREE.Vector3(0, -0.05, -0.24);
const POLE_R = new THREE.Vector3(0.8, -1, 0.3);
const POLE_L = new THREE.Vector3(-0.5, -1, 0.05);
const AIM_PIVOT = new THREE.Vector3(0.1, 0.46, -0.04);
const AIM_OFFSET = new THREE.Vector3(0, -0.06, -0.2);
/** Rifle stance: the torso turns right so the left hand reaches the foregrip. */
const STANCE_YAW = -0.32;

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
  private beltTool = new THREE.Group();
  private toolTip = new THREE.Object3D();
  private beam: THREE.Mesh;
  private beamGlow: THREE.Sprite;
  private flames: THREE.Mesh[] = [];
  private flameGlow: THREE.Sprite;
  private rifle = new THREE.Group();
  private muzzle = new THREE.Object3D();
  private flash: THREE.Sprite;
  private holsterQ = new THREE.Quaternion();
  private holsterP = new THREE.Vector3(-0.02, 0.3, 0.4);

  private t = Math.random() * 10;
  private phase = 0;
  private w = { walk: 0, run: 0, air: 0, jet: 0, rise: 0, land: 0, harvest: 0, aim: 0, climb: 0, scramble: 0 };
  private dirC = 1;
  private dirS = 0;
  private airTime = 0;
  private landing = 0;
  private harvestT = 0;
  private harvestTarget: THREE.Vector3 | null = null;
  private lastSin = [0, 0];
  private aimHold = 0;
  private recoil = 0;
  private flashT = 0;
  private hurtT = 0;
  private hurtSide = 1;
  private idleT = 0;
  private fidget = -1;
  private fidgetT = 0;
  private nextFidget = 5 + Math.random() * 4;
  private climb = { mode: 1, t: 0 };
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
      if (s < 0) part(el, new THREE.BoxGeometry(0.1, 0.07, 0.13), MAT.joint, [0.02, -0.2, -0.02]); // wrist computer
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
    // mining tool clipped to the belt when not in use
    this.beltTool.position.set(0.21, -0.02, 0.02);
    this.beltTool.rotation.set(Math.PI / 2 + 0.2, 0, 0.15);
    part(this.beltTool, G.toolBody, MAT.tool, [0, 0, -0.06]);
    part(this.beltTool, G.toolBarrel, MAT.joint, [0, 0.02, -0.26]);
    this.hips.add(this.beltTool);

    // blaster rifle (slung on the back until raised)
    part(this.rifle, G.rBody, MAT.gun, [0, 0.03, -0.1]);
    part(this.rifle, G.rStock, MAT.gun, [0, 0.0, 0.17], [0.12, 0, 0]);
    part(this.rifle, G.rGrip, MAT.gunTrim, [0, -0.05, 0.02], [0.3, 0, 0]);
    part(this.rifle, G.rFore, MAT.gunTrim, [0, -0.03, -0.24]);
    part(this.rifle, G.rBarrel, MAT.gun, [0, 0.04, -0.4]);
    part(this.rifle, G.rEmitter, MAT.joint, [0, 0.04, -0.52]);
    part(this.rifle, G.rCell, MAT.cell, [0.045, 0.02, -0.08]);
    part(this.rifle, G.rScope, MAT.joint, [0, 0.11, -0.08]);
    part(this.rifle, G.lamp, MAT.glow, [0, 0.11, -0.145], [0, 0, 0], [0.6, 0.6, 0.6]);
    this.muzzle.position.set(0, 0.04, -0.56);
    this.rifle.add(this.muzzle);
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color(2.8, 1.4, 0.5), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
    this.flash.visible = false;
    this.flash.scale.setScalar(0.45);
    this.muzzle.add(this.flash);
    this.spine.add(this.rifle);
    {
      // barrel up over the left shoulder, rifle top facing away from the back
      const fwd = new THREE.Vector3(-0.5, 0.86, 0).normalize();
      const z = fwd.clone().negate();
      const y = new THREE.Vector3(0, 0, 1).addScaledVector(z, -z.z).normalize();
      const x = new THREE.Vector3().crossVectors(y, z);
      this.holsterQ.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    }

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

  /** A blaster shot: raises the rifle, kicks it back and flashes the muzzle. */
  fire() {
    this.aimHold = 1.5;
    this.recoil = 1;
    this.flashT = 0.06;
  }

  /** Hit reaction (k = strength 0..1). */
  hurt(k = 1) {
    this.hurtT = 0.35 * Math.min(1, 0.5 + k);
    this.hurtSide = Math.random() < 0.5 ? -1 : 1;
  }

  /** Plays an idle fidget now (0 look around, 1 check the wrist computer, 2 stretch). */
  playFidget(kind: number) {
    this.fidget = kind;
    this.fidgetT = 0;
    this.idleT = 0;
  }

  /** True once the rifle is up (bolts should start at the muzzle). */
  get aiming(): boolean {
    return this.w.aim > 0.6;
  }

  /** Muzzle position in scene space. */
  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    this.group.updateMatrixWorld(true);
    return this.muzzle.getWorldPosition(out);
  }

  update(dt: number, a: AnimInput) {
    this.t += dt;
    const w = this.w;
    const k = (rate: number) => 1 - Math.exp(-dt * rate);
    const ground = a.ground;
    const climbing = !!a.climb && a.climb.mode > 0;
    if (climbing) this.climb = { ...a.climb! };

    // --- state weights (smoothed)
    if (!ground && !climbing) this.airTime += dt;
    else {
      if (this.airTime > 0.3 && ground) {
        this.landing = Math.min(1, 0.4 + this.airTime * 0.5);
        this.onLand?.(this.landing);
      }
      if (ground) this.airTime = 0;
    }
    this.landing = Math.max(0, this.landing - dt * 3.5);
    this.harvestT = Math.max(0, this.harvestT - dt);
    this.aimHold = Math.max(0, this.aimHold - dt);
    this.recoil = Math.max(0, this.recoil - dt * 9);
    this.flashT = Math.max(0, this.flashT - dt);
    this.hurtT = Math.max(0, this.hurtT - dt);
    const fwdV = a.fwd ?? a.speed, sideV = a.side ?? 0;
    const spd = Math.hypot(fwdV, sideV);
    const aimWanted = (!!a.aim || this.aimHold > 0) && this.harvestT <= 0 && !climbing;
    const tw = {
      walk: ground ? sstep(spd, 0.15, 1.4) : 0,
      run: ground ? sstep(spd, 5.2, 8.5) * (a.scramble ? 0 : 1) : 0,
      air: ground || climbing || this.airTime < 0.08 ? 0 : 1,
      jet: !ground && a.jet && !climbing ? 1 : 0,
      rise: a.vUp > 0.5 ? 1 : 0,
      land: this.landing,
      harvest: this.harvestT > 0 ? sstep(this.harvestT, 0, 0.25) * sstep(1.1 - this.harvestT, 0, 0.2) : 0,
      aim: aimWanted ? 1 : 0,
      climb: climbing ? 1 : 0,
      scramble: a.scramble && ground && !climbing ? 1 : 0,
    };
    w.walk += (tw.walk - w.walk) * k(10);
    w.run += (tw.run - w.run) * k(6);
    w.air += (tw.air - w.air) * k(10);
    w.jet += (tw.jet - w.jet) * k(8);
    w.rise += (tw.rise - w.rise) * k(6);
    w.land = tw.land;
    w.harvest += (tw.harvest - w.harvest) * k(14);
    w.aim += (tw.aim - w.aim) * k(aimWanted ? 9 : 5);
    w.climb += (tw.climb - w.climb) * k(14);
    w.scramble += (tw.scramble - w.scramble) * k(6);

    // movement direction relative to the facing (smoothed so turns blend)
    if (spd > 0.3) {
      this.dirC += (fwdV / spd - this.dirC) * k(8);
      this.dirS += (sideV / spd - this.dirS) * k(8);
    } else {
      this.dirC += (1 - this.dirC) * k(4);
      this.dirS += (0 - this.dirS) * k(4);
    }
    const dC = this.dirC, dS = this.dirS, strafe = Math.abs(dS);

    // --- gait phase (shorter steps backwards and sideways)
    const stride = (1.35 + w.run * 1.0) * (dC < 0 ? 0.8 : 1) * (1 - 0.25 * strafe) * (a.scramble ? 0.6 : 1);
    if (ground) this.phase += (dt * spd * Math.PI * 2) / stride;
    if (ground && spd < 0.6 && Math.abs(a.turn) > 0.4) this.phase += dt * Math.min(6, Math.abs(a.turn) * 3);
    const ph = this.phase;
    const sin = [Math.sin(ph), Math.sin(ph + Math.PI)], cos = [Math.cos(ph), Math.cos(ph + Math.PI)];
    const gw = Math.max(w.walk, ground && Math.abs(a.turn) > 0.4 ? 0.35 : 0) * (1 - w.air) * (1 - w.climb);

    // footfalls
    if (gw > 0.4) {
      for (let i = 0; i < 2; i++) {
        if (this.lastSin[i] > 0 && sin[i] <= 0) this.onStep?.(i);
        this.lastSin[i] = sin[i];
      }
    }

    // idle fidgets (look around, check the wrist computer, stretch)
    const idle = 1 - gw;
    if (ground && gw < 0.1 && w.aim < 0.1 && w.harvest < 0.05 && !climbing) this.idleT += dt; else { this.idleT = 0; this.fidget = -1; }
    if (this.fidget < 0 && this.idleT > this.nextFidget) { this.fidget = Math.floor(Math.random() * 3); this.fidgetT = 0; this.nextFidget = 6 + Math.random() * 5; this.idleT = 0; }
    let fid = 0;
    if (this.fidget >= 0) {
      this.fidgetT += dt;
      const dur = [2.6, 2.2, 1.8][this.fidget];
      fid = sstep(this.fidgetT, 0, 0.4) * (1 - sstep(this.fidgetT, dur - 0.4, dur));
      if (this.fidgetT > dur) this.fidget = -1;
    }

    const breath = Math.sin(this.t * 1.7);
    const legAmp = (0.42 + 0.4 * w.run) * gw;
    const kneeAmp = (0.55 + 0.85 * w.run) * gw;
    const armAmp = (0.32 + 0.6 * w.run) * gw * (1 - 0.6 * strafe);

    // --- base locomotion pose (forward / back / sideways blended by direction)
    let hipsY = 0.97 - 0.004 * breath * idle - (0.035 + 0.05 * w.run) * gw * (sin[0] * sin[0]);
    let hipsYaw = 0.1 * sin[0] * gw * Math.abs(dC) - dS * Math.sign(dC || 1) * 0.38 * gw;
    let hipsRoll = Math.sin(this.t * 0.55) * 0.025 * idle + dS * 0.05 * gw;
    let spineX = -0.03 + 0.012 * breath * idle - (0.05 * w.walk + 0.2 * w.run) * Math.max(0, dC) + 0.08 * Math.max(0, -dC) * gw;
    let spineYaw = -0.16 * sin[0] * gw * Math.abs(dC) - hipsYaw * 0.85;
    const thigh = [0, 0], thighZ = [0, 0], knee = [0, 0];
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      thigh[i] = legAmp * sin[i] * dC;
      let z = legAmp * 0.75 * sin[i] * dS;
      if (z * side < 0) z *= 0.35; // the trailing leg only closes in, never crosses far
      thighZ[i] = z;
      knee[i] = -(kneeAmp * Math.max(0, cos[i] * Math.sign(dC || 1)) * Math.abs(dC) + kneeAmp * 0.8 * Math.max(0, cos[i]) * strafe + 0.1 * gw + 0.04);
    }
    const shoulder = [-armAmp * sin[0] * Math.sign(dC || 1) + 0.05 * idle, -armAmp * sin[1] * Math.sign(dC || 1) + 0.05 * idle];
    const roll = [0.14 + 0.02 * breath * idle + 0.12 * strafe * gw, 0.14 + 0.02 * breath * idle + 0.12 * strafe * gw];
    const elbow = [0.2 + w.run * 1.1 + 0.25 * gw * Math.max(0, -sin[0]), 0.2 + w.run * 1.1 + 0.25 * gw * Math.max(0, -sin[1])];
    let headX = Math.max(-0.5, Math.min(0.6, a.look * 0.55));
    let headYaw = Math.sin(this.t * 0.31) * 0.28 * idle * (1 - w.harvest) - a.turn * 0.08;

    // --- fidgets
    if (fid > 0) {
      if (this.fidget === 0) { headYaw += Math.sin(this.fidgetT * 2.4) * 0.9 * fid; headX += 0.1 * fid; }
      else if (this.fidget === 1) {
        shoulder[0] += (1.25 - shoulder[0]) * fid; elbow[0] += (1.95 - elbow[0]) * fid; roll[0] += (0.35 - roll[0]) * fid;
        headX += (-0.45 - headX) * fid; headYaw += 0.35 * fid;
      } else {
        for (let i = 0; i < 2; i++) { shoulder[i] += (2.75 - shoulder[i]) * fid; elbow[i] += (0.3 - elbow[i]) * fid; roll[i] += (0.35 - roll[i]) * fid; }
        spineX += 0.16 * fid; headX += 0.3 * fid;
      }
    }

    // --- scrambling up a steep slope: bent over, hands reaching for the ground
    if (w.scramble > 0.001) {
      const sc = w.scramble;
      hipsY -= 0.18 * sc;
      spineX += (-0.85 - spineX) * sc;
      headX += (0.55 - headX) * sc;
      for (let i = 0; i < 2; i++) {
        shoulder[i] += (1.45 + 0.55 * sin[1 - i] - shoulder[i]) * sc;
        elbow[i] += (0.35 + 0.3 * Math.max(0, cos[1 - i]) - elbow[i]) * sc;
        roll[i] += (0.22 - roll[i]) * sc;
        thigh[i] += (0.75 + 0.45 * sin[i] - thigh[i]) * sc;
        knee[i] += (-1.2 - 0.5 * Math.max(0, cos[i]) - knee[i]) * sc;
      }
    }

    // --- airborne layers: jump / fall / jetpack
    const air = w.air;
    if (air > 0.001) {
      const jet = w.jet, rise = w.rise * (1 - jet), fall = (1 - w.rise) * (1 - jet);
      const tuck = [0.2 * jet + 0.65 * rise + 0.3 * fall, 0.1 * jet + 0.45 * rise + 0.15 * fall];
      const kneeAir = [-(0.5 * jet + 1.1 * rise + 0.45 * fall), -(0.35 * jet + 0.8 * rise + 0.3 * fall)];
      for (let i = 0; i < 2; i++) {
        thigh[i] += (tuck[i] - thigh[i]) * air;
        thighZ[i] *= 1 - air;
        knee[i] += (kneeAir[i] - knee[i]) * air;
        shoulder[i] += ((0.15 * jet + 0.7 * rise + 0.25 * fall) - shoulder[i]) * air;
        roll[i] += ((0.55 * jet + 0.35 * rise + 0.9 * fall) - roll[i]) * air;
        elbow[i] += ((0.5 * jet + 0.5 * rise + 0.3 * fall) - elbow[i]) * air;
      }
      spineX += (-(0.12 * jet + Math.min(0.35, spd * 0.03)) - spineX) * air * (0.4 + jet * 0.6);
      hipsYaw *= 1 - air;
      spineYaw *= 1 - air;
    }

    // --- vaulting / climbing over an obstacle (keyframed on the traversal progress)
    if (w.climb > 0.001) {
      const c = w.climb, t = this.climb.t;
      let pose: { hy: number; sx: number; roll: number; th: number[]; kn: number[]; sh: number[]; el: number[]; rl: number[] };
      if (this.climb.mode === 1) {
        // speed vault: left hand plants, legs tuck and swing past on the right
        pose = {
          // the root follows the feet; with the legs tucked the body sits low over the obstacle
          hy: key(t, [[0, -0.1], [0.35, -0.5], [0.8, -0.35], [1, 0]]), sx: key(t, [[0, -0.45], [0.5, -0.25], [1, -0.05]]), roll: key(t, [[0, 0], [0.35, 0.55], [0.75, 0.4], [1, 0]]),
          th: [key(t, [[0, -0.2], [0.35, 1.3], [0.8, 0.9], [1, 0.3]]), key(t, [[0, 0.3], [0.35, 1.45], [0.8, 0.7], [1, 0.1]])],
          kn: [key(t, [[0, -0.4], [0.35, -1.8], [0.8, -1.0], [1, -0.4]]), key(t, [[0, -0.6], [0.35, -1.9], [0.8, -0.8], [1, -0.3]])],
          sh: [key(t, [[0, 1.0], [0.3, 0.55], [0.65, 0.1], [1, 0.3]]), key(t, [[0, 0.6], [0.4, 1.7], [1, 0.5]])],
          el: [key(t, [[0, 0.2], [0.5, 0.1], [1, 0.4]]), [0.3, 0.4][0]],
          rl: [key(t, [[0, 0.1], [0.5, 0.25], [1, 0.2]]), key(t, [[0, 0.3], [0.4, 1.1], [1, 0.3]])],
        };
      } else {
        // climb over: reach up, pull, knee up onto the ledge, step over
        pose = {
          hy: key(t, [[0, 0], [0.15, 0.05], [0.45, -0.05], [1, 0]]), sx: key(t, [[0, 0.12], [0.2, 0.1], [0.5, -0.55], [0.8, -0.3], [1, -0.05]]), roll: 0,
          th: [key(t, [[0, 0.1], [0.3, -0.1], [0.6, 0.4], [0.85, 1.1], [1, 0.3]]), key(t, [[0, 0.3], [0.3, 0.9], [0.5, 1.75], [0.8, 0.8], [1, 0.1]])],
          kn: [key(t, [[0, -0.2], [0.3, -0.15], [0.6, -0.6], [0.85, -1.4], [1, -0.3]]), key(t, [[0, -0.5], [0.3, -1.6], [0.5, -2.1], [0.8, -0.9], [1, -0.3]])],
          sh: [key(t, [[0, 2.75], [0.18, 2.85], [0.5, 1.2], [0.7, 0.35], [1, 0.2]]), key(t, [[0, 2.75], [0.18, 2.85], [0.5, 1.3], [0.7, 0.4], [1, 0.2]])],
          el: [key(t, [[0, 0.2], [0.35, 1.5], [0.6, 0.6], [1, 0.3]]), key(t, [[0, 0.2], [0.35, 1.4], [0.6, 0.5], [1, 0.3]])],
          rl: [key(t, [[0, 0.25], [0.5, 0.35], [1, 0.15]]), key(t, [[0, 0.25], [0.5, 0.35], [1, 0.15]])],
        };
      }
      hipsY += pose.hy * c;
      spineX += (pose.sx - spineX) * c;
      hipsRoll += (pose.roll - hipsRoll) * c;
      hipsYaw *= 1 - c;
      spineYaw *= 1 - c;
      headX += (0.25 - headX) * c * (this.climb.mode === 2 ? 1 : 0.3);
      for (let i = 0; i < 2; i++) {
        thigh[i] += (pose.th[i] - thigh[i]) * c;
        thighZ[i] *= 1 - c;
        knee[i] += (pose.kn[i] - knee[i]) * c;
        shoulder[i] += (pose.sh[i] - shoulder[i]) * c;
        elbow[i] += (pose.el[i] - elbow[i]) * c;
        roll[i] += (pose.rl[i] - roll[i]) * c;
      }
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

    // --- rifle stance: torso turned, head and chest follow the aim pitch
    const aw = w.aim;
    const aimPitch = Math.max(-1.1, Math.min(1.0, a.aimPitch ?? a.look));
    if (aw > 0.001) {
      spineYaw += (STANCE_YAW - spineYaw) * aw;
      spineX += (aimPitch * 0.35 - 0.05 - spineX) * aw * 0.8;
      headX += (aimPitch * 0.6 - headX) * aw;
      headYaw += (-STANCE_YAW * 0.9 - headYaw) * aw;
      hipsYaw *= 1 - aw * 0.5;
      spineX += this.recoil * 0.05;
    }

    // --- hit flinch
    if (this.hurtT > 0) {
      const f = Math.sin((this.hurtT / 0.35) * Math.PI);
      spineX += 0.28 * f;
      spineYaw += 0.25 * f * this.hurtSide;
      headX += 0.3 * f;
      hipsY -= 0.05 * f;
      for (let i = 0; i < 2; i++) { roll[i] += 0.3 * f; elbow[i] += 0.4 * f; }
    }

    // --- apply
    this.hips.position.y = hipsY;
    this.hips.rotation.set(0, hipsYaw, hipsRoll);
    this.spine.rotation.set(spineX, spineYaw, 0);
    this.head.rotation.set(headX - spineX * 0.6, headYaw - spineYaw * 0.5, 0);
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      this.hip[i].rotation.set(thigh[i] - spineX * 0.1, 0, side * 0.03 + thighZ[i]);
      this.kn[i].rotation.x = knee[i];
      this.an[i].rotation.x = -(thigh[i] + knee[i]) * 0.75 + (w.air > 0.5 ? 0.35 : 0);
      this.sh[i].rotation.set(shoulder[i], 0, side * roll[i]);
      this.el[i].rotation.x = elbow[i];
    }

    // --- rifle: slung on the back ↔ raised to the shoulder; hands solved onto it
    const e = sstep(aw, 0, 1);
    _e.set(aimPitch - spineX, -spineYaw * 0.95, 0, 'YXZ');
    _qa.setFromEuler(_e);
    const aimP = _S.copy(AIM_OFFSET).applyQuaternion(_qa).add(AIM_PIVOT);
    aimP.z += this.recoil * 0.05;
    this.rifle.position.lerpVectors(this.holsterP, aimP, e);
    this.rifle.quaternion.slerpQuaternions(this.holsterQ, _qa, e);
    const ik = sstep(aw, 0.45, 0.95);
    if (ik > 0.001) {
      this.rifle.updateMatrix();
      for (let i = 0; i < 2; i++) {
        const grip = _T.copy(i === 1 ? GRIP_R : GRIP_L).applyMatrix4(this.rifle.matrix);
        const beta = solveArm(this.sh[i].position, grip, i === 1 ? POLE_R : POLE_L, 0.33, 0.29, _qb);
        this.sh[i].quaternion.slerp(_qb, ik);
        this.el[i].rotation.x += (beta - this.el[i].rotation.x) * ik;
      }
    }
    this.flash.visible = this.flashT > 0;
    if (this.flash.visible) this.flash.scale.setScalar(0.35 + Math.random() * 0.25);

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
    this.beltTool.visible = !this.tool.visible;
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
