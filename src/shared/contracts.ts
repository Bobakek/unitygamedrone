/**
 * Contracts, factions, reputation and pilot ranks. The station board is
 * generated deterministically per system and 10-minute epoch; what a pilot
 * has taken, their reputation and experience live in their `Career`.
 */
import { CARGO_KEYS, CARGO_NAMES, cargoCount, combatStats, PRICES, type Cargo, type CargoKey, type Upgrades } from './economy.ts';
import type { HullKey } from './ships/hulls.ts';
import type { Poi } from './events.ts';
import { FAUNA, FAUNA_SEA, SPECIES } from './fauna.ts';
import { getSystem, type PlanetDef } from './galaxy/system-gen.ts';
import { getGalaxy, jumpsFrom, SECURITY_NAMES, type Security } from './galaxy/galaxy.ts';
import { SYSTEM_COUNT } from './constants.ts';
import { hashInts, Rng } from './math/rng.ts';
import { planetSites } from './planet/sites.ts';
import { eventOffers, type GalaxyEvent, type GalaxyEventKind } from './galaxy-events.ts';
import { clampRep, FACTION_SHORT, FACTIONS, PIRATE_FRIENDLY, REP, repLevel, WANTED_BELOW, type Faction } from './factions.ts';

export * from './factions.ts';

// ---------------------------------------------------------------- ranks
export interface Rank { name: string; xp: number; slots: number; tier: number }
export const RANKS: readonly Rank[] = [
  { name: 'Курсант', xp: 0, slots: 2, tier: 1 },
  { name: 'Пилот', xp: 300, slots: 2, tier: 2 },
  { name: 'Лейтенант', xp: 900, slots: 3, tier: 2 },
  { name: 'Капитан', xp: 2000, slots: 3, tier: 3 },
  { name: 'Командор', xp: 4000, slots: 4, tier: 3 },
  { name: 'Адмирал', xp: 8000, slots: 4, tier: 3 },
];
export function rankOf(xp: number): number {
  let r = 0;
  while (r + 1 < RANKS.length && xp >= RANKS[r + 1].xp) r++;
  return r;
}
/** Lowest rank that may take contracts of a tier. */
export const rankForTier = (tier: number) => RANKS.findIndex((r) => r.tier >= tier);

// ---------------------------------------------------------------- contracts
export type ContractKind = 'hunt' | 'pirates' | 'clear' | 'intercept' | 'supply' | 'deliver' | 'survey' | 'smuggle' | 'freight';
export const CONTRACT_KINDS: readonly ContractKind[] = ['hunt', 'pirates', 'clear', 'intercept', 'supply', 'deliver', 'survey', 'smuggle', 'freight'];
export const KIND_NAMES: Record<ContractKind, string> = {
  hunt: 'Охота', pirates: 'Пираты', clear: 'Зачистка', intercept: 'Перехват',
  supply: 'Поставка', deliver: 'Доставка', survey: 'Разведка', smuggle: 'Контрабанда', freight: 'Грузоперевозка',
};

export interface ContractReward { credits: number; xp: number; rep: number }
export interface ContractDef {
  id: string;
  kind: ContractKind;
  faction: Faction;
  tier: number;
  title: string;
  desc: string;
  /** Target system (for deliveries: the destination). */
  system: number;
  planet?: number;
  species?: number;
  /** Site index within the planet (planetSites). */
  site?: number;
  cargo?: CargoKey;
  /** Convoy event id (intercept). */
  poi?: number;
  need: number;
  reward: ContractReward;
  /** Reputation change with other factions on completion. */
  side?: Partial<Record<Faction, number>>;
  /** Put on the board by a galaxy event (urgent, better paid). */
  event?: GalaxyEventKind;
  /** Freight: sealed containers loaded at `origin` and carried in the hold. */
  origin?: number;
  /** Freight: ms allowed from taking the contract to delivery. */
  time?: number;
  /** Freight: collateral paid when taken, returned on delivery, lost on failure. */
  deposit?: number;
  /** Urgent offers (galaxy events) pay more and give less time. */
  urgent?: boolean;
}
export interface ActiveContract extends ContractDef {
  have: number;
  /** Freight: server time (ms) the cargo must be delivered by. */
  due?: number;
}

export interface Career {
  xp: number;
  rep: Record<Faction, number>;
  active: ActiveContract[];
  /** Ids of finished offers (so the same offer is not taken twice). */
  done: string[];
}
export const newCareer = (): Career => ({ xp: 0, rep: { fed: 0, guild: 0, pirate: 0 }, active: [], done: [] });
const DONE_KEEP = 40;
const MAX_SLOTS = RANKS[RANKS.length - 1].slots;

export const BOARD_EPOCH_MS = 10 * 60 * 1000;
export const boardEpoch = (nowMs: number) => Math.floor(nowMs / BOARD_EPOCH_MS);
/** Distance from a site centre that counts as "arrived" (survey, smuggle). */
export const SITE_REACH = 30;

const XP = [0, 60, 140, 260];
const REP_GAIN = [0, 6, 9, 12];
const round10 = (v: number) => Math.round(v / 10) * 10;

// ---------------------------------------------------------------- freight
/** Containers per tier: tier 1 fits an upgraded fighter, the rest need a hauler. */
export const FREIGHT_SIZE = [0, 16, 32, 50];
/** Jumps to the destination per tier. */
export const FREIGHT_JUMPS: readonly [number, number][] = [[0, 0], [2, 3], [3, 4], [4, 6]];
/** Time allowed: a base plus this much per jump (ms). */
export const FREIGHT_TIME_BASE = 4 * 60_000;
export const FREIGHT_TIME_JUMP = 2.5 * 60_000;
/** Share of the reward paid back as a bonus for delivering with over half the time left. */
export const FREIGHT_FAST_BONUS = 0.2;
/** Share of the reward each group mate escorting the convoy gets on delivery. */
export const FREIGHT_ESCORT_SHARE = 0.15;
/** Standing lost with the Guild when freight is lost or late. */
export const FREIGHT_FAIL_REP = 8;
/** Chance of pirates waiting at the gate when a pilot with freight arrives, by zone of the system. */
export const FREIGHT_ARRIVAL_RISK: Record<Security, number> = { core: 0.12, mid: 0.4, frontier: 0.65 };
/** Chance per check (every FREIGHT_CHECK s in open space) of a raid on a pilot with freight. */
export const FREIGHT_RAID_RISK: Record<Security, number> = { core: 0.04, mid: 0.12, frontier: 0.22 };
export const FREIGHT_CHECK = 45;

/** Containers of contracted freight in a hold. */
export const freightLoad = (c: Career) => c.active.reduce((n, a) => n + (a.kind === 'freight' ? a.need - a.have : 0), 0);

/** What a hold needs to know: the ship's capacity, loose cargo and contracted freight. */
export interface Holder { cargo: Cargo; career: Career; upgrades: Upgrades; ship: HullKey }
/** Units used in the hold (loose cargo plus freight containers). */
export const holdUsed = (p: Holder) => cargoCount(p.cargo) + freightLoad(p.career);
/** Free room in the hold of the ship flown (`ship` to ask about another class). */
export const holdRoom = (p: Holder, ship: HullKey = p.ship) => combatStats(p.upgrades, ship).cargoCap - holdUsed(p);

/** "12:05" or "1:02:05" for a span of ms. */
export function clockText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/**
 * A long-haul freight offer from `from` to `target`: sealed containers that take hold
 * room, a deadline and a deposit. Galaxy events may make urgent ones (more pay, less time).
 */
export function freightOffer(from: number, target: number, tier: number, id: string, opts: { urgent?: boolean; reason?: string } = {}): ContractDef {
  const jumps = Math.max(1, jumpsFrom(from)[target]);
  const src = getSystem(from), dest = getSystem(target);
  const need = FREIGHT_SIZE[tier];
  const danger = getGalaxy().stars[target].security;
  const risk = danger === 'frontier' ? 1.35 : danger === 'mid' ? 1.15 : 1;
  const urgent = !!opts.urgent;
  const credits = round10((need * 26 + 200) * (1 + 0.45 * (jumps - 1)) * risk * (urgent ? 1.5 : 1));
  const time = Math.round((FREIGHT_TIME_BASE + FREIGHT_TIME_JUMP * jumps) * (urgent ? 0.7 : 1) / 1000) * 1000;
  const what = ['медикаменты', 'запчасти реакторов', 'продовольствие', 'оборудование шахт', 'почта и посылки', 'приборы связи'][hashInts(src.seed, target, tier) % 6];
  return {
    id, kind: 'freight', faction: 'guild', tier, system: target, origin: from, need, time, urgent: urgent || undefined,
    deposit: round10(credits * 0.3),
    title: `${urgent ? 'Срочный груз' : 'Грузоперевозка'}: ${dest.name}`,
    desc: `${opts.reason ? `${opts.reason} ` : ''}Опломбированные контейнеры (${what}) ×${need} — на станцию ${dest.station.name}, ${jumps} ${jumps < 5 ? 'прыжка' : 'прыжков'} (${SECURITY_NAMES[danger].toLowerCase()}), срок ${clockText(time)}. `
      + `Груз занимает трюм${need > 22 ? ', нужен «Тягач»' : ''}. Пираты охотятся за конвоями: берите группу в сопровождение. Залог возвращается при доставке.`,
    reward: { credits, xp: XP[tier] + 40 * (jumps - 1), rep: REP_GAIN[tier] + 2 },
  };
}

export const isWanted = (c: Career) => c.rep.fed < WANTED_BELOW;
export const isPirateFriend = (c: Career) => c.rep.pirate >= PIRATE_FRIENDLY;

/** Why a pilot cannot take an offer (null = can). */
export function cannotTake(def: ContractDef, c: Career): string | null {
  const rank = rankOf(c.xp);
  if (def.tier > RANKS[rank].tier) return `Нужен ранг ${RANKS[rankForTier(def.tier)].name}`;
  if (repLevel(c.rep[def.faction]) <= REP.enemy) return `${FACTION_SHORT[def.faction]} считает вас врагом`;
  if (c.active.some((a) => a.id === def.id)) return 'Уже взят';
  if (c.done.includes(def.id)) return 'Уже выполнен';
  if (c.active.length >= RANKS[rank].slots) return `Не больше ${RANKS[rank].slots} контрактов на ранге ${RANKS[rank].name}`;
  return null;
}

/** Freight also needs hold room for the containers and credits for the deposit. */
export function cannotLoad(def: ContractDef, p: Holder & { credits: number }): string | null {
  if (def.kind !== 'freight') return null;
  const room = holdRoom(p);
  if (room < def.need) return `Нужно ${def.need} мест в трюме, свободно ${Math.max(0, room)}`;
  if (p.credits < (def.deposit ?? 0)) return `Нужен залог ${def.deposit} кр`;
  return null;
}

// ---------------------------------------------------------------- board generation
const tierPick = (rng: Rng) => { const x = rng.float(); return x < 0.5 ? 1 : x < 0.83 ? 2 : 3; };
const living = (pls: readonly PlanetDef[]) => pls.filter((p) => FAUNA[p.type]);
const sitesOf = (pls: readonly PlanetDef[], kind: 'ruin' | 'base' | 'wreck') => pls.flatMap((p) => planetSites(p).filter((s) => s.kind === kind).map((s) => ({ pl: p, s })));
const hostile = (p: PlanetDef) => p.type !== 'terran' && p.type !== 'ocean';

type Maker = (rng: Rng, tier: number, id: string) => ContractDef | null;

function makers(sysId: number): Record<Exclude<ContractKind, 'intercept'>, Maker> {
  const sys = getSystem(sysId);
  const pls = sys.planets;
  const reward = (credits: number, tier: number): ContractReward => ({ credits: round10(credits), xp: XP[tier], rep: REP_GAIN[tier] });
  const cargoNeed = (cargo: CargoKey, tier: number) => {
    const base = cargo === 'ore' ? 6 : cargo === 'relic' ? 2 : 4;
    return Math.round(base * (tier === 1 ? 1 : tier === 2 ? 1.5 : 2));
  };
  const pickCargo = (rng: Rng, tier: number): CargoKey => rng.pick(tier === 1 ? ['ore', 'crystal', 'bio'] as CargoKey[] : CARGO_KEYS);
  return {
    hunt: (rng, tier, id) => {
      const sea = tier >= 2 && rng.chance(0.35) ? pls.filter((p) => FAUNA_SEA[p.type] && p.sea) : [];
      const pl = sea.length ? rng.pick(sea) : living(pls).length ? rng.pick(living(pls)) : null;
      if (!pl) return null;
      const species = (sea.length ? FAUNA_SEA[pl.type]! : FAUNA[pl.type]!)[1];
      const need = sea.length ? tier : [0, 2, 3, 5][tier];
      return {
        id, kind: 'hunt', faction: 'guild', tier, system: sysId, planet: pl.index, species, need,
        title: `Охота: ${SPECIES[species].name}`,
        desc: `Хищники нападают на старателей на ${pl.name}. Цель — ${SPECIES[species].name.toLowerCase()} ×${need}, ${sea.length ? 'в море, под водой' : 'пешком, из бластера'}.`,
        reward: reward([0, 250, 420, 650][tier] + (sea.length ? 80 : 0), tier),
      };
    },
    pirates: (_rng, tier, id) => {
      const need = [0, 2, 3, 5][tier];
      return {
        id, kind: 'pirates', faction: 'fed', tier, system: sysId, need,
        title: 'Охота на пиратов',
        desc: `Пиратские истребители мешают торговле в системе ${sys.name}. Собьите ${need} шт.`,
        reward: reward([0, 300, 520, 800][tier], tier), side: { pirate: -4 },
      };
    },
    clear: (rng, tier, id) => {
      const all = sitesOf(pls, 'base');
      const pool = tier === 3 ? all.filter((x) => hostile(x.pl)) : all;
      if (!pool.length) return null;
      const { pl, s } = rng.pick(pool);
      const need = tier === 1 ? 2 : 3;
      return {
        id, kind: 'clear', faction: 'fed', tier, system: sysId, planet: pl.index, site: s.id, need,
        title: `Зачистка: ${s.name}`,
        desc: `${s.name} на ${pl.name} обстреливает корабли. Уничтожьте турели: ${need} из 3.`,
        reward: reward([0, 450, 700, 1000][tier], tier), side: { pirate: -4 },
      };
    },
    supply: (rng, tier, id) => {
      const cargo = pickCargo(rng, tier), need = cargoNeed(cargo, tier);
      return {
        id, kind: 'supply', faction: 'guild', tier, system: sysId, cargo, need,
        title: `Поставка: ${CARGO_NAMES[cargo]}`,
        desc: `Станции ${sys.station.name} нужны ${CARGO_NAMES[cargo].toLowerCase()} ×${need}. Сдаются при стыковке, можно частями.`,
        reward: reward(need * PRICES[cargo] * 1.6 + 60, tier),
      };
    },
    deliver: (rng, tier, id) => {
      // farther for higher tiers: up to 1, 2 or 3 jumps away, paid by the jump
      const hops = jumpsFrom(sysId);
      const near = hops.map((h, i) => (h > 0 && h <= tier ? i : -1)).filter((i) => i >= 0);
      const target = near[rng.int(0, near.length - 1)];
      const dest = getSystem(target), jumps = hops[target];
      const cargo = pickCargo(rng, tier), need = cargoNeed(cargo, tier);
      return {
        id, kind: 'deliver', faction: 'guild', tier, system: target, cargo, need,
        title: `Доставка в ${dest.name}`,
        desc: `Отвезите ${CARGO_NAMES[cargo].toLowerCase()} ×${need} на станцию ${dest.station.name} (${jumps === 1 ? 'соседняя система' : `${jumps} прыжка`}, маршрут — на карте M). Сдаются при стыковке.`,
        reward: reward((need * PRICES[cargo] * 2.2 + 100) * (1 + 0.5 * (jumps - 1)), tier),
      };
    },
    survey: (rng, tier, id) => {
      // crashed ships (guarded, with a leaking reactor) from tier 2
      const wrecks = tier >= 2 ? sitesOf(pls, 'wreck') : [];
      if (wrecks.length && rng.chance(0.55)) {
        const { pl, s } = rng.pick(wrecks);
        return {
          id, kind: 'survey', faction: 'guild', tier, system: sysId, planet: pl.index, site: s.id, need: 1,
          title: `Разведка: ${s.name}`,
          desc: `Корабль разбился на ${pl.name}. Проберитесь на мостик и снимите бортовой журнал. Внутри темно, работают дроны-охранники, реактор фонит.`,
          reward: reward([0, 300, 480, 700][tier], tier),
        };
      }
      const all = sitesOf(pls, 'ruin');
      const pool = tier >= 2 ? all.filter((x) => hostile(x.pl)) : all;
      if (!pool.length) return null;
      const { pl, s } = rng.pick(pool);
      return {
        id, kind: 'survey', faction: 'guild', tier, system: sysId, planet: pl.index, site: s.id, need: 1,
        title: `Разведка: ${s.name}`,
        desc: `Гильдии нужны данные: ${s.name} на ${pl.name}. Высадитесь и дойдите до центра пешком.`,
        reward: reward([0, 200, 340, 500][tier], tier),
      };
    },
    freight: (rng, tier, id) => {
      // far away: a few jumps for cadets, the other end of the map for captains
      const hops = jumpsFrom(sysId);
      const [lo, hi] = FREIGHT_JUMPS[tier];
      let pool = hops.map((h, i) => (h >= lo && h <= hi ? i : -1)).filter((i) => i >= 0);
      if (!pool.length) {
        const far = Math.max(...hops);
        pool = hops.map((h, i) => (h === far && h > 0 ? i : -1)).filter((i) => i >= 0);
      }
      if (!pool.length) return null;
      return freightOffer(sysId, pool[rng.int(0, pool.length - 1)], tier, id);
    },
    smuggle: (rng, tier, id) => {
      const pool = sitesOf(pls, 'base');
      if (!pool.length) return null;
      const { pl, s } = rng.pick(pool);
      const cargo: CargoKey = tier === 1 ? 'crystal' : 'relic';
      const need = tier === 1 ? 3 : tier === 2 ? 2 : 3;
      return {
        id, kind: 'smuggle', faction: 'pirate', tier, system: sysId, planet: pl.index, site: s.id, cargo, need,
        title: `Контрабанда: ${s.name}`,
        desc: `Анонимный заказчик ждёт ${CARGO_NAMES[cargo].toLowerCase()} ×${need}. Место встречи — ${s.name} на ${pl.name}, груз принести пешком. Федерации это не понравится.`,
        reward: reward(need * PRICES[cargo] * 2.5 + 100, tier), side: { fed: -8 },
      };
    },
  };
}

/** Interception offer for an active pirate convoy. */
export function interceptOffer(sysId: number, poi: Poi): ContractDef {
  return {
    id: `${sysId}-cv${poi.id}`, kind: 'intercept', faction: 'fed', tier: 2, system: sysId, poi: poi.id, need: 1,
    title: `Перехват: ${poi.name}`,
    desc: `${poi.name} везёт награбленное через систему. Уничтожьте грузовик, пока он не ушёл. Контракт снимается, если конвой уйдёт.`,
    reward: { credits: 600, xp: XP[2], rep: REP_GAIN[2] }, side: { pirate: -4 },
  };
}

/** The station board of a system for an epoch, plus interception offers for active convoys and urgent offers from galaxy events. */
export function generateBoard(sysId: number, epoch: number, pois: readonly Poi[] = [], events: readonly GalaxyEvent[] = []): ContractDef[] {
  const rng = new Rng(hashInts(getSystem(sysId).seed, epoch, 0xc0a7));
  const make = makers(sysId);
  const plan: [Faction, Exclude<ContractKind, 'intercept'>[]][] = [
    ['guild', ['hunt', 'supply', 'deliver', 'survey']],
    ['guild', ['hunt', 'supply', 'deliver', 'survey']],
    ['fed', ['pirates', 'clear']],
    ['fed', ['pirates', 'clear']],
    ['pirate', ['smuggle']],
  ];
  if (rng.chance(0.6)) plan.push(['guild', ['hunt', 'supply', 'deliver', 'survey']]);
  if (rng.chance(0.5)) plan.push(['fed', ['pirates', 'clear']]);
  if (rng.chance(0.5)) plan.push(['pirate', ['smuggle']]);
  // long-haul freight for haulers: one always, a second one often
  const freightAt = plan.length;
  plan.push(['guild', ['freight']]);
  if (rng.chance(0.5)) plan.push(['guild', ['freight']]);
  const out: ContractDef[] = [];
  const seen = new Set<string>();
  plan.forEach(([, kinds], k) => {
    // the first offer of each faction is entry level so cadets always have work
    // (and the first freight run is one a fighter with a bigger hold can manage)
    const tier = k === 0 || k === 2 || k === 4 || k === freightAt ? 1 : tierPick(rng);
    for (let tries = 0; tries < 6; tries++) {
      const def = make[rng.pick(kinds)](rng, tier, `${sysId}-${epoch}-${k}`);
      if (!def) continue;
      const key = `${def.kind}:${def.planet ?? ''}:${def.site ?? ''}:${def.species ?? ''}:${def.cargo ?? ''}:${def.system}${def.kind === 'freight' ? `:${def.tier}` : ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(def);
      break;
    }
  });
  for (const p of pois) if (p.kind === 'convoy' && p.ship) out.push(interceptOffer(sysId, p));
  out.push(...eventOffers(sysId, events));
  return out;
}

// ---------------------------------------------------------------- text
/** "Ледяной волк 1/3 · Theoraqua IV" — the objective with progress. */
export function objectiveText(c: ContractDef, have = (c as ActiveContract).have ?? 0): string {
  const sys = getSystem(c.system);
  const pl = c.planet !== undefined ? sys.planets[c.planet] : undefined;
  const site = pl && c.site !== undefined ? planetSites(pl)[c.site] : undefined;
  const n = `${Math.min(have, c.need)}/${c.need}`;
  switch (c.kind) {
    case 'hunt': return `${SPECIES[c.species ?? 0].name} ${n} · ${pl?.name ?? ''}`;
    case 'pirates': return `Пираты ${n} · ${sys.name}`;
    case 'clear': return `Турели ${n} · ${site?.name ?? ''}, ${pl?.name ?? ''}`;
    case 'intercept': return 'Грузовик конвоя';
    case 'supply': case 'deliver': return `${CARGO_NAMES[c.cargo ?? 'ore']} ${n} → ${sys.station.name}`;
    case 'survey': return `${site?.name ?? ''} · ${pl?.name ?? ''}`;
    case 'smuggle': return `${CARGO_NAMES[c.cargo ?? 'relic']} ×${c.need} → ${site?.name ?? ''}, ${pl?.name ?? ''}`;
    case 'freight': return `Контейнеры ×${c.need} → ${sys.station.name} · ${jumpsFrom(c.origin ?? c.system)[c.system]} прыж.`;
  }
}

export function rewardText(r: ContractReward, faction: Faction, side?: Partial<Record<Faction, number>>): string {
  const parts = [`${r.credits} кр`, `${r.xp} опыта`, `${FACTION_SHORT[faction]} +${r.rep}`];
  for (const f of FACTIONS) if (side?.[f]) parts.push(`${FACTION_SHORT[f]} ${side[f]! > 0 ? '+' : ''}${side[f]}`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------- validation
const isInt = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const optInt = (v: unknown, lo: number, hi: number) => v === undefined || isInt(v, lo, hi);

function validActive(x: unknown): x is ActiveContract {
  if (!x || typeof x !== 'object') return false;
  const c = x as Record<string, unknown>;
  const r = c.reward as Record<string, unknown> | undefined;
  return typeof c.id === 'string' && CONTRACT_KINDS.includes(c.kind as ContractKind) && FACTIONS.includes(c.faction as Faction)
    && isInt(c.tier, 1, 3) && typeof c.title === 'string' && typeof c.desc === 'string' && isInt(c.system, 0, SYSTEM_COUNT - 1)
    && optInt(c.planet, 0, 15) && optInt(c.species, 0, SPECIES.length - 1) && optInt(c.site, 0, 15) && optInt(c.poi, 0, 2 ** 31)
    && (c.cargo === undefined || CARGO_KEYS.includes(c.cargo as CargoKey))
    && isInt(c.need, 1, 999) && isInt(c.have, 0, 999)
    && optInt(c.origin, 0, SYSTEM_COUNT - 1) && optInt(c.time, 0, 1e8) && optInt(c.deposit, 0, 1e6) && optInt(c.due, 0, Number.MAX_SAFE_INTEGER)
    && (c.urgent === undefined || typeof c.urgent === 'boolean')
    && !!r && isInt(r.credits, 0, 1e6) && isInt(r.xp, 0, 1e5) && isInt(r.rep, 0, 100);
}

/** A career read from storage: anything malformed is dropped or reset. */
export function validCareer(raw: unknown): Career {
  const c = newCareer();
  if (!raw || typeof raw !== 'object') return c;
  const r = raw as Record<string, unknown>;
  if (typeof r.xp === 'number' && Number.isFinite(r.xp)) c.xp = Math.max(0, Math.floor(r.xp));
  const rep = r.rep as Record<string, unknown> | undefined;
  for (const f of FACTIONS) {
    const v = rep?.[f];
    if (typeof v === 'number' && Number.isFinite(v)) c.rep[f] = clampRep(v);
  }
  if (Array.isArray(r.active)) c.active = r.active.filter(validActive).slice(0, MAX_SLOTS).map((a) => structuredClone(a));
  if (Array.isArray(r.done)) c.done = r.done.filter((x): x is string => typeof x === 'string').slice(-DONE_KEEP);
  return c;
}

export function markDone(c: Career, id: string) {
  c.done.push(id);
  if (c.done.length > DONE_KEEP) c.done.splice(0, c.done.length - DONE_KEEP);
}
