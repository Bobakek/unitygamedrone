import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { PlanetType } from '../../shared/galaxy/system-gen.ts';
import { add, newParts, type Parts } from '../entities/ship-builder.ts';
import { rockGeometries } from '../world/structures.ts';

/**
 * Procedural low-poly decoration per planet type. Each kind has a solid
 * geometry (vertex coloured, with an `aSway` attribute for wind) and an
 * optional unlit glow geometry sharing the same instance transforms.
 */
/** Geometry for one prop kind (order matches shared/planet/prop-rules.ts). */
export interface KindGeo {
  solid: THREE.BufferGeometry;
  glow: THREE.BufferGeometry | null;
  shadow: boolean;
  ice: boolean;
}
export interface KitGeometries { big: KindGeo[]; small: KindGeo[]; sea: KindGeo[] }

function finish(p: Parts, sway: number): { solid: THREE.BufferGeometry; glow: THREE.BufferGeometry | null } {
  const solid = mergeGeometries(p.hull)!;
  solid.computeBoundingBox();
  const top = Math.max(0.1, solid.boundingBox!.max.y);
  const pos = solid.getAttribute('position');
  const sw = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.max(0, pos.getY(i) / top);
    sw[i] = sway * t * t;
  }
  solid.setAttribute('aSway', new THREE.BufferAttribute(sw, 1));
  const glow = p.glow.length ? mergeGeometries(p.glow)! : null;
  return { solid, glow };
}

const kg = (build: () => { solid: THREE.BufferGeometry; glow: THREE.BufferGeometry | null }, shadow = true, ice = false): KindGeo => ({ ...build(), shadow, ice });

const rockGeo = (i: number) => rockGeometries()[i % 4];

const G = {
  pine: (greens: string[]) => () => {
    const p = newParts();
    add(p, new THREE.CylinderGeometry(0.28, 0.4, 2.6, 5), '#6b4a2f', false, [0, 1.1, 0]);
    add(p, new THREE.ConeGeometry(2.3, 3.2, 7), greens[0], false, [0, 3.2, 0]);
    add(p, new THREE.ConeGeometry(1.8, 2.8, 7), greens[1], false, [0, 4.6, 0], [0, 0.4, 0]);
    add(p, new THREE.ConeGeometry(1.2, 2.3, 7), greens[2], false, [0, 5.9, 0], [0, 0.8, 0]);
    return finish(p, 0.35);
  },
  broadleaf: (greens: string[]) => () => {
    const p = newParts();
    add(p, new THREE.CylinderGeometry(0.22, 0.36, 3.2, 5), '#7a5536', false, [0, 1.5, 0]);
    add(p, new THREE.CylinderGeometry(0.1, 0.16, 1.6, 4), '#7a5536', false, [0.5, 3.2, 0], [0, 0, -0.7]);
    add(p, new THREE.IcosahedronGeometry(1.9, 0), greens[0], false, [0, 4.4, 0]);
    add(p, new THREE.IcosahedronGeometry(1.4, 0), greens[1], false, [1.2, 3.9, 0.4]);
    add(p, new THREE.IcosahedronGeometry(1.3, 0), greens[2], false, [-0.9, 4.0, -0.7]);
    return finish(p, 0.3);
  },
  palm: () => {
    const p = newParts();
    let x = 0, y = 0;
    for (let i = 0; i < 5; i++) {
      add(p, new THREE.CylinderGeometry(0.2 - i * 0.02, 0.26 - i * 0.02, 1.3, 6), i % 2 ? '#8a6a44' : '#9a7a50', false, [x, y + 0.65, 0], [0, 0, -0.08 * i]);
      x += Math.sin(0.08 * i) * 1.3; y += Math.cos(0.08 * i) * 1.2;
    }
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      add(p, new THREE.ConeGeometry(0.45, 3.2, 3), i % 2 ? '#3f9a45' : '#56b04c', false,
        [x + Math.cos(a) * 1.3, y + 0.1, Math.sin(a) * 1.3], [Math.sin(a) * 1.25, 0, -Math.cos(a) * 1.25], [1, 1, 0.25]);
    }
    add(p, new THREE.IcosahedronGeometry(0.22, 0), '#6b4a2f', false, [x + 0.2, y - 0.2, 0.1]);
    add(p, new THREE.IcosahedronGeometry(0.22, 0), '#6b4a2f', false, [x - 0.1, y - 0.25, -0.2]);
    return finish(p, 0.5);
  },
  bush: (greens: string[]) => () => {
    const p = newParts();
    add(p, new THREE.IcosahedronGeometry(0.9, 0), greens[0], false, [0, 0.6, 0], [0, 0, 0], [1, 0.75, 1]);
    add(p, new THREE.IcosahedronGeometry(0.7, 0), greens[1], false, [0.7, 0.45, 0.2], [0.5, 0, 0], [1, 0.8, 1]);
    add(p, new THREE.IcosahedronGeometry(0.6, 0), greens[2], false, [-0.5, 0.4, -0.4], [0, 0.6, 0], [1, 0.8, 1]);
    return finish(p, 0.2);
  },
  boulder: (color: string, i: number) => () => {
    const p = newParts();
    add(p, rockGeo(i), color, false, [0, 0.35, 0], [0, 0, 0], [1.2, 0.9, 1.1]);
    add(p, rockGeo(i + 1), color, false, [0.9, 0.1, 0.4], [0.4, 1, 0], [0.5, 0.45, 0.5]);
    return finish(p, 0);
  },
  grass: (c1: string, c2: string) => () => {
    const p = newParts();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      add(p, new THREE.ConeGeometry(0.06, 0.7 + (i % 3) * 0.2, 3), i % 2 ? c1 : c2, false, [Math.cos(a) * 0.12, 0.35, Math.sin(a) * 0.12], [Math.sin(a) * 0.3, 0, -Math.cos(a) * 0.3]);
    }
    return finish(p, 0.12);
  },
  flower: (petal: string) => () => {
    const p = newParts();
    add(p, new THREE.CylinderGeometry(0.02, 0.025, 0.55, 3), '#3f7f35', false, [0, 0.27, 0]);
    add(p, new THREE.ConeGeometry(0.05, 0.3, 3), '#4f9a40', false, [0.08, 0.15, 0], [0, 0, -0.6]);
    add(p, new THREE.IcosahedronGeometry(0.12, 0), petal, false, [0, 0.58, 0], [0, 0, 0], [1, 0.5, 1]);
    add(p, new THREE.IcosahedronGeometry(0.05, 0), '#ffe070', false, [0, 0.62, 0]);
    return finish(p, 0.1);
  },
  pebble: (color: string) => () => {
    const p = newParts();
    add(p, rockGeo(2), color, false, [0, 0.05, 0], [0, 0, 0], [0.25, 0.15, 0.2]);
    add(p, rockGeo(3), color, false, [0.3, 0.03, 0.2], [0, 1, 0], [0.15, 0.1, 0.18]);
    return finish(p, 0);
  },
  mushroom: (cap: string, spots: string) => () => {
    const p = newParts();
    add(p, new THREE.CylinderGeometry(0.3, 0.45, 3.4, 6), '#f3e6c8', false, [0, 1.7, 0]);
    add(p, new THREE.IcosahedronGeometry(1.9, 1), cap, false, [0, 3.5, 0], [0, 0, 0], [1, 0.45, 1]);
    for (let i = 0; i < 5; i++) {
      const a = i * 1.3;
      add(p, new THREE.IcosahedronGeometry(0.22, 0), spots, false, [Math.cos(a) * 1.1, 3.95, Math.sin(a) * 1.1]);
    }
    return finish(p, 0.18);
  },
  bulb: () => {
    const p = newParts();
    for (let i = 0; i < 3; i++) {
      const a = i * 2.1, h = 1.6 + i * 0.5;
      add(p, new THREE.CylinderGeometry(0.06, 0.1, h, 4), '#4a2a6a', false, [Math.cos(a) * 0.3, h / 2, Math.sin(a) * 0.3], [Math.sin(a) * 0.15, 0, -Math.cos(a) * 0.15]);
      add(p, new THREE.IcosahedronGeometry(0.28, 0), '#7affe0', true, [Math.cos(a) * 0.45, h + 0.1, Math.sin(a) * 0.45], undefined, undefined, 1.5);
    }
    return finish(p, 0);
  },
  coral: () => {
    const p = newParts();
    for (let i = 0; i < 5; i++) {
      const a = i * 1.26, h = 1.5 + (i % 3) * 0.9;
      add(p, new THREE.ConeGeometry(0.28, h, 5), i % 2 ? '#b064e0' : '#e070b8', false, [Math.cos(a) * 0.5, h / 2, Math.sin(a) * 0.5], [Math.sin(a) * 0.35, 0, -Math.cos(a) * 0.35]);
    }
    return finish(p, 0.08);
  },
  sprout: (c: string) => () => {
    const p = newParts();
    add(p, new THREE.CylinderGeometry(0.02, 0.03, 0.5, 3), '#5a3a7a', false, [0, 0.25, 0]);
    add(p, new THREE.IcosahedronGeometry(0.08, 0), c, true, [0, 0.52, 0], undefined, undefined, 1.8);
    return finish(p, 0);
  },
  cactus: () => {
    const p = newParts();
    add(p, new THREE.CapsuleGeometry(0.35, 3.0, 2, 7), '#4f8a3a', false, [0, 1.8, 0]);
    add(p, new THREE.CapsuleGeometry(0.22, 0.8, 2, 6), '#4f8a3a', false, [0.6, 1.7, 0], [0, 0, Math.PI / 2]);
    add(p, new THREE.CapsuleGeometry(0.22, 1.0, 2, 6), '#5a9a44', false, [0.95, 2.3, 0]);
    add(p, new THREE.CapsuleGeometry(0.2, 0.6, 2, 6), '#4f8a3a', false, [-0.5, 2.3, 0], [0, 0, -Math.PI / 2]);
    add(p, new THREE.CapsuleGeometry(0.2, 0.7, 2, 6), '#5a9a44', false, [-0.75, 2.7, 0]);
    add(p, new THREE.IcosahedronGeometry(0.12, 0), '#ff7aa0', false, [0, 3.55, 0]);
    return finish(p, 0);
  },
  shrub: () => {
    const p = newParts();
    for (let i = 0; i < 6; i++) {
      const a = i * 1.05;
      add(p, new THREE.CylinderGeometry(0.02, 0.04, 0.8, 3), '#8a6a44', false, [Math.cos(a) * 0.15, 0.35, Math.sin(a) * 0.15], [Math.sin(a) * 0.6, 0, -Math.cos(a) * 0.6]);
    }
    return finish(p, 0.05);
  },
  iceSpire: () => {
    const p = newParts();
    for (let i = 0; i < 4; i++) {
      const a = i * 1.7, h = 2.5 + i * 1.3;
      add(p, new THREE.OctahedronGeometry(0.6, 0), i % 2 ? '#bfe6ff' : '#e6f6ff', false, [Math.cos(a) * 0.5, h * 0.45, Math.sin(a) * 0.5], [Math.sin(a) * 0.2, a, -Math.cos(a) * 0.2], [0.8, h, 0.8]);
    }
    return finish(p, 0);
  },
  snowRock: () => {
    const p = newParts();
    add(p, rockGeo(0), '#7890a8', false, [0, 0.3, 0], [0, 0, 0], [1.2, 0.8, 1]);
    add(p, rockGeo(1), '#f4f8ff', false, [0, 0.75, 0], [0, 0.5, 0], [1.05, 0.3, 0.9]);
    return finish(p, 0);
  },
  shard: () => {
    const p = newParts();
    add(p, new THREE.OctahedronGeometry(0.12, 0), '#d8f0ff', false, [0, 0.2, 0], [0.2, 0, 0.3], [1, 3, 1]);
    add(p, new THREE.OctahedronGeometry(0.1, 0), '#bfe6ff', false, [0.2, 0.15, 0.1], [-0.3, 0, 0.2], [1, 2.4, 1]);
    return finish(p, 0);
  },
  mound: () => {
    const p = newParts();
    add(p, new THREE.IcosahedronGeometry(0.5, 0), '#ffffff', false, [0, 0.05, 0], [0, 0, 0], [1.4, 0.35, 1]);
    return finish(p, 0);
  },
  basalt: () => {
    const p = newParts();
    for (let i = 0; i < 6; i++) {
      const a = i * 1.05, r = i === 0 ? 0 : 0.75, h = 2.2 + ((i * 7) % 5) * 0.6;
      add(p, new THREE.CylinderGeometry(0.42, 0.45, h, 6), i % 2 ? '#2e2a2c' : '#3a3436', false, [Math.cos(a) * r, h / 2, Math.sin(a) * r]);
    }
    return finish(p, 0);
  },
  glowRock: () => {
    const p = newParts();
    add(p, rockGeo(1), '#2a2426', false, [0, 0.45, 0], [0, 0, 0], [1.3, 1, 1.2]);
    for (let i = 0; i < 4; i++) {
      const a = i * 1.6;
      add(p, new THREE.OctahedronGeometry(0.25, 0), '#ff6a20', true, [Math.cos(a) * 0.9, 0.35 + (i % 2) * 0.4, Math.sin(a) * 0.8], undefined, [1, 2, 1], 2.2);
    }
    return finish(p, 0);
  },
  // ---- sea bed
  kelp: (c1: string, c2: string) => () => {
    const p = newParts();
    for (let s = 0; s < 4; s++) {
      const a = s * 1.7, r = s ? 0.35 : 0, h = 3.2 + ((s * 5) % 3) * 1.1;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      add(p, new THREE.CylinderGeometry(0.03, 0.05, h, 4), c1, false, [x, h / 2, z]);
      for (let k = 0; k < 6; k++) {
        const y = h * (0.2 + k * 0.13), side = k % 2 ? 1 : -1;
        add(p, new THREE.BoxGeometry(0.02, 0.75, 0.24), k % 2 ? c1 : c2, false, [x + side * 0.13, y, z], [0, a, side * 0.55]);
      }
      add(p, new THREE.SphereGeometry(0.07, 4, 3), c2, false, [x, h * 0.55, z + 0.05]);
    }
    return finish(p, 0.9);
  },
  branchCoral: (c: string, tip: string) => () => {
    const p = newParts();
    add(p, new THREE.CylinderGeometry(0.07, 0.12, 0.5, 5), c, false, [0, 0.25, 0]);
    for (let i = 0; i < 7; i++) {
      const a = i * 0.9, t = 0.35 + (i % 3) * 0.12, len = 0.5 + (i % 4) * 0.12;
      const x = Math.cos(a) * 0.12, z = Math.sin(a) * 0.12, y = 0.35 + (i % 3) * 0.1;
      add(p, new THREE.CylinderGeometry(0.035, 0.06, len, 4), c, false, [x + Math.cos(a) * len * 0.3, y + len * 0.4, z + Math.sin(a) * len * 0.3], [Math.sin(a) * t * 1.5, 0, -Math.cos(a) * t * 1.5]);
      add(p, new THREE.SphereGeometry(0.05, 4, 3), tip, false, [x + Math.cos(a) * len * 0.62, y + len * 0.85, z + Math.sin(a) * len * 0.62]);
    }
    return finish(p, 0.04);
  },
  brainCoral: (c: string, c2: string) => () => {
    const p = newParts();
    add(p, new THREE.IcosahedronGeometry(0.62, 1), c, false, [0, 0.18, 0], [0, 0, 0], [1, 0.6, 1]);
    add(p, new THREE.IcosahedronGeometry(0.4, 1), c2, false, [0.45, 0.12, 0.25], [0.4, 0, 0], [1, 0.55, 1]);
    add(p, new THREE.IcosahedronGeometry(0.28, 0), c2, false, [-0.45, 0.08, -0.3], [0, 0.6, 0], [1, 0.6, 1]);
    return finish(p, 0);
  },
  tubeCoral: (c: string, tip: string) => () => {
    const p = newParts();
    for (let i = 0; i < 8; i++) {
      const a = i * 2.4, r = i ? 0.18 + (i % 3) * 0.1 : 0, h = 0.45 + ((i * 7) % 5) * 0.2;
      add(p, new THREE.CylinderGeometry(0.07, 0.09, h, 6, 1, true), c, false, [Math.cos(a) * r, h / 2, Math.sin(a) * r], [Math.sin(a) * 0.15, 0, -Math.cos(a) * 0.15]);
      add(p, new THREE.TorusGeometry(0.075, 0.025, 3, 6), tip, true, [Math.cos(a) * r * 1.1, h, Math.sin(a) * r * 1.1], [Math.PI / 2, 0, 0], undefined, 1.8);
    }
    return finish(p, 0.05);
  },
  seaRock: (c: string, moss: string) => () => {
    const p = newParts();
    add(p, rockGeo(2), c, false, [0, 0.35, 0], [0, 0, 0], [1.2, 0.9, 1.1]);
    add(p, rockGeo(3), moss, false, [0.1, 0.72, 0], [0, 0.8, 0], [0.95, 0.25, 0.85]);
    return finish(p, 0);
  },
  anemone: (c: string, glow: boolean) => () => {
    const p = newParts();
    add(p, new THREE.CylinderGeometry(0.16, 0.22, 0.3, 7), c, false, [0, 0.15, 0]);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      add(p, new THREE.ConeGeometry(0.03, 0.42, 3), c, glow, [Math.cos(a) * 0.14, 0.45, Math.sin(a) * 0.14], [Math.sin(a) * 0.6, 0, -Math.cos(a) * 0.6], undefined, 1.6);
    }
    return finish(p, 0.18);
  },
  starShells: (star: string, shell: string) => () => {
    const p = newParts();
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      add(p, new THREE.ConeGeometry(0.06, 0.32, 3), star, false, [Math.cos(a) * 0.14, 0.03, Math.sin(a) * 0.14], [Math.PI / 2, 0, -a + Math.PI / 2], [1, 1, 0.45]);
    }
    add(p, new THREE.ConeGeometry(0.09, 0.2, 6), shell, false, [0.5, 0.06, 0.2], [0.4, 0, 1.3]);
    add(p, new THREE.SphereGeometry(0.1, 5, 3, 0, Math.PI * 2, 0, Math.PI / 2), shell, false, [-0.4, 0, -0.3], [0, 0, 0], [1, 0.5, 1.3]);
    return finish(p, 0);
  },
  ember: () => {
    const p = newParts();
    add(p, rockGeo(3), '#221c1c', false, [0, 0.08, 0], [0, 0, 0], [0.3, 0.2, 0.3]);
    add(p, new THREE.OctahedronGeometry(0.09, 0), '#ff7a30', true, [0.05, 0.2, 0], undefined, undefined, 2.4);
    return finish(p, 0);
  },
};

const cache = new Map<PlanetType, KitGeometries>();

export function kitGeometries(type: PlanetType): KitGeometries {
  const hit = cache.get(type);
  if (hit) return hit;
  let kit: KitGeometries;
  switch (type) {
    case 'terran':
      kit = {
        big: [kg(G.pine(['#2f6b3a', '#3a7a42', '#478a4a'])), kg(G.broadleaf(['#4f8f3a', '#5f9f45', '#3f7f35'])), kg(G.bush(['#4f8a3a', '#5a9a44', '#3f7a35'])), kg(G.boulder('#8c8279', 0))],
        small: [kg(G.grass('#6aa84f', '#86c05a'), false), kg(G.flower('#e8485a'), false), kg(G.flower('#fff4d0'), false), kg(G.pebble('#8c8279'), false)],
        sea: [kg(G.kelp('#4a6a2a', '#6a8a3a'), false), kg(G.branchCoral('#e86a5a', '#ffd0b0'), false), kg(G.brainCoral('#d8a06a', '#b8804a'), false),
          kg(G.seaRock('#6a7068', '#4a7a4a'), false), kg(G.anemone('#ff8a5a', false), false), kg(G.starShells('#ff7040', '#f0e0c8'), false)],
      };
      break;
    case 'ocean':
      kit = {
        big: [kg(G.palm), kg(G.broadleaf(['#3f9a55', '#4faa5a', '#358a48'])), kg(G.bush(['#3f9a55', '#4faa5a', '#358a48'])), kg(G.boulder('#9a8f80', 1))],
        small: [kg(G.grass('#6cc070', '#8ad07a'), false), kg(G.flower('#ffb84a'), false), kg(G.pebble('#b0a080'), false)],
        sea: [kg(G.kelp('#3a7a4a', '#5a9a4a'), false), kg(G.branchCoral('#ff6a9a', '#ffe0f0'), false), kg(G.brainCoral('#b0d070', '#8ab050'), false),
          kg(G.seaRock('#8a8278', '#4a8a6a'), false), kg(G.anemone('#ffd04a', false), false), kg(G.starShells('#ff5a3a', '#ffe8d0'), false)],
      };
      break;
    case 'alien':
      kit = {
        big: [kg(G.mushroom('#ff7ab8', '#ffe0f0')), kg(G.mushroom('#2ee6c9', '#e0fff8')), kg(G.bulb), kg(G.coral)],
        small: [kg(G.sprout('#7affe0'), false), kg(G.sprout('#ffb0f0'), false), kg(G.grass('#b070e0', '#8a4fc0'), false)],
        sea: [kg(G.kelp('#8a4ac0', '#b070e0'), false), kg(G.tubeCoral('#2e8a9a', '#8affe8'), false), kg(G.brainCoral('#ff7ab8', '#e05a9a'), false),
          kg(G.seaRock('#5e3b8c', '#3de0c8'), false), kg(G.anemone('#ff5ad0', true), false), kg(G.starShells('#7affe0', '#f0d0ff'), false)],
      };
      break;
    case 'desert':
      kit = { big: [kg(G.cactus), kg(G.boulder('#a85f38', 2))], small: [kg(G.shrub, false), kg(G.pebble('#a86a40'), false)], sea: [] };
      break;
    case 'ice':
      kit = { big: [kg(G.iceSpire, true, true), kg(G.snowRock)], small: [kg(G.shard, false, true), kg(G.mound, false)], sea: [] };
      break;
    case 'lava':
      kit = { big: [kg(G.basalt), kg(G.glowRock)], small: [kg(G.ember, false), kg(G.pebble('#2e2626'), false)], sea: [] };
      break;
    default:
      kit = { big: [kg(G.boulder('#8e8a86', 3))], small: [kg(G.pebble('#9a948e'), false)], sea: [] };
  }
  cache.set(type, kit);
  return kit;
}
