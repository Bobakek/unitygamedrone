import * as THREE from 'three';
import { DOCK_RANGE, DT, EXIT_RANGE, GATE_RANGE, HARVEST_RANGE, INTERP_DELAY, SAFE_ZONE_RADIUS } from '../shared/constants.ts';
import { defaultUpgrades, flightStats } from '../shared/economy.ts';
import { getSystem, type PlanetDef, type SystemDef } from '../shared/galaxy/system-gen.ts';
import { FWD, qlook, qrot, quat, v3, vcross, vdist, vlen, vnorm, vsub, type Quat, type V3 } from '../shared/math/vec.ts';
import {
  aimPitch, BLASTER_LEVEL, DRONE_LEVEL, DECK_FRAME, CFLAG, EFLAG, IFLAG, KIND, MODE, type EntityInfo, type EntityState, type GameEvent, type GroupMsg, type PilotInfo, type SelfState, type Shot, type Snapshot, type Welcome,
} from '../shared/net/protocol.ts';
import { heightAt, liquidOf, surfaceHeight, waterColors } from '../shared/planet/terrain.ts';
import { resourceNode } from '../shared/planet/resources.ts';
import type { SimEnv } from '../shared/sim/env.ts';
import { climbProgress } from '../shared/sim/character.ts';
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
import { Underwater } from './world/underwater.ts';
import { SeaLife } from './planet/sealife.ts';
import { Wardrobe } from './ui/wardrobe.ts';
import { ContractsUi } from './ui/contracts.ts';
import { KIND_NAMES, type ActiveContract } from '../shared/contracts.ts';
import { DEFAULT_GEAR, gearStats, parseLook, validOutfit, type GearStats } from '../shared/outfit.ts';
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
import { WeatherView } from './world/weather.ts';
import { StationInterior } from './world/station-interior.ts';
import { BOARD_REACH, DECK_WALLS, nearTerminal, PAD, type TerminalKind } from '../shared/station/deck.ts';
import { forecast, HAZARD_GEAR, HAZARD_NAMES, LAVA_HEAT, STORM_OF, WEATHER, weatherAt, type Weather, type WeatherKind, type WeatherOverride } from '../shared/weather.ts';
import { CreatureView } from './entities/creature.ts';
import { DroneView } from './entities/drone.ts';
import { BLASTER, moodOf, SAMPLE_RANGE, SPECIES } from '../shared/fauna.ts';
import { planetSites, siteDir, sitePlane, sitesNear, wreckAt, wreckZone, type SiteDef } from '../shared/planet/sites.ts';
import { wreckLog } from '../shared/planet/wreck-log.ts';
import { POI_LABEL, SALVAGE_MAX_SPEED, SALVAGE_RANGE, type Poi } from '../shared/events.ts';
import { getGalaxy, route, SECURITY_NAMES } from '../shared/galaxy/galaxy.ts';
import { GalaxyMap } from './ui/galaxy-map.ts';

interface Remote {
  info: EntityInfo | null;
  buf: InterpBuffer;
  view: ShipView | AstronautView | MissileView | LootView | CreatureView | DroneView | null;
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
  /** Previous heading (creatures: turn-rate estimate). */
  prevF?: V3;
}

/** `site`: a point on a planet (body frame) the marker follows as the planet turns. */
interface NavItem { name: string; pos: V3; kind: 'planet' | 'station' | 'gate' | 'event' | 'goal' | 'ally'; radius: number; ship?: number; site?: { planet: number; p: V3 } }

const RESOURCE_NAMES = { ore: 'руда', crystal: 'кристалл', relic: 'реликт' } as const;
const DUST: Record<string, string> = { terran: '#9a8a6a', ocean: '#b0a080', alien: '#c090d0', desert: '#d9a060', ice: '#e8f4ff', lava: '#5a4a4a', barren: '#9a948e' };
const tv = new THREE.Vector3(), tv2 = new THREE.Vector3(), tv3 = new THREE.Vector3();

/** Splits a body-frame velocity into forward / sideways (right) / vertical parts for animation. */
function moveParts(v: V3, up: V3, fwd: V3) {
  const vUp = v.x * up.x + v.y * up.y + v.z * up.z;
  const hx = v.x - up.x * vUp, hy = v.y - up.y * vUp, hz = v.z - up.z * vUp;
  const rx = fwd.y * up.z - fwd.z * up.y, ry = fwd.z * up.x - fwd.x * up.z, rz = fwd.x * up.y - fwd.y * up.x;
  return { speed: Math.hypot(hx, hy, hz), fwd: hx * fwd.x + hy * fwd.y + hz * fwd.z, side: hx * rx + hy * ry + hz * rz, vUp };
}

/** Owns the client session: world rendering, prediction, networking glue and HUD. */
export class Game {
  private r: Renderer;
  private input: Input;
  private hud = new Hud();
  private wardrobe = new Wardrobe();
  private contracts = new ContractsUi();
  private galaxyMap = new GalaxyMap();
  /** Destination system picked on the galaxy map (its next gate is a navigation point). */
  private routeTo: number | null = null;
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
  private underwater = new Underwater();
  private sealife = new SeaLife();
  /** Camera under the sea (0/1), its depth, daylight at the camera, and the last swim state. */
  private camUnder = 0;
  private weatherV = new WeatherView();
  /** The walkable inside of this system's station. */
  private interior: StationInterior | null = null;
  /** Recent chat lines by pilot name (speech bubbles over their heads). */
  private bubbles = new Map<string, { text: string; until: number }>();
  private wxOverrides = new Map<number, WeatherOverride>();
  /** Weather where the camera is: kind, felt strength (fades with altitude), world wind. */
  private wx = { kind: 'clear' as WeatherKind, k: 0, wind: new THREE.Vector3(), dark: false };
  private wxBody: Weather = { kind: 'clear', k: 0, wind: v3() };
  private geigerT = 0;
  /** 0..1: how far the camera is inside a wrecked hull (dims daylight, lights the emergency lamps). */
  private indoorK = 0;
  private indoorStation = false;
  private wreckLights = [new THREE.PointLight('#6aff5a', 0, 30, 1.6), new THREE.PointLight('#ff3a2a', 0, 24, 1.6)];
  private camDepth = 0;
  private dayNow = 1;
  private lastSwim = 0;
  private bubbleT = 0;
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
  private goalIds: string[] = [];
  private goalsKnown = false;
  /** Effects of the local pilot's outfit (prediction must match the server). */
  private gear: GearStats = DEFAULT_GEAR;
  private self: SelfState | null = null;
  private lastMode = -1;
  private harvested = new Map<string, number>();
  private harvestVersion = 0;
  private targetId = 0;
  private lockT = 0;
  private locked = false;
  private navIndex = 0;
  private navItems: NavItem[] = [];
  /** The pilot's group and the session ids of the other members. */
  private group: GroupMsg = { members: [] };
  private allies = new Set<number>();
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
  /** Smoothed rifle aim (RMB on foot or recent shots) — drives camera and pose. */
  private aimK = 0;
  private lastAir = 1;
  /** Manual visor position (V), or null to follow the light. */
  private visorOverride: number | null = null;
  private lastShot = -99;
  private nearPlanet: PlanetDef | null = null;
  private nearAlt = 1e9;

  constructor(canvas: HTMLCanvasElement, name: string, token: string | undefined, private onFatal: (msg: string) => void, offline: boolean, private settings: Settings) {
    this.r = new Renderer(canvas, QUALITY[settings.quality]);
    this.envLight = new EnvLighting(this.r.gl);
    this.input = new Input(canvas);
    this.ctrl = new Controller(this.input);
    this.pred = new Predictor(() => this.env!, () => this.stats, () => this.gear, (planet, t) => this.sys ? weatherAt(this.sys.planets[planet], t, this.wxOverrides.get(planet)) : undefined);
    this.r.scene.add(this.world, this.sky.mesh);
    this.world.add(this.props.group, this.effects.group, this.underwater.group, this.sealife.group, this.weatherV.group);
    this.sunLight = new THREE.DirectionalLight('#ffffff', 2.6);
    Object.assign(this.sunLight.shadow.camera, { near: 1, far: 2400 });
    this.sunLight.shadow.bias = -0.0005;
    this.sunLight.shadow.normalBias = 0.05;
    this.hemi = new THREE.HemisphereLight('#6a7a9a', '#2a2630', 1.6);
    this.r.scene.add(this.sunLight, this.sunLight.target, this.hemi, this.fill, this.fill.target, ...this.wreckLights);
    document.querySelector('#shiplog .log-close')!.addEventListener('click', () => this.closeLog());
    this.r.scene.fog = new THREE.Fog('#000000', 1e8, 2e8);

    this.hud.onChat = (t) => this.conn.chat(t);
    this.hud.onAction = (a) => { this.conn.action(a); this.sfx.beep(); };
    this.hud.onWardrobe = () => { if (this.pilot) this.wardrobe.show(this.pilot); };
    this.wardrobe.onAction = (a) => { this.conn.action(a); this.sfx.beep(); };
    this.hud.onContracts = () => { if (this.pilot) this.contracts.show(this.pilot); };
    this.contracts.onAction = (a) => { this.conn.action(a); this.sfx.beep(); };
    this.galaxyMap.onRoute = (to) => this.setRoute(to);
    this.hud.onTyping = (t) => { this.input.typing = t; };
    this.hud.onGroup = (w) => {
      this.conn.action(w === 'leave' ? { a: 'groupLeave' } : { a: 'groupAnswer', yes: w === 'yes' });
      this.sfx.beep();
    };

    const handlers: NetHandlers = {
      welcome: (w) => this.onWelcome(w),
      snapshot: (s) => this.onSnapshot(s),
      info: (l) => this.onInfo(l),
      gone: (ids) => ids.forEach((id) => this.removeRemote(id)),
      shots: (s) => this.onShots(s),
      events: (e) => this.onEvents(e),
      pilot: (p) => this.setPilot(p),
      world: (p) => this.onWorld(p),
      board: (b) => this.contracts.setBoard(b),
      market: (m) => this.hud.setMarket(m),
      group: (g) => this.onGroup(g),
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
    const arrived = this.routeTo === w.system;
    if (arrived) this.routeTo = null;
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
    } else this.hud.toast(`Прыжок завершён: ${this.sys!.name} · ${SECURITY_NAMES[this.sys!.security]}${arrived ? ' · вы на месте' : ''}`, 'good');
    this.syncMap();
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
    this.interior?.dispose();
    this.interior = new StationInterior(sys, facing);
    this.world.add(this.interior.group);
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
    this.navItems.push(...this.goalNav());
    // group mates in this system
    for (const m of this.group.members) {
      if (m.id === this.welcome?.playerId || !m.pos || m.system !== this.sys?.id) continue;
      this.navItems.push({ name: `Группа: ${m.name}`, pos: v3(m.pos[0], m.pos[1], m.pos[2]), kind: 'ally', radius: 0 });
    }
    const i = this.navItems.findIndex((n) => n.name === cur);
    this.navIndex = i >= 0 ? i : Math.min(this.navIndex, this.navItems.length - 1);
  }

  /** The gate of this system that is the first jump towards `to`, and how many jumps it takes. */
  private gateTowards(to: number): { gate: SystemDef['gates'][number]; jumps: number } | null {
    const sys = this.sys;
    if (!sys) return null;
    const path = route(sys.id, to);
    const gate = path.length ? sys.gates.find((x) => x.target === path[0]) : undefined;
    return gate ? { gate, jumps: path.length } : null;
  }

  private setRoute(to: number | null) {
    this.routeTo = to;
    this.rebuildNav();
    if (to !== null) {
      const i = this.navItems.findIndex((n) => n.name.startsWith('▶'));
      if (i >= 0) this.navIndex = i;
      this.hud.toast(`Маршрут до ${getGalaxy().stars[to].name} проложен — следующие врата в навигации`);
    }
    this.syncMap();
  }

  private syncMap() {
    if (this.sys) this.galaxyMap.update(this.sys.id, this.routeTo, (this.pilot?.career.active ?? []).map((c) => c.system));
  }

  /** Navigation points for the map route and the targets of active contracts (another system: the next gate there). */
  private goalNav(): NavItem[] {
    const sys = this.sys;
    if (!sys || !this.pilot) return [];
    const out: NavItem[] = [];
    if (this.routeTo !== null && this.routeTo !== sys.id) {
      const next = this.gateTowards(this.routeTo);
      if (next) out.push({ name: `▶ ${getGalaxy().stars[this.routeTo].name} (${next.jumps}): ${next.gate.name}`, pos: next.gate.pos, kind: 'goal', radius: 0 });
    }
    for (const c of this.pilot.career.active) {
      const name = `◆ ${KIND_NAMES[c.kind]}: `;
      if (c.system !== sys.id) {
        const next = this.gateTowards(c.system);
        if (next) out.push({ name: `${name}${next.gate.name}${next.jumps > 1 ? ` (${next.jumps})` : ''}`, pos: next.gate.pos, kind: 'goal', radius: 0 });
        continue;
      }
      const pl = c.planet !== undefined ? sys.planets[c.planet] : undefined;
      if (pl && c.site !== undefined) {
        const s = planetSites(pl)[c.site];
        if (!s) continue;
        // the goal of the site: the centre of ruins and bases, the bridge of a wreck
        const g = siteDir(pl, s, s.goal.x, s.goal.z);
        const r = pl.radius + s.h + (s.kind === 'wreck' ? 2 : 12);
        out.push({ name: `${name}${s.name}`, pos: v3(), kind: 'goal', radius: 0, site: { planet: pl.index, p: v3(g.x * r, g.y * r, g.z * r) } });
      } else if (pl) out.push({ name: `${name}${pl.name}`, pos: pl.center, kind: 'goal', radius: pl.radius });
      else if (c.kind === 'supply' || c.kind === 'deliver') out.push({ name: `${name}${sys.station.name}`, pos: sys.station.pos, kind: 'goal', radius: 0 });
    }
    return out;
  }

  private onGroup(g: GroupMsg) {
    const was = this.group.members.length;
    this.group = g;
    const me = this.welcome?.playerId;
    this.allies = new Set(g.members.filter((m) => m.id !== me).map((m) => m.id));
    if (!was && g.members.length) this.hud.toast('Вы в группе: союзники отмечены зелёным, награды делятся', 'good');
    this.rebuildNav();
    this.renderGroup();
  }

  /** The group panel: each member's whereabouts and hull. */
  private renderGroup() {
    const me = this.welcome?.playerId;
    const here = this.shipW.p;
    const where = (m: GroupMsg['members'][number]) => {
      if (m.system !== this.sys?.id) return getSystem(m.system).name;
      if (m.mode === MODE.DEAD) return 'сбит';
      if (m.mode === MODE.DOCKED || m.mode === MODE.DECK) return 'на станции';
      if (m.id === me || !m.pos) return m.mode === MODE.FOOT ? 'пешком' : '';
      return this.fmtDist(vdist(v3(m.pos[0], m.pos[1], m.pos[2]), this.lastMode === MODE.FOOT ? this.charPos : here));
    };
    this.hud.group(this.group.members.map((m) => ({ name: m.id === me ? `${m.name} (вы)` : m.name, leader: m.leader, where: where(m), hull: m.hull })), this.group.invite?.from ?? null);
  }

  /** Invites the targeted pilot, or the one standing next to us. */
  private inviteNearby() {
    const t = this.targetId ? this.remotes.get(this.targetId) : undefined;
    if (t?.info && !t.info.npc && t.info.kind === KIND.SHIP && t.info.owner) { this.conn.action({ a: 'groupInvite', entity: this.targetId }); return; }
    const me = this.lastMode === MODE.FOOT || this.lastMode === MODE.DECK ? this.charPos : this.shipW.p;
    let best = 0, bd = 40;
    for (const [id, r] of this.remotes) {
      if (!r.visible || !r.info || r.info.npc || !r.info.owner || (r.info.kind !== KIND.CHAR && r.info.kind !== KIND.SHIP)) continue;
      const d = vdist(r.p, me);
      if (d < bd) { bd = d; best = id; }
    }
    if (best) this.conn.action({ a: 'groupInvite', entity: best });
    else this.hud.toast('Выберите пилота целью (T) или подойдите к нему. Можно и в чате: /invite имя', 'warn');
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
    this.gear = gearStats(validOutfit(p.outfit, p.items));
    this.myAstro?.dress(validOutfit(p.outfit, p.items), p.name);
    if (this.wardrobe.open) this.wardrobe.setPilot(p);
    this.contracts.setPilot(p);
    this.hud.setPilot(p, this.sys?.name ?? '');
    this.syncMap();
    // a freshly taken contract becomes the navigation target
    const had = new Set(this.goalIds), first = !this.goalsKnown;
    this.goalsKnown = true;
    this.goalIds = p.career.active.map((c) => c.id);
    this.rebuildNav();
    const fresh = p.career.active.find((c: ActiveContract) => !had.has(c.id));
    if (fresh && !first && had.size + 1 === this.goalIds.length) {
      const i = this.navItems.findIndex((n) => n.kind === 'goal' && n.name.startsWith(`◆ ${KIND_NAMES[fresh.kind]}`));
      if (i >= 0) { this.navIndex = i; this.hud.toast(`Цель контракта — в навигации: ${this.navItems[i].name.slice(2)}`); }
    }
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
    const inStation = (m: number) => m === MODE.DOCKED || m === MODE.DECK;
    if (inStation(prev) && !inStation(mode)) { this.wardrobe.close(); this.contracts.close(); }
    if (mode === MODE.DECK) { this.wardrobe.close(); this.contracts.close(); }
    if (mode === MODE.FOOT || mode === MODE.DECK) {
      this.ctrl.footPitch = -0.12;
      if (!this.myAstro) {
        this.myAstro = this.makeAstronaut(() => this.charPos);
        this.myAstro.enableSpot();
        if (this.pilot) this.myAstro.dress(validOutfit(this.pilot.outfit, this.pilot.items), this.pilot.name);
        this.world.add(this.myAstro.group);
      }
    }
    if (mode !== MODE.FOOT && mode !== MODE.DECK && this.myAstro) { this.myAstro.dispose(); this.myAstro = null; }
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
    else if (r.info.kind === KIND.CHAR) {
      const a = this.makeAstronaut(() => r.p, 0.5);
      a.dress(parseLook(r.info.look), r.info.name);
      r.view = a;
    }
    else if (r.info.kind === KIND.MISSILE) r.view = new MissileView();
    else if (r.info.kind === KIND.LOOT) r.view = new LootView();
    else if (r.info.kind === KIND.CREATURE && r.info.species !== undefined) r.view = SPECIES[r.info.species]?.drone ? new DroneView() : new CreatureView(SPECIES[r.info.species]);
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
    if (level === BLASTER_LEVEL) return new THREE.Color(2.6, 1.2, 0.3);
    if (level === DRONE_LEVEL) return new THREE.Color(2.8, 0.35, 0.3);
    const info = this.infos.get(shooter);
    if (info?.npc) return new THREE.Color(2.4, 0.5, 0.3);
    return [new THREE.Color(0.5, 2.2, 2.6), new THREE.Color(0.5, 2.2, 2.6), new THREE.Color(0.6, 2.6, 1.2), new THREE.Color(2.2, 1.6, 0.4), new THREE.Color(2.4, 0.8, 2.4)][level] ?? new THREE.Color(0.5, 2.2, 2.6);
  }

  private onShots(shots: Shot[]) {
    for (const s of shots) {
      const p = v3(s.px, s.py, s.pz);
      const shooter = s.level === BLASTER_LEVEL ? this.remotes.get(s.shooter)?.view : null;
      if (shooter instanceof AstronautView) {
        shooter.fire();
        if (shooter.aiming) { const m = shooter.muzzleWorld(tv3); p.x = m.x + this.origin.x; p.y = m.y + this.origin.y; p.z = m.z + this.origin.z; }
      }
      this.effects.bolt(p, v3(s.vx, s.vy, s.vz), this.shotColor(s.shooter, s.level), s.shooter, INTERP_DELAY, s.level === BLASTER_LEVEL ? 0.45 : undefined);
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
            if (v instanceof CreatureView || v instanceof DroneView) v.hit();
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
        case 'chat': this.hud.chat(e.from, e.text); this.bubbles.set(e.from, { text: e.text, until: this.time + 6 }); break;
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
        case 'hurt':
          this.myAstro?.hurt(Math.min(1, e.dmg / 15));
          this.hud.hurt(Math.min(0.6, e.dmg / 30));
          this.sfx.hit(false);
          break;
        case 'bite': {
          const v = this.remotes.get(e.id)?.view;
          if (v instanceof CreatureView) v.attack();
          break;
        }
        case 'roar': {
          const v = this.remotes.get(e.id)?.view;
          if (v instanceof CreatureView) { v.roar(); this.sfx.explosion(false, 0.12); }
          break;
        }
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
        case 'weather':
          this.wxOverrides.set(e.planet, { kind: e.kind, k: e.k, until: e.until });
          break;
        case 'strike': {
          const pl = this.sys?.planets[e.planet];
          if (!pl) break;
          const at = this.toWorld(pl.index + 1, v3(e.pos[0], e.pos[1], e.pos[2]), v3());
          const d = vdist(at, this.origin);
          if (d > 6000) break;
          const up = new THREE.Vector3(at.x - pl.center.x, at.y - pl.center.y, at.z - pl.center.z).normalize();
          this.weatherV.bolt(at, up, d);
          this.sfx.thunder(d / 343, Math.max(0.15, 1 - d / 3000));
          break;
        }
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
    if (mode !== MODE.SHIP && mode !== MODE.FOOT && mode !== MODE.DECK) return;
    const m = this.ctrl.build(mode, this.timeline.serverNow);
    this.conn.input(m);
    this.pred.step(m);
    this.energy = Math.min(100, this.energy + ENERGY_REGEN * DT);
    this.fireCd -= DT;
    if (mode === MODE.FOOT && m.flags & IFLAG.FIRE && this.fireCd <= 0) this.blasterBolt();
    if (mode !== MODE.SHIP) return;
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

  /** Local (predicted) hand-blaster bolt; the server does the hit test. */
  private blasterBolt() {
    const pl = this.sys!.planets[this.pred.charPlanet];
    if (!pl) return;
    this.fireCd = BLASTER.cooldown;
    const up = vnorm(v3(), vsub(v3(), this.charPos, pl.center));
    const c = Math.cos(this.ctrl.footPitch), s = Math.sin(this.ctrl.footPitch);
    const d = v3(this.charFwd.x * c + up.x * s, this.charFwd.y * c + up.y * s, this.charFwd.z * c + up.z * s);
    const right = vnorm(v3(), vcross(v3(), this.charFwd, up));
    let p = v3(this.charPos.x + up.x * 1.45 + right.x * 0.35, this.charPos.y + up.y * 1.45 + right.y * 0.35, this.charPos.z + up.z * 1.45 + right.z * 0.35);
    const astro = this.myAstro;
    if (astro?.aiming) {
      // leave from the muzzle, converging on the point under the crosshair
      const m = astro.muzzleWorld(tv3);
      const target = v3(p.x + d.x * 60, p.y + d.y * 60, p.z + d.z * 60);
      p = v3(m.x + this.origin.x, m.y + this.origin.y, m.z + this.origin.z);
      const dd = vnorm(v3(), vsub(v3(), target, p));
      d.x = dd.x; d.y = dd.y; d.z = dd.z;
    }
    astro?.fire();
    this.lastShot = this.time;
    this.effects.bolt(p, v3(d.x * BLASTER.speed, d.y * BLASTER.speed, d.z * BLASTER.speed), this.shotColor(0, BLASTER_LEVEL), this.self!.charId, 0, 0.45);
    this.sfx.blaster();
  }

  /** A terminal on the station deck: the matching station window. */
  private openTerminal(kind: TerminalKind, name: string) {
    if (!this.pilot) return;
    this.input.releaseLock();
    this.sfx.beep(true);
    if (kind === 'contracts') this.contracts.show(this.pilot);
    else if (kind === 'wardrobe') this.wardrobe.show(this.pilot);
    else {
      this.hud.showStation(true, `${this.sys!.station.name} · ${name}`, true);
      if (this.self) this.hud.renderStation(this.pilot, { hull: this.self.hull, max: this.self.maxHull });
    }
  }

  /** Third-person camera on the deck: never behind a wall, never above the ceiling. */
  private deckClamp(pivot: V3) {
    const it = this.interior!, st = this.sys!.station.pos;
    const a = it.toDeck(st, pivot), b = it.toDeck(st, this.rig.pos);
    const dx = b.x - a.x, dz = b.z - a.z;
    let tMin = 1;
    for (const [x0, z0, x1, z1] of DECK_WALLS) {
      const ex = x1 - x0, ez = z1 - z0, den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((x0 - a.x) * ez - (z0 - a.z) * ex) / den, u = ((x0 - a.x) * dz - (z0 - a.z) * dx) / den;
      if (t > 0 && t < tMin && u >= 0 && u <= 1) tMin = t;
    }
    const len = Math.hypot(dx, b.y - a.y, dz) || 1;
    const k = tMin < 1 ? Math.max(0.08, tMin - 0.4 / len) : 1;
    const ceil = it.ceil(a.x, a.z) ?? 9;
    let y = a.y + (b.y - a.y) * k;
    if (y > ceil - 0.4) y = ceil - 0.4;
    const w = it.toWorld(st, v3(a.x + dx * k, y, a.z + dz * k), v3());
    this.rig.pos.x = w.x; this.rig.pos.y = w.y; this.rig.pos.z = w.z;
  }

  /** A wreck's bridge console within reach of the pilot on foot. */
  private nearLog(): SiteDef | null {
    const pl = this.pred.charPlanet >= 0 ? this.sys?.planets[this.pred.charPlanet] : null;
    if (!pl) return null;
    const w = wreckAt(pl, this.charPosB);
    if (!w || wreckZone(w.site, w.x, w.z) !== 'bridge') return null;
    return Math.hypot(w.x - w.site.goal.x, w.z - w.site.goal.z) < 2.6 ? w.site : null;
  }

  private openLog(s: SiteDef) {
    const pl = this.sys!.planets[s.planet];
    const log = wreckLog(s, pl.name);
    document.querySelector('#shiplog .log-title')!.textContent = log.title;
    const body = document.querySelector('#shiplog .log-body')!;
    body.replaceChildren(...log.entries.map((t) => { const p = document.createElement('p'); p.textContent = t; return p; }));
    document.getElementById('shiplog')!.classList.remove('hidden');
    this.input.releaseLock();
    this.sfx.beep(true);
  }

  private closeLog() {
    document.getElementById('shiplog')!.classList.add('hidden');
  }

  /**
   * Keeps the third-person camera from seeing through the walls of a wreck next to the pilot,
   * and under its roof while the pilot is inside.
   */
  private wallClamp(pl: PlanetDef, pivot: V3) {
    const R = this.rots[pl.index];
    const pB = toBodyPoint(pl, R, pivot, v3()), cB = toBodyPoint(pl, R, this.rig.pos, v3());
    const up = vnorm(v3(), pB);
    let tMin = 1;
    for (const s of sitesNear(pl, up, 60)) {
      if (s.kind !== 'wreck') continue;
      const a = sitePlane(pl, s, pB), b = sitePlane(pl, s, cB);
      const dx = b.x - a.x, dz = b.z - a.z;
      for (const w of s.walls) {
        const ex = w.x1 - w.x0, ez = w.z1 - w.z0;
        const den = dx * ez - dz * ex;
        if (Math.abs(den) < 1e-9) continue;
        const t = ((w.x0 - a.x) * ez - (w.z0 - a.z) * ex) / den;
        const u = ((w.x0 - a.x) * dz - (w.z0 - a.z) * dx) / den;
        if (t > 0 && t < tMin && u >= 0 && u <= 1) tMin = t;
      }
    }
    if (tMin < 1) {
      const len = vdist(pivot, this.rig.pos) || 1;
      const k = Math.max(0.08, tMin - 0.4 / len);
      this.rig.pos.x = pivot.x + (this.rig.pos.x - pivot.x) * k;
      this.rig.pos.y = pivot.y + (this.rig.pos.y - pivot.y) * k;
      this.rig.pos.z = pivot.z + (this.rig.pos.z - pivot.z) * k;
    }
    const inside = wreckAt(pl, this.charPosB);
    if (inside && vlen(this.charPosB) < inside.roof) this.rig.clampRadius(pl.center, 0, inside.roof - 0.45);
  }

  /** Carcass within reach of the pilot. */
  private nearCarcass(): { id: number; name: string; drone: boolean } | null {
    for (const [id, r] of this.remotes) {
      if (r.info?.kind !== KIND.CREATURE || !r.state || !(r.state.flags & EFLAG.DEAD) || r.state.frame !== this.pred.charPlanet + 1) continue;
      const sp = SPECIES[r.info.species ?? 0];
      if (vdist(r.bp, this.charPosB) < SAMPLE_RANGE + sp.size) return { id, name: sp.name, drone: !!sp.drone };
    }
    return null;
  }

  private handleKeys(dt: number, mode: number) {
    const i = this.input;
    if (i.hit('KeyH')) this.hud.toggleHelp();
    if (i.hit('KeyO')) this.toggleSettings();
    if (i.hit('KeyM')) { this.galaxyMap.toggle(); if (this.galaxyMap.open) i.releaseLock(); }
    if (i.hit('Escape')) { this.hud.toggleHelp(false); this.toggleSettings(false); this.wardrobe.close(); this.contracts.close(); this.galaxyMap.close(); this.closeLog(); if (mode === MODE.DECK) this.hud.showStation(false); }
    if (i.hit('Enter')) { this.hud.focusChat(); i.releaseLock(); }
    if (i.hit('KeyZ')) i.releaseLock();
    if (i.hit('KeyV') && mode === MODE.FOOT) {
      // visor: automatic → forced up / down → automatic
      this.visorOverride = this.visorOverride === null ? (this.myAstro && this.myAstro.visorUp > 0.5 ? 0 : 1) : null;
      this.hud.toast(this.visorOverride === null ? 'Светофильтр: авто' : this.visorOverride ? 'Светофильтр поднят' : 'Светофильтр опущен');
    }
    if (i.hit('Tab')) this.navIndex = (this.navIndex + 1) % Math.max(1, this.navItems.length);
    if (i.hit('KeyT')) this.pickTarget();
    if (i.hit('KeyP')) this.inviteNearby();
    const yes = i.hit('KeyY'), no = i.hit('KeyN');
    if (this.group.invite && (yes || no)) {
      this.conn.action({ a: 'groupAnswer', yes });
      this.group.invite = undefined;
      this.renderGroup();
    }
    if (i.hit('KeyG')) {
      if (mode === MODE.SHIP && this.pred.ship.landed) this.conn.action({ a: 'exit' });
      else if (mode === MODE.FOOT || mode === MODE.DECK) this.conn.action({ a: 'board' });
      else if (mode === MODE.DOCKED) this.conn.action({ a: 'disembark' });
    }
    if (i.hit('KeyF') && mode === MODE.DECK && this.pred.char) {
      const t = nearTerminal(this.pred.char.p);
      if (t) this.openTerminal(t.kind, t.name);
    } else if (i.hit('KeyF')) {
      const carcass = mode === MODE.FOOT ? this.nearCarcass() : null;
      const log = mode === MODE.FOOT ? this.nearLog() : null;
      if (log) this.openLog(log);
      else if (carcass) { this.conn.action({ a: 'sample', id: carcass.id }); this.sfx.mining(); }
      else if (mode === MODE.FOOT) {
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

  /**
   * Visual lift (metres along local up) that puts something standing on a planet onto the
   * terrain as it is drawn: far away the mesh is a coarser LOD than the exact height used by
   * physics. Fades out a few metres above the ground (jumps, hovering).
   */
  private groundFix(planet: number, bodyP: V3): number {
    const pv = this.planets[planet];
    if (!pv) return 0;
    const pl = pv.def;
    const l = vlen(bodyP);
    const d = v3(bodyP.x / l, bodyP.y / l, bodyP.z / l);
    const h = heightAt(pl, d.x, d.y, d.z);
    if (pl.sea && h < 0) return 0;
    const alt = l - pl.radius - h;
    if (alt > 5) return 0;
    return pv.groundDelta(d, h) * (alt <= 2.5 ? 1 : 1 - (alt - 2.5) / 2.5);
  }

  /** Moves `obj` along its planet's world up by the ground fix of body position `bodyP`. */
  private liftToGround(obj: THREE.Object3D, frame: number, bodyP: V3, worldP: V3) {
    if (!frame || frame === DECK_FRAME) return;
    const fix = this.groundFix(frame - 1, bodyP);
    if (!fix) return;
    const c = this.sys!.planets[frame - 1].center;
    const up = vnorm(v3(), vsub(v3(), worldP, c));
    obj.position.x += up.x * fix; obj.position.y += up.y * fix; obj.position.z += up.z * fix;
  }

  /** Render-space vector (relative to the floating origin) of a world point. */
  private rel(p: V3): THREE.Vector3 {
    return new THREE.Vector3(p.x - this.origin.x, p.y - this.origin.y, p.z - this.origin.z);
  }

  /** Converts a point from `frame` (0 = world, planet + 1 = body) to world at the render time. */
  private toWorld(frame: number, p: V3, out: V3): V3 {
    if (!frame) { out.x = p.x; out.y = p.y; out.z = p.z; return out; }
    if (frame === DECK_FRAME) return this.interior!.toWorld(this.sys!.station.pos, p, out);
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
    const onDeck = mode === MODE.DECK && this.pred.charPose(alpha, this.charPosB, this.charFwdB);
    const onFoot = mode === MODE.FOOT && this.pred.charPose(alpha, this.charPosB, this.charFwdB);
    const charPl = onFoot ? sys.planets[this.pred.charPlanet] : null;
    const it = this.interior!;
    if (charPl) {
      const R = this.rots[charPl.index];
      toWorldPoint(charPl, R, this.charPosB, this.charPos);
      toWorldDir(R, this.charFwdB, this.charFwd);
    } else if (onDeck) {
      it.toWorld(sys.station.pos, this.charPosB, this.charPos);
      const fw = it.dirToWorld(this.charFwdB);
      this.charFwd.x = fw.x; this.charFwd.y = fw.y; this.charFwd.z = fw.z;
    }
    const speed = vlen(ship.v);

    // nearest planet to the player
    const focus = onFoot || onDeck ? this.charPos : this.shipPos;
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
      const wantAim = this.input.mouse(2) || this.time - this.lastShot < 1.5;
      this.aimK += ((wantAim ? 1 : 0) - this.aimK) * (1 - Math.exp(-dt * 9));
      this.ctrl.lookScale = 1 - 0.4 * this.aimK;
      // orbit the pilot as drawn (the model gets the same ground fix)
      const fix = this.groundFix(charPl.index, this.charPosB);
      const piv = v3(this.charPos.x + up.x * fix, this.charPos.y + up.y * fix, this.charPos.z + up.z * fix);
      const R = this.rots[charPl.index], cd = v3();
      // a swimmer's camera may dive with them: only the sea bed stops it
      const swim = this.pred.char?.swim ?? 0;
      const solid = swim ? heightAt : surfaceHeight;
      const clear = (x: number, y: number, z: number) => {
        cd.x = x - charPl.center.x; cd.y = y - charPl.center.y; cd.z = z - charPl.center.z;
        const l = vlen(cd);
        toBodyDir(R, vnorm(cd, cd), cd);
        return l - charPl.radius - solid(charPl, cd.x, cd.y, cd.z) - fix;
      };
      // pivot: shoulder when upright, above the water for a surface swimmer, the body for a diver
      const pivotH = swim === 1 ? 1.8 : swim === 2 ? 1.0 : 1.5;
      this.rig.foot(dt, piv, up, this.charFwd, this.ctrl.footPitch, this.ctrl.footDist, this.input.mouse(2) ? this.aimK : 0, pivotH, clear);
      // never leave the lens cutting the water plane: stay on the swimmer's side of it
      if (swim === 1) this.rig.clampRadius(charPl.center, charPl.radius + 0.3, Infinity);
      else if (swim === 2) this.rig.clampRadius(charPl.center, 0, charPl.radius - 0.3);
      this.wallClamp(charPl, piv);
    } else if (onDeck) {
      const wantAim = this.input.mouse(2);
      this.aimK += ((wantAim ? 1 : 0) - this.aimK) * (1 - Math.exp(-dt * 9));
      this.ctrl.lookScale = 1 - 0.4 * this.aimK;
      const up = it.dirToWorld(v3(0, 1, 0));
      this.rig.foot(dt, this.charPos, up, this.charFwd, this.ctrl.footPitch, this.ctrl.footDist, this.input.mouse(2) ? this.aimK : 0, 1.5, () => 50);
      this.deckClamp(this.charPos);
    } else if (mode === MODE.DOCKED) {
      // in the hangar, slowly circling the ship on its pad
      const a = this.time * 0.07;
      const cam = it.toWorld(sys.station.pos, v3(PAD.x + Math.cos(a) * 13, 5.5, PAD.z + Math.sin(a) * 9), v3());
      const at = it.toWorld(sys.station.pos, v3(PAD.x, 2, PAD.z), v3());
      const up = it.dirToWorld(v3(0, 1, 0));
      this.rig.look(cam, at, v3(up.x, up.y, up.z));
    }
    const np = this.nearPlanet;
    if (np && this.nearAlt < np.maxHeight * 3 + 400) {
      const d = toBodyDir(this.rots[np.index], vnorm(v3(), vsub(v3(), this.rig.pos, np.center)), v3());
      const diving = onFoot && np === charPl && (this.pred.char?.swim ?? 0) > 0;
      this.rig.clampAbove(np.center, np.radius + (diving ? heightAt : surfaceHeight)(np, d.x, d.y, d.z), onFoot ? (diving ? 0.4 : 0.6) : 1.5);
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
    this.props.update(propsPlanet ? this.planets[propsPlanet.index] : null, camB, this.harvestedSet(), this.harvestVersion, this.time, { props: true, small: this.r.q.smallProps });
    // is the camera under the sea?
    this.camUnder = 0;
    this.camDepth = 0;
    if (np && liquidOf(np) === 'water') {
      const dep = np.radius - vdist(this.origin, np.center);
      const bd = toBodyDir(this.rots[np.index], vnorm(v3(), vsub(v3(), this.origin, np.center)), v3());
      if (dep > 0 && heightAt(np, bd.x, bd.y, bd.z) < 0) { this.camUnder = 1; this.camDepth = dep; }
    }
    this.planets.forEach((pv, i) => {
      const p = pv.def;
      const R = this.rots[i];
      pv.sun = tv2.set(toSun.x, toSun.y, toSun.z);
      pv.day = np === p ? this.dayNow : 1;
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
      cl.group.visible = !this.camUnder;
      // ruins and outposts ride the planet group; built lazily on approach
      const near = vdist(this.origin, p.center) < p.radius * 3;
      if (near && !this.siteViews[i]) this.siteViews[i] = planetSites(p).map((s) => { const v = new SiteView(p, s); pv.group.add(v.group); return v; });
      if (near) for (const v of this.siteViews[i]!) { v.update(this.time); v.ground(pv); }
    });
    this.place(this.station!.group, sys.station.pos);
    this.station!.update(dt);
    const inside = mode === MODE.DOCKED || mode === MODE.DECK;
    this.station!.setInside(inside);
    it.group.visible = inside;
    if (inside) {
      this.place(it.group, it.toWorld(sys.station.pos, v3(0, 0, 0), v3()));
      it.group.quaternion.copy(it.q);
      it.update(dt, this.time, onDeck ? this.charPosB : null);
    }
    this.gates.forEach((g) => { this.place(g.group, g.def.pos); g.update(dt); });
    this.fields.forEach((f) => this.place(f.group, f.def.center));
    if (propsPlanet) this.props.sync(this.origin, this.rots[propsPlanet.index]);
    // fish scatter from a swimmer
    const swimmer = onFoot && charPl === propsPlanet && (this.pred.char?.swim ?? 0) > 0 ? this.charPosB : null;
    this.sealife.update(propsPlanet, camB, swimmer, this.time, dt, this.dayNow);
    if (propsPlanet) this.sealife.sync(this.origin, this.rots[propsPlanet.index]);

    // own ship / astronaut
    const ms = this.myShip!;
    ms.group.visible = mode === MODE.SHIP || mode === MODE.FOOT || inside;
    if (inside) {
      // parked on its pad in the hangar, nose towards the bay
      this.place(ms.group, it.toWorld(sys.station.pos, v3(PAD.x, 2.4, PAD.z), v3()));
      ms.group.quaternion.copy(it.q);
    } else {
      this.place(ms.group, this.shipPos);
      ms.group.quaternion.set(this.shipQ.x, this.shipQ.y, this.shipQ.z, this.shipQ.w);
    }
    if (ship.landed && !inside) this.liftToGround(ms.group, ship.frame, this.shipPosF, this.shipPos);
    ms.throttle = Math.abs(this.ctrl.throttle);
    ms.boost = this.input.down('ShiftLeft');
    ms.cruise = isCruising(ship);
    ms.landed = !!ship.landed || mode === MODE.FOOT || inside;
    ms.update(dt, this.time);
    if (this.myAstro && onDeck) {
      // walking on the deck: the same animation inputs, with the deck's up
      const up = it.dirToWorld(v3(0, 1, 0));
      this.place(this.myAstro.group, this.charPos);
      const q = qlook(quat(), this.charFwd, v3(up.x, up.y, up.z));
      this.myAstro.group.quaternion.set(q.x, q.y, q.z, q.w);
      const c = this.pred.char!;
      const upB = v3(0, 1, 0);
      const mv = moveParts(c.v, upB, this.charFwdB);
      const cr = vcross(v3(), this.prevFwd, this.charFwdB);
      const turn = dt > 0 ? -Math.asin(Math.max(-1, Math.min(1, cr.y))) / dt : 0;
      this.prevFwd = { ...this.charFwdB };
      this.myAstro.update(dt, { ...mv, ground: !!c.ground, jet: false, look: this.ctrl.footPitch, turn, aim: false, aimPitch: 0, climb: null, scramble: false, swim: 0, swimPitch: 0 });
      this.myAstro.visorUp = this.visorOverride ?? 1;
      this.myAstro.lightsOn = false;
    }
    if (this.myAstro && onFoot && charPl) {
      const up = vnorm(v3(), vsub(v3(), this.charPos, charPl.center));
      this.place(this.myAstro.group, this.charPos);
      this.liftToGround(this.myAstro.group, charPl.index + 1, this.charPosB, this.charPos);
      const q = qlook(quat(), this.charFwd, up);
      this.myAstro.group.quaternion.set(q.x, q.y, q.z, q.w);
      // animation inputs in the body frame (independent of the planet's spin)
      const c = this.pred.char!;
      const upB = vnorm(v3(), this.charPosB);
      const mv = moveParts(c.v, upB, this.charFwdB);
      const cr = vcross(v3(), this.prevFwd, this.charFwdB);
      const turn = dt > 0 ? -Math.asin(Math.max(-1, Math.min(1, cr.x * upB.x + cr.y * upB.y + cr.z * upB.z))) / dt : 0;
      this.prevFwd = { ...this.charFwdB };
      if (this.harvestPos) this.myAstro.setHarvestTarget(this.rel(this.toWorld(charPl.index + 1, this.harvestPos, v3())));
      this.myAstro.update(dt, {
        ...mv, ground: !!c.ground, jet: !c.ground && !c.climbMode && this.input.down('Space') && c.fuel > 0.01, look: this.ctrl.footPitch, turn,
        aim: this.aimK > 0.5, aimPitch: this.ctrl.footPitch, climb: c.climbMode ? { mode: c.climbMode, t: climbProgress(c) } : null, scramble: !!c.scramble,
        swim: c.swim, swimPitch: Math.atan2(mv.vUp, Math.hypot(mv.fwd, mv.side) + 1e-3),
      });
      // gold visor down in daylight, up in the dark or under water; lamps on when it is dark
      const dark = this.dayNow < 0.35 || this.camUnder > 0 || this.wx.dark || this.indoorK > 0.5;
      this.myAstro.visorUp = this.visorOverride ?? (dark || c.swim === 2 ? 1 : 0);
      this.myAstro.lightsOn = dark || c.swim === 2;
      // splash in and out of deep water; a diver breathes out bubbles
      if (!!c.swim !== !!this.lastSwim) this.sfx.splash(Math.min(1, 0.4 + Math.abs(mv.vUp) * 0.2));
      this.lastSwim = c.swim;
      if (c.swim === 2 && (this.bubbleT -= dt) <= 0) {
        this.bubbleT = 1.1 + Math.random() * 0.9;
        const hp = v3(this.charPos.x + up.x * 1.1 + this.charFwd.x * 0.5, this.charPos.y + up.y * 1.1 + this.charFwd.y * 0.5, this.charPos.z + up.z * 1.1 + this.charFwd.z * 0.5);
        this.effects.bubbles(hp, up, 4 + Math.floor(Math.random() * 4), charPl.radius - vdist(hp, charPl.center));
        this.sfx.bubbles();
      }
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
        const pl = st.frame && st.frame !== DECK_FRAME ? sys.planets[st.frame - 1] : null;
        const bv = v3(st.vx, st.vy, st.vz);
        if (st.frame === DECK_FRAME) {
          // walking on the station deck
          this.interior!.toWorld(sys.station.pos, r.bp, r.p);
          const wq = this.interior!.q.clone().multiply(new THREE.Quaternion(r.bq.x, r.bq.y, r.bq.z, r.bq.w));
          r.q.x = wq.x; r.q.y = wq.y; r.q.z = wq.z; r.q.w = wq.w;
          const wv = this.interior!.dirToWorld(bv);
          r.v.x = wv.x; r.v.y = wv.y; r.v.z = wv.z;
        } else if (pl) {
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
      const grounded = r.view instanceof AstronautView || r.view instanceof CreatureView || r.view instanceof DroneView || (r.view instanceof ShipView && !!(st.flags & EFLAG.LANDED));
      if (grounded) this.liftToGround(r.view.group, st.frame, r.bp, r.p);
      if (r.view instanceof ShipView) {
        r.view.throttle = st.throttle;
        r.view.boost = !!(st.flags & EFLAG.BOOST);
        r.view.cruise = !!(st.flags & EFLAG.CRUISE);
        r.view.landed = !!(st.flags & EFLAG.LANDED);
        r.view.update(dt, this.time);
      } else if (r.view instanceof AstronautView) {
        const up = st.frame === DECK_FRAME ? v3(0, 1, 0) : vnorm(v3(), r.bp);
        const fwd = qrot(v3(), r.bq, FWD);
        const mv = moveParts(v3(st.vx, st.vy, st.vz), up, fwd);
        const climbing = !!(st.flags & CFLAG.CLIMB);
        const swim = st.flags & CFLAG.UNDER ? 2 : st.flags & CFLAG.SWIM ? 1 : 0;
        const ground = !(st.flags & CFLAG.AIR) && !swim;
        const rpl = st.frame ? sys.planets[st.frame - 1] : null;
        r.view.visorUp = this.dayNow < 0.35 || this.wx.dark || swim === 2 ? 1 : 0;
        r.view.lightsOn = this.dayNow < 0.35 || this.wx.dark || swim === 2;
        if (swim === 2 && rpl && (r.smokeT -= dt) <= 0) {
          // a diver breathes out bubbles
          r.smokeT = 1.2 + Math.random();
          const wup = vnorm(v3(), vsub(v3(), r.p, rpl.center));
          const hp = v3(r.p.x + wup.x * 1.1, r.p.y + wup.y * 1.1, r.p.z + wup.z * 1.1);
          this.effects.bubbles(hp, wup, 5, rpl.radius - vdist(hp, rpl.center));
        }
        const cm = st.throttle >= 0.5 ? 2 : 1;
        if (r.harvestPos) r.view.setHarvestTarget(this.rel(this.toWorld(st.frame, r.harvestPos, v3())));
        r.view.update(dt, {
          ...mv, ground, jet: !ground && !climbing && mv.vUp > 2.5, look: 0, turn: 0,
          aim: !!(st.flags & CFLAG.AIM), aimPitch: aimPitch(st.shield),
          climb: climbing ? { mode: cm, t: cm === 2 ? (st.throttle - 0.5) * 2 : st.throttle * 2 } : null, scramble: !!(st.flags & CFLAG.SCRAMBLE),
          swim, swimPitch: Math.atan2(mv.vUp, Math.hypot(mv.fwd, mv.side) + 1e-3),
        });
      } else if (r.view instanceof LootView) {
        r.view.update(dt);
      } else if (r.view instanceof DroneView) {
        const dead = !!(st.flags & EFLAG.DEAD);
        r.view.update(dt, { speed: Math.hypot(st.vx, st.vy, st.vz), mood: moodOf(st.throttle), dead });
        if (dead && (r.smokeT -= dt) <= 0) { r.smokeT = 0.25; this.effects.smoke(r.p); }
      } else if (r.view instanceof CreatureView) {
        // heading change rate drives turning-in-place steps
        const f = qrot(v3(), r.bq, FWD), up = vnorm(v3(), r.bp);
        let turn = 0;
        if (r.prevF && dt > 0) {
          const cr = vcross(v3(), r.prevF, f);
          turn = Math.asin(Math.max(-1, Math.min(1, cr.x * up.x + cr.y * up.y + cr.z * up.z))) / dt;
        }
        r.prevF = f;
        r.view.update(dt, { speed: Math.hypot(st.vx, st.vy, st.vz), turn, mood: moodOf(st.throttle), dead: !!(st.flags & EFLAG.DEAD) });
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
    this.underwater.setViewport(window.innerHeight, cam.fov);
    this.weatherV.setViewport(window.innerHeight, cam.fov);
    this.effects.update(dt, this.origin);
    this.updateWeather(dt, onFoot);

    this.updateEnvironment(toSun, onFoot ? this.charPos : this.shipPos);
    this.updateHud(self, mode, speed);
    this.r.render();
  }

  /**
   * Weather around the camera on the nearest planet: felt in full near the ground, fading out
   * high in the sky; drives the precipitation, fog, light, sound and the storm HUD.
   */
  private updateWeather(dt: number, onFoot: boolean) {
    const np = this.nearPlanet;
    const now = this.timeline.serverNow;
    const w = this.wx;
    w.kind = 'clear'; w.k = 0; w.wind.set(0, 0, 0); w.dark = false;
    let up = new THREE.Vector3(0, 1, 0), camC = new THREE.Vector3();
    if (np) {
      const wb = weatherAt(np, now, this.wxOverrides.get(np.index), this.wxBody);
      camC.set(this.origin.x - np.center.x, this.origin.y - np.center.y, this.origin.z - np.center.z);
      up = camC.clone().normalize();
      const low = 1 - THREE.MathUtils.smoothstep(this.nearAlt, 1500, 4000);
      w.kind = wb.kind;
      w.k = this.camUnder ? 0 : wb.k * low;
      const R = this.rots[np.index];
      const wv = toWorldDir(R, wb.wind, v3());
      w.wind.set(wv.x, wv.y, wv.z).multiplyScalar(low);
      w.dark = w.k > 0.55 && wb.kind !== 'radiation';
      this.clouds.forEach((c, i) => c.storm(i === np.index && wb.kind !== 'radiation' ? wb.k * 0.9 : 0));
    }
    this.weatherV.update(dt, w.kind, w.k, camC, up, w.wind, 0.15 + 0.85 * this.dayNow, this.time, this.origin);
    const rainy = w.kind === 'storm' || w.kind === 'acid';
    this.sfx.weather(rainy ? w.k : 0, Math.min(1, w.wind.length() / 20) * (this.camUnder ? 0 : 1));

    // the storm HUD: what hits the suit and how well the gear protects
    let chip: { icon: string; text: string; level: 0 | 1 | 2 } | null = null;
    if (np && onFoot && this.pred.char) {
      const g = this.gear;
      const wb = this.wxBody;
      const parts: string[] = [];
      let dps = 0, rad = false;
      if (wb.kind !== 'clear' && wb.k > 0.05) {
        const def = WEATHER[wb.kind];
        if (def.hazard === 'lightning') parts.push(`${def.name} · молнии`);
        else if (def.hazard) {
          const prot = g[HAZARD_GEAR[def.hazard]];
          rad = def.hazard === 'rad';
          // radiation storms only burn in sunlight; under water only the cold gets through
          const shade = rad && this.dayNow < 0.3, wet = (this.pred.char.swim === 2 && def.hazard !== 'cold');
          const d = shade || wet ? 0 : def.rate * wb.k * (1 - prot);
          dps += d;
          parts.push(shade ? `${def.name} · в тени планеты безопасно` : `${def.name} · ${HAZARD_NAMES[def.hazard]} −${d.toFixed(1)}/с · защита ${Math.round(prot * 100)} %`);
        }
      }
      if (np.type === 'lava') {
        const d = LAVA_HEAT * (1 - g.thermal);
        dps += d;
        if (!parts.length) parts.push(`Жара −${d.toFixed(1)}/с · защита ${Math.round(g.thermal * 100)} %`);
      }
      if (parts.length) chip = { icon: wb.kind !== 'clear' ? WEATHER[wb.kind].icon : '♨', text: parts.join(' '), level: dps > 0.5 ? 2 : dps > 0.05 || wb.kind === 'storm' ? 1 : 0 };
      // a Geiger counter ticks in a radiation storm
      if (rad && dps > 0) {
        this.geigerT -= dt * (2 + dps * 6);
        if (this.geigerT <= 0) { this.geigerT = Math.random(); this.sfx.click(); }
      }
    }
    this.hud.weatherChip(chip);
    let fc: string | null = null;
    if (np && this.nearAlt < np.radius * 0.8) {
      const wb = this.wxBody;
      const ov = this.wxOverrides.get(np.index);
      if (wb.kind !== 'clear' && wb.k > 0) fc = `${WEATHER[wb.kind].icon} ${WEATHER[wb.kind].name}${ov && now < ov.until ? '' : this.untilText(forecast(np, now))}`;
      else {
        const f = forecast(np, now);
        fc = f ? `ясно · ${WEATHER[STORM_OF[np.type]].name.toLowerCase()} через ${this.mmss(f.inSec)}` : 'ясно';
      }
    }
    this.hud.forecast(fc);
  }

  private untilText(f: ReturnType<typeof forecast>) {
    return f && f.active ? ` · стихнет через ${this.mmss(f.inSec)}` : '';
  }

  private mmss(s: number) {
    const t = Math.max(0, Math.round(s));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  }

  /** Is the camera inside a wreck's hull? Eases `indoorK` and places the wreck's lights. */
  private updateIndoor(np: PlanetDef | null) {
    const [lamp0, lamp1] = this.wreckLights;
    const mode = this.pred.mode;
    this.indoorStation = mode === MODE.DOCKED || mode === MODE.DECK;
    if (this.indoorStation && this.interior && this.sys) {
      // the same two lamps light the hangar and the promenade
      this.indoorK = 1;
      const st = this.sys.station.pos;
      const put = (l: THREE.PointLight, x: number, y: number, z: number) => {
        const w = this.interior!.toWorld(st, v3(x, y, z), v3());
        l.position.set(w.x - this.origin.x, w.y - this.origin.y, w.z - this.origin.z);
      };
      // both hang in the room the camera is in: over the pad in the hangar, along the promenade's length
      const cz = this.interior.toDeck(st, this.origin).z;
      if (cz < -60) { put(lamp0, -10, 12, -92); put(lamp1, 12, 10, -90); }
      else { put(lamp0, 0, 4, -24); put(lamp1, 0, 4, 12); }
      lamp0.color.set('#fff2dc'); lamp1.color.set('#f4f6ff');
      lamp0.distance = lamp1.distance = 80;
      lamp0.intensity = lamp1.intensity = cz < -60 ? 110 : 70;
      return;
    }
    lamp0.color.set('#6aff5a'); lamp1.color.set('#ff3a2a');
    lamp0.distance = 30; lamp1.distance = 24;
    let hit: { pl: PlanetDef; site: SiteDef; zone: string | null } | null = null;
    if (np && this.nearAlt < 300) {
      const camB = toBodyPoint(np, this.rots[np.index], this.origin, v3());
      const w = wreckAt(np, camB);
      if (w && vlen(camB) < w.roof) hit = { pl: np, site: w.site, zone: wreckZone(w.site, w.x, w.z) };
    }
    this.indoorK += ((hit ? 1 : 0) - this.indoorK) * 0.25;
    if (this.indoorK < 0.01) this.indoorK = 0;
    const [green, red] = this.wreckLights;
    if (!hit || this.indoorK <= 0) { green.intensity = 0; red.intensity = 0; return; }
    const { pl, site } = hit;
    const R = this.rots[pl.index];
    const put = (l: THREE.PointLight, x: number, z: number, lift: number) => {
      const d = siteDir(pl, site, x, z);
      const r = pl.radius + site.h + lift;
      const w = toWorldPoint(pl, R, v3(d.x * r, d.y * r, d.z * r), v3());
      l.position.set(w.x - this.origin.x, w.y - this.origin.y, w.z - this.origin.z);
    };
    put(green, -26, 0, 3.5);
    green.intensity = 60 * this.indoorK;
    // the red lamp hangs over the middle of the room the camera is in
    const zn = site.zones?.find((z) => z.kind === hit!.zone) ?? site.zones![2];
    put(red, (zn.x0 + zn.x1) / 2, (zn.z0 + zn.z1) / 2, 5.5);
    red.intensity = (hit.zone === 'rad' ? 6 : 14) * this.indoorK;
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
    this.dayNow = day;

    // inside a wrecked hull: daylight only through the breaches, emergency lamps and the reactor glow
    this.updateIndoor(np);
    const ik = this.indoorK;
    if (ik > 0 && this.indoorStation) {
      // the station is lit by its own lamps; daylight only through the windows
      this.sunLight.intensity *= 1 - 0.55 * ik;
      this.hemi.color.lerp(new THREE.Color('#dfe6f2'), 0.6 * ik);
      this.hemi.groundColor.lerp(new THREE.Color('#4a4e58'), 0.6 * ik);
    } else if (ik > 0) {
      this.sunLight.intensity *= 1 - 0.9 * ik;
      this.hemi.intensity *= 1 - 0.7 * ik;
      this.fill.intensity *= 1 - 0.8 * ik;
      if (this.r.scene.environment) this.r.scene.environmentIntensity *= 1 - 0.8 * ik;
    }

    // storms: shorter visibility tinted by the storm, darker sky and sun, lightning flashes
    const wk = this.wx.k;
    if (np?.atmo && wk > 0 && this.wx.kind !== 'clear') {
      const def = WEATHER[this.wx.kind];
      const tint = new THREE.Color(def.color).multiplyScalar(0.12 + 0.88 * day);
      if (def.visibility > 0) {
        const far = THREE.MathUtils.lerp(Math.min(fog.far, 14000), def.visibility, wk);
        fog.far = Math.min(fog.far, far);
        fog.near = Math.min(fog.near, far * 0.03);
        fog.color.lerp(tint, 0.7 * wk);
      }
      const dim = this.wx.kind === 'radiation' ? 0 : (this.wx.kind === 'storm' ? 0.78 : 0.6) * wk;
      this.sunLight.intensity *= 1 - dim;
      u.zen.value.lerp(tint, 0.8 * wk);
      u.hor.value.lerp(tint, 0.85 * wk);
      this.r.scene.backgroundIntensity *= 1 - 0.5 * wk;
      this.hemi.color.lerp(tint, 0.4 * wk);
      if (this.wx.kind === 'storm') this.hemi.intensity *= 1 - 0.35 * wk;
      if (this.r.scene.environment) this.r.scene.environmentIntensity *= 1 - 0.5 * wk;
    }
    if (np?.atmo === null && this.wx.kind === 'radiation' && this.wxBody.k > 0) {
      // radiation storm on an airless world: a sickly green shimmer over everything
      this.hemi.color.lerp(new THREE.Color('#9aff6a'), 0.25 * this.wxBody.k);
    }
    if (this.weatherV.flash > 0) {
      this.hemi.intensity += this.weatherV.flash * 3;
      this.r.scene.backgroundIntensity = Math.min(1, this.r.scene.backgroundIntensity + this.weatherV.flash * 0.5);
    }

    // under the sea: short turquoise visibility, dimmer and bluer light with depth
    const wet = this.camUnder && np ? np : null;
    this.r.setUnderwater(wet ? 1 : 0, this.time);
    this.sfx.underwater(!!wet);
    if (wet) {
      const [sh, dp] = waterColors(wet);
      const dk = THREE.MathUtils.smoothstep(this.camDepth, 0, 45);
      const light = (0.1 + 0.9 * day) * (0.55 + 0.45 * Math.exp(-this.camDepth * 0.02));
      const wc = new THREE.Color(sh[0], sh[1], sh[2]).lerp(new THREE.Color(dp[0], dp[1], dp[2]), 0.25 + 0.5 * dk).multiplyScalar(light * 0.85);
      const clear = wet.type === 'ocean' ? 58 : wet.type === 'alien' ? 40 : 48;
      fog.color.copy(wc);
      fog.near = 0.5;
      fog.far = clear * (1 - 0.45 * dk);
      u.zen.value.copy(wc); u.hor.value.copy(wc); u.ground.value.copy(wc);
      u.sunC.value.setRGB(0, 0, 0);
      u.alpha.value = 1;
      u.day.value = 1;
      this.r.scene.backgroundIntensity = 0;
      this.hemi.color.copy(wc).multiplyScalar(2.8);
      this.hemi.groundColor.copy(wc).multiplyScalar(0.5);
      this.sunLight.intensity *= Math.exp(-this.camDepth * 0.03);
      this.sunLight.color.lerp(new THREE.Color(sh[0], sh[1], sh[2]).multiplyScalar(1.6), 0.45);
      this.r.scene.environmentIntensity *= 0.5;
      const cup = new THREE.Vector3(this.origin.x - wet.center.x, this.origin.y - wet.center.y, this.origin.z - wet.center.z);
      this.underwater.update(1 / 60, true, cup, cup.clone().normalize(), this.camDepth, new THREE.Vector3(toSun.x, toSun.y, toSun.z), day, wc.clone().multiplyScalar(1 / Math.max(0.05, light * 0.85)), this.time);
    } else this.underwater.update(0, false, new THREE.Vector3(), new THREE.Vector3(0, 1, 0), 0, new THREE.Vector3(), day, new THREE.Color(), this.time);
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
    // distances from the pilot on foot, from the hangar's camera while docked
    const me = mode === MODE.FOOT || mode === MODE.DECK ? this.charPos : mode === MODE.DOCKED ? this.rig.pos : this.shipPos;
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
      if (n.site) this.toWorld(n.site.planet + 1, n.site.p, n.pos);
    }
    const items = this.navItems.map((n) => ({ name: n.name, dist: this.fmtDist(Math.max(0, vdist(n.pos, me) - (n.kind === 'planet' || n.kind === 'goal' ? n.radius : 0))) }));
    this.hud.navList(items, this.navIndex);
    const nav = this.navItems[this.navIndex];
    if (nav && mode !== MODE.DOCKED && mode !== MODE.DECK) {
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
    const seenAllies = new Set<number>();
    for (const [id, r] of this.remotes) {
      if (!r.visible || !r.info) continue;
      const d = vdist(r.p, me);
      const c = rel(r.p);
      if (r.info.kind === KIND.MISSILE) { blips.push({ x: c.x, y: c.y, z: c.z, kind: 'missile' }); continue; }
      if (r.info.kind === KIND.LOOT) { blips.push({ x: c.x, y: c.y, z: c.z, kind: 'loot' }); continue; }
      if (r.info.kind === KIND.CREATURE) {
        const dead = !!r.state && !!(r.state.flags & EFLAG.DEAD);
        const k = mode === MODE.FOOT ? 20 : 1;
        if (!dead) blips.push({ x: c.x * k, y: 0, z: c.z * k, kind: r.info.npc ? 'npc' : 'fauna' });
        if (d < 90 && mode === MODE.FOOT) {
          const sp = this.project(v3(r.p.x, r.p.y, r.p.z));
          if (!sp.behind) labels.push({ id, x: sp.x, y: sp.y - 40, text: dead ? `${r.info.name} · ${SPECIES[r.info.species ?? 0]?.drone ? 'сбит' : 'туша'}` : r.info.name, sub: this.fmtDist(d), npc: !!r.info.npc, hull: r.state?.hull ?? 1 });
        }
        continue;
      }
      const ally = !!r.info.owner && this.allies.has(r.info.owner);
      if (ally) seenAllies.add(r.info.owner!);
      blips.push({ x: c.x, y: c.y, z: c.z, kind: r.info.npc ? 'npc' : ally ? 'ally' : 'player', sel: id === this.targetId });
      if (d < 4000 && (mode !== MODE.DOCKED || r.info.kind === KIND.CHAR)) {
        const sp = this.project(v3(r.p.x, r.p.y, r.p.z));
        const said = r.info.kind === KIND.CHAR ? this.bubbles.get(r.info.name) : undefined;
        const bubble = said && said.until > this.time && d < 60 ? said.text : undefined;
        if (!sp.behind) labels.push({ id, x: sp.x, y: sp.y - (r.info.kind === KIND.CHAR ? 46 : 18), text: r.info.wanted ? `${r.info.name} · РАЗЫСКИВАЕТСЯ` : r.info.name, sub: this.fmtDist(d), npc: !ally && (!!r.info.npc || !!r.info.wanted), hull: r.state?.hull ?? 1, bubble, ally });
      }
    }
    // group mates out of view: where the server last saw them
    for (const m of this.group.members) {
      if (!this.allies.has(m.id) || seenAllies.has(m.id) || !m.pos || m.system !== sys.id) continue;
      const ac = rel(v3(m.pos[0], m.pos[1], m.pos[2]));
      blips.push({ x: ac.x, y: ac.y, z: ac.z, kind: 'ally' });
    }
    for (const p of this.pois) { const pc = rel(v3(p.pos[0], p.pos[1], p.pos[2])); blips.push({ x: pc.x, y: pc.y, z: pc.z, kind: 'poi' }); }
    for (const n of this.navItems) if (n.kind === 'goal') { const gc = rel(n.pos); blips.push({ x: gc.x, y: gc.y, z: gc.z, kind: 'goal' }); }
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
        const goal = !!this.pilot?.career.active.some((c) => c.system === this.sys?.id && c.planet === np.index && c.site === s.id);
        labels.push({ id: -1000 - np.index * 32 - k, x: sp.x, y: sp.y, text: goal ? `◆ ${s.name}` : s.name, sub: this.fmtDist(d), npc: s.kind === 'base', hull: 1, site: true, goal });
      });
    }
    this.hud.setLabels(labels);
    this.radar.draw(blips);

    this.hud.clock(this.localClock());
    const air = this.pred.char?.air ?? 1;
    this.hud.suit(mode === MODE.FOOT ? self.suit : null, air);
    if (mode === MODE.FOOT && air < 0.25 && this.lastAir >= 0.25) this.hud.toast('Кончается воздух — всплывайте!', 'warn');
    this.lastAir = air;

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
      const carcass = this.nearCarcass();
      if (this.nearLog()) prompt = '<kbd>F</kbd> бортовой журнал';
      else if (carcass) prompt = carcass.drone ? '<kbd>F</kbd> разобрать дрона' : `<kbd>F</kbd> взять биообразцы: ${carcass.name}`;
      else if (n) prompt = `<kbd>F</kbd> собрать: ${RESOURCE_NAMES[n.type]}`;
      else if (ship.frame === this.pred.charPlanet + 1 && vdist(this.charPosB, ship.p) < EXIT_RANGE + 6) prompt = '<kbd>G</kbd> сесть в корабль';
    } else if (mode === MODE.DECK && this.pred.char) {
      const c = this.pred.char.p;
      const t = nearTerminal(c);
      if (t) prompt = `<kbd>F</kbd> ${t.name}`;
      else if (Math.hypot(c.x - PAD.x, c.z - PAD.z) < BOARD_REACH) prompt = '<kbd>G</kbd> сесть в корабль';
    }
    this.hud.prompt(prompt);
  }
}
