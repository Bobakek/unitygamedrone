import { describe, expect, it } from 'vitest';
import {
  deposit, DEPOSIT_BASE, DEPOSIT_KINDS, DEP_GRID, depositPos, depositsNear, getSystem, heightAt, liquidOf, nearDeposit,
  resourceNode, vdist, vnorm, v3,
} from '../src/shared/index.ts';
import { inSite, SITE_NODE_BASE } from '../src/shared/planet/sites.ts';
import { collidersNear } from '../src/shared/planet/prop-rules.ts';

const planets = [0, 1, 2].flatMap((s) => getSystem(s).planets);
const all = (pl: (typeof planets)[number]) => Array.from({ length: DEP_GRID * DEP_GRID * 6 }, (_, k) => deposit(pl, DEPOSIT_BASE + k)).filter((d) => !!d);

describe('rover deposits', () => {
  it('every planet has plenty, a kilometre or so apart, of kinds that suit it', () => {
    for (const pl of planets) {
      const ds = all(pl);
      expect(ds.length).toBeGreaterThan(40);
      // lava and airless worlds hold no fossils
      if (pl.type === 'lava' || pl.type === 'barren') expect(ds.some((d) => d.kind === 'fossil')).toBe(false);
      for (const d of ds) {
        expect(DEPOSIT_KINDS).toContain(d.kind);
        expect(Object.values(d.yield).reduce((n, x) => n + (x ?? 0), 0)).toBeGreaterThanOrEqual(3);
        // on dry ground, out of ruins and outposts
        if (liquidOf(pl)) expect(d.h).toBeGreaterThanOrEqual(2);
        expect(inSite(pl, d.dir, 50)).toBe(false);
        expect(heightAt(pl, d.dir.x, d.dir.y, d.dir.z)).toBeCloseTo(d.h, 6);
      }
    }
  });

  it('is deterministic and its ids never collide with resource nodes or site caches', () => {
    const pl = planets[1];
    const a = all(pl), b = all(pl);
    expect(b).toEqual(a);
    expect(DEPOSIT_BASE).toBeGreaterThan(SITE_NODE_BASE + 4096);
    expect(resourceNode(pl, a[0].id)).toBeNull();
    expect(deposit(pl, 5)).toBeNull();
    expect(deposit(pl, DEPOSIT_BASE + DEP_GRID * DEP_GRID * 6)).toBeNull();
  });

  it('finds deposits by distance, and they are solid', () => {
    const pl = planets[0];
    const d = all(pl)[7];
    const near = depositsNear(pl, d.dir, 2500);
    expect(near.map((x) => x.id)).toContain(d.id);
    for (const x of near) expect(vdist(depositPos(pl, x), depositPos(pl, d))).toBeLessThan(2500 + 1);
    expect(nearDeposit(pl, d.dir, 1)).toBe(true);
    const far = vnorm(v3(), v3(-d.dir.x, -d.dir.y, -d.dir.z));
    expect(depositsNear(pl, far, 300).some((x) => x.id === d.id)).toBe(false);
    // the rover and the pilot bump into it
    const p = depositPos(pl, d);
    expect(collidersNear(pl, d.dir, 5).some((c) => Math.hypot(c.x - p.x, c.y - p.y, c.z - p.z) < 1)).toBe(true);
  });
});
