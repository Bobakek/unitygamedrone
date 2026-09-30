import * as THREE from 'three';
import type { PlanetDef } from '../../shared/galaxy/system-gen.ts';
import { nodesNear, type ResourceNode, type ResourceType } from '../../shared/planet/resources.ts';
import { PROP_RULES, PROP_STRIDE, type PropTierName } from '../../shared/planet/prop-rules.ts';
import { qrot, v3, type Quat, type V3 } from '../../shared/math/vec.ts';
import type { WorkerPool } from './worker-pool.ts';
import type { PlanetView } from './planet-view.ts';
import { sphereToCube } from '../../shared/planet/cubesphere.ts';

type ShownNode = ReturnType<PlanetView['shownNodeAt']>;

/**
 * Per-instance data needed to drop a prop onto the terrain as currently drawn:
 * the worker places props on the exact height, but distant terrain is a
 * coarser mesh, so each base is moved along its up vector by the difference.
 */
class GroundSnap {
  n = 0;
  mesh = new Int16Array(0);
  slot = new Int32Array(0);
  base = new Float32Array(0);
  up = new Float32Array(0);
  h = new Float32Array(0);
  cube = new Float32Array(0);
  node: ShownNode[] = [];
  delta = new Float32Array(0);

  reset(cap: number) {
    this.n = 0;
    if (this.slot.length < cap) {
      this.mesh = new Int16Array(cap); this.slot = new Int32Array(cap); this.base = new Float32Array(cap * 3); this.up = new Float32Array(cap * 3);
      this.h = new Float32Array(cap); this.cube = new Float32Array(cap * 3); this.delta = new Float32Array(cap);
    }
    this.node = [];
  }

  push(mesh: number, slot: number, bx: number, by: number, bz: number, ux: number, uy: number, uz: number, h: number, face: number, u: number, v: number) {
    const i = this.n++;
    this.mesh[i] = mesh; this.slot[i] = slot;
    this.base[i * 3] = bx; this.base[i * 3 + 1] = by; this.base[i * 3 + 2] = bz;
    this.up[i * 3] = ux; this.up[i * 3 + 1] = uy; this.up[i * 3 + 2] = uz;
    this.h[i] = h; this.cube[i * 3] = face; this.cube[i * 3 + 1] = u; this.cube[i * 3 + 2] = v;
    this.delta[i] = 0;
    this.node.push(null);
  }

  /**
   * Re-evaluates the ground under every instance and rewrites the translation
   * of changed ones via `write(mesh, slot, x, y, z)`; returns the touched meshes.
   */
  snap(pv: PlanetView, write: (mesh: number, slot: number, x: number, y: number, z: number) => void): Set<number> {
    const touched = new Set<number>();
    const dir = v3();
    for (let i = 0; i < this.n; i++) {
      const face = this.cube[i * 3], u = this.cube[i * 3 + 1], v = this.cube[i * 3 + 2];
      const node = pv.shownNodeAt(face, u, v);
      if (node === this.node[i] && node) continue;
      this.node[i] = node;
      dir.x = this.up[i * 3]; dir.y = this.up[i * 3 + 1]; dir.z = this.up[i * 3 + 2];
      const hr = node ? pv.renderedHeight(face, u, v, dir, node) : null;
      // where this level of detail puts the ground under the sea, the prop would stand in water: sink it out of sight
      // (sea-bed props simply follow the drawn sea bed)
      const d = hr === null ? 0 : pv.def.sea && hr < 0.3 && this.h[i] >= 0 ? -300 : hr - this.h[i];
      if (Math.abs(d - this.delta[i]) < 0.005) continue;
      this.delta[i] = d;
      write(this.mesh[i], this.slot[i], this.base[i * 3] + dir.x * d, this.base[i * 3 + 1] + dir.y * d, this.base[i * 3 + 2] + dir.z * d);
      touched.add(this.mesh[i]);
    }
    return touched;
  }
}
import { kitGeometries, type KindGeo } from './prop-kits.ts';

const windU = { uTime: { value: 0 } };
const tmpV = v3();

/** Places a group whose contents are relative to a body-frame `anchor` of a rotating planet. */
function placeBody(g: THREE.Object3D, pl: PlanetDef, rot: Quat, anchor: V3, origin: V3) {
  qrot(tmpV, rot, anchor);
  g.position.set(pl.center.x + tmpV.x - origin.x, pl.center.y + tmpV.y - origin.y, pl.center.z + tmpV.z - origin.z);
  g.quaternion.set(rot.x, rot.y, rot.z, rot.w);
}
/** Wind sway driven by the per-vertex `aSway` weight and the instance position. */
function withSway<T extends THREE.Material>(m: T, key: string): T {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = windU.uTime;
    sh.vertexShader = 'attribute float aSway;\nuniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vec3 ip = instanceMatrix[3].xyz;
      #else
        vec3 ip = vec3(0.0);
      #endif
      float sw = sin(uTime * 1.7 + ip.x * 0.35 + ip.z * 0.27 + ip.y * 0.19) * 0.6 + sin(uTime * 2.9 + ip.x * 0.8) * 0.25;
      transformed.x += sw * aSway;
      transformed.z += sw * aSway * 0.6;`);
  };
  m.customProgramCacheKey = () => key;
  return m;
}

const solidMat = withSway(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.86 }), 'prop-solid');
const iceMat = withSway(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.86, emissive: '#16324a' }), 'prop-ice');
const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });

const NODE_COLORS: Record<ResourceType, THREE.Color> = {
  ore: new THREE.Color(1.7, 0.75, 0.3),
  crystal: new THREE.Color(0.45, 1.9, 2.3),
  relic: new THREE.Color(2.2, 1.5, 0.4),
};
const nodeMat = new THREE.MeshBasicMaterial({ toneMapped: false });
const beamMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });

interface KindMeshes { solid: THREE.InstancedMesh; glow: THREE.InstancedMesh | null }

/** One tier of decoration (big: trees/rocks far out; small: grass/flowers close by). */
class PropTier {
  readonly group = new THREE.Group();
  private meshes: KindMeshes[] = [];
  private planet: PlanetDef | null = null;
  private last = v3(1e12, 0, 0);
  private pending = false;
  /** Planet-relative anchor of the built instances. */
  private anchorRel = v3();
  private ground = new GroundSnap();
  /** Set when new instances arrived and have not been dropped onto the drawn terrain yet. */
  fresh = false;

  constructor(private tier: PropTierName, private cap: number, private rebuildDist: number) {}

  /** Drops instances onto the currently drawn terrain. */
  snap(pv: PlanetView) {
    if (pv.def !== this.planet) return;
    const touched = this.ground.snap(pv, (mi, slot, x, y, z) => {
      const km = this.meshes[mi];
      for (const im of [km.solid, km.glow]) {
        if (!im) continue;
        const a = im.instanceMatrix.array as Float32Array;
        a[slot * 16 + 12] = x; a[slot * 16 + 13] = y; a[slot * 16 + 14] = z;
      }
    });
    for (const mi of touched) {
      const km = this.meshes[mi];
      km.solid.instanceMatrix.needsUpdate = true;
      if (km.glow) km.glow.instanceMatrix.needsUpdate = true;
    }
  }

  private setKit(planet: PlanetDef) {
    for (const m of this.meshes) {
      m.solid.removeFromParent();
      m.solid.dispose();
      m.glow?.removeFromParent();
      m.glow?.dispose();
    }
    this.meshes = kitGeometries(planet.type)[this.tier].map((k: KindGeo) => {
      const solid = new THREE.InstancedMesh(k.solid, k.ice ? iceMat : solidMat, this.cap);
      solid.count = 0;
      solid.frustumCulled = false;
      solid.castShadow = k.shadow;
      solid.receiveShadow = true;
      this.group.add(solid);
      let glow: THREE.InstancedMesh | null = null;
      if (k.glow) {
        glow = new THREE.InstancedMesh(k.glow, glowMat, this.cap);
        glow.count = 0;
        glow.frustumCulled = false;
        this.group.add(glow);
      }
      return { solid, glow };
    });
  }

  clear() {
    this.planet = null;
    for (const m of this.meshes) { m.solid.count = 0; if (m.glow) m.glow.count = 0; }
    this.last = v3(1e12, 0, 0);
  }

  /** `cam` = camera position in the planet's body frame (planet-relative). */
  update(planet: PlanetDef, cam: V3, pool: WorkerPool) {
    if (planet !== this.planet) {
      if (!this.planet || this.planet.type !== planet.type || !this.meshes.length) this.setKit(planet);
      this.planet = planet;
      this.last = v3(1e12, 0, 0);
      for (const m of this.meshes) { m.solid.count = 0; if (m.glow) m.glow.count = 0; }
    }
    const moved = Math.hypot(cam.x - this.last.x, cam.y - this.last.y, cam.z - this.last.z);
    if (this.pending || moved < this.rebuildDist || pool.free <= 0) return;
    this.pending = true;
    const rel = v3(cam.x, cam.y, cam.z);
    const l = Math.hypot(rel.x, rel.y, rel.z);
    const dir = v3(rel.x / l, rel.y / l, rel.z / l);
    this.last = { ...cam };
    pool.requestProps(planet, dir, this.tier, (data) => {
      this.pending = false;
      if (planet !== this.planet) return;
      this.apply(data, rel);
    });
  }

  private apply(data: Float32Array, anchorRel: V3) {
    this.anchorRel = anchorRel;
    this.fresh = true;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), qy = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(), c = new THREE.Color();
    const Y = new THREE.Vector3(0, 1, 0);
    const counts = this.meshes.map(() => 0);
    const n = data.length / PROP_STRIDE;
    this.ground.reset(n);
    for (let i = 0; i < n; i++) {
      const o = i * PROP_STRIDE;
      const ki = data[o];
      const km = this.meshes[ki];
      if (!km || counts[ki] >= this.cap) continue;
      up.set(data[o + 4], data[o + 5], data[o + 6]);
      q.setFromUnitVectors(Y, up).multiply(qy.setFromAxisAngle(Y, data[o + 7]));
      p.set(data[o + 1] - anchorRel.x, data[o + 2] - anchorRel.y, data[o + 3] - anchorRel.z);
      m.compose(p, q, s.setScalar(data[o + 8]));
      km.solid.setMatrixAt(counts[ki], m);
      km.solid.setColorAt(counts[ki], c.setScalar(data[o + 9]));
      km.glow?.setMatrixAt(counts[ki], m);
      this.ground.push(ki, counts[ki], p.x, p.y, p.z, up.x, up.y, up.z, data[o + 10], data[o + 11], data[o + 12], data[o + 13]);
      counts[ki]++;
    }
    this.meshes.forEach((km, i) => {
      km.solid.count = counts[i];
      km.solid.instanceMatrix.needsUpdate = true;
      if (km.solid.instanceColor) km.solid.instanceColor.needsUpdate = true;
      if (km.glow) { km.glow.count = counts[i]; km.glow.instanceMatrix.needsUpdate = true; }
    });
  }

  sync(origin: V3, rot: Quat) {
    const pl = this.planet;
    if (!pl) return;
    placeBody(this.group, pl, rot, this.anchorRel, origin);
  }
}

/**
 * Near-surface decoration (two instanced tiers built in workers) and
 * harvestable resource nodes with light beacons.
 */
export class SurfaceProps {
  readonly group = new THREE.Group();
  private big = new PropTier('big', 2400, 90);
  private small = new PropTier('small', 1600, 25);
  private sea = new PropTier('sea', 1800, 35);
  private nodes: THREE.InstancedMesh;
  private beams: THREE.InstancedMesh;
  private nodeGroup = new THREE.Group();
  private planet: PlanetDef | null = null;
  private lastNodes = v3(1e12, 0, 0);
  private nodeAnchor = v3();
  private nodeGround = new GroundSnap();
  private lodSeen = -1;
  private lastSnap = -1;
  private nodesFresh = false;
  private harvestVersion = -1;
  /** Nodes near the camera; `pos` is in the planet's body frame. */
  visibleNodes: (ResourceNode & { pos: V3 })[] = [];

  constructor(private pool: WorkerPool) {
    this.nodes = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.6, 0), nodeMat, 200);
    this.beams = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.35, 0.35, 1, 6, 1, true), beamMat, 200);
    for (const m of [this.nodes, this.beams]) {
      m.count = 0;
      m.frustumCulled = false;
      this.nodeGroup.add(m);
    }
    this.group.add(this.big.group, this.small.group, this.sea.group, this.nodeGroup);
  }

  clear() {
    this.planet = null;
    this.nodeGround.reset(0);
    this.big.clear();
    this.small.clear();
    this.sea.clear();
    this.nodes.count = 0;
    this.beams.count = 0;
    this.visibleNodes = [];
  }

  /**
   * `pv` = the planet being walked/flown over; `cam` = camera position in its body frame;
   * `harvested` = "planet:node" keys; bump `version` after harvesting.
   */
  update(pv: PlanetView | null, cam: V3, harvested: Set<string>, version: number, time: number, quality: { props: boolean; small: boolean }) {
    windU.uTime.value = time;
    const planet = pv?.def ?? null;
    if (!pv || !planet) { if (this.planet) this.clear(); return; }
    if (planet !== this.planet) { this.planet = planet; this.lastNodes = v3(1e12, 0, 0); }
    if (quality.props) this.big.update(planet, cam, this.pool);
    if (quality.small) this.small.update(planet, cam, this.pool);
    const wet = !!PROP_RULES[planet.type].sea;
    if (wet && quality.props) this.sea.update(planet, cam, this.pool);
    this.big.group.visible = quality.props;
    this.small.group.visible = quality.small;
    this.sea.group.visible = wet && quality.props;
    this.updateNodes(planet, cam, harvested, version);
    // keep everything standing on the terrain as it is currently drawn (LOD changes, new batches);
    // throttled in wall-clock time so slow frames still re-snap every frame
    const now = performance.now() / 1000;
    const lodChanged = pv.lodVersion !== this.lodSeen && now - this.lastSnap > 0.15;
    if (lodChanged || this.big.fresh || this.small.fresh || this.sea.fresh || this.nodesFresh) {
      this.lodSeen = pv.lodVersion;
      this.lastSnap = now;
      this.big.snap(pv); this.big.fresh = false;
      this.small.snap(pv); this.small.fresh = false;
      this.sea.snap(pv); this.sea.fresh = false;
      this.snapNodes(pv);
    }
  }

  private snapNodes(pv: PlanetView) {
    this.nodesFresh = false;
    const ims = [this.nodes, this.beams];
    const touched = this.nodeGround.snap(pv, (mi, slot, x, y, z) => {
      const a = ims[mi].instanceMatrix.array as Float32Array;
      a[slot * 16 + 12] = x; a[slot * 16 + 13] = y; a[slot * 16 + 14] = z;
    });
    for (const mi of touched) ims[mi].instanceMatrix.needsUpdate = true;
  }

  private updateNodes(planet: PlanetDef, cam: V3, harvested: Set<string>, version: number) {

    const moved = Math.hypot(cam.x - this.lastNodes.x, cam.y - this.lastNodes.y, cam.z - this.lastNodes.z);
    if (moved < 60 && version === this.harvestVersion) return;
    this.lastNodes = { ...cam };
    this.harvestVersion = version;
    this.nodeAnchor = { ...cam };
    const d = v3(cam.x, cam.y, cam.z);
    const len = Math.hypot(d.x, d.y, d.z);
    d.x /= len; d.y /= len; d.z /= len;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(), c = new THREE.Color();
    const Y = new THREE.Vector3(0, 1, 0);
    let nn = 0;
    this.visibleNodes = [];
    this.nodeGround.reset(400);
    this.nodesFresh = true;
    const cube = { face: 0, u: 0, v: 0 };
    for (const node of nodesNear(planet, d, 500)) {
      if (harvested.has(`${planet.index}:${node.id}`) || nn >= 200) continue;
      const r = planet.radius + node.h;
      const pos = v3(node.dir.x * r, node.dir.y * r, node.dir.z * r);
      this.visibleNodes.push({ ...node, pos });
      up.set(node.dir.x, node.dir.y, node.dir.z);
      q.setFromUnitVectors(Y, up);
      p.set(pos.x - cam.x, pos.y - cam.y, pos.z - cam.z);
      const sc = node.type === 'crystal' ? s.set(0.8, 2.4, 0.8) : node.type === 'relic' ? s.set(1.2, 1.2, 1.2) : s.set(1.3, 1, 1.3);
      const np = p.clone().addScaledVector(up, sc.y * 0.5);
      m.compose(np, q, sc);
      this.nodes.setMatrixAt(nn, m);
      this.nodes.setColorAt(nn, NODE_COLORS[node.type]);
      const bp = p.clone().addScaledVector(up, 20);
      m.compose(bp, q, s.set(1, 40, 1));
      this.beams.setMatrixAt(nn, m);
      sphereToCube(node.dir, cube);
      this.nodeGround.push(0, nn, np.x, np.y, np.z, up.x, up.y, up.z, node.h, cube.face, cube.u, cube.v);
      this.nodeGround.push(1, nn, bp.x, bp.y, bp.z, up.x, up.y, up.z, node.h, cube.face, cube.u, cube.v);
      this.beams.setColorAt(nn, c.copy(NODE_COLORS[node.type]).multiplyScalar(0.6));
      nn++;
    }
    this.nodes.count = nn;
    this.beams.count = nn;
    this.nodes.instanceMatrix.needsUpdate = true;
    this.beams.instanceMatrix.needsUpdate = true;
    if (this.nodes.instanceColor) this.nodes.instanceColor.needsUpdate = true;
    if (this.beams.instanceColor) this.beams.instanceColor.needsUpdate = true;
  }

  /** Place the groups relative to the floating origin; `rot` = the planet's current body→world rotation. */
  sync(origin: V3, rot: Quat) {
    this.big.sync(origin, rot);
    this.small.sync(origin, rot);
    this.sea.sync(origin, rot);
    if (this.planet) placeBody(this.nodeGroup, this.planet, rot, this.nodeAnchor, origin);
  }
}

