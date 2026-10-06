import { CARGO_NAMES, type Cargo, type CargoKey, type RefinedKey } from './economy.ts';

/**
 * The station smelter: raw ore and crystals from the miner's lasers and the rover's drill
 * become ingots, optics and machine parts. A batch takes its inputs out of the hold and
 * puts one unit of the product back, so refining packs more value into every unit of hold
 * (the hauler's 60 slots of parts are worth far more than 60 of ore) and the products sell
 * well where there are no mines. Products are ordinary goods: every market quotes them,
 * and anything that moves prices (trade, drift, galaxy events) moves theirs the same way.
 */
export interface Recipe {
  key: RefinedKey;
  /** Inputs of one batch. */
  inputs: Partial<Record<CargoKey, number>>;
  /** Smelter fee per batch (credits). */
  fee: number;
  /** What the smelter does, for the station window. */
  blurb: string;
}

export const RECIPES: readonly Recipe[] = [
  { key: 'ingot', inputs: { ore: 3 }, fee: 6, blurb: 'Руду плавят в печи и разливают в слитки.' },
  { key: 'optics', inputs: { crystal: 3 }, fee: 10, blurb: 'Кристаллы режут и шлифуют в линзы для сенсоров.' },
  { key: 'parts', inputs: { ingot: 2, crystal: 1 }, fee: 14, blurb: 'Из слитков на станке точат детали, кристалл идёт на микросхемы.' },
];
export const recipeOf = (key: string): Recipe | undefined => RECIPES.find((r) => r.key === key);
/** Most batches in one go. */
export const MAX_BATCHES = 50;

/** How many batches the hold and the purse allow. */
export function batchesPossible(r: Recipe, cargo: Cargo, credits: number): number {
  let n = r.fee > 0 ? Math.floor(credits / r.fee) : MAX_BATCHES;
  for (const [k, need] of Object.entries(r.inputs) as [CargoKey, number][]) n = Math.min(n, Math.floor((cargo[k] ?? 0) / need));
  return Math.max(0, Math.min(MAX_BATCHES, n));
}

/** Runs up to `want` batches on the cargo in place; returns how many ran and the fee taken. */
export function refine(r: Recipe, cargo: Cargo, credits: number, want: number): { n: number; fee: number } {
  const n = Math.min(batchesPossible(r, cargo, credits), Math.max(0, Math.floor(want)));
  if (n <= 0) return { n: 0, fee: 0 };
  for (const [k, need] of Object.entries(r.inputs) as [CargoKey, number][]) cargo[k] -= need * n;
  cargo[r.key] += n;
  return { n, fee: n * r.fee };
}

/** "Руда ×3" style list of a recipe's inputs. */
export const inputsText = (r: Recipe) => (Object.entries(r.inputs) as [CargoKey, number][]).map(([k, n]) => `${CARGO_NAMES[k]} ×${n}`).join(' + ');
