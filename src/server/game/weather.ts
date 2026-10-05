import { hashInts, Rng } from '../../shared/math/rng.ts';
import { v3, vdist, vnorm, vscale, type V3 } from '../../shared/math/vec.ts';
import { MODE } from '../../shared/net/protocol.ts';
import { footHeight, liquidOf } from '../../shared/planet/terrain.ts';
import { planetRot, toBodyDir } from '../../shared/sim/frames.ts';
import {
  HAZARD_GEAR, HAZARD_NAMES, LAVA_HEAT, WEATHER, weatherAt, type Hazard, type Weather, type WeatherKind, type WeatherOverride,
} from '../../shared/weather.ts';
import type { Session } from './session.ts';
import type { SystemInstance } from './system.ts';

/** Suit damage per second below which the suit still repairs itself. */
const MINOR = 0.5;
const STRIKE_HIT = 5;
const STRIKE_DMG = 30;
const tmp = v3(), rot = { x: 0, y: 0, z: 0, w: 1 };

/**
 * Weather hazards on the planets of a system: suit damage from storms (less
 * with protective gear, none in shelter), lightning strikes near pilots, and
 * dev overrides that clients are told about.
 */
export class WeatherDesk {
  private overrides = new Map<number, WeatherOverride>();
  private nextStrike = new Map<number, number>();
  private warned = new Map<number, number>();
  private rng: Rng;
  private w: Weather = { kind: 'clear', k: 0, wind: v3() };

  constructor(private sys: SystemInstance) {
    this.rng = new Rng(hashInts(sys.def.seed, 0x3ea7));
  }

  /** Weather on planet `planet` at time `t` (dev overrides included). */
  at(planet: number, t: number, out?: Weather): Weather {
    return weatherAt(this.sys.def.planets[planet], t, this.overrides.get(planet), out);
  }

  /** Dev: force a weather on a planet for a while; everyone in the system is told. */
  override(planet: number, kind: WeatherKind, k: number, seconds = 600) {
    const ov = { kind, k: Math.max(0, Math.min(1, k)), until: this.sys.time + seconds };
    this.overrides.set(planet, ov);
    this.sys.events.push({ t: 'weather', planet, ...ov });
  }

  /** Overrides still in force (sent to pilots who arrive later). */
  activeOverrides() {
    return [...this.overrides].filter(([, o]) => o.until > this.sys.time).map(([planet, o]) => ({ planet, ...o }));
  }

  /**
   * Shelter from the weather at a body-frame point of a planet: inside a derelict's hull
   * (its reactor room aside) nothing but the reactor reaches the pilot.
   */
  sheltered(planet: number, p: V3): boolean {
    return this.sys.shelter(planet, p);
  }

  /** Called a couple of times a second. */
  step(dt: number) {
    const t = this.sys.time;
    for (const s of this.sys.sessions) {
      const ch = s.char;
      if (s.mode !== MODE.FOOT || !ch || ch.planet < 0) continue;
      const pl = this.sys.def.planets[ch.planet];
      const w = this.at(ch.planet, t, this.w);
      const g = s.gear();
      const under = ch.state.swim === 2;
      const inside = this.sheltered(ch.planet, ch.state.p);
      let total = 0, worst: Hazard = 'cold', worstDps = 0;
      const add = (hazard: Exclude<Hazard, 'lightning'>, rate: number) => {
        if (rate <= 0) return;
        const dps = rate * (1 - g[HAZARD_GEAR[hazard]]);
        if (dps > worstDps) { worst = hazard; worstDps = dps; }
        total += dps;
      };
      if (w.kind !== 'clear') {
        const def = WEATHER[w.kind];
        const hz = def.hazard;
        if (hz && hz !== 'lightning' && !inside && (!under || hz === 'cold')) {
          // radiation storms burn only on the day side
          if (hz !== 'rad' || this.sunlit(ch.planet, ch.state.p)) add(hz, def.rate * w.k);
        }
      }
      if (liquidOf(pl) === 'lava' && !inside) add('heat', LAVA_HEAT);
      add('rad', this.sys.reactorDose(ch.planet, ch.state.p));
      if (total <= 0) continue;
      const cause = HAZARD_NAMES[worst];
      this.sys.fauna.hazard(s, total * dt, total > MINOR, cause);
      // a word of warning when the suit starts to suffer
      if (total > MINOR && t - (this.warned.get(s.id) ?? -1e9) > 25) {
        this.warned.set(s.id, t);
        s.msg(`Скафандр повреждается: ${cause} (−${total.toFixed(1)}/с). Укройтесь или наденьте защитный модуль.`, 'warn');
      }
    }
    this.lightning();
  }

  private sunlit(planet: number, p: V3): boolean {
    const pl = this.sys.def.planets[planet];
    const sun = vnorm(tmp, { x: this.sys.def.star.pos.x - pl.center.x, y: this.sys.def.star.pos.y - pl.center.y, z: this.sys.def.star.pos.z - pl.center.z });
    const sb = toBodyDir(planetRot(pl, this.sys.time, rot), sun, v3());
    const l = Math.hypot(p.x, p.y, p.z) || 1;
    return (p.x * sb.x + p.y * sb.y + p.z * sb.z) / l > 0.05;
  }

  /** Thunderstorms strike near pilots on foot every few seconds. */
  private lightning() {
    const t = this.sys.time;
    const byPlanet = new Map<number, Session[]>();
    for (const s of this.sys.sessions) {
      if (s.mode !== MODE.FOOT || !s.char || s.char.planet < 0) continue;
      const list = byPlanet.get(s.char.planet) ?? [];
      list.push(s);
      byPlanet.set(s.char.planet, list);
    }
    for (const [planet, list] of byPlanet) {
      const w = this.at(planet, t, this.w);
      if (w.kind !== 'storm' || w.k < 0.5) continue;
      const due = this.nextStrike.get(planet) ?? 0;
      if (t < due) continue;
      this.nextStrike.set(planet, t + this.rng.range(3, 6) / w.k);
      this.strike(planet, this.rng.pick(list));
    }
  }

  /** A bolt near pilot `s` (sometimes very near); anyone within a few metres is hurt. */
  strike(planet: number, s: Session, at?: V3) {
    const pl = this.sys.def.planets[planet];
    const ch = s.char!;
    let p = at;
    if (!p) {
      const close = this.rng.chance(0.15);
      const d = close ? this.rng.range(3, 10) : this.rng.range(25, 90), a = this.rng.range(0, Math.PI * 2);
      const up = vnorm(v3(), ch.state.p);
      const e = vnorm(v3(), { x: -up.z, y: 0, z: up.x });
      const n = { x: up.y * e.z - up.z * e.y, y: up.z * e.x - up.x * e.z, z: up.x * e.y - up.y * e.x };
      const q = vnorm(v3(), {
        x: ch.state.p.x + (e.x * Math.cos(a) + n.x * Math.sin(a)) * d,
        y: ch.state.p.y + (e.y * Math.cos(a) + n.y * Math.sin(a)) * d,
        z: ch.state.p.z + (e.z * Math.cos(a) + n.z * Math.sin(a)) * d,
      });
      p = vscale(v3(), q, pl.radius + footHeight(pl, q.x, q.y, q.z));
    }
    this.sys.events.push({ t: 'strike', planet, pos: [p.x, p.y, p.z] });
    for (const o of this.sys.sessions) {
      const oc = o.char;
      if (o.mode !== MODE.FOOT || !oc || oc.planet !== planet) continue;
      if (vdist(oc.state.p, p) > STRIKE_HIT || oc.state.swim === 2 || this.sheltered(planet, oc.state.p)) continue;
      this.sys.fauna.hurt(o, STRIKE_DMG, 0);
      o.msg('Удар молнии!', 'warn');
    }
  }
}
