import type { V3 } from './math/vec.ts';
import type { ShipClass } from './ships/blueprint.ts';
import { HULL_KEYS, type HullKey } from './ships/hulls.ts';

/**
 * Weapon modules: bought once at a station's arsenal and fitted into the slots of a ship, like
 * the hangar they belong to the pilot and stay fitted in each ship. Keys 1 and 2 fire the module
 * in that slot (see MODULE_KEYS_HINT). The lasers stay the main guns; modules are tools with a
 * long cooldown:
 *
 *   railgun  a hitscan slug along the nose: soft against shields, punches through hull
 *   mines    drops a proximity mine behind the ship (ammo bought at the station)
 *   emp      a pulse around the ship: knocks enemy shields out and jams their guns
 */
export type ModuleKey = 'railgun' | 'mines' | 'emp';
export const MODULE_KEYS: readonly ModuleKey[] = ['railgun', 'mines', 'emp'];
export const isModule = (k: unknown): k is ModuleKey => typeof k === 'string' && (MODULE_KEYS as readonly string[]).includes(k);

export interface ModuleDef {
  key: ModuleKey;
  name: string;
  /** Two or three letters for the HUD slot. */
  short: string;
  blurb: string;
  price: number;
  /** Energy per use and seconds between uses. */
  energy: number;
  cooldown: number;
}

export const MODULES: Record<ModuleKey, ModuleDef> = {
  railgun: {
    key: 'railgun', name: 'Рельсотрон', short: 'РЛС', price: 2400, energy: 40, cooldown: 6,
    blurb: 'Мгновенный выстрел по курсу на 2,4 км. Щиты гасят его наполовину, зато по голому корпусу он бьёт в 1,4 раза сильнее. Цель с захватом в узком конусе у носа поражается точно.',
  },
  mines: {
    key: 'mines', name: 'Минный постановщик', short: 'МИН', price: 1600, energy: 0, cooldown: 1.2,
    blurb: 'Сбрасывает мину за кормой. Через секунду она взводится и рвётся, когда рядом проходит чужой корабль. Кассета на 6 мин, пополняется на станции.',
  },
  emp: {
    key: 'emp', name: 'ЭМИ-излучатель', short: 'ЭМИ', price: 2100, energy: 60, cooldown: 28,
    blurb: 'Импульс на 400 м вокруг корабля: выжигает врагам до 50 ед. щита и не даёт ему восстановиться 3,5 с, на секунду глушит их пушки, сбивает чужие ракеты и мины.',
  },
};

/** Railgun: range (m), damage at weapons level 1 and per further level, shield / hull multipliers. */
export const RAIL = {
  range: 2400, damage: 21, perLevel: 0.15, shieldMul: 0.5, hullMul: 1.4,
  /** Aim assist: the slug goes to the selected target if it is within this angle of the nose. */
  assist: (0.7 * Math.PI) / 180,
} as const;
export const railDamage = (weapons: number) => RAIL.damage * (1 + (weapons - 1) * RAIL.perLevel);

/** Mines: arming delay, trigger and blast radii, damage at the centre (40% at the edge), life, ammo. */
export const MINE = {
  arm: 1, trigger: 70, blast: 110, damage: 85, life: 120, maxLive: 5, cap: 6, price: 30,
  /** Speed it is thrown back at (relative to the ship) and how fast it settles. */
  toss: 25, drag: 0.8,
} as const;

/** EMP: radius, shield points burnt off, seconds the shields can't recharge, seconds the guns are jammed, hull damage. */
export const EMP = { radius: 400, shield: 50, shieldLock: 3.5, jam: 1, hull: 6 } as const;

/** Module slots of each ship class. */
export const MODULE_SLOTS: Record<HullKey, number> = { fighter: 2, hauler: 2, miner: 1 };

/**
 * Where the modules sit on each ship class (model space, forward = -Z), slot by slot. `down`:
 * hung under the hull (the model is turned upside down).
 */
export interface Mount { p: V3; down: boolean; scale: number }
export const MOUNTS: Partial<Record<ShipClass, Mount[]>> = {
  fighter: [{ p: { x: 0, y: -0.62, z: -0.9 }, down: true, scale: 0.8 }, { p: { x: 0, y: 0.62, z: 1.9 }, down: false, scale: 0.8 }],
  hauler: [{ p: { x: 0, y: 4.25, z: 0.5 }, down: false, scale: 1.25 }, { p: { x: 0, y: -2.05, z: -6.0 }, down: true, scale: 1.25 }],
  miner: [{ p: { x: 0, y: 1.95, z: -2.6 }, down: false, scale: 1 }],
};
/** Railgun muzzle ahead of the mount (model metres before the mount's scale). */
export const RAIL_MUZZLE = { y: 0.55, z: -4.3 } as const;

/** Muzzle of a railgun in slot `slot` of a ship of class `cls`, in model space. */
export function railMuzzle(cls: ShipClass, slot: number): V3 {
  const m = MOUNTS[cls]?.[slot];
  if (!m) return { x: 0, y: 0, z: -4 };
  return { x: m.p.x, y: m.p.y + (m.down ? -1 : 1) * RAIL_MUZZLE.y * m.scale, z: m.p.z + RAIL_MUZZLE.z * m.scale };
}

/** What a pilot owns and has fitted: modules, the fit of each ship, mines in the magazine. */
export interface Arms {
  owned: ModuleKey[];
  fits: Partial<Record<HullKey, ModuleKey[]>>;
  mines: number;
}
export const newArms = (): Arms => ({ owned: [], fits: {}, mines: 0 });

/** The modules fitted in ship `ship`, slot by slot (only owned ones, no more than the slots). */
export function fitOf(arms: Arms, ship: HullKey): ModuleKey[] {
  const list = arms.fits[ship] ?? [];
  return list.filter((k, i) => arms.owned.includes(k) && list.indexOf(k) === i).slice(0, MODULE_SLOTS[ship] ?? 0);
}

/** Arms from stored data (unknown keys dropped, counts clamped). */
export function validArms(v: unknown): Arms {
  const out = newArms();
  if (!v || typeof v !== 'object') return out;
  const r = v as Record<string, unknown>;
  if (Array.isArray(r.owned)) for (const k of r.owned) if (isModule(k) && !out.owned.includes(k)) out.owned.push(k);
  if (r.fits && typeof r.fits === 'object') {
    for (const h of HULL_KEYS) {
      const f = (r.fits as Record<string, unknown>)[h];
      if (Array.isArray(f)) out.fits[h] = fitOf({ ...out, fits: { [h]: f.filter(isModule) } }, h);
    }
  }
  if (typeof r.mines === 'number' && r.mines > 0) out.mines = Math.min(MINE.cap, Math.floor(r.mines));
  return out;
}

/** Fits or removes module `key` on ship `ship`; an error text, or null. */
export function toggleFit(arms: Arms, ship: HullKey, key: ModuleKey): string | null {
  if (!arms.owned.includes(key)) return 'Модуль не куплен';
  const fit = fitOf(arms, ship);
  if (fit.includes(key)) { arms.fits[ship] = fit.filter((k) => k !== key); return null; }
  if (fit.length >= (MODULE_SLOTS[ship] ?? 0)) return 'Все слоты корабля заняты: сначала снимите другой модуль';
  arms.fits[ship] = [...fit, key];
  return null;
}
