import { BASE_BOUNTY, TURRET_COMBAT, TURRET_FLIGHT } from '../../shared/economy.ts';
import { hashInts, Rng } from '../../shared/math/rng.ts';
import { qlook, quat, v3, vdist, vnorm, vsub } from '../../shared/math/vec.ts';
import { MODE } from '../../shared/net/protocol.ts';
import { planetSites, TURRET_HEIGHT, TURRET_RANGE, type SiteDef } from '../../shared/planet/sites.ts';
import { newPose, planetRot, toBodyQuat } from '../../shared/sim/frames.ts';
import { emptyInput, newShip } from '../../shared/sim/ship.ts';
import { LASER, leadPoint } from '../../shared/sim/weapons.ts';
import { turretBlueprint } from '../../shared/ships/blueprint.ts';
import type { ShipEntity } from './entities.ts';
import { NpcBrain } from './npc.ts';
import type { SystemInstance } from './system.ts';

interface Tower { site: SiteDef; slot: number; ship: ShipEntity | null; respawnAt: number; burst: number; cool: number }

const TURRET_RESPAWN = 600;
const BURST = 3;
const aim = v3(), up = v3(), dir = v3(), wq = quat(), rot = quat();

/**
 * Pirate outposts on planet surfaces: each base has three flak towers (static
 * NPC "ships" parked in the planet's body frame) that shoot at pilots flying
 * nearby. Towers come back after a while; silencing all towers of a base pays
 * a bounty to whoever destroyed the last one.
 */
export class Outposts {
  private towers: Tower[] = [];
  private rng: Rng;

  constructor(private sys: SystemInstance) {
    this.rng = new Rng(hashInts(sys.def.seed, 0x7a11));
    for (const pl of sys.def.planets) {
      for (const site of planetSites(pl)) {
        if (site.kind !== 'base') continue;
        site.turrets.forEach((_, slot) => {
          const t: Tower = { site, slot, ship: null, respawnAt: 0, burst: 0, cool: this.rng.range(0, 2) };
          this.spawn(t);
          this.towers.push(t);
        });
      }
    }
  }

  private spawn(t: Tower) {
    const pl = this.sys.def.planets[t.site.planet];
    const tp = t.site.turrets[t.slot];
    const r = pl.radius + tp.h + TURRET_HEIGHT + 1.6;
    const p = v3(tp.dir.x * r, tp.dir.y * r, tp.dir.z * r);
    const q = qlook(quat(), vnorm(v3(), t.site.east), tp.dir);
    const brain = new NpcBrain(v3(), 0, new Rng(this.rng.int(0, 1e9)));
    brain.role = 'turret';
    const ship: ShipEntity = {
      id: this.sys.nextId(), name: 'Турель', bp: turretBlueprint(this.rng.int(0, 1e9)),
      state: newShip(p, q), world: newPose(), flight: TURRET_FLIGHT, combat: TURRET_COMBAT,
      hull: TURRET_COMBAT.maxHull, shield: TURRET_COMBAT.maxShield, energy: 100, lastHit: -99, fireCooldown: 0, gun: 0,
      throttle: 0, boosting: false, dead: false, respawnAt: 0, docked: false, god: false, session: null,
      npc: brain, lastInput: emptyInput(), transient: true, bounty: 110,
    };
    ship.state.frame = ship.state.landed = pl.index + 1;
    t.ship = ship;
    this.sys.addNpc(ship);
  }

  /** Called when any NPC dies; handles towers. */
  onKill(target: ShipEntity, killer: ShipEntity | undefined) {
    const t = this.towers.find((x) => x.ship === target);
    if (!t) return;
    t.ship = null;
    t.respawnAt = this.sys.time + TURRET_RESPAWN;
    if (killer?.session) this.sys.contracts.onTurretKill(killer.session, t.site.planet, t.site.id);
    const standing = this.towers.some((o) => o.site === t.site && o.ship);
    if (standing) return;
    const s = killer?.session;
    const share = s ? this.sys.reward(s, target.world.p, BASE_BOUNTY, 'База подавлена') : 0;
    const who = s ? (s.group ? `группа ${s.pilot.name}` : s.pilot.name) : '';
    this.sys.events.push({ t: 'announce', text: 'Пиратская база подавлена', sub: `${t.site.name}${s ? ` — ${who} получает ${share === BASE_BOUNTY ? BASE_BOUNTY : `по ${share}`} кр` : ''}`, kind: 'good' });
  }

  /** Sites whose towers are all down (for HUD / tests). */
  silenced(site: SiteDef): boolean {
    return !this.towers.some((t) => t.site === site && t.ship);
  }

  step(dt: number) {
    const t = this.sys.time;
    for (const tw of this.towers) {
      if (!tw.ship) {
        if (t >= tw.respawnAt) this.spawn(tw);
        continue;
      }
      const ship = tw.ship;
      ship.fireCooldown -= dt;
      tw.cool -= dt;
      const target = this.pick(ship);
      if (!target) { tw.burst = 0; continue; }
      // aim with lead, plus a little scatter so fast flying beats the guns
      leadPoint(ship.world.p, ship.world.v, target.world.p, target.world.v, LASER.speed, aim);
      const sp = 7 + vdist(aim, ship.world.p) * 0.012;
      aim.x += this.rng.range(-sp, sp); aim.y += this.rng.range(-sp, sp); aim.z += this.rng.range(-sp, sp);
      const pl = this.sys.def.planets[ship.state.frame - 1];
      vnorm(up, vsub(up, ship.world.p, pl.center));
      qlook(wq, vnorm(dir, vsub(dir, aim, ship.world.p)), up);
      toBodyQuat(planetRot(pl, t, rot), wq, ship.state.q);
      this.sys.syncWorld(ship);
      if (tw.cool > 0) continue;
      if (ship.fireCooldown <= 0) {
        ship.fireCooldown = 0;
        this.sys.tryFire(ship);
        ship.fireCooldown = 0.16;
        if (++tw.burst >= BURST) { tw.burst = 0; tw.cool = this.rng.range(1.1, 1.6); }
      }
    }
  }

  /** Nearest player ship in range and above the tower's horizon. */
  private pick(tower: ShipEntity): ShipEntity | null {
    let best: ShipEntity | null = null, bd = TURRET_RANGE;
    const pl = this.sys.def.planets[tower.state.frame - 1];
    for (const s of this.sys.sessions) {
      const sh = s.ship;
      if (s.mode !== MODE.SHIP || sh.dead || sh.docked || sh.god || this.sys.truce(sh)) continue;
      const d = vdist(sh.world.p, tower.world.p);
      if (d >= bd) continue;
      vnorm(up, vsub(up, tower.world.p, pl.center));
      vsub(dir, sh.world.p, tower.world.p);
      if ((dir.x * up.x + dir.y * up.y + dir.z * up.z) / (d || 1) < -0.05) continue;
      bd = d;
      best = sh;
    }
    return best;
  }

  /** Standing towers of a site. */
  towersOf(site: SiteDef): ShipEntity[] {
    return this.towers.filter((t) => t.site === site && t.ship).map((t) => t.ship!);
  }
}
