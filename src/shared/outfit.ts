/**
 * Pilot outfits: a catalogue of suit parts bought at the station, what a
 * pilot is wearing, the gameplay effect of the gear (shared by the server and
 * client prediction) and a compact code other players receive to dress the
 * pilot's model the same way.
 */
import { FACTION_SHORT, REP_NAMES, repLevel, type Faction } from './factions.ts';

export type Slot = 'suit' | 'helmet' | 'visor' | 'pack' | 'chest' | 'lights' | 'patch';
export const SLOTS: readonly Slot[] = ['suit', 'helmet', 'visor', 'pack', 'chest', 'lights', 'patch'];
export const SLOT_NAMES: Record<Slot, string> = {
  suit: 'Скафандр', helmet: 'Шлем', visor: 'Светофильтр', pack: 'Ранец', chest: 'Грудь', lights: 'Фонари', patch: 'Нашивка',
};

/** Gameplay effect of the gear a pilot wears. */
export interface GearStats {
  /** Suit integrity. */
  hp: number;
  /** Seconds of air under water. */
  airTime: number;
  /** Jetpack fuel used per second of thrust (fraction of a full tank). */
  fuelDrain: number;
  /** Suit self-repair per second, and the quiet time before it starts (s). */
  regenRate: number;
  regenDelay: number;
  /** Extra bio samples from each carcass. */
  samples: number;
}
export const DEFAULT_GEAR: GearStats = { hp: 100, airTime: 75, fuelDrain: 0.45, regenRate: 4, regenDelay: 5, samples: 0 };

export interface ItemDef {
  id: string;
  slot: Slot;
  name: string;
  /** Credits; 0 = part of the starter kit (always owned). */
  price: number;
  desc: string;
  /** What changes from the default gear. */
  gear?: Partial<GearStats>;
  /** Extra hp on top of the base suit (stacks across slots). */
  armor?: number;
  /** Sold only to pilots with at least this standing with a faction (REP level index). */
  rep?: { faction: Faction; level: number };
}

export const ITEMS: readonly ItemDef[] = [
  { id: 'suit-white', slot: 'suit', name: 'Белый EMU', price: 0, desc: 'Классический белый скафандр для выхода в открытый космос.' },
  { id: 'suit-commander', slot: 'suit', name: 'Командирский', price: 350, desc: 'Белый, с красными полосами на руках и ногах — знак командира экипажа.' },
  { id: 'suit-orange', slot: 'suit', name: 'Оранжевый ACES', price: 400, desc: 'Спасательный оранжевый — заметен с любой орбиты.' },
  { id: 'suit-orlan', slot: 'suit', name: 'Бело-синий «Орлан»', price: 450, desc: 'Белый с синими вставками и красной окантовкой.' },
  { id: 'suit-tan', slot: 'suit', name: 'Песчаный разведчик', price: 500, desc: 'Пыльно-песочный, для пустынь и скал.' },
  { id: 'suit-graphite', slot: 'suit', name: 'Графитовый', price: 800, desc: 'Тёмный матовый скафандр с оранжевой окантовкой.' },
  { id: 'suit-navy', slot: 'suit', name: 'Флотский', price: 600, desc: 'Тёмно-синий скафандр флота Федерации с золотыми кантами.', rep: { faction: 'fed', level: 3 } },
  { id: 'suit-miner', slot: 'suit', name: 'Старательский', price: 500, desc: 'Сигнальный жёлтый с отражающими полосами — форма Гильдии.', rep: { faction: 'guild', level: 3 } },
  { id: 'suit-raider', slot: 'suit', name: 'Рейдер', price: 700, desc: 'Чёрный с красным — так ходят люди Синдиката.', rep: { faction: 'pirate', level: 3 } },

  { id: 'helmet-dome', slot: 'helmet', name: 'Купол EMU', price: 0, desc: 'Прозрачный шлем-пузырь со щитком, светофильтром и фонарями.' },
  { id: 'helmet-panorama', slot: 'helmet', name: 'Панорамный', price: 450, desc: 'Почти весь из стекла — лучший обзор.' },
  { id: 'helmet-armored', slot: 'helmet', name: 'Бронешлем', price: 900, desc: 'Глухой композитный шлем с узкой щелью визора.', armor: 10 },

  { id: 'visor-gold', slot: 'visor', name: 'Золотой', price: 0, desc: 'Золотое напыление отражает солнце.' },
  { id: 'visor-silver', slot: 'visor', name: 'Серебряный', price: 150, desc: 'Зеркальный серебряный фильтр.' },
  { id: 'visor-amber', slot: 'visor', name: 'Янтарный', price: 150, desc: 'Тёплый янтарный оттенок.' },
  { id: 'visor-chameleon', slot: 'visor', name: 'Хамелеон', price: 300, desc: 'Переливается синим, фиолетовым и зелёным.' },
  { id: 'visor-clear', slot: 'visor', name: 'Прозрачный', price: 100, desc: 'Без напыления — лицо видно всегда.' },

  { id: 'pack-plss', slot: 'pack', name: 'PLSS', price: 0, desc: 'Стандартный ранец жизнеобеспечения со встроенным джетпаком.' },
  { id: 'pack-o2', slot: 'pack', name: 'Кислородные баллоны', price: 900, desc: 'Два дополнительных баллона: вдвое больше воздуха под водой.', gear: { airTime: 150 } },
  { id: 'pack-jet', slot: 'pack', name: 'Усиленный джетпак', price: 1200, desc: 'Крупные сопла и экономичный двигатель: топлива хватает дольше.', gear: { fuelDrain: 0.27 } },
  { id: 'pack-medic', slot: 'pack', name: 'Ремонтный модуль', price: 1000, desc: 'Латает скафандр быстрее и раньше.', gear: { regenRate: 10, regenDelay: 2.5 } },
  { id: 'pack-deep', slot: 'pack', name: 'Глубоководный ранец', price: 1300, desc: 'Три баллона Гильдии для работы под водой.', gear: { airTime: 240 }, rep: { faction: 'guild', level: 4 } },
  { id: 'pack-raider', slot: 'pack', name: 'Форсажный ранец', price: 1700, desc: 'Краденый форсажный двигатель Синдиката: топлива хватает надолго.', gear: { fuelDrain: 0.2 }, rep: { faction: 'pirate', level: 4 } },

  { id: 'chest-dcm', slot: 'chest', name: 'Пульт DCM', price: 0, desc: 'Стандартный нагрудный пульт управления.' },
  { id: 'chest-plate', slot: 'chest', name: 'Бронепластина', price: 1100, desc: 'Композитная пластина поверх пульта.', armor: 30 },
  { id: 'chest-rig', slot: 'chest', name: 'Разгрузка с контейнерами', price: 600, desc: 'Подсумки для образцов: с каждой туши на один образец больше.', gear: { samples: 1 } },
  { id: 'chest-aegis', slot: 'chest', name: 'Щит «Эгида»', price: 1600, desc: 'Флотская броня Федерации с эмблемой на груди.', armor: 45, rep: { faction: 'fed', level: 4 } },

  { id: 'lights-none', slot: 'lights', name: 'Без фонарей', price: 0, desc: 'Фонари не установлены.' },
  { id: 'lights-eva', slot: 'lights', name: 'EVA-фонари', price: 300, desc: 'Два прожектора на шлеме освещают путь ночью.' },

  { id: 'patch-flag', slot: 'patch', name: 'Флаг Федерации', price: 0, desc: 'Сине-белый флаг.' },
  { id: 'patch-planet', slot: 'patch', name: 'Планета', price: 0, desc: 'Кольцевая планета на синем.' },
  { id: 'patch-star', slot: 'patch', name: 'Звезда', price: 0, desc: 'Золотая звезда.' },
  { id: 'patch-comet', slot: 'patch', name: 'Комета', price: 0, desc: 'Комета на тёмном небе.' },
  { id: 'patch-wings', slot: 'patch', name: 'Крылья', price: 0, desc: 'Крылья пилота.' },
  { id: 'patch-skull', slot: 'patch', name: 'Череп', price: 0, desc: 'Пиратский череп.' },
];

const BY_ID = new Map(ITEMS.map((i) => [i.id, i]));
export const item = (id: string): ItemDef | undefined => BY_ID.get(id);

export type Outfit = Record<Slot, string>;
export const defaultOutfit = (): Outfit => ({
  suit: 'suit-white', helmet: 'helmet-dome', visor: 'visor-gold', pack: 'pack-plss', chest: 'chest-dcm', lights: 'lights-none', patch: 'patch-flag',
});

/** Starter-kit items are owned by everyone. */
export const owns = (owned: readonly string[], id: string) => (item(id)?.price ?? 1) === 0 || owned.includes(id);

/** The outfit with anything unknown, misplaced or not owned replaced by the default. */
export function validOutfit(o: Partial<Record<string, unknown>> | null | undefined, owned: readonly string[]): Outfit {
  const d = defaultOutfit();
  const out = { ...d };
  for (const s of SLOTS) {
    const id = o?.[s];
    if (typeof id === 'string' && item(id)?.slot === s && owns(owned, id)) out[s] = id;
  }
  return out;
}

/** True when the pilot's standing allows buying the item. */
export const repOk = (it: ItemDef, rep: Record<Faction, number>) => !it.rep || repLevel(rep[it.rep.faction] ?? 0) >= it.rep.level;
/** "Гильдия — Друг" */
export const repNeedText = (it: ItemDef) => (it.rep ? `${FACTION_SHORT[it.rep.faction]} — ${REP_NAMES[it.rep.level]}` : '');

/** Gameplay stats of an outfit. */
export function gearStats(o: Outfit): GearStats {
  const g = { ...DEFAULT_GEAR };
  for (const s of SLOTS) {
    const it = item(o[s]);
    if (!it) continue;
    Object.assign(g, it.gear);
    g.hp += it.armor ?? 0;
  }
  return g;
}

/** Human-readable effect of an item (for the wardrobe). */
export function itemEffect(it: ItemDef): string {
  const p: string[] = [];
  if (it.armor) p.push(`+${it.armor} к прочности скафандра`);
  const g = it.gear ?? {};
  if (g.airTime) p.push(`воздух ${DEFAULT_GEAR.airTime} → ${g.airTime} с`);
  if (g.fuelDrain) p.push(`расход топлива −${Math.round((1 - g.fuelDrain / DEFAULT_GEAR.fuelDrain) * 100)}%`);
  if (g.regenRate) p.push(`самопочинка ${DEFAULT_GEAR.regenRate} → ${g.regenRate} ед./с`);
  if (g.samples) p.push(`+${g.samples} биообразец с туши`);
  if (it.id === 'lights-eva') p.push('свет ночью');
  return p.join(', ');
}

/** Compact code of an outfit for the network ("suit-orange.helmet-dome...") — slot order is fixed. */
export const lookCode = (o: Outfit): string => SLOTS.map((s) => o[s]).join('.');
/** Parses a look code (anything invalid falls back to the default part). */
export function parseLook(code: string | undefined): Outfit {
  const ids = (code ?? '').split('.');
  const o = defaultOutfit();
  SLOTS.forEach((s, i) => { if (item(ids[i])?.slot === s) o[s] = ids[i]; });
  return o;
}
