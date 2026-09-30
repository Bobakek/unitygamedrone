import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { PlanetDef } from '../../shared/galaxy/system-gen.ts';
import { nodesNear, propsNear, type ResourceNode, type ResourceType } from '../../shared/planet/resources.ts';
import { v3, type V3 } from '../../shared/math/vec.ts';
import { add, newParts } from '../entities/ship-builder.ts';
import { rockGeometries } from '../world/structures.ts';

function treeGeometry(kind: 'pine' | 'mushroom'): THREE.BufferGeometry {
  const p = newParts();
  if (kind === 'pine') {
    add(p, new THREE.CylinderGeometry(0.3, 0.4, 2.4, 5), '#6b4a2f', false, [0, 0.9, 0]);
    add(p, new THREE.ConeGeometry(2, 5.5, 6), '#ffffff', false, [0, 4.6, 0]);
  } else {
    add(p, new THREE.CylinderGeometry(0.35, 0.5, 3.6, 6), '#f6e7c8', false, [0, 1.6, 0]);
    add(p, new THREE.SphereGeometry(1.8, 8, 5), '#ffffff', false, [0, 3.5, 0], [0, 0, 0], [1, 0.5, 1]);
  }
  return mergeGeometries(p.hull)!;
}

const propMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 });
const rockMat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.95 });
const NODE_COLORS: Record<ResourceType, THREE.Color> = {
  ore: new THREE.Color(1.7, 0.75, 0.3),
  crystal: new THREE.Color(0.45, 1.9, 2.3),
  relic: new THREE.Color(2.2, 1.5, 0.4),
};
const nodeMat = new THREE.MeshBasicMaterial({ toneMapped: false });
const beamMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });

const TREE_PALETTE: Record<string, string[]> = {
  terran: ['#2f6b3a', '#3f7f45', '#4f8f3a'],
  ocean: ['#2f7f4a', '#3a8f5a', '#5a9f3a'],
  alien: ['#2ee6c9', '#ff7ab8', '#b98cff'],
};

/**
 * Near-surface decoration (trees, rocks) and harvestable resource nodes,
 * rebuilt as instanced meshes around the player when they move far enough.
 */
export class SurfaceProps {
  readonly group = new THREE.Group();
  private trees: THREE.InstancedMesh;
  private rocks: THREE.InstancedMesh;
  private nodes: THREE.InstancedMesh;
  private beams: THREE.InstancedMesh;
  private treeKind: 'pine' | 'mushroom' | null = null;
  private planet: PlanetDef | null = null;
  private last = v3(1e12, 0, 0);
  /** World-space anchor that instance matrices are relative to. */
  readonly anchor = v3();
  visibleNodes: (ResourceNode & { pos: V3 })[] = [];
  private harvestVersion = -1;

  constructor() {
    this.trees = new THREE.InstancedMesh(treeGeometry('pine'), propMat, 1600);
    this.rocks = new THREE.InstancedMesh(rockGeometries()[1], rockMat, 700);
    this.nodes = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.6, 0), nodeMat, 200);
    this.beams = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.35, 0.35, 1, 6, 1, true), beamMat, 200);
    for (const m of [this.trees, this.rocks, this.nodes, this.beams]) {
      m.count = 0;
      m.frustumCulled = false;
      this.group.add(m);
    }
    this.trees.castShadow = true;
    this.rocks.castShadow = true;
    this.rocks.receiveShadow = true;
  }

  clear() {
    this.planet = null;
    for (const m of [this.trees, this.rocks, this.nodes, this.beams]) m.count = 0;
    this.visibleNodes = [];
  }

  /**
   * @param cam camera world position; @param harvested set of "planet:node" keys;
   * @param version bump to force a node refresh after harvesting.
   */
  update(planet: PlanetDef | null, cam: V3, harvested: Set<string>, version: number) {
    if (!planet) { if (this.planet) this.clear(); return; }
    const moved = (cam.x - this.last.x) ** 2 + (cam.y - this.last.y) ** 2 + (cam.z - this.last.z) ** 2;
    if (planet === this.planet && moved < 70 * 70 && version === this.harvestVersion) return;
    const planetChanged = planet !== this.planet;
    this.planet = planet;
    this.harvestVersion = version;
    const d = v3(cam.x - planet.center.x, cam.y - planet.center.y, cam.z - planet.center.z);
    const len = Math.hypot(d.x, d.y, d.z);
    d.x /= len; d.y /= len; d.z /= len;
    const doProps = planetChanged || moved >= 70 * 70;
    this.last = { ...cam };
    this.anchor.x = cam.x; this.anchor.y = cam.y; this.anchor.z = cam.z;

    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), q2 = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0), c = new THREE.Color();
    const place = (dir: V3, h: number) => {
      const r = planet.radius + h;
      p.set(planet.center.x + dir.x * r - cam.x, planet.center.y + dir.y * r - cam.y, planet.center.z + dir.z * r - cam.z);
      up.set(dir.x, dir.y, dir.z);
      q.setFromUnitVectors(Y, up);
    };

    if (doProps) {
      const kind = planet.type === 'alien' ? 'mushroom' : 'pine';
      if (kind !== this.treeKind) {
        this.trees.geometry.dispose();
        this.trees.geometry = treeGeometry(kind);
        this.treeKind = kind;
      }
      const pal = TREE_PALETTE[planet.type] ?? TREE_PALETTE.terran;
      let nt = 0, nr = 0;
      for (const pr of propsNear(planet, d, 650)) {
        place(pr.dir, pr.h - 0.3);
        q.multiply(q2.setFromAxisAngle(Y, pr.rot));
        if (pr.kind === 0 && nt < 1600) {
          m.compose(p, q, s.setScalar(pr.scale));
          this.trees.setMatrixAt(nt, m);
          this.trees.setColorAt(nt, c.set(pal[pr.id % pal.length]));
          nt++;
        } else if (pr.kind === 1 && nr < 700) {
          m.compose(p, q, s.setScalar(pr.scale * 1.4));
          this.rocks.setMatrixAt(nr, m);
          this.rocks.setColorAt(nr, c.setHSL(0.08, 0.1, 0.32 + (pr.id % 7) * 0.02));
          nr++;
        }
      }
      this.trees.count = nt;
      this.rocks.count = nr;
      this.trees.instanceMatrix.needsUpdate = true;
      this.rocks.instanceMatrix.needsUpdate = true;
      if (this.trees.instanceColor) this.trees.instanceColor.needsUpdate = true;
      if (this.rocks.instanceColor) this.rocks.instanceColor.needsUpdate = true;
    } else {
      // Keep the prop anchor where the props were built.
      this.anchor.x = this.propAnchor.x; this.anchor.y = this.propAnchor.y; this.anchor.z = this.propAnchor.z;
    }
    if (doProps) this.propAnchor = { ...this.anchor };

    let nn = 0;
    this.visibleNodes = [];
    const a = this.anchor;
    for (const node of nodesNear(planet, d, 500)) {
      if (harvested.has(`${planet.index}:${node.id}`) || nn >= 200) continue;
      const r = planet.radius + node.h;
      const pos = v3(planet.center.x + node.dir.x * r, planet.center.y + node.dir.y * r, planet.center.z + node.dir.z * r);
      this.visibleNodes.push({ ...node, pos });
      up.set(node.dir.x, node.dir.y, node.dir.z);
      q.setFromUnitVectors(Y, up);
      p.set(pos.x - a.x, pos.y - a.y, pos.z - a.z);
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

  private propAnchor = v3();

  /** Place the group relative to the floating origin. */
  sync(origin: V3) {
    this.group.position.set(this.anchor.x - origin.x, this.anchor.y - origin.y, this.anchor.z - origin.z);
  }
}
