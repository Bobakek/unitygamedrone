import { buildChunk, CHUNK_N } from '../src/shared/planet/chunk-gen.ts';
import { cubeToSphere } from '../src/shared/planet/cubesphere.ts';
import { heightAt } from '../src/shared/planet/terrain.ts';
import { v3, type V3 } from '../src/shared/math/vec.ts';
import type { PlanetDef } from '../src/shared/galaxy/system-gen.ts';
export * from '../src/shared/index.ts';

/** Builds a chunk plus the planet-space positions of its left/right grid edges. */
export function buildChunkLike(p: PlanetDef, level: number, face: number, x: number, y: number) {
  const c = buildChunk(p, face, level, x, y);
  const size = 2 / (1 << level);
  const edge = (i: number): V3[] => {
    const out: V3[] = [];
    for (let j = 0; j <= CHUNK_N; j++) {
      const d = cubeToSphere(face, -1 + x * size + (size * i) / CHUNK_N, -1 + y * size + (size * j) / CHUNK_N, v3());
      const h = heightAt(p, d.x, d.y, d.z);
      const r = p.radius + (p.sea && h < 0 ? 0 : h);
      out.push(v3(d.x * r, d.y * r, d.z * r));
    }
    return out;
  };
  return { ...c, edgeLeft: edge(0), edgeRight: edge(CHUNK_N) };
}
