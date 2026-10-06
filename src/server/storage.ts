import type { Cargo, Upgrades } from '../shared/economy.ts';
import type { Outfit } from '../shared/outfit.ts';
import type { Career } from '../shared/contracts.ts';
import type { Trophy } from '../shared/station/trophies.ts';
import type { HullKey } from '../shared/ships/hulls.ts';

/** Browser-safe pilot storage contract (SQLite on the server, localStorage in offline mode). */
export interface PilotRecord {
  id: number; name: string; token: string; credits: number; cargo: Cargo; upgrades: Upgrades;
  missiles: number; kills: number; deaths: number; system: number;
  /** Bought suit parts and what the pilot wears. */
  items: string[]; outfit: Outfit;
  /** Experience, reputation and contracts. */
  career: Career;
  /** Trophies shown in the pilot's cabin. */
  trophies: Trophy[];
  /** The ship class flown and the ships owned (always including the fighter). */
  ship: HullKey; ships: HullKey[];
}

export interface PilotStorage {
  find(name: string): PilotRecord | null;
  create(name: string): PilotRecord;
  save(p: PilotRecord): void;
}
