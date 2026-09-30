import { describe, expect, it } from 'vitest';
import {
  buildChunkLike, cubeToSphere, decodeInput, decodeShots, decodeSnapshot, emptyCharInput, emptyInput, encodeInput, encodeShots,
  encodeSnapshot, flightStats, defaultUpgrades, generateSystem, getSystem, heightAt, leadPoint, MODE, newChar, newShip, nodesNear,
  noiseFor, qlook, quantizeInput, resourceNode, segmentSphere, SHIP_LAND_HEIGHT, stepChar, stepShip, surfaceHeight, v3, vdist, vlen, vnorm,
  type ShipInput, type SimEnv, Rng, DT, cloneShip, CRUISE_SPOOL,
} from './helpers.ts';

const sys = getSystem(0);
const env: SimEnv = { star: sys.star, planets: sys.planets, fields: sys.fields, station: sys.station };
const stats = flightStats(defaultUpgrades());

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
      expect(s.gates.length).toBe(2);
      expect(s.fields.length).toBeGreaterThanOrEqual(1);
      for (const p of s.planets) {
        expect(vdist(s.station.pos, p.center)).toBeGreaterThan(p.radius * 1.5);
      }
    }
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
      seq: 0, mode: MODE.SHIP, flags: rng.chance(0.3) ? 2 : 0,
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
    // dive at full throttle
    const dive = { ...emptyInput(), throttle: 1 };
    for (let k = 0; k < 200; k++) {
      stepShip(s, dive, stats, env, DT);
      const d = vnorm(v3(), v3(s.p.x - p.center.x, s.p.y - p.center.y, s.p.z - p.center.z));
      const ground = p.radius + surfaceHeight(p, d.x, d.y, d.z);
      expect(vdist(s.p, p.center) - ground).toBeGreaterThan(stats.radius * 0.5 - 1e-6);
    }
    // cut throttle and descend gently -> should land
    const down = { ...emptyInput(), strafeY: -0.3 };
    for (let k = 0; k < 600 && !s.landed; k++) stepShip(s, down, stats, env, DT);
    expect(s.landed).toBe(p.index + 1);
    const d = vnorm(v3(), v3(s.p.x - p.center.x, s.p.y - p.center.y, s.p.z - p.center.z));
    expect(vdist(s.p, p.center) - (p.radius + surfaceHeight(p, d.x, d.y, d.z))).toBeCloseTo(SHIP_LAND_HEIGHT, 5);
    // throttle up -> takes off
    stepShip(s, { ...emptyInput(), throttle: 0.5 }, stats, env, DT);
    expect(s.landed).toBe(0);
  });

  it('settles and lands by itself with idle controls near the ground', () => {
    const p = sys.planets[1];
    const dir = vnorm(v3(), v3(-0.4, 0.7, 0.6));
    const g = p.radius + surfaceHeight(p, dir.x, dir.y, dir.z) + 60;
    const s = newShip(v3(p.center.x + dir.x * g, p.center.y + dir.y * g, p.center.z + dir.z * g));
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

describe('character simulation', () => {
  it('walks on the surface and lands after a jump', () => {
    const p = sys.planets[1];
    const d = vnorm(v3(), v3(0.2, 0.9, 0.3));
    const g = p.radius + surfaceHeight(p, d.x, d.y, d.z);
    const c = newChar(v3(p.center.x + d.x * g, p.center.y + d.y * g, p.center.z + d.z * g), vnorm(v3(), v3(1, 0, 0)));
    const walk = { ...emptyCharInput(), mz: 1 };
    const start = { ...c.p };
    for (let k = 0; k < 90; k++) stepChar(c, walk, p, DT);
    expect(vdist(c.p, start)).toBeGreaterThan(8);
    stepChar(c, { ...emptyCharInput(), jump: true }, p, DT);
    expect(c.ground).toBe(0);
    for (let k = 0; k < 200; k++) stepChar(c, emptyCharInput(), p, DT);
    expect(c.ground).toBe(1);
    const dd = vnorm(v3(), v3(c.p.x - p.center.x, c.p.y - p.center.y, c.p.z - p.center.z));
    expect(vdist(c.p, p.center) - (p.radius + surfaceHeight(p, dd.x, dd.y, dd.z))).toBeCloseTo(0, 5);
  });
});

describe('protocol', () => {
  it('round-trips inputs with quantisation', () => {
    const m = { seq: 42, mode: MODE.SHIP, flags: 5, ship: { ...emptyInput(), yaw: 0.5, throttle: -0.2, strafeY: 1 }, char: emptyCharInput() };
    const d = decodeInput(encodeInput(m));
    expect(d.seq).toBe(42);
    expect(d.ship.yaw).toBeCloseTo(0.5, 2);
    expect(d.ship.cruise).toBe(true);
    expect(quantizeInput(d)).toEqual(d);
  });

  it('round-trips snapshots exactly for own state', () => {
    const ship = newShip(v3(123456.789, -9876.54321, 42.4242));
    ship.v = v3(1.5, 2.5, -3.25); ship.boost = 0.3333; ship.cruise = 1.234; ship.landed = 2;
    const char = newChar(v3(1, 2, 3), v3(0, 0, -1));
    const snap = {
      tick: 99, time: 12.5, ack: 77,
      self: { shipId: 5, mode: MODE.FOOT, teleport: 3, ship, hull: 90, maxHull: 100, shield: 12.5, maxShield: 80, energy: 55, missiles: 4, charId: 9, char, charPlanet: 1 },
      entities: [{ id: 7, kind: 1, flags: 3, px: 1000.5, py: 2, pz: 3, qx: 0, qy: 0.7071, qz: 0, qw: 0.7071, vx: 10, vy: 0, vz: -5, hull: 0.5, shield: 1, throttle: 0.25 }],
    };
    const d = decodeSnapshot(encodeSnapshot(snap));
    expect(d.self.ship).toEqual(ship);
    expect(d.self.char).toEqual(char);
    expect(d.ack).toBe(77);
    expect(d.entities[0].px).toBeCloseTo(1000.5, 3);
    expect(d.entities[0].qy).toBeCloseTo(0.7071, 3);
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
