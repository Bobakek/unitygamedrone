import * as THREE from 'three';
import type { PlanetDef } from '../../shared/galaxy/system-gen.ts';
import { CHUNK_N, meshHeightAt, type ChunkData } from '../../shared/planet/chunk-gen.ts';
import { cubeToSphere, maxLevelFor, sphereToCube } from '../../shared/planet/cubesphere.ts';
import { v3, type V3 } from '../../shared/math/vec.ts';
import type { WorkerPool } from './worker-pool.ts';
import { liquidOf } from '../../shared/planet/terrain.ts';
import { seaBedMaterial, seaUniforms, updateSea, waterMaterial, type SeaUniforms } from './water.ts';

const terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0 });

interface LiquidUniforms { uTime: { value: number }; uPlanet: { value: THREE.Vector3 }; uRotInv: { value: THREE.Matrix3 } }
const m4 = new THREE.Matrix4(), qi = new THREE.Quaternion();

/** Liquid material for lava (glowing, slow faceted waves) and ice sheets; water has its own (water.ts). */
function liquidMaterial(def: PlanetDef, u: LiquidUniforms): THREE.Material {
  let m: THREE.Material;
  let amp = 0.35, speed = 1;
  if (def.type === 'lava') {
    m = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    amp = 0.5; speed = 0.25;
  } else if (def.type === 'ice') {
    m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.25, metalness: 0.05, flatShading: true });
    amp = 0;
  } else {
    m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.8, flatShading: true, depthWrite: false });
  }
  if (amp > 0) {
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = u.uTime;
      sh.uniforms.uPlanet = u.uPlanet;
      sh.uniforms.uRotInv = u.uRotInv;
      sh.vertexShader = `uniform float uTime; uniform vec3 uPlanet; uniform mat3 uRotInv;\n` + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        // waves are anchored to the (rotating) planet body
        vec3 wp = uRotInv * ((modelMatrix * vec4(position, 1.0)).xyz - uPlanet);
        float t = uTime * ${speed.toFixed(2)};
        float w = sin(dot(wp, vec3(0.31, 0.12, 0.27)) + t * 1.3) * 0.5
                + sin(dot(wp, vec3(-0.18, 0.41, 0.09)) * 1.3 - t * 1.7) * 0.3
                + sin(dot(wp, vec3(0.05, -0.22, 0.47)) * 2.1 + t * 2.3) * 0.2;
        transformed += normal * w * ${amp.toFixed(2)};`);
    };
    m.customProgramCacheKey = () => `liquid-${def.type}`;
  }
  return m;
}

interface QNode {
  face: number; level: number; x: number; y: number;
  /** Face-coordinate bounds (u0..u0+span, v0..v0+span). */
  u0: number; v0: number; span: number;
  heights: Float32Array | null;
  dir: THREE.Vector3;
  center: THREE.Vector3;
  size: number;
  children: QNode[] | null;
  mesh: THREE.Mesh | null;
  water: THREE.Mesh | null;
  pending: boolean;
  disposed: boolean;
  lastUsed: number;
}

interface Req { node: QNode; dist: number }

/**
 * Seamless planet: six cube faces, each a quadtree of flat-shaded chunks
 * generated in workers. Chunks split by camera distance and are culled
 * against the horizon, so the same mesh works from orbit to walking height.
 */
export class PlanetView {
  readonly group = new THREE.Group();
  private roots: QNode[] = [];
  private maxLevel: number;
  private frame = 0;
  private shown = new Set<QNode>();
  private nextShown = new Set<QNode>();
  private reqs: Req[] = [];
  private camRel = new THREE.Vector3();
  private camDir = new THREE.Vector3();
  private horizon = 0;
  private mountain: number;
  chunks = 0;
  /** Bumped whenever the set of displayed chunks changes (props re-snap to the ground). */
  lodVersion = 0;
  private liquidU: LiquidUniforms = { uTime: { value: 0 }, uPlanet: { value: new THREE.Vector3() }, uRotInv: { value: new THREE.Matrix3() } };
  private liquid: THREE.Material | null;
  private terrain: THREE.Material = terrainMat;
  /** Sea water uniforms (water worlds only). */
  readonly sea: SeaUniforms | null = null;
  /** Sun direction (world) and daylight at the camera, fed by the game for the water's glow. */
  sun: THREE.Vector3 | null = null;
  day = 1;

  constructor(public def: PlanetDef, private pool: WorkerPool, public splitK = 2.4) {
    if (liquidOf(def) === 'water') {
      this.sea = seaUniforms(def);
      this.liquid = waterMaterial(this.sea);
      this.terrain = seaBedMaterial(terrainMat, this.sea);
    } else this.liquid = def.sea ? liquidMaterial(def, this.liquidU) : null;
    this.maxLevel = maxLevelFor(def.radius, CHUNK_N, 2.6);
    this.mountain = Math.acos(def.radius / (def.radius + def.maxHeight * 1.2));
    for (let f = 0; f < 6; f++) this.roots.push(this.node(f, 0, 0, 0));
  }

  private node(face: number, level: number, x: number, y: number): QNode {
    const size = 2 / (1 << level);
    const d = cubeToSphere(face, -1 + (x + 0.5) * size, -1 + (y + 0.5) * size, v3());
    const dir = new THREE.Vector3(d.x, d.y, d.z);
    return {
      face, level, x, y, u0: -1 + x * size, v0: -1 + y * size, span: size, heights: null, dir, center: dir.clone().multiplyScalar(this.def.radius),
      size: (Math.PI / 4) * this.def.radius * size, children: null, mesh: null, water: null, pending: false, disposed: false, lastUsed: 0,
    };
  }

  private culled(n: QNode): boolean {
    if (n.level < 2) return false;
    const ang = Math.acos(Math.max(-1, Math.min(1, this.camDir.dot(n.dir))));
    return ang > this.horizon + this.mountain + (n.size / this.def.radius) * 1.2;
  }

  /**
   * `camRel` = camera position relative to the planet centre in the planet's body
   * frame (metres). Place and orient `group` before calling.
   */
  update(camRel: THREE.Vector3, time = 0) {
    this.frame++;
    this.liquidU.uTime.value = time;
    this.liquidU.uPlanet.value.copy(this.group.position);
    this.liquidU.uRotInv.value.setFromMatrix4(m4.makeRotationFromQuaternion(qi.copy(this.group.quaternion).invert()));
    if (this.sea) updateSea(this.sea, this.group.quaternion, camRel, time, this.sun, this.day);
    this.camRel.copy(camRel);
    const dist = camRel.length();
    this.camDir.copy(camRel).divideScalar(dist || 1);
    this.horizon = dist > this.def.radius ? Math.acos(this.def.radius / dist) : 0;
    this.reqs.length = 0;
    this.nextShown.clear();
    for (const r of this.roots) this.visit(r);
    let changed = this.shown.size !== this.nextShown.size;
    for (const n of this.shown) {
      if (this.nextShown.has(n) || !n.mesh) continue;
      changed = true;
      n.mesh.visible = false;
      if (n.water) n.water.visible = false;
    }
    if (changed) this.lodVersion++;
    for (const n of this.nextShown) {
      n.mesh!.visible = true;
      if (n.water) n.water.visible = true;
    }
    [this.shown, this.nextShown] = [this.nextShown, this.shown];
    this.chunks = this.shown.size;

    this.reqs.sort((a, b) => a.dist - b.dist);
    this.pump();
    if (this.frame % 60 === 0) for (const r of this.roots) this.prune(r);
  }

  private visit(n: QNode) {
    n.lastUsed = this.frame;
    if (this.culled(n)) return;
    const d = Math.max(0, this.camRel.distanceTo(n.center) - n.size * 0.3);
    if (n.level < this.maxLevel && d < n.size * this.splitK) {
      if (!n.children) {
        const L = n.level + 1, x = n.x * 2, y = n.y * 2;
        n.children = [this.node(n.face, L, x, y), this.node(n.face, L, x + 1, y), this.node(n.face, L, x, y + 1), this.node(n.face, L, x + 1, y + 1)];
      }
      let ready = true;
      for (const c of n.children) {
        if (!c.mesh && !this.culled(c)) {
          ready = false;
          if (!c.pending) this.reqs.push({ node: c, dist: d });
        }
      }
      if (ready) {
        for (const c of n.children) this.visit(c);
        return;
      }
    }
    if (n.mesh) this.nextShown.add(n);
    else if (!n.pending) this.reqs.push({ node: n, dist: d - 1e6 });
  }

  /** Dispatches queued chunk requests while workers are free (also called as jobs finish). */
  private pump() {
    while (this.reqs.length && this.pool.free > 0) {
      const r = this.reqs.shift()!;
      if (r.node.pending || r.node.mesh || r.node.disposed) continue;
      this.load(r.node);
    }
  }

  private load(n: QNode) {
    n.pending = true;
    this.pool.request(this.def, n.face, n.level, n.x, n.y, (c: ChunkData) => {
      n.pending = false;
      queueMicrotask(() => this.pump());
      if (n.disposed || n.lastUsed < this.frame - 240) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(c.positions, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(c.normals, 3));
      g.setAttribute('color', new THREE.BufferAttribute(c.colors, 3));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), c.radius);
      const m = new THREE.Mesh(g, this.terrain);
      m.position.set(c.cx, c.cy, c.cz);
      m.receiveShadow = true;
      // fine chunks near the player cast terrain shadows (hills, cliffs)
      m.castShadow = n.level >= this.maxLevel - 2;
      m.visible = false;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      n.center.set(c.cx, c.cy, c.cz);
      n.heights = c.heights;
      n.mesh = m;
      this.group.add(m);
      if (this.liquid && c.water.positions.length) {
        const wg = new THREE.BufferGeometry();
        wg.setAttribute('position', new THREE.BufferAttribute(c.water.positions, 3));
        wg.setAttribute('normal', new THREE.BufferAttribute(c.water.normals, 3));
        wg.setAttribute('color', new THREE.BufferAttribute(c.water.colors, 3));
        wg.setAttribute('seabed', new THREE.BufferAttribute(c.water.seabed, 1));
        wg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), c.radius + 10);
        const w = new THREE.Mesh(wg, this.liquid);
        w.position.copy(m.position);
        w.visible = false;
        w.matrixAutoUpdate = false;
        w.updateMatrix();
        w.receiveShadow = true;
        n.water = w;
        this.group.add(w);
      }
    });
  }

  /** Displayed chunk covering face coordinates (face, u, v), or null (culled / not loaded). */
  shownNodeAt(face: number, u: number, v: number): QNode | null {
    let n = this.roots[face];
    while (n) {
      if (this.shown.has(n) && n.heights) return n;
      if (!n.children) return null;
      const cx = u >= n.u0 + n.span / 2 ? 1 : 0, cy = v >= n.v0 + n.span / 2 ? 1 : 0;
      n = n.children[cy * 2 + cx];
    }
    return null;
  }

  /** Height of the drawn terrain along `dir` (face coords given), or null when nothing is drawn there. */
  renderedHeight(face: number, u: number, v: number, dir: V3, node = this.shownNodeAt(face, u, v)): number | null {
    if (!node?.heights) return null;
    return meshHeightAt(this.def.radius, face, node.u0, node.v0, node.span, CHUNK_N, node.heights, u, v, dir);
  }

  /** Drawn minus exact terrain height at unit direction `dir` (0 when unknown). */
  groundDelta(dir: V3, exactH: number): number {
    const c = sphereToCube(dir, this.cube);
    const h = this.renderedHeight(c.face, c.u, c.v, dir);
    return h === null ? 0 : h - exactH;
  }
  private cube = { face: 0, u: 0, v: 0 };

  /** Frees subtrees that have not been visited recently. */
  private prune(n: QNode) {
    if (!n.children) return;
    const stale = n.children.every((c) => c.lastUsed < this.frame - 180);
    if (stale) {
      for (const c of n.children) this.dispose(c);
      n.children = null;
    } else for (const c of n.children) this.prune(c);
  }

  private dispose(n: QNode) {
    n.disposed = true;
    if (n.children) for (const c of n.children) this.dispose(c);
    if (n.mesh) {
      n.mesh.geometry.dispose();
      n.mesh.removeFromParent();
      this.shown.delete(n);
    }
    if (n.water) {
      n.water.geometry.dispose();
      n.water.removeFromParent();
    }
    n.mesh = null;
    n.water = null;
    n.heights = null;
    n.children = null;
  }
}
