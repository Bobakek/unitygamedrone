import { Rng } from '../math/rng.ts';

const A = ['ka', 've', 'lo', 'ra', 'zen', 'tor', 'mi', 'sa', 'ul', 'dra', 'kor', 'ne', 'xi', 'or', 'ta', 'bel', 'ly', 'qua', 'the', 'vos'];
const B = ['ri', 'on', 'ax', 'us', 'ia', 'en', 'is', 'ar', 'eth', 'um', 'ora', 'ix', 'yn', 'as'];

export function makeName(rng: Rng): string {
  let s = rng.pick(A) + rng.pick(B);
  if (rng.chance(0.45)) s += rng.pick(A);
  return s[0].toUpperCase() + s.slice(1);
}

export const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];
