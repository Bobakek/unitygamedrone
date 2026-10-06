import { describe, expect, it } from 'vitest';
import {
  DT, defaultUpgrades, emptyInput, flightStats, newAutopilot, newShip, qlook, steerTo, stepShip, v3, vdist, vlen, vsub,
  type SimEnv, type V3,
} from './helpers.ts';

// Open space: no planets or rocks, station and star far away.
const env: SimEnv = {
  star: { color: '#fff', radius: 10, pos: v3(1e7, 0, 0) },
  planets: [], fields: [],
  station: { name: 'S', pos: v3(-1e7, 0, 0), radius: 160, planet: 0 },
  time: 0,
};

function fly(cls: 'fighter' | 'hauler', start: V3, look: V3, target: (t: number) => V3, tv: V3, range: number, seconds: number) {
  const st = flightStats(defaultUpgrades(), cls);
  const s = newShip(start);
  qlook(s.q, look, v3(0, 1, 0));
  const ap = newAutopilot();
  const inp = emptyInput();
  let maxSpeed = 0, cruised = false;
  for (let k = 0; k < seconds / DT; k++) {
    steerTo(s.p, s.v, s.q, target(k * DT), tv, range, st, ap, inp);
    stepShip(s, inp, st, env, DT);
    maxSpeed = Math.max(maxSpeed, vlen(s.v));
    cruised ||= inp.cruise;
  }
  const tp = target(seconds);
  return { s, dist: vdist(s.p, tp), rel: vlen(vsub(v3(), s.v, tv)), maxSpeed, cruised };
}

describe('auto-approach', () => {
  it('reaches a target behind the ship and holds weapon range', () => {
    const r = fly('fighter', v3(0, 0, 0), v3(0, 0, -1), () => v3(300, 800, 4000), v3(), 600, 60);
    expect(Math.abs(r.dist - 600)).toBeLessThan(40);
    expect(r.rel).toBeLessThan(10);
  });

  it('keeps pace with a moving target', () => {
    const tv = v3(80, 0, 30);
    const r = fly('fighter', v3(0, 0, 0), v3(1, 0, 0), (t) => v3(2000 + tv.x * t, 500, tv.z * t), tv, 600, 90);
    expect(Math.abs(r.dist - 600)).toBeLessThan(80);
  });

  it('closes in to boarding range with almost no relative speed', () => {
    const r = fly('hauler', v3(0, 0, 0), v3(0, 0, -1), () => v3(-1500, 0, -900), v3(), 90, 80);
    expect(Math.abs(r.dist - 90)).toBeLessThan(30);
    expect(r.rel).toBeLessThan(15);
  });

  it('uses the cruise drive for long hauls and drops out of it near the target', () => {
    const r = fly('fighter', v3(0, 0, 0), v3(0, 0, -1), () => v3(0, 0, -60000), v3(), 400, 70);
    expect(r.cruised).toBe(true);
    expect(r.maxSpeed).toBeGreaterThan(1000);
    expect(Math.abs(r.dist - 400)).toBeLessThan(60);
  });
});

describe('combat orbit', () => {
  it('circles the target at gun range instead of sitting still', () => {
    const st = flightStats(defaultUpgrades(), 'fighter');
    const s = newShip(v3(0, 0, 0));
    const tp = v3(0, 0, -2000), ap = newAutopilot(), inp = emptyInput();
    const dirs: V3[] = [];
    for (let k = 0; k < 90 / DT; k++) {
      steerTo(s.p, s.v, s.q, tp, v3(), 600, st, ap, inp, undefined, 0.7);
      stepShip(s, inp, st, env, DT);
      if (k * DT > 30 && k % 30 === 0) dirs.push(vsub(v3(), s.p, tp));
    }
    expect(Math.abs(vdist(s.p, tp) - 600)).toBeLessThan(60);
    // the bearing from the target keeps changing: the ship moves around it
    const a = dirs[0], b = dirs.at(-1)!;
    expect(Math.acos((a.x * b.x + a.y * b.y + a.z * b.z) / (vlen(a) * vlen(b)))).toBeGreaterThan(0.5);
  });
});
