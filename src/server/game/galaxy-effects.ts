import { SAFE_ZONE_RADIUS } from '../../shared/constants.ts';
import type { LootContents } from '../../shared/events.ts';
import { eventTitle, type GalaxyEvent } from '../../shared/galaxy-events.ts';
import { getGalaxy } from '../../shared/galaxy/galaxy.ts';
import { makeName } from '../../shared/galaxy/names.ts';
import { hashInts, Rng } from '../../shared/math/rng.ts';
import { qlook, quat, v3, vnorm, vsub, type V3 } from '../../shared/math/vec.ts';
import { MODE } from '../../shared/net/protocol.ts';
import type { SystemInstance } from './system.ts';

/** Raiders kept around the station during a raid, by security zone. */
const RAIDERS = { core: 3, mid: 4, frontier: 5 } as const;
/** Seconds between raid waves (lost raiders are replaced). */
const WAVE_EVERY = 80;
export const RAIDER_BOUNTY = 140;
/** Storm: average seconds between meteor hits on a ship in open space, and their damage. */
const METEOR_EVERY = 22;
const METEOR_DAMAGE: readonly [number, number] = [6, 16];
/** Storm: seconds between fragments drifting up near each pilot in space. */
const FRAGMENT_EVERY = 18;

/**
 * What galaxy events do inside a system that is being simulated (someone is flying here):
 * raiders swarm the station's approaches, a meteor storm hits ships in open space and
 * leaves fragments with ore and crystals. Prices and contracts follow the events on their
 * own (market.ts, contracts.ts), even in systems nobody is in.
 */
export class GalaxyEffects {
  /** Event ids already announced here, and the raiders of each raid. */
  private seen = new Set<number>();
  private raiders = new Map<number, number[]>();
  private nextWave = new Map<number, number>();
  private nextFragment = new Map<number, number>();
  private rng: Rng;

  constructor(private sys: SystemInstance) {
    this.rng = new Rng(hashInts(sys.def.seed, 0x6e7e));
  }

  /** Called once a second. */
  step(events: readonly GalaxyEvent[]) {
    const mine = events.filter((e) => e.system === this.sys.def.id);
    const live = new Set(mine.map((e) => e.id));
    for (const e of mine) {
      if (!this.seen.has(e.id)) this.begin(e);
      if (e.kind === 'raid') this.raid(e);
      if (e.kind === 'storm') this.storm();
    }
    for (const id of [...this.seen]) if (!live.has(id)) this.end(id);
  }

  private begin(e: GalaxyEvent) {
    this.seen.add(e.id);
    const sub = e.kind === 'raid' ? 'Налётчики атакуют корабли у станции, Федерация платит за каждого'
      : e.kind === 'storm' ? 'Обломки бьют по кораблям в открытом космосе, осколки с рудой можно собрать'
      : 'Станция дорого скупает этот товар, на доске контрактов срочный заказ';
    this.sys.events.push({ t: 'announce', text: eventTitle(e), sub, kind: e.kind === 'shortage' ? 'info' : 'warn' });
  }

  private end(id: number) {
    this.seen.delete(id);
    this.nextWave.delete(id);
    const ids = this.raiders.get(id);
    if (!ids) return;
    this.raiders.delete(id);
    // raiders that are not in a fight jump out
    let left = 0;
    for (const rid of ids) {
      const r = this.sys.ships.get(rid);
      if (!r || r.dead) continue;
      if (r.npc?.state === 'attack') { left++; continue; }
      this.sys.despawn(r);
    }
    this.sys.events.push({ t: 'announce', text: 'Набег окончен', sub: left ? 'Последние налётчики ещё дерутся' : 'Пираты ушли от станции', kind: 'good' });
  }

  // ------------------------------------------------------------------ raid
  private raid(e: GalaxyEvent) {
    const t = this.sys.time;
    if (t < (this.nextWave.get(e.id) ?? 0)) return;
    this.nextWave.set(e.id, t + WAVE_EVERY);
    const ids = (this.raiders.get(e.id) ?? []).filter((id) => { const r = this.sys.ships.get(id); return !!r && !r.dead; });
    const want = RAIDERS[getGalaxy().stars[this.sys.def.id].security];
    const st = this.sys.def.station.pos, r = this.rng;
    const wave = want - ids.length;
    for (let i = 0; i < wave; i++) {
      const a = r.range(0, Math.PI * 2);
      const dir = vnorm(v3(), v3(Math.cos(a), r.range(-0.25, 0.25), Math.sin(a)));
      const ring = (d: number): V3 => v3(st.x + dir.x * d, st.y + dir.y * d, st.z + dir.z * d);
      const p = ring(SAFE_ZONE_RADIUS + r.range(1800, 3200));
      const pirate = this.sys.spawnPirate(p, `Налётчик ${makeName(r)}`);
      pirate.transient = true;
      pirate.bounty = RAIDER_BOUNTY;
      pirate.state.q = qlook(quat(), vnorm(v3(), vsub(v3(), st, p)), v3(0, 1, 0));
      pirate.npc!.home = ring(SAFE_ZONE_RADIUS + 1500);
      pirate.npc!.homeRadius = 1600;
      pirate.npc!.waypoint = pirate.npc!.pickWaypoint();
      this.sys.syncWorld(pirate);
      ids.push(pirate.id);
    }
    this.raiders.set(e.id, ids);
    if (wave > 0 && ids.length > wave) this.sys.events.push({ t: 'announce', text: 'Новая волна налётчиков', sub: 'Пираты подтягивают подкрепление к станции', kind: 'warn' });
  }

  // ------------------------------------------------------------------ storm
  private storm() {
    const t = this.sys.time, r = this.rng;
    for (const s of this.sys.sessions) {
      if (s.mode !== MODE.SHIP) continue;
      const ship = s.ship;
      if (ship.dead || ship.state.landed || this.sys.inSafeZone(ship.world.p)) continue;
      if (r.chance(1 / METEOR_EVERY)) {
        const dmg = r.range(METEOR_DAMAGE[0], METEOR_DAMAGE[1]);
        this.sys.damage(ship, dmg, 0);
        s.msg('Удар метеорита!', 'warn');
      }
      if (t >= (this.nextFragment.get(s.id) ?? 0)) {
        this.nextFragment.set(s.id, t + FRAGMENT_EVERY * r.range(0.7, 1.3));
        const p = ship.world.p;
        const dir = vnorm(v3(), v3(r.range(-1, 1), r.range(-0.4, 0.4), r.range(-1, 1)));
        const d = r.range(250, 700);
        const contents: LootContents = { credits: 0, cargo: r.chance(0.7) ? { ore: r.int(1, 3) } : { crystal: r.int(1, 2) } };
        this.sys.world.dropFragment(v3(p.x + dir.x * d, p.y + dir.y * d, p.z + dir.z * d), contents);
      }
    }
  }

  /** Dev: how many raiders of current raids are alive. */
  raidersAlive(): number {
    let n = 0;
    for (const ids of this.raiders.values()) for (const id of ids) if (this.sys.ships.get(id) && !this.sys.ships.get(id)!.dead) n++;
    return n;
  }
}
