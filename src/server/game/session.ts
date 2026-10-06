import type { WebSocket } from 'ws';
import { encodeJson, MSG, MODE, type InputMsg, type Mode, type PilotInfo } from '../../shared/net/protocol.ts';
import { combatStats } from '../../shared/economy.ts';
import { gearStats, type GearStats } from '../../shared/outfit.ts';
import { ROVER_BED } from '../../shared/planet/deposits.ts';
import type { PilotRecord } from '../storage.ts';
import type { CharEntity, RoverEntity, ShipEntity } from './entities.ts';
import type { SystemInstance } from './system.ts';
import type { Group } from './groups.ts';
import { awardMilestones } from './trophies.ts';
import { tankOf } from '../../shared/jump.ts';

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

/** A connected player: owns one ship, while on foot one character, and on a planet maybe a rover. */
export class Session {
  mode: Mode = MODE.SHIP;
  inputs: InputMsg[] = [];
  lastSeq = 0;
  /** Input-processing budget (tokens per tick). */
  budget = 0;
  teleport = 0;
  char: CharEntity | null = null;
  /** The rover this pilot unloaded (parked or being driven: mode ROVER). */
  rover: RoverEntity | null = null;
  /** The rover's drill at work on a deposit: done at `until` (system time). */
  drill: { planet: number; id: number; until: number } | null = null;
  chatTimes: number[] = [];
  lastSave = 0;
  closed = false;
  god = false;
  group: Group | null = null;
  /** A pending invitation to a group. */
  invite: { from: Session; until: number } | null = null;
  /** The jump drive charging: started at `at`, jumps at `until` (server time). */
  charge: { system: number; target: number; at: number; until: number } | null = null;

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
      name: p.name, credits: Math.floor(p.credits), cargo: { ...p.cargo }, cargoCap: combatStats(p.upgrades, p.ship).cargoCap,
      upgrades: { ...p.upgrades }, missiles: p.missiles, kills: p.kills, deaths: p.deaths, fuel: p.fuel, fuelTank: tankOf(p.ship),
      items: [...p.items], outfit: { ...p.outfit }, career: structuredClone(p.career), trophies: p.trophies.map((t) => ({ ...t })),
      roverBed: { ...p.roverBed }, roverBedCap: ROVER_BED,
      ship: p.ship, ships: [...p.ships], clock: this.system.now(),
    };
  }

  /** Gameplay effect of the outfit the pilot wears. */
  gear(): GearStats {
    return gearStats(this.pilot.outfit);
  }

  /** Sends the pilot info; new kill, rank and reputation trophies are handed out first. */
  sendPilot() {
    awardMilestones(this);
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
