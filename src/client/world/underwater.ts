import * as THREE from 'three';
import { LOGDEPTH_FS, LOGDEPTH_FS_PARS, LOGDEPTH_VS, LOGDEPTH_VS_PARS } from './textures.ts';

const SHAFTS = 28;
const MOTES = 420;
const CELL = 7;

const SHAFT_VS = `attribute float fade; varying vec2 vUv; varying float vFade;
${LOGDEPTH_VS_PARS}
void main(){ vUv = uv; vFade = fade; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
${LOGDEPTH_VS}
}`;
const SHAFT_FS = `uniform vec3 color; uniform float time; varying vec2 vUv; varying float vFade;
${LOGDEPTH_FS_PARS}
void main(){
${LOGDEPTH_FS}
  float edge = smoothstep(0.0, 0.5, vUv.x) * smoothstep(1.0, 0.5, vUv.x);
  float len = pow(1.0 - vUv.y, 1.6) * smoothstep(0.0, 0.08, vUv.y);
  float flick = 0.75 + 0.25 * sin(time * 1.3 + vFade * 40.0);
  gl_FragColor = vec4(color * edge * edge * len * vFade * flick, 1.0);
}`;
const MOTE_VS = `uniform float scale; uniform vec3 color; varying float vA;
${LOGDEPTH_VS_PARS}
void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vA = smoothstep(18.0, 4.0, -mv.z); gl_PointSize = max(1.0, 0.05 * scale / max(0.1, -mv.z)); gl_Position = projectionMatrix * mv;
${LOGDEPTH_VS}
}`;
const MOTE_FS = `uniform vec3 color; varying float vA;
${LOGDEPTH_FS_PARS}
void main(){
${LOGDEPTH_FS}
  float d = length(gl_PointCoord - 0.5); gl_FragColor = vec4(color * smoothstep(0.5, 0.1, d) * vA, 1.0); }`;

const hash = (a: number, b: number) => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/**
 * Under-water atmosphere around the camera: sun shafts slanting down from the
 * surface (anchored to a grid on the sea surface so they stay put as you swim)
 * and drifting specks of plankton that show motion and depth.
 */
export class Underwater {
  readonly group = new THREE.Group();
  private shafts: THREE.Mesh;
  private pos = new Float32Array(SHAFTS * 4 * 3);
  private fade = new Float32Array(SHAFTS * 4);
  private shaftMat: THREE.ShaderMaterial;
  private motes: THREE.Points;
  private motePos = new Float32Array(MOTES * 3);
  private moteMat: THREE.ShaderMaterial;
  private seeded = false;
  private e1 = new THREE.Vector3();
  private e2 = new THREE.Vector3();

  constructor() {
    const g = new THREE.BufferGeometry();
    const uv = new Float32Array(SHAFTS * 4 * 2), idx: number[] = [];
    for (let i = 0; i < SHAFTS; i++) {
      uv.set([0, 0, 1, 0, 1, 1, 0, 1], i * 8);
      const o = i * 4;
      idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
    }
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('fade', new THREE.BufferAttribute(this.fade, 1).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(idx);
    this.shaftMat = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color() }, time: { value: 0 } }, vertexShader: SHAFT_VS, fragmentShader: SHAFT_FS,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.shafts = new THREE.Mesh(g, this.shaftMat);
    this.shafts.frustumCulled = false;
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(this.motePos, 3).setUsage(THREE.DynamicDrawUsage));
    this.moteMat = new THREE.ShaderMaterial({
      uniforms: { scale: { value: 600 }, color: { value: new THREE.Color() } }, vertexShader: MOTE_VS, fragmentShader: MOTE_FS,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.motes = new THREE.Points(mg, this.moteMat);
    this.motes.frustumCulled = false;
    this.group.add(this.shafts, this.motes);
    this.group.visible = false;
  }

  setViewport(height: number, fov: number) {
    this.moteMat.uniforms.scale.value = height / (2 * Math.tan((fov * Math.PI) / 360));
  }

  /**
   * `camC` = camera position relative to the planet centre (world axes), `up` its unit
   * vector, `depth` = metres below the surface, `sun` = direction to the sun (world),
   * `tint` = water colour. Camera sits at the render origin.
   */
  update(dt: number, on: boolean, camC: THREE.Vector3, up: THREE.Vector3, depth: number, sun: THREE.Vector3, day: number, tint: THREE.Color, time: number) {
    this.group.visible = on;
    if (!on) { this.seeded = false; return; }
    // tangent basis on the surface above the camera
    const ref = Math.abs(up.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    this.e1.crossVectors(ref, up).normalize();
    this.e2.crossVectors(up, this.e1);
    const a0 = camC.dot(this.e1), b0 = camC.dot(this.e2);
    // shafts: refracted sun direction, pointing down into the water
    const sd = new THREE.Vector3().copy(sun).addScaledVector(up, -sun.dot(up)).multiplyScalar(0.45).addScaledVector(up, -1).normalize();
    const sunUp = Math.max(0, sun.dot(up));
    const k = day * (0.25 + 0.75 * sunUp) * Math.exp(-depth * 0.03);
    this.shaftMat.uniforms.color.value.copy(tint).lerp(new THREE.Color(1, 1, 1), 0.5).multiplyScalar(0.22 * k);
    this.shaftMat.uniforms.time.value = time;
    const ca = Math.floor(a0 / CELL), cb = Math.floor(b0 / CELL);
    const toCam = new THREE.Vector3(), side = new THREE.Vector3(), top = new THREE.Vector3(), bot = new THREE.Vector3();
    let n = 0;
    for (let i = -4; i <= 4 && n < SHAFTS; i++) {
      for (let j = -4; j <= 4 && n < SHAFTS; j++) {
        const ci = ca + i, cj = cb + j;
        if (hash(ci, cj) > 0.38) continue;
        const a = (ci + hash(cj, ci)) * CELL - a0, b = (cj + hash(ci + 7.1, cj - 3.3)) * CELL - b0;
        // a point on the sea surface, relative to the camera
        top.copy(this.e1).multiplyScalar(a).addScaledVector(this.e2, b).addScaledVector(up, depth);
        const len = 24 + hash(ci * 3.1, cj * 1.7) * 26, w = 0.6 + hash(ci * 5.3, cj * 2.9) * 1.8;
        bot.copy(top).addScaledVector(sd, len);
        toCam.copy(top).lerp(bot, 0.4).negate();
        side.crossVectors(sd, toCam).normalize().multiplyScalar(w);
        const o = n * 12;
        this.pos[o] = top.x - side.x; this.pos[o + 1] = top.y - side.y; this.pos[o + 2] = top.z - side.z;
        this.pos[o + 3] = top.x + side.x; this.pos[o + 4] = top.y + side.y; this.pos[o + 5] = top.z + side.z;
        this.pos[o + 6] = bot.x + side.x; this.pos[o + 7] = bot.y + side.y; this.pos[o + 8] = bot.z + side.z;
        this.pos[o + 9] = bot.x - side.x; this.pos[o + 10] = bot.y - side.y; this.pos[o + 11] = bot.z - side.z;
        // fade with horizontal distance so shafts appear and vanish softly at the edge of the grid
        const f = Math.max(0, 1 - Math.hypot(a, b) / (CELL * 4.2)) * (0.5 + 0.5 * hash(ci * 9.7, cj * 4.1));
        this.fade.fill(f, n * 4, n * 4 + 4);
        n++;
      }
    }
    for (; n < SHAFTS; n++) this.fade.fill(0, n * 4, n * 4 + 4);
    this.shafts.geometry.attributes.position.needsUpdate = true;
    this.shafts.geometry.attributes.fade.needsUpdate = true;

    // plankton: a box of specks around the camera, wrapped as it moves, drifting slowly
    const B = 16;
    if (!this.seeded) {
      for (let i = 0; i < MOTES * 3; i++) this.motePos[i] = (Math.random() - 0.5) * 2 * B;
      this.seeded = true;
      this.last.copy(camC);
    }
    const mv = this.last.sub(camC);
    for (let i = 0; i < MOTES; i++) {
      const o = i * 3;
      for (let c = 0; c < 3; c++) {
        let v = this.motePos[o + c] + (c === 0 ? mv.x : c === 1 ? mv.y : mv.z) + Math.sin(time * 0.3 + i * 1.7 + c) * 0.05 * dt;
        if (v > B) v -= 2 * B; else if (v < -B) v += 2 * B;
        this.motePos[o + c] = v;
      }
    }
    this.last.copy(camC);
    this.motes.geometry.attributes.position.needsUpdate = true;
    this.moteMat.uniforms.color.value.copy(tint).lerp(new THREE.Color(1, 1, 1), 0.6).multiplyScalar(0.35 * (0.3 + 0.7 * day));
  }
  private last = new THREE.Vector3();
}
