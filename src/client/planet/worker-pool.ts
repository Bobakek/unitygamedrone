import type { PlanetDef } from '../../shared/galaxy/system-gen.ts';
import { buildChunk, type ChunkData } from '../../shared/planet/chunk-gen.ts';

type Done = (c: ChunkData) => void;
interface Job { planet: PlanetDef; face: number; level: number; x: number; y: number; done: Done }

/**
 * Fixed pool of terrain-generation workers. If workers are unavailable or never
 * answer (e.g. a restrictive sandbox), it falls back to generating a few chunks
 * per frame on the main thread.
 */
export class WorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private jobs = new Map<number, Job>();
  private nextId = 1;
  private fallback = false;
  private budget = 3;
  private answered = false;
  private watchdog: ReturnType<typeof setTimeout> | null = null;

  constructor(size = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1))) {
    try {
      for (let i = 0; i < size; i++) {
        const w = new Worker(new URL('./chunk.worker.ts', import.meta.url), { type: 'module' });
        w.onmessage = (e: MessageEvent<{ id: number; chunk: ChunkData }>) => {
          this.answered = true;
          const job = this.jobs.get(e.data.id);
          this.jobs.delete(e.data.id);
          this.idle.push(w);
          job?.done(e.data.chunk);
        };
        w.onerror = () => this.useFallback();
        this.workers.push(w);
        this.idle.push(w);
      }
    } catch {
      this.useFallback();
    }
  }

  private useFallback() {
    if (this.fallback) return;
    this.fallback = true;
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.idle = [];
    const pending = [...this.jobs.values()];
    this.jobs.clear();
    for (const j of pending) j.done(buildChunk(j.planet, j.face, j.level, j.x, j.y));
  }

  /** Call once per rendered frame (limits main-thread generation in fallback mode). */
  beginFrame() {
    this.budget = 3;
  }

  get free(): number {
    return this.fallback ? this.budget : this.idle.length;
  }

  request(planet: PlanetDef, face: number, level: number, x: number, y: number, done: Done) {
    if (this.fallback) {
      this.budget--;
      done(buildChunk(planet, face, level, x, y));
      return;
    }
    const w = this.idle.pop()!;
    const id = this.nextId++;
    this.jobs.set(id, { planet, face, level, x, y, done });
    if (!this.answered && !this.watchdog) this.watchdog = setTimeout(() => { if (!this.answered) this.useFallback(); }, 5000);
    w.postMessage({ id, planet, face, level, x, y });
  }
}
