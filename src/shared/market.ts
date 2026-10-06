import { SYSTEM_COUNT } from './constants.ts';
import { CARGO_KEYS, PRICES, type CargoKey } from './economy.ts';
import { getSystem, type PlanetType } from './galaxy/system-gen.ts';
import { hashInts, Rng } from './math/rng.ts';
import { planetSites } from './planet/sites.ts';

/**
 * Station markets. Every system values goods by what its worlds produce: a system rich in
 * lava and airless worlds and asteroid fields is flush with ore and pays little for it, one
 * full of living worlds has biosamples to spare, and so on. Everything follows from the
 * generated systems, however many there are: systems are ranked against each other, the
 * richest in a good pay the least for it and also sell it (the station's exports), the
 * poorest pay the most, so hauling goods through the gates pays. On top of that prices
 * drift every epoch (10 minutes, like the contract board) and react to trade: selling a
 * good floods the market and lowers the price, buying raises it; both fade with time.
 */

/** A price change of a good per unit bought (+) or sold (−) at a station. */
export const MARKET_ELASTICITY = 0.015;
/** Half-life (s) of the effect of trade on prices. */
export const MARKET_HALF_LIFE = 480;
/** The station sells its export goods this much above its buying price. */
export const MARKET_SPREAD = 1.2;
/** Price multipliers from the system with the most of a good to the one with the least. */
export const MARKET_RANGE: readonly [number, number] = [0.7, 1.4];
/** Systems in this top share of the galaxy's supply of a good sell it. */
export const EXPORT_SHARE = 0.34;
/** Prices drift by up to this much (±) each epoch. */
export const MARKET_DRIFT = 0.12;

/** What a good of the station costs right now. `buy` is absent when the station does not sell it. */
export interface Quote { sell: number; buy?: number }
export interface MarketQuote { system: number; goods: Record<CargoKey, Quote> }
/** Market data sent to docked pilots: this station and the others; `next` = ms to the next drift. */
export interface MarketMsg { here: MarketQuote; others: MarketQuote[]; next: number }

const ORE: Partial<Record<PlanetType, number>> = { lava: 2, barren: 2, desert: 1.5, ice: 0.8, alien: 0.5, terran: 0.4, ocean: 0.2 };
const CRYSTAL: Partial<Record<PlanetType, number>> = { ice: 2, alien: 1.6, lava: 1.2, barren: 1, desert: 0.6, terran: 0.3, ocean: 0.3 };
const BIO: Partial<Record<PlanetType, number>> = { terran: 2, ocean: 2, alien: 1.6, desert: 0.6, ice: 0.6 };

/** Range of a station's industry: how much of its raw goods it refines itself. */
const INDUSTRY: readonly [number, number] = [0.25, 1.75];

/** How much of each good a system produces (arbitrary units). */
export function supplyOf(system: number): Record<CargoKey, number> {
  const d = getSystem(system);
  const out: Record<CargoKey, number> = { ore: d.fields.length * 1.5, crystal: d.fields.length * 0.5, relic: 0, bio: 0, ingot: 0, optics: 0, parts: 0 };
  for (const p of d.planets) {
    out.ore += ORE[p.type] ?? 0;
    out.crystal += CRYSTAL[p.type] ?? 0;
    out.bio += BIO[p.type] ?? 0;
    // relics come from ruins and crashed ships
    for (const s of planetSites(p)) out.relic += s.kind === 'ruin' ? 1 : s.kind === 'wreck' ? 1.5 : 0;
  }
  // refined goods: made from what the system mines, more where the station has big smelters
  const industry = INDUSTRY[0] + (INDUSTRY[1] - INDUSTRY[0]) * new Rng(hashInts(d.seed, 0x5e17)).float();
  out.ingot = out.ore * industry;
  out.optics = out.crystal * industry;
  out.parts = (out.ore + out.crystal) * 0.5 * industry;
  return out;
}

export interface MarketProfile {
  /** Price multiplier per good (low where the good is plentiful). */
  mult: Record<CargoKey, number>;
  /** Goods the station sells. */
  exports: CargoKey[];
}

const profiles = new Map<number, MarketProfile>();

/** The lasting character of a system's market, ranked against the other systems. */
export function marketProfile(system: number): MarketProfile {
  const hit = profiles.get(system);
  if (hit) return hit;
  // what a system is rich in relative to its other goods (big and small systems alike specialise)
  const raw = Array.from({ length: SYSTEM_COUNT }, (_, i) => supplyOf(i));
  const mean = (k: CargoKey) => raw.reduce((n, r) => n + r[k], 0) / raw.length || 1;
  const supply = raw.map((r) => {
    const norm = CARGO_KEYS.map((k) => r[k] / mean(k));
    const avg = norm.reduce((a, b) => a + b, 0) / norm.length || 1;
    return Object.fromEntries(CARGO_KEYS.map((k, j) => [k, norm[j] / avg])) as Record<CargoKey, number>;
  });
  const mult = {} as Record<CargoKey, number>;
  const exports: CargoKey[] = [];
  let best: CargoKey = 'ore', bestRank = Infinity;
  for (const k of CARGO_KEYS) {
    // rank 0 = has the most of it (ties go to the lower system id)
    const rank = supply.filter((s, i) => s[k] > supply[system][k] || (s[k] === supply[system][k] && i < system)).length;
    const t = SYSTEM_COUNT > 1 ? rank / (SYSTEM_COUNT - 1) : 0.5;
    mult[k] = MARKET_RANGE[0] + (MARKET_RANGE[1] - MARKET_RANGE[0]) * t;
    // the third of the galaxy richest in a good exports it
    if (t <= EXPORT_SHARE) exports.push(k);
    if (rank < bestRank) { bestRank = rank; best = k; }
  }
  // every station sells at least something: its most plentiful good
  if (!exports.length) exports.push(best);
  const p = { mult, exports };
  profiles.set(system, p);
  return p;
}

/** Price drift of a good in an epoch, a factor around 1. */
export function marketDrift(system: number, epoch: number, k: CargoKey): number {
  const rng = new Rng(hashInts(getSystem(system).seed, 0x3a7e, epoch, CARGO_KEYS.indexOf(k)));
  return 1 + (rng.float() * 2 - 1) * MARKET_DRIFT;
}

/** Effect of recent trade: `pressure` = units sold minus units bought (decayed). */
export const pressureFactor = (pressure: number) => Math.max(0.5, Math.min(1.5, 1 - MARKET_ELASTICITY * pressure));

/** Current prices of a station; `mods` = multipliers from galaxy events (see galaxy-events.ts). */
export function marketQuote(
  system: number, epoch: number, pressure: Partial<Record<CargoKey, number>> = {}, mods: Partial<Record<CargoKey, number>> = {},
): MarketQuote {
  const prof = marketProfile(system);
  const goods = {} as Record<CargoKey, Quote>;
  for (const k of CARGO_KEYS) {
    const sell = Math.max(1, Math.round(PRICES[k] * prof.mult[k] * marketDrift(system, epoch, k) * pressureFactor(pressure[k] ?? 0) * (mods[k] ?? 1)));
    goods[k] = prof.exports.includes(k) ? { sell, buy: Math.max(sell + 1, Math.round(sell * MARKET_SPREAD)) } : { sell };
  }
  return { system, goods };
}
