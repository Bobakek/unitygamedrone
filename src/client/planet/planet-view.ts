import * as THREE from 'three';
import type { PlanetDef } from '../../shared/galaxy/system-gen.ts';
import { CHUNK_N, type ChunkData } from '../../shared/planet/chunk-gen.ts';
import { cubeToSphere, maxLevelFor } from '../../shared/planet/cubesphere.ts';
import { v3 } from '../../shared/math/vec.ts';
import type { WorkerPool } from './worker-pool.ts';

const terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0 });
const SPLIT_K = 2.4;

interface QNode {
  face: number; level: number; x: number; y: number;
  dir: THREE.Vector3;
  center: THREE.Vector3;
  size: number;
  children: QNode[] | null;
  mesh: THREE.Mesh | null;
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

  constructor(public def: PlanetDef, private pool: WorkerPool) {
    this.maxLevel = maxLevelFor(def.radius, CHUNK_N, 2.6);
    this.mountain = Math.acos(def.radius / (def.radius + def.maxHeight * 1.2));
    for (let f = 0; f < 6; f++) this.roots.push(this.node(f, 0, 0, 0));
  }

  private node(face: number, level: number, x: number, y: number): QNode {
    const size = 2 / (1 << level);
    const d = cubeToSphere(face, -1 + (x + 0.5) * size, -1 + (y + 0.5) * size, v3());
    const dir = new THREE.Vector3(d.x, d.y, d.z);
    return {
      face, level, x, y, dir, center: dir.clone().multiplyScalar(this.def.radius),
      size: (Math.PI / 4) * this.def.radius * size, children: null, mesh: null, pending: false, disposed: false, lastUsed: 0,
    };
  }

  private culled(n: QNode): boolean {
    if (n.level < 2) return false;
    const ang = Math.acos(Math.max(-1, Math.min(1, this.camDir.dot(n.dir))));
    return ang > this.horizon + this.mountain + (n.size / this.def.radius) * 1.2;
  }

  /** `camRel` = camera position relative to the planet centre (metres). */
  update(camRel: THREE.Vector3) {
    this.frame++;
    this.camRel.copy(camRel);
    const dist = camRel.length();
    this.camDir.copy(camRel).divideScalar(dist || 1);
    this.horizon = dist > this.def.radius ? Math.acos(this.def.radius / dist) : 0;
    this.reqs.length = 0;
    this.nextShown.clear();
    for (const r of this.roots) this.visit(r);
    for (const n of this.shown) if (!this.nextShown.has(n) && n.mesh) n.mesh.visible = false;
    for (const n of this.nextShown) n.mesh!.visible = true;
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
    if (n.level < this.maxLevel && d < n.size * SPLIT_K) {
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
      const m = new THREE.Mesh(g, terrainMat);
      m.position.set(c.cx, c.cy, c.cz);
      m.receiveShadow = true;
      m.visible = false;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      n.center.set(c.cx, c.cy, c.cz);
      n.mesh = m;
      this.group.add(m);
    });
  }

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
    n.mesh = null;
    n.children = null;
  }
}
