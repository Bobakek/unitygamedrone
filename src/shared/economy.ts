import { BASE_STATS, type ShipStats } from './sim/ship.ts';
import type { ResourceType } from './planet/resources.ts';

export type UpgradeKey = 'weapons' | 'shields' | 'hull' | 'engine' | 'cargo';
export const UPGRADE_KEYS: readonly UpgradeKey[] = ['weapons', 'shields', 'hull', 'engine', 'cargo'];
export type Upgrades = Record<UpgradeKey, number>;
export const MAX_LEVEL = 4;
/** Cost to buy level N (index = target level). */
export const UPGRADE_COST = [0, 0, 450, 1300, 3200];

export const PRICES: Record<ResourceType, number> = { ore: 14, crystal: 38, relic: 140 };
export const REPAIR_COST_PER_HP = 1.5;
export const MISSILE_COST = 35;
export const MAX_MISSILES = 8;
export const BOUNTY = { npc: 90, player: 120 } as const;

export const defaultUpgrades = (): Upgrades => ({ weapons: 1, shields: 1, hull: 1, engine: 1, cargo: 1 });
export type Cargo = Record<ResourceType, number>;
export const emptyCargo = (): Cargo => ({ ore: 0, crystal: 0, relic: 0 });
export const cargoCount = (c: Cargo) => c.ore + c.crystal + c.relic;

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
