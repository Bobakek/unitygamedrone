import * as THREE from 'three';
import type { WeatherKind } from '../../shared/weather.ts';
import { LOGDEPTH_FS, LOGDEPTH_FS_PARS, LOGDEPTH_VS, LOGDEPTH_VS_PARS } from './textures.ts';

const DROPS = 3200;
/** Half-size of the box of precipitation around the camera (m). */
const B = 20;

interface Look {
  /** Fall speed (m/s along -up), share of the wind carried, streak length (s of motion), colour, opacity, point flakes instead of streaks. */
  fall: number; carry: number; streak: number; color: string; alpha: number; flakes: boolean; jitter: number;
}
const LOOKS: Partial<Record<WeatherKind, Look>> = {
  storm: { fall: 16, carry: 0.5, streak: 0.065, color: '#c8d6ec', alpha: 0.6, flakes: false, jitter: 0.5 },
  blizzard: { fall: 2.2, carry: 0.9, streak: 0, color: '#ffffff', alpha: 1, flakes: true, jitter: 2.2 },
  sandstorm: { fall: 0.6, carry: 1.1, streak: 0.1, color: '#e0b070', alpha: 0.7, flakes: false, jitter: 1.6 },
  acid: { fall: 11, carry: 0.5, streak: 0.05, color: '#b4e05a', alpha: 0.5, flakes: false, jitter: 0.6 },
  ash: { fall: 1.4, carry: 0.6, streak: 0, color: '#5a504a', alpha: 0.85, flakes: true, jitter: 1.2 },
};

const STREAK_VS = `attribute float head; uniform vec3 color; uniform float alpha; varying float vA;
${LOGDEPTH_VS_PARS}
void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vA = alpha * head * smoothstep(${B.toFixed(1)}, 3.0, length(mv.xyz)); gl_Position = projectionMatrix * mv;
${LOGDEPTH_VS}
}`;
const STREAK_FS = `uniform vec3 color; varying float vA;
${LOGDEPTH_FS_PARS}
void main(){
${LOGDEPTH_FS}
  gl_FragColor = vec4(color, vA); }`;
const FLAKE_VS = `uniform float scale; uniform float alpha; varying float vA;
${LOGDEPTH_VS_PARS}
void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); float d = -mv.z; vA = alpha * smoothstep(${B.toFixed(1)}, 4.0, length(mv.xyz)) * smoothstep(0.3, 1.2, d);
  gl_PointSize = clamp(0.1 * scale / max(0.3, d), 1.5, 14.0); gl_Position = projectionMatrix * mv;
${LOGDEPTH_VS}
}`;
const FLAKE_FS = `uniform vec3 color; uniform float ember; uniform float time; varying float vA;
${LOGDEPTH_FS_PARS}
void main(){
${LOGDEPTH_FS}
  float d = length(gl_PointCoord - 0.5);
  vec3 c = mix(color, vec3(1.0, 0.45, 0.12) * 2.0, ember * step(0.93, fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5)));
  gl_FragColor = vec4(c, vA * smoothstep(0.5, 0.15, d)); }`;
const BOLT_FS = `uniform float k;
${LOGDEPTH_FS_PARS}
void main(){
${LOGDEPTH_FS}
  gl_FragColor = vec4(vec3(0.85, 0.9, 1.0) * 3.0 * k, 1.0); }`;
const BOLT_VS = `${LOGDEPTH_VS_PARS}
void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
${LOGDEPTH_VS}
}`;

interface Bolt { line: THREE.LineSegments; age: number; mat: THREE.ShaderMaterial; at: { x: number; y: number; z: number } }

/**
 * Weather around the camera: rain, snow, blowing sand, acid rain or falling ash
 * in a box that wraps as the camera moves and leans with the wind, plus
 * lightning bolts and the flash they leave. The camera sits at the render origin.
 */
export class WeatherView {
  readonly group = new THREE.Group();
  private pos = new Float32Array(DROPS * 3);
  private seg = new Float32Array(DROPS * 6);
  private head = new Float32Array(DROPS * 2);
  private streaks: THREE.LineSegments;
  private flakes: THREE.Points;
  private streakMat: THREE.ShaderMaterial;
  private flakeMat: THREE.ShaderMaterial;
  private bolts: Bolt[] = [];
  private seeded = false;
  private last = new THREE.Vector3();
  private v = new THREE.Vector3();
  /** Lightning flash 0..1 (decays), read by the lighting. */
  flash = 0;

  constructor() {
    for (let i = 0; i < DROPS; i++) { this.head[i * 2] = 1; this.head[i * 2 + 1] = 0; }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(this.seg, 3).setUsage(THREE.DynamicDrawUsage));
    sg.setAttribute('head', new THREE.BufferAttribute(this.head, 1));
    this.streakMat = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color() }, alpha: { value: 0 } }, vertexShader: STREAK_VS, fragmentShader: STREAK_FS,
      transparent: true, depthWrite: false,
    });
    this.streaks = new THREE.LineSegments(sg, this.streakMat);
    this.streaks.frustumCulled = false;
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.flakeMat = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color() }, alpha: { value: 0 }, scale: { value: 600 }, ember: { value: 0 }, time: { value: 0 } },
      vertexShader: FLAKE_VS, fragmentShader: FLAKE_FS, transparent: true, depthWrite: false,
    });
    this.flakes = new THREE.Points(fg, this.flakeMat);
    this.flakes.frustumCulled = false;
    this.group.add(this.streaks, this.flakes);
  }

  setViewport(height: number, fov: number) {
    this.flakeMat.uniforms.scale.value = height / (2 * Math.tan((fov * Math.PI) / 360));
  }

  /**
   * `cam` = camera position relative to the planet centre (world axes) — used to keep the
   * box still in the world as the camera moves; `up` = local up, `wind` = wind (world axes, m/s),
   * `light` = how lit the scene is (0..1).
   */
  update(dt: number, kind: WeatherKind, k: number, cam: THREE.Vector3, up: THREE.Vector3, wind: THREE.Vector3, light: number, time: number, origin: { x: number; y: number; z: number }) {
    this.flash = Math.max(0, this.flash - dt * 4);
    this.updateBolts(dt, origin);
    const look = LOOKS[kind];
    const on = !!look && k > 0.02;
    this.streaks.visible = on && !look!.flakes;
    this.flakes.visible = on && look!.flakes;
    if (!on) { this.seeded = false; return; }
    if (!this.seeded) {
      for (let i = 0; i < DROPS * 3; i++) this.pos[i] = (Math.random() - 0.5) * 2 * B;
      this.seeded = true;
      this.last.copy(cam);
    }
    // only a share of the drops fall in a light storm
    const active = Math.floor(DROPS * Math.min(1, 0.15 + k));
    const mv = this.last.sub(cam);
    const v = this.v.copy(up).multiplyScalar(-look.fall).addScaledVector(wind, look.carry);
    for (let i = 0; i < DROPS; i++) {
      const o = i * 3;
      const j = Math.sin(time * 1.7 + i * 12.9) * look.jitter, j2 = Math.cos(time * 1.3 + i * 7.3) * look.jitter;
      let x = this.pos[o] + mv.x + (v.x + j) * dt, y = this.pos[o + 1] + mv.y + (v.y + j2) * dt, z = this.pos[o + 2] + mv.z + (v.z - j) * dt;
      if (x > B) x -= 2 * B; else if (x < -B) x += 2 * B;
      if (y > B) y -= 2 * B; else if (y < -B) y += 2 * B;
      if (z > B) z -= 2 * B; else if (z < -B) z += 2 * B;
      this.pos[o] = x; this.pos[o + 1] = y; this.pos[o + 2] = z;
      const s = i * 6;
      if (i >= active) { this.seg.fill(1e5, s, s + 6); continue; }
      const L = look.streak;
      this.seg[s] = x; this.seg[s + 1] = y; this.seg[s + 2] = z;
      this.seg[s + 3] = x - v.x * L; this.seg[s + 4] = y - v.y * L; this.seg[s + 5] = z - v.z * L;
    }
    this.last.copy(cam);
    const c = new THREE.Color(look.color).multiplyScalar(0.25 + 0.75 * light);
    if (look.flakes) {
      // flakes beyond the active count are parked far away
      for (let i = active; i < DROPS; i++) this.pos[i * 3 + 1] = 1e5;
      this.flakes.geometry.attributes.position.needsUpdate = true;
      this.flakeMat.uniforms.color.value.copy(c);
      this.flakeMat.uniforms.alpha.value = look.alpha * Math.min(1, 0.3 + k);
      this.flakeMat.uniforms.ember.value = kind === 'ash' ? 1 : 0;
      this.flakeMat.uniforms.time.value = time;
    } else {
      this.streaks.geometry.attributes.position.needsUpdate = true;
      this.streakMat.uniforms.color.value.copy(c);
      this.streakMat.uniforms.alpha.value = look.alpha * Math.min(1, 0.3 + k) * (1 + this.flash);
    }
  }

  /** A lightning bolt from the sky down to `at` (world position), `up` = local up, `near` = distance to the camera. */
  bolt(at: { x: number; y: number; z: number }, up: THREE.Vector3, near: number) {
    const ground = new THREE.Vector3();
    const pts: number[] = [];
    const side = new THREE.Vector3(1, 0, 0).cross(up).normalize();
    const side2 = new THREE.Vector3().crossVectors(up, side);
    const H = 420, n = 22;
    let prev = ground.clone().addScaledVector(up, H);
    const branch = (from: THREE.Vector3, len: number, steps: number) => {
      let p = from.clone();
      for (let i = 0; i < steps; i++) {
        const q = p.clone().addScaledVector(up, -len / steps).addScaledVector(side, (Math.random() - 0.5) * 14).addScaledVector(side2, (Math.random() - 0.5) * 14);
        pts.push(p.x, p.y, p.z, q.x, q.y, q.z);
        p = q;
      }
    };
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const p = ground.clone().addScaledVector(up, H * (1 - t));
      if (i < n) p.addScaledVector(side, (Math.random() - 0.5) * 26 * (1 - t * 0.7)).addScaledVector(side2, (Math.random() - 0.5) * 26 * (1 - t * 0.7));
      pts.push(prev.x, prev.y, prev.z, p.x, p.y, p.z);
      if (i > 3 && i < n - 3 && Math.random() < 0.18) branch(p, 60 + Math.random() * 80, 5);
      prev = p;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const mat = new THREE.ShaderMaterial({ uniforms: { k: { value: 1 } }, vertexShader: BOLT_VS, fragmentShader: BOLT_FS, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false });
    const line = new THREE.LineSegments(g, mat);
    line.frustumCulled = false;
    this.group.add(line);
    this.bolts.push({ line, age: 0, mat, at: { ...at } });
    this.flash = Math.max(this.flash, Math.min(1, 1.6 - near / 400));
  }

  private updateBolts(dt: number, origin: { x: number; y: number; z: number }) {
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.age += dt;
      b.line.position.set(b.at.x - origin.x, b.at.y - origin.y, b.at.z - origin.z);
      // a few flickers, then gone
      b.mat.uniforms.k.value = b.age < 0.06 ? 1 : b.age < 0.12 ? 0.25 : b.age < 0.2 ? 0.9 : Math.max(0, 1 - (b.age - 0.2) * 5);
      if (b.age > 0.45) {
        this.group.remove(b.line);
        b.line.geometry.dispose();
        b.mat.dispose();
        this.bolts.splice(i, 1);
      }
    }
  }
}
