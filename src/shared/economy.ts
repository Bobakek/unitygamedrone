import { BASE_STATS, type ShipStats } from './sim/ship.ts';
import type { ResourceType } from './planet/resources.ts';

export type UpgradeKey = 'weapons' | 'shields' | 'hull' | 'engine' | 'cargo';
export const UPGRADE_KEYS: readonly UpgradeKey[] = ['weapons', 'shields', 'hull', 'engine', 'cargo'];
export type Upgrades = Record<UpgradeKey, number>;
export const MAX_LEVEL = 4;
/** Cost to buy level N (index = target level). */
export const UPGRADE_COST = [0, 0, 450, 1300, 3200];

/** Everything a hold can carry: mined resources plus biological samples from fauna. */
export type CargoKey = ResourceType | 'bio';
export const CARGO_KEYS: readonly CargoKey[] = ['ore', 'crystal', 'relic', 'bio'];
export const CARGO_NAMES: Record<CargoKey, string> = { ore: 'Руда', crystal: 'Кристаллы', relic: 'Реликты', bio: 'Биообразцы' };
export const PRICES: Record<CargoKey, number> = { ore: 14, crystal: 38, relic: 140, bio: 30 };
export const REPAIR_COST_PER_HP = 1.5;
export const MISSILE_COST = 35;
export const MAX_MISSILES = 8;
export const BOUNTY = { npc: 90, player: 120 } as const;

export const defaultUpgrades = (): Upgrades => ({ weapons: 1, shields: 1, hull: 1, engine: 1, cargo: 1 });
export type Cargo = Record<CargoKey, number>;
export const emptyCargo = (): Cargo => ({ ore: 0, crystal: 0, relic: 0, bio: 0 });
export const cargoCount = (c: Cargo) => CARGO_KEYS.reduce((n, k) => n + (c[k] || 0), 0);
export const cargoValue = (c: Cargo) => CARGO_KEYS.reduce((n, k) => n + (c[k] || 0) * PRICES[k], 0);

export interface CombatStats {
  maxHull: number; maxShield: number; shieldRegen: number; laserDamage: number; cargoCap: number;
}

export function combatStats(u: Upgrades): CombatStats {
  return {
    maxHull: 100 + (u.hull - 1) * 45,
    maxShield: 80 + (u.shields - 1) * 40,
    shieldRegen: 9 + (u.shields - 1) * 3,
    laserDamage: 9 + (u.weapons - 1) * 3.5,
    cargoCap: 12 + (u.cargo - 1) * 10,
  };
}

export function flightStats(u: Upgrades): ShipStats {
  const e = u.engine - 1;
  return { ...BASE_STATS, maxSpeed: BASE_STATS.maxSpeed + e * 20, boostSpeed: BASE_STATS.boostSpeed + e * 30, accel: BASE_STATS.accel + e * 12, turn: BASE_STATS.turn + e * 0.1 };
}

/** NPC pirate stats — slightly weaker than a starter player ship. */
export const PIRATE_FLIGHT: ShipStats = { ...BASE_STATS, maxSpeed: 200, boostSpeed: 330, turn: 1.25, radius: 7 };
export const PIRATE_COMBAT: CombatStats = { maxHull: 80, maxShield: 50, shieldRegen: 6, laserDamage: 6, cargoCap: 0 };
/** Convoy freighter: slow, tough, unarmed. */
export const FREIGHTER_FLIGHT: ShipStats = { ...BASE_STATS, maxSpeed: 75, boostSpeed: 110, accel: 30, turn: 0.35, roll: 0.6, radius: 26 };
/** Outpost flak turret: static, sturdy, short bursts. */
export const TURRET_FLIGHT: ShipStats = { ...BASE_STATS, maxSpeed: 0, boostSpeed: 0, accel: 0, turn: 0, roll: 0, cruiseSpeed: 0, radius: 3.2 };
export const TURRET_COMBAT: CombatStats = { maxHull: 170, maxShield: 60, shieldRegen: 5, laserDamage: 6, cargoCap: 0 };
export const BASE_BOUNTY = 450;
export const FREIGHTER_COMBAT: CombatStats = { maxHull: 950, maxShield: 320, shieldRegen: 8, laserDamage: 0, cargoCap: 0 };
