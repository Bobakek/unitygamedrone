import { defaultUpgrades, emptyCargo, MAX_MISSILES } from '../../shared/economy.ts';
import { defaultOutfit, validOutfit } from '../../shared/outfit.ts';
import { newCareer, validCareer } from '../../shared/contracts.ts';
import { hangarOf } from '../../shared/ships/hulls.ts';
import { encodeInput, encodeJson, MSG, type Action, type InputMsg } from '../../shared/net/protocol.ts';
import { Game as ServerGame, type Connection as ServerConnection } from '../../server/game/game.ts';
import type { PilotRecord, PilotStorage } from '../../server/storage.ts';
import { dispatchMessage, helloMessage, type NetClient, type NetHandlers } from './connection.ts';

const KEY = 'nova.offline.pilots';

/** Offline pilot storage in localStorage (falls back to memory when storage is unavailable). */
class LocalPilotStore implements PilotStorage {
  private pilots: Record<string, PilotRecord> = {};
  constructor() {
    try {
      this.pilots = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    } catch {
      this.pilots = {};
    }
  }
  private persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.pilots));
    } catch { /* storage blocked — keep in memory */ }
  }
  find(name: string) {
    const p = this.pilots[name.toLowerCase()];
    // older saves predate some cargo kinds and the wardrobe
    if (!p) return null;
    const items = Array.isArray(p.items) ? p.items.filter((x) => typeof x === 'string') : [];
    return { ...structuredClone(p), cargo: { ...emptyCargo(), ...p.cargo }, items, outfit: validOutfit(p.outfit, items), career: validCareer(p.career), ...hangarOf(p.ship, p.ships) };
  }
  create(name: string): PilotRecord {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    const p: PilotRecord = {
      id: Object.keys(this.pilots).length + 1, name, token, credits: 250, cargo: emptyCargo(), upgrades: defaultUpgrades(),
      missiles: MAX_MISSILES / 2, kills: 0, deaths: 0, system: 0, items: [], outfit: defaultOutfit(), career: newCareer(), ship: 'fighter', ships: ['fighter'],
    };
    this.pilots[name.toLowerCase()] = p;
    this.persist();
    return structuredClone(p);
  }
  save(p: PilotRecord) {
    this.pilots[p.name.toLowerCase()] = structuredClone(p);
    this.persist();
  }
}

/**
 * Single-player mode: runs the authoritative game server inside the page and
 * talks to it through an in-memory transport using the exact wire format.
 */
export class LocalConnection implements NetClient {
  rtt = 0;
  open = true;
  private server: ServerGame;
  private conn: ServerConnection;

  constructor(name: string, token: string | undefined, h: NetHandlers) {
    this.server = new ServerGame({ store: new LocalPilotStore(), dev: true });
    this.conn = this.server.connect({
      send: (d) => {
        const copy = d.slice();
        setTimeout(() => dispatchMessage(copy, h), 0);
      },
      close: () => {
        this.open = false;
        setTimeout(() => h.closed(), 0);
      },
      buffered: 0,
    });
    this.server.start();
    setTimeout(() => this.conn.onMessage(helloMessage(name, token)), 0);
    window.addEventListener('beforeunload', () => this.server.stop());
  }

  input(m: InputMsg) {
    this.conn.onMessage(encodeInput(m));
  }

  action(a: Action) {
    this.conn.onMessage(encodeJson(MSG.ACTION, a));
  }

  chat(text: string) {
    this.conn.onMessage(encodeJson(MSG.CHAT, { text }));
  }
}
