/**
 * Planet weather: a deterministic schedule of storms per planet (from its seed
 * and the server time), so the server, client prediction and the renderer all
 * agree without any network traffic. Each planet type has its own storm with
 * its own hazard to the suit; gear modules protect against them.
 */
import type { PlanetDef, PlanetType } from './galaxy/system-gen.ts';
import { hashFloat } from './math/rng.ts';
import { v3, type V3 } from './math/vec.ts';

export type WeatherKind = 'clear' | 'storm' | 'blizzard' | 'sandstorm' | 'acid' | 'ash' | 'radiation';
export type Hazard = 'lightning' | 'cold' | 'dust' | 'acid' | 'heat' | 'rad';
/** Gear stat that protects against a hazard (0..1). */
export type Protection = 'thermal' | 'filter' | 'shielding';
export const HAZARD_GEAR: Record<Exclude<Hazard, 'lightning'>, Protection> = { cold: 'thermal', heat: 'thermal', dust: 'filter', acid: 'filter', rad: 'shielding' };
export const HAZARD_NAMES: Record<Hazard, string> = { lightning: 'молнии', cold: 'холод', dust: 'абразия', acid: 'кислота', heat: 'жара', rad: 'радиация' };

export interface WeatherDef {
  name: string;
  hazard: Hazard | null;
  /** Suit damage per second at full strength, unprotected. */
  rate: number;
  /** Visibility (m) at full strength (0 = unchanged). */
  visibility: number;
  /** Wind speed (m/s) at full strength. */
  wind: number;
  /** Fog / particle tint. */
  color: string;
  icon: string;
}
export const WEATHER: Record<Exclude<WeatherKind, 'clear'>, WeatherDef> = {
  storm: { name: 'Гроза', hazard: 'lightning', rate: 0, visibility: 320, wind: 14, color: '#5a6470', icon: '⚡' },
  blizzard: { name: 'Метель', hazard: 'cold', rate: 2.5, visibility: 70, wind: 18, color: '#c8d4e2', icon: '❄' },
  sandstorm: { name: 'Песчаная буря', hazard: 'dust', rate: 2, visibility: 50, wind: 20, color: '#b08a58', icon: '≋' },
  acid: { name: 'Кислотный дождь', hazard: 'acid', rate: 2.5, visibility: 160, wind: 8, color: '#7a9a4a', icon: '☣' },
  ash: { name: 'Пеплопад', hazard: 'heat', rate: 2.5, visibility: 120, wind: 6, color: '#4a3a34', icon: '♨' },
  radiation: { name: 'Радиационная буря', hazard: 'rad', rate: 3.5, visibility: 0, wind: 0, color: '#c8ff6a', icon: '☢' },
};
/** The storm each planet type gets. */
export const STORM_OF: Record<PlanetType, Exclude<WeatherKind, 'clear'>> = {
  terran: 'storm', ocean: 'storm', ice: 'blizzard', desert: 'sandstorm', alien: 'acid', lava: 'ash', barren: 'radiation',
};
/** Mild heat everywhere on lava worlds, storm or not. */
export const LAVA_HEAT = 0.5;

/** Weather windows (s); a storm comes in a window with this chance and ramps in and out. */
export const WINDOW = 300;
export const STORM_CHANCE = 0.45;
const RAMP = 40;

export interface WeatherOverride { kind: WeatherKind; k: number; until: number }
export interface Weather {
  kind: WeatherKind;
  /** Strength 0..1. */
  k: number;
  /** Wind in the planet's body frame (m/s). */
  wind: V3;
}

/** Storm span [start, end) within window `w`, or null for a calm window. */
function stormSpan(pl: PlanetDef, w: number): [number, number] | null {
  if (hashFloat(pl.seed, w, 0x3ea7) >= STORM_CHANCE) return null;
  const start = 15 + hashFloat(pl.seed, w, 0x51a7) * 70;
  const len = 140 + hashFloat(pl.seed, w, 0x1e9) * (WINDOW - 30 - start - 140);
  return [w * WINDOW + start, w * WINDOW + start + len];
}

/** Unit wind direction of window `w` (body frame). */
function windDir(pl: PlanetDef, w: number, out: V3): V3 {
  const a = hashFloat(pl.seed, w, 0x77) * Math.PI * 2, z = hashFloat(pl.seed, w, 0x78) * 2 - 1;
  const s = Math.sqrt(1 - z * z);
  out.x = Math.cos(a) * s; out.y = z; out.z = Math.sin(a) * s;
  return out;
}

/** Weather on planet `pl` at server time `t` (an override from the server wins while it lasts). */
export function weatherAt(pl: PlanetDef, t: number, ov?: WeatherOverride | null, out: Weather = { kind: 'clear', k: 0, wind: v3() }): Weather {
  const w = Math.floor(t / WINDOW);
  const storm = STORM_OF[pl.type];
  let kind: WeatherKind = 'clear', k = 0;
  if (ov && t < ov.until) {
    kind = ov.kind;
    k = ov.kind === 'clear' ? 0 : ov.k;
  } else {
    const span = stormSpan(pl, w);
    if (span && t >= span[0] && t < span[1]) {
      kind = storm;
      k = Math.max(0, Math.min(1, (t - span[0]) / RAMP, (span[1] - t) / RAMP));
    }
  }
  out.kind = kind;
  out.k = k;
  const speed = pl.atmo ? 2 + (kind === 'clear' ? 0 : WEATHER[kind].wind * k) : 0;
  windDir(pl, w, out.wind);
  out.wind.x *= speed; out.wind.y *= speed; out.wind.z *= speed;
  return out;
}

/** What is coming: the current storm and when it ends, or the next one and when it starts. */
export function forecast(pl: PlanetDef, t: number): { kind: Exclude<WeatherKind, 'clear'>; active: boolean; inSec: number } | null {
  const w = Math.floor(t / WINDOW);
  for (let i = 0; i < 24; i++) {
    const span = stormSpan(pl, w + i);
    if (!span || t >= span[1]) continue;
    if (t >= span[0]) return { kind: STORM_OF[pl.type], active: true, inSec: span[1] - t };
    return { kind: STORM_OF[pl.type], active: false, inSec: span[0] - t };
  }
  return null;
}
