import { buildChunk } from '../../shared/planet/chunk-gen.ts';
import { placeProps } from '../../shared/planet/prop-rules.ts';
import type { PlanetDef } from '../../shared/galaxy/system-gen.ts';
import type { V3 } from '../../shared/math/vec.ts';

type Job =
  | { id: number; kind: 'chunk'; planet: PlanetDef; face: number; level: number; x: number; y: number }
  | { id: number; kind: 'props'; planet: PlanetDef; dir: V3; tier: 'big' | 'small' };

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<Job>) => void) | null;
  postMessage(msg: unknown, transfer: Transferable[]): void;
};

ctx.onmessage = (e) => {
  const j = e.data;
  if (j.kind === 'props') {
    const data = placeProps(j.planet, j.dir, j.tier);
    ctx.postMessage({ id: j.id, props: data }, [data.buffer]);
    return;
  }
  const c = buildChunk(j.planet, j.face, j.level, j.x, j.y);
  ctx.postMessage({ id: j.id, chunk: c }, [c.heights.buffer, c.positions.buffer, c.normals.buffer, c.colors.buffer, c.water.positions.buffer, c.water.normals.buffer, c.water.colors.buffer, c.water.seabed.buffer]);
};
