import { GALAXY_SEED, SYSTEM_COUNT } from '../constants.ts';
import { hashInts, Rng } from '../math/rng.ts';
import { makeName } from './names.ts';

/**
 * The star map: where each system sits in the galaxy (light years, a flat
 * disc), its security zone and the jump lanes between neighbours. Gates exist
 * only along lanes, so getting far means a route of several jumps. Ids are
 * stable: 0 is the core system new pilots start in, low ids are near the core.
 */

export type Security = 'core' | 'mid' | 'frontier';

export interface StarNode {
  id: number;
  name: string;
  x: number;
  y: number;
  security: Security;
}

export interface Galaxy {
  stars: StarNode[];
  /** Lanes as [a, b] with a < b. */
  lanes: [number, number][];
  /** Neighbours of each system, nearest first. */
  links: number[][];
}

export const SECURITY_NAMES: Record<Security, string> = { core: 'Ядро', mid: 'Пограничье', frontier: 'Дальний рубеж' };
export const SECURITY_COLORS: Record<Security, string> = { core: '#6dff9c', mid: '#ffd050', frontier: '#ff5a6a' };
/** Pirates kept alive in a system of the zone. */
export const SECURITY_PIRATES: Record<Security, number> = { core: 4, mid: 7, frontier: 11 };

const RADIUS = 50;
const MIN_GAP = 9;
const MAX_LINKS = 4;
const MAX_LANE = 22;

const cross = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

function segmentsCross(a: StarNode, b: StarNode, c: StarNode, d: StarNode): boolean {
  if (a === c || a === d || b === c || b === d) return false;
  const d1 = cross(a.x, a.y, b.x, b.y, c.x, c.y), d2 = cross(a.x, a.y, b.x, b.y, d.x, d.y);
  const d3 = cross(c.x, c.y, d.x, d.y, a.x, a.y), d4 = cross(c.x, c.y, d.x, d.y, b.x, b.y);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function segmentPointDist(a: StarNode, b: StarNode, p: StarNode): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y);
}

export function generateGalaxy(seed = GALAXY_SEED, count = SYSTEM_COUNT): Galaxy {
  const rng = new Rng(hashInts(seed, 0x6a1a));
  const pts: { x: number; y: number }[] = [{ x: 0, y: 0 }];
  for (let tries = 0; pts.length < count && tries < 20000; tries++) {
    // denser towards the core
    const r = RADIUS * Math.pow(rng.float(), 0.7), a = rng.range(0, Math.PI * 2);
    const p = { x: Math.cos(a) * r, y: Math.sin(a) * r * 0.75 };
    if (pts.every((q) => Math.hypot(q.x - p.x, q.y - p.y) > MIN_GAP)) pts.push(p);
  }
  // nearest to the core first, so system 0 is the centre and low ids are safe
  pts.sort((p, q) => Math.hypot(p.x, p.y) - Math.hypot(q.x, q.y));

  const used = new Set<string>();
  const stars: StarNode[] = pts.map((p, id) => {
    let name = makeName(new Rng(hashInts(seed, id, 0x51)));
    for (let k = 0; used.has(name); k++) name = makeName(new Rng(hashInts(seed, id, 0x52 + k)));
    used.add(name);
    const r = Math.hypot(p.x, p.y);
    return { id, name, x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, security: r < 17 ? 'core' : r < 33 ? 'mid' : 'frontier' };
  });

  const pairs: { a: number; b: number; d: number }[] = [];
  for (let a = 0; a < stars.length; a++) {
    for (let b = a + 1; b < stars.length; b++) pairs.push({ a, b, d: Math.hypot(stars[a].x - stars[b].x, stars[a].y - stars[b].y) });
  }
  pairs.sort((p, q) => p.d - q.d);

  const lanes: [number, number][] = [];
  const links: number[][] = stars.map(() => []);
  const ok = (a: number, b: number) =>
    lanes.every(([c, d]) => !segmentsCross(stars[a], stars[b], stars[c], stars[d]))
    && stars.every((s) => s.id === a || s.id === b || segmentPointDist(stars[a], stars[b], s) > 3);
  const add = (a: number, b: number) => { lanes.push([a, b]); links[a].push(b); links[b].push(a); };

  // Greedy planar graph: shortest lanes first, no crossings, a few lanes per star.
  // Frontier stars get fewer, so the rim has dead ends and chokepoints.
  const cap = (i: number) => (stars[i].security === 'frontier' ? MAX_LINKS - 1 : MAX_LINKS);
  for (const { a, b, d } of pairs) {
    if (d > MAX_LANE) break;
    if (links[a].length >= cap(a) || links[b].length >= cap(b) || !ok(a, b)) continue;
    add(a, b);
  }
  // anything still cut off joins the nearest reachable star
  const root = stars.map((_, i) => i);
  const find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i])));
  for (const [a, b] of lanes) root[find(a)] = find(b);
  for (const { a, b } of pairs) {
    if (find(a) !== find(b)) { root[find(a)] = find(b); add(a, b); }
  }

  const dist = (a: number, b: number) => Math.hypot(stars[a].x - stars[b].x, stars[a].y - stars[b].y);
  for (let i = 0; i < links.length; i++) links[i].sort((p, q) => dist(i, p) - dist(i, q));
  for (const l of lanes) l.sort((p, q) => p - q);
  return { stars, lanes, links };
}

let cached: { seed: number; g: Galaxy } | null = null;
export function getGalaxy(seed = GALAXY_SEED): Galaxy {
  if (!cached || cached.seed !== seed) cached = { seed, g: generateGalaxy(seed) };
  return cached.g;
}

/** Fewest jumps from `from` to every system (-1: unreachable). */
export function jumpsFrom(from: number, g = getGalaxy()): number[] {
  const out = g.stars.map(() => -1);
  out[from] = 0;
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    for (const n of g.links[queue[i]]) if (out[n] < 0) { out[n] = out[queue[i]] + 1; queue.push(n); }
  }
  return out;
}

/** Shortest route by jumps: the systems after `from` up to and including `to` (empty if already there). */
export function route(from: number, to: number, g = getGalaxy()): number[] {
  if (from === to) return [];
  const prev = g.stars.map(() => -1);
  prev[from] = from;
  const queue = [from];
  for (let i = 0; i < queue.length && prev[to] < 0; i++) {
    for (const n of g.links[queue[i]]) if (prev[n] < 0) { prev[n] = queue[i]; queue.push(n); }
  }
  if (prev[to] < 0) return [];
  const path: number[] = [];
  for (let c = to; c !== from; c = prev[c]) path.push(c);
  return path.reverse();
}
