import { vdist, type V3 } from '../../shared/math/vec.ts';
import { MODE, MSG, type GroupMember, type GroupMsg } from '../../shared/net/protocol.ts';
import type { Session } from './session.ts';

/** Most pilots in a group. */
export const GROUP_MAX = 5;
/** Seconds an invitation stays open. */
export const INVITE_TTL = 60;
/** Members this close to a kill share its bounty and contract credit (m). */
export const SHARE_RANGE = 5000;
/** Each extra member nearby adds this share to the bounty that is split. */
export const GROUP_BONUS = 0.15;

export class Group {
  members: Session[] = [];
  constructor(public leader: Session) {}
}

export interface GroupWorld {
  readonly time: number;
  readonly sessions: Map<number, Session>;
}

/**
 * Pilot groups (parties): invitations, leaving and expelling, the group panel data sent to
 * members once a second, and who counts as a group mate nearby for shared kills.
 * Groups live only while their members are online.
 */
export class Groups {
  constructor(private w: GroupWorld) {}

  invite(s: Session, to: Session | undefined): string | null {
    if (!to || to.closed) return 'Пилот не найден';
    if (to === s) return 'Нельзя пригласить себя';
    const g = s.group;
    if (g && g.leader !== s) return 'Приглашать может только лидер группы';
    if (g && g.members.length >= GROUP_MAX) return `В группе не больше ${GROUP_MAX} пилотов`;
    if (to.group) return to.group === g ? `${to.pilot.name} уже в вашей группе` : `${to.pilot.name} уже в другой группе`;
    if (to.invite && to.invite.until > this.w.time && to.invite.from !== s) return `${to.pilot.name} уже думает над другим приглашением`;
    to.invite = { from: s, until: this.w.time + INVITE_TTL };
    s.msg(`Приглашение отправлено: ${to.pilot.name}`);
    to.msg(`${s.pilot.name} зовёт вас в группу: Y — принять, N — отказаться`, 'good');
    this.send(to);
    return null;
  }

  answer(s: Session, yes: boolean): string | null {
    const inv = s.invite;
    s.invite = null;
    if (!inv || inv.until <= this.w.time || inv.from.closed) { this.send(s); return 'Приглашение устарело'; }
    const from = inv.from;
    if (!yes) {
      from.msg(`${s.pilot.name} отказался от приглашения`, 'warn');
      this.send(s);
      return null;
    }
    if (s.group) this.leave(s);
    let g = from.group;
    if (g && g.leader !== from) { this.send(s); return 'Пригласивший больше не лидер группы'; }
    if (g && g.members.length >= GROUP_MAX) { this.send(s); return 'Группа уже полная'; }
    if (!g) {
      g = new Group(from);
      g.members.push(from);
      from.group = g;
    }
    g.members.push(s);
    s.group = g;
    this.tell(g, `${s.pilot.name} в группе`, 'good');
    this.sendGroup(g);
    return null;
  }

  leave(s: Session): string | null {
    const g = s.group;
    if (!g) return 'Вы не в группе';
    this.remove(g, s);
    s.msg('Вы вышли из группы');
    this.send(s);
    return null;
  }

  kick(s: Session, name: string): string | null {
    const g = s.group;
    if (!g) return 'Вы не в группе';
    if (g.leader !== s) return 'Исключать может только лидер группы';
    const m = g.members.find((x) => x.pilot.name.toLowerCase() === name.trim().toLowerCase());
    if (!m || m === s) return 'В группе нет такого пилота';
    this.remove(g, m);
    m.msg('Лидер исключил вас из группы', 'warn');
    this.send(m);
    return null;
  }

  /** A pilot went offline. */
  drop(s: Session) {
    for (const o of this.w.sessions.values()) if (o.invite?.from === s) { o.invite = null; this.send(o); }
    if (s.group) this.remove(s.group, s);
  }

  private remove(g: Group, s: Session) {
    g.members = g.members.filter((m) => m !== s);
    s.group = null;
    if (g.members.length <= 1) {
      // a group of one is no group
      for (const m of g.members) { m.group = null; m.msg('Группа распалась'); this.send(m); }
      g.members = [];
      return;
    }
    this.tell(g, `${s.pilot.name} покинул группу`);
    if (g.leader === s) {
      g.leader = g.members[0];
      this.tell(g, `Новый лидер группы: ${g.leader.pilot.name}`);
    }
    this.sendGroup(g);
  }

  allies(a: Session, b: Session): boolean {
    return a !== b && !!a.group && a.group === b.group;
  }

  /** `s` first, then group mates alive in the same system within `range` of `at`. */
  crew(s: Session, at: V3, range: number): Session[] {
    const out = [s];
    for (const m of s.group?.members ?? []) {
      if (m === s || m.system !== s.system || m.mode === MODE.DEAD) continue;
      if (vdist(m.system.focusOf(m), at) <= range) out.push(m);
    }
    return out;
  }

  /** Group chat. */
  say(s: Session, text: string) {
    if (!s.group) { s.msg('Вы не в группе', 'warn'); return; }
    for (const m of s.group.members) m.sendJson(MSG.EVENTS, { ev: [{ t: 'chat', from: `[группа] ${s.pilot.name}`, text }] });
  }

  list(s: Session): string {
    const g = s.group;
    if (!g) return 'Вы не в группе. /invite <имя> — пригласить';
    return `Группа (${g.members.length}/${GROUP_MAX}): ${g.members.map((m) => (m === g.leader ? `★${m.pilot.name}` : m.pilot.name)).join(', ')}`;
  }

  /** Once a second: members' whereabouts and hull; invitations that ran out. */
  step() {
    for (const s of this.w.sessions.values()) {
      if (s.invite && s.invite.until <= this.w.time) {
        s.invite.from.msg(`${s.pilot.name} не ответил на приглашение`);
        s.invite = null;
        this.send(s);
      } else if (s.group) this.send(s);
    }
  }

  private sendGroup(g: Group) {
    for (const m of g.members) this.send(m);
  }

  private tell(g: Group, text: string, kind: 'info' | 'good' = 'info') {
    for (const m of g.members) m.msg(text, kind);
  }

  /** The group panel of one pilot. */
  send(s: Session) {
    const g = s.group;
    const members: GroupMember[] = (g?.members ?? []).map((m) => {
      const out: GroupMember = {
        id: m.id, name: m.pilot.name, system: m.system.def.id, mode: m.mode,
        hull: Math.max(0, Math.min(1, m.ship.hull / m.ship.combat.maxHull)), leader: m === g!.leader,
      };
      if (m.system === s.system) {
        // at the station (cockpit or deck) the station itself marks them
        const p = m.mode === MODE.DOCKED || m.mode === MODE.DECK ? m.system.def.station.pos : m.system.focusOf(m);
        out.pos = [p.x, p.y, p.z];
      }
      return out;
    });
    const msg: GroupMsg = { members };
    if (s.invite && s.invite.until > this.w.time) msg.invite = { from: s.invite.from.pilot.name };
    s.sendJson(MSG.GROUP, msg);
  }
}
