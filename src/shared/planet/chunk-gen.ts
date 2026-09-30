import type { PlanetDef } from '../galaxy/system-gen.ts';
import { v3 } from '../math/vec.ts';
import { cubeToSphere } from './cubesphere.ts';
import { heightAt, surfaceColor } from './terrain.ts';

export interface ChunkData {
  key: string;
  /** Chunk centre relative to the planet centre (metres, double precision). */
  cx: number; cy: number; cz: number;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  radius: number;
}

export const CHUNK_N = 16;

/**
 * Builds a flat-shaded (non-indexed) low-poly terrain chunk for quadtree node
 * (face, level, x, y). Vertices are relative to the chunk centre for float32 precision.
 */
export function buildChunk(p: PlanetDef, face: number, level: number, x: number, y: number, N = CHUNK_N): ChunkData {
  const size = 2 / (1 << level);
  const u0 = -1 + x * size, v0 = -1 + y * size;
  const G = N + 1;
  const pos = new Float64Array(G * G * 3);
  const dir = new Float64Array(G * G * 3);
  const raw = new Float64Array(G * G);
  const d = v3();
  const R = p.radius;
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      cubeToSphere(face, u0 + (size * i) / N, v0 + (size * j) / N, d);
      const h = heightAt(p, d.x, d.y, d.z);
      const k = j * G + i;
      raw[k] = h;
      const r = R + (p.sea && h < 0 ? 0 : h);
      pos[k * 3] = d.x * r; pos[k * 3 + 1] = d.y * r; pos[k * 3 + 2] = d.z * r;
      dir[k * 3] = d.x; dir[k * 3 + 1] = d.y; dir[k * 3 + 2] = d.z;
    }
  }
  cubeToSphere(face, u0 + size / 2, v0 + size / 2, d);
  const hc = heightAt(p, d.x, d.y, d.z);
  const rc = R + (p.sea && hc < 0 ? 0 : hc);
  const cx = d.x * rc, cy = d.y * rc, cz = d.z * rc;

  const triCount = N * N * 2 + 4 * N * 4;
  const P = new Float32Array(triCount * 9);
  const Nn = new Float32Array(triCount * 9);
  const C = new Float32Array(triCount * 9);
  let o = 0;
  let maxR2 = 0;
  const col: [number, number, number] = [0, 0, 0];

  const put = (k: number, nx: number, ny: number, nz: number, dx = 0) => {
    const px = pos[k * 3] - cx - dir[k * 3] * dx, py = pos[k * 3 + 1] - cy - dir[k * 3 + 1] * dx, pz = pos[k * 3 + 2] - cz - dir[k * 3 + 2] * dx;
    P[o] = px; P[o + 1] = py; P[o + 2] = pz;
    Nn[o] = nx; Nn[o + 1] = ny; Nn[o + 2] = nz;
    C[o] = col[0]; C[o + 1] = col[1]; C[o + 2] = col[2];
    const r2 = px * px + py * py + pz * pz;
    if (r2 > maxR2) maxR2 = r2;
    o += 3;
  };

  const tri = (a: number, b: number, c: number) => {
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const e1x = pos[b * 3] - ax, e1y = pos[b * 3 + 1] - ay, e1z = pos[b * 3 + 2] - az;
    const e2x = pos[c * 3] - ax, e2y = pos[c * 3 + 1] - ay, e2z = pos[c * 3 + 2] - az;
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    let mx = dir[a * 3] + dir[b * 3] + dir[c * 3], my = dir[a * 3 + 1] + dir[b * 3 + 1] + dir[c * 3 + 1], mz = dir[a * 3 + 2] + dir[b * 3 + 2] + dir[c * 3 + 2];
    const ml = Math.sqrt(mx * mx + my * my + mz * mz) || 1;
    mx /= ml; my /= ml; mz /= ml;
    const slope = 1 - (nx * mx + ny * my + nz * mz);
    const hmax = Math.max(raw[a], raw[b], raw[c]);
    const havg = (raw[a] + raw[b] + raw[c]) / 3;
    surfaceColor(p, mx, my, mz, p.sea && hmax < 0 ? havg : Math.max(havg, p.sea ? 0 : havg), slope, col);
    put(a, nx, ny, nz); put(b, nx, ny, nz); put(c, nx, ny, nz);
  };

  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * G + i, b = a + 1, c = a + G + 1, dd = a + G;
      tri(a, b, c);
      tri(a, c, dd);
    }
  }

  // Skirts hide cracks between neighbouring LOD levels.
  const skirt = Math.max(3, ((Math.PI * R * size) / 4) * 0.04);
  const edge = (k0: number, k1: number) => {
    surfaceColor(p, dir[k0 * 3], dir[k0 * 3 + 1], dir[k0 * 3 + 2], raw[k0], 0, col);
    const nx = dir[k0 * 3], ny = dir[k0 * 3 + 1], nz = dir[k0 * 3 + 2];
    // both windings so the skirt is visible from either side
    put(k0, nx, ny, nz); put(k1, nx, ny, nz); put(k1, nx, ny, nz, skirt);
    put(k0, nx, ny, nz); put(k1, nx, ny, nz, skirt); put(k0, nx, ny, nz, skirt);
    put(k0, nx, ny, nz); put(k1, nx, ny, nz, skirt); put(k1, nx, ny, nz);
    put(k0, nx, ny, nz); put(k0, nx, ny, nz, skirt); put(k1, nx, ny, nz, skirt);
  };
  for (let i = 0; i < N; i++) {
    edge(i, i + 1);
    edge(N * G + i, N * G + i + 1);
    edge(i * G, (i + 1) * G);
    edge(i * G + N, (i + 1) * G + N);
  }

  return { key: `${face}/${level}/${x}/${y}`, cx, cy, cz, positions: P, normals: Nn, colors: C, radius: Math.sqrt(maxR2) };
}
