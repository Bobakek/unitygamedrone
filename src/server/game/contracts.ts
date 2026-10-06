import { CARGO_NAMES } from '../../shared/economy.ts';
import {
  boardEpoch, BOARD_EPOCH_MS, cannotTake, clampRep, FACTION_SHORT, FACTIONS, generateBoard, isWanted, markDone, RANKS, rankOf,
  SITE_REACH, type ActiveContract, type ContractDef, type Faction,
} from '../../shared/contracts.ts';
import { v3, vdist, vscale } from '../../shared/math/vec.ts';
import { MODE, MSG, type BoardMsg, type GameEvent } from '../../shared/net/protocol.ts';
import { planetSites, siteDir } from '../../shared/planet/sites.ts';
import type { Session } from './session.ts';
import type { SystemInstance } from './system.ts';

const sitePos = v3();

/**
 * The contract desk of a system: its station board (regenerated every epoch
 * and when convoys come and go), taking and dropping contracts, progress
 * hooks called from combat, fauna and docking, and the rewards.
 */
export class ContractDesk {
  private epoch = -1;
  private convoys = '';
  private offers: ContractDef[] = [];
  /** Session id → server time of the last "not enough cargo" hint (smuggling). */
  private hinted = new Map<number, number>();

  constructor(private sys: SystemInstance) {}

  /** Current board; returns true in `changed` when it was regenerated. */
  board(): { offers: ContractDef[]; changed: boolean } {
    const ep = boardEpoch(this.sys.now());
    const pois = this.sys.world.list().filter((p) => p.kind === 'convoy' && p.ship);
    const key = pois.map((p) => p.id).join(',');
    const changed = ep !== this.epoch || key !== this.convoys;
    if (changed) {
      this.epoch = ep;
      this.convoys = key;
      this.offers = generateBoard(this.sys.def.id, ep, pois);
    }
    return { offers: this.offers, changed };
  }

  boardMsg(): BoardMsg {
    const { offers } = this.board();
    return { system: this.sys.def.id, offers, next: (this.epoch + 1) * BOARD_EPOCH_MS - this.sys.now() };
  }

  sendBoard(s: Session) {
    s.sendJson(MSG.BOARD, this.boardMsg());
  }

  // ------------------------------------------------------------------ actions
  take(s: Session, id: string): string | null {
    if (s.mode !== MODE.DOCKED) return 'Нужно пристыковаться';
    const def = this.board().offers.find((o) => o.id === id);
    if (!def) return 'Предложение устарело';
    const c = s.pilot.career;
    const why = cannotTake(def, c);
    if (why) return why;
    c.active.push({ ...structuredClone(def), have: 0 });
    s.msg(`Контракт принят: ${def.title}`, 'good');
    s.sendPilot();
    // supplies for this very station are handed over at once
    this.deliver(s);
    return null;
  }

  drop(s: Session, id: string): string | null {
    const c = s.pilot.career;
    const i = c.active.findIndex((a) => a.id === id);
    if (i < 0) return null;
    const [gone] = c.active.splice(i, 1);
    // abandoning interception of a convoy that already left costs nothing
    if (gone.kind !== 'intercept') this.rep(s, gone.faction, -2);
    s.msg(`Контракт отменён: ${gone.title}`, 'warn');
    s.sendPilot();
    return null;
  }

  // ------------------------------------------------------------------ progress hooks
  /** Adds `n` to every active contract of the pilot matching `pred`. */
  private progress(s: Session, pred: (c: ActiveContract) => boolean, n = 1) {
    let touched = false;
    for (const c of [...s.pilot.career.active]) {
      if (!pred(c)) continue;
      c.have = Math.min(c.need, c.have + n);
      touched = true;
      if (c.have >= c.need) this.complete(s, c);
      else s.msg(`${c.title}: ${c.have}/${c.need}`);
    }
    if (touched) s.sendPilot();
  }

  /** Kill credit goes to the pilot and to their group mates nearby. */
  private crewProgress(s: Session, pred: (c: ActiveContract) => boolean) {
    for (const m of this.sys.crew(s)) this.progress(m, pred);
  }

  /** A player shot down a pirate ship. */
  onPirateKill(s: Session) {
    this.rep(s, 'pirate', -2);
    this.rep(s, 'fed', 1);
    const id = this.sys.def.id;
    this.crewProgress(s, (c) => c.kind === 'pirates' && c.system === id);
  }

  /** A player destroyed a turret of base `site` on `planet`. */
  onTurretKill(s: Session, planet: number, site: number) {
    this.rep(s, 'pirate', -4);
    const id = this.sys.def.id;
    this.crewProgress(s, (c) => c.kind === 'clear' && c.system === id && c.planet === planet && c.site === site);
  }

  /** A player destroyed the freighter of convoy `poi`. */
  onFreighterKill(s: Session, poi: number) {
    const id = this.sys.def.id;
    this.crewProgress(s, (c) => c.kind === 'intercept' && c.system === id && c.poi === poi);
  }

  /** A player killed a creature. */
  onCreatureKill(s: Session, species: number, planet: number) {
    const id = this.sys.def.id;
    this.crewProgress(s, (c) => c.kind === 'hunt' && c.system === id && c.species === species && c.planet === planet);
  }

  /** Docked at this system's station: hand over supplies and deliveries (partly if need be). */
  deliver(s: Session) {
    const p = s.pilot, id = this.sys.def.id;
    let touched = false;
    for (const c of [...p.career.active]) {
      if ((c.kind !== 'supply' && c.kind !== 'deliver') || c.system !== id || !c.cargo) continue;
      const give = Math.min(p.cargo[c.cargo], c.need - c.have);
      if (give <= 0) continue;
      p.cargo[c.cargo] -= give;
      c.have += give;
      touched = true;
      if (c.have >= c.need) this.complete(s, c);
      else s.msg(`${c.title}: сдано ${CARGO_NAMES[c.cargo].toLowerCase()} ×${give} (${c.have}/${c.need})`);
    }
    if (touched) s.sendPilot();
  }

  /** Survey and smuggling: pilots on foot who reached the site centre. Called a few times a second. */
  checkSites() {
    const id = this.sys.def.id;
    for (const s of this.sys.sessions) {
      const ch = s.char;
      if (s.mode !== MODE.FOOT || !ch) continue;
      for (const c of [...s.pilot.career.active]) {
        if ((c.kind !== 'survey' && c.kind !== 'smuggle') || c.system !== id || c.planet !== ch.planet || c.site === undefined) continue;
        const pl = this.sys.def.planets[ch.planet];
        const site = planetSites(pl)[c.site];
        if (!site) continue;
        // the goal: the centre of ruins, the bridge of a wreck
        const g = siteDir(pl, site, site.goal.x, site.goal.z, sitePos);
        vscale(sitePos, g, Math.hypot(ch.state.p.x, ch.state.p.y, ch.state.p.z));
        if (vdist(sitePos, ch.state.p) > (site.kind === 'wreck' ? 6 : SITE_REACH)) continue;
        if (c.kind === 'smuggle' && c.cargo) {
          if (s.pilot.cargo[c.cargo] < c.need) {
            const last = this.hinted.get(s.id) ?? -99;
            if (this.sys.time - last > 10) {
              this.hinted.set(s.id, this.sys.time);
              s.msg(`Заказчику нужно: ${CARGO_NAMES[c.cargo].toLowerCase()} ×${c.need} — у вас ${s.pilot.cargo[c.cargo]}`, 'warn');
            }
            continue;
          }
          s.pilot.cargo[c.cargo] -= c.need;
        }
        c.have = c.need;
        this.complete(s, c);
        s.sendPilot();
      }
    }
  }

  /** Interceptions of convoys that are gone are withdrawn without penalty. */
  expire(s: Session) {
    const c = s.pilot.career;
    const before = c.active.length;
    c.active = c.active.filter((a) => a.kind !== 'intercept' || a.poi === undefined || this.sys.convoyAlive(a.system, a.poi));
    if (c.active.length !== before) {
      s.msg('Конвой ушёл — контракт на перехват снят', 'info');
      s.sendPilot();
    }
  }

  /** Dev: completes a contract on the spot. */
  devFinish(s: Session, c: ActiveContract) {
    c.have = c.need;
    this.complete(s, c);
    s.sendPilot();
  }

  // ------------------------------------------------------------------ rewards
  private complete(s: Session, c: ActiveContract) {
    const career = s.pilot.career;
    const i = career.active.indexOf(c);
    if (i < 0) return;
    career.active.splice(i, 1);
    markDone(career, c.id);
    const rank = rankOf(career.xp);
    s.pilot.credits += c.reward.credits;
    career.xp += c.reward.xp;
    this.rep(s, c.faction, c.reward.rep);
    for (const f of FACTIONS) if (c.side?.[f]) this.rep(s, f, c.side[f]!);
    const ev: GameEvent[] = [{ t: 'announce', text: 'Контракт выполнен', sub: `${c.title} — +${c.reward.credits} кр, +${c.reward.xp} опыта, ${FACTION_SHORT[c.faction]} +${c.reward.rep}`, kind: 'good' }];
    const now = rankOf(career.xp);
    if (now > rank) ev.push({ t: 'announce', text: `Новое звание: ${RANKS[now].name}`, sub: `Контрактов одновременно: ${RANKS[now].slots} · задания до ${RANKS[now].tier} уровня`, kind: 'good' });
    s.sendJson(MSG.EVENTS, { ev });
  }

  /** Changes standing with a faction; a change of "wanted" status is shown to everyone. */
  rep(s: Session, f: Faction, d: number) {
    const c = s.pilot.career;
    const was = isWanted(c);
    c.rep[f] = clampRep(c.rep[f] + d);
    if (isWanted(c) !== was) {
      this.sys.infos.push(this.sys.shipInfo(s.ship));
      s.msg(isWanted(c) ? 'Федерация объявила вас в розыск: за ваш корабль назначена награда' : 'Федерация сняла вас с розыска', isWanted(c) ? 'warn' : 'good');
    }
  }
}
