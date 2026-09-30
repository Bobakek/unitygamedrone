import * as THREE from 'three';
import type { Species } from '../../shared/fauna.ts';
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

interface Leg { hip: THREE.Group; knee: THREE.Group; phase: number; side: number; row: number }

/**
 * Procedural low-poly animal. Three body plans (quadruped, six-legged,
 * biped raptor) are assembled from boxes and animated with simple gait
 * cycles driven by ground speed; grazers dip their heads, predators lunge.
 * Local frame: forward -Z, up +Y, feet at y = 0.
 */
export class CreatureView {
  readonly group = new THREE.Group();
  private body = new THREE.Group();
  private neck = new THREE.Group();
  private head = new THREE.Group();
  private tail: THREE.Group | null = null;
  private legs: Leg[] = [];
  private phase = Math.random() * 10;
  private idle = Math.random() * 10;
  private lunge = 0;
  private deadK = 0;
  private hitFlash = 0;
  private bodyY = 0;
  private meshes: THREE.Mesh[] = [];
  private glow: THREE.Sprite | null = null;

  constructor(readonly sp: Species) {
    const [c0, c1, c2] = sp.colors;
    const s = sp.size;
    this.group.add(this.body);
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
    const leg = (x: number, y: number, z: number, upper: number, lower: number, thick: number, side: number, row: number, phase: number, splay = 0) => {
      const hip = new THREE.Group();
      hip.position.set(x, y, z);
      hip.rotation.z = splay * side;
      const knee = new THREE.Group();
      knee.position.y = -upper;
      add(hip, box(thick, upper, thick), c0, [0, -upper / 2, 0]);
      add(knee, box(thick * 0.8, lower, thick * 0.8), c1, [0, -lower / 2, 0]);
      add(knee, box(thick * 1.2, thick * 0.5, thick * 1.6), c1, [0, -lower, -thick * 0.3]);
      hip.add(knee);
      this.body.add(hip);
      this.legs.push({ hip, knee, phase, side, row });
    };

    if (sp.plan === 'quad') {
      this.bodyY = 1.0;
      add(this.body, tapered(0.8, 0.75, 1.7, 0.85), c0, [0, 1.05, 0]);
      add(this.body, box(0.6, 0.2, 1.3), c1, [0, 0.72, 0]);
      this.neck.position.set(0, 1.25, -0.75);
      this.body.add(this.neck);
      add(this.neck, box(0.34, 0.34, 0.7), c0, [0, 0.12, -0.3], [0.6, 0, 0]);
      this.head.position.set(0, 0.35, -0.62);
      this.neck.add(this.head);
      add(this.head, tapered(0.36, 0.34, 0.62, 0.6), c0, [0, 0, -0.18]);
      add(this.head, box(0.24, 0.16, 0.2), c1, [0, -0.08, -0.5]);
      for (const x of [-1, 1]) add(this.head, box(0.07, 0.07, 0.04), sp.predator ? c2 : '#111111', [x * 0.13, 0.07, -0.42], [0, 0, 0], sp.predator);
      if (sp.horns) for (const x of [-1, 1]) add(this.head, new THREE.ConeGeometry(0.06, 0.45, 4), c2, [x * 0.14, 0.32, 0.02], [-0.5, 0, x * 0.35]);
      else for (const x of [-1, 1]) add(this.head, new THREE.ConeGeometry(0.08, 0.22, 3), c0, [x * 0.12, 0.25, 0.05], [-0.2, 0, x * 0.2]);
      if (sp.tail) {
        this.tail = new THREE.Group();
        this.tail.position.set(0, 1.2, 0.85);
        this.body.add(this.tail);
        add(this.tail, tapered(0.16, 0.16, 0.8, 1.8), c0, [0, -0.1, 0.35], [-0.5, 0, 0]);
      }
      for (const [z, row] of [[-0.6, 0], [0.62, 1]] as const) {
        for (const side of [-1, 1]) leg(side * 0.3, 0.85, z, 0.45, 0.42, 0.16, side, row, (row === 0) === (side < 0) ? 0 : Math.PI);
      }
    } else if (sp.plan === 'hex') {
      this.bodyY = 0.62;
      add(this.body, tapered(1.0, 0.45, 0.9, 0.85), c0, [0, 0.72, -0.1]);
      add(this.body, tapered(0.95, 0.55, 1.1, 0.8).rotateY(Math.PI), c0, [0, 0.78, 0.85]);
      add(this.body, box(0.7, 0.14, 1.6), c1, [0, 0.5, 0.35]);
      if (sp.glow) for (let i = 0; i < 4; i++) add(this.body, new THREE.SphereGeometry(0.08, 5, 3), c2, [(i % 2 ? 1 : -1) * 0.28, 1.05, 0.5 + Math.floor(i / 2) * 0.35], [0, 0, 0], true);
      this.neck.position.set(0, 0.72, -0.55);
      this.body.add(this.neck);
      this.head.position.set(0, 0, -0.1);
      this.neck.add(this.head);
      add(this.head, tapered(0.55, 0.36, 0.45, 0.7), c0, [0, 0, -0.2]);
      for (const x of [-1, 1]) {
        add(this.head, new THREE.ConeGeometry(0.05, 0.38, 4), c1, [x * 0.16, -0.08, -0.52], [-Math.PI / 2 - 0.3, 0, x * 0.4]);
        add(this.head, new THREE.SphereGeometry(0.05, 4, 3), sp.predator ? c2 : '#101010', [x * 0.14, 0.1, -0.38], [0, 0, 0], sp.predator);
      }
      if (sp.tail) {
        this.tail = new THREE.Group();
        this.tail.position.set(0, 0.95, 1.35);
        this.body.add(this.tail);
        let seg: THREE.Object3D = this.tail;
        for (let i = 0; i < 4; i++) {
          const g = new THREE.Group();
          g.position.set(0, i ? 0.3 : 0, 0);
          g.rotation.x = i ? -0.55 : -0.9;
          seg.add(g);
          add(g, box(0.16 - i * 0.02, 0.32, 0.16 - i * 0.02), c0, [0, 0.15, 0]);
          seg = g;
        }
        add(seg, new THREE.ConeGeometry(0.08, 0.3, 4), c2, [0, 0.38, -0.05], [-0.8, 0, 0], true);
      }
      for (let row = 0; row < 3; row++) {
        for (const side of [-1, 1]) {
          const tripod = (row % 2 === 0) === (side < 0);
          leg(side * 0.42, 0.72, -0.45 + row * 0.45, 0.55, 0.62, 0.09, side, row, tripod ? 0 : Math.PI, 1.0);
        }
      }
    } else {
      // biped raptor
      this.bodyY = 1.2;
      add(this.body, tapered(0.55, 0.62, 1.2, 0.8), c0, [0, 1.35, 0]);
      add(this.body, box(0.4, 0.2, 0.9), c1, [0, 1.08, -0.05]);
      this.neck.position.set(0, 1.5, -0.55);
      this.body.add(this.neck);
      add(this.neck, box(0.26, 0.26, 0.6), c0, [0, 0.15, -0.2], [0.9, 0, 0]);
      this.head.position.set(0, 0.42, -0.4);
      this.neck.add(this.head);
      add(this.head, tapered(0.3, 0.3, 0.75, 0.55), c0, [0, 0, -0.25]);
      add(this.head, tapered(0.24, 0.1, 0.6, 0.6), c1, [0, -0.17, -0.3]);
      add(this.head, box(0.36, 0.08, 0.4), c2, [0, 0.19, 0.05], [0.3, 0, 0], true);
      for (const x of [-1, 1]) add(this.head, box(0.06, 0.06, 0.04), c2, [x * 0.12, 0.06, -0.38], [0, 0, 0], true);
      for (const x of [-1, 1]) add(this.body, box(0.08, 0.35, 0.08), c1, [x * 0.2, 1.1, -0.5], [-0.6, 0, 0]);
      this.tail = new THREE.Group();
      this.tail.position.set(0, 1.4, 0.55);
      this.body.add(this.tail);
      add(this.tail, tapered(0.3, 0.3, 1.5, 3.2).rotateY(Math.PI), c0, [0, 0, 0.72]);
      for (const side of [-1, 1]) leg(side * 0.24, 1.2, 0.15, 0.62, 0.62, 0.17, side, 0, side < 0 ? 0 : Math.PI);
    }
  }

  attack() { this.lunge = 1; }
  hit() { this.hitFlash = 0.15; }

  /** `speed` = ground speed (m/s), `dead` = carcass pose. */
  update(dt: number, speed: number, dead: boolean) {
    const s = this.sp.size;
    if (dead) {
      if (!this.glow) {
        // carcasses glow faintly: bio samples can be taken
        this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color(0.5, 2.0, 0.7), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
        this.glow.scale.setScalar(2.2 * s);
        this.glow.position.y = 0.6 * s;
        this.group.add(this.glow);
      }
      this.glow.material.opacity = 0.5 + Math.sin(this.idle * 3) * 0.3;
      this.idle += dt;
      this.deadK = Math.min(1, this.deadK + dt * 2.5);
      this.body.rotation.z = this.deadK * Math.PI * 0.5;
      this.body.position.y = -this.deadK * this.bodyY * s * 0.45;
      for (const l of this.legs) { l.hip.rotation.x = 0.4 * this.deadK; l.knee.rotation.x = -0.3 * this.deadK; }
      return;
    }
    this.deadK = 0;
    this.body.rotation.z = 0;
    const stride = (this.sp.plan === 'hex' ? 0.9 : 1.3) * s;
    this.phase += (dt * speed * Math.PI) / stride;
    const amp = Math.min(1, speed / (this.sp.walk * 2)) * (this.sp.plan === 'hex' ? 0.45 : 0.75);
    for (const l of this.legs) {
      const a = Math.sin(this.phase + l.phase);
      if (this.sp.plan === 'hex') {
        l.hip.rotation.y = a * amp * 0.9;
        l.hip.rotation.z = l.side * (1.0 - Math.max(0, Math.cos(this.phase + l.phase)) * amp * 0.6);
        l.knee.rotation.z = -l.side * 1.6;
      } else {
        l.hip.rotation.x = a * amp;
        l.knee.rotation.x = -Math.max(0, -Math.cos(this.phase + l.phase)) * amp * 1.3 + (this.sp.plan === 'biped' ? 0.5 : 0);
        if (this.sp.plan === 'biped') l.hip.rotation.x -= 0.25;
      }
    }
    const bob = Math.abs(Math.sin(this.phase)) * amp * 0.06 * s;
    this.body.position.y = bob;
    // head: grazing dips when standing, forward lunge on attack
    this.idle += dt;
    const graze = speed < 0.3 && !this.sp.predator ? Math.max(0, Math.sin(this.idle * 0.7)) : 0;
    this.lunge = Math.max(0, this.lunge - dt * 3.2);
    const lunge = Math.sin(this.lunge * Math.PI);
    this.neck.rotation.x = -graze * 0.9 + lunge * 0.5 + Math.sin(this.idle * 1.3) * 0.04;
    this.neck.position.z = (this.sp.plan === 'biped' ? -0.55 : this.sp.plan === 'hex' ? -0.55 : -0.75) - lunge * 0.35;
    this.head.rotation.y = Math.sin(this.idle * 0.5) * (speed < 0.3 ? 0.35 : 0.08);
    if (this.tail) this.tail.rotation.y = Math.sin(this.idle * (2 + speed)) * 0.3;
    if (this.hitFlash > 0) {
      this.hitFlash -= dt;
      this.body.scale.setScalar(s * (1 + this.hitFlash * 0.4));
    } else this.body.scale.setScalar(s);
  }

  dispose() {
    this.group.removeFromParent();
    for (const m of this.meshes) m.geometry.dispose();
    this.glow?.material.dispose();
  }
}
