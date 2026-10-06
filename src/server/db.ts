import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultUpgrades, emptyCargo, MAX_MISSILES } from '../shared/economy.ts';
import { defaultOutfit, validOutfit } from '../shared/outfit.ts';
import { newCareer, validCareer } from '../shared/contracts.ts';
import { validTrophies } from '../shared/station/trophies.ts';
import type { PilotRecord, PilotStorage } from './storage.ts';

export type { PilotRecord } from './storage.ts';

interface Row {
  id: number; name: string; token: string; credits: number; cargo: string; upgrades: string;
  missiles: number; kills: number; deaths: number; system: number;
  items: string | null; outfit: string | null; career: string | null; trophies: string | null;
}

/** Pilot persistence on the built-in node:sqlite driver (no native build step). */
export class PilotStore implements PilotStorage {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS pilots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      token TEXT NOT NULL,
      credits INTEGER NOT NULL DEFAULT 250,
      cargo TEXT NOT NULL,
      upgrades TEXT NOT NULL,
      missiles INTEGER NOT NULL,
      kills INTEGER NOT NULL DEFAULT 0,
      deaths INTEGER NOT NULL DEFAULT 0,
      system INTEGER NOT NULL DEFAULT 0,
      created INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    )`);
    // later columns (older databases are migrated in place)
    const cols = new Set((this.db.prepare('PRAGMA table_info(pilots)').all() as { name: string }[]).map((c) => c.name));
    if (!cols.has('items')) this.db.exec(`ALTER TABLE pilots ADD COLUMN items TEXT NOT NULL DEFAULT '[]'`);
    if (!cols.has('outfit')) this.db.exec(`ALTER TABLE pilots ADD COLUMN outfit TEXT NOT NULL DEFAULT '{}'`);
    if (!cols.has('career')) this.db.exec(`ALTER TABLE pilots ADD COLUMN career TEXT NOT NULL DEFAULT '{}'`);
    if (!cols.has('trophies')) this.db.exec(`ALTER TABLE pilots ADD COLUMN trophies TEXT NOT NULL DEFAULT '[]'`);
  }

  private parse(r: Row): PilotRecord {
    return {
      id: r.id, name: r.name, token: r.token, credits: r.credits,
      cargo: { ...emptyCargo(), ...JSON.parse(r.cargo) }, upgrades: { ...defaultUpgrades(), ...JSON.parse(r.upgrades) },
      missiles: r.missiles, kills: r.kills, deaths: r.deaths, system: r.system,
      ...parseGear(r.items, r.outfit), career: parseCareer(r.career), trophies: parseTrophies(r.trophies),
    };
  }

  find(name: string): PilotRecord | null {
    const r = this.db.prepare('SELECT * FROM pilots WHERE name = ?').get(name) as Row | undefined;
    return r ? this.parse(r) : null;
  }

  create(name: string): PilotRecord {
    const token = randomBytes(18).toString('base64url');
    const now = Date.now();
    this.db
      .prepare('INSERT INTO pilots (name, token, credits, cargo, upgrades, missiles, items, outfit, career, created, last_seen) VALUES (?, ?, 250, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(name, token, JSON.stringify(emptyCargo()), JSON.stringify(defaultUpgrades()), MAX_MISSILES / 2, '[]', JSON.stringify(defaultOutfit()), JSON.stringify(newCareer()), now, now);
    return this.find(name)!;
  }

  save(p: PilotRecord): void {
    this.db
      .prepare('UPDATE pilots SET credits = ?, cargo = ?, upgrades = ?, missiles = ?, kills = ?, deaths = ?, system = ?, items = ?, outfit = ?, career = ?, trophies = ?, last_seen = ? WHERE id = ?')
      .run(Math.floor(p.credits), JSON.stringify(p.cargo), JSON.stringify(p.upgrades), p.missiles, p.kills, p.deaths, p.system, JSON.stringify(p.items), JSON.stringify(p.outfit), JSON.stringify(p.career), JSON.stringify(p.trophies), Date.now(), p.id);
  }

  close(): void {
    this.db.close();
  }
}

/** Owned items and outfit from stored JSON (tolerating old or damaged rows). */
export function parseGear(items: string | null | undefined, outfit: string | null | undefined): { items: string[]; outfit: ReturnType<typeof defaultOutfit> } {
  let list: string[] = [];
  let worn: unknown = null;
  try { const v = JSON.parse(items ?? '[]'); if (Array.isArray(v)) list = v.filter((x) => typeof x === 'string'); } catch { /* keep empty */ }
  try { worn = JSON.parse(outfit ?? '{}'); } catch { /* default */ }
  return { items: list, outfit: validOutfit(worn as Record<string, unknown>, list) };
}

/** Trophies from stored JSON (old rows have none). */
export function parseTrophies(raw: string | null | undefined) {
  try { return validTrophies(JSON.parse(raw ?? '[]')); } catch { return []; }
}

/** Career from stored JSON (old rows have none). */
export function parseCareer(raw: string | null | undefined) {
  try { return validCareer(JSON.parse(raw ?? '{}')); } catch { return newCareer(); }
}
