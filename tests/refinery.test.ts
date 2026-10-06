import { describe, expect, it } from 'vitest';
import { PilotStore } from '../src/server/db.ts';
import { Game } from '../src/server/game/game.ts';
import type { Transport } from '../src/server/game/session.ts';
import {
  BOARD_EPOCH_MS, CARGO_KEYS, emptyCargo, encodeJson, marketProfile, marketQuote, MSG, PRICES, PROTOCOL_VERSION, RECIPES, recipeOf, refine,
  REFINED_KEYS, SYSTEM_COUNT, batchesPossible,
} from '../src/shared/index.ts';
import { DECK_POSTS, TERMINALS } from '../src/shared/station/deck.ts';

describe('station smelter', () => {
  it('every product is worth more than what goes into it, and packs value into the hold', () => {
    for (const r of RECIPES) {
      const units = Object.values(r.inputs).reduce((a, b) => a + b, 0);
      const cost = Object.entries(r.inputs).reduce((n, [k, v]) => n + PRICES[k as keyof typeof PRICES] * v, 0);
      expect(PRICES[r.key], r.key).toBeGreaterThan(cost + r.fee);
      expect(units).toBeGreaterThan(1);
    }
    // a hauler's hold of parts is worth several holds of ore
    expect(PRICES.parts).toBeGreaterThan(PRICES.ore * 12);
  });

  it('refining takes the inputs and the fee, within the hold and the purse', () => {
    const c = { ...emptyCargo(), ore: 10, crystal: 2 };
    const ingot = recipeOf('ingot')!;
    expect(batchesPossible(ingot, c, 1000)).toBe(3);
    expect(batchesPossible(ingot, c, 13)).toBe(2);
    expect(refine(ingot, c, 1000, 99)).toEqual({ n: 3, fee: 18 });
    expect(c.ore).toBe(1);
    expect(c.ingot).toBe(3);
    const parts = recipeOf('parts')!;
    expect(refine(parts, c, 1000, 5)).toEqual({ n: 1, fee: parts.fee });
    expect(c).toMatchObject({ ingot: 1, crystal: 1, parts: 1 });
    expect(refine(parts, c, 1000, 5).n).toBe(0);
    expect(refine(ingot, { ...emptyCargo(), ore: 9 }, 1000, -3).n).toBe(0);
  });

  it('every market quotes the products, and somewhere sells each of them', () => {
    for (const k of REFINED_KEYS) {
      expect(CARGO_KEYS).toContain(k);
      expect(Array.from({ length: SYSTEM_COUNT }, (_, i) => marketProfile(i).exports.includes(k)).some(Boolean)).toBe(true);
      const prices = Array.from({ length: SYSTEM_COUNT }, (_, i) => marketQuote(i, 2).goods[k].sell);
      expect(Math.max(...prices)).toBeGreaterThan(Math.min(...prices) * 1.4);
    }
  });

  it('the smelter terminal stands on free floor in front of the furnace', () => {
    const t = TERMINALS.find((x) => x.kind === 'refinery')!;
    expect(t).toBeTruthy();
    // the pilot can stand at the screen (the side facing the promenade)
    const at = { x: t.x - 1.8, z: t.z };
    for (const o of DECK_POSTS) if (o.x !== t.x || o.z !== t.z) expect(Math.hypot(at.x - o.x, at.z - o.z)).toBeGreaterThan(o.r + 0.35);
  });

  it('a docked pilot smelts ore from the hold', () => {
    const game = new Game({ store: new PilotStore(':memory:'), dev: true, now: () => 5 * BOARD_EPOCH_MS + 1000 });
    const t: Transport = { send: () => {}, close: () => {}, buffered: 0 };
    const c = game.connect(t);
    c.onMessage(encodeJson(MSG.HELLO, { v: PROTOCOL_VERSION, name: 'Smelter' }));
    const s = [...game.sessions.values()].find((x) => x.pilot.name === 'Smelter')!;
    const sys = game.systems.find((x) => x.def.id === s.pilot.system)!;
    s.pilot.cargo = { ...emptyCargo(), ore: 7, crystal: 4 };
    s.pilot.credits = 100;
    expect(sys.handleAction(s, { a: 'refine', recipe: 'ingot' })).toBe('Нужно пристыковаться');
    sys.devTeleport(s, 'dock');
    expect(sys.handleAction(s, { a: 'dock' })).toBeNull();
    expect(sys.handleAction(s, { a: 'refine', recipe: 'ingot' })).toBeNull();
    expect(s.pilot.cargo).toMatchObject({ ore: 1, ingot: 2 });
    expect(s.pilot.credits).toBe(88);
    expect(sys.handleAction(s, { a: 'refine', recipe: 'parts', n: 1 })).toBeNull();
    expect(s.pilot.cargo).toMatchObject({ ingot: 0, crystal: 3, parts: 1 });
    expect(sys.handleAction(s, { a: 'refine', recipe: 'parts', n: 1 })).toMatch(/Нужно/);
    expect(sys.handleAction(s, { a: 'refine', recipe: 'nope' })).toBeNull();
    // products sell like any other good
    const credits = s.pilot.credits;
    expect(sys.handleAction(s, { a: 'sell', key: 'parts' })).toBeNull();
    expect(s.pilot.credits).toBeGreaterThan(credits + 100);
  });
});
