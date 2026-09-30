import * as THREE from 'three';
import { DOCK_RANGE, DT, EXIT_RANGE, GATE_RANGE, HARVEST_RANGE, INTERP_DELAY, SAFE_ZONE_RADIUS } from '../shared/constants.ts';
import { defaultUpgrades, flightStats } from '../shared/economy.ts';
import { getSystem, type PlanetDef, type SystemDef } from '../shared/galaxy/system-gen.ts';
import { FWD, qlook, qrot, quat, v3, vdist, vlen, vnorm, vsub, type Quat, type V3 } from '../shared/math/vec.ts';
import {
  EFLAG, KIND, MODE, type EntityInfo, type EntityState, type GameEvent, type PilotInfo, type SelfState, type Shot, type Snapshot, type Welcome,
} from '../shared/net/protocol.ts';
import { surfaceHeight } from '../shared/planet/terrain.ts';
import { charUp } from '../shared/sim/character.ts';
import type { SimEnv } from '../shared/sim/env.ts';
import { CRUISE_SPOOL, cruiseInhibited, isCruising } from '../shared/sim/ship.ts';
import { ENERGY_REGEN, GUN_OFFSETS, LASER, leadPoint, MISSILE } from '../shared/sim/weapons.ts';
import { playerBlueprint } from '../shared/ships/blueprint.ts';
import { Sfx } from './audio/sfx.ts';
import { Input } from './core/input.ts';
import { Renderer } from './core/renderer.ts';
import { AstronautView, MissileView, ShipView } from './entities/views.ts';
import { Connection } from './net/connection.ts';
import { InterpBuffer, Timeline } from './net/interp.ts';
import { AtmosphereView, SkyDome } from './planet/atmosphere.ts';
import { PlanetView } from './planet/planet-view.ts';
import { SurfaceProps } from './planet/props.ts';
import { WorkerPool } from './planet/worker-pool.ts';
import { CameraRig } from './player/camera-rig.ts';
import { Controller } from './player/controller.ts';
import { Predictor } from './player/prediction.ts';
import { Hud, type LabelData } from './ui/hud.ts';
import { Radar, type Blip } from './ui/radar.ts';
import { Effects } from './world/effects.ts';
import { SpaceBackdrop, Sun } from './world/space.ts';
import { FieldView, GateView, StationView } from './world/structures.ts';

interface Remote {
  info: EntityInfo | null;
  buf: InterpBuffer;
  view: ShipView | AstronautView | MissileView | null;
  p: V3;
  q: Quat;
  state: EntityState | null;
  visible: boolean;
  smokeT: number;
}

interface NavItem { name: string; pos: V3; kind: 'planet' | 'station' | 'gate'; radius: number }

const RESOURCE_NAMES = { ore: 'руда', crystal: 'кристалл', relic: 'реликт' } as const;
const tv = new THREE.Vector3();

/** Owns the client session: world rendering, prediction, networking glue and HUD. */
export class Game {
  private r: Renderer;
  private input: Input;
  private hud = new Hud();
  private radar = new Radar(document.getElementById('radar') as HTMLCanvasElement);
  private sfx = new Sfx();
  private conn: Connection;
  private timeline = new Timeline();
  private pool = new WorkerPool();
  private ctrl: Controller;
  private rig = new CameraRig();
  private pred: Predictor;

  private sys: SystemDef | null = null;
  private env: SimEnv | null = null;
  private world = new THREE.Group();
  private backdrop: SpaceBackdrop | null = null;
  private sun: Sun | null = null;
  private planets: PlanetView[] = [];
  private atmos: (AtmosphereView | null)[] = [];
  private station: StationView | null = null;
  private gates: GateView[] = [];
  private fields: FieldView[] = [];
  private props = new SurfaceProps();
  private effects = new Effects();
  private sky = new SkyDome();
  private sunLight: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  /** Soft "headlight" along the view direction so hulls stay readable when back-lit. */
  private fill = new THREE.DirectionalLight('#b8c8ff', 0.7);

  private infos = new Map<number, EntityInfo>();
  private remotes = new Map<number, Remote>();
  private myShip: ShipView | null = null;
  private myAstro: AstronautView | null = null;
  private welcome: Welcome | null = null;
  private pilot: PilotInfo | null = null;
  private self: SelfState | null = null;
  private lastMode = -1;
  private harvested = new Map<string, number>();
  private harvestVersion = 0;
  private targetId = 0;
  private lockT = 0;
  private locked = false;
  private navIndex = 0;
  private navItems: NavItem[] = [];
  private fireCd = 0;
  private energy = 100;
  private gun = 0;
  private acc = 0;
  private last = performance.now();
  private time = 0;
  private origin = v3();
  private shipPos = v3();
  private shipQ = quat();
  private charPos = v3();
  private charFwd = v3(0, 0, -1);
  private stats = flightStats(defaultUpgrades());
  private nearPlanet: PlanetDef | null = null;
  private nearAlt = 1e9;

  constructor(canvas: HTMLCanvasElement, name: string, token: string | undefined, private onFatal: (msg: string) => void) {
    this.r = new Renderer(canvas);
    this.input = new Input(canvas);
    this.ctrl = new Controller(this.input);
    this.pred = new Predictor(() => this.env!, () => this.stats);
    this.r.scene.add(this.world, this.sky.mesh);
    this.world.add(this.props.group, this.effects.group);
    this.sunLight = new THREE.DirectionalLight('#ffffff', 2.6);
    this.sunLight.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sunLight.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 2000 });
    this.sunLight.shadow.bias = -0.0005;
    this.sunLight.shadow.normalBias = 0.05;
    this.hemi = new THREE.HemisphereLight('#6a7a9a', '#2a2630', 1.6);
    this.r.scene.add(this.sunLight, this.sunLight.target, this.hemi, this.fill, this.fill.target);
    this.r.scene.fog = new THREE.Fog('#000000', 1e8, 2e8);

    this.hud.onChat = (t) => this.conn.chat(t);
    this.hud.onAction = (a) => { this.conn.action(a); this.sfx.beep(); };
    this.hud.onTyping = (t) => { this.input.typing = t; };

    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    this.conn = new Connection(url, name, token, {
      welcome: (w) => this.onWelcome(w),
      snapshot: (s) => this.onSnapshot(s),
      info: (l) => this.onInfo(l),
      gone: (ids) => ids.forEach((id) => this.removeRemote(id)),
      shots: (s) => this.onShots(s),
      events: (e) => this.onEvents(e),
      pilot: (p) => this.setPilot(p),
      error: (m) => this.onFatal(m),
      closed: () => this.onFatal('Соединение с сервером потеряно'),
    });
    requestAnimationFrame(() => this.frame());
    (window as unknown as { __game: Game }).__game = this;
  }

  // ------------------------------------------------------------------ network
  private onWelcome(w: Welcome) {
    const first = !this.welcome;
    this.welcome = w;
    localStorage.setItem('nova.pilot', JSON.stringify({ name: w.pilot.name, token: w.token }));
    if (!this.sys || this.sys.id !== w.system) this.buildSystem(w.system);
    for (const id of [...this.remotes.keys()]) this.removeRemote(id);
    this.infos.clear();
    this.harvested.clear();
    for (const h of w.harvested) this.harvested.set(`${h.planet}:${h.node}`, w.time + h.left);
    this.harvestVersion++;
    this.pred.ready = false;
    this.targetId = 0;
    this.navIndex = 0;
    if (!this.myShip) {
      this.myShip = new ShipView(playerBlueprint(w.pilot.name));
      this.world.add(this.myShip.group);
    }
    this.setPilot(w.pilot);
    document.getElementById('loading')!.classList.add('hidden');
    this.hud.show();
    if (first) {
      this.hud.toast(w.motd);
      this.hud.chat(null, w.motd);
    } else this.hud.toast(`Прыжок завершён: система ${this.sys!.name}`, 'good');
  }

  private buildSystem(id: number) {
    for (const p of this.planets) p.group.removeFromParent();
    for (const a of this.atmos) a?.group.removeFromParent();
    this.station?.group.removeFromParent();
    this.gates.forEach((g) => g.group.removeFromParent());
    this.fields.forEach((f) => f.group.removeFromParent());
    this.sun?.group.removeFromParent();
    this.backdrop?.dispose();
    this.props.clear();

    const sys = getSystem(id);
    this.sys = sys;
    this.env = { star: sys.star, planets: sys.planets, fields: sys.fields, station: sys.station };
    this.backdrop = new SpaceBackdrop(this.r.gl, sys.seed, this.r.low ? 512 : 1024);
    this.r.scene.background = this.backdrop.texture;
    this.sun = new Sun(sys.star);
    this.sunLight.color.copy(this.sun.color);
    this.world.add(this.sun.group);
    this.planets = sys.planets.map((p) => new PlanetView(p, this.pool));
    this.atmos = sys.planets.map((p) => (p.atmo ? new AtmosphereView(p.radius, p.atmo) : null));
    this.planets.forEach((p) => this.world.add(p.group));
    this.atmos.forEach((a) => a && this.world.add(a.group));
    const facing = new THREE.Vector3(sys.spawn.x - sys.station.pos.x, sys.spawn.y - sys.station.pos.y, sys.spawn.z - sys.station.pos.z);
    this.station = new StationView(sys.station, facing);
    this.world.add(this.station.group);
    this.gates = sys.gates.map((g) => new GateView(g, new THREE.Vector3(sys.station.pos.x - g.pos.x, sys.station.pos.y - g.pos.y, sys.station.pos.z - g.pos.z)));
    this.gates.forEach((g) => this.world.add(g.group));
    this.fields = sys.fields.map((f) => new FieldView(f));
    this.fields.forEach((f) => this.world.add(f.group));
    this.navItems = [
      { name: sys.station.name, pos: sys.station.pos, kind: 'station', radius: 200 },
      ...sys.planets.map((p) => ({ name: p.name, pos: p.center, kind: 'planet' as const, radius: p.radius })),
      ...sys.gates.map((g) => ({ name: g.name, pos: g.pos, kind: 'gate' as const, radius: 150 })),
    ];
  }

  private setPilot(p: PilotInfo) {
    this.pilot = p;
    this.stats = flightStats(p.upgrades);
    this.hud.setPilot(p, this.sys?.name ?? '');
    if (this.self && this.lastMode === MODE.DOCKED) this.hud.renderStation(p, { hull: this.self.hull, max: this.self.maxHull });
  }

  private onSnapshot(s: Snapshot) {
    if (!this.sys) return;
    this.timeline.onSnapshot(s.time);
    this.self = s.self;
    this.pred.onSnapshot(s);
    this.energy = Math.min(this.energy, s.self.energy + 8);
    if (Math.abs(this.energy - s.self.energy) > 15) this.energy = s.self.energy;
    if (s.self.mode !== this.lastMode) this.onModeChange(this.lastMode, s.self.mode);
    for (const e of s.entities) {
      let r = this.remotes.get(e.id);
      if (!r) r = this.addRemote(e.id);
      r.buf.push(s.time, e);
    }
  }

  private onModeChange(prev: number, mode: number) {
    this.lastMode = mode;
    this.hud.showStation(mode === MODE.DOCKED, this.sys?.station.name);
    this.hud.setDead(mode === MODE.DEAD);
    this.hud.setFlightVisible(mode === MODE.SHIP);
    if (mode === MODE.DOCKED) {
      this.input.releaseLock();
      if (this.pilot && this.self) this.hud.renderStation(this.pilot, { hull: this.self.hull, max: this.self.maxHull });
    }
    if (mode === MODE.DEAD || prev === MODE.DOCKED) { this.ctrl.throttle = 0; this.ctrl.cruiseOn = false; }
    if (mode === MODE.FOOT) {
      this.ctrl.footPitch = -0.12;
      if (!this.myAstro) { this.myAstro = new AstronautView(); this.world.add(this.myAstro.group); }
    }
    if (mode !== MODE.FOOT && this.myAstro) { this.myAstro.dispose(); this.myAstro = null; }
    if (mode === MODE.SHIP && prev === MODE.FOOT) this.ctrl.throttle = 0;
  }

  private addRemote(id: number): Remote {
    const r: Remote = { info: this.infos.get(id) ?? null, buf: new InterpBuffer(), view: null, p: v3(), q: quat(), state: null, visible: false, smokeT: 0 };
    this.remotes.set(id, r);
    return r;
  }

  private onInfo(list: EntityInfo[]) {
    for (const i of list) {
      this.infos.set(i.id, i);
      const r = this.remotes.get(i.id);
      if (r) r.info = i;
    }
  }

  private removeRemote(id: number) {
    const r = this.remotes.get(id);
    if (r?.view) r.view.dispose();
    this.remotes.delete(id);
    this.infos.delete(id);
    if (this.targetId === id) this.targetId = 0;
  }

  private ensureView(r: Remote) {
    if (r.view || !r.info) return;
    if (r.info.kind === KIND.SHIP && r.info.bp) r.view = new ShipView(r.info.bp);
    else if (r.info.kind === KIND.CHAR) r.view = new AstronautView();
    else if (r.info.kind === KIND.MISSILE) r.view = new MissileView();
    if (r.view) this.world.add(r.view.group);
  }

  private shotColor(shooter: number, level: number) {
    const info = this.infos.get(shooter);
    if (info?.npc) return new THREE.Color(2.4, 0.5, 0.3);
    return [new THREE.Color(0.5, 2.2, 2.6), new THREE.Color(0.5, 2.2, 2.6), new THREE.Color(0.6, 2.6, 1.2), new THREE.Color(2.2, 1.6, 0.4), new THREE.Color(2.4, 0.8, 2.4)][level] ?? new THREE.Color(0.5, 2.2, 2.6);
  }

  private onShots(shots: Shot[]) {
    for (const s of shots) {
      const p = v3(s.px, s.py, s.pz);
      this.effects.bolt(p, v3(s.vx, s.vy, s.vz), this.shotColor(s.shooter, s.level), s.shooter, INTERP_DELAY);
      const d = vdist(p, this.origin);
      if (d < 3000) setTimeout(() => this.sfx.laser(Math.max(0.1, 1 - d / 3000) * 0.7), INTERP_DELAY * 1000);
    }
  }

  private onEvents(list: GameEvent[]) {
    const myShip = this.self?.shipId;
    for (const e of list) {
      switch (e.t) {
        case 'hit': {
          const pos = v3(e.pos[0], e.pos[1], e.pos[2]);
          this.effects.consumeBolt(e.by, pos);
          this.effects.spark(pos, e.shield ? new THREE.Color(0.4, 0.9, 1.4) : new THREE.Color(1.4, 0.7, 0.25));
          if (e.target === myShip) { this.myShip?.hit(e.shield); this.sfx.hit(e.shield); }
          else {
            const v = this.remotes.get(e.target)?.view;
            if (v instanceof ShipView) v.hit(e.shield);
            if (e.by === myShip) this.sfx.hit(e.shield);
          }
          break;
        }
        case 'boom': {
          const pos = v3(e.pos[0], e.pos[1], e.pos[2]);
          this.effects.explosion(pos, e.big);
          const d = vdist(pos, this.origin);
          if (d < 6000) this.sfx.explosion(e.big, Math.max(0.15, 1 - d / 6000));
          break;
        }
        case 'kill': this.hud.feed(`${e.killer} ✕ ${e.victim}`); break;
        case 'chat': this.hud.chat(e.from, e.text); break;
        case 'msg': this.hud.toast(e.text, e.kind); this.hud.chat(null, e.text); break;
        case 'harvest':
          this.harvested.set(`${e.planet}:${e.node}`, this.timeline.serverNow + e.left);
          this.harvestVersion++;
          if (e.by === this.welcome?.playerId) { this.sfx.pickup(); this.hud.toast('Ресурс собран', 'good'); }
          break;
        case 'missile':
          if (e.target === myShip) { this.hud.toast('Внимание: ракета!', 'warn'); this.sfx.beep(true); }
          else this.sfx.missile();
          break;
      }
    }
  }

  // ------------------------------------------------------------------ loop
  private frame() {
    requestAnimationFrame(() => this.frame());
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    if (!this.sys || !this.self) { this.input.endFrame(); return; }
    const mode = this.pred.mode;
    this.handleKeys(dt, mode);
    this.ctrl.frame(dt, mode);
    this.acc += dt;
    let n = 0;
    while (this.acc >= DT && n < 5) { this.fixedTick(); this.acc -= DT; n++; }
    if (n === 5) this.acc = 0;
    this.pred.decay(dt);
    this.render(dt, this.acc / DT);
    this.input.endFrame();
  }

  private fixedTick() {
    if (!this.pred.ready || !this.conn.open) return;
    const mode = this.pred.mode;
    if (mode !== MODE.SHIP && mode !== MODE.FOOT) return;
    const m = this.ctrl.build(mode);
    this.conn.input(m);
    this.pred.step(m);
    this.energy = Math.min(100, this.energy + ENERGY_REGEN * DT);
    if (mode !== MODE.SHIP) return;
    this.fireCd -= DT;
    const s = this.pred.ship;
    if (m.flags & 1 && this.fireCd <= 0 && this.energy >= LASER.cost && !s.landed && !isCruising(s) && vdist(s.p, this.sys!.station.pos) > SAFE_ZONE_RADIUS) {
      this.fireCd = LASER.cooldown;
      this.energy -= LASER.cost;
      const g = GUN_OFFSETS.fighter[this.gun++ % 2];
      const off = qrot(v3(), s.q, g), f = qrot(v3(), s.q, FWD);
      const p = v3(s.p.x + off.x, s.p.y + off.y, s.p.z + off.z);
      this.effects.bolt(p, v3(s.v.x + f.x * LASER.speed, s.v.y + f.y * LASER.speed, s.v.z + f.z * LASER.speed), this.shotColor(this.self!.shipId, this.pilot?.upgrades.weapons ?? 1), this.self!.shipId);
      this.sfx.laser(0.8);
    }
  }

  private handleKeys(dt: number, mode: number) {
    const i = this.input;
    if (i.hit('KeyH')) this.hud.toggleHelp();
    if (i.hit('Escape')) this.hud.toggleHelp(false);
    if (i.hit('Enter')) { this.hud.focusChat(); i.releaseLock(); }
    if (i.hit('KeyZ')) i.releaseLock();
    if (i.hit('Tab')) this.navIndex = (this.navIndex + 1) % Math.max(1, this.navItems.length);
    if (i.hit('KeyT')) this.pickTarget();
    if (i.hit('KeyG')) {
      if (mode === MODE.SHIP && this.pred.ship.landed) this.conn.action({ a: 'exit' });
      else if (mode === MODE.FOOT) this.conn.action({ a: 'board' });
    }
    if (i.hit('KeyF')) {
      if (mode === MODE.FOOT) {
        const n = this.nearestNode();
        if (n) this.conn.action({ a: 'harvest', node: n.id });
        else this.hud.toast('Рядом нет ресурсов', 'warn');
      } else if (mode === MODE.SHIP) {
        const p = this.pred.ship.p;
        if (vdist(p, this.sys!.station.pos) < DOCK_RANGE) this.conn.action({ a: 'dock' });
        else if (this.sys!.gates.some((g) => vdist(g.pos, p) < GATE_RANGE)) this.conn.action({ a: 'jump' });
      }
    }
    // Missile lock: hold RMB on a target inside the cone.
    const t = this.targetId ? this.remotes.get(this.targetId) : undefined;
    if (mode === MODE.SHIP && i.mouse(2) && t?.visible) {
      const s = this.pred.ship;
      const to = vsub(v3(), t.p, s.p);
      const d = vlen(to);
      const f = qrot(v3(), s.q, FWD);
      const inCone = d < MISSILE.range && (to.x * f.x + to.y * f.y + to.z * f.z) / d > MISSILE.coneCos;
      if (inCone) {
        const before = this.lockT;
        this.lockT += dt;
        if (!this.locked && this.lockT >= MISSILE.lockTime) { this.locked = true; this.sfx.beep(true); }
        else if (Math.floor(before * 6) !== Math.floor(this.lockT * 6) && !this.locked) this.sfx.beep();
      } else { this.lockT = 0; this.locked = false; }
    }
    if (i.released.has(2)) {
      if (this.locked && this.targetId && mode === MODE.SHIP) {
        if ((this.pilot?.missiles ?? 0) > 0) { this.conn.action({ a: 'missile', target: this.targetId }); this.sfx.missile(); }
        else this.hud.toast('Нет ракет — купите на станции', 'warn');
      }
      this.lockT = 0;
      this.locked = false;
    }
  }

  private pickTarget() {
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(this.rig.quat);
    let best = 0, bestScore = Infinity;
    for (const [id, r] of this.remotes) {
      if (!r.visible || r.info?.kind !== KIND.SHIP) continue;
      const to = new THREE.Vector3(r.p.x - this.origin.x, r.p.y - this.origin.y, r.p.z - this.origin.z);
      const d = to.length();
      if (d > 8000) continue;
      const ang = Math.acos(Math.min(1, to.dot(f) / d));
      const score = ang < 0.45 ? ang * 1000 + d * 0.01 : 1e6 + d;
      if (score < bestScore && id !== this.targetId) { bestScore = score; best = id; }
    }
    this.targetId = best;
    this.lockT = 0;
    this.locked = false;
    if (best) this.sfx.beep();
  }

  private nearestNode() {
    let best = null, bd = HARVEST_RANGE + 0.5;
    for (const n of this.props.visibleNodes) {
      const d = vdist(n.pos, this.charPos);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  // ------------------------------------------------------------------ render
  private place(obj: THREE.Object3D, p: V3) {
    obj.position.set(p.x - this.origin.x, p.y - this.origin.y, p.z - this.origin.z);
  }

  private render(dt: number, alpha: number) {
    const sys = this.sys!, self = this.self!, mode = this.pred.mode;
    this.pred.shipPose(alpha, this.shipPos, this.shipQ);
    const onFoot = mode === MODE.FOOT && this.pred.charPose(alpha, this.charPos, this.charFwd);
    const ship = this.pred.ship;
    const speed = vlen(ship.v);

    // nearest planet to the player
    const focus = onFoot ? this.charPos : this.shipPos;
    this.nearPlanet = null;
    this.nearAlt = 1e12;
    for (const p of sys.planets) {
      const alt = vdist(focus, p.center) - p.radius;
      if (alt < this.nearAlt) { this.nearAlt = alt; this.nearPlanet = p; }
    }

    // camera
    if (mode === MODE.SHIP) this.rig.ship(dt, this.shipPos, this.shipQ, speed, isCruising(ship), !!ship.landed);
    else if (onFoot) {
      const pl = sys.planets[this.pred.charPlanet];
      this.rig.foot(this.charPos, charUp(this.pred.char!, pl, v3()), this.charFwd, this.ctrl.footPitch);
    } else if (mode === MODE.DOCKED) this.rig.orbit(dt, sys.station.pos, 900);
    const np = this.nearPlanet;
    if (np && this.nearAlt < np.maxHeight * 3 + 400) {
      const d = vnorm(v3(), vsub(v3(), this.rig.pos, np.center));
      this.rig.clampAbove(np.center, np.radius + surfaceHeight(np, d.x, d.y, d.z), onFoot ? 0.6 : 1.5);
    }
    this.origin.x = this.rig.pos.x; this.origin.y = this.rig.pos.y; this.origin.z = this.rig.pos.z;
    const cam = this.r.camera;
    cam.position.set(0, 0, 0);
    cam.quaternion.copy(this.rig.quat);
    cam.updateMatrixWorld();

    // world
    this.place(this.sun!.group, sys.star.pos);
    const toSun = vnorm(v3(), vsub(v3(), sys.star.pos, this.origin));
    this.planets.forEach((pv, i) => {
      const p = pv.def;
      this.place(pv.group, p.center);
      pv.update(tv.set(this.origin.x - p.center.x, this.origin.y - p.center.y, this.origin.z - p.center.z));
      const a = this.atmos[i];
      if (a) {
        this.place(a.group, p.center);
        const sd = vnorm(v3(), vsub(v3(), sys.star.pos, p.center));
        a.uniforms.sun.value.set(sd.x, sd.y, sd.z);
        const alt = vdist(this.origin, p.center) - p.radius;
        a.uniforms.k.value = THREE.MathUtils.smoothstep(alt, p.radius * 0.08, p.radius * 0.4);
      }
    });
    this.place(this.station!.group, sys.station.pos);
    this.station!.update(dt);
    this.gates.forEach((g) => { this.place(g.group, g.def.pos); g.update(dt); });
    this.fields.forEach((f) => this.place(f.group, f.def.center));
    this.props.update(np && this.nearAlt < 2500 ? np : null, this.origin, this.harvestedSet(), this.harvestVersion);
    this.props.sync(this.origin);

    // own ship / astronaut
    const ms = this.myShip!;
    ms.group.visible = mode === MODE.SHIP || mode === MODE.FOOT;
    this.place(ms.group, this.shipPos);
    ms.group.quaternion.set(this.shipQ.x, this.shipQ.y, this.shipQ.z, this.shipQ.w);
    ms.throttle = Math.abs(this.ctrl.throttle);
    ms.boost = this.input.down('ShiftLeft');
    ms.cruise = isCruising(ship);
    ms.landed = !!ship.landed || mode === MODE.FOOT;
    ms.update(dt, this.time);
    if (this.myAstro && onFoot) {
      this.place(this.myAstro.group, this.charPos);
      const q = qlook(quat(), this.charFwd, charUp(this.pred.char!, sys.planets[this.pred.charPlanet], v3()));
      this.myAstro.group.quaternion.set(q.x, q.y, q.z, q.w);
      const c = this.pred.char!;
      this.myAstro.speed = Math.hypot(c.v.x, c.v.y, c.v.z);
      this.myAstro.flying = !c.ground && this.input.down('Space');
      this.myAstro.update(dt);
    }
    if (mode === MODE.SHIP) this.sfx.engineLevel(this.ctrl.throttle, this.input.down('ShiftLeft'), isCruising(ship));
    else this.sfx.silenceEngine();

    // remote entities
    const rt = this.timeline.renderTime;
    for (const r of this.remotes.values()) {
      this.ensureView(r);
      const st = r.buf.sample(rt, r.p, r.q);
      r.state = st;
      r.visible = !!st && r.buf.lastSeen > this.timeline.serverNow - 1.2;
      if (!r.view) continue;
      r.view.group.visible = r.visible;
      if (!r.visible || !st) continue;
      this.place(r.view.group, r.p);
      r.view.group.quaternion.set(r.q.x, r.q.y, r.q.z, r.q.w);
      if (r.view instanceof ShipView) {
        r.view.throttle = st.throttle;
        r.view.boost = !!(st.flags & EFLAG.BOOST);
        r.view.cruise = !!(st.flags & EFLAG.CRUISE);
        r.view.landed = !!(st.flags & EFLAG.LANDED);
        r.view.update(dt, this.time);
      } else if (r.view instanceof AstronautView) {
        r.view.speed = Math.hypot(st.vx, st.vy, st.vz);
        r.view.flying = !!(st.flags & EFLAG.BOOST);
        r.view.update(dt);
      } else {
        r.smokeT -= dt;
        if (r.smokeT <= 0) { r.smokeT = 0.03; this.effects.smoke(r.p); }
      }
    }
    this.effects.setViewport(window.innerHeight, cam.fov);
    this.effects.update(dt, this.origin);

    this.updateEnvironment(toSun);
    this.updateHud(self, mode, speed);
    this.r.render();
  }

  private harvestedSet(): Set<string> {
    const now = this.timeline.serverNow;
    const s = new Set<string>();
    for (const [k, until] of this.harvested) if (until > now) s.add(k);
    return s;
  }

  private updateEnvironment(toSun: V3) {
    this.sunLight.position.set(toSun.x * 1000, toSun.y * 1000, toSun.z * 1000);
    this.sunLight.target.position.set(0, 0, 0);
    const np = this.nearPlanet;
    let inside = 0, day = 1;
    const fog = this.r.scene.fog as THREE.Fog;
    if (np) {
      const up = vnorm(v3(), vsub(v3(), this.origin, np.center));
      day = THREE.MathUtils.smoothstep(up.x * toSun.x + up.y * toSun.y + up.z * toSun.z, -0.2, 0.25);
      if (np.atmo) {
        inside = 1 - THREE.MathUtils.smoothstep(this.nearAlt, np.radius * 0.05, np.radius * 0.35);
        const u = this.sky.u;
        u.zen.value.set(np.atmo.zenith);
        u.hor.value.set(np.atmo.horizon);
        u.up.value.set(up.x, up.y, up.z);
        u.sun.value.set(toSun.x, toSun.y, toSun.z);
        u.sunC.value.copy(this.sun!.color);
        u.alpha.value = inside;
        u.day.value = day;
        const hor = new THREE.Color(np.atmo.horizon).multiplyScalar(0.12 + 0.88 * day);
        fog.color.copy(hor);
        fog.near = THREE.MathUtils.lerp(1e8, 600, inside);
        fog.far = THREE.MathUtils.lerp(2e8, 14000, inside);
      }
      if (np.atmo && inside > 0) {
        this.hemi.color.set('#6a7a9a').lerp(new THREE.Color(np.atmo.zenith), inside).multiplyScalar(0.35 + 0.65 * Math.max(day, 1 - inside));
        this.hemi.groundColor.set('#2a2630');
        this.hemi.intensity = 1.6;
      } else {
        this.hemi.color.set('#6a7a9a');
        this.hemi.groundColor.set('#2a2630');
        this.hemi.intensity = 1.6;
      }
    }
    if (!np?.atmo || inside <= 0) {
      this.sky.u.alpha.value = 0;
      fog.near = 1e8;
      fog.far = 2e8;
    }
    this.r.scene.backgroundIntensity = 1 - inside * day * 0.97;
    this.sunLight.intensity = 2.6 * (np?.atmo ? 1 - inside * (1 - day) : 1);
    const back = new THREE.Vector3(0, 0.3, 1).applyQuaternion(this.rig.quat);
    this.fill.position.copy(back).multiplyScalar(100);
    this.fill.intensity = 0.7 * (1 - inside * 0.6);
    const shadows = this.nearAlt < 1500;
    this.sunLight.castShadow = shadows;
  }

  private project(p: V3): { x: number; y: number; behind: boolean } {
    tv.set(p.x - this.origin.x, p.y - this.origin.y, p.z - this.origin.z);
    const cam = this.r.camera;
    const vz = tv.clone().applyQuaternion(cam.quaternion.clone().invert()).z;
    tv.project(cam);
    return { x: (tv.x * 0.5 + 0.5) * window.innerWidth, y: (-tv.y * 0.5 + 0.5) * window.innerHeight, behind: vz > 0 };
  }

  private fmtDist(d: number) {
    return d >= 1000 ? `${(d / 1000).toFixed(d >= 10000 ? 0 : 1)} км` : `${Math.round(d)} м`;
  }

  private updateHud(self: SelfState, mode: number, speed: number) {
    const sys = this.sys!, W = window.innerWidth, H = window.innerHeight;
    const ship = this.pred.ship;
    const me = mode === MODE.FOOT ? this.charPos : this.shipPos;
    const invCam = this.r.camera.quaternion.clone().invert();

    if (mode === MODE.SHIP) {
      const f = qrot(v3(), this.shipQ, FWD);
      const aimP = this.project(v3(this.shipPos.x + f.x * 1500, this.shipPos.y + f.y * 1500, this.shipPos.z + f.z * 1500));
      this.hud.crosshair(aimP.x, aimP.y);
      const R = 0.28 * Math.min(W, H);
      this.hud.cursorAt(W / 2 + this.input.vx * R, H / 2 + this.input.vy * R);
      let modeText = '';
      const inh = this.env ? cruiseInhibited(ship.p, this.env) : false;
      if (ship.landed) modeText = 'ПОСАДКА';
      else if (isCruising(ship)) modeText = 'КРУИЗ';
      else if (this.ctrl.cruiseOn) modeText = ship.cruiseBlock > 0 ? 'КРУИЗ: помехи' : inh ? 'КРУИЗ: масса рядом' : `КРУИЗ: ${(CRUISE_SPOOL - ship.cruise).toFixed(1)} с`;
      else if (vdist(ship.p, sys.station.pos) < SAFE_ZONE_RADIUS) modeText = 'ЗОНА СТАНЦИИ';
      this.hud.flight({ speed, throttle: this.ctrl.throttle, boost: ship.boost, energy: this.energy / 100, shield: self.shield / self.maxShield, hull: self.hull / self.maxHull, mode: modeText });
    }

    // target
    const t = this.targetId ? this.remotes.get(this.targetId) : undefined;
    if (t && t.visible && t.state && mode === MODE.SHIP) {
      const sp = this.project(t.p);
      const d = vdist(t.p, this.origin);
      if (!sp.behind) {
        const r = t.view instanceof ShipView ? t.view.built.radius : 6;
        const size = (r / Math.max(1, d)) * (H / (2 * Math.tan((this.r.camera.fov * Math.PI) / 360))) * 2.4;
        this.hud.target({ x: sp.x, y: sp.y, size, name: t.info?.name ?? '?', info: `${this.fmtDist(vdist(t.p, ship.p))} · ${Math.round(Math.hypot(t.state.vx, t.state.vy, t.state.vz))} м/с`, shield: t.state.shield, hull: t.state.hull, lock: this.locked ? 2 : this.lockT > 0 ? 1 : 0 });
        const lp = leadPoint(ship.p, ship.v, t.p, v3(t.state.vx, t.state.vy, t.state.vz), LASER.speed, v3());
        const lps = this.project(lp);
        this.hud.leadAt(lps.behind ? null : lps);
      } else { this.hud.target(null); this.hud.leadAt(null); }
    } else { this.hud.target(null); this.hud.leadAt(null); }

    // nav
    const items = this.navItems.map((n) => ({ name: n.name, dist: this.fmtDist(Math.max(0, vdist(n.pos, me) - (n.kind === 'planet' ? n.radius : 0))) }));
    this.hud.navList(items, this.navIndex);
    const nav = this.navItems[this.navIndex];
    if (nav && mode !== MODE.DOCKED) {
      const sp = this.project(nav.pos);
      let x = sp.x, y = sp.y;
      const off = sp.behind || x < 30 || y < 30 || x > W - 30 || y > H - 30;
      if (off) {
        let dx = x - W / 2, dy = y - H / 2;
        if (sp.behind) { dx = -dx; dy = -dy; }
        const k = Math.min((W / 2 - 40) / Math.abs(dx || 1), (H / 2 - 40) / Math.abs(dy || 1));
        x = W / 2 + dx * k; y = H / 2 + dy * k;
      }
      this.hud.navMarker({ x, y, text: `${nav.name} · ${items[this.navIndex].dist}` });
    } else this.hud.navMarker(null);

    // labels + radar
    const labels: LabelData[] = [];
    const blips: Blip[] = [];
    const rel = (p: V3) => tv.set(p.x - me.x, p.y - me.y, p.z - me.z).applyQuaternion(invCam);
    for (const [id, r] of this.remotes) {
      if (!r.visible || !r.info) continue;
      const d = vdist(r.p, me);
      const c = rel(r.p);
      if (r.info.kind === KIND.MISSILE) { blips.push({ x: c.x, y: c.y, z: c.z, kind: 'missile' }); continue; }
      blips.push({ x: c.x, y: c.y, z: c.z, kind: r.info.npc ? 'npc' : 'player', sel: id === this.targetId });
      if (d < 4000 && mode !== MODE.DOCKED) {
        const sp = this.project(v3(r.p.x, r.p.y, r.p.z));
        if (!sp.behind) labels.push({ id, x: sp.x, y: sp.y - 18, text: r.info.name, sub: this.fmtDist(d), npc: !!r.info.npc, hull: r.state?.hull ?? 1 });
      }
    }
    const sc = rel(sys.station.pos);
    blips.push({ x: sc.x, y: sc.y, z: sc.z, kind: 'station' });
    for (const g of sys.gates) { const gc = rel(g.pos); blips.push({ x: gc.x, y: gc.y, z: gc.z, kind: 'gate' }); }
    if (mode === MODE.FOOT) for (const n of this.props.visibleNodes) { const nc = rel(n.pos); blips.push({ x: nc.x * 20, y: 0, z: nc.z * 20, kind: 'node' }); }
    this.hud.setLabels(labels);
    this.radar.draw(blips);

    // context prompt
    let prompt: string | null = null;
    if (mode === MODE.SHIP) {
      if (ship.landed) prompt = '<kbd>G</kbd> выйти из корабля · <kbd>W</kbd> взлёт';
      else if (vdist(ship.p, sys.station.pos) < DOCK_RANGE) prompt = '<kbd>F</kbd> стыковка со станцией';
      else if (sys.gates.some((g) => vdist(g.pos, ship.p) < GATE_RANGE)) prompt = '<kbd>F</kbd> прыжок через врата';
      else if (this.nearPlanet && this.nearAlt < 250 && speed < 80 && Math.abs(this.ctrl.throttle) >= 0.05) prompt = '<kbd>X</kbd> сброс тяги — корабль сам опустится и сядет';
    } else if (mode === MODE.FOOT) {
      const n = this.nearestNode();
      if (n) prompt = `<kbd>F</kbd> собрать: ${RESOURCE_NAMES[n.type]}`;
      else if (vdist(this.charPos, ship.p) < EXIT_RANGE + 6) prompt = '<kbd>G</kbd> сесть в корабль';
    }
    this.hud.prompt(prompt);
  }
}
