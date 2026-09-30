import type { PlanetDef } from '../../shared/galaxy/system-gen.ts';
import { buildChunk, type ChunkData } from '../../shared/planet/chunk-gen.ts';

type Done = (c: ChunkData) => void;

/** Fixed pool of terrain-generation workers (falls back to the main thread if workers fail). */
export class WorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private callbacks = new Map<number, Done>();
  private nextId = 1;

  constructor(size = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1))) {
    try {
      for (let i = 0; i < size; i++) {
        const w = new Worker(new URL('./chunk.worker.ts', import.meta.url), { type: 'module' });
        w.onmessage = (e: MessageEvent<{ id: number; chunk: ChunkData }>) => {
          const cb = this.callbacks.get(e.data.id);
          this.callbacks.delete(e.data.id);
          this.idle.push(w);
          cb?.(e.data.chunk);
        };
        this.workers.push(w);
        this.idle.push(w);
      }
    } catch {
      this.workers = [];
      this.idle = [];
    }
  }

  get free(): number {
    return this.workers.length ? this.idle.length : 1;
  }

  request(planet: PlanetDef, face: number, level: number, x: number, y: number, done: Done) {
    if (!this.workers.length) {
      done(buildChunk(planet, face, level, x, y));
      return;
    }
    const w = this.idle.pop()!;
    const id = this.nextId++;
    this.callbacks.set(id, done);
    w.postMessage({ id, planet, face, level, x, y });
  }
}
