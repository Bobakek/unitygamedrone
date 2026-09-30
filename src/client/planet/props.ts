import * as THREE from 'three';
import type { PlanetDef } from '../../shared/galaxy/system-gen.ts';
import { nodesNear, type ResourceNode, type ResourceType } from '../../shared/planet/resources.ts';
import { PROP_STRIDE } from '../../shared/planet/prop-rules.ts';
import { v3, type V3 } from '../../shared/math/vec.ts';
import type { WorkerPool } from './worker-pool.ts';
import { kitGeometries, type KindGeo } from './prop-kits.ts';

const windU = { uTime: { value: 0 } };
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

  constructor(private tier: 'big' | 'small', private cap: number, private rebuildDist: number) {}

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
    const rel = v3(cam.x - planet.center.x, cam.y - planet.center.y, cam.z - planet.center.z);
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
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), qy = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(), c = new THREE.Color();
    const Y = new THREE.Vector3(0, 1, 0);
    const counts = this.meshes.map(() => 0);
    const n = data.length / PROP_STRIDE;
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
      counts[ki]++;
    }
    this.meshes.forEach((km, i) => {
      km.solid.count = counts[i];
      km.solid.instanceMatrix.needsUpdate = true;
      if (km.solid.instanceColor) km.solid.instanceColor.needsUpdate = true;
      if (km.glow) { km.glow.count = counts[i]; km.glow.instanceMatrix.needsUpdate = true; }
    });
  }

  sync(origin: V3) {
    const pl = this.planet;
    if (!pl) return;
    this.group.position.set(pl.center.x + this.anchorRel.x - origin.x, pl.center.y + this.anchorRel.y - origin.y, pl.center.z + this.anchorRel.z - origin.z);
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
  private nodes: THREE.InstancedMesh;
  private beams: THREE.InstancedMesh;
  private nodeGroup = new THREE.Group();
  private planet: PlanetDef | null = null;
  private lastNodes = v3(1e12, 0, 0);
  private nodeAnchor = v3();
  private harvestVersion = -1;
  visibleNodes: (ResourceNode & { pos: V3 })[] = [];

  constructor(private pool: WorkerPool) {
    this.nodes = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.6, 0), nodeMat, 200);
    this.beams = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.35, 0.35, 1, 6, 1, true), beamMat, 200);
    for (const m of [this.nodes, this.beams]) {
      m.count = 0;
      m.frustumCulled = false;
      this.nodeGroup.add(m);
    }
    this.group.add(this.big.group, this.small.group, this.nodeGroup);
  }

  clear() {
    this.planet = null;
    this.big.clear();
    this.small.clear();
    this.nodes.count = 0;
    this.beams.count = 0;
    this.visibleNodes = [];
  }

  /** `cam` = camera world position; `harvested` = "planet:node" keys; bump `version` after harvesting. */
  update(planet: PlanetDef | null, cam: V3, harvested: Set<string>, version: number, time: number, quality: { props: boolean; small: boolean }) {
    windU.uTime.value = time;
    if (!planet) { if (this.planet) this.clear(); return; }
    if (planet !== this.planet) { this.planet = planet; this.lastNodes = v3(1e12, 0, 0); }
    if (quality.props) this.big.update(planet, cam, this.pool);
    if (quality.small) this.small.update(planet, cam, this.pool);
    this.big.group.visible = quality.props;
    this.small.group.visible = quality.small;

    const moved = Math.hypot(cam.x - this.lastNodes.x, cam.y - this.lastNodes.y, cam.z - this.lastNodes.z);
    if (moved < 60 && version === this.harvestVersion) return;
    this.lastNodes = { ...cam };
    this.harvestVersion = version;
    this.nodeAnchor = { ...cam };
    const d = v3(cam.x - planet.center.x, cam.y - planet.center.y, cam.z - planet.center.z);
    const len = Math.hypot(d.x, d.y, d.z);
    d.x /= len; d.y /= len; d.z /= len;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(), c = new THREE.Color();
    const Y = new THREE.Vector3(0, 1, 0);
    let nn = 0;
    this.visibleNodes = [];
    for (const node of nodesNear(planet, d, 500)) {
      if (harvested.has(`${planet.index}:${node.id}`) || nn >= 200) continue;
      const r = planet.radius + node.h;
      const pos = v3(planet.center.x + node.dir.x * r, planet.center.y + node.dir.y * r, planet.center.z + node.dir.z * r);
      this.visibleNodes.push({ ...node, pos });
      up.set(node.dir.x, node.dir.y, node.dir.z);
      q.setFromUnitVectors(Y, up);
      p.set(pos.x - cam.x, pos.y - cam.y, pos.z - cam.z);
      const sc = node.type === 'crystal' ? s.set(0.8, 2.4, 0.8) : node.type === 'relic' ? s.set(1.2, 1.2, 1.2) : s.set(1.3, 1, 1.3);
      m.compose(p.clone().addScaledVector(up, sc.y * 0.5), q, sc);
      this.nodes.setMatrixAt(nn, m);
      this.nodes.setColorAt(nn, NODE_COLORS[node.type]);
      m.compose(p.clone().addScaledVector(up, 20), q, s.set(1, 40, 1));
      this.beams.setMatrixAt(nn, m);
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

  /** Place the groups relative to the floating origin. */
  sync(origin: V3) {
    this.big.sync(origin);
    this.small.sync(origin);
    this.nodeGroup.position.set(this.nodeAnchor.x - origin.x, this.nodeAnchor.y - origin.y, this.nodeAnchor.z - origin.z);
  }
}

