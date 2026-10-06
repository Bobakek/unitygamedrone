import { CARGO_NAMES } from '../../shared/economy.ts';
import {
  boardEpoch, BOARD_EPOCH_MS, cannotLoad, cannotTake, clampRep, clockText, FACTION_SHORT, FACTIONS, FREIGHT_ARRIVAL_RISK, FREIGHT_CHECK,
  FREIGHT_ESCORT_SHARE, FREIGHT_FAIL_REP, FREIGHT_FAST_BONUS, FREIGHT_RAID_RISK, freightLoad, generateBoard, isWanted, markDone, RANKS,
  rankOf, SITE_REACH, type ActiveContract, type ContractDef, type Faction,
} from '../../shared/contracts.ts';
import { hashInts, Rng } from '../../shared/math/rng.ts';
import { qlook, quat, v3, vdist, vnorm, vscale, vsub } from '../../shared/math/vec.ts';
import { MODE, MSG, type BoardMsg, type GameEvent } from '../../shared/net/protocol.ts';
import { planetSites, siteDir } from '../../shared/planet/sites.ts';
import type { Session } from './session.ts';
import type { SystemInstance } from './system.ts';

const sitePos = v3();
/** Pirates hunting one pilot's freight at a time, at most. */
const MAX_HUNTERS = 4;

/** Pirates sent after a pilot carrying freight. */
interface Hunt { ids: number[]; next: number; raidAt: number }

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
  /** Session id → pirates hunting their freight and when the next raid check is due. */
  private hunts = new Map<number, Hunt>();
  private rng: Rng;

  constructor(private sys: SystemInstance) {
    this.rng = new Rng(hashInts(sys.def.seed, 0xf7e1));
  }

  /** Current board; returns true in `changed` when it was regenerated. */
  board(): { offers: ContractDef[]; changed: boolean } {
    const ep = boardEpoch(this.sys.now());
    const pois = this.sys.world.list().filter((p) => p.kind === 'convoy' && p.ship);
    const events = this.sys.galaxyEvents();
    const key = pois.map((p) => p.id).join(',') + '|' + events.map((e) => e.id).join(',');
    const changed = ep !== this.epoch || key !== this.convoys;
    if (changed) {
      this.epoch = ep;
      this.convoys = key;
      this.offers = generateBoard(this.sys.def.id, ep, pois, events);
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
    const nope = cannotLoad(def, s.pilot);
    if (nope) return nope;
    const job: ActiveContract = { ...structuredClone(def), have: 0 };
    if (def.kind === 'freight') {
      s.pilot.credits -= def.deposit ?? 0;
      job.due = this.sys.now() + (def.time ?? 0);
    }
    c.active.push(job);
    s.msg(def.kind === 'freight'
      ? `Контракт принят: ${def.title}. Погружено контейнеров: ${def.need}, залог ${def.deposit} кр, срок ${clockText(def.time ?? 0)}`
      : `Контракт принят: ${def.title}`, 'good');
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
    if (gone.kind === 'freight') {
      // containers handed back where they were loaded return the deposit; anywhere else they are dumped
      const home = s.mode === MODE.DOCKED && gone.origin === this.sys.def.id;
      if (home) s.pilot.credits += gone.deposit ?? 0;
      s.msg(home ? `Контракт отменён: ${gone.title}. Контейнеры сданы, залог возвращён` : `Контракт отменён: ${gone.title}. Контейнеры сброшены, залог ${gone.deposit} кр потерян`, 'warn');
    } else s.msg(`Контракт отменён: ${gone.title}`, 'warn');
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
      if (c.kind === 'freight' && c.system === id) { this.deliverFreight(s, c); touched = true; continue; }
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

  /** Freight at its destination: containers unloaded, deposit back, a bonus for speed and a fee for the escort. */
  private deliverFreight(s: Session, c: ActiveContract) {
    const left = (c.due ?? 0) - this.sys.now();
    const fast = left > (c.time ?? 0) / 2 ? Math.round((c.reward.credits * FREIGHT_FAST_BONUS) / 10) * 10 : 0;
    s.pilot.credits += (c.deposit ?? 0) + fast;
    c.have = c.need;
    s.msg(`Груз сдан: залог ${c.deposit} кр возвращён${fast ? `, премия за скорость +${fast} кр` : ''}`, 'good');
    // group mates who flew with the convoy get an escort fee from the Guild
    const fee = Math.round((c.reward.credits * FREIGHT_ESCORT_SHARE) / 10) * 10;
    for (const m of this.sys.crew(s)) {
      if (m === s) continue;
      m.pilot.credits += fee;
      m.sendPilot();
      m.msg(`Сопровождение конвоя ${s.pilot.name}: +${fee} кр от Гильдии`, 'good');
    }
    this.complete(s, c);
  }

  /** Freight that cannot be delivered: the deposit is kept and the Guild remembers. */
  private failFreight(s: Session, c: ActiveContract, why: string) {
    const career = s.pilot.career;
    const i = career.active.indexOf(c);
    if (i < 0) return;
    career.active.splice(i, 1);
    markDone(career, c.id);
    this.rep(s, 'guild', -FREIGHT_FAIL_REP);
    s.sendJson(MSG.EVENTS, { ev: [{ t: 'announce', text: 'Груз потерян', sub: `${c.title}: ${why}. Залог ${c.deposit} кр не вернётся, ${FACTION_SHORT.guild} −${FREIGHT_FAIL_REP}`, kind: 'warn' }] });
  }

  /** The pilot's ship was destroyed: freight in the hold is gone. */
  onShipLost(s: Session) {
    const lost = s.pilot.career.active.filter((a) => a.kind === 'freight');
    for (const c of lost) this.failFreight(s, c, 'корабль уничтожен вместе с контейнерами');
    this.hunts.delete(s.id);
    if (lost.length) s.sendPilot();
  }

  /** Interceptions of convoys that are gone are withdrawn without penalty; late freight fails. */
  expire(s: Session) {
    const now = this.sys.now();
    const late = s.pilot.career.active.filter((a) => a.kind === 'freight' && a.due !== undefined && now > a.due);
    for (const c of late) this.failFreight(s, c, 'срок доставки истёк');
    if (late.length) s.sendPilot();
    const c = s.pilot.career;
    const before = c.active.length;
    c.active = c.active.filter((a) => a.kind !== 'intercept' || a.poi === undefined || this.sys.convoyAlive(a.system, a.poi));
    if (c.active.length !== before) {
      s.msg('Конвой ушёл — контракт на перехват снят', 'info');
      s.sendPilot();
    }
  }

  // ------------------------------------------------------------------ pirates hunting convoys
  private hunt(s: Session): Hunt {
    let h = this.hunts.get(s.id);
    if (!h) { h = { ids: [], next: this.sys.time + FREIGHT_CHECK, raidAt: -1 }; this.hunts.set(s.id, h); }
    return h;
  }

  /** Where the pirates can get at a pilot's freight: flying in open space, not friends of the Syndicate. */
  private exposed(s: Session): boolean {
    const ship = s.ship;
    return s.mode === MODE.SHIP && !ship.dead && !ship.docked && !ship.state.landed && !this.sys.inSafeZone(ship.world.p) && !this.sys.truce(ship);
  }

  /** A pilot with freight came through a gate: pirates may be waiting for the convoy. */
  onArrive(s: Session) {
    this.hunts.delete(s.id);
    const load = freightLoad(s.pilot.career);
    if (!load || this.sys.truce(s.ship)) return;
    const tier = Math.max(...s.pilot.career.active.filter((a) => a.kind === 'freight').map((a) => a.tier));
    const risk = FREIGHT_ARRIVAL_RISK[this.sys.def.security] + 0.08 * (tier - 1);
    if (this.rng.float() < risk) this.hunt(s).raidAt = this.sys.time + this.rng.range(4, 8);
  }

  /** Raids on pilots carrying freight. Called once a second. */
  stepFreight() {
    const t = this.sys.time;
    for (const s of this.sys.sessions) {
      if (!freightLoad(s.pilot.career)) { this.hunts.delete(s.id); continue; }
      const h = this.hunt(s);
      h.ids = h.ids.filter((id) => { const e = this.sys.ship(id); return !!e && !e.dead; });
      if (!this.exposed(s)) continue;
      if (h.raidAt >= 0 && t >= h.raidAt) {
        h.raidAt = -1;
        this.raid(s, h, 'Пираты поджидали конвой на выходе из прыжка');
      } else if (t >= h.next) {
        h.next = t + FREIGHT_CHECK;
        if (this.rng.float() < FREIGHT_RAID_RISK[this.sys.def.security]) this.raid(s, h, 'Перехват! Пиратские налётчики идут на ваш груз');
      }
    }
  }

  /** Spawns raiders on a pilot's tail and knocks them out of cruise. */
  raid(s: Session, h: Hunt = this.hunt(s), text = 'Перехват! Пиратские налётчики идут на ваш груз') {
    const tier = Math.max(1, ...s.pilot.career.active.filter((a) => a.kind === 'freight').map((a) => a.tier));
    const n = Math.min(MAX_HUNTERS - h.ids.length, tier + (this.sys.def.security === 'frontier' ? 1 : 0));
    if (n <= 0) return;
    const ship = s.ship, p = ship.world.p;
    // a pirate jammer drops the convoy out of cruise
    ship.state.cruise = 0;
    ship.state.cruiseBlock = Math.max(ship.state.cruiseBlock, 8);
    const dir = vnorm(v3(), v3(this.rng.range(-1, 1), this.rng.range(-0.3, 0.3), this.rng.range(-1, 1)));
    for (let i = 0; i < n; i++) {
      const at = v3(p.x + dir.x * 1500 + i * 70, p.y + dir.y * 1500 + 45 * i, p.z + dir.z * 1500 - i * 50);
      const e = this.sys.spawnPirate(at);
      e.transient = true;
      e.state.q = qlook(quat(), vnorm(v3(), vsub(v3(), p, at)), v3(0, 1, 0));
      e.npc!.home = v3(p.x, p.y, p.z);
      e.npc!.homeRadius = 2500;
      e.npc!.target = ship.id;
      e.npc!.state = 'attack';
      this.sys.syncWorld(e);
      h.ids.push(e.id);
    }
    s.sendJson(MSG.EVENTS, { ev: [{ t: 'announce', text: 'Налёт на конвой', sub: `${text} (${n}). Отбивайтесь или уходите к станции`, kind: 'warn' }] });
  }

  /** The pilot left the system. */
  forget(s: Session) {
    this.hunts.delete(s.id);
    this.hinted.delete(s.id);
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
