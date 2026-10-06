import { describe, expect, it } from 'vitest';
import {
  buildChunkLike, cubeToSphere, decodeInput, decodeShots, decodeSnapshot, emptyCharInput, emptyInput, encodeInput, encodeShots,
  encodeSnapshot, flightStats, defaultUpgrades, generateSystem, getSystem, heightAt, leadPoint, MODE, newChar, newShip, nodesNear,
  noiseFor, qlook, quantizeInput, resourceNode, segmentSphere, SHIP_LAND_HEIGHT, stepChar, stepShip, surfaceHeight, v3, vdist, vlen, vnorm,
  type ShipInput, type SimEnv, Rng, DT, cloneShip, CRUISE_SPOOL, footHeight, copyChar, quat, newPose, planetRot, setFrame, toWorldPoint, worldPose,
  liquidOf, FLOAT_DEPTH, HEAD_UNDER, AIR_TIME, vscale,
  defaultOutfit, gearStats, DEFAULT_GEAR, lookCode, parseLook, validOutfit, type Outfit,
  generateBoard, objectiveText, FAUNA, FAUNA_SEA, rankOf, RANKS, repLevel, validCareer, newCareer, item, repOk,
  weatherAt, forecast, STORM_OF, WINDOW, vsub, getGalaxy, generateGalaxy, jumpsFrom, route, SYSTEM_COUNT,
  newRover, IFLAG,
} from './helpers.ts';
import { planetSites, siteDir, wreckAt, wreckZone } from '../src/shared/planet/sites.ts';
import { DECK_POSTS, DECK_WALLS, RAMP, roomAt, stepDeck, TERMINAL_REACH, TERMINALS } from '../src/shared/station/deck.ts';

const sys = getSystem(0);
const env: SimEnv = { star: sys.star, planets: sys.planets, fields: sys.fields, station: sys.station, time: 0 };
const stats = flightStats(defaultUpgrades(), 'fighter');
const cloneChar = (c: ReturnType<typeof newChar>) => copyChar(newChar(v3(), v3()), c);

describe('noise & generation', () => {
  it('noise is deterministic and bounded', () => {
    const a = noiseFor(123), b = noiseFor(123);
    for (let i = 0; i < 200; i++) {
      const x = i * 0.37, y = i * 0.11, z = -i * 0.23;
      expect(a(x, y, z)).toBe(b(x, y, z));
      expect(Math.abs(a(x, y, z))).toBeLessThanOrEqual(1.05);
    }
    expect(noiseFor(1)(0.3, 0.4, 0.5)).not.toBe(noiseFor(2)(0.3, 0.4, 0.5));
  });

  it('star systems are deterministic and well formed', () => {
    const s1 = generateSystem(1), s2 = generateSystem(1);
    expect(JSON.stringify(s1)).toBe(JSON.stringify(s2));
    for (const id of [0, 1, 2]) {
      const s = generateSystem(id);
      expect(s.planets.length).toBeGreaterThanOrEqual(4);
      expect(s.gates.length).toBe(getGalaxy().links[id].length);
      expect(s.fields.length).toBeGreaterThanOrEqual(1);
      for (const p of s.planets) {
        expect(vdist(s.station.pos, p.center)).toBeGreaterThan(p.radius * 1.5);
      }
    }
  });

  it('the galaxy is one connected map of lanes with a gate per lane', () => {
    const g = getGalaxy();
    expect(JSON.stringify(generateGalaxy())).toBe(JSON.stringify(g));
    expect(g.stars.length).toBe(SYSTEM_COUNT);
    expect(new Set(g.stars.map((s) => s.name)).size).toBe(SYSTEM_COUNT);
    expect(g.stars[0].security).toBe('core');
    expect(jumpsFrom(0).every((h) => h >= 0)).toBe(true);
    for (const s of g.stars) {
      const links = g.links[s.id];
      expect(links.length).toBeGreaterThan(0);
      expect(links.length).toBeLessThanOrEqual(4);
      const sys = getSystem(s.id);
      expect(sys.name).toBe(s.name);
      // every lane has its gate on both ends, so a jump always lands at a gate back
      expect(sys.gates.map((x) => x.target).sort()).toEqual([...links].sort());
      for (const n of links) expect(g.links[n]).toContain(s.id);
    }
    const r = route(0, 23);
    expect(r[r.length - 1]).toBe(23);
    expect(r.length).toBe(jumpsFrom(0)[23]);
    for (let i = 0; i < r.length; i++) expect(g.links[i ? r[i - 1] : 0]).toContain(r[i]);
    expect(route(5, 5)).toEqual([]);
  });

  it('cube faces agree on shared edges', () => {
    const a = cubeToSphere(0, 1, 0.3, v3()), b = cubeToSphere(5, -1, 0.3, v3());
    expect(vdist(a, b)).toBeLessThan(1e-12);
    const c = cubeToSphere(4, 0.25, 1, v3()), d = cubeToSphere(2, 0.25, -1, v3());
    expect(vdist(c, d)).toBeLessThan(1e-12);
    expect(vlen(a)).toBeCloseTo(1, 12);
  });

  it('terrain heights stay within the planet profile', () => {
    for (const p of sys.planets) {
      const rng = new Rng(p.seed);
      for (let i = 0; i < 300; i++) {
        const d = vnorm(v3(), v3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)));
        const h = heightAt(p, d.x, d.y, d.z);
        expect(Math.abs(h)).toBeLessThan(p.maxHeight * 3);
        if (p.sea) expect(surfaceHeight(p, d.x, d.y, d.z)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('chunk meshes are finite and neighbouring chunks share edge vertices', () => {
    const p = sys.planets[1];
    const a = buildChunkLike(p, 4, 2, 1, 1);
    const b = buildChunkLike(p, 4, 2, 2, 1);
    expect(a.positions.every(Number.isFinite)).toBe(true);
    // right edge of a == left edge of b in planet space
    const ea = a.edgeRight, eb = b.edgeLeft;
    for (let i = 0; i < ea.length; i++) expect(vdist(ea[i], eb[i])).toBeLessThan(1e-6);
  });

  it('resource nodes are deterministic and above water', () => {
    const p = sys.planets.find((x) => x.sea)!;
    let found = 0;
    for (let id = 0; id < 2000; id++) {
      const n = resourceNode(p, id);
      if (!n) continue;
      found++;
      expect(n.h).toBeGreaterThan(0.9);
      expect(resourceNode(p, id)).toEqual(n);
    }
    expect(found).toBeGreaterThan(50);
    const n0 = resourceNode(p, [...Array(3000).keys()].find((i) => resourceNode(p, i))!)!;
    expect(nodesNear(p, n0.dir, 50).some((n) => n.id === n0.id)).toBe(true);
  });
});

describe('ship simulation', () => {
  const randomInputs = (seed: number, n: number): ShipInput[] => {
    const rng = new Rng(seed);
    return Array.from({ length: n }, () => quantizeInput({
      seq: 0, mode: MODE.SHIP, flags: rng.chance(0.3) ? 2 : 0, t: 0,
      ship: { yaw: rng.range(-1, 1), pitch: rng.range(-1, 1), roll: rng.range(-1, 1), throttle: rng.range(-0.3, 1), strafeX: rng.range(-1, 1), strafeY: rng.range(-1, 1), boost: rng.chance(0.3), cruise: false },
      char: emptyCharInput(),
    }).ship);
  };

  it('is deterministic (basis of prediction/reconciliation)', () => {
    const inputs = randomInputs(7, 400);
    const a = newShip(sys.spawn), b = newShip(sys.spawn);
    for (const i of inputs) stepShip(a, i, stats, env, DT);
    for (const i of inputs) stepShip(b, i, stats, env, DT);
    expect(a).toEqual(b);
    // replay from a mid-point clone gives identical results
    const c = newShip(sys.spawn);
    for (let k = 0; k < 200; k++) stepShip(c, inputs[k], stats, env, DT);
    const d = cloneShip(c);
    for (let k = 200; k < 400; k++) { stepShip(c, inputs[k], stats, env, DT); stepShip(d, inputs[k], stats, env, DT); }
    expect(c).toEqual(d);
    expect(c).toEqual(a);
  });

  it('never passes through terrain and lands when slow', () => {
    const p = sys.planets[0];
    const dir = vnorm(v3(), v3(0.3, 0.8, -0.5));
    const start = v3(p.center.x + dir.x * (p.radius + p.maxHeight + 400), p.center.y + dir.y * (p.radius + p.maxHeight + 400), p.center.z + dir.z * (p.radius + p.maxHeight + 400));
    const s = newShip(start);
    qlook(s.q, v3(-dir.x, -dir.y, -dir.z), v3(0, 1, 0));
    // dive at full throttle (the ship switches into the planet's body frame on the first step)
    const dive = { ...emptyInput(), throttle: 1 };
    for (let k = 0; k < 200; k++) {
      stepShip(s, dive, stats, env, DT);
      expect(s.frame).toBe(p.index + 1);
      const d = vnorm(v3(), s.p);
      const ground = p.radius + surfaceHeight(p, d.x, d.y, d.z);
      expect(vlen(s.p) - ground).toBeGreaterThan(stats.radius * 0.5 - 1e-6);
    }
    // cut throttle and descend gently -> should land
    const down = { ...emptyInput(), strafeY: -0.3 };
    for (let k = 0; k < 600 && !s.landed; k++) stepShip(s, down, stats, env, DT);
    expect(s.landed).toBe(p.index + 1);
    const d = vnorm(v3(), s.p);
    expect(vlen(s.p) - (p.radius + surfaceHeight(p, d.x, d.y, d.z))).toBeCloseTo(SHIP_LAND_HEIGHT, 5);
    // throttle up -> takes off
    stepShip(s, { ...emptyInput(), throttle: 0.5 }, stats, env, DT);
    expect(s.landed).toBe(0);
  });

  it('settles and lands by itself with idle controls near the ground', () => {
    const p = sys.planets[1];
    const dir = vnorm(v3(), v3(-0.4, 0.7, 0.6));
    const g = p.radius + surfaceHeight(p, dir.x, dir.y, dir.z) + 60;
    const s = newShip(v3(dir.x * g, dir.y * g, dir.z * g));
    s.frame = p.index + 1;
    qlook(s.q, v3(dir.y, -dir.x, 0), dir);
    for (let k = 0; k < 30 * 40 && !s.landed; k++) stepShip(s, emptyInput(), stats, env, DT);
    expect(s.landed).toBe(p.index + 1);
  });

  it('cruise spools up in open space and is inhibited near planets', () => {
    const far = newShip(v3(sys.station.pos.x + 20000, sys.station.pos.y + 20000, sys.station.pos.z));
    const cr = { ...emptyInput(), throttle: 1, cruise: true };
    for (let k = 0; k < Math.ceil(CRUISE_SPOOL / DT) + 60; k++) stepShip(far, cr, stats, env, DT);
    expect(vlen(far.v)).toBeGreaterThan(stats.boostSpeed * 1.5);
    const near = newShip(sys.spawn);
    for (let k = 0; k < 120; k++) stepShip(near, cr, stats, env, DT);
    expect(vlen(near.v)).toBeLessThanOrEqual(stats.maxSpeed + 1e-6);
  });
});

describe('terrain level of detail', () => {
  it('sphereToCube inverts cubeToSphere', async () => {
    const { sphereToCube } = await import('../src/shared/planet/cubesphere.ts');
    const rng = new Rng(11);
    for (let k = 0; k < 2000; k++) {
      const face = rng.int(0, 5), u = rng.range(-0.999, 0.999), v = rng.range(-0.999, 0.999);
      const c = sphereToCube(cubeToSphere(face, u, v, v3()));
      expect(c.face).toBe(face);
      expect(Math.abs(c.u - u)).toBeLessThan(1e-9);
      expect(Math.abs(c.v - v)).toBeLessThan(1e-9);
    }
  });

  it('meshHeightAt matches the drawn chunk triangles at every level', async () => {
    const { buildChunk, meshHeightAt, CHUNK_N } = await import('../src/shared/planet/chunk-gen.ts');
    const p = sys.planets[2];
    const rng = new Rng(4);
    for (const [level, x, y] of [[2, 1, 2], [5, 12, 20], [8, 100, 140]]) {
      const face = 4, size = 2 / (1 << level), u0 = -1 + x * size, v0 = -1 + y * size;
      const ch = buildChunk(p, face, level, x, y);
      const P = ch.positions;
      for (let k = 0; k < 60; k++) {
        const u = u0 + rng.range(0.01, 0.99) * size, v = v0 + rng.range(0.01, 0.99) * size;
        const d = cubeToSphere(face, u, v, v3());
        const hm = meshHeightAt(p.radius, face, u0, v0, size, CHUNK_N, ch.heights, u, v, d);
        // brute force: ray from the planet centre against the chunk's terrain triangles
        let hit: number | null = null;
        for (let t = 0; t < CHUNK_N * CHUNK_N * 2 && hit === null; t++) {
          const o = t * 9;
          const A = v3(P[o] + ch.cx, P[o + 1] + ch.cy, P[o + 2] + ch.cz);
          const e1 = v3(P[o + 3] + ch.cx - A.x, P[o + 4] + ch.cy - A.y, P[o + 5] + ch.cz - A.z);
          const e2 = v3(P[o + 6] + ch.cx - A.x, P[o + 7] + ch.cy - A.y, P[o + 8] + ch.cz - A.z);
          const pv = v3(d.y * e2.z - d.z * e2.y, d.z * e2.x - d.x * e2.z, d.x * e2.y - d.y * e2.x);
          const det = e1.x * pv.x + e1.y * pv.y + e1.z * pv.z;
          const tv = v3(-A.x, -A.y, -A.z);
          const a = (tv.x * pv.x + tv.y * pv.y + tv.z * pv.z) / det;
          if (a < -1e-7 || a > 1 + 1e-7) continue;
          const qv = v3(tv.y * e1.z - tv.z * e1.y, tv.z * e1.x - tv.x * e1.z, tv.x * e1.y - tv.y * e1.x);
          const b = (d.x * qv.x + d.y * qv.y + d.z * qv.z) / det;
          if (b < -1e-7 || a + b > 1 + 1e-7) continue;
          hit = (e2.x * qv.x + e2.y * qv.y + e2.z * qv.z) / det - p.radius;
        }
        expect(hit).not.toBeNull();
        expect(Math.abs(hm - hit!)).toBeLessThan(0.03);
      }
    }
  });
});

describe('rotating planet frames', () => {
  const p = sys.planets[2];

  it('planets spin slowly about a tilted axis', () => {
    for (const pl of sys.planets) {
      expect(vlen(pl.spinAxis)).toBeCloseTo(1, 9);
      expect(pl.spinAxis.y).toBeGreaterThan(0.9);
      const period = (Math.PI * 2) / pl.spinRate;
      expect(period).toBeGreaterThanOrEqual(720);
      expect(period).toBeLessThanOrEqual(1200);
    }
  });

  it('frame changes keep the world pose continuous', () => {
    const t = 431.25;
    const s = newShip(v3(p.center.x + p.radius * 1.5, p.center.y + 300, p.center.z - 200));
    s.v = v3(40, -12, 90);
    qlook(s.q, vnorm(v3(), v3(0.3, -0.2, -1)), v3(0, 1, 0));
    const before = worldPose(s, sys.planets, t, newPose());
    setFrame(s, p.index + 1, sys.planets, t);
    expect(s.frame).toBe(p.index + 1);
    const after = worldPose(s, sys.planets, t, newPose());
    for (const k of ['x', 'y', 'z'] as const) {
      expect(after.p[k]).toBeCloseTo(before.p[k], 6);
      expect(after.v[k]).toBeCloseTo(before.v[k], 6);
    }
    expect(Math.abs(after.q.x * before.q.x + after.q.y * before.q.y + after.q.z * before.q.z + after.q.w * before.q.w)).toBeCloseTo(1, 9);
    setFrame(s, 0, sys.planets, t);
    expect(s.p.x).toBeCloseTo(before.p.x, 6);
    expect(s.v.z).toBeCloseTo(before.v.z, 6);
  });

  it('a landed ship rides the rotating ground', () => {
    const dir = vnorm(v3(), v3(0.5, 0.3, 0.8));
    const g = p.radius + surfaceHeight(p, dir.x, dir.y, dir.z) + SHIP_LAND_HEIGHT;
    const s = newShip(v3(dir.x * g, dir.y * g, dir.z * g));
    s.frame = s.landed = p.index + 1;
    const e = { ...env };
    const w0 = worldPose(s, sys.planets, 0, newPose());
    for (let k = 0; k < 300; k++) { e.time = k * DT; stepShip(s, emptyInput(), stats, e, DT); }
    expect(s.landed).toBe(p.index + 1);
    expect(vlen(s.p)).toBeCloseTo(g, 9);
    const w1 = worldPose(s, sys.planets, 10, newPose());
    // ~10 s of spin moves it in world space, but it stays at the same height above the ground
    expect(vdist(w0.p, w1.p)).toBeGreaterThan(p.radius * p.spinRate * 10 * 0.2);
    expect(vdist(w1.p, p.center)).toBeCloseTo(g, 6);
    // the ground under it moves with the same velocity
    expect(vlen(w1.v)).toBeGreaterThan(0);
    const R = planetRot(p, 10, quat());
    const surf = toWorldPoint(p, R, s.p, v3());
    expect(vdist(surf, w1.p)).toBeCloseTo(0, 6);
  });

  it('prediction replays match across frame changes (time-stamped inputs)', () => {
    const start = v3(p.center.x + p.radius * 2.3, p.center.y, p.center.z);
    const inputs = Array.from({ length: 360 }, (_, k) => ({ t: 100 + k * DT + 0.013, inp: { ...emptyInput(), throttle: 1, boost: true, yaw: k < 60 ? 0.2 : 0 } }));
    const run = (from = 0, base?: ReturnType<typeof newShip>) => {
      const s = base ? cloneShip(base) : newShip(start, qlook(quat(), v3(-1, 0, 0), v3(0, 1, 0)));
      const e = { ...env };
      for (let k = from; k < inputs.length; k++) { e.time = inputs[k].t; stepShip(s, inputs[k].inp, stats, e, DT); }
      return s;
    };
    const a = run(), b = run();
    expect(a).toEqual(b);
    expect(a.frame).toBe(p.index + 1);
    // replaying the tail from a mid-point snapshot gives the same result
    const mid = newShip(start, qlook(quat(), v3(-1, 0, 0), v3(0, 1, 0)));
    const e = { ...env };
    for (let k = 0; k < 150; k++) { e.time = inputs[k].t; stepShip(mid, inputs[k].inp, stats, e, DT); }
    expect(run(150, mid)).toEqual(a);
  });
});

describe('character simulation', () => {
  it('walks on the surface and lands after a jump', () => {
    const p = sys.planets[1];
    const d = vnorm(v3(), v3(0.2, 0.9, 0.3));
    const g = p.radius + surfaceHeight(p, d.x, d.y, d.z);
    const c = newChar(v3(d.x * g, d.y * g, d.z * g), vnorm(v3(), v3(1, 0, 0)));
    const walk = { ...emptyCharInput(), mz: 1 };
    const start = { ...c.p };
    for (let k = 0; k < 90; k++) stepChar(c, walk, p, DT);
    expect(vdist(c.p, start)).toBeGreaterThan(8);
    stepChar(c, { ...emptyCharInput(), jump: true }, p, DT);
    expect(c.ground).toBe(0);
    for (let k = 0; k < 200; k++) stepChar(c, emptyCharInput(), p, DT);
    expect(c.ground).toBe(1);
    const dd = vnorm(v3(), c.p);
    expect(vlen(c.p) - (p.radius + surfaceHeight(p, dd.x, dd.y, dd.z))).toBeCloseTo(0, 5);
  });
});

describe('obstacle traversal', () => {
  const run = (c: ReturnType<typeof newChar>, p: typeof sys.planets[0], ticks: number, inp: Partial<ReturnType<typeof emptyCharInput>>) => {
    const modes = new Set<number>();
    for (let k = 0; k < ticks; k++) { stepChar(c, { ...emptyCharInput(), ...inp }, p, DT); modes.add(c.climbMode); }
    return modes;
  };
  /** Pilot standing `dist` metres from site-plane point (x, z), facing towards (tx, tz). */
  const start = async (p: typeof sys.planets[0], s: import('../src/shared/planet/sites.ts').SiteDef, x: number, z: number, tx: number, tz: number) => {
    const { siteDir } = await import('../src/shared/planet/sites.ts');
    const d = siteDir(p, s, x, z), t = siteDir(p, s, tx, tz);
    const g = p.radius + footHeight(p, d.x, d.y, d.z);
    const f = vnorm(v3(), v3(t.x - d.x, t.y - d.y, t.z - d.z));
    return newChar(v3(d.x * g, d.y * g, d.z * g), f);
  };
  const across = (c: ReturnType<typeof newChar>, p: typeof sys.planets[0], s: import('../src/shared/planet/sites.ts').SiteDef) => {
    // signed distance from the site centre in the site plane
    const r = p.radius + s.h;
    const dx = c.p.x - s.dir.x * r, dy = c.p.y - s.dir.y * r, dz = c.p.z - s.dir.z * r;
    return Math.hypot(dx * s.east.x + dy * s.east.y + dz * s.east.z, dx * s.north.x + dy * s.north.y + dz * s.north.z);
  };

  it('vaults low ruin blocks on the run, deterministically', async () => {
    const { planetSites } = await import('../src/shared/planet/sites.ts');
    const p = sys.planets.find((x) => planetSites(x).some((s) => s.kind === 'ruin' && s.blocks.some((b) => b.tall < 1.2)))!;
    const ruin = planetSites(p).find((s) => s.kind === 'ruin' && s.blocks.some((b) => b.tall < 1.2))!;
    const b = ruin.blocks.find((x) => x.tall < 1.2)!;
    // block position in the site plane
    const r = p.radius + ruin.h;
    const bx = (b.dir.x * r - ruin.dir.x * r) * ruin.east.x + (b.dir.y * r - ruin.dir.y * r) * ruin.east.y + (b.dir.z * r - ruin.dir.z * r) * ruin.east.z;
    const bz = (b.dir.x * r - ruin.dir.x * r) * ruin.north.x + (b.dir.y * r - ruin.dir.y * r) * ruin.north.y + (b.dir.z * r - ruin.dir.z * r) * ruin.north.z;
    const out = Math.hypot(bx, bz);
    const ux = bx / out, uz = bz / out;
    const c = await start(p, ruin, ux * (out + b.r + 2.5), uz * (out + b.r + 2.5), 0, 0);
    const c2 = cloneChar(c);
    const modes = run(c, p, 60, { mz: 1 });
    expect(modes.has(1)).toBe(true);
    // ended up on the inner side of the block
    expect(across(c, p, ruin)).toBeLessThan(out - b.r - 0.2);
    run(c2, p, 60, { mz: 1 });
    expect(c2).toEqual(c);
  });

  it('climbs outpost walls only with jump; trees stay solid', async () => {
    const { planetSites, WALL_HEIGHT } = await import('../src/shared/planet/sites.ts');
    const p = sys.planets.find((x) => planetSites(x).some((s) => s.kind === 'base'))!;
    const base = planetSites(p).find((s) => s.kind === 'base')!;
    const w = base.walls[0];
    const mx = (w.x0 + w.x1) / 2, mz = (w.z0 + w.z1) / 2, l = Math.hypot(mx, mz);
    const o = (l + 3.5) / l;
    // walking into the wall without jumping: blocked outside
    const a = await start(p, base, mx * o, mz * o, 0, 0);
    const modesA = run(a, p, 60, { mz: 1 });
    expect(modesA.has(2)).toBe(false);
    expect(across(a, p, base)).toBeGreaterThan(l - 0.5);
    // at the wall, a tap on jump climbs over and drops inside
    const b = cloneChar(a);
    const modesB = run(b, p, 2, { mz: 1, jump: true });
    run(b, p, 60, { mz: 1 });
    expect(modesB.has(2)).toBe(true);
    expect(across(b, p, base)).toBeLessThan(l - 1.5);
    expect(WALL_HEIGHT).toBeLessThanOrEqual(3.2);
  });

  it('scrambles slowly up steep slopes', () => {
    const p = sys.planets[2];
    const rng = new Rng(21);
    let best: { d: ReturnType<typeof v3>; f: ReturnType<typeof v3> } | null = null;
    for (let i = 0; i < 20000 && !best; i++) {
      const d = vnorm(v3(), v3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)));
      const h = footHeight(p, d.x, d.y, d.z);
      if (h < 2) continue;
      const t = vnorm(v3(), v3(-d.z, 0, d.x));
      const e = 1.5 / p.radius;
      for (const sgn of [1, -1]) {
        const q = vnorm(v3(), v3(d.x + t.x * e * sgn, d.y + t.y * e * sgn, d.z + t.z * e * sgn));
        if ((footHeight(p, q.x, q.y, q.z) - h) / 1.5 > 1.3) { best = { d, f: v3(t.x * sgn, t.y * sgn, t.z * sgn) }; break; }
      }
    }
    expect(best).not.toBeNull();
    const g = p.radius + footHeight(p, best!.d.x, best!.d.y, best!.d.z);
    const c = newChar(v3(best!.d.x * g, best!.d.y * g, best!.d.z * g), best!.f);
    stepChar(c, { ...emptyCharInput(), mz: 1 }, p, DT);
    stepChar(c, { ...emptyCharInput(), mz: 1 }, p, DT);
    expect(c.scramble).toBe(1);
  });
});

describe('swimming', () => {
  const wet = [0, 1, 2, 3, 4, 5].map(getSystem).flatMap((x) => x.planets).find((p) => liquidOf(p) === 'water')!;
  const R = wet.radius;
  const h = (d: ReturnType<typeof v3>) => heightAt(wet, d.x, d.y, d.z);
  const at = (d: ReturnType<typeof v3>, t: ReturnType<typeof v3>, m: number) => vnorm(v3(), v3(d.x * R + t.x * m, d.y * R + t.y * m, d.z * R + t.z * m));
  /** A sandy point with deep water straight ahead. */
  const shore = () => {
    const rng = new Rng(5);
    for (let i = 0; i < 200000; i++) {
      const d = vnorm(v3(), v3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)));
      if (h(d) < 0.3 || h(d) > 1.2) continue;
      const t = vnorm(v3(), v3(-d.z, 0, d.x));
      for (const sg of [1, -1]) {
        const tt = v3(t.x * sg, t.y * sg, t.z * sg);
        if (h(at(d, tt, 20)) < -3 && h(at(d, tt, 40)) < -8 && h(at(d, tt, 80)) < -12) return { d, t: tt };
      }
    }
    throw new Error('no shore');
  };
  const run = (c: ReturnType<typeof newChar>, ticks: number, inp: Partial<ReturnType<typeof emptyCharInput>>) => {
    for (let k = 0; k < ticks; k++) stepChar(c, { ...emptyCharInput(), ...inp }, wet, DT);
  };
  const depth = (c: ReturnType<typeof newChar>) => R - vlen(c.p);

  it('wades into deep water, floats, dives, runs out of air and surfaces', () => {
    const { d, t } = shore();
    const g = R + footHeight(wet, d.x, d.y, d.z);
    const c = newChar(v3(d.x * g, d.y * g, d.z * g), t);
    for (let k = 0; k < 1200 && !c.swim; k++) run(c, 1, { mz: 1 });
    expect(c.swim).toBe(1);
    // swim out over deep water, then drift
    run(c, 600, { mz: 1 });
    run(c, 180, {});
    expect(depth(c)).toBeCloseTo(FLOAT_DEPTH, 1);
    expect(c.air).toBe(1);
    const start = cloneChar(c);
    // C dives straight down, then forward follows the view pitch
    run(c, 120, { dive: true });
    expect(c.swim).toBe(2);
    const d1 = depth(c);
    expect(d1).toBeGreaterThan(HEAD_UNDER + 1);
    run(c, 60, { mz: 1, pitch: -0.7 });
    expect(depth(c)).toBeGreaterThan(d1 + 1);
    expect(c.air).toBeLessThan(1);
    expect(c.air).toBeCloseTo(1 - 3 / AIR_TIME, 1);
    // the same inputs replay identically (prediction)
    const again = cloneChar(start);
    run(again, 120, { dive: true });
    run(again, 60, { mz: 1, pitch: -0.7 });
    expect(again).toEqual(c);
    // out of air after a long dive, then swim up and breathe
    run(c, Math.ceil(AIR_TIME / DT), { dive: true });
    expect(c.air).toBe(0);
    for (let k = 0; k < 1200 && c.swim === 2; k++) run(c, 1, { jump: true });
    expect(c.swim).toBe(1);
    run(c, 120, {});
    expect(c.air).toBeGreaterThan(0.5);
  });

  it('the sea bed and the surface bound a diver', () => {
    const { d, t } = shore();
    const p0 = at(d, t, 60);
    const c = newChar(vscale(v3(), p0, R - 5), t);
    c.swim = 2;
    for (let k = 0; k < 900; k++) {
      run(c, 1, { dive: true, mz: 0.5 });
      const u = vnorm(v3(), c.p);
      expect(vlen(c.p)).toBeGreaterThanOrEqual(R + heightAt(wet, u.x, u.y, u.z) + 0.3 - 1e-6);
    }
    run(c, 1200, { jump: true });
    expect(depth(c)).toBeGreaterThanOrEqual(FLOAT_DEPTH - 0.25 - 1e-6);
    expect(c.swim).toBe(1);
  });

  it('frozen seas are solid ice', () => {
    const ice = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(getSystem).flatMap((x) => x.planets).find((p) => liquidOf(p) === 'ice')!;
    const rng = new Rng(9);
    let n = 0;
    for (let i = 0; i < 4000 && n < 20; i++) {
      const d = vnorm(v3(), v3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)));
      if (heightAt(ice, d.x, d.y, d.z) >= -2) continue;
      expect(footHeight(ice, d.x, d.y, d.z)).toBe(0);
      n++;
    }
    expect(n).toBeGreaterThan(0);
  });
});

describe('outfits', () => {
  it('gear stats follow what the pilot wears', () => {
    const o = defaultOutfit();
    expect(gearStats(o)).toEqual(DEFAULT_GEAR);
    expect(gearStats({ ...o, pack: 'pack-o2' }).airTime).toBe(150);
    expect(gearStats({ ...o, pack: 'pack-jet' }).fuelDrain).toBeLessThan(DEFAULT_GEAR.fuelDrain);
    expect(gearStats({ ...o, chest: 'chest-plate', helmet: 'helmet-armored' }).hp).toBe(DEFAULT_GEAR.hp + 40);
    expect(gearStats({ ...o, chest: 'chest-rig' }).samples).toBe(1);
    expect(gearStats({ ...o, pack: 'pack-medic' }).regenRate).toBeGreaterThan(DEFAULT_GEAR.regenRate);
  });

  it('look codes round-trip and outfits only keep owned items in their own slots', () => {
    const o: Outfit = { ...defaultOutfit(), suit: 'suit-orange', pack: 'pack-o2', lights: 'lights-eva', patch: 'patch-skull' };
    expect(parseLook(lookCode(o))).toEqual(o);
    expect(parseLook('garbage')).toEqual(defaultOutfit());
    expect(parseLook(undefined)).toEqual(defaultOutfit());
    // only the starter kit (patches are free) without purchases
    expect(validOutfit(o, [])).toEqual({ ...defaultOutfit(), patch: 'patch-skull' });
    expect(validOutfit(o, ['suit-orange', 'pack-o2', 'lights-eva'])).toEqual(o);
    expect(validOutfit({ suit: 'pack-o2' }, ['pack-o2']).suit).toBe('suit-white');
    expect(validOutfit(null, [])).toEqual(defaultOutfit());
  });

  it('gear changes air and jetpack fuel in the shared sim', () => {
    const p = sys.planets[1];
    const d = vnorm(v3(), v3(0.3, 0.8, -0.2));
    const g = p.radius + surfaceHeight(p, d.x, d.y, d.z);
    const a = newChar(v3(d.x * g, d.y * g, d.z * g), vnorm(v3(), v3(1, 0, 0)));
    const b = cloneChar(a);
    const jet = gearStats({ ...defaultOutfit(), pack: 'pack-jet' });
    stepChar(a, { ...emptyCharInput(), jump: true }, p, DT);
    stepChar(b, { ...emptyCharInput(), jump: true }, p, DT, jet);
    for (let k = 0; k < 60; k++) {
      stepChar(a, { ...emptyCharInput(), jump: true }, p, DT);
      stepChar(b, { ...emptyCharInput(), jump: true }, p, DT, jet);
    }
    expect(b.fuel).toBeGreaterThan(a.fuel + 0.05);
    // a head under water (forced) breathes the tanks twice as long
    const c = cloneChar(a), e = cloneChar(a);
    const tanks = gearStats({ ...defaultOutfit(), pack: 'pack-o2' });
    for (let k = 0; k < 30; k++) {
      c.swim = 2; e.swim = 2;
      stepChar(c, emptyCharInput(), p, DT);
      stepChar(e, emptyCharInput(), p, DT, tanks);
    }
    expect(1 - c.air).toBeCloseTo((1 - e.air) * 2, 6);
  });
});

describe('protocol', () => {
  it('round-trips inputs with quantisation', () => {
    const m = { seq: 42, mode: MODE.SHIP, flags: 5, t: 1234.5678, ship: { ...emptyInput(), yaw: 0.5, throttle: -0.2, strafeY: 1 }, char: emptyCharInput() };
    const d = decodeInput(encodeInput(m));
    expect(d.seq).toBe(42);
    expect(d.t).toBe(1234.5678);
    expect(d.ship.yaw).toBeCloseTo(0.5, 2);
    expect(d.ship.cruise).toBe(true);
    expect(quantizeInput(d)).toEqual(d);
  });

  it('round-trips snapshots exactly for own state', () => {
    const ship = newShip(v3(123456.789, -9876.54321, 42.4242));
    ship.v = v3(1.5, 2.5, -3.25); ship.boost = 0.3333; ship.cruise = 1.234; ship.landed = 2; ship.frame = 2;
    const char = newChar(v3(1, 2, 3), v3(0, 0, -1));
    char.swim = 2; char.air = 0.4321;
    const snap = {
      tick: 99, time: 12.5, ack: 77,
      self: { shipId: 5, mode: MODE.FOOT, teleport: 3, ship, hull: 90, maxHull: 100, shield: 12.5, maxShield: 80, energy: 55, missiles: 4, charId: 9, char, charPlanet: 1, suit: 88, roverId: 0, rover: null },
      entities: [{ id: 7, kind: 1, flags: 3, frame: 3, px: 1000.5, py: 2, pz: 3, qx: 0, qy: 0.7071, qz: 0, qw: 0.7071, vx: 10, vy: 0, vz: -5, hull: 0.5, shield: 1, throttle: 0.25 }],
    };
    const d = decodeSnapshot(encodeSnapshot(snap));
    expect(d.self.ship).toEqual(ship);
    expect(d.self.char).toEqual(char);
    expect(d.ack).toBe(77);
    expect(d.entities[0].px).toBeCloseTo(1000.5, 3);
    expect(d.entities[0].frame).toBe(3);
    expect(d.entities[0].qy).toBeCloseTo(0.7071, 3);
    // a driven rover comes back bit for bit (prediction replays from it)
    const rover = newRover(v3(4000.123456789, 1.5, -2.25), qlook(quat(), v3(0, 0, -1), v3(0, 1, 0)));
    rover.v = v3(3.3, -0.1, 7.77); rover.w = v3(0.1, -0.2, 0.3); rover.steer = -0.4321; rover.susp = [0.3, 0.31, 0.4, 0.45]; rover.ground = 3;
    const driving = decodeSnapshot(encodeSnapshot({ ...snap, self: { ...snap.self, mode: MODE.ROVER, roverId: 11, rover } }));
    expect(driving.self.rover).toEqual(rover);
    expect(driving.self.roverId).toBe(11);
    expect(driving.self.char).toEqual(char);
    const inp = { seq: 1, mode: MODE.ROVER, flags: IFLAG.JUMP | IFLAG.SPRINT, t: 1, ship: emptyInput(), char: { ...emptyCharInput(), mx: -1, mz: 0.5 } };
    const di = decodeInput(encodeInput(inp));
    expect(di.char.mx).toBeCloseTo(-1, 2);
    expect(di.char.mz).toBeCloseTo(0.5, 2);
    expect(di.char.jump && di.char.sprint).toBe(true);
    const shots = [{ shooter: 3, px: 1, py: 2, pz: 3, vx: 4, vy: 5, vz: 6, level: 2 }];
    expect(decodeShots(encodeShots(shots))).toEqual(shots);
  });
});

describe('weapons', () => {
  it('segment/sphere and lead computation', () => {
    expect(segmentSphere(v3(-10, 0, 0), v3(10, 0, 0), v3(0, 0, 0), 1)).toBeCloseTo(0.45, 5);
    expect(segmentSphere(v3(-10, 5, 0), v3(10, 5, 0), v3(0, 0, 0), 1)).toBe(-1);
    const lp = leadPoint(v3(), v3(), v3(1000, 0, 0), v3(0, 100, 0), 1000, v3());
    const t = vdist(lp, v3()) / 1000;
    expect(lp.y).toBeCloseTo(100 * t, 3);
  });
});

describe('solid props', () => {
  it('pilots cannot walk through tree trunks and colliders are deterministic', async () => {
    const { collidersNear } = await import('../src/shared/planet/prop-rules.ts');
    const p = sys.planets.find((x) => x.type === 'terran')!;
    // find a direction with a collider nearby
    const rng = new Rng(3);
    let dir = v3(), cols: ReturnType<typeof collidersNear> = [];
    for (let i = 0; i < 400 && !cols.length; i++) {
      dir = vnorm(v3(), v3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)));
      if (surfaceHeight(p, dir.x, dir.y, dir.z) < 5) continue;
      cols = collidersNear(p, dir, 40).filter((c) => Math.hypot(c.x - dir.x * p.radius, c.y - dir.y * p.radius, c.z - dir.z * p.radius) < 400);
    }
    expect(cols.length).toBeGreaterThan(0);
    const col = cols[0];
    const cd = vnorm(v3(), v3(col.x, col.y, col.z));
    expect(collidersNear(p, cd).some((c) => c.x === col.x && c.r === col.r)).toBe(true);
    // start 3 m away from the trunk and walk straight into it
    const tangent = vnorm(v3(), v3(-cd.z, 0, cd.x));
    const startDir = vnorm(v3(), v3(cd.x + tangent.x * (3 / p.radius), cd.y, cd.z + tangent.z * (3 / p.radius)));
    const g = p.radius + surfaceHeight(p, startDir.x, startDir.y, startDir.z);
    const c = newChar(v3(startDir.x * g, startDir.y * g, startDir.z * g), v3(-tangent.x, 0, -tangent.z));
    for (let k = 0; k < 90; k++) stepChar(c, { ...emptyCharInput(), mz: 1 }, p, DT);
    const base = v3(col.x, col.y, col.z);
    const up = vnorm(v3(), c.p);
    const dx = c.p.x - base.x, dy = c.p.y - base.y, dz = c.p.z - base.z;
    const du = dx * up.x + dy * up.y + dz * up.z;
    const horiz = Math.hypot(dx - up.x * du, dy - up.y * du, dz - up.z * du);
    expect(horiz).toBeGreaterThanOrEqual(col.r + 0.3);
  });
});

describe('contracts', () => {
  it('boards are deterministic and point at real targets', () => {
    for (const sysId of [0, 1, 2]) {
      for (let ep = 0; ep < 30; ep++) {
        const board = generateBoard(sysId, ep);
        expect(generateBoard(sysId, ep)).toEqual(board);
        expect(new Set(board.map((o) => o.id)).size).toBe(board.length);
        for (const o of board) {
          expect(o.reward.credits).toBeGreaterThan(0);
          expect(o.need).toBeGreaterThan(0);
          expect(objectiveText(o)).not.toContain('undefined');
          const sys = getSystem(o.system);
          if (o.kind === 'deliver') {
            const hops = jumpsFrom(sysId)[o.system];
            expect(hops).toBeGreaterThan(0);
            expect(hops).toBeLessThanOrEqual(o.tier);
          }
          else if (o.kind === 'freight') expect(jumpsFrom(sysId)[o.system]).toBeGreaterThanOrEqual(2);
          else expect(o.system).toBe(sysId);
          if (o.planet !== undefined) {
            const pl = sys.planets[o.planet];
            if (o.kind === 'hunt') expect([FAUNA[pl.type]?.[1], FAUNA_SEA[pl.type]?.[1]]).toContain(o.species);
            if (o.site !== undefined) expect(o.kind === 'survey' ? ['ruin', 'wreck'] : ['base']).toContain(planetSites(pl)[o.site].kind);
          }
        }
      }
    }
  });

  it('ranks, reputation levels and stored careers', () => {
    expect(rankOf(0)).toBe(0);
    expect(rankOf(899)).toBe(1);
    expect(rankOf(900)).toBe(2);
    expect(rankOf(1e9)).toBe(RANKS.length - 1);
    expect([-100, -50, -49, -10, 24, 25, 60].map(repLevel)).toEqual([0, 0, 1, 2, 2, 3, 4]);
    const c = validCareer({ xp: 120.7, rep: { fed: 500, guild: 'x' }, active: [{ id: 'bad' }], done: ['a', 3] });
    expect(c).toEqual({ xp: 120, rep: { fed: 100, guild: 0, pirate: 0 }, active: [], done: ['a'] });
    expect(validCareer(null)).toEqual(newCareer());
    const o = generateBoard(0, 1)[0];
    expect(validCareer({ active: [{ ...o, have: 1 }] }).active[0]).toEqual({ ...o, have: 1 });
    const navy = item('suit-navy')!;
    expect(repOk(navy, { fed: 24, guild: 0, pirate: 0 })).toBe(false);
    expect(repOk(navy, { fed: 25, guild: 0, pirate: 0 })).toBe(true);
    expect(repOk(item('suit-white')!, { fed: -100, guild: -100, pirate: -100 })).toBe(true);
  });
});

describe('weather', () => {
  const sys0 = getSystem(0);
  it('each planet gets its own kind of storm on a deterministic schedule', () => {
    for (const pl of sys0.planets) {
      let storms = 0, calm = 0, full = 0;
      for (let t = 0; t < WINDOW * 40; t += 7) {
        const w = weatherAt(pl, t);
        expect(weatherAt(pl, t)).toEqual(w);
        if (w.kind === 'clear') calm++;
        else { storms++; expect(w.kind).toBe(STORM_OF[pl.type]); if (w.k >= 1) full++; }
      }
      expect(storms).toBeGreaterThan(50);
      expect(calm).toBeGreaterThan(storms);
      expect(full).toBeGreaterThan(10);
      // airless worlds have no wind
      if (!pl.atmo) expect(vlen(weatherAt(pl, 1234).wind)).toBe(0);
    }
  });

  it('the forecast agrees with the weather', () => {
    const pl = sys0.planets.find((p) => p.type === 'ice')!;
    for (let t = 100; t < WINDOW * 12; t += 53) {
      const f = forecast(pl, t)!;
      expect(f).toBeTruthy();
      expect(f.kind).toBe('blizzard');
      if (f.active) {
        expect(weatherAt(pl, t).kind).toBe('blizzard');
        expect(weatherAt(pl, t + f.inSec + 0.5).kind).toBe('clear');
      } else {
        expect(weatherAt(pl, t).kind).toBe('clear');
        expect(weatherAt(pl, t + f.inSec + 0.5).kind).toBe('blizzard');
      }
    }
    // a dev override wins while it lasts
    expect(weatherAt(pl, 10, { kind: 'blizzard', k: 0.7, until: 20 }).k).toBe(0.7);
    expect(weatherAt(pl, 10, { kind: 'clear', k: 1, until: 20 }).kind).toBe('clear');
  });

  it('wind pushes a pilot along the ground, the same way every time', () => {
    const pl = sys0.planets.find((p) => p.type === 'terran')!;
    const run = () => {
      // a dry spot
      let d = vnorm(v3(), v3(0.3, 0.8, 0.5));
      for (let i = 0; i < 200 && heightAt(pl, d.x, d.y, d.z) < 4; i++) d = vnorm(v3(), v3(Math.sin(i * 1.7), Math.cos(i * 2.3), Math.sin(i * 0.9 + 1)));
      const c = newChar(vscale(v3(), d, pl.radius + footHeight(pl, d.x, d.y, d.z)), vnorm(v3(), v3(1, 0, 0)));
      const w = vscale(v3(), vnorm(v3(), v3(-0.4, 0.1, 0.9)), 18);
      const p0 = { ...c.p };
      for (let i = 0; i < 60; i++) stepChar(c, emptyCharInput(), pl, DT, DEFAULT_GEAR, { wind: w });
      return { moved: vdist(p0, c.p), along: (c.p.x - p0.x) * w.x + (c.p.y - p0.y) * w.y + (c.p.z - p0.z) * w.z, p: c.p };
    };
    const a = run(), b = run();
    expect(a.p).toEqual(b.p);
    expect(a.moved).toBeGreaterThan(1);
    expect(a.along).toBeGreaterThan(0);
  });

  it('protection modules: gear stats and older look codes', () => {
    expect(gearStats({ ...defaultOutfit(), mod: 'mod-thermo' }).thermal).toBe(0.85);
    expect(gearStats({ ...defaultOutfit(), mod: 'mod-wanderer' })).toMatchObject({ thermal: 0.6, filter: 0.6, shielding: 0.6 });
    const old = 'suit-orange.helmet-dome.visor-gold.pack-plss.chest-dcm.lights-none.patch-flag';
    expect(parseLook(old).mod).toBe('mod-none');
    expect(parseLook(old).suit).toBe('suit-orange');
    expect(parseLook(lookCode({ ...defaultOutfit(), mod: 'mod-rad' })).mod).toBe('mod-rad');
  });
});

describe('wrecks', () => {
  const sys0 = getSystem(0);
  it('every planet has a crashed ship, placed after the older sites', () => {
    for (const pl of sys0.planets) {
      const sites = planetSites(pl);
      const first = sites.findIndex((s) => s.kind === 'wreck');
      expect(first).toBeGreaterThan(0);
      expect(sites.slice(first).every((s) => s.kind === 'wreck')).toBe(true);
      for (const s of sites.slice(first)) {
        expect(s.hull!.length).toBeGreaterThan(5);
        expect(wreckZone(s, s.goal.x, s.goal.z)).toBe('bridge');
        expect(s.caches.length).toBe(4);
      }
    }
  });

  it('walls hold, the roof is a ceiling inside and a floor on top', () => {
    const pl = sys0.planets.find((p) => planetSites(p).some((s) => s.kind === 'wreck'))!;
    const s = planetSites(pl).find((x) => x.kind === 'wreck')!;
    const at = (x: number, z: number, lift = 0.05) => {
      const d = siteDir(pl, s, x, z);
      return vscale(v3(), d, pl.radius + footHeight(pl, d.x, d.y, d.z) + lift);
    };
    // walking north from the hold runs into the hull wall
    const c = newChar(at(-4, 5), siteDir(pl, s, -4, 9));
    const f = vnorm(v3(), vsub(v3(), at(-4, 20), c.p));
    c.f = { ...f };
    for (let i = 0; i < 90; i++) stepChar(c, { ...emptyCharInput(), mz: 1 }, pl, DT);
    expect(wreckAt(pl, c.p)).toBeTruthy();
    // jetpacking inside stops under the roof
    const j = newChar(at(-4, 0), f);
    for (let i = 0; i < 60; i++) stepChar(j, { ...emptyCharInput(), jump: true }, pl, DT);
    const w = wreckAt(pl, j.p)!;
    expect(vlen(j.p)).toBeLessThan(w.roof - 1.9);
    // dropped onto the roof from above: stands on it
    const r = newChar(vscale(v3(), vnorm(v3(), at(-4, 0)), w.roof + 1), f);
    r.ground = 0;
    for (let i = 0; i < 60; i++) stepChar(r, emptyCharInput(), pl, DT);
    expect(vlen(r.p)).toBeCloseTo(w.roof, 1);
    expect(r.ground).toBe(1);
  });
});

describe('station deck', () => {
  it('walls hold and every terminal can be reached on foot from the ramp', () => {
    // walk into the hangar's side wall
    const c = newChar(v3(RAMP.x, 0, RAMP.z), v3(1, 0, 0));
    for (let i = 0; i < 200; i++) stepDeck(c, { ...emptyCharInput(), mz: 1, sprint: true }, DT);
    expect(c.p.x).toBeLessThan(30);
    expect(c.p.x).toBeGreaterThan(29);
    // a flood fill over free floor cells from the ramp reaches all terminals
    const R = 0.5, step = 0.5;
    const free = (x: number, z: number) => {
      if (!roomAt(x, z)) return false;
      for (const o of DECK_POSTS) if (Math.hypot(x - o.x, z - o.z) < o.r + R) return false;
      for (const [x0, z0, x1, z1] of DECK_WALLS) {
        const ex = x1 - x0, ez = z1 - z0, t = Math.max(0, Math.min(1, ((x - x0) * ex + (z - z0) * ez) / (ex * ex + ez * ez)));
        if (Math.hypot(x - x0 - ex * t, z - z0 - ez * t) < R) return false;
      }
      return true;
    };
    const key = (x: number, z: number) => `${Math.round(x / step)},${Math.round(z / step)}`;
    const seen = new Set([key(RAMP.x, RAMP.z)]);
    const q: [number, number][] = [[RAMP.x, RAMP.z]];
    while (q.length) {
      const [x, z] = q.pop()!;
      for (const [dx, dz] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
        const nx = x + dx, nz = z + dz, k = key(nx, nz);
        if (seen.has(k) || !free(nx, nz)) continue;
        seen.add(k);
        q.push([nx, nz]);
      }
    }
    for (const t of TERMINALS) {
      const near = [...seen].some((k) => { const [i, j] = k.split(',').map(Number); return Math.hypot(i * step - t.x, j * step - t.z) < TERMINAL_REACH - 0.3; });
      expect(near, t.kind).toBe(true);
    }
  });
});
