import type { CharState } from '../../shared/sim/character.ts';
import type { RoverState } from '../../shared/sim/rover.ts';
import type { ShipInput, ShipState, ShipStats } from '../../shared/sim/ship.ts';
import type { Blueprint } from '../../shared/ships/blueprint.ts';
import type { CombatStats } from '../../shared/economy.ts';
import type { V3 } from '../../shared/math/vec.ts';
import type { Session } from './session.ts';
import type { NpcBrain } from './npc.ts';
import type { ModuleKey } from '../../shared/modules.ts';
import type { Pose } from '../../shared/sim/frames.ts';

export interface ShipEntity {
  id: number;
  name: string;
  bp: Blueprint;
  state: ShipState;
  /** World-space pose derived from `state` at the current server time (state may be in a planet frame). */
  world: Pose;
  flight: ShipStats;
  combat: CombatStats;
  hull: number;
  shield: number;
  energy: number;
  lastHit: number;
  fireCooldown: number;
  gun: number;
  throttle: number;
  boosting: boolean;
  dead: boolean;
  respawnAt: number;
  docked: boolean;
  god: boolean;
  session: Session | null;
  npc: NpcBrain | null;
  lastInput: ShipInput;
  /** Event NPCs (convoys, ambushes) are not replaced when destroyed. */
  transient?: boolean;
  /** Bounty override for the killer. */
  bounty?: number;
  /** Server time a player ship last shot at an NPC (pirates stay hostile to it for a while). */
  provokedAt?: number;
  /** An NPC knocked out by fire: dead in space, open to boarding (see boarding.ts). */
  disabled?: boolean;
  /** Sim time it was disabled: bolts already in flight then can't finish it off. */
  disabledAt?: number;
  /** Weapon modules fitted, slot by slot (see modules.ts), and when each slot can fire again. */
  mods?: ModuleKey[];
  modReady?: number[];
  /** Guns and modules jammed by an EMP until this time. */
  jamUntil?: number;
  /** Mines in the magazine when they don't come from the pilot's stock (arena seats). */
  mineAmmo?: number;
}

export interface CharEntity {
  id: number;
  name: string;
  /** Body-frame state of planet `planet` (deck coordinates on a station deck or aboard a ship). */
  state: CharState;
  planet: number;
  /** Aboard this disabled ship (its deck coordinates, see boarding.ts). */
  aboard?: number;
  session: Session;
  /** Suit integrity (of `maxHp`, set by the outfit), time of the last injury and blaster cooldown. */
  hp: number;
  maxHp: number;
  hurtAt: number;
  cool: number;
  /** Last aim pitch, aim button and time of the last blaster shot (for remote animation). */
  pitch: number;
  aim: boolean;
  shotAt: number;
  /** Seconds spent out of air (drowning damage ticks once a second). */
  drown: number;
  /** Last time the client was told about weather damage. */
  hazardAt?: number;
}

/** A pilot's planetary rover, unloaded from their landed ship. */
export interface RoverEntity {
  id: number;
  owner: Session;
  /** Body-frame state of planet `planet`. */
  state: RoverState;
  planet: number;
}

export interface Missile {
  id: number;
  owner: number;
  target: number;
  p: V3;
  v: V3;
  life: number;
}

export interface Laser {
  owner: number;
  p: V3;
  v: V3;
  life: number;
  dmg: number;
  /** Mining power of the shooter's ship (0: the laser passes through asteroids). */
  mine: number;
}
