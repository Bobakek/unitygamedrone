import type { CharState } from '../../shared/sim/character.ts';
import type { ShipInput, ShipState, ShipStats } from '../../shared/sim/ship.ts';
import type { Blueprint } from '../../shared/ships/blueprint.ts';
import type { CombatStats } from '../../shared/economy.ts';
import type { V3 } from '../../shared/math/vec.ts';
import type { Session } from './session.ts';
import type { NpcBrain } from './npc.ts';
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
}

export interface CharEntity {
  id: number;
  name: string;
  /** Body-frame state of planet `planet`. */
  state: CharState;
  planet: number;
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
}
