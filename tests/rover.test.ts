import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanetDef } from '../src/shared/galaxy/system-gen.ts';
import { qlook, qrot, quat, v3, vdot, vlen, vnorm } from '../src/shared/math/vec.ts';
import { DT } from '../src/shared/constants.ts';
import { emptyCharInput, type CharInput } from '../src/shared/sim/character.ts';

/**
 * Rover physics on synthetic ground: a plane through the planet's north pole that can be
 * tilted (`slope`, rise per metre along +x) and roughened (`bumps`, metres), plus optional
 * tree trunks. The real terrain and props are swapped out so every case is exact.
 */
const ground = { slope: 0, bumps: 0, trees: [] as { x: number; z: number; r: number }[] };
const R = 4000;
vi.mock('../src/shared/planet/terrain.ts', async (orig) => ({
  ...(await orig<typeof import('../src/shared/planet/terrain.ts')>()),
  heightAt: (_p: PlanetDef, x: number, _y: number, z: number) => {
    const mx = x * R, mz = z * R;
    return ground.slope * mx + ground.bumps * Math.sin(mx * 0.9) * Math.sin(mz * 0.7);
  },
}));
vi.mock('../src/shared/planet/prop-rules.ts', async (orig) => ({
  ...(await orig<typeof import('../src/shared/planet/prop-rules.ts')>()),
  collidersNear: () => ground.trees.map((t) => {
    const d = vnorm(v3(), v3(t.x / R, 1, t.z / R));
    return { x: d.x * R, y: d.y * R, z: d.z * R, r: t.r, top: 8 };
  }),
}));

const { newRover, stepRover, roverOverturned, rightRover, ROVER, copyRover, roverWheelLengths } = await import('../src/shared/sim/rover.ts');

const planet = { radius: R, gravity: 9.8, sea: false, type: 'terran', index: 0, seed: 1 } as unknown as PlanetDef;
type Rover = ReturnType<typeof newRover>;
let cur: Rover;

/** A rover at plane point (x, z) facing `heading` (radians from -z towards +x), dropped from `drop` m. */
function spawn(x = 0, z = 0, heading = 0, drop = 0.3): Rover {
  const d = vnorm(v3(), v3(x / R, 1, z / R));
  const g = R + ground.slope * x;
  const f = v3(Math.sin(heading), 0, -Math.cos(heading));
  const up = ground.slope ? vnorm(v3(), v3(-ground.slope, 1, 0)) : d;
  // rest the wheels on the (possibly tilted) ground: offset along its normal, not the radial
  const k = 0.87 + drop;
  const fu = vdot(f, up);
  return cur = newRover(v3(d.x * g + up.x * k, d.y * g + up.y * k, d.z * g + up.z * k), qlook(quat(), vnorm(v3(), v3(f.x - up.x * fu, f.y - up.y * fu, f.z - up.z * fu)), up));
}
/** Steps the most recently spawned rover. */
const run = (ticks: number, inp: Partial<CharInput> = {}, r = cur) => { for (let k = 0; k < ticks; k++) stepRover(r, { ...emptyCharInput(), ...inp }, planet, DT); };
const fwdSpeed = (r: Rover) => vdot(qrot(v3(), r.q, v3(0, 0, -1)), r.v);
const tilt = (r: Rover) => Math.acos(Math.min(1, vdot(qrot(v3(), r.q, v3(0, 1, 0)), vnorm(v3(), r.p)))) * 180 / Math.PI;
const heading = (r: Rover) => { const f = qrot(v3(), r.q, v3(0, 0, -1)); return Math.atan2(f.x, -f.z); };

beforeEach(() => { ground.slope = 0; ground.bumps = 0; ground.trees = []; });

describe('rover physics', () => {
  it('settles on its springs and stays put', () => {
    const r = spawn();
    run(90);
    expect(r.ground).toBe(4);
    expect(vlen(r.v)).toBeLessThan(0.02);
    expect(tilt(r)).toBeLessThan(0.5);
    // sag under its own weight lands the wheels where the model draws them
    for (const l of r.susp) expect(Math.abs(l - ROVER.modelLen)).toBeLessThan(0.06);
  });

  it('accelerates to top speed, boosts beyond it and brakes to a stop', () => {
    const r = spawn();
    run(30);
    run(90, { mz: 1 });
    expect(fwdSpeed(r)).toBeGreaterThan(ROVER.topSpeed * 0.7);
    run(150, { mz: 1 });
    expect(fwdSpeed(r)).toBeGreaterThan(ROVER.topSpeed * 0.95);
    expect(fwdSpeed(r)).toBeLessThan(ROVER.topSpeed * 1.05);
    run(150, { mz: 1, sprint: true });
    expect(fwdSpeed(r)).toBeGreaterThan(ROVER.topSpeed * 1.25);
    // braking is grip-limited (~1 g): 23 m/s gone in under three seconds (held longer, S reverses)
    run(80, { mz: -1 });
    expect(Math.abs(fwdSpeed(r))).toBeLessThan(1.5);
    run(60);
    expect(vlen(r.v)).toBeLessThan(0.1);
    expect(r.ground).toBe(4);
  });

  it('reverses slowly', () => {
    const r = spawn();
    run(30);
    run(120, { mz: -1 });
    expect(fwdSpeed(r)).toBeLessThan(-ROVER.reverseSpeed * 0.8);
    expect(fwdSpeed(r)).toBeGreaterThan(-ROVER.reverseSpeed * 1.1);
  });

  it('steers: right turns right, the front wheels angle in, and it stays on its wheels', () => {
    const r = spawn();
    run(30);
    run(60, { mz: 1 });
    const h0 = heading(r);
    run(60, { mz: 0.6, mx: 1 });
    expect(r.steer).toBeLessThan(-0.15);
    expect(heading(r) - h0).toBeGreaterThan(0.6);
    expect(roverOverturned(r)).toBe(false);
    run(60, { mz: 0.6, mx: -1 });
    expect(r.steer).toBeGreaterThan(0.15);
  });

  it('holds on a moderate slope with no throttle and climbs it', () => {
    ground.slope = 0.25;
    const r = spawn(0, 0, Math.PI / 2);
    run(60);
    const p0 = { ...r.p };
    run(90);
    expect(Math.hypot(r.p.x - p0.x, r.p.y - p0.y, r.p.z - p0.z)).toBeLessThan(0.3);
    run(150, { mz: 1 });
    expect(fwdSpeed(r)).toBeGreaterThan(5);
    expect(roverOverturned(r)).toBe(false);
  });

  it('stays on its wheels driving across a 40° slope', () => {
    ground.slope = 0.85;
    spawn(0, 0, 0, 0.05);
    run(120, { mz: 0.5 });
    expect(roverOverturned(cur)).toBe(false);
  });

  it('falls on its side when tipped past its tipping angle, and can be put back on its wheels', () => {
    // tipping angle: atan(half track / centre of mass height) ≈ 53°; lean it 62° on flat ground
    const r = spawn(0, 0, 0, 0.4);
    const a = 62 * Math.PI / 180;
    r.q = qlook(quat(), v3(0, 0, -1), v3(Math.sin(a), Math.cos(a), 0));
    run(120);
    expect(roverOverturned(r)).toBe(true);
    expect(tilt(r)).toBeGreaterThan(80);
    // and one leaning less than that drops back onto its wheels
    const s = spawn(0, 0, 0, 0.4);
    const b = 40 * Math.PI / 180;
    s.q = qlook(quat(), v3(0, 0, -1), v3(Math.sin(b), Math.cos(b), 0));
    run(120);
    expect(roverOverturned(s)).toBe(false);
    rightRover(r, planet);
    run(90, {}, r);
    expect(roverOverturned(r)).toBe(false);
    expect(r.ground).toBe(4);
  });

  it('soaks up bumps at speed without leaving the ground for long', () => {
    ground.bumps = 0.25;
    const r = spawn();
    run(30);
    let air = 0;
    for (let k = 0; k < 300; k++) { run(1, { mz: 1 }); if (!r.ground) air++; }
    expect(air).toBeLessThan(40);
    expect(roverOverturned(r)).toBe(false);
    expect(fwdSpeed(r)).toBeGreaterThan(8);
    expect(new Set(r.susp.map((l) => l.toFixed(2))).size).toBeGreaterThan(1);
  });

  it('stops at a tree and glances off it', () => {
    ground.trees = [{ x: 0, z: -30, r: 0.5 }];
    const r = spawn();
    run(30);
    run(150, { mz: 1 });
    // the nose never passes the trunk
    expect(r.p.z / vlen(r.p) * R).toBeGreaterThan(-30 + 0.5);
    ground.trees = [{ x: 1.2, z: -30, r: 0.5 }];
    const s = spawn();
    run(30);
    const h0 = heading(s);
    for (let k = 0; k < 150; k++) stepRover(s, { ...emptyCharInput(), mz: 1 }, planet, DT);
    expect(Math.abs(heading(s) - h0)).toBeGreaterThan(0.05);
  });

  it('is deterministic (client prediction replays it exactly)', () => {
    ground.bumps = 0.2;
    const a = spawn(), b = copyRover(newRover(v3(), quat()), a);
    const inputs: Partial<CharInput>[] = [{ mz: 1 }, { mz: 1, mx: 0.5 }, { mz: -1 }, { jump: true }, {}];
    for (let k = 0; k < 200; k++) {
      const i = inputs[k % 5];
      stepRover(a, { ...emptyCharInput(), ...i }, planet, DT);
      stepRover(b, { ...emptyCharInput(), ...i }, planet, DT);
    }
    expect(b.p).toEqual(a.p);
    expect(b.q).toEqual(a.q);
  });

  it('estimates wheel drop for remote rovers like the simulation', () => {
    const r = spawn();
    run(90);
    const out = [0, 0, 0, 0];
    roverWheelLengths(planet, r.p, r.q, out);
    for (let i = 0; i < 4; i++) expect(Math.abs(out[i] - r.susp[i])).toBeLessThan(0.05);
  });
});

