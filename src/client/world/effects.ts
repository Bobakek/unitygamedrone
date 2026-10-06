import * as THREE from 'three';
import type { V3 } from '../../shared/math/vec.ts';
import { glowTexture, LOGDEPTH_FS, LOGDEPTH_FS_PARS, LOGDEPTH_VS, LOGDEPTH_VS_PARS, ringTexture } from './textures.ts';

interface Bolt { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; shooter: number; color: THREE.Color; delay: number }
interface Particle { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; max: number; size: number; r: number; g: number; b: number; drag: number }
interface Flash { sprite: THREE.Sprite; x: number; y: number; z: number; life: number; max: number; size: number; grow: number }
interface Shard { x: number; y: number; z: number; vx: number; vy: number; vz: number; ax: number; ay: number; az: number; rx: number; ry: number; rz: number; s: number; life: number; smoke: number }
const MAX_SHARDS = 400;
/** Point lights lent to explosions (they light up nearby hulls for a moment). */
const LIGHTS = 4;
interface Blast { x: number; y: number; z: number; t: number; k: number }
interface Glow { light: THREE.PointLight; x: number; y: number; z: number; life: number; max: number; power: number }
interface Meteor { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number }
/** A railgun trace (world ends) or an EMP shell (centre, radius) fading out. */
interface Beam { mesh: THREE.Mesh; glow: THREE.Mesh; a: V3; b: V3; life: number; max: number }
interface Pulse { mesh: THREE.Mesh; p: V3; r: number; life: number; max: number }

const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true).rotateX(Math.PI / 2);
const pulseGeo = new THREE.IcosahedronGeometry(1, 4);
const PULSE_VS = `varying vec3 vN; varying vec3 vV;
#include <common>
#include <logdepthbuf_pars_vertex>
void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv;
#include <logdepthbuf_vertex>
}`;
// a crackling fresnel shell: bright at the rim, banded so it reads as a wave front
const PULSE_FS = `uniform vec3 c; uniform float k; uniform float t; varying vec3 vN; varying vec3 vV;
#include <logdepthbuf_pars_fragment>
void main(){
#include <logdepthbuf_fragment>
float d = abs(dot(vN, vV));
float rim = pow(1.0 - d, 2.2);
float bands = 0.6 + 0.4 * sin(vN.y * 40.0 + vN.x * 23.0 + t * 30.0);
gl_FragColor = vec4(c * (rim * 1.6 + 0.08) * bands * k, 1.0); }`;

const MAX_BOLTS = 800;
const MAX_PARTICLES = 5000;

const PARTICLE_VS = `attribute float size; attribute vec4 rgba; uniform float scale; varying vec4 vC;
${LOGDEPTH_VS_PARS}
void main(){ vC = rgba; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = max(1.0, size * scale / max(0.1, -mv.z)); gl_Position = projectionMatrix*mv;
${LOGDEPTH_VS}
}`;
const PARTICLE_FS = `varying vec4 vC;
${LOGDEPTH_FS_PARS}
void main(){
${LOGDEPTH_FS}
  float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d); gl_FragColor = vec4(vC.rgb * a * vC.a, 1.0); }`;

/** Laser bolts, explosions, sparks and missile smoke — all in floating-origin space. */
export class Effects {
  readonly group = new THREE.Group();
  private bolts: Bolt[] = [];
  private boltMesh: THREE.InstancedMesh;
  private particles: Particle[] = [];
  private pGeo = new THREE.BufferGeometry();
  private pPos = new Float32Array(MAX_PARTICLES * 3);
  private pSize = new Float32Array(MAX_PARTICLES);
  private pCol = new Float32Array(MAX_PARTICLES * 4);
  private pMat: THREE.ShaderMaterial;
  private flashes: Flash[] = [];
  private shards: Shard[] = [];
  private meteors: Meteor[] = [];
  private shardMesh: THREE.InstancedMesh;
  private e = new THREE.Euler();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private dir = new THREE.Vector3();
  private Z = new THREE.Vector3(0, 0, 1);
  private blasts: Blast[] = [];
  private glows: Glow[] = [];
  private lightPool: THREE.PointLight[] = [];
  private beams: Beam[] = [];
  private pulses: Pulse[] = [];

  constructor() {
    for (let i = 0; i < LIGHTS; i++) {
      const l = new THREE.PointLight('#ffb070', 0, 600, 2);
      l.visible = false;
      this.lightPool.push(l);
      this.group.add(l);
    }
    this.boltMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.16, 0.16, 7), new THREE.MeshBasicMaterial({ toneMapped: false }), MAX_BOLTS);
    this.boltMesh.count = 0;
    this.boltMesh.frustumCulled = false;
    this.group.add(this.boltMesh);
    this.pGeo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.pGeo.setAttribute('size', new THREE.BufferAttribute(this.pSize, 1).setUsage(THREE.DynamicDrawUsage));
    this.pGeo.setAttribute('rgba', new THREE.BufferAttribute(this.pCol, 4).setUsage(THREE.DynamicDrawUsage));
    this.pMat = new THREE.ShaderMaterial({
      uniforms: { scale: { value: 600 } }, vertexShader: PARTICLE_VS, fragmentShader: PARTICLE_FS,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.shardMesh = new THREE.InstancedMesh(new THREE.TetrahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: '#4a4e58', flatShading: true, roughness: 0.4, metalness: 0.7, emissive: '#ff5a1a', emissiveIntensity: 0.35 }), MAX_SHARDS);
    this.shardMesh.count = 0;
    this.shardMesh.frustumCulled = false;
    this.group.add(this.shardMesh);
    const pts = new THREE.Points(this.pGeo, this.pMat);
    pts.frustumCulled = false;
    this.group.add(pts);
  }

  setViewport(height: number, fov: number) {
    this.pMat.uniforms.scale.value = height / (2 * Math.tan((fov * Math.PI) / 360));
  }

  /** `delay` postpones remote bolts so they line up with interpolated (past) ship poses. */
  bolt(p: V3, v: V3, color: THREE.Color, shooter: number, delay = 0, life = 1.25) {
    if (this.bolts.length >= MAX_BOLTS) this.bolts.shift();
    this.bolts.push({ x: p.x, y: p.y, z: p.z, vx: v.x, vy: v.y, vz: v.z, life, shooter, color, delay });
    if (!delay) this.flash(p, color, 2.2, 0.08);
  }

  /** Removes the bolt from `shooter` closest to `pos` (it hit something). */
  consumeBolt(shooter: number, pos: V3) {
    let best = -1, bd = 90 * 90;
    for (let i = 0; i < this.bolts.length; i++) {
      const b = this.bolts[i];
      if (b.shooter !== shooter) continue;
      const d = (b.x - pos.x) ** 2 + (b.y - pos.y) ** 2 + (b.z - pos.z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0) this.bolts.splice(best, 1);
  }

  private particle(p: Particle) {
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
    this.particles.push(p);
  }

  flash(p: V3, color: THREE.Color, size: number, life: number, map = glowTexture(), grow = 0.4) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, color: color.clone().multiplyScalar(2), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
    this.group.add(sprite);
    this.flashes.push({ sprite, x: p.x, y: p.y, z: p.z, life, max: life, size, grow });
  }

  /** Air bubbles rising along `up` from `p`; they pop at the surface `depth` metres above. */
  bubbles(p: V3, up: V3, n: number, depth: number) {
    for (let i = 0; i < n; i++) {
      const s = 0.9 + Math.random() * 0.8, life = Math.min(4, Math.max(0.1, depth) / s);
      this.particle({
        x: p.x + (Math.random() - 0.5) * 0.15, y: p.y + (Math.random() - 0.5) * 0.15, z: p.z + (Math.random() - 0.5) * 0.15,
        vx: up.x * s + (Math.random() - 0.5) * 0.3, vy: up.y * s + (Math.random() - 0.5) * 0.3, vz: up.z * s + (Math.random() - 0.5) * 0.3,
        life, max: life * 1.4, size: 0.05 + Math.random() * 0.07, r: 0.55, g: 0.75, b: 0.85, drag: 0,
      });
    }
  }

  spark(p: V3, color: THREE.Color, n = 10) {
    this.flash(p, color, 5, 0.18);
    for (let i = 0; i < n; i++) {
      const s = 25 + Math.random() * 60;
      this.particle({ x: p.x, y: p.y, z: p.z, vx: (Math.random() - 0.5) * s, vy: (Math.random() - 0.5) * s, vz: (Math.random() - 0.5) * s, life: 0.4, max: 0.4, size: 0.6, r: color.r * 2, g: color.g * 2, b: color.b * 2, drag: 2 });
    }
  }

  /** A short-lived light at `p` (explosions, warp-ins); the oldest is reused when all are busy. */
  light(p: V3, color: THREE.Color, power: number, life: number) {
    let l = this.lightPool.find((x) => !x.visible);
    if (!l) {
      const g = this.glows.shift()!;
      l = g.light;
    }
    l.visible = true;
    l.color.copy(color);
    this.glows.push({ light: l, x: p.x, y: p.y, z: p.z, life, max: life, power });
  }

  /** A laser hitting bare hull: hot streaks, glowing chips and a puff of smoke. */
  hullHit(p: V3, dir?: V3) {
    this.flash(p, new THREE.Color(1.6, 0.9, 0.4), 7, 0.14);
    const bx = dir ? -dir.x : 0, by = dir ? -dir.y : 0, bz = dir ? -dir.z : 0;
    for (let i = 0; i < 16; i++) {
      const s = 30 + Math.random() * 90;
      this.particle({
        x: p.x, y: p.y, z: p.z,
        vx: (Math.random() - 0.5) * s + bx * s * 0.8, vy: (Math.random() - 0.5) * s + by * s * 0.8, vz: (Math.random() - 0.5) * s + bz * s * 0.8,
        life: 0.25 + Math.random() * 0.35, max: 0.6, size: 0.35 + Math.random() * 0.4, r: 3, g: 1.6 + Math.random(), b: 0.5, drag: 3,
      });
    }
    for (let i = 0; i < 3; i++) {
      if (this.shards.length >= MAX_SHARDS) this.shards.shift();
      const s = 15 + Math.random() * 25;
      this.shards.push({
        x: p.x, y: p.y, z: p.z, vx: (Math.random() - 0.5) * s + bx * 10, vy: (Math.random() - 0.5) * s + by * 10, vz: (Math.random() - 0.5) * s + bz * 10,
        ax: Math.random() * 6, ay: Math.random() * 6, az: Math.random() * 6, rx: (Math.random() - 0.5) * 20, ry: (Math.random() - 0.5) * 20, rz: (Math.random() - 0.5) * 20,
        s: 0.15 + Math.random() * 0.2, life: 0.8 + Math.random() * 0.6, smoke: 0,
      });
    }
    this.particle({ x: p.x, y: p.y, z: p.z, vx: bx * 4, vy: by * 4, vz: bz * 4, life: 0.9, max: 0.9, size: 2.4, r: 0.35, g: 0.32, b: 0.3, drag: 1 });
  }

  /** A hull ripple of light where the shield caught a bolt. */
  shieldHit(p: V3, color: THREE.Color) {
    this.flash(p, color, 6, 0.16);
    for (let i = 0; i < 8; i++) {
      const s = 20 + Math.random() * 40;
      this.particle({ x: p.x, y: p.y, z: p.z, vx: (Math.random() - 0.5) * s, vy: (Math.random() - 0.5) * s, vz: (Math.random() - 0.5) * s, life: 0.3, max: 0.3, size: 0.5, r: color.r * 2, g: color.g * 2, b: color.b * 2, drag: 3 });
    }
  }

  /** A damaged ship trails smoke, and fire below a quarter hull (`k` = damage 0..1). */
  damage(p: V3, v: V3, k: number) {
    const fire = k > 0.75;
    this.particle({
      x: p.x + (Math.random() - 0.5) * 2, y: p.y + (Math.random() - 0.5) * 2, z: p.z + (Math.random() - 0.5) * 2,
      vx: v.x * 0.6 + (Math.random() - 0.5) * 4, vy: v.y * 0.6 + (Math.random() - 0.5) * 4, vz: v.z * 0.6 + (Math.random() - 0.5) * 4,
      life: 1.4, max: 1.4, size: 2 + k * 2, r: 0.28, g: 0.26, b: 0.25, drag: 1.4,
    });
    if (fire) {
      this.particle({
        x: p.x, y: p.y, z: p.z, vx: v.x * 0.8 + (Math.random() - 0.5) * 6, vy: v.y * 0.8 + (Math.random() - 0.5) * 6, vz: v.z * 0.8 + (Math.random() - 0.5) * 6,
        life: 0.45, max: 0.45, size: 1.6, r: 2.4, g: 0.9 + Math.random() * 0.5, b: 0.25, drag: 2,
      });
    }
  }

  /** A ship warping in at an arena start point: a team-coloured flash, a ring and a burst of light streaks. */
  warp(p: V3, color: THREE.Color) {
    this.flash(p, color, 70, 0.6);
    this.flash(p, new THREE.Color(1.6, 1.6, 1.8), 24, 0.25);
    this.flash(p, color, 60, 0.8, ringTexture(), 2.2);
    this.light(p, color, 30000, 0.6);
    for (let i = 0; i < 60; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u), s = 60 + Math.random() * 120;
      this.particle({ x: p.x, y: p.y, z: p.z, vx: Math.cos(a) * r * s, vy: u * s, vz: Math.sin(a) * r * s, life: 0.5, max: 0.5, size: 1.1, r: color.r * 2.5, g: color.g * 2.5, b: color.b * 2.5, drag: 4 });
    }
  }

  /**
   * A railgun slug: a white-hot core along the path with a coloured glow, a spiral of sparks
   * winding round it, a muzzle flash and, where it struck, a burst.
   */
  rail(a: V3, b: V3, color: THREE.Color, hit: boolean) {
    const mk = (r: number, c: THREE.Color, op: number) => {
      const m = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
      m.scale.set(r, r, 1);
      m.frustumCulled = false;
      this.group.add(m);
      return m;
    };
    this.beams.push({ mesh: mk(0.16, new THREE.Color(2.2, 2.4, 2.6), 1), glow: mk(0.55, color.clone().multiplyScalar(1.8), 0.4), a: { ...a }, b: { ...b }, life: 0.5, max: 0.5 });
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, len = Math.hypot(dx, dy, dz) || 1;
    const f = new THREE.Vector3(dx / len, dy / len, dz / len);
    const u = new THREE.Vector3(0, 1, 0).cross(f);
    if (u.lengthSq() < 1e-4) u.set(1, 0, 0).cross(f);
    u.normalize();
    const w = new THREE.Vector3().crossVectors(f, u);
    const steps = Math.min(220, Math.floor(len / 6));
    for (let i = 0; i < steps; i++) {
      const s = (i / steps) * len, ang = s * 0.18, r = 0.9;
      const ox = (u.x * Math.cos(ang) + w.x * Math.sin(ang)) * r, oy = (u.y * Math.cos(ang) + w.y * Math.sin(ang)) * r, oz = (u.z * Math.cos(ang) + w.z * Math.sin(ang)) * r;
      this.particle({
        x: a.x + f.x * s + ox, y: a.y + f.y * s + oy, z: a.z + f.z * s + oz, vx: ox * 1.5, vy: oy * 1.5, vz: oz * 1.5,
        life: 0.5 + Math.random() * 0.5, max: 1, size: 0.7, r: color.r * 1.6, g: color.g * 1.6, b: color.b * 1.6, drag: 1.5,
      });
    }
    this.flash(a, color, 9, 0.18);
    this.flash(a, new THREE.Color(2, 2, 2), 4, 0.1);
    if (hit) {
      this.flash(b, color, 22, 0.35);
      this.flash(b, color, 30, 0.5, ringTexture(), 1.4);
      this.spark(b, new THREE.Color(1.6, 1.8, 2.2), 30);
      this.light(b, color, 20000, 0.35);
    }
  }

  /** An EMP pulse: an electric shell racing out to radius `r`, a ring and crackling sparks. */
  emp(p: V3, r: number, color: THREE.Color) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { c: { value: color.clone() }, k: { value: 1 }, t: { value: 0 } }, vertexShader: PULSE_VS, fragmentShader: PULSE_FS,
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(pulseGeo, mat);
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.pulses.push({ mesh, p: { ...p }, r, life: 0.8, max: 0.8 });
    this.flash(p, color, 60, 0.4);
    this.flash(p, color, r * 0.7, 0.6, ringTexture(), 2.6);
    this.light(p, color, 40000, 0.5);
    for (let i = 0; i < 90; i++) {
      const uu = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, rr = Math.sqrt(1 - uu * uu), s = r * (0.8 + Math.random() * 0.6);
      this.particle({ x: p.x, y: p.y, z: p.z, vx: Math.cos(a) * rr * s, vy: uu * s, vz: Math.sin(a) * rr * s, life: 0.6, max: 0.6, size: 2.2, r: color.r * 2.2, g: color.g * 2.2, b: color.b * 2.4, drag: 2.5 });
    }
  }

  /** Blue arcs crawling over a ship caught by an EMP. */
  zap(p: V3, radius: number) {
    for (let i = 0; i < 26; i++) {
      const uu = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, rr = Math.sqrt(1 - uu * uu);
      const x = p.x + Math.cos(a) * rr * radius, y = p.y + uu * radius, z = p.z + Math.sin(a) * rr * radius;
      this.particle({ x, y, z, vx: (Math.random() - 0.5) * 30, vy: (Math.random() - 0.5) * 30, vz: (Math.random() - 0.5) * 30, life: 0.4 + Math.random() * 0.8, max: 1.2, size: 0.9, r: 0.8, g: 1.6, b: 2.6, drag: 3 });
    }
    this.flash(p, new THREE.Color(0.5, 1.1, 2), radius * 3, 0.3);
  }

  /** A ship blows up: a fireball, a shock ring, a flash of light, burning debris and a couple of secondary blasts. */
  shipExplosion(p: V3, big: boolean) {
    this.explosion(p, big);
    const k = big ? 1 : 0.5;
    this.light(p, new THREE.Color('#ffb070'), 60000 * k, 0.9);
    this.flash(p, new THREE.Color(2.4, 2.2, 1.9), 26 * k, 0.12);
    for (let i = 0; i < (big ? 3 : 1); i++) {
      this.blasts.push({ x: p.x + (Math.random() - 0.5) * 14, y: p.y + (Math.random() - 0.5) * 14, z: p.z + (Math.random() - 0.5) * 14, t: 0.15 + Math.random() * 0.5, k: 0.35 + Math.random() * 0.3 });
    }
    // big burning chunks of hull
    for (let i = 0; i < (big ? 10 : 3); i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u), sp = 20 + Math.random() * 40;
      if (this.shards.length >= MAX_SHARDS) this.shards.shift();
      this.shards.push({
        x: p.x, y: p.y, z: p.z, vx: Math.cos(a) * r * sp, vy: u * sp, vz: Math.sin(a) * r * sp,
        ax: Math.random() * 6, ay: Math.random() * 6, az: Math.random() * 6, rx: (Math.random() - 0.5) * 6, ry: (Math.random() - 0.5) * 6, rz: (Math.random() - 0.5) * 6,
        s: (1.6 + Math.random() * 1.8) * k, life: 3 + Math.random() * 2, smoke: 0,
      });
    }
  }

  explosion(p: V3, big: boolean) {
    const k = big ? 1 : 0.4;
    this.flash(p, new THREE.Color(1.6, 1.1, 0.6), 60 * k, 0.5);
    this.flash(p, new THREE.Color(1.2, 0.5, 0.2), 30 * k, 1.1);
    this.flash(p, new THREE.Color(1.2, 0.8, 0.5), 90 * k, 0.7, ringTexture(), 1.6);
    for (let i = 0; i < (big ? 18 : 5); i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u), sp = (25 + Math.random() * 55) * k;
      if (this.shards.length >= MAX_SHARDS) this.shards.shift();
      this.shards.push({
        x: p.x, y: p.y, z: p.z, vx: Math.cos(a) * r * sp, vy: u * sp, vz: Math.sin(a) * r * sp,
        ax: Math.random() * 6, ay: Math.random() * 6, az: Math.random() * 6, rx: (Math.random() - 0.5) * 12, ry: (Math.random() - 0.5) * 12, rz: (Math.random() - 0.5) * 12,
        s: (0.4 + Math.random() * 1.1) * (big ? 1 : 0.5), life: 2 + Math.random() * 1.5, smoke: 0,
      });
    }
    const n = big ? 160 : 50;
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
      const s = (20 + Math.random() * 90) * k;
      const hot = Math.random();
      this.particle({
        x: p.x, y: p.y, z: p.z, vx: Math.cos(a) * r * s, vy: u * s, vz: Math.sin(a) * r * s,
        life: 0.8 + Math.random() * 1.2, max: 2, size: (2 + Math.random() * 4) * k,
        r: 1.8, g: 0.6 + hot * 0.9, b: 0.2 + hot * 0.3, drag: 1.2,
      });
    }
    for (let i = 0; i < n / 4; i++) {
      const s = 8 * k;
      this.particle({ x: p.x, y: p.y, z: p.z, vx: (Math.random() - 0.5) * s, vy: (Math.random() - 0.5) * s, vz: (Math.random() - 0.5) * s, life: 2.5, max: 2.5, size: 9 * k, r: 0.25, g: 0.22, b: 0.22, drag: 0.5 });
    }
  }

  /** Footstep / landing dust kicked up along the local `up` direction. */
  dust(p: V3, up: V3, color: THREE.Color, n = 6, k = 1) {
    for (let i = 0; i < n; i++) {
      const s = (0.6 + Math.random() * 1.2) * k;
      this.particle({
        x: p.x + (Math.random() - 0.5) * 0.3, y: p.y + (Math.random() - 0.5) * 0.3, z: p.z + (Math.random() - 0.5) * 0.3,
        vx: up.x * s + (Math.random() - 0.5) * 1.5 * k, vy: up.y * s + (Math.random() - 0.5) * 1.5 * k, vz: up.z * s + (Math.random() - 0.5) * 1.5 * k,
        life: 0.7, max: 0.7, size: 0.35 * k, r: color.r * 0.5, g: color.g * 0.5, b: color.b * 0.5, drag: 2.5,
      });
    }
  }

  /** A burning meteor streaking past (meteor storms): a hot head leaving a fading trail. */
  meteor(p: V3, v: V3, life = 4) {
    if (this.meteors.length < 40) this.meteors.push({ x: p.x, y: p.y, z: p.z, vx: v.x, vy: v.y, vz: v.z, life });
  }

  smoke(p: V3) {
    this.particle({ x: p.x, y: p.y, z: p.z, vx: (Math.random() - 0.5) * 3, vy: (Math.random() - 0.5) * 3, vz: (Math.random() - 0.5) * 3, life: 1.2, max: 1.2, size: 2.2, r: 0.5, g: 0.45, b: 0.42, drag: 0.8 });
  }

  update(dt: number, origin: V3) {
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i];
      b.life -= dt;
      if (b.life <= 0) {
        for (const m of [b.mesh, b.glow]) { m.removeFromParent(); (m.material as THREE.Material).dispose(); }
        this.beams.splice(i, 1);
        continue;
      }
      const t = b.life / b.max;
      const len = Math.hypot(b.b.x - b.a.x, b.b.y - b.a.y, b.b.z - b.a.z);
      this.dir.set(b.b.x - b.a.x, b.b.y - b.a.y, b.b.z - b.a.z).normalize();
      this.q.setFromUnitVectors(this.Z, this.dir);
      for (const m of [b.mesh, b.glow]) {
        m.quaternion.copy(this.q);
        m.position.set((b.a.x + b.b.x) / 2 - origin.x, (b.a.y + b.b.y) / 2 - origin.y, (b.a.z + b.b.z) / 2 - origin.z);
        m.scale.z = len;
      }
      (b.mesh.material as THREE.MeshBasicMaterial).opacity = t * t;
      (b.glow.material as THREE.MeshBasicMaterial).opacity = 0.45 * t;
      b.glow.scale.x = b.glow.scale.y = 0.55 + (1 - t) * 1.2;
    }
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i];
      p.life -= dt;
      const mat = p.mesh.material as THREE.ShaderMaterial;
      if (p.life <= 0) { p.mesh.removeFromParent(); mat.dispose(); this.pulses.splice(i, 1); continue; }
      const t = 1 - p.life / p.max;
      p.mesh.position.set(p.p.x - origin.x, p.p.y - origin.y, p.p.z - origin.z);
      p.mesh.scale.setScalar(Math.max(1, p.r * (1 - (1 - t) ** 3)));
      mat.uniforms.k.value = (1 - t) * 1.2;
      mat.uniforms.t.value += dt;
    }
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const b = this.blasts[i];
      b.t -= dt;
      if (b.t > 0) continue;
      this.blasts.splice(i, 1);
      this.flash(b, new THREE.Color(1.6, 1, 0.5), 30 * b.k, 0.45);
      this.flash(b, new THREE.Color(1.2, 0.5, 0.2), 18 * b.k, 0.9);
      for (let j = 0; j < 40; j++) {
        const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u), s = (15 + Math.random() * 50) * b.k;
        this.particle({ x: b.x, y: b.y, z: b.z, vx: Math.cos(a) * r * s, vy: u * s, vz: Math.sin(a) * r * s, life: 0.6 + Math.random() * 0.6, max: 1.2, size: (2 + Math.random() * 3) * b.k, r: 1.8, g: 0.8 + Math.random() * 0.6, b: 0.25, drag: 1.4 });
      }
    }
    for (let i = this.glows.length - 1; i >= 0; i--) {
      const g = this.glows[i];
      g.life -= dt;
      if (g.life <= 0) { g.light.visible = false; g.light.intensity = 0; this.glows.splice(i, 1); continue; }
      const t = g.life / g.max;
      g.light.intensity = g.power * t * t;
      g.light.position.set(g.x - origin.x, g.y - origin.y, g.z - origin.z);
    }
    for (let i = this.meteors.length - 1; i >= 0; i--) {
      const m = this.meteors[i];
      m.life -= dt;
      if (m.life <= 0) { this.meteors.splice(i, 1); continue; }
      const steps = 3;
      for (let k = 0; k < steps; k++) {
        const f = k / steps;
        this.particle({ x: m.x + m.vx * dt * f, y: m.y + m.vy * dt * f, z: m.z + m.vz * dt * f, vx: 0, vy: 0, vz: 0, life: 1.1, max: 1.1, size: 22, r: 2, g: 0.9 + Math.random() * 0.4, b: 0.3, drag: 0 });
      }
      this.particle({ x: m.x, y: m.y, z: m.z, vx: 0, vy: 0, vz: 0, life: 0.06, max: 0.06, size: 45, r: 2.4, g: 2, b: 1.4, drag: 0 });
      m.x += m.vx * dt; m.y += m.vy * dt; m.z += m.vz * dt;
    }
    // bolts
    let n = 0;
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      if (b.delay > 0) {
        b.delay -= dt;
        if (b.delay <= 0) this.flash(b, b.color, 2.2, 0.08);
        continue;
      }
      b.life -= dt;
      if (b.life <= 0) { this.bolts.splice(i, 1); continue; }
      b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
    }
    for (const b of this.bolts) {
      if (b.delay > 0) continue;
      this.dir.set(b.vx, b.vy, b.vz).normalize();
      this.q.setFromUnitVectors(this.Z, this.dir);
      this.m.makeRotationFromQuaternion(this.q);
      this.m.setPosition(b.x - origin.x, b.y - origin.y, b.z - origin.z);
      this.boltMesh.setMatrixAt(n, this.m);
      this.boltMesh.setColorAt(n, b.color);
      n++;
    }
    this.boltMesh.count = n;
    this.boltMesh.instanceMatrix.needsUpdate = true;
    if (this.boltMesh.instanceColor) this.boltMesh.instanceColor.needsUpdate = true;

    // particles
    let k = 0;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) { this.particles.splice(i, 1); continue; }
      const dr = Math.exp(-p.drag * dt);
      p.vx *= dr; p.vy *= dr; p.vz *= dr;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    }
    for (const p of this.particles) {
      const a = Math.min(1, p.life / (p.max * 0.5));
      this.pPos[k * 3] = p.x - origin.x; this.pPos[k * 3 + 1] = p.y - origin.y; this.pPos[k * 3 + 2] = p.z - origin.z;
      this.pSize[k] = p.size * (1.6 - a * 0.6);
      this.pCol[k * 4] = p.r; this.pCol[k * 4 + 1] = p.g; this.pCol[k * 4 + 2] = p.b; this.pCol[k * 4 + 3] = a;
      k++;
    }
    this.pGeo.setDrawRange(0, k);
    (this.pGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.pGeo.attributes.size as THREE.BufferAttribute).needsUpdate = true;
    (this.pGeo.attributes.rgba as THREE.BufferAttribute).needsUpdate = true;

    // tumbling debris that leaves a smoke trail
    let ns = 0;
    for (let i = this.shards.length - 1; i >= 0; i--) {
      const d = this.shards[i];
      d.life -= dt;
      if (d.life <= 0) { this.shards.splice(i, 1); continue; }
      d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
      d.ax += d.rx * dt; d.ay += d.ry * dt; d.az += d.rz * dt;
      d.smoke -= dt;
      if (d.smoke <= 0 && d.life > 0.6) {
        d.smoke = 0.06;
        this.particle({ x: d.x, y: d.y, z: d.z, vx: 0, vy: 0, vz: 0, life: 0.9, max: 0.9, size: 1.4 * d.s, r: 0.9, g: 0.45, b: 0.2, drag: 1 });
      }
    }
    for (const d of this.shards) {
      const sc = d.s * Math.min(1, d.life * 2);
      this.m.makeRotationFromEuler(this.e.set(d.ax, d.ay, d.az)).scale(this.dir.set(sc, sc * 0.6, sc * 1.4)).setPosition(d.x - origin.x, d.y - origin.y, d.z - origin.z);
      this.shardMesh.setMatrixAt(ns++, this.m);
    }
    this.shardMesh.count = ns;
    this.shardMesh.instanceMatrix.needsUpdate = true;

    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.life -= dt;
      if (f.life <= 0) {
        f.sprite.removeFromParent();
        f.sprite.material.dispose();
        this.flashes.splice(i, 1);
        continue;
      }
      const t = f.life / f.max;
      f.sprite.position.set(f.x - origin.x, f.y - origin.y, f.z - origin.z);
      f.sprite.scale.setScalar(f.size * (1 + f.grow - t * f.grow));
      f.sprite.material.opacity = t;
    }
  }
}
