import { GALAXY_SEED, SYSTEM_COUNT } from './constants.ts';
import { CARGO_KEYS, CARGO_NAMES, PRICES, type CargoKey } from './economy.ts';
import { getGalaxy, jumpsFrom } from './galaxy/galaxy.ts';
import { getSystem } from './galaxy/system-gen.ts';
import { hashInts, Rng } from './math/rng.ts';
import type { ContractDef } from './contracts.ts';

/**
 * Galaxy events: a pirate raid on a station, a meteor storm, a shortage of a good. They are
 * scheduled from the wall clock alone (like the contract board), so every system has them,
 * asleep or not, and a restart changes nothing. What they do everywhere: prices at the hit
 * station (and a little at its neighbours) and urgent contracts on the boards around it.
 * In a system someone is flying in they also happen for real: raiders attack, meteors hit
 * ships and leave fragments to collect (see server/game/galaxy-effects.ts).
 */

export type GalaxyEventKind = 'raid' | 'storm' | 'shortage';
export const GALAXY_EVENT_KINDS: readonly GalaxyEventKind[] = ['raid', 'storm', 'shortage'];

export interface GalaxyEvent {
  id: number;
  kind: GalaxyEventKind;
  system: number;
  /** Shortage: the good that ran out. */
  good?: CargoKey;
  /** Wall clock, ms. */
  start: number;
  end: number;
}

/** A new event may start in each slot. */
export const EVENT_SLOT_MS = 4 * 60 * 1000;
/** Chance that a slot has an event. */
const EVENT_CHANCE = 0.6;
/** Event length, minutes. */
const EVENT_MINUTES: readonly [number, number] = [12, 26];
/** Slots to look back: an event never outlives this many. */
const LOOKBACK = Math.ceil((EVENT_MINUTES[1] * 60000 + EVENT_SLOT_MS / 2) / EVENT_SLOT_MS);

/** Price multipliers at the station of the event and (`near`) at its neighbours. */
export const EVENT_PRICES = {
  raid: 1.25,
  storm: { ore: 1.6, crystal: 1.5 } as Partial<Record<CargoKey, number>>,
  shortage: 2,
  shortageNear: 1.25,
} as const;

export const EVENT_NAMES: Record<GalaxyEventKind, string> = { raid: 'Пиратский набег', storm: 'Метеоритный шторм', shortage: 'Дефицит' };
export const EVENT_ICONS: Record<GalaxyEventKind, string> = { raid: '☠', storm: '☄', shortage: '▼' };

/** The event a slot would start, before checking it against earlier ones. */
function rawEvent(slot: number): GalaxyEvent | null {
  const rng = new Rng(hashInts(GALAXY_SEED, 0x9e7e, slot));
  if (!rng.chance(EVENT_CHANCE)) return null;
  const roll = rng.float();
  const kind: GalaxyEventKind = roll < 0.35 ? 'raid' : roll < 0.65 ? 'storm' : 'shortage';
  const stars = getGalaxy().stars;
  // pirates raid the border and the frontier; the core only rarely
  const pool = kind === 'raid' && !rng.chance(0.15) ? stars.filter((s) => s.security !== 'core').map((s) => s.id) : stars.map((s) => s.id);
  const system = pool.length ? rng.pick(pool) : rng.int(0, SYSTEM_COUNT - 1);
  const start = slot * EVENT_SLOT_MS + rng.int(0, EVENT_SLOT_MS / 2);
  const end = start + Math.round(rng.range(EVENT_MINUTES[0], EVENT_MINUTES[1]) * 60000);
  const e: GalaxyEvent = { id: slot, kind, system, start, end };
  if (kind === 'shortage') e.good = rng.pick(CARGO_KEYS);
  return e;
}

/** An earlier event in the same system is still going when this one would start. */
function clashes(e: GalaxyEvent): boolean {
  for (let s = e.id - LOOKBACK; s < e.id; s++) {
    const o = rawEvent(s);
    if (o && o.system === e.system && o.end > e.start) return true;
  }
  return false;
}

/** Events going on at `now` (ms) across the galaxy. */
export function galaxyEventsAt(now: number): GalaxyEvent[] {
  const n = Math.floor(now / EVENT_SLOT_MS);
  const out: GalaxyEvent[] = [];
  for (let s = n - LOOKBACK; s <= n; s++) {
    const e = rawEvent(s);
    if (e && now >= e.start && now < e.end && !clashes(e)) out.push(e);
  }
  return out;
}

/** The next events to come after `now` (for tests and the dev command). */
export function upcomingEvents(now: number, count: number): GalaxyEvent[] {
  const out: GalaxyEvent[] = [];
  for (let s = Math.floor(now / EVENT_SLOT_MS); out.length < count && s < Math.floor(now / EVENT_SLOT_MS) + 500; s++) {
    const e = rawEvent(s);
    if (e && e.start > now && !clashes(e)) out.push(e);
  }
  return out;
}

/** How events change the prices of a station: a multiplier per good. */
export function eventPriceMods(system: number, events: readonly GalaxyEvent[]): Record<CargoKey, number> {
  const mods = Object.fromEntries(CARGO_KEYS.map((k) => [k, 1])) as Record<CargoKey, number>;
  const near = getGalaxy().links[system] ?? [];
  for (const e of events) {
    if (e.system === system) {
      if (e.kind === 'raid') for (const k of CARGO_KEYS) mods[k] *= EVENT_PRICES.raid;
      if (e.kind === 'storm') for (const k of CARGO_KEYS) mods[k] *= EVENT_PRICES.storm[k] ?? 1;
      if (e.kind === 'shortage' && e.good) mods[e.good] *= EVENT_PRICES.shortage;
    } else if (e.kind === 'shortage' && e.good && near.includes(e.system)) {
      mods[e.good] *= EVENT_PRICES.shortageNear;
    }
  }
  return mods;
}

// ---------------------------------------------------------------- text
type EventWhat = Pick<GalaxyEvent, 'kind' | 'system' | 'good'>;

export function eventTitle(e: EventWhat): string {
  return e.kind === 'shortage' ? `Дефицит: ${CARGO_NAMES[e.good ?? 'ore'].toLowerCase()}` : EVENT_NAMES[e.kind];
}

/** One line of galaxy news. */
export function eventText(e: EventWhat): string {
  const sys = getSystem(e.system);
  switch (e.kind) {
    case 'raid': return `Пираты атакуют станцию ${sys.station.name} в системе ${sys.name}. Станция платит за всё дороже, Федерация хорошо платит за сбитых налётчиков.`;
    case 'storm': return `Метеоритный шторм в системе ${sys.name}: обломки бьют по кораблям. В космосе летают осколки с рудой, а станция дорого платит за руду и кристаллы.`;
    case 'shortage': return `На станции ${sys.station.name} (${sys.name}) кончились ${CARGO_NAMES[e.good ?? 'ore'].toLowerCase()}: цена выросла вдвое, соседи ищут, кто довезёт.`;
  }
}

// ---------------------------------------------------------------- contracts
const round10 = (v: number) => Math.round(v / 10) * 10;

/** Urgent offers the events put on the board of `sysId` (their own system and the neighbours). */
export function eventOffers(sysId: number, events: readonly GalaxyEvent[]): ContractDef[] {
  const out: ContractDef[] = [];
  const here = getSystem(sysId);
  const hops = jumpsFrom(sysId);
  for (const e of events) {
    const at = getSystem(e.system), jumps = hops[e.system];
    const id = (k: string) => `${sysId}-ev${e.id}-${k}`;
    if (e.kind === 'raid') {
      if (e.system === sysId) {
        out.push({
          id: id('def'), kind: 'pirates', faction: 'fed', tier: 1, system: sysId, need: 4, event: 'raid',
          title: 'Отбить набег на станцию',
          desc: `Пираты атакуют станцию ${here.station.name}. Собьите 4 налётчика у станции или где угодно в системе. Федерация платит втрое.`,
          reward: { credits: 950, xp: 160, rep: 10 }, side: { pirate: -6 },
        });
      } else if (jumps === 1) {
        out.push({
          id: id('fix'), kind: 'deliver', faction: 'guild', tier: 1, system: e.system, cargo: 'ore', need: 8, event: 'raid',
          title: `Срочно: ремонт станции ${at.station.name}`,
          desc: `Станцию ${at.station.name} в соседней системе ${at.name} громят пираты. Довезите руду ×8 на ремонт, пока набег не кончился, и не попадитесь налётчикам.`,
          reward: { credits: round10(8 * PRICES.ore * 4 + 200), xp: 140, rep: 9 },
        });
      }
    } else if (e.kind === 'storm' && e.system === sysId) {
      out.push({
        id: id('ore'), kind: 'supply', faction: 'guild', tier: 1, system: sysId, cargo: 'ore', need: 8, event: 'storm',
        title: 'Шторм: руда для щитов станции',
        desc: `Метеоритный шторм бьёт по станции ${here.station.name}. Нужна руда ×8 на заплатки, осколки метеоритов в системе тоже годятся.`,
        reward: { credits: round10(8 * PRICES.ore * 3.5 + 150), xp: 120, rep: 8 },
      });
    } else if (e.kind === 'shortage' && e.good) {
      const g = e.good, name = CARGO_NAMES[g].toLowerCase();
      const need = g === 'relic' ? 3 : g === 'ore' ? 10 : 6;
      if (e.system === sysId) {
        out.push({
          id: id('sup'), kind: 'supply', faction: 'guild', tier: 1, system: sysId, cargo: g, need, event: 'shortage',
          title: `Дефицит: ${name}`,
          desc: `На станции ${here.station.name} кончились ${name}. Сдайте ${name} ×${need} при стыковке, можно частями.`,
          reward: { credits: round10(need * PRICES[g] * 2.6 + 100), xp: 140, rep: 9 },
        });
      } else if (jumps >= 1 && jumps <= 2) {
        out.push({
          id: id('run'), kind: 'deliver', faction: 'guild', tier: jumps, system: e.system, cargo: g, need, event: 'shortage',
          title: `Срочная доставка в ${at.name}`,
          desc: `На станции ${at.station.name} (${jumps === 1 ? 'соседняя система' : '2 прыжка'}) кончились ${name}. Довезите ×${need}, маршрут на карте M.`,
          reward: { credits: round10((need * PRICES[g] * 3 + 150) * (1 + 0.5 * (jumps - 1))), xp: 160, rep: 10 },
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- network
/** An event as sent to clients: `left` = ms until it ends. */
export interface GalaxyEventInfo { id: number; kind: GalaxyEventKind; system: number; good?: CargoKey; left: number }

export const eventInfo = (e: GalaxyEvent, now: number): GalaxyEventInfo =>
  ({ id: e.id, kind: e.kind, system: e.system, good: e.good, left: Math.max(0, e.end - now) });
