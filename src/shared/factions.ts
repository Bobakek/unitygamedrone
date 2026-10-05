/** Factions and reputation levels (no dependencies, so any shared module can use them). */
export type Faction = 'fed' | 'guild' | 'pirate';
export const FACTIONS: readonly Faction[] = ['fed', 'guild', 'pirate'];
export const FACTION_NAMES: Record<Faction, string> = { fed: 'Федерация', guild: 'Гильдия старателей', pirate: 'Синдикат «Чёрная звезда»' };
export const FACTION_SHORT: Record<Faction, string> = { fed: 'Федерация', guild: 'Гильдия', pirate: 'Синдикат' };
export const FACTION_COLORS: Record<Faction, string> = { fed: '#5aa0ff', guild: '#ffb43a', pirate: '#ff4a5a' };

export const REP_NAMES = ['Враг', 'Недруг', 'Нейтралитет', 'Друг', 'Союзник'] as const;
/** Lowest reputation of each level. */
export const REP_MIN = [-100, -49, -10, 25, 60] as const;
export const REP = { enemy: 0, unfriendly: 1, neutral: 2, friend: 3, ally: 4 } as const;
export const repLevel = (v: number) => (v >= 60 ? 4 : v >= 25 ? 3 : v >= -10 ? 2 : v > -50 ? 1 : 0);
export const clampRep = (v: number) => Math.max(-100, Math.min(100, Math.round(v)));
/** Pirates leave pilots they are friends with alone (until provoked). */
export const PIRATE_FRIENDLY = REP_MIN[REP.friend];
/** Below this Federation standing the pilot is wanted: other pilots earn a bonus for the kill. */
export const WANTED_BELOW = -25;
export const WANTED_BOUNTY = 200;
