import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { AsteroidField, GateDef, StationDef } from '../../shared/galaxy/system-gen.ts';
import { fbm, noiseFor } from '../../shared/math/noise.ts';
import { add, newParts } from '../entities/ship-builder.ts';
import { LOGDEPTH_FS, LOGDEPTH_FS_PARS, LOGDEPTH_VS, LOGDEPTH_VS_PARS } from './textures.ts';

const solidMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.75, metalness: 0.1 });
const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });

function meshes(parts: ReturnType<typeof newParts>): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  if (parts.hull.length) {
    const m = new THREE.Mesh(mergeGeometries(parts.hull)!, solidMat);
    m.receiveShadow = true;
    out.push(m);
  }
  if (parts.glow.length) out.push(new THREE.Mesh(mergeGeometries(parts.glow)!, glowMat));
  return out;
}

/** Low-poly orbital station: spinning habitat ring, hub, docking bay, solar wings. */
export class StationView {
  readonly group = new THREE.Group();
  private ring = new THREE.Group();

  constructor(public def: StationDef, facing: THREE.Vector3) {
    const p = newParts();
    add(p, new THREE.CylinderGeometry(40, 40, 170, 10).rotateX(Math.PI / 2), '#cfcabe', false);
    add(p, new THREE.CylinderGeometry(28, 40, 30, 10).rotateX(Math.PI / 2), '#9aa0a8', false, [0, 0, 100]);
    add(p, new THREE.BoxGeometry(78, 46, 34), '#8a8f99', false, [0, 0, -95]);
    add(p, new THREE.BoxGeometry(60, 30, 4), '#141824', false, [0, 0, -112.5]);
    for (const [x, y, w, h] of [[0, 17, 62, 2], [0, -17, 62, 2], [31, 0, 2, 34], [-31, 0, 2, 34]]) add(p, new THREE.BoxGeometry(w, h, 2), '#8ff8ff', true, [x, y, -113.5]);
    for (const s of [-1, 1]) {
      add(p, new THREE.BoxGeometry(110, 4, 4), '#9aa0a8', false, [s * 95, 0, 70]);
      add(p, new THREE.BoxGeometry(150, 1.5, 44), '#2f4f8f', false, [s * 200, 0, 70]);
      add(p, new THREE.BoxGeometry(152, 2, 3), '#cfcabe', false, [s * 200, 0, 92]);
      add(p, new THREE.BoxGeometry(152, 2, 3), '#cfcabe', false, [s * 200, 0, 48]);
    }
    add(p, new THREE.CylinderGeometry(2, 2, 90, 5).rotateX(Math.PI / 2), '#9aa0a8', false, [0, 0, 160]);
    add(p, new THREE.SphereGeometry(3, 5, 3), '#ff3040', true, [0, 0, 206]);
    for (const o of meshes(p)) this.group.add(o);

    const r = newParts();
    add(r, new THREE.TorusGeometry(155, 16, 6, 24), '#e6e1d4', false);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      add(r, new THREE.BoxGeometry(8, 110, 8), '#b8b3a8', false, [Math.cos(a) * 95, Math.sin(a) * 95, 0], [0, 0, a - Math.PI / 2]);
    }
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      add(r, new THREE.BoxGeometry(10, 4, 2), i % 6 === 0 ? '#ffcf6b' : '#8ff8ff', true, [Math.cos(a) * 155, Math.sin(a) * 155, 16.5], [0, 0, a + Math.PI / 2]);
    }
    for (const o of meshes(r)) this.ring.add(o);
    this.group.add(this.ring);
    // Docking bay (local -Z) faces `facing`.
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), facing.clone().normalize());
  }

  update(dt: number) {
    this.ring.rotation.z += dt * 0.06;
  }
}

const GATE_FS = `uniform float t; uniform vec3 c; varying vec2 vUv;
${LOGDEPTH_FS_PARS}
void main(){
${LOGDEPTH_FS}
  vec2 p = vUv*2.0-1.0; float r = length(p); float a = atan(p.y,p.x);
  float sw = 0.5+0.5*sin(a*6.0 - r*14.0 + t*2.5);
  float k = smoothstep(1.0,0.2,r) * (0.25 + 0.5*sw);
  gl_FragColor = vec4(c*k, 1.0); }`;
const GATE_VS = `varying vec2 vUv;
${LOGDEPTH_VS_PARS}
void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);
${LOGDEPTH_VS}
}`;

/** Jump gate: ring + animated event-horizon disc. */
export class GateView {
  readonly group = new THREE.Group();
  private u = { t: { value: 0 }, c: { value: new THREE.Color('#6fd8ff').multiplyScalar(1.4) } };
  constructor(public def: GateDef, facing: THREE.Vector3) {
    const p = newParts();
    add(p, new THREE.TorusGeometry(140, 13, 6, 18), '#8a8f99', false);
    add(p, new THREE.TorusGeometry(126, 2.5, 4, 36), '#8ff8ff', true);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      add(p, new THREE.BoxGeometry(22, 34, 30), '#5a606a', false, [Math.cos(a) * 150, Math.sin(a) * 150, 0], [0, 0, a]);
      add(p, new THREE.SphereGeometry(4, 5, 3), '#ffcf6b', true, [Math.cos(a) * 168, Math.sin(a) * 168, 0]);
    }
    for (const o of meshes(p)) this.group.add(o);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(124, 48), new THREE.ShaderMaterial({ uniforms: this.u, vertexShader: GATE_VS, fragmentShader: GATE_FS, side: THREE.DoubleSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.group.add(disc);
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), facing.clone().normalize());
  }
  update(dt: number) {
    this.u.t.value += dt;
  }
}

function rockGeometry(seed: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const n = noiseFor(seed);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    const d = 1 + 0.38 * fbm(n, v.x * 1.4, v.y * 1.4, v.z * 1.4, 3);
    p.setXYZ(i, v.x * d, v.y * d * 0.8, v.z * d);
  }
  g.computeVertexNormals();
  return g;
}

let rockGeos: THREE.BufferGeometry[] | null = null;
export function rockGeometries() {
  if (!rockGeos) rockGeos = [11, 23, 37, 51].map(rockGeometry);
  return rockGeos;
}
const rockMat = new THREE.MeshStandardMaterial({ color: '#ffffff', flatShading: true, roughness: 0.95 });

/** Instanced asteroid field (positions relative to the field centre for float precision). */
export class FieldView {
  readonly group = new THREE.Group();
  constructor(public def: AsteroidField) {
    const geos = rockGeometries();
    const buckets: number[][] = geos.map(() => []);
    def.rocks.forEach((r, i) => buckets[r.seed % geos.length].push(i));
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), pp = new THREE.Vector3(), c = new THREE.Color();
    buckets.forEach((idx, gi) => {
      if (!idx.length) return;
      const im = new THREE.InstancedMesh(geos[gi], rockMat, idx.length);
      idx.forEach((ri, k) => {
        const r = def.rocks[ri];
        e.set((r.seed % 628) / 100, (r.seed % 314) / 50, (r.seed % 97) / 30);
        m.compose(pp.set(r.x - def.center.x, r.y - def.center.y, r.z - def.center.z), q.setFromEuler(e), s.setScalar(r.r));
        im.setMatrixAt(k, m);
        c.setHSL(0.07 + (r.seed % 7) * 0.006, 0.12, 0.3 + (r.seed % 11) * 0.015);
        im.setColorAt(k, c);
      });
      im.computeBoundingSphere();
      this.group.add(im);
    });
  }
}
