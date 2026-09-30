import * as THREE from 'three';
import { MOOD, type Species } from '../../shared/fauna.ts';
import { glowTexture } from '../world/textures.ts';

const mats = new Map<string, THREE.MeshStandardMaterial>();
function mat(color: string, glow = false): THREE.MeshStandardMaterial {
  const key = color + (glow ? ':g' : '');
  let m = mats.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.8, emissive: glow ? color : '#000000', emissiveIntensity: glow ? 1.6 : 0 });
    mats.set(key, m);
  }
  return m;
}

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
function tapered(w: number, h: number, l: number, front: number) {
  const g = new THREE.BoxGeometry(w, h, l);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = 0.5 - p.getZ(i) / l; // 1 at the front (-Z)
    const k = THREE.MathUtils.lerp(1, front, t);
    p.setX(i, p.getX(i) * k);
    p.setY(i, p.getY(i) * k);
  }
  g.computeVertexNormals();
  return g;
}
const sstep = (x: number, a: number, b: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Gait timing: phase offset (fraction of a cycle) per leg for walk, trot and gallop. */
interface Leg { hip: THREE.Group; knee: THREE.Group; side: number; row: number; offs: [number, number, number]; splay: number }

export interface CreatureAnim {
  /** Ground speed, m/s. */
  speed: number;
  /** Heading change rate, rad/s (turning in place shuffles the legs). */
  turn: number;
  /** Behaviour (MOOD values): graze, wander, flee, hunt, alert, rest. */
  mood: number;
  dead: boolean;
}

/**
 * Procedural low-poly animal. Three body plans (quadruped, six-legged,
 * biped raptor) are assembled from boxes and animated procedurally:
 * walk / trot / gallop gaits blended by speed (tripod gait for six legs),
 * turning in place, grazing, an alert stance, lying down to rest, attacks
 * that fit the body plan (bite and lunge, pounce, fore-leg strike, tail
 * sting), roars, hit recoils and death. Local frame: forward -Z, up +Y.
 */
export class CreatureView {
  readonly group = new THREE.Group();
  private body = new THREE.Group();
  private torso = new THREE.Group();
  private neck = new THREE.Group();
  private head = new THREE.Group();
  private jaw = new THREE.Group();
  private tail: THREE.Group | null = null;
  private tailSegs: THREE.Group[] = [];
  private legs: Leg[] = [];
  private phase = Math.random() * 10;
  private idle = Math.random() * 10;
  private attackT = 0;
  private roarT = 0;
  private hitT = 0;
  private hitSide = 1;
  private deadK = 0;
  private restK = 0;
  private alertK = 0;
  private bodyY = 0;
  private meshes: THREE.Mesh[] = [];
  private glow: THREE.Sprite | null = null;
  /** Sea creatures: body segments (fish) and wing roots/tips (ray). */
  private segs: THREE.Group[] = [];
  private wings: { root: THREE.Group; tip: THREE.Group; side: number }[] = [];
  private swimPh = Math.random();
  private roll = 0;

  constructor(readonly sp: Species) {
    const [c0, c1, c2] = sp.colors;
    const s = sp.size;
    this.group.add(this.body);
    this.body.add(this.torso);
    this.body.scale.setScalar(s);
    const add = (parent: THREE.Object3D, g: THREE.BufferGeometry, color: string, pos: number[], rot: number[] = [0, 0, 0], glow = false) => {
      const m = new THREE.Mesh(g, mat(color, glow));
      m.position.set(pos[0], pos[1], pos[2]);
      m.rotation.set(rot[0], rot[1], rot[2]);
      m.castShadow = true;
      parent.add(m);
      this.meshes.push(m);
      return m;
    };
    const leg = (x: number, y: number, z: number, upper: number, lower: number, thick: number, side: number, row: number, offs: [number, number, number], splay = 0) => {
      const hip = new THREE.Group();
      hip.position.set(x, y, z);
      const knee = new THREE.Group();
      knee.position.y = -upper;
      add(hip, box(thick, upper, thick), c0, [0, -upper / 2, 0]);
      add(knee, box(thick * 0.8, lower, thick * 0.8), c1, [0, -lower / 2, 0]);
      add(knee, box(thick * 1.2, thick * 0.5, thick * 1.6), c1, [0, -lower, -thick * 0.3]);
      hip.add(knee);
      this.torso.add(hip);
      this.legs.push({ hip, knee, side, row, offs, splay });
    };
    const eyes = (parent: THREE.Object3D, x: number, y: number, z: number, r: number) => {
      for (const sx of [-1, 1]) add(parent, box(r, r, r * 0.6), sp.predator ? c2 : '#111111', [sx * x, y, z], [0, 0, 0], sp.predator);
    };

    if (sp.plan === 'fish') {
      // shark / eel: a chain of body segments ending in a tail fin, the head with a hinged jaw in front
      const eel = !!sp.eel;
      const n = eel ? 6 : 4, L = eel ? 3.0 : 1.9, segL = L / n;
      let parent: THREE.Object3D = this.torso;
      for (let i = 0; i < n; i++) {
        const g = new THREE.Group();
        g.position.z = i === 0 ? -L * 0.25 : segL;
        parent.add(g);
        const k = 1 - i / (n + 0.8);
        const w = (eel ? 0.3 : 0.52) * k, h = (eel ? 0.32 : 0.62) * (1 - i / (n + 1.6));
        add(g, tapered(w, h, segL * 1.08, i === 0 ? 1 : 1.12), c0, [0, 0, segL / 2]);
        add(g, box(w * 0.8, h * 0.3, segL), c1, [0, -h * 0.34, segL / 2]);
        if (sp.glow && i % 2 === 0) for (const x of [-1, 1]) add(g, new THREE.SphereGeometry(0.045, 4, 3), c2, [x * w * 0.5, h * 0.1, segL * 0.5], [0, 0, 0], true);
        if (!eel && i === 1) add(g, new THREE.ConeGeometry(0.22, 0.55, 3), c0, [0, h * 0.5 + 0.2, segL * 0.3], [-0.45, 0, 0], );
        if (!eel && i === 0) for (const x of [-1, 1]) add(g, box(0.5, 0.04, 0.26), c0, [x * 0.4, -0.18, segL * 0.6], [0, x * 0.3, x * -0.35]);
        this.segs.push(g);
        parent = g;
      }
      // tail fin: crescent for the shark, a ribbon for the eel
      if (eel) add(parent, box(0.03, 0.34, 0.5), c2, [0, 0, segL + 0.2], [0, 0, 0], !!sp.glow);
      else {
        add(parent, new THREE.ConeGeometry(0.09, 0.75, 3), c0, [0, 0.3, segL + 0.1], [0.75, 0, 0], );
        add(parent, new THREE.ConeGeometry(0.07, 0.45, 3), c0, [0, -0.2, segL + 0.05], [2.4, 0, 0]);
      }
      // head in front of the first segment
      this.head.position.z = -L * 0.25;
      this.torso.add(this.head);
      const hw = eel ? 0.3 : 0.5, hh = eel ? 0.3 : 0.5;
      add(this.head, tapered(hw, hh, 0.7, 0.45), c0, [0, 0.03, -0.32]);
      this.jaw.position.set(0, -hh * 0.3, -0.05);
      this.head.add(this.jaw);
      add(this.jaw, tapered(hw * 0.85, 0.1, 0.55, 0.5), c1, [0, -0.04, -0.26]);
      for (let i = 0; i < 4; i++) for (const sx of [-1, 1]) add(this.jaw, new THREE.ConeGeometry(0.018, 0.07, 3), '#f4f0e8', [sx * (0.05 + i * 0.03), 0.04, -0.46 + i * 0.07], [0, 0, 0]);
      eyes(this.head, hw * 0.38, 0.1, -0.44, 0.06);
    } else if (sp.plan === 'ray') {
      // manta: flat diamond body, flapping two-part wings, cephalic fins and a whip tail
      add(this.torso, new THREE.OctahedronGeometry(0.5, 0), c0, [0, 0, 0], [0, 0, 0]).scale.set(0.8, 0.28, 1.25);
      add(this.torso, new THREE.OctahedronGeometry(0.46, 0), c1, [0, -0.04, 0.02]).scale.set(0.74, 0.2, 1.15);
      // flat wing plates (outline in x / z, thickness down): inner part on the root, tip hinged at its edge
      const plate = (pts: number[][], t: number) => {
        const sh = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, z)));
        return new THREE.ExtrudeGeometry(sh, { depth: t, bevelEnabled: false }).rotateX(Math.PI / 2).translate(0, t / 2, 0);
      };
      for (const side of [-1, 1]) {
        const root = new THREE.Group();
        root.position.set(side * 0.28, 0, 0);
        this.torso.add(root);
        add(root, plate([[0, -0.55], [side * 0.7, -0.14], [side * 0.7, 0.3], [0, 0.5]], 0.09), c0, [0, 0.01, 0]);
        add(root, plate([[0, -0.5], [side * 0.68, -0.12], [side * 0.68, 0.27], [0, 0.45]], 0.03), c1, [0, -0.05, 0]);
        const tip = new THREE.Group();
        tip.position.set(side * 0.7, 0, 0);
        root.add(tip);
        add(tip, plate([[0, -0.14], [side * 0.62, 0.2], [0, 0.3]], 0.06), c0, [0, 0, 0]);
        if (sp.glow) for (let i = 0; i < 3; i++) add(root, new THREE.SphereGeometry(0.045, 4, 3), c2, [side * (0.2 + i * 0.18), 0.07, 0.02 + i * 0.05], [0, 0, 0], true);
        this.wings.push({ root, tip, side });
        // cephalic fins
        add(this.torso, box(0.07, 0.05, 0.3), c0, [side * 0.17, 0, -0.62], [0.3, side * 0.3, 0]);
      }
      this.head.position.z = -0.55;
      this.torso.add(this.head);
      eyes(this.head, 0.2, 0.06, -0.02, 0.05);
      this.jaw.position.set(0, -0.06, -0.05);
      this.head.add(this.jaw);
      add(this.jaw, box(0.3, 0.03, 0.08), c1, [0, 0, 0]);
      // whip tail
      let parent: THREE.Object3D = this.torso;
      for (let i = 0; i < 3; i++) {
        const g = new THREE.Group();
        g.position.z = i === 0 ? 0.55 : 0.45;
        parent.add(g);
        add(g, box(0.05 - i * 0.012, 0.05 - i * 0.012, 0.47), c0, [0, 0, 0.23]);
        this.segs.push(g);
        parent = g;
      }
    } else if (sp.plan === 'quad') {
      this.bodyY = 1.0;
      add(this.torso, tapered(0.8, 0.75, 1.7, 0.85), c0, [0, 1.05, 0]);
      add(this.torso, box(0.6, 0.2, 1.3), c1, [0, 0.72, 0]);
      this.neck.position.set(0, 1.25, -0.75);
      this.torso.add(this.neck);
      add(this.neck, box(0.34, 0.34, 0.7), c0, [0, 0.12, -0.3], [0.6, 0, 0]);
      this.head.position.set(0, 0.35, -0.62);
      this.neck.add(this.head);
      add(this.head, tapered(0.36, 0.26, 0.62, 0.6), c0, [0, 0.04, -0.18]);
      this.jaw.position.set(0, -0.08, -0.02);
      this.head.add(this.jaw);
      add(this.jaw, tapered(0.26, 0.1, 0.5, 0.6), c1, [0, -0.02, -0.24]);
      if (sp.predator) for (const sx of [-1, 1]) add(this.jaw, new THREE.ConeGeometry(0.025, 0.08, 3), '#f4f0e8', [sx * 0.07, 0.04, -0.4], [Math.PI, 0, 0]);
      eyes(this.head, 0.13, 0.1, -0.4, 0.07);
      if (sp.horns) for (const x of [-1, 1]) add(this.head, new THREE.ConeGeometry(0.06, 0.45, 4), c2, [x * 0.14, 0.32, 0.02], [-0.5, 0, x * 0.35]);
      else for (const x of [-1, 1]) add(this.head, new THREE.ConeGeometry(0.08, 0.22, 3), c0, [x * 0.12, 0.25, 0.05], [-0.2, 0, x * 0.2]);
      if (sp.tail) {
        this.tail = new THREE.Group();
        this.tail.position.set(0, 1.2, 0.85);
        this.torso.add(this.tail);
        add(this.tail, tapered(0.16, 0.16, 0.8, 1.8), c0, [0, -0.1, 0.35], [-0.5, 0, 0]);
      }
      // walk (lateral sequence), trot (diagonal pairs), gallop (fronts then hinds)
      leg(-0.3, 0.85, -0.6, 0.45, 0.42, 0.16, -1, 0, [0.25, 0, 0]);
      leg(0.3, 0.85, -0.6, 0.45, 0.42, 0.16, 1, 0, [0.75, 0.5, 0.1]);
      leg(-0.3, 0.85, 0.62, 0.45, 0.42, 0.16, -1, 1, [0, 0.5, 0.5]);
      leg(0.3, 0.85, 0.62, 0.45, 0.42, 0.16, 1, 1, [0.5, 0, 0.6]);
    } else if (sp.plan === 'hex') {
      this.bodyY = 0.62;
      add(this.torso, tapered(1.0, 0.45, 0.9, 0.85), c0, [0, 0.72, -0.1]);
      add(this.torso, tapered(0.95, 0.55, 1.1, 0.8).rotateY(Math.PI), c0, [0, 0.78, 0.85]);
      add(this.torso, box(0.7, 0.14, 1.6), c1, [0, 0.5, 0.35]);
      if (sp.glow) for (let i = 0; i < 4; i++) add(this.torso, new THREE.SphereGeometry(0.08, 5, 3), c2, [(i % 2 ? 1 : -1) * 0.28, 1.05, 0.5 + Math.floor(i / 2) * 0.35], [0, 0, 0], true);
      this.neck.position.set(0, 0.72, -0.55);
      this.torso.add(this.neck);
      this.head.position.set(0, 0, -0.1);
      this.neck.add(this.head);
      add(this.head, tapered(0.55, 0.36, 0.45, 0.7), c0, [0, 0, -0.2]);
      // mandibles open sideways on the "jaw"
      this.jaw.position.set(0, -0.08, -0.4);
      this.head.add(this.jaw);
      for (const x of [-1, 1]) add(this.jaw, new THREE.ConeGeometry(0.05, 0.38, 4), c1, [x * 0.16, 0, -0.12], [-Math.PI / 2 - 0.3, 0, x * 0.4]);
      for (const x of [-1, 1]) add(this.head, new THREE.SphereGeometry(0.05, 4, 3), sp.predator ? c2 : '#101010', [x * 0.14, 0.1, -0.38], [0, 0, 0], sp.predator);
      if (sp.tail) {
        this.tail = new THREE.Group();
        this.tail.position.set(0, 0.95, 1.35);
        this.torso.add(this.tail);
        let seg: THREE.Object3D = this.tail;
        for (let i = 0; i < 4; i++) {
          const g = new THREE.Group();
          g.position.set(0, i ? 0.3 : 0, 0);
          g.rotation.x = i ? -0.55 : -0.9;
          seg.add(g);
          add(g, box(0.16 - i * 0.02, 0.32, 0.16 - i * 0.02), c0, [0, 0.15, 0]);
          this.tailSegs.push(g);
          seg = g;
        }
        add(seg, new THREE.ConeGeometry(0.08, 0.3, 4), c2, [0, 0.38, -0.05], [-0.8, 0, 0], true);
      }
      // tripod gait: L1 R2 L3 together, R1 L2 R3 half a cycle later
      for (let row = 0; row < 3; row++) {
        for (const side of [-1, 1]) {
          const a = (row % 2 === 0) === (side < 0) ? 0 : 0.5;
          leg(side * 0.42, 0.72, -0.45 + row * 0.45, 0.55, 0.62, 0.09, side, row, [a, a, a], 1.0);
        }
      }
    } else {
      // biped raptor
      this.bodyY = 1.2;
      add(this.torso, tapered(0.55, 0.62, 1.2, 0.8), c0, [0, 1.35, 0]);
      add(this.torso, box(0.4, 0.2, 0.9), c1, [0, 1.08, -0.05]);
      this.neck.position.set(0, 1.5, -0.55);
      this.torso.add(this.neck);
      add(this.neck, box(0.26, 0.26, 0.6), c0, [0, 0.15, -0.2], [0.9, 0, 0]);
      this.head.position.set(0, 0.42, -0.4);
      this.neck.add(this.head);
      add(this.head, tapered(0.3, 0.24, 0.75, 0.55), c0, [0, 0.03, -0.25]);
      this.jaw.position.set(0, -0.1, 0.05);
      this.head.add(this.jaw);
      add(this.jaw, tapered(0.24, 0.1, 0.6, 0.6), c1, [0, -0.04, -0.3]);
      for (const sx of [-1, 1]) add(this.jaw, new THREE.ConeGeometry(0.02, 0.07, 3), '#f4f0e8', [sx * 0.07, 0.02, -0.45], [Math.PI, 0, 0]);
      add(this.head, box(0.36, 0.08, 0.4), c2, [0, 0.19, 0.05], [0.3, 0, 0], true);
      eyes(this.head, 0.12, 0.08, -0.38, 0.06);
      for (const x of [-1, 1]) add(this.torso, box(0.08, 0.35, 0.08), c1, [x * 0.2, 1.1, -0.5], [-0.6, 0, 0]);
      this.tail = new THREE.Group();
      this.tail.position.set(0, 1.4, 0.55);
      this.torso.add(this.tail);
      add(this.tail, tapered(0.1, 0.1, 1.5, 3.2), c0, [0, 0, 0.72]); // thick at the hips, thin tip
      leg(-0.24, 1.2, 0.15, 0.62, 0.62, 0.17, -1, 0, [0, 0, 0]);
      leg(0.24, 1.2, 0.15, 0.62, 0.62, 0.17, 1, 0, [0.5, 0.5, 0.5]);
    }
  }

  attack() { this.attackT = 1; }
  roar() { this.roarT = 1.2; }
  hit() { this.hitT = 0.3; this.hitSide = Math.random() < 0.5 ? -1 : 1; }

  update(dt: number, a: CreatureAnim) {
    const sp = this.sp, s = sp.size;
    this.idle += dt;
    if (a.dead) { this.die(dt); return; }
    if (sp.aquatic) { this.swim(dt, a); return; }
    this.deadK = 0;
    this.body.rotation.z = 0;
    const k = (r: number) => 1 - Math.exp(-dt * r);
    this.restK += ((a.mood === MOOD.rest && a.speed < 0.2 ? 1 : 0) - this.restK) * k(1.5);
    this.alertK += ((a.mood === MOOD.alert ? 1 : 0) - this.alertK) * k(6);
    this.attackT = Math.max(0, this.attackT - dt * 2.2);
    this.roarT = Math.max(0, this.roarT - dt);
    this.hitT = Math.max(0, this.hitT - dt);

    // --- gait: phase advances with ground speed (or with turning in place)
    const speed = a.speed;
    const turning = speed < 0.3 && Math.abs(a.turn) > 0.3;
    const stride = (sp.plan === 'hex' ? 0.9 : sp.plan === 'biped' ? 1.5 : 1.3) * s * (1 + 0.5 * sstep(speed, sp.walk * 1.5, sp.run));
    this.phase += turning ? dt * 3 : (dt * speed) / stride;
    const wGallop = sp.plan === 'quad' ? sstep(speed, sp.run * 0.55, sp.run * 0.85) : 0;
    const wTrot = sp.plan === 'quad' ? sstep(speed, sp.walk * 1.2, sp.walk * 2.2) * (1 - wGallop) : 0;
    const wWalk = 1 - wTrot - wGallop;
    const moving = Math.min(1, speed / (sp.walk * 1.5)) + (turning ? 0.35 : 0);
    const amp = (sp.plan === 'hex' ? 0.45 : 0.6 + 0.3 * wGallop) * Math.min(1, moving) * (1 - this.restK);
    const TAU = Math.PI * 2;
    for (const l of this.legs) {
      const ph = TAU * (this.phase + l.offs[0] * wWalk + l.offs[1] * wTrot + l.offs[2] * wGallop);
      const sw = Math.sin(ph), lift = Math.max(0, Math.cos(ph));
      if (sp.plan === 'hex') {
        // legs sweep forward/back around the vertical and lift on the return stroke
        l.hip.rotation.set(0, sw * amp * 0.9 * (turning ? l.side : 1), l.side * (1.0 - lift * amp * 0.7));
        l.knee.rotation.z = -l.side * (1.6 - lift * amp * 0.3);
      } else {
        l.hip.rotation.set(sw * amp - (sp.plan === 'biped' ? 0.25 : 0), 0, 0);
        l.knee.rotation.x = -lift * amp * 1.4 + (sp.plan === 'biped' ? 0.5 : 0);
      }
    }

    // --- body: bob, gallop flex, sway, lean into speed
    const bob = Math.abs(Math.sin(this.phase * TAU * (sp.plan === 'hex' ? 1 : 0.5))) * amp * (0.05 + 0.08 * wGallop) * s;
    const lean = sp.plan === 'biped' ? -0.25 * sstep(speed, sp.walk, sp.run) : 0;
    let pitch = lean + Math.sin(this.phase * TAU) * 0.1 * wGallop;
    let yaw = sp.plan === 'hex' ? Math.sin(this.phase * TAU) * 0.08 * amp : 0;
    let y = bob;

    // --- resting: settle to the ground, legs folded
    if (this.restK > 0.01) {
      y -= this.restK * this.bodyY * s * 0.55;
      for (const l of this.legs) {
        if (sp.plan === 'hex') l.hip.rotation.z = l.side * (1.0 + 0.6 * this.restK);
        else { l.hip.rotation.x += (l.row === 0 ? -1.2 : 1.1) * this.restK; l.knee.rotation.x += (l.row === 0 ? 2.2 : -2.1) * this.restK; }
      }
    }

    // --- head and neck: grazing dips, alert stance, roar, attack
    const grazing = a.mood === MOOD.graze && speed < 0.3 && !sp.predator ? Math.max(0, Math.sin(this.idle * 0.7)) : 0;
    let neckX = -grazing * 0.9 + Math.sin(this.idle * 1.3) * 0.04;
    let neckZ = 0;
    let jaw = grazing * 0.15 * Math.max(0, Math.sin(this.idle * 6));
    neckX += this.alertK * 0.45 - this.restK * 0.4;
    let headYaw = Math.sin(this.idle * 0.5) * (speed < 0.3 ? 0.35 : 0.08) * (1 - this.alertK) + Math.sin(this.idle * 2.1) * 0.12 * this.alertK;

    if (this.roarT > 0) {
      const r = Math.sin(Math.min(1, (1.2 - this.roarT) / 1.2) * Math.PI);
      neckX += 0.6 * r;
      jaw += 0.75 * r;
      headYaw *= 1 - r;
      yaw += Math.sin(this.idle * 40) * 0.02 * r;
    }

    const at = this.attackT > 0 ? Math.sin((1 - this.attackT) * Math.PI) : 0;
    let tailStrike = 0, forelegs = 0;
    if (at > 0) {
      jaw += 0.6 * at;
      if (sp.plan === 'biped') { y += 0.5 * at * s; pitch -= 0.35 * at; neckX -= 0.3 * at; }
      else if (sp.plan === 'hex' && sp.tail) tailStrike = at;
      else if (sp.plan === 'hex') { forelegs = at; pitch += 0.35 * at; }
      else { neckX -= 0.5 * at; pitch -= 0.1 * at; }
    }
    if (this.hitT > 0) {
      const h = Math.sin((this.hitT / 0.3) * Math.PI);
      pitch += 0.15 * h;
      yaw += 0.25 * h * this.hitSide;
      neckZ += 0.3 * h * this.hitSide;
    }
    for (const l of this.legs) {
      if (forelegs > 0 && l.row === 0) {
        l.hip.rotation.y = -l.side * 0.3 * forelegs;
        l.hip.rotation.z = l.side * (0.2 - 0.6 * forelegs);
      }
    }

    this.body.position.y = y;
    this.body.rotation.set(pitch, yaw, 0);
    this.neck.rotation.set(neckX, 0, neckZ);
    this.neck.position.z = (sp.plan === 'quad' ? -0.75 : -0.55) - (sp.plan === 'quad' ? 0.35 * at : 0);
    this.head.rotation.set(0, headYaw, 0);
    this.jaw.rotation.x = sp.plan === 'hex' ? 0 : Math.min(0.9, jaw);
    if (sp.plan === 'hex') this.jaw.scale.set(1 + Math.min(0.9, jaw) * 0.6, 1, 1);
    if (this.tail) {
      this.tail.rotation.y = Math.sin(this.idle * (2 + speed)) * 0.3 * (1 - this.restK);
      if (this.tailSegs.length) {
        this.tailSegs.forEach((g, i) => { g.rotation.x = (i ? -0.55 : -0.9) - tailStrike * (i ? 0.35 : 0.2); });
      } else this.tail.rotation.x = -0.1 * wGallop * Math.sin(this.phase * TAU) - 0.2 * this.alertK;
    }
  }

  /**
   * Sea creatures: the fish body undulates (faster and wider with speed, a burst when
   * lunging), the ray flaps its wings in a travelling wave; both bank into turns.
   */
  private swim(dt: number, a: CreatureAnim) {
    const sp = this.sp;
    const k = (r: number) => 1 - Math.exp(-dt * r);
    this.attackT = Math.max(0, this.attackT - dt * 2.2);
    this.roarT = Math.max(0, this.roarT - dt);
    this.hitT = Math.max(0, this.hitT - dt);
    this.deadK = 0;
    const fast = Math.min(1, a.speed / sp.run);
    const at = this.attackT > 0 ? Math.sin((1 - this.attackT) * Math.PI) : 0;
    const TAU = Math.PI * 2;
    this.roll += (-Math.max(-1, Math.min(1, a.turn)) * 0.45 - this.roll) * k(4);
    let yaw = 0, pitch = 0, z = 0;
    if (sp.plan === 'fish') {
      this.swimPh += dt * (0.7 + a.speed * 0.9 + at * 2) / sp.size;
      const amp = 0.1 + 0.2 * fast + 0.2 * at;
      const n = this.segs.length;
      this.segs.forEach((g, i) => { g.rotation.y = Math.sin(this.swimPh * TAU - i * 0.9) * amp * (0.35 + (i / n) * 0.9); });
      yaw = -Math.sin(this.swimPh * TAU + 0.6) * amp * 0.25;
      z = -0.5 * at;
      this.head.rotation.x = 0.15 * at;
    } else {
      this.swimPh += dt * (0.35 + a.speed * 0.28) * (1 + at);
      const amp = 0.28 + 0.35 * fast + (a.mood === MOOD.rest ? -0.15 : 0);
      for (const w of this.wings) {
        w.root.rotation.z = w.side * Math.sin(this.swimPh * TAU) * amp;
        w.tip.rotation.z = w.side * Math.sin(this.swimPh * TAU - 1.1) * amp * 1.2;
      }
      this.segs.forEach((g, i) => { g.rotation.y = Math.sin(this.idle * 1.8 - i) * 0.15; g.rotation.x = Math.sin(this.idle * 1.3 - i) * 0.08; });
      pitch = -Math.sin(this.swimPh * TAU) * 0.06 * amp;
      z = -0.3 * at;
    }
    let jaw = 0.8 * at;
    if (this.roarT > 0) jaw = Math.max(jaw, 0.7 * Math.sin(Math.min(1, (1.2 - this.roarT) / 1.2) * Math.PI));
    if (this.hitT > 0) { const h = Math.sin((this.hitT / 0.3) * Math.PI); yaw += 0.35 * h * this.hitSide; pitch += 0.15 * h; }
    this.jaw.rotation.x = Math.min(0.9, jaw);
    this.body.position.set(0, Math.sin(this.idle * 0.9) * 0.05, z * sp.size);
    this.body.rotation.set(pitch, yaw, this.roll);
  }

  /** Carcass: roll onto the side, legs stiffen and curl, a faint glow marks the samples. */
  private die(dt: number) {
    const s = this.sp.size;
    if (!this.glow) {
      this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color(0.5, 2.0, 0.7), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
      this.glow.scale.setScalar(2.2 * s);
      this.glow.position.y = (this.sp.aquatic ? 0.2 : 0.6) * s;
      this.group.add(this.glow);
    }
    this.glow.material.opacity = 0.5 + Math.sin(this.idle * 3) * 0.3;
    this.deadK = Math.min(1, this.deadK + dt * 2.5);
    const d = this.deadK;
    if (this.sp.aquatic) {
      // belly up, fins limp, drifting
      this.body.rotation.set(0, 0, Math.PI * d);
      this.body.position.set(0, Math.sin(this.idle * 0.8) * 0.05, 0);
      this.segs.forEach((g, i) => { g.rotation.y = 0.12 * d * (i % 2 ? 1 : -1); });
      for (const w of this.wings) { w.root.rotation.z = -w.side * 0.25 * d; w.tip.rotation.z = -w.side * 0.3 * d; }
      this.jaw.rotation.x = 0.3 * d;
      return;
    }
    // roll onto the side (six-legged: onto the back) about the feet, then lift so the torso rests on the ground
    const hex = this.sp.plan === 'hex';
    const ang = d * Math.PI * (hex ? 1 : 0.5);
    const cy = this.bodyY * s + 0.05 * s;
    // torso centre (cy above the feet) ends up `rest` above the ground, straight above the old spot
    const rest = (this.sp.plan === 'quad' ? 0.4 : 0.3) * s;
    this.body.rotation.set(0, 0, ang);
    this.body.position.set(Math.sin(ang) * cy, cy + (rest - cy) * d - Math.cos(ang) * cy, 0);
    this.neck.rotation.set(-0.2 * d, 0, 0.3 * d);
    this.jaw.rotation.x = this.sp.plan === 'hex' ? 0 : 0.35 * d;
    for (const l of this.legs) {
      if (this.sp.plan === 'hex') { l.hip.rotation.z = l.side * (1 - 0.9 * d); l.knee.rotation.z = -l.side * (1.6 + 0.8 * d); }
      else { l.hip.rotation.x = 0.4 * d * (l.row === 0 ? -1 : 1); l.knee.rotation.x = -0.6 * d; }
    }
  }

  dispose() {
    this.group.removeFromParent();
    for (const m of this.meshes) m.geometry.dispose();
    this.glow?.material.dispose();
  }
}
