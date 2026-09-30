import { buildChunk } from '../../shared/planet/chunk-gen.ts';
import type { PlanetDef } from '../../shared/galaxy/system-gen.ts';

interface Job { id: number; planet: PlanetDef; face: number; level: number; x: number; y: number }

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<Job>) => void) | null;
  postMessage(msg: unknown, transfer: Transferable[]): void;
};

ctx.onmessage = (e) => {
  const j = e.data;
  const c = buildChunk(j.planet, j.face, j.level, j.x, j.y);
  ctx.postMessage({ id: j.id, chunk: c }, [c.positions.buffer, c.normals.buffer, c.colors.buffer]);
};
