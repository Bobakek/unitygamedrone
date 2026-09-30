import * as THREE from 'three';
import type { V3 } from '../../shared/math/vec.ts';
import { glowTexture, LOGDEPTH_FS, LOGDEPTH_FS_PARS, LOGDEPTH_VS, LOGDEPTH_VS_PARS } from './textures.ts';

interface Bolt { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; shooter: number; color: THREE.Color; delay: number }
interface Particle { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; max: number; size: number; r: number; g: number; b: number; drag: number }
interface Flash { sprite: THREE.Sprite; x: number; y: number; z: number; life: number; max: number; size: number }

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

  flash(p: V3, color: THREE.Color, size: number, life: number) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: color.clone().multiplyScalar(2), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
    this.group.add(sprite);
    this.flashes.push({ sprite, x: p.x, y: p.y, z: p.z, life, max: life, size });
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
      f.sprite.scale.setScalar(f.size * (1.4 - t * 0.4));
      f.sprite.material.opacity = t;
    }
  }
}
