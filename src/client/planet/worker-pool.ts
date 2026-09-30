import type { PlanetDef } from '../../shared/galaxy/system-gen.ts';
import type { V3 } from '../../shared/math/vec.ts';
import { buildChunk, type ChunkData } from '../../shared/planet/chunk-gen.ts';
import { placeProps } from '../../shared/planet/prop-rules.ts';

type ChunkJob = { kind: 'chunk'; planet: PlanetDef; face: number; level: number; x: number; y: number; done: (c: ChunkData) => void };
type PropsJob = { kind: 'props'; planet: PlanetDef; dir: V3; tier: 'big' | 'small'; done: (d: Float32Array) => void };
type Job = ChunkJob | PropsJob;

const run = (j: Job) => {
  if (j.kind === 'chunk') j.done(buildChunk(j.planet, j.face, j.level, j.x, j.y));
  else j.done(placeProps(j.planet, j.dir, j.tier));
};

/**
 * Fixed pool of generation workers (terrain chunks and prop placement). If
 * workers are unavailable or never answer (e.g. a restrictive sandbox), it
 * falls back to doing a few jobs per frame on the main thread.
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
        w.onmessage = (e: MessageEvent<{ id: number; chunk?: ChunkData; props?: Float32Array }>) => {
          this.answered = true;
          const job = this.jobs.get(e.data.id);
          this.jobs.delete(e.data.id);
          this.idle.push(w);
          if (job?.kind === 'chunk' && e.data.chunk) job.done(e.data.chunk);
          else if (job?.kind === 'props' && e.data.props) job.done(e.data.props);
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
    for (const j of pending) run(j);
  }

  /** Call once per rendered frame (limits main-thread generation in fallback mode). */
  beginFrame() {
    this.budget = 3;
  }

  get free(): number {
    return this.fallback ? this.budget : this.idle.length;
  }

  private submit(job: Job, msg: object) {
    if (this.fallback || !this.idle.length) {
      if (this.fallback) this.budget--;
      run(job);
      return;
    }
    const w = this.idle.pop()!;
    const id = this.nextId++;
    this.jobs.set(id, job);
    if (!this.answered && !this.watchdog) this.watchdog = setTimeout(() => { if (!this.answered) this.useFallback(); }, 5000);
    w.postMessage({ id, ...msg });
  }

  request(planet: PlanetDef, face: number, level: number, x: number, y: number, done: (c: ChunkData) => void) {
    this.submit({ kind: 'chunk', planet, face, level, x, y, done }, { kind: 'chunk', planet, face, level, x, y });
  }

  requestProps(planet: PlanetDef, dir: V3, tier: 'big' | 'small', done: (d: Float32Array) => void) {
    this.submit({ kind: 'props', planet, dir, tier, done }, { kind: 'props', planet, dir, tier });
  }
}
