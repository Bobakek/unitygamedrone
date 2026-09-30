import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Poi } from '../../shared/events.ts';
import { Rng } from '../../shared/math/rng.ts';
import { add, newParts, taperedBox } from '../entities/ship-builder.ts';
import { glowTexture } from './textures.ts';
import { LOGDEPTH_FS, LOGDEPTH_FS_PARS, LOGDEPTH_VS, LOGDEPTH_VS_PARS } from './textures.ts';

const hullMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.7, metalness: 0.25 });
const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });

function sprite(color: THREE.Color, size: number): THREE.Sprite {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
  s.scale.setScalar(size);
  return s;
}

export interface PoiView { readonly group: THREE.Group; update(dt: number, time: number, poi: Poi): void; dispose(): void }

/** Derelict hull torn into pieces, drifting debris, fires and a blinking distress beacon. */
export class WreckView implements PoiView {
  readonly group = new THREE.Group();
  private body = new THREE.Group();
  private fires: THREE.Sprite[] = [];
  private beacon: THREE.Sprite;
  private spin: THREE.Vector3;

  constructor(poi: Poi) {
    const r = new Rng(poi.seed);
    const p = newParts();
    const hull = r.pick(['#8a8478', '#7a7f86', '#8a7466']), dark = '#2e2a28', accent = r.pick(['#3a6ab0', '#b04a3a', '#c8a030']);
    // bow and stern sections broken apart at an angle
    add(p, taperedBox(12, 9, 30, 0.45, 1, 0.6), hull, false, [0, 0, 22], [0.1, 0.25, 0.3]);
    add(p, new THREE.BoxGeometry(9, 7, 22), hull, false, [3, -6, -14], [-0.35, -0.2, 0.9]);
    add(p, new THREE.BoxGeometry(12.5, 1.2, 8), dark, false, [0.5, -1, 7], [0.2, 0.3, 0.2]);
    add(p, new THREE.BoxGeometry(6, 1.5, 3), accent, false, [0, 5, 20], [0.1, 0.25, 0.3]);
    add(p, new THREE.BoxGeometry(5.5, 0.6, 0.4), '#ffd27a', 'glass', [0, 3.4, 36], [-0.3, 0.25, 0.3]);
    // exposed girders and torn plates
    for (let i = 0; i < 9; i++) {
      add(p, new THREE.BoxGeometry(0.6, 0.6, r.range(6, 14)), '#5a5550', 'metal', [r.range(-6, 6), r.range(-6, 4), r.range(-4, 10)], [r.range(-1, 1), r.range(-1, 1), r.range(-1, 1)]);
    }
    for (let i = 0; i < 6; i++) {
      add(p, new THREE.BoxGeometry(r.range(3, 7), 0.3, r.range(3, 6)), r.chance(0.5) ? hull : dark, false, [r.range(-10, 10), r.range(-8, 8), r.range(-10, 14)], [r.range(-1.5, 1.5), r.range(-1.5, 1.5), r.range(-1.5, 1.5)]);
    }
    // engine stub still glowing faintly
    add(p, new THREE.CylinderGeometry(2.2, 2.6, 4, 7).rotateX(Math.PI / 2), '#3a3538', 'metal', [4, -9, -26], [-0.35, -0.2, 0.9]);
    add(p, new THREE.CylinderGeometry(1.9, 1.9, 0.1, 7).rotateX(Math.PI / 2), '#ff7a3d', true, [4.6, -10.2, -28], [-0.35, -0.2, 0.9], undefined, 0.5);
    const solid = [...p.hull, ...p.metal, ...p.glass];
    this.body.add(new THREE.Mesh(mergeGeometries(solid)!, hullMat));
    if (p.glow.length) this.body.add(new THREE.Mesh(mergeGeometries(p.glow)!, glowMat));
    for (let i = 0; i < 4; i++) {
      const f = sprite(new THREE.Color(2.2, 0.9, 0.3), r.range(3, 6));
      f.position.set(r.range(-6, 6), r.range(-6, 4), r.range(-8, 20));
      this.fires.push(f);
      this.body.add(f);
    }
    this.beacon = sprite(new THREE.Color(3, 0.4, 0.3), 10);
    this.beacon.position.set(0, 8, 24);
    this.body.add(this.beacon);
    // debris cloud
    const deb = new THREE.InstancedMesh(new THREE.TetrahedronGeometry(1, 0), hullMat, 60);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), pos = new THREE.Vector3();
    for (let i = 0; i < 60; i++) {
      pos.set(r.range(-1, 1), r.range(-1, 1), r.range(-1, 1)).normalize().multiplyScalar(r.range(15, 70));
      m.compose(pos, q.setFromEuler(e.set(r.range(0, 6), r.range(0, 6), r.range(0, 6))), s.setScalar(r.range(0.4, 2.2)));
      deb.setMatrixAt(i, m);
      deb.setColorAt(i, new THREE.Color(r.pick([hull, dark, '#5a5550'])));
    }
    this.body.add(deb);
    this.body.scale.setScalar(2.2);
    this.group.add(this.body);
    this.spin = new THREE.Vector3(r.range(-1, 1), r.range(-1, 1), r.range(-1, 1)).normalize();
  }

  update(dt: number, time: number, poi: Poi) {
    this.body.rotateOnAxis(this.spin, dt * 0.02);
    const alive = (poi.charges ?? 0) > 0;
    this.beacon.visible = alive && Math.sin(time * 5) > 0.2;
    this.fires.forEach((f, i) => { f.material.opacity = 0.6 + Math.sin(time * 9 + i * 2.3) * 0.25 + Math.sin(time * 23 + i) * 0.15; });
  }

  dispose() {
    this.group.removeFromParent();
    this.body.traverse((o) => { if (o instanceof THREE.Mesh || o instanceof THREE.InstancedMesh) o.geometry.dispose(); });
  }
}

const SHELL_VS = `varying vec3 vN; varying vec3 vV;
${LOGDEPTH_VS_PARS}
void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv;
${LOGDEPTH_VS}
}`;
const SHELL_FS = `uniform vec3 c; uniform float k; uniform float t; varying vec3 vN; varying vec3 vV;
${LOGDEPTH_FS_PARS}
void main(){
${LOGDEPTH_FS}
float d = abs(dot(vN, vV));
float band = 0.6 + 0.4 * sin(t * 2.0 + vN.y * 9.0 + vN.x * 5.0);
gl_FragColor = vec4(c * pow(1.0 - d, 3.0) * k * band, 1.0); }`;

const ANOMALY_COLORS = ['#b46bff', '#4af0d0', '#7aff6a', '#ff6ad0'];

/** Swirling energy anomaly: bright core, tilted spinning rings, orbiting motes and a faint scan-zone shell. */
export class AnomalyView implements PoiView {
  readonly group = new THREE.Group();
  private rings: THREE.Mesh[] = [];
  private motes: THREE.Points;
  private core: THREE.Sprite;
  private shellU: { c: { value: THREE.Color }; k: { value: number }; t: { value: number } };
  private coreU: { c: { value: THREE.Color }; k: { value: number }; t: { value: number } };

  constructor(poi: Poi) {
    const r = new Rng(poi.seed);
    const col = new THREE.Color(r.pick(ANOMALY_COLORS));
    this.core = sprite(col.clone().multiplyScalar(3), 120);
    this.group.add(this.core);
    this.coreU = { c: { value: col.clone().multiplyScalar(2.2) }, k: { value: 1.4 }, t: { value: 0 } };
    const coreMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(28, 2), new THREE.ShaderMaterial({ uniforms: this.coreU, vertexShader: SHELL_VS, fragmentShader: SHELL_FS, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
    this.group.add(coreMesh);
    for (let i = 0; i < 3; i++) {
      const m = new THREE.MeshBasicMaterial({ color: col.clone().multiplyScalar(1.6 - i * 0.3), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(60 + i * 45, 1.6 + i * 0.6, 4, 48), m);
      ring.rotation.set(r.range(0, 3), r.range(0, 3), 0);
      this.rings.push(ring);
      this.group.add(ring);
    }
    const n = 360;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = r.range(0, Math.PI * 2), rad = r.range(40, poi.radius * 0.95), y = r.range(-1, 1) * rad * 0.35;
      pos[i * 3] = Math.cos(a) * rad; pos[i * 3 + 1] = y; pos[i * 3 + 2] = Math.sin(a) * rad;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.motes = new THREE.Points(g, new THREE.PointsMaterial({ map: glowTexture(), color: col.clone().multiplyScalar(2), size: 9, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.motes.rotation.z = r.range(-0.4, 0.4);
    this.group.add(this.motes);
    this.shellU = { c: { value: col.clone() }, k: { value: 0.2 }, t: { value: 0 } };
    this.group.add(new THREE.Mesh(new THREE.IcosahedronGeometry(poi.radius, 3), new THREE.ShaderMaterial({ uniforms: this.shellU, vertexShader: SHELL_VS, fragmentShader: SHELL_FS, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide })));
  }

  update(dt: number, time: number) {
    this.rings.forEach((r, i) => { r.rotation.x += dt * (0.15 + i * 0.07); r.rotation.y += dt * (0.11 - i * 0.05); });
    this.motes.rotation.y += dt * 0.12;
    const pulse = 1 + Math.sin(time * 2.2) * 0.12 + Math.sin(time * 7.3) * 0.05;
    this.core.scale.setScalar(120 * pulse);
    this.coreU.t.value = time;
    this.shellU.t.value = time;
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => { if (o instanceof THREE.Mesh || o instanceof THREE.Points) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } });
  }
}

let lootGeo: { solid: THREE.BufferGeometry; glow: THREE.BufferGeometry } | null = null;
function lootGeometry() {
  if (lootGeo) return lootGeo;
  const p = newParts();
  add(p, new THREE.BoxGeometry(2.4, 1.6, 1.6), '#8a8f99', false);
  add(p, new THREE.BoxGeometry(2.5, 0.3, 1.7), '#c8a030', false, [0, 0.55, 0]);
  add(p, new THREE.BoxGeometry(2.5, 0.3, 1.7), '#c8a030', false, [0, -0.55, 0]);
  add(p, new THREE.BoxGeometry(0.2, 1.2, 1.7), '#8ff8ff', true, [1.25, 0, 0], undefined, undefined, 1.6);
  add(p, new THREE.BoxGeometry(0.2, 1.2, 1.7), '#8ff8ff', true, [-1.25, 0, 0], undefined, undefined, 1.6);
  lootGeo = { solid: mergeGeometries(p.hull)!, glow: mergeGeometries(p.glow)! };
  return lootGeo;
}

/** Floating cargo container with a pulsing beacon. */
export class LootView {
  readonly group = new THREE.Group();
  private box = new THREE.Group();
  private beacon: THREE.Sprite;
  private phase = Math.random() * 10;

  constructor() {
    const g = lootGeometry();
    this.box.add(new THREE.Mesh(g.solid, hullMat), new THREE.Mesh(g.glow, glowMat));
    this.box.scale.setScalar(1.6);
    this.beacon = sprite(new THREE.Color(0.6, 2.4, 2.8), 14);
    this.group.add(this.box, this.beacon);
  }

  update(dt: number) {
    this.phase += dt;
    this.box.rotation.set(this.phase * 0.4, this.phase * 0.7, 0);
    this.beacon.material.opacity = 0.45 + Math.sin(this.phase * 4) * 0.35;
  }

  dispose() {
    this.group.removeFromParent();
  }
}
