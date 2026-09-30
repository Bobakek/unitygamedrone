import * as THREE from 'three';
import { DOCK_RANGE, DT, EXIT_RANGE, GATE_RANGE, HARVEST_RANGE, INTERP_DELAY, SAFE_ZONE_RADIUS } from '../shared/constants.ts';
import { defaultUpgrades, flightStats } from '../shared/economy.ts';
import { getSystem, type PlanetDef, type SystemDef } from '../shared/galaxy/system-gen.ts';
import { FWD, qlook, qrot, quat, v3, vcross, vdist, vlen, vnorm, vsub, type Quat, type V3 } from '../shared/math/vec.ts';
import {
  EFLAG, KIND, MODE, type EntityInfo, type EntityState, type GameEvent, type PilotInfo, type SelfState, type Shot, type Snapshot, type Welcome,
} from '../shared/net/protocol.ts';
import { surfaceHeight } from '../shared/planet/terrain.ts';
import { resourceNode } from '../shared/planet/resources.ts';
import type { SimEnv } from '../shared/sim/env.ts';
import { newPose, planetRot, toBodyDir, toBodyPoint, toWorldDir, toWorldPoint, toWorldQuat, toWorldVel, worldPose, type Pose } from '../shared/sim/frames.ts';
import { CRUISE_SPOOL, cruiseInhibited, isCruising } from '../shared/sim/ship.ts';
import { ENERGY_REGEN, GUN_OFFSETS, LASER, leadPoint, MISSILE } from '../shared/sim/weapons.ts';
import { playerBlueprint } from '../shared/ships/blueprint.ts';
import { Sfx } from './audio/sfx.ts';
import { Input } from './core/input.ts';
import { Renderer } from './core/renderer.ts';
import { QUALITY, saveSettings, type Settings } from './core/quality.ts';
import { MissileView, ShipView } from './entities/views.ts';
import { AstronautView } from './entities/astronaut.ts';
import { Connection, type NetClient, type NetHandlers } from './net/connection.ts';
import { LocalConnection } from './net/local.ts';
import { InterpBuffer, Timeline } from './net/interp.ts';
import { AtmosphereView, EnvLighting, SkyDome } from './planet/atmosphere.ts';
import { CloudLayer } from './planet/clouds.ts';
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
import { AnomalyView, LootView, WreckView, type PoiView } from './world/poi-views.ts';
import { SiteView } from './planet/sites-view.ts';
import { planetSites } from '../shared/planet/sites.ts';
import { POI_LABEL, SALVAGE_MAX_SPEED, SALVAGE_RANGE, type Poi } from '../shared/events.ts';

interface Remote {
  info: EntityInfo | null;
  buf: InterpBuffer;
  view: ShipView | AstronautView | MissileView | LootView | null;
  /** World pose at the current render time. */
  p: V3;
  q: Quat;
  v: V3;
  /** Raw interpolated pose in the entity's own frame (`state.frame`). */
  bp: V3;
  bq: Quat;
  state: EntityState | null;
  visible: boolean;
  smokeT: number;
  /** Body-frame position of the node this remote pilot is mining (for the beam). */
  harvestPos: V3 | null;
}

interface NavItem { name: string; pos: V3; kind: 'planet' | 'station' | 'gate' | 'event'; radius: number; ship?: number }

const RESOURCE_NAMES = { ore: 'руда', crystal: 'кристалл', relic: 'реликт' } as const;
const DUST: Record<string, string> = { terran: '#9a8a6a', ocean: '#b0a080', alien: '#c090d0', desert: '#d9a060', ice: '#e8f4ff', lava: '#5a4a4a', barren: '#9a948e' };
const tv = new THREE.Vector3();

/** Owns the client session: world rendering, prediction, networking glue and HUD. */
export class Game {
  private r: Renderer;
  private input: Input;
  private hud = new Hud();
  private radar = new Radar(document.getElementById('radar') as HTMLCanvasElement);
  private sfx = new Sfx();
  private conn: NetClient;
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
  private clouds: CloudLayer[] = [];
  private station: StationView | null = null;
  private gates: GateView[] = [];
  private fields: FieldView[] = [];
  private props = new SurfaceProps(this.pool);
  private effects = new Effects();
  private sky = new SkyDome();
  private sunLight: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  /** Soft "headlight" along the view direction so hulls stay readable when back-lit. */
  private fill = new THREE.DirectionalLight('#b8c8ff', 0.7);
  private envLight: EnvLighting;
  private qualityApplied = false;

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
  private baseNav: NavItem[] = [];
  /** Active world events (convoys, wrecks, anomalies) and their scene views. */
  private pois: Poi[] = [];
  private poiViews = new Map<number, PoiView>();
  private scan: { id: number; k: number } | null = null;
  /** Surface site buildings per planet (built when the player first comes close). */
  private siteViews: (SiteView[] | null)[] = [];
  private fireCd = 0;
  private energy = 100;
  private gun = 0;
  private acc = 0;
  private last = performance.now();
  private time = 0;
  private origin = v3();
  /** Render pose of the own ship / pilot in world space ... */
  private shipPos = v3();
  private shipQ = quat();
  private charPos = v3();
  private charFwd = v3(0, 0, -1);
  /** ... and in their own frame (ship frame / planet body frame). */
  private shipPosF = v3();
  private shipQF = quat();
  private charPosB = v3();
  private charFwdB = v3(0, 0, -1);
  /** World pose of the latest predicted ship state (for firing, docking, HUD). */
  private shipW: Pose = newPose();
  /** Planet body→world rotations at the current render time. */
  private rots: Quat[] = [];
  private rotsT = new THREE.Quaternion();
  private stats = flightStats(defaultUpgrades());
  private harvestPos: V3 | null = null;
  private prevFwd = v3(0, 0, -1);
  private nearPlanet: PlanetDef | null = null;
  private nearAlt = 1e9;

  constructor(canvas: HTMLCanvasElement, name: string, token: string | undefined, private onFatal: (msg: string) => void, offline: boolean, private settings: Settings) {
    this.r = new Renderer(canvas, QUALITY[settings.quality]);
    this.envLight = new EnvLighting(this.r.gl);
    this.input = new Input(canvas);
    this.ctrl = new Controller(this.input);
    this.pred = new Predictor(() => this.env!, () => this.stats);
    this.r.scene.add(this.world, this.sky.mesh);
    this.world.add(this.props.group, this.effects.group);
    this.sunLight = new THREE.DirectionalLight('#ffffff', 2.6);
    Object.assign(this.sunLight.shadow.camera, { near: 1, far: 2400 });
    this.sunLight.shadow.bias = -0.0005;
    this.sunLight.shadow.normalBias = 0.05;
    this.hemi = new THREE.HemisphereLight('#6a7a9a', '#2a2630', 1.6);
    this.r.scene.add(this.sunLight, this.sunLight.target, this.hemi, this.fill, this.fill.target);
    this.r.scene.fog = new THREE.Fog('#000000', 1e8, 2e8);

    this.hud.onChat = (t) => this.conn.chat(t);
    this.hud.onAction = (a) => { this.conn.action(a); this.sfx.beep(); };
    this.hud.onTyping = (t) => { this.input.typing = t; };

    const handlers: NetHandlers = {
      welcome: (w) => this.onWelcome(w),
      snapshot: (s) => this.onSnapshot(s),
      info: (l) => this.onInfo(l),
      gone: (ids) => ids.forEach((id) => this.removeRemote(id)),
      shots: (s) => this.onShots(s),
      events: (e) => this.onEvents(e),
      pilot: (p) => this.setPilot(p),
      world: (p) => this.onWorld(p),
      error: (m) => this.onFatal(m),
      closed: () => this.onFatal('Соединение с сервером потеряно'),
    };
    if (offline) this.conn = new LocalConnection(name, token, handlers);
    else this.conn = new Connection(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`, name, token, handlers);
    this.bindSettings();
    this.applySettings(settings);
    requestAnimationFrame(() => this.frame());
    (window as unknown as { __game: Game }).__game = this;
  }

  // ------------------------------------------------------------------ settings
  private bindSettings() {
    const $ = (id: string) => document.getElementById(id)!;
    $('set-quality').addEventListener('click', (e) => {
      const q = (e.target as HTMLElement).closest('button')?.dataset.q;
      if (q && q in QUALITY) this.applySettings({ ...this.settings, quality: q as Settings['quality'] });
    });
    ($('set-sens') as HTMLInputElement).addEventListener('input', (e) => this.applySettings({ ...this.settings, sensitivity: Number((e.target as HTMLInputElement).value) }));
    ($('set-vol') as HTMLInputElement).addEventListener('input', (e) => this.applySettings({ ...this.settings, volume: Number((e.target as HTMLInputElement).value) }));
    $('set-close').addEventListener('click', () => this.toggleSettings(false));
  }

  private toggleSettings(force?: boolean) {
    const el = document.getElementById('settings')!;
    const open = force ?? el.classList.contains('hidden');
    el.classList.toggle('hidden', !open);
    if (open) this.input.releaseLock();
  }

  private applySettings(s: Settings) {
    const prev = this.settings;
    this.settings = s;
    saveSettings(s);
    const q = QUALITY[s.quality];
    if (prev.quality !== s.quality || !this.qualityApplied) {
      this.qualityApplied = true;
      this.r.apply(q);
      for (const pv of this.planets) pv.splitK = q.splitK;
      if (this.sys && prev.quality !== s.quality) {
        for (const c of this.clouds) c.group.removeFromParent();
        this.clouds = this.sys.planets.map((p) => new CloudLayer(p, q.clouds));
        this.clouds.forEach((c) => this.world.add(c.group));
      }
    }
    this.input.sensitivity = s.sensitivity;
    this.sfx.setVolume(s.volume);
    document.querySelectorAll<HTMLButtonElement>('#set-quality button').forEach((b) => b.classList.toggle('on', b.dataset.q === s.quality));
    (document.getElementById('set-sens') as HTMLInputElement).value = String(s.sensitivity);
    (document.getElementById('set-vol') as HTMLInputElement).value = String(s.volume);
  }

  // ------------------------------------------------------------------ network
  private onWelcome(w: Welcome) {
    const first = !this.welcome;
    this.welcome = w;
    try {
      localStorage.setItem('nova.pilot', JSON.stringify({ name: w.pilot.name, token: w.token }));
    } catch { /* storage unavailable */ }
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
    for (const c of this.clouds) c.group.removeFromParent();
    this.station?.group.removeFromParent();
    this.gates.forEach((g) => g.group.removeFromParent());
    this.fields.forEach((f) => f.group.removeFromParent());
    this.sun?.group.removeFromParent();
    this.backdrop?.dispose();
    this.props.clear();

    const sys = getSystem(id);
    this.sys = sys;
    this.env = { star: sys.star, planets: sys.planets, fields: sys.fields, station: sys.station, time: 0 };
    this.rots = sys.planets.map(() => quat());
    this.backdrop = new SpaceBackdrop(this.r.gl, sys.seed, this.r.low ? 512 : 1024);
    this.r.scene.background = this.backdrop.texture;
    this.envLight.space(this.backdrop.texture);
    this.sun = new Sun(sys.star);
    this.sunLight.color.copy(this.sun.color);
    this.world.add(this.sun.group);
    this.planets = sys.planets.map((p) => new PlanetView(p, this.pool, this.r.q.splitK));
    this.siteViews = sys.planets.map(() => null);
    this.atmos = sys.planets.map((p) => (p.atmo ? new AtmosphereView(p.radius, p.atmo) : null));
    this.planets.forEach((p) => this.world.add(p.group));
    this.atmos.forEach((a) => a && this.world.add(a.group));
    this.clouds = sys.planets.map((p) => new CloudLayer(p, this.r.q.clouds));
    this.clouds.forEach((c) => this.world.add(c.group));
    const facing = new THREE.Vector3(sys.spawn.x - sys.station.pos.x, sys.spawn.y - sys.station.pos.y, sys.spawn.z - sys.station.pos.z);
    this.station = new StationView(sys.station, facing);
    this.world.add(this.station.group);
    this.gates = sys.gates.map((g) => new GateView(g, new THREE.Vector3(sys.station.pos.x - g.pos.x, sys.station.pos.y - g.pos.y, sys.station.pos.z - g.pos.z)));
    this.gates.forEach((g) => this.world.add(g.group));
    this.fields = sys.fields.map((f) => new FieldView(f));
    this.fields.forEach((f) => this.world.add(f.group));
    this.baseNav = [
      { name: sys.station.name, pos: sys.station.pos, kind: 'station', radius: 200 },
      ...sys.planets.map((p) => ({ name: p.name, pos: p.center, kind: 'planet' as const, radius: p.radius })),
      ...sys.gates.map((g) => ({ name: g.name, pos: g.pos, kind: 'gate' as const, radius: 150 })),
    ];
    for (const v of this.poiViews.values()) v.dispose();
    this.poiViews.clear();
    this.pois = [];
    this.scan = null;
    this.rebuildNav();
  }

  private rebuildNav() {
    const cur = this.navItems[this.navIndex]?.name;
    this.navItems = [
      ...this.baseNav,
      ...this.pois.map((p) => ({ name: p.kind === 'convoy' ? p.name : `${POI_LABEL[p.kind]}: ${p.name.replace(/^(Обломки|Аномалия) /, '')}`, pos: v3(p.pos[0], p.pos[1], p.pos[2]), kind: 'event' as const, radius: 0, ship: p.ship })),
    ];
    const i = this.navItems.findIndex((n) => n.name === cur);
    this.navIndex = i >= 0 ? i : Math.min(this.navIndex, this.navItems.length - 1);
  }

  private onWorld(list: Poi[]) {
    const ids = new Set(list.map((p) => p.id));
    for (const [id, v] of this.poiViews) if (!ids.has(id)) { v.dispose(); this.poiViews.delete(id); }
    for (const p of list) {
      if (this.poiViews.has(p.id)) continue;
      const v = p.kind === 'wreck' ? new WreckView(p) : p.kind === 'anomaly' ? new AnomalyView(p) : null;
      if (v) { this.poiViews.set(p.id, v); this.world.add(v.group); }
    }
    this.pois = list;
    if (this.scan && !ids.has(this.scan.id)) this.scan = null;
    this.rebuildNav();
  }

  /** Wreck close enough to salvage from the ship. */
  private nearWreck(): Poi | null {
    for (const p of this.pois) {
      if (p.kind === 'wreck' && (p.charges ?? 0) > 0 && vdist(this.shipW.p, v3(p.pos[0], p.pos[1], p.pos[2])) < SALVAGE_RANGE) return p;
    }
    return null;
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
      if (!this.myAstro) {
        this.myAstro = this.makeAstronaut(() => this.charPos);
        this.world.add(this.myAstro.group);
      }
    }
    if (mode !== MODE.FOOT && this.myAstro) { this.myAstro.dispose(); this.myAstro = null; }
    if (mode === MODE.SHIP && prev === MODE.FOOT) this.ctrl.throttle = 0;
  }

  private addRemote(id: number): Remote {
    const r: Remote = {
      info: this.infos.get(id) ?? null, buf: new InterpBuffer(), view: null, p: v3(), q: quat(), v: v3(), bp: v3(), bq: quat(),
      state: null, visible: false, smokeT: 0, harvestPos: null,
    };
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
    else if (r.info.kind === KIND.CHAR) r.view = this.makeAstronaut(() => r.p, 0.5);
    else if (r.info.kind === KIND.MISSILE) r.view = new MissileView();
    else if (r.info.kind === KIND.LOOT) r.view = new LootView();
    if (r.view) this.world.add(r.view.group);
  }

  private planetNear(p: V3): PlanetDef {
    let best = this.sys!.planets[0], bd = Infinity;
    for (const pl of this.sys!.planets) {
      const d = vdist(p, pl.center) - pl.radius;
      if (d < bd) { bd = d; best = pl; }
    }
    return best;
  }

  private makeAstronaut(pos: () => V3, vol = 1): AstronautView {
    const a = new AstronautView();
    const dust = (n: number, k: number) => {
      const p = pos();
      const pl = this.planetNear(p);
      const up = vnorm(v3(), vsub(v3(), p, pl.center));
      if (vdist(p, this.origin) < 60) this.effects.dust(p, up, new THREE.Color(DUST[pl.type] ?? '#9a948e'), n, k);
    };
    a.onStep = () => {
      if (vdist(pos(), this.origin) < 40) this.sfx.step(vol);
      dust(3, 0.7);
    };
    a.onLand = (k) => {
      if (vdist(pos(), this.origin) < 60) this.sfx.thud(k * vol);
      dust(14, 1 + k);
    };
    return a;
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
        case 'harvest': {
          this.harvested.set(`${e.planet}:${e.node}`, this.timeline.serverNow + e.left);
          this.harvestVersion++;
          const pl = this.sys?.planets[e.planet];
          const node = pl ? resourceNode(pl, e.node) : null;
          if (node && pl && e.by !== this.welcome?.playerId) {
            const pos = v3(node.dir.x * (pl.radius + node.h), node.dir.y * (pl.radius + node.h), node.dir.z * (pl.radius + node.h));
            for (const rm of this.remotes.values()) {
              if (rm.info?.kind === KIND.CHAR && rm.info.owner === e.by && rm.view instanceof AstronautView) {
                rm.harvestPos = pos;
                rm.view.harvest(this.rel(this.toWorld(pl.index + 1, pos, v3())));
              }
            }
          }
          if (e.by === this.welcome?.playerId) { this.sfx.pickup(); this.hud.toast('Ресурс собран', 'good'); }
          break;
        }
        case 'announce':
          this.hud.announce(e.text, e.sub ?? '', e.kind ?? 'info');
          this.hud.chat(null, e.sub ? `${e.text}: ${e.sub}` : e.text);
          this.sfx.beep(e.kind === 'warn');
          break;
        case 'scan':
          this.scan = e.k < 0 || e.k >= 1 ? null : { id: e.id, k: e.k };
          break;
        case 'loot': {
          this.hud.toast(e.text, 'good');
          this.hud.chat(null, e.text);
          this.sfx.pickup();
          this.effects.flash(v3(e.pos[0], e.pos[1], e.pos[2]), new THREE.Color(0.6, 2.2, 2.6), 26, 0.5);
          break;
        }
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
    this.pool.beginFrame();
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
    const m = this.ctrl.build(mode, this.timeline.serverNow);
    this.conn.input(m);
    this.pred.step(m);
    this.energy = Math.min(100, this.energy + ENERGY_REGEN * DT);
    if (mode !== MODE.SHIP) return;
    this.fireCd -= DT;
    const s = this.pred.ship;
    const w = worldPose(s, this.sys!.planets, m.t, this.shipW);
    if (m.flags & 1 && this.fireCd <= 0 && this.energy >= LASER.cost && !s.landed && !isCruising(s) && vdist(w.p, this.sys!.station.pos) > SAFE_ZONE_RADIUS) {
      this.fireCd = LASER.cooldown;
      this.energy -= LASER.cost;
      const g = GUN_OFFSETS.fighter[this.gun++ % 2];
      const off = qrot(v3(), w.q, g), f = qrot(v3(), w.q, FWD);
      const p = v3(w.p.x + off.x, w.p.y + off.y, w.p.z + off.z);
      this.effects.bolt(p, v3(w.v.x + f.x * LASER.speed, w.v.y + f.y * LASER.speed, w.v.z + f.z * LASER.speed), this.shotColor(this.self!.shipId, this.pilot?.upgrades.weapons ?? 1), this.self!.shipId);
      this.sfx.laser(0.8);
    }
  }

  private handleKeys(dt: number, mode: number) {
    const i = this.input;
    if (i.hit('KeyH')) this.hud.toggleHelp();
    if (i.hit('KeyO')) this.toggleSettings();
    if (i.hit('Escape')) { this.hud.toggleHelp(false); this.toggleSettings(false); }
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
        if (n) {
          this.conn.action({ a: 'harvest', node: n.id });
          this.harvestPos = n.pos;
          this.myAstro?.harvest(this.rel(this.toWorld(this.pred.charPlanet + 1, n.pos, v3())));
          this.sfx.mining();
        } else this.hud.toast('Рядом нет ресурсов', 'warn');
      } else if (mode === MODE.SHIP) {
        const p = this.shipW.p;
        const wreck = this.nearWreck();
        if (wreck) this.conn.action({ a: 'salvage', id: wreck.id });
        else if (vdist(p, this.sys!.station.pos) < DOCK_RANGE) this.conn.action({ a: 'dock' });
        else if (this.sys!.gates.some((g) => vdist(g.pos, p) < GATE_RANGE)) this.conn.action({ a: 'jump' });
      }
    }
    // Missile lock: hold RMB on a target inside the cone.
    const t = this.targetId ? this.remotes.get(this.targetId) : undefined;
    if (mode === MODE.SHIP && i.mouse(2) && t?.visible) {
      const s = this.shipW;
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
      const d = vdist(n.pos, this.charPosB);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  // ------------------------------------------------------------------ render
  private place(obj: THREE.Object3D, p: V3) {
    obj.position.set(p.x - this.origin.x, p.y - this.origin.y, p.z - this.origin.z);
  }

  /** Render-space vector (relative to the floating origin) of a world point. */
  private rel(p: V3): THREE.Vector3 {
    return new THREE.Vector3(p.x - this.origin.x, p.y - this.origin.y, p.z - this.origin.z);
  }

  /** Converts a point from `frame` (0 = world, planet + 1 = body) to world at the render time. */
  private toWorld(frame: number, p: V3, out: V3): V3 {
    if (!frame) { out.x = p.x; out.y = p.y; out.z = p.z; return out; }
    return toWorldPoint(this.sys!.planets[frame - 1], this.rots[frame - 1], p, out);
  }

  private render(dt: number, alpha: number) {
    const sys = this.sys!, self = this.self!, mode = this.pred.mode;
    // Planets spin: everything in a body frame is converted with the same rotation the planet is drawn with.
    const now = this.timeline.serverNow;
    sys.planets.forEach((p, i) => planetRot(p, now, this.rots[i]));
    const ship = this.pred.ship;
    this.pred.shipPose(alpha, this.shipPosF, this.shipQF);
    this.toWorld(ship.frame, this.shipPosF, this.shipPos);
    if (ship.frame) toWorldQuat(this.rots[ship.frame - 1], this.shipQF, this.shipQ);
    else Object.assign(this.shipQ, this.shipQF);
    worldPose(ship, sys.planets, now, this.shipW);
    const onFoot = mode === MODE.FOOT && this.pred.charPose(alpha, this.charPosB, this.charFwdB);
    const charPl = onFoot ? sys.planets[this.pred.charPlanet] : null;
    if (charPl) {
      const R = this.rots[charPl.index];
      toWorldPoint(charPl, R, this.charPosB, this.charPos);
      toWorldDir(R, this.charFwdB, this.charFwd);
    }
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
    else if (onFoot && charPl) {
      const up = vnorm(v3(), vsub(v3(), this.charPos, charPl.center));
      this.rig.foot(this.charPos, up, this.charFwd, this.ctrl.footPitch);
    } else if (mode === MODE.DOCKED) this.rig.orbit(dt, sys.station.pos, 900);
    const np = this.nearPlanet;
    if (np && this.nearAlt < np.maxHeight * 3 + 400) {
      const d = toBodyDir(this.rots[np.index], vnorm(v3(), vsub(v3(), this.rig.pos, np.center)), v3());
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
    // props first: they only need a couple of worker jobs and must not starve behind terrain chunks
    const propsPlanet = np && this.nearAlt < 2500 ? np : null;
    const camB = propsPlanet ? toBodyPoint(propsPlanet, this.rots[propsPlanet.index], this.origin, v3()) : this.origin;
    this.props.update(propsPlanet, camB, this.harvestedSet(), this.harvestVersion, this.time, { props: true, small: this.r.q.smallProps });
    this.planets.forEach((pv, i) => {
      const p = pv.def;
      const R = this.rots[i];
      this.rotsT.set(R.x, R.y, R.z, R.w);
      this.place(pv.group, p.center);
      pv.group.quaternion.copy(this.rotsT);
      const cb = toBodyPoint(p, R, this.origin, v3());
      pv.update(tv.set(cb.x, cb.y, cb.z), this.time);
      const a = this.atmos[i];
      const sd = vnorm(v3(), vsub(v3(), sys.star.pos, p.center));
      if (a) {
        this.place(a.group, p.center);
        a.uniforms.sun.value.set(sd.x, sd.y, sd.z);
        const alt = vdist(this.origin, p.center) - p.radius;
        a.uniforms.k.value = THREE.MathUtils.smoothstep(alt, p.radius * 0.08, p.radius * 0.4);
      }
      const cl = this.clouds[i];
      this.place(cl.group, p.center);
      cl.update(dt, 1, this.rotsT, sd);
      // ruins and outposts ride the planet group; built lazily on approach
      const near = vdist(this.origin, p.center) < p.radius * 3;
      if (near && !this.siteViews[i]) this.siteViews[i] = planetSites(p).map((s) => { const v = new SiteView(p, s); pv.group.add(v.group); return v; });
      if (near) for (const v of this.siteViews[i]!) v.update(this.time);
    });
    this.place(this.station!.group, sys.station.pos);
    this.station!.update(dt);
    this.gates.forEach((g) => { this.place(g.group, g.def.pos); g.update(dt); });
    this.fields.forEach((f) => this.place(f.group, f.def.center));
    if (propsPlanet) this.props.sync(this.origin, this.rots[propsPlanet.index]);

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
    if (this.myAstro && onFoot && charPl) {
      const up = vnorm(v3(), vsub(v3(), this.charPos, charPl.center));
      this.place(this.myAstro.group, this.charPos);
      const q = qlook(quat(), this.charFwd, up);
      this.myAstro.group.quaternion.set(q.x, q.y, q.z, q.w);
      // animation inputs in the body frame (independent of the planet's spin)
      const c = this.pred.char!;
      const upB = vnorm(v3(), this.charPosB);
      const vUp = c.v.x * upB.x + c.v.y * upB.y + c.v.z * upB.z;
      const hs = Math.hypot(c.v.x - upB.x * vUp, c.v.y - upB.y * vUp, c.v.z - upB.z * vUp);
      const cr = vcross(v3(), this.prevFwd, this.charFwdB);
      const turn = dt > 0 ? -Math.asin(Math.max(-1, Math.min(1, cr.x * upB.x + cr.y * upB.y + cr.z * upB.z))) / dt : 0;
      this.prevFwd = { ...this.charFwdB };
      if (this.harvestPos) this.myAstro.setHarvestTarget(this.rel(this.toWorld(charPl.index + 1, this.harvestPos, v3())));
      this.myAstro.update(dt, { speed: hs, vUp, ground: !!c.ground, jet: !c.ground && this.input.down('Space') && c.fuel > 0.01, look: this.ctrl.footPitch, turn });
    }
    if (mode === MODE.SHIP) this.sfx.engineLevel(this.ctrl.throttle, this.input.down('ShiftLeft'), isCruising(ship));
    else this.sfx.silenceEngine();

    // remote entities
    const rt = this.timeline.renderTime;
    for (const r of this.remotes.values()) {
      this.ensureView(r);
      const st = r.buf.sample(rt, r.bp, r.bq);
      r.state = st;
      r.visible = !!st && r.buf.lastSeen > this.timeline.serverNow - 1.2;
      if (st) {
        const pl = st.frame ? sys.planets[st.frame - 1] : null;
        const bv = v3(st.vx, st.vy, st.vz);
        if (pl) {
          const R = this.rots[pl.index];
          toWorldPoint(pl, R, r.bp, r.p);
          toWorldQuat(R, r.bq, r.q);
          toWorldVel(pl, R, r.bp, bv, r.v);
        } else {
          Object.assign(r.p, r.bp);
          Object.assign(r.q, r.bq);
          Object.assign(r.v, bv);
        }
      }
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
        const up = vnorm(v3(), r.bp);
        const vUp = st.vx * up.x + st.vy * up.y + st.vz * up.z;
        const hs = Math.hypot(st.vx - up.x * vUp, st.vy - up.y * vUp, st.vz - up.z * vUp);
        const ground = !(st.flags & EFLAG.BOOST);
        if (r.harvestPos) r.view.setHarvestTarget(this.rel(this.toWorld(st.frame, r.harvestPos, v3())));
        r.view.update(dt, { speed: hs, vUp, ground, jet: !ground && vUp > 2.5, look: 0, turn: 0 });
      } else if (r.view instanceof LootView) {
        r.view.update(dt);
      } else {
        r.smokeT -= dt;
        if (r.smokeT <= 0) { r.smokeT = 0.03; this.effects.smoke(r.p); }
      }
    }
    for (const p of this.pois) {
      const v = this.poiViews.get(p.id);
      if (!v) continue;
      this.place(v.group, v3(p.pos[0], p.pos[1], p.pos[2]));
      v.update(dt, this.time, p);
    }
    this.effects.setViewport(window.innerHeight, cam.fov);
    this.effects.update(dt, this.origin);

    this.updateEnvironment(toSun, onFoot ? this.charPos : this.shipPos);
    this.updateHud(self, mode, speed);
    this.r.render();
  }

  private harvestedSet(): Set<string> {
    const now = this.timeline.serverNow;
    const s = new Set<string>();
    for (const [k, until] of this.harvested) if (until > now) s.add(k);
    return s;
  }

  private updateEnvironment(toSun: V3, focus: V3) {
    const q = this.r.q;
    // Sun shadows follow the player (not the chase camera) inside a quality-sized box.
    const tx = focus.x - this.origin.x, ty = focus.y - this.origin.y, tz = focus.z - this.origin.z;
    this.sunLight.target.position.set(tx, ty, tz);
    this.sunLight.position.set(tx + toSun.x * 1000, ty + toSun.y * 1000, tz + toSun.z * 1000);
    const cam = this.sunLight.shadow.camera;
    if (cam.right !== q.shadowRange || this.sunLight.shadow.mapSize.x !== q.shadowSize) {
      Object.assign(cam, { left: -q.shadowRange, right: q.shadowRange, top: q.shadowRange, bottom: -q.shadowRange });
      cam.updateProjectionMatrix();
      this.sunLight.shadow.mapSize.set(q.shadowSize, q.shadowSize);
      this.sunLight.shadow.map?.dispose();
      this.sunLight.shadow.map = null;
    }

    const np = this.nearPlanet;
    let inside = 0, day = 1, dusk = 0;
    const fog = this.r.scene.fog as THREE.Fog;
    const u = this.sky.u;
    if (np) {
      const up = vnorm(v3(), vsub(v3(), this.origin, np.center));
      const se = up.x * toSun.x + up.y * toSun.y + up.z * toSun.z;
      day = THREE.MathUtils.smoothstep(se, -0.2, 0.25);
      dusk = THREE.MathUtils.smoothstep(se, 0.5, 0.05) * THREE.MathUtils.smoothstep(se, -0.3, 0.02);
      if (np.atmo) {
        inside = 1 - THREE.MathUtils.smoothstep(this.nearAlt, np.radius * 0.05, np.radius * 0.35);
        u.zen.value.set(np.atmo.zenith);
        u.hor.value.set(np.atmo.horizon);
        u.sunset.value.set('#ff8a4a').lerp(new THREE.Color(np.atmo.color), 0.25);
        u.ground.value.set(DUST[np.type] ?? '#3a3530').multiplyScalar(0.55);
        u.up.value.set(up.x, up.y, up.z);
        u.sun.value.set(toSun.x, toSun.y, toSun.z);
        u.sunC.value.copy(this.sun!.color);
        u.alpha.value = inside;
        u.day.value = day;
        const hor = new THREE.Color(np.atmo.horizon).lerp(u.sunset.value, dusk * 0.45).multiplyScalar(0.1 + 0.9 * day);
        fog.color.copy(hor);
        fog.near = THREE.MathUtils.lerp(1e8, 600, inside);
        fog.far = THREE.MathUtils.lerp(2e8, 14000, inside);
      }
    }
    if (!np?.atmo || inside <= 0) {
      u.alpha.value = 0;
      fog.near = 1e8;
      fog.far = 2e8;
    }

    // Ambient: hemisphere tinted by the sky, image-based reflections when enabled.
    const env = q.env;
    this.hemi.groundColor.set('#2a2630');
    if (np?.atmo && inside > 0) this.hemi.color.set('#6a7a9a').lerp(new THREE.Color(np.atmo.zenith), inside).multiplyScalar(0.35 + 0.65 * Math.max(day, 1 - inside));
    else this.hemi.color.set('#6a7a9a');
    this.hemi.intensity = env ? 1.0 : 1.6;
    if (env) {
      if (np?.atmo && inside > 0.5) {
        this.r.scene.environment = this.envLight.sky(this.sys!.id * 16 + np.index, u);
        this.r.scene.environmentIntensity = 0.35 + 0.55 * day;
      } else {
        this.r.scene.environment = this.envLight.spaceTexture;
        this.r.scene.environmentIntensity = 0.6;
      }
    } else this.r.scene.environment = null;

    this.r.scene.backgroundIntensity = 1 - inside * day * 0.97;
    this.sunLight.intensity = 2.6 * (np?.atmo ? 1 - inside * (1 - day) : 1);
    this.sunLight.color.copy(this.sun!.color).lerp(new THREE.Color('#ffb070'), dusk * inside * 0.6);
    const back = new THREE.Vector3(0, 0.3, 1).applyQuaternion(this.rig.quat);
    this.fill.position.copy(back).multiplyScalar(100);
    this.fill.intensity = 0.6 * (1 - inside * 0.6);
    this.sunLight.castShadow = q.shadows && this.nearAlt < 2000;
  }

  private project(p: V3): { x: number; y: number; behind: boolean } {
    tv.set(p.x - this.origin.x, p.y - this.origin.y, p.z - this.origin.z);
    const cam = this.r.camera;
    const vz = tv.clone().applyQuaternion(cam.quaternion.clone().invert()).z;
    tv.project(cam);
    return { x: (tv.x * 0.5 + 0.5) * window.innerWidth, y: (-tv.y * 0.5 + 0.5) * window.innerHeight, behind: vz > 0 };
  }

  /** Local solar time (hours) under the player when close to a planet. */
  private localClock(): { planet: string; hours: number } | null {
    const np = this.nearPlanet;
    if (!np || this.nearAlt > np.radius * 0.8) return null;
    const a = np.spinAxis;
    const flat = (v: V3) => { const k = v.x * a.x + v.y * a.y + v.z * a.z; return v3(v.x - a.x * k, v.y - a.y * k, v.z - a.z * k); };
    const s = flat(vsub(v3(), this.sys!.star.pos, np.center));
    const u = flat(vsub(v3(), this.origin, np.center));
    const c = vcross(v3(), s, u);
    // hour angle: 0 at local noon, growing as the ground turns away from the sun
    const h = Math.atan2(c.x * a.x + c.y * a.y + c.z * a.z, s.x * u.x + s.y * u.y + s.z * u.z);
    return { planet: np.name, hours: (((12 + (h / (Math.PI * 2)) * 24) % 24) + 24) % 24 };
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
      const inh = this.env ? cruiseInhibited(ship, this.env) : false;
      if (ship.landed) modeText = 'ПОСАДКА';
      else if (isCruising(ship)) modeText = 'КРУИЗ';
      else if (this.ctrl.cruiseOn) modeText = ship.cruiseBlock > 0 ? 'КРУИЗ: помехи' : inh ? 'КРУИЗ: масса рядом' : `КРУИЗ: ${(CRUISE_SPOOL - ship.cruise).toFixed(1)} с`;
      else if (vdist(this.shipW.p, sys.station.pos) < SAFE_ZONE_RADIUS) modeText = 'ЗОНА СТАНЦИИ';
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
        this.hud.target({ x: sp.x, y: sp.y, size, name: t.info?.name ?? '?', info: `${this.fmtDist(vdist(t.p, this.shipW.p))} · ${Math.round(Math.hypot(t.state.vx, t.state.vy, t.state.vz))} м/с`, shield: t.state.shield, hull: t.state.hull, lock: this.locked ? 2 : this.lockT > 0 ? 1 : 0 });
        const lp = leadPoint(this.shipW.p, this.shipW.v, t.p, t.v, LASER.speed, v3());
        const lps = this.project(lp);
        this.hud.leadAt(lps.behind ? null : lps);
      } else { this.hud.target(null); this.hud.leadAt(null); }
    } else { this.hud.target(null); this.hud.leadAt(null); }

    // nav (a convoy follows its freighter when that ship is in view)
    for (const n of this.navItems) {
      const r = n.ship ? this.remotes.get(n.ship) : undefined;
      if (r?.visible) Object.assign(n.pos, r.p);
    }
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
      if (r.info.kind === KIND.LOOT) { blips.push({ x: c.x, y: c.y, z: c.z, kind: 'loot' }); continue; }
      blips.push({ x: c.x, y: c.y, z: c.z, kind: r.info.npc ? 'npc' : 'player', sel: id === this.targetId });
      if (d < 4000 && mode !== MODE.DOCKED) {
        const sp = this.project(v3(r.p.x, r.p.y, r.p.z));
        if (!sp.behind) labels.push({ id, x: sp.x, y: sp.y - 18, text: r.info.name, sub: this.fmtDist(d), npc: !!r.info.npc, hull: r.state?.hull ?? 1 });
      }
    }
    for (const p of this.pois) { const pc = rel(v3(p.pos[0], p.pos[1], p.pos[2])); blips.push({ x: pc.x, y: pc.y, z: pc.z, kind: 'poi' }); }
    const sc = rel(sys.station.pos);
    blips.push({ x: sc.x, y: sc.y, z: sc.z, kind: 'station' });
    for (const g of sys.gates) { const gc = rel(g.pos); blips.push({ x: gc.x, y: gc.y, z: gc.z, kind: 'gate' }); }
    if (mode === MODE.FOOT) {
      for (const n of this.props.visibleNodes) {
        const nc = rel(this.toWorld(this.pred.charPlanet + 1, n.pos, v3()));
        blips.push({ x: nc.x * 20, y: 0, z: nc.z * 20, kind: 'node' });
      }
    }
    const np = this.nearPlanet;
    if (np && mode !== MODE.DOCKED && this.nearAlt < np.radius) {
      planetSites(np).forEach((s, k) => {
        const w = this.toWorld(np.index + 1, v3(s.dir.x * (np.radius + s.h + 12), s.dir.y * (np.radius + s.h + 12), s.dir.z * (np.radius + s.h + 12)), v3());
        const d = vdist(w, me);
        if (d > 6000 || d < 25) return;
        const sp = this.project(w);
        if (sp.behind) return;
        labels.push({ id: -1000 - np.index * 32 - k, x: sp.x, y: sp.y, text: s.name, sub: this.fmtDist(d), npc: s.kind === 'base', hull: 1, site: true });
      });
    }
    this.hud.setLabels(labels);
    this.radar.draw(blips);

    this.hud.clock(this.localClock());

    // context prompt
    let prompt: string | null = null;
    if (mode === MODE.SHIP) {
      const wreck = this.nearWreck();
      const anomaly = this.scan ? this.pois.find((p) => p.id === this.scan!.id) : null;
      if (ship.landed) prompt = '<kbd>G</kbd> выйти из корабля · <kbd>W</kbd> взлёт';
      else if (anomaly && this.scan) prompt = `Сканирование аномалии: ${Math.round(this.scan.k * 100)}% — оставайтесь внутри`;
      else if (wreck) prompt = vlen(this.shipW.v) > SALVAGE_MAX_SPEED ? `Обломки рядом — сбросьте скорость до ${SALVAGE_MAX_SPEED} м/с` : `<kbd>F</kbd> разобрать обломки (осталось: ${wreck.charges})`;
      else if (vdist(this.shipW.p, sys.station.pos) < DOCK_RANGE) prompt = '<kbd>F</kbd> стыковка со станцией';
      else if (sys.gates.some((g) => vdist(g.pos, this.shipW.p) < GATE_RANGE)) prompt = '<kbd>F</kbd> прыжок через врата';
      else if (this.nearPlanet && this.nearAlt < 250 && speed < 80 && Math.abs(this.ctrl.throttle) >= 0.05) prompt = '<kbd>X</kbd> сброс тяги — корабль сам опустится и сядет';
    } else if (mode === MODE.FOOT) {
      const n = this.nearestNode();
      if (n) prompt = `<kbd>F</kbd> собрать: ${RESOURCE_NAMES[n.type]}`;
      else if (ship.frame === this.pred.charPlanet + 1 && vdist(this.charPosB, ship.p) < EXIT_RANGE + 6) prompt = '<kbd>G</kbd> сесть в корабль';
    }
    this.hud.prompt(prompt);
  }
}
