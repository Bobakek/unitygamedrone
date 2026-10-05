import type { CharInput, CharState } from '../sim/character.ts';
import type { ShipInput, ShipState } from '../sim/ship.ts';
import type { Blueprint } from '../ships/blueprint.ts';
import type { Cargo, Upgrades } from '../economy.ts';
import type { Outfit } from '../outfit.ts';
import type { Career, ContractDef } from '../contracts.ts';
import type { WeatherKind } from '../weather.ts';
import { Reader, Writer } from './buffer.ts';

export const MSG = {
  HELLO: 1, INPUT: 2, ACTION: 3, CHAT: 4, PING: 5,
  WELCOME: 20, SNAPSHOT: 21, INFO: 22, GONE: 23, SHOTS: 24, EVENTS: 25, PILOT: 26, PONG: 27, ERROR: 28, WORLD: 29, BOARD: 30,
} as const;

export const KIND = { SHIP: 1, CHAR: 2, MISSILE: 3, LOOT: 4, CREATURE: 5 } as const;
/** Shot.level used for the pilot's hand blaster. */
export const BLASTER_LEVEL = 10;
export const EFLAG = { LANDED: 1, CRUISE: 2, BOOST: 4, HIDDEN: 8, NPC: 16, SAFE: 32, DEAD: 64 } as const;
/**
 * Flags of pilots on foot (KIND.CHAR). For these entities `throttle` carries the traversal
 * progress (vault in 0..0.5, climb in 0.5..1) and `shield` the aim pitch (see aimByte).
 */
export const CFLAG = { SCRAMBLE: 1, CLIMB: 2, AIR: 4, SWIM: 8, UNDER: 16, AIM: 128 } as const;
export const aimByte = (pitch: number) => Math.max(0, Math.min(1, pitch / 2.6 + 0.5));
export const aimPitch = (b: number) => (b - 0.5) * 2.6;
export const IFLAG = { FIRE: 1, BOOST: 2, CRUISE: 4, JUMP: 8, SPRINT: 16, AIM: 32, DIVE: 64 } as const;
export const MODE = { SHIP: 0, FOOT: 1, DOCKED: 2, DEAD: 3 } as const;
export type Mode = (typeof MODE)[keyof typeof MODE];

// ---------------------------------------------------------------- JSON messages
export interface PilotInfo {
  name: string; credits: number; cargo: Cargo; cargoCap: number; upgrades: Upgrades;
  missiles: number; kills: number; deaths: number;
  /** Bought suit parts and the outfit worn. */
  items: string[]; outfit: Outfit;
  /** Experience, reputation and contracts. */
  career: Career;
}
/** The station contract board (sent while docked); `next` = ms until it is refreshed. */
export interface BoardMsg { system: number; offers: ContractDef[]; next: number }
/** `look` (pilots on foot): outfit code, see outfit.ts lookCode; `wanted`: a player ship wanted by the Federation. */
export interface EntityInfo { id: number; kind: number; name: string; bp?: Blueprint; npc?: boolean; owner?: number; species?: number; look?: string; wanted?: boolean }
export interface Harvested { planet: number; node: number; left: number }
export interface Welcome {
  playerId: number; shipId: number; token: string; pilot: PilotInfo; system: number;
  dev: boolean; tick: number; time: number; harvested: Harvested[]; motd: string;
}
export type GameEvent =
  | { t: 'hit'; target: number; pos: [number, number, number]; shield: boolean; dmg: number; by: number }
  | { t: 'boom'; id: number; pos: [number, number, number]; big: boolean }
  | { t: 'kill'; killer: string; victim: string }
  | { t: 'chat'; from: string; text: string }
  | { t: 'msg'; text: string; kind?: 'info' | 'warn' | 'good' }
  | { t: 'harvest'; planet: number; node: number; left: number; by: number }
  | { t: 'missile'; id: number; target: number }
  /** Big centred banner for world events. */
  | { t: 'announce'; text: string; sub?: string; kind?: 'info' | 'warn' | 'good' }
  /** Anomaly scan progress for this pilot (k in 0..1, -1 = left the field). */
  | { t: 'scan'; id: number; k: number }
  | { t: 'loot'; text: string; pos: [number, number, number] }
  /** The local pilot's suit took damage. */
  | { t: 'hurt'; dmg: number; by: number }
  /** A creature attacks (animation cue). */
  | { t: 'bite'; id: number }
  /** A predator roars as it starts a hunt. */
  | { t: 'roar'; id: number }
  /** Lightning struck at a body-frame point of a planet. */
  | { t: 'strike'; planet: number; pos: [number, number, number] }
  /** The server forced a planet's weather until `until` (dev). */
  | { t: 'weather'; planet: number; kind: WeatherKind; k: number; until: number };

export type Action =
  | { a: 'exit' } | { a: 'board' } | { a: 'dock' } | { a: 'undock' } | { a: 'jump' }
  | { a: 'harvest'; node: number }
  | { a: 'sell' } | { a: 'repair' } | { a: 'buyMissiles' } | { a: 'upgrade'; key: string }
  | { a: 'missile'; target: number } | { a: 'respawn' }
  | { a: 'salvage'; id: number } | { a: 'sample'; id: number }
  | { a: 'buyItem'; id: string } | { a: 'equip'; id: string }
  | { a: 'takeContract'; id: string } | { a: 'dropContract'; id: string };

export function encodeJson(type: number, payload: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const out = new Uint8Array(body.length + 1);
  out[0] = type;
  out.set(body, 1);
  return out;
}
export function decodeJson<T>(data: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(data.subarray(1))) as T;
}

// ---------------------------------------------------------------- input
export interface InputMsg {
  seq: number; mode: number; flags: number;
  /** Client's estimate of server time when the input was made (orients planet frames). */
  t: number;
  ship: ShipInput; char: CharInput;
}
const q8 = (v: number) => Math.max(-127, Math.min(127, Math.round(v * 127)));
const d8 = (v: number) => v / 127;

export function encodeInput(m: InputMsg): Uint8Array {
  const w = new Writer(32);
  w.u8(MSG.INPUT).u32(m.seq).u8(m.mode).u16(m.flags).f64(m.t);
  if (m.mode === MODE.FOOT) {
    w.i8(q8(m.char.mx)).i8(q8(m.char.mz)).f32(m.char.yawDelta).i8(q8(m.char.pitch / 1.3));
  } else {
    const s = m.ship;
    w.i8(q8(s.yaw)).i8(q8(s.pitch)).i8(q8(s.roll)).i8(q8(s.throttle)).i8(q8(s.strafeX)).i8(q8(s.strafeY));
  }
  return w.finish();
}

export function decodeInput(data: Uint8Array): InputMsg {
  const r = new Reader(data);
  r.u8();
  const seq = r.u32(), mode = r.u8(), flags = r.u16();
  const tt = r.f64(), t = Number.isFinite(tt) ? tt : 0;
  const ship: ShipInput = { yaw: 0, pitch: 0, roll: 0, throttle: 0, strafeX: 0, strafeY: 0, boost: !!(flags & IFLAG.BOOST), cruise: !!(flags & IFLAG.CRUISE) };
  const char: CharInput = { mx: 0, mz: 0, yawDelta: 0, pitch: 0, jump: !!(flags & IFLAG.JUMP), sprint: !!(flags & IFLAG.SPRINT), dive: !!(flags & IFLAG.DIVE) };
  if (mode === MODE.FOOT) {
    char.mx = d8(r.i8()); char.mz = d8(r.i8());
    const yd = r.f32();
    char.yawDelta = Number.isFinite(yd) ? Math.max(-0.5, Math.min(0.5, yd)) : 0;
    char.pitch = d8(r.i8()) * 1.3;
  } else {
    ship.yaw = d8(r.i8()); ship.pitch = d8(r.i8()); ship.roll = d8(r.i8());
    ship.throttle = Math.max(-0.3, d8(r.i8())); ship.strafeX = d8(r.i8()); ship.strafeY = d8(r.i8());
  }
  return { seq, mode, flags, t, ship, char };
}

/** Round-trips an input through the wire format so client prediction matches the server bit-for-bit. */
export function quantizeInput(m: InputMsg): InputMsg {
  return decodeInput(encodeInput(m));
}

// ---------------------------------------------------------------- snapshot
export interface SelfState {
  shipId: number; mode: number; teleport: number;
  ship: ShipState;
  hull: number; maxHull: number; shield: number; maxShield: number; energy: number; missiles: number;
  charId: number; char: CharState | null; charPlanet: number;
  /** Pilot suit integrity in percent (on foot). */
  suit: number;
}
export interface EntityState {
  id: number; kind: number; flags: number;
  /** 0 = world coordinates, planet index + 1 = that planet's body frame. */
  frame: number;
  px: number; py: number; pz: number;
  qx: number; qy: number; qz: number; qw: number;
  vx: number; vy: number; vz: number;
  hull: number; shield: number; throttle: number;
}
export interface Snapshot { tick: number; time: number; ack: number; self: SelfState; entities: EntityState[] }

const qi16 = (v: number) => Math.max(-32767, Math.min(32767, Math.round(v * 32767)));

export function encodeSnapshot(s: Snapshot): Uint8Array {
  const w = new Writer(512 + s.entities.length * 48);
  w.u8(MSG.SNAPSHOT).u32(s.tick).f64(s.time).u32(s.ack);
  const me = s.self;
  w.u32(me.shipId).u8(me.mode).u8(me.teleport);
  const sh = me.ship;
  w.f64(sh.p.x).f64(sh.p.y).f64(sh.p.z).f64(sh.v.x).f64(sh.v.y).f64(sh.v.z);
  w.f64(sh.q.x).f64(sh.q.y).f64(sh.q.z).f64(sh.q.w);
  w.f64(sh.boost).f64(sh.cruise).f64(sh.cruiseBlock).u8(sh.landed).u8(sh.frame);
  w.f32(me.hull).f32(me.maxHull).f32(me.shield).f32(me.maxShield).u8(Math.round(me.energy)).u8(me.missiles).u8(Math.max(0, Math.min(255, Math.round(me.suit))));
  if (me.char) {
    const c = me.char;
    w.u8(1).u32(me.charId).i8(me.charPlanet);
    w.f64(c.p.x).f64(c.p.y).f64(c.p.z).f64(c.v.x).f64(c.v.y).f64(c.v.z).f64(c.f.x).f64(c.f.y).f64(c.f.z);
    w.u8(c.ground).f64(c.fuel).u8(c.climbMode).f64(c.climb).f64(c.climbRise).f64(c.climbFwd).f64(c.climbUp).u8(c.scramble).u8(c.swim).f64(c.air);
  } else w.u8(0);
  w.u16(s.entities.length);
  for (const e of s.entities) {
    w.u32(e.id).u8(e.kind).u8(e.flags).u8(e.frame);
    w.f32(e.px).f32(e.py).f32(e.pz);
    w.i16(qi16(e.qx)).i16(qi16(e.qy)).i16(qi16(e.qz)).i16(qi16(e.qw));
    w.f32(e.vx).f32(e.vy).f32(e.vz);
    w.u8(Math.round(e.hull * 255)).u8(Math.round(e.shield * 255)).u8(Math.round(Math.max(0, e.throttle) * 255));
  }
  return w.finish();
}

export function decodeSnapshot(data: Uint8Array): Snapshot {
  const r = new Reader(data);
  r.u8();
  const tick = r.u32(), time = r.f64(), ack = r.u32();
  const shipId = r.u32(), mode = r.u8(), teleport = r.u8();
  const ship: ShipState = {
    p: { x: r.f64(), y: r.f64(), z: r.f64() }, v: { x: r.f64(), y: r.f64(), z: r.f64() },
    q: { x: r.f64(), y: r.f64(), z: r.f64(), w: r.f64() },
    boost: r.f64(), cruise: r.f64(), cruiseBlock: r.f64(), landed: r.u8(), frame: r.u8(),
  };
  const hull = r.f32(), maxHull = r.f32(), shield = r.f32(), maxShield = r.f32(), energy = r.u8(), missiles = r.u8(), suit = r.u8();
  let char: CharState | null = null, charId = 0, charPlanet = -1;
  if (r.u8()) {
    charId = r.u32(); charPlanet = r.i8();
    char = {
      p: { x: r.f64(), y: r.f64(), z: r.f64() }, v: { x: r.f64(), y: r.f64(), z: r.f64() }, f: { x: r.f64(), y: r.f64(), z: r.f64() },
      ground: r.u8(), fuel: r.f64(), climbMode: r.u8(), climb: r.f64(), climbRise: r.f64(), climbFwd: r.f64(), climbUp: r.f64(), scramble: r.u8(), swim: r.u8(), air: r.f64(),
    };
  }
  const n = r.u16();
  const entities: EntityState[] = [];
  for (let i = 0; i < n; i++) {
    entities.push({
      id: r.u32(), kind: r.u8(), flags: r.u8(), frame: r.u8(),
      px: r.f32(), py: r.f32(), pz: r.f32(),
      qx: r.i16() / 32767, qy: r.i16() / 32767, qz: r.i16() / 32767, qw: r.i16() / 32767,
      vx: r.f32(), vy: r.f32(), vz: r.f32(),
      hull: r.u8() / 255, shield: r.u8() / 255, throttle: r.u8() / 255,
    });
  }
  return { tick, time, ack, self: { shipId, mode, teleport, ship, hull, maxHull, shield, maxShield, energy, missiles, charId, char, charPlanet, suit }, entities };
}

// ---------------------------------------------------------------- shots
export interface Shot { shooter: number; px: number; py: number; pz: number; vx: number; vy: number; vz: number; level: number }
export function encodeShots(shots: Shot[]): Uint8Array {
  const w = new Writer(8 + shots.length * 29);
  w.u8(MSG.SHOTS).u16(shots.length);
  for (const s of shots) w.u32(s.shooter).f32(s.px).f32(s.py).f32(s.pz).f32(s.vx).f32(s.vy).f32(s.vz).u8(s.level);
  return w.finish();
}
export function decodeShots(data: Uint8Array): Shot[] {
  const r = new Reader(data);
  r.u8();
  const n = r.u16();
  const out: Shot[] = [];
  for (let i = 0; i < n; i++) out.push({ shooter: r.u32(), px: r.f32(), py: r.f32(), pz: r.f32(), vx: r.f32(), vy: r.f32(), vz: r.f32(), level: r.u8() });
  return out;
}
