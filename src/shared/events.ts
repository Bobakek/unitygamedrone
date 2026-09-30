import { CARGO_KEYS, CARGO_NAMES, type Cargo } from './economy.ts';

/**
 * Dynamic points of interest ("world events") announced by the server:
 * pirate convoys, derelict wrecks and energy anomalies in space.
 */
export type PoiKind = 'convoy' | 'wreck' | 'anomaly';

export interface Poi {
  id: number;
  kind: PoiKind;
  name: string;
  /** World position (for a convoy: its freighter). */
  pos: [number, number, number];
  radius: number;
  /** Server time when the event ends. */
  until: number;
  seed: number;
  /** Salvage charges left (wrecks). */
  charges?: number;
  /** Convoy freighter entity id (0 once destroyed). */
  ship?: number;
}

/** Loot container contents (credits and/or cargo). */
export interface LootContents { credits: number; cargo: Partial<Cargo> }

export const LOOT_PICKUP = 45;
export const SALVAGE_RANGE = 160;
export const SALVAGE_MAX_SPEED = 40;
export const ANOMALY_SCAN_TIME = 8;

export const EVENT_REWARD = {
  freighterBounty: 420,
  salvageCredits: [60, 150] as [number, number],
  anomalyCredits: 180,
} as const;

export const POI_LABEL: Record<PoiKind, string> = {
  convoy: 'Конвой',
  wreck: 'Обломки',
  anomaly: 'Аномалия',
};

export function describeLoot(l: LootContents): string {
  const parts: string[] = [];
  if (l.credits) parts.push(`+${l.credits} кр`);
  for (const k of CARGO_KEYS) if (l.cargo[k]) parts.push(`${CARGO_NAMES[k].toLowerCase()} ×${l.cargo[k]}`);
  return parts.join(', ');
}
