import { MSG, type GameEvent } from '../../shared/net/protocol.ts';
import { addTrophy, milestoneTrophies } from '../../shared/station/trophies.ts';
import type { Session } from './session.ts';

/**
 * Gives the pilot a trophy for their cabin (no-op if they have it already) and
 * announces it. Returns whether it was new. The pilot info is not re-sent here:
 * callers do that as part of the change that earned it.
 */
export function awardTrophy(s: Session, id: string): boolean {
  const info = addTrophy(s.pilot.trophies, id, Date.now());
  if (!info) return false;
  const ev: GameEvent[] = [{ t: 'announce', text: 'Новый трофей в каюте', sub: info.name, kind: 'good' }];
  s.sendJson(MSG.EVENTS, { ev });
  return true;
}

/** Patches and medals for kills, rank and reputation the pilot has reached. */
export function awardMilestones(s: Session): void {
  const p = s.pilot;
  for (const id of milestoneTrophies(p.trophies, p.kills, p.career.xp, p.career.rep)) awardTrophy(s, id);
}
