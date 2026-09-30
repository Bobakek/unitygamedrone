import * as THREE from 'three';
import type { V3 } from '../../shared/math/vec.ts';
import { glowTexture, LOGDEPTH_FS, LOGDEPTH_FS_PARS, LOGDEPTH_VS, LOGDEPTH_VS_PARS, ringTexture } from './textures.ts';

interface Bolt { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; shooter: number; color: THREE.Color; delay: number }
interface Particle { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; max: number; size: number; r: number; g: number; b: number; drag: number }
interface Flash { sprite: THREE.Sprite; x: number; y: number; z: number; life: number; max: number; size: number; grow: number }
interface Shard { x: number; y: number; z: number; vx: number; vy: number; vz: number; ax: number; ay: number; az: number; rx: number; ry: number; rz: number; s: number; life: number; smoke: number }
const MAX_SHARDS = 400;

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
  private shardMesh: THREE.InstancedMesh;
  private e = new THREE.Euler();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private dir = new THREE.Vector3();
  private Z = new THREE.Vector3(0, 0, 1);

  constructor() {
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

  smoke(p: V3) {
    this.particle({ x: p.x, y: p.y, z: p.z, vx: (Math.random() - 0.5) * 3, vy: (Math.random() - 0.5) * 3, vz: (Math.random() - 0.5) * 3, life: 1.2, max: 1.2, size: 2.2, r: 0.5, g: 0.45, b: 0.42, drag: 0.8 });
  }

  update(dt: number, origin: V3) {
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
