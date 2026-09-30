import type { Cargo, Upgrades } from '../shared/economy.ts';

/** Browser-safe pilot storage contract (SQLite on the server, localStorage in offline mode). */
export interface PilotRecord {
  id: number; name: string; token: string; credits: number; cargo: Cargo; upgrades: Upgrades;
  missiles: number; kills: number; deaths: number; system: number;
}

export interface PilotStorage {
  find(name: string): PilotRecord | null;
  create(name: string): PilotRecord;
  save(p: PilotRecord): void;
}
