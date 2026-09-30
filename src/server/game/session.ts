import type { WebSocket } from 'ws';
import { encodeJson, MSG, MODE, type InputMsg, type Mode, type PilotInfo } from '../../shared/net/protocol.ts';
import { combatStats } from '../../shared/economy.ts';
import type { PilotRecord } from '../db.ts';
import type { CharEntity, ShipEntity } from './entities.ts';
import type { SystemInstance } from './system.ts';

export interface Transport {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  readonly buffered: number;
}

export function wsTransport(ws: WebSocket): Transport {
  return {
    send: (d) => { if (ws.readyState === ws.OPEN) ws.send(d); },
    close: (c, r) => ws.close(c, r),
    get buffered() { return ws.bufferedAmount; },
  };
}

/** A connected player: owns one ship and, while on foot, one character. */
export class Session {
  mode: Mode = MODE.SHIP;
  inputs: InputMsg[] = [];
  lastSeq = 0;
  teleport = 0;
  char: CharEntity | null = null;
  chatTimes: number[] = [];
  lastSave = 0;
  closed = false;
  god = false;

  constructor(
    public id: number,
    public transport: Transport,
    public pilot: PilotRecord,
    public system: SystemInstance,
    public ship: ShipEntity,
  ) {}

  send(data: Uint8Array) {
    this.transport.send(data);
  }

  sendJson(type: number, payload: unknown) {
    this.send(encodeJson(type, payload));
  }

  pilotInfo(): PilotInfo {
    const p = this.pilot;
    return {
      name: p.name, credits: Math.floor(p.credits), cargo: { ...p.cargo }, cargoCap: combatStats(p.upgrades).cargoCap,
      upgrades: { ...p.upgrades }, missiles: p.missiles, kills: p.kills, deaths: p.deaths,
    };
  }

  sendPilot() {
    this.sendJson(MSG.PILOT, this.pilotInfo());
  }

  msg(text: string, kind: 'info' | 'warn' | 'good' = 'info') {
    this.sendJson(MSG.EVENTS, { ev: [{ t: 'msg', text, kind }] });
  }

  /** Forces the client to drop pending predicted inputs and snap to server state. */
  resync() {
    this.teleport = (this.teleport + 1) & 255;
    this.inputs.length = 0;
  }
}
