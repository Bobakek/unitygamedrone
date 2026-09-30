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
export interface KitGeometries { big: KindGeo[]; small: KindGeo[] }

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
      };
      break;
    case 'ocean':
      kit = {
        big: [kg(G.palm), kg(G.broadleaf(['#3f9a55', '#4faa5a', '#358a48'])), kg(G.bush(['#3f9a55', '#4faa5a', '#358a48'])), kg(G.boulder('#9a8f80', 1))],
        small: [kg(G.grass('#6cc070', '#8ad07a'), false), kg(G.flower('#ffb84a'), false), kg(G.pebble('#b0a080'), false)],
      };
      break;
    case 'alien':
      kit = {
        big: [kg(G.mushroom('#ff7ab8', '#ffe0f0')), kg(G.mushroom('#2ee6c9', '#e0fff8')), kg(G.bulb), kg(G.coral)],
        small: [kg(G.sprout('#7affe0'), false), kg(G.sprout('#ffb0f0'), false), kg(G.grass('#b070e0', '#8a4fc0'), false)],
      };
      break;
    case 'desert':
      kit = { big: [kg(G.cactus), kg(G.boulder('#a85f38', 2))], small: [kg(G.shrub, false), kg(G.pebble('#a86a40'), false)] };
      break;
    case 'ice':
      kit = { big: [kg(G.iceSpire, true, true), kg(G.snowRock)], small: [kg(G.shard, false, true), kg(G.mound, false)] };
      break;
    case 'lava':
      kit = { big: [kg(G.basalt), kg(G.glowRock)], small: [kg(G.ember, false), kg(G.pebble('#2e2626'), false)] };
      break;
    default:
      kit = { big: [kg(G.boulder('#8e8a86', 3))], small: [kg(G.pebble('#9a948e'), false)] };
  }
  cache.set(type, kit);
  return kit;
}
