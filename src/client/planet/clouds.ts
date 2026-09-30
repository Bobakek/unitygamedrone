import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { PlanetDef, PlanetType } from '../../shared/galaxy/system-gen.ts';
import { fbm, noiseFor } from '../../shared/math/noise.ts';
import { hashInts, Rng } from '../../shared/math/rng.ts';

const COVER: Partial<Record<PlanetType, { cover: number; color: string; count: number }>> = {
  terran: { cover: 0.52, color: '#ffffff', count: 520 },
  ocean: { cover: 0.62, color: '#ffffff', count: 620 },
  alien: { cover: 0.5, color: '#ffe6f6', count: 480 },
  desert: { cover: 0.2, color: '#fff2e0', count: 160 },
  ice: { cover: 0.45, color: '#f4f8ff', count: 420 },
  lava: { cover: 0.42, color: '#4a3c3a', count: 420 },
};

let puff: THREE.BufferGeometry | null = null;
/** A flattened cluster of low-poly spheres — one cumulus "puff". */
function puffGeometry(): THREE.BufferGeometry {
  if (puff) return puff;
  const parts: THREE.BufferGeometry[] = [];
  const blobs = [[0, 0, 0, 1], [1.1, -0.15, 0.25, 0.75], [-1.05, -0.1, -0.2, 0.8], [0.35, 0.25, -0.85, 0.7], [-0.4, 0.3, 0.8, 0.65], [0.1, 0.55, 0.1, 0.6]];
  for (const [x, y, z, r] of blobs) {
    const g = new THREE.IcosahedronGeometry(r, 1);
    g.deleteAttribute('uv');
    g.translate(x, y, z);
    parts.push(g);
  }
  puff = mergeGeometries(parts)!;
  puff.scale(1, 0.55, 1);
  puff.computeVertexNormals();
  return puff;
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** Instanced low-poly cloud layer that slowly drifts around the planet. */
export class CloudLayer {
  readonly group = new THREE.Group();
  private mat: THREE.MeshStandardMaterial;
  private drift = 0;
  private qd = new THREE.Quaternion();
  /** World direction from the planet to its star. */
  private sunU = { value: new THREE.Vector3(0, 1, 0) };

  constructor(def: PlanetDef, density = 1) {
    const cfg = COVER[def.type];
    this.mat = new THREE.MeshStandardMaterial({ color: cfg?.color ?? '#ffffff', flatShading: true, roughness: 1, transparent: true, opacity: 0.94, emissive: cfg?.color ?? '#ffffff', emissiveIntensity: 0.32 });
    // The soft self-glow only applies on the day side, so night-side clouds go dark.
    this.mat.onBeforeCompile = (sh) => {
      sh.uniforms.uSun = this.sunU;
      sh.vertexShader = 'uniform vec3 uSun;\nvarying float vDay;\n' + sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
        vec4 cwp = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
        vDay = smoothstep(-0.12, 0.3, dot(normalize(cwp.xyz - modelMatrix[3].xyz), uSun));`);
      sh.fragmentShader = 'varying float vDay;\n' + sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance *= vDay;');
    };
    this.mat.customProgramCacheKey = () => 'cloud-daylit';
    if (!cfg || !def.atmo) return;
    const count = Math.round(cfg.count * density);
    const im = new THREE.InstancedMesh(puffGeometry(), this.mat, count);
    const rng = new Rng(hashInts(def.seed, 0xc10d));
    const n = noiseFor(def.seed + 99);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), qy = new THREE.Quaternion(), p = new THREE.Vector3(), up = new THREE.Vector3(), s = new THREE.Vector3();
    const Y = new THREE.Vector3(0, 1, 0);
    const base = def.radius + def.maxHeight * 1.35 + def.radius * 0.02;
    let k = 0;
    for (let tries = 0; tries < count * 12 && k < count; tries++) {
      up.set(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1));
      if (up.lengthSq() > 1 || up.lengthSq() < 0.01) continue;
      up.normalize();
      const c = fbm(n, up.x * 2.2, up.y * 2.2, up.z * 2.2, 4) * 0.5 + 0.5;
      if (c < 1 - cfg.cover * 0.9 || Math.abs(up.y) > 0.93) continue;
      const size = def.radius * rng.range(0.014, 0.034) * (0.6 + c);
      p.copy(up).multiplyScalar(base + rng.range(0, def.radius * 0.015));
      q.setFromUnitVectors(Y, up).multiply(qy.setFromAxisAngle(Y, rng.range(0, Math.PI * 2)));
      m.compose(p, q, s.set(size, size * rng.range(0.7, 1.1), size * rng.range(0.8, 1.3)));
      im.setMatrixAt(k++, m);
    }
    im.count = k;
    im.computeBoundingSphere();
    this.group.add(im);
  }

  /** `spin` = the planet's body→world rotation; clouds ride it and drift slowly on top. */
  update(dt: number, fade: number, spin: THREE.Quaternion, toSun: { x: number; y: number; z: number }) {
    this.sunU.value.set(toSun.x, toSun.y, toSun.z);
    this.drift += dt * 0.0025;
    this.group.quaternion.copy(spin).multiply(this.qd.setFromAxisAngle(Y_AXIS, this.drift));
    this.mat.opacity = 0.94 * fade;
    this.group.visible = fade > 0.02;
  }
}
