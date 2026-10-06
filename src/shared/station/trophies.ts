/**
 * Trophies a pilot collects while playing, shown in their cabin on every
 * station (see deck.ts CABIN). A trophy is just an id that says where it came
 * from; its name, description and look are derived from the id, so the
 * stored list stays tiny and old saves keep working when texts change.
 *
 *   relic:<system>:<planet>:<site>   first relic taken from a cache of ruins, a base or a wreck
 *   log:<system>:<planet>:<site>     a wreck's ship's log read on its bridge
 *   patch:kills:<n>                  shot down n ships (KILL_MARKS)
 *   patch:rank:<r>                   reached rank r
 *   medal:<faction>:<level>          reputation level friend (3) / ally (4) with a faction
 *   specimen:<species>               first bio samples of a species
 *   shard:<system>                   first anomaly scanned in a system
 */
import { FACTION_COLORS, FACTION_SHORT, FACTIONS, REP, REP_NAMES, repLevel, type Faction } from '../factions.ts';
import { RANKS, rankOf } from '../contracts.ts';
import { SPECIES } from '../fauna.ts';
import { SYSTEM_COUNT } from '../constants.ts';
import { getSystem } from '../galaxy/system-gen.ts';
import { planetSites, type SiteDef } from '../planet/sites.ts';

export type TrophyKind = 'relic' | 'log' | 'patch' | 'medal' | 'specimen' | 'shard';
export const TROPHY_KINDS: readonly TrophyKind[] = ['relic', 'log', 'patch', 'medal', 'specimen', 'shard'];
export const TROPHY_KIND_NAMES: Record<TrophyKind, string> = {
  relic: 'Реликты', log: 'Бортовые журналы', patch: 'Нашивки', medal: 'Награды фракций', specimen: 'Образцы фауны', shard: 'Осколки аномалий',
};
/** A collected trophy; `at` = when (ms since epoch). */
export interface Trophy { id: string; at: number }
export interface TrophyInfo {
  kind: TrophyKind;
  name: string;
  desc: string;
  /** Main tint of the model or emblem. */
  color: string;
  /** Second tint (ribbon, creature belly, ...). */
  color2: string;
  /** Which model variant (relics), the emblem number (patches). */
  variant: number;
  /** Wreck logs: where to find the text (see wreck-log.ts). */
  site?: { system: number; planet: number; site: number };
}

/** Kill counts that earn a patch. */
export const KILL_MARKS = [1, 10, 25, 50, 100, 250] as const;
const KILL_NAMES: Record<number, string> = { 1: 'Первая победа', 10: 'Десять сбитых', 25: 'Гроза пиратов', 50: 'Ас', 100: 'Сотня', 250: 'Легенда фронтира' };
/** Most trophies a pilot keeps (oldest relics and logs go first beyond this). */
export const TROPHY_MAX = 400;

const int = (s: string | undefined) => (s !== undefined && /^\d+$/.test(s) ? Number(s) : -1);

function siteOf(sys: number, planet: number, site: number): { s: SiteDef; planet: string; system: string } | null {
  if (sys < 0 || sys >= SYSTEM_COUNT) return null;
  const def = getSystem(sys);
  const pl = def.planets[planet];
  const s = pl ? planetSites(pl)[site] : undefined;
  return s ? { s, planet: pl.name, system: def.name } : null;
}

/** What a trophy id stands for (null: not a valid trophy). */
export function trophyInfo(id: string): TrophyInfo | null {
  const [kind, a, b, c] = id.split(':');
  switch (kind) {
    case 'relic': case 'log': {
      const at = siteOf(int(a), int(b), int(c));
      if (!at) return null;
      const where = `${at.planet}, система ${at.system}`;
      if (kind === 'log') {
        const ship = at.s.name.replace(/^Разбитый\s*/, '');
        return { kind, name: `Журнал ${ship}`, desc: `Снят с мостика разбитого корабля. ${where}.`, color: '#3ce0ff', color2: '#1a2a30', variant: at.s.seed % 3, site: { system: int(a), planet: int(b), site: int(c) } };
      }
      const from = at.s.kind === 'ruin' ? 'Найден в руинах' : at.s.kind === 'wreck' ? 'Найден в трюме разбитого корабля' : 'Взят на пиратской базе';
      const hue = (at.s.seed % 360) / 360;
      return { kind, name: `Реликт: ${at.s.name}`, desc: `${from}. ${where}.`, color: hsl(hue, 0.7, 0.6), color2: '#b89a5a', variant: at.s.seed % 3 };
    }
    case 'patch': {
      if (a === 'kills') {
        const n = int(b);
        if (!KILL_MARKS.includes(n as (typeof KILL_MARKS)[number])) return null;
        return { kind, name: `Нашивка «${KILL_NAMES[n]}»`, desc: n === 1 ? 'Первый сбитый корабль.' : `Сбито кораблей: ${n}.`, color: '#c8302a', color2: '#ffd24a', variant: KILL_MARKS.indexOf(n as (typeof KILL_MARKS)[number]) };
      }
      if (a === 'rank') {
        const r = int(b);
        if (r < 1 || r >= RANKS.length) return null;
        return { kind, name: `Нашивка звания «${RANKS[r].name}»`, desc: `Получено звание ${RANKS[r].name}.`, color: '#24407a', color2: '#e8c060', variant: 10 + r };
      }
      return null;
    }
    case 'medal': {
      const f = a as Faction, lvl = int(b);
      if (!FACTIONS.includes(f) || (lvl !== REP.friend && lvl !== REP.ally)) return null;
      const metal = lvl === REP.ally ? '#ffd24a' : '#c8ccd2';
      return { kind, name: `${lvl === REP.ally ? 'Золотая' : 'Серебряная'} медаль: ${FACTION_SHORT[f]}`, desc: `Репутация «${REP_NAMES[lvl]}» у фракции ${FACTION_SHORT[f]}.`, color: metal, color2: FACTION_COLORS[f], variant: lvl };
    }
    case 'specimen': {
      const sp = SPECIES[int(a)];
      if (!sp || sp.drone) return null;
      return { kind, name: `Образец: ${sp.name}`, desc: `${sp.predator ? 'Хищник' : 'Травоядное'}, ${sp.aquatic ? 'морской вид' : 'наземный вид'}. Первые биообразцы этого вида.`, color: sp.colors[0], color2: sp.colors[2], variant: sp.id };
    }
    case 'shard': {
      const sys = int(a);
      if (sys < 0 || sys >= SYSTEM_COUNT) return null;
      const def = getSystem(sys);
      return { kind, name: `Осколок аномалии: ${def.name}`, desc: `Первая аномалия, просканированная в системе ${def.name}.`, color: def.star.color, color2: '#9ad8ff', variant: sys % 3 };
    }
    default:
      return null;
  }
}

/** Adds a trophy if it is new and valid; returns its info then. */
export function addTrophy(list: Trophy[], id: string, at: number): TrophyInfo | null {
  if (list.some((t) => t.id === id)) return null;
  const info = trophyInfo(id);
  if (!info) return null;
  list.push({ id, at });
  // over the cap the oldest relics and logs give way (patches and medals stay)
  while (list.length > TROPHY_MAX) {
    const i = list.findIndex((t) => t.id.startsWith('relic:') || t.id.startsWith('log:'));
    list.splice(i < 0 ? 0 : i, 1);
  }
  return info;
}

/** Trophies earned by the pilot's numbers (kills, rank, reputation) that they do not have yet. */
export function milestoneTrophies(list: Trophy[], kills: number, xp: number, rep: Record<Faction, number>): string[] {
  const out: string[] = [];
  for (const n of KILL_MARKS) if (kills >= n) out.push(`patch:kills:${n}`);
  for (let r = 1; r <= rankOf(xp); r++) out.push(`patch:rank:${r}`);
  for (const f of FACTIONS) {
    const lvl = repLevel(rep[f] ?? 0);
    if (lvl >= REP.friend) out.push(`medal:${f}:${REP.friend}`);
    if (lvl >= REP.ally) out.push(`medal:${f}:${REP.ally}`);
  }
  return out.filter((id) => !list.some((t) => t.id === id));
}

/** Trophies from stored JSON (tolerating old or damaged data). */
export function validTrophies(raw: unknown): Trophy[] {
  const out: Trophy[] = [];
  if (!Array.isArray(raw)) return out;
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const { id, at } = t as Record<string, unknown>;
    if (typeof id !== 'string' || out.some((x) => x.id === id) || !trophyInfo(id)) continue;
    out.push({ id, at: typeof at === 'number' && Number.isFinite(at) ? at : 0 });
  }
  return out.slice(-TROPHY_MAX);
}

function hsl(h: number, s: number, l: number): string {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
