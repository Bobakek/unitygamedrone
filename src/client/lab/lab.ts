import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MOOD, SPECIES as ALL_SPECIES, type Species } from '../../shared/fauna.ts';

/** Animals only: the guard drones of wrecks have no rig to show here. */
const SPECIES = ALL_SPECIES.filter((s) => !s.drone);
import { CLIMB_TIME, VAULT_TIME } from '../../shared/sim/character.ts';
import { QUALITY } from '../core/quality.ts';
import { Renderer } from '../core/renderer.ts';
import { AstronautView, type AnimInput } from '../entities/astronaut.ts';
import { CreatureView, type CreatureAnim } from '../entities/creature.ts';
import { ITEMS, lookCode, parseLook, SLOT_NAMES, SLOTS, type Outfit } from '../../shared/outfit.ts';

/**
 * Animation lab: a small outdoor set where the pilot and every creature
 * species can be played clip by clip (locomotion in all directions, jumps,
 * vaulting and climbing over obstacles, swimming and diving, aiming and
 * firing, harvesting, hit reactions, grazing, gaits, attacks...), slowed down
 * or frozen, and laid out as contact sheets for review. Swimmers and sea
 * creatures play in a pool. Reachable from the login screen or `?lab`.
 */

type PilotCtx = { t: number; dt: number; view: AstronautView; obj: THREE.Object3D; ev: (every: number, fn: () => void) => void };
interface PilotClip { id: string; label: string; period?: number; course?: 'vault' | 'climb' | 'slope'; pool?: boolean; drive: (c: PilotCtx) => Partial<AnimInput> }
type CreatureCtx = { t: number; view: CreatureView; sp: Species; ev: (every: number, fn: () => void) => void };
interface CreatureClip { id: string; label: string; drive: (c: CreatureCtx) => Partial<CreatureAnim> }

const G = 9.8;
/** Height of the pool's water surface above the lab floor; sea creatures float at SEA_Y. */
const POOL_Y = 5;
const SEA_Y = 2.2;
/** What the lab pilot wears (panel selectors / `?outfit=`), and whether the visor is up. */
let OUTFIT: Outfit = parseLook(new URLSearchParams(location.search).get('outfit') ?? '');
let VISOR_UP = new URLSearchParams(location.search).get('visor') === '1' ? 1 : 0;

/** Scripted run-up and traversal over an obstacle (mirrors the shared character sim's timings). */
function course(kind: 'vault' | 'climb', t: number): { z: number; y: number; inp: Partial<AnimInput> } {
  const vault = kind === 'vault';
  const height = vault ? 1.1 : 2.5, r = vault ? 0.8 : 0.6;
  const runSpeed = vault ? 6 : 3;
  const startZ = 7, faceZ = r + 0.35 + 0.3;
  const tRun = (startZ - faceZ) / runSpeed;
  const T = vault ? VAULT_TIME : CLIMB_TIME, rise = vault ? 0.22 : 0.65;
  const dist = 0.3 + 2 * r + 0.7 + 0.4;
  const fwd = dist / (vault ? T : 0.15 * rise + (T - rise));
  if (t < tRun) return { z: startZ - runSpeed * t, y: 0, inp: { speed: runSpeed, fwd: runSpeed, ground: true } };
  const tc = t - tRun;
  const z0 = faceZ;
  if (tc < T) {
    const tr = Math.min(tc, rise);
    const zRise = z0 - (vault ? fwd : fwd * 0.15) * tr;
    const z = tc < rise ? zRise : zRise - fwd * (tc - rise);
    const y = ((height + 0.3) / rise) * tr;
    return { z, y, inp: { speed: fwd, fwd, ground: false, climb: { mode: vault ? 1 : 2, t: tc / T } } };
  }
  // drop down on the far side, then walk out
  const ta = tc - T;
  const zEnd = z0 - (vault ? fwd * T : fwd * (0.15 * rise + T - rise));
  const yTop = height + 0.3;
  const tFall = Math.sqrt((2 * yTop) / G);
  if (ta < tFall) return { z: zEnd - fwd * 0.6 * ta, y: yTop - 0.5 * G * ta * ta, inp: { speed: fwd * 0.6, fwd: fwd * 0.6, vUp: -G * ta, ground: false } };
  const tw = ta - tFall;
  return { z: zEnd - fwd * 0.6 * tFall - 2.5 * tw, y: 0, inp: { speed: 2.5, fwd: 2.5, ground: true } };
}

const PILOT_CLIPS: PilotClip[] = [
  { id: 'idle', label: 'Покой', drive: () => ({}) },
  { id: 'walk', label: 'Шаг', drive: () => ({ fwd: 2.5 }) },
  { id: 'run', label: 'Бег', drive: () => ({ fwd: 8.6 }) },
  { id: 'back', label: 'Назад', drive: () => ({ fwd: -3.2 }) },
  { id: 'strafeL', label: 'Бег влево', drive: () => ({ side: -4.6 }) },
  { id: 'strafeR', label: 'Бег вправо', drive: () => ({ side: 4.6 }) },
  { id: 'diag', label: 'Диагональ', drive: () => ({ fwd: 3.4, side: 3.4 }) },
  { id: 'turn', label: 'Поворот', drive: () => ({ turn: 1.8 }) },
  {
    id: 'jump', label: 'Прыжок', period: 1.7, drive: ({ t, obj }) => {
      const ta = t - 0.25;
      if (ta < 0 || ta > 1.12) { obj.position.y = 0; return { ground: true }; }
      obj.position.y = 5.5 * ta - 0.5 * G * ta * ta;
      return { ground: false, vUp: 5.5 - G * ta };
    },
  },
  { id: 'jet', label: 'Джетпак', drive: ({ t, obj }) => { obj.position.y = 1.5 + Math.sin(t * 1.5) * 0.3; return { ground: false, jet: true, vUp: 0.5, fwd: 1.5 }; } },
  { id: 'vault', label: 'Перепрыгнуть', period: 3.2, course: 'vault', drive: () => ({}) },
  { id: 'climb', label: 'Залезть', period: 4.2, course: 'climb', drive: () => ({}) },
  { id: 'scramble', label: 'Карабкаться', period: 5, course: 'slope', drive: () => ({ fwd: 2.2, scramble: true }) },
  { id: 'aim', label: 'Прицел', drive: () => ({ aim: true }) },
  { id: 'aimStrafe', label: 'Прицел + вбок', drive: () => ({ aim: true, side: 3 }) },
  { id: 'shoot', label: 'Стрельба', drive: ({ view, ev }) => { ev(0.24, () => view.fire()); return { aim: true }; } },
  { id: 'shootRun', label: 'Стрельба на бегу', drive: ({ view, ev }) => { ev(0.24, () => view.fire()); return { aim: true, fwd: 4.5 }; } },
  { id: 'harvest', label: 'Добыча', drive: ({ view, ev, obj }) => { ev(1.4, () => view.harvest(new THREE.Vector3(obj.position.x - 0.3, obj.position.y + 0.2, obj.position.z - 1.3))); return {}; } },
  { id: 'hurt', label: 'Ранение', drive: ({ view, ev }) => { ev(1.0, () => view.hurt(1)); return {}; } },
  { id: 'fidget', label: 'Жесты', drive: ({ view, ev }) => { let k = 0; ev(3, () => view.playFidget(k++ % 3)); return {}; } },
  { id: 'tread', label: 'На воде', pool: true, drive: ({ obj }) => { obj.position.y = POOL_Y - 1.2; return { ground: false, swim: 1 }; } },
  { id: 'crawl', label: 'Плыть', pool: true, drive: ({ obj }) => { obj.position.y = POOL_Y - 1.2; return { ground: false, swim: 1, fwd: 2.6 }; } },
  { id: 'underSwim', label: 'Под водой', pool: true, drive: ({ obj }) => { obj.position.y = POOL_Y - 3.6; return { ground: false, swim: 2, fwd: 2.6 }; } },
  { id: 'dive', label: 'Нырок', pool: true, drive: ({ obj }) => { obj.position.y = POOL_Y - 3.2; return { ground: false, swim: 2, fwd: 2, vUp: -1.6, swimPitch: -0.65 }; } },
  { id: 'hover', label: 'Зависнуть', pool: true, drive: ({ obj }) => { obj.position.y = POOL_Y - 3.4; return { ground: false, swim: 2 }; } },
  { id: 'aimSwim', label: 'Прицел в воде', pool: true, drive: ({ obj }) => { obj.position.y = POOL_Y - 3.4; return { ground: false, swim: 2, aim: true }; } },
];

const CREATURE_CLIPS: CreatureClip[] = [
  { id: 'graze', label: 'Пасётся', drive: () => ({ mood: MOOD.graze }) },
  { id: 'walk', label: 'Шаг', drive: ({ sp }) => ({ speed: sp.walk, mood: MOOD.wander }) },
  { id: 'trot', label: 'Рысь', drive: ({ sp }) => ({ speed: Math.min(sp.run * 0.5, sp.walk * 2.4), mood: MOOD.wander }) },
  { id: 'run', label: 'Бег', drive: ({ sp }) => ({ speed: sp.run, mood: MOOD.flee }) },
  { id: 'turn', label: 'Поворот', drive: () => ({ turn: 1.6, mood: MOOD.wander }) },
  { id: 'alert', label: 'Настороже', drive: () => ({ mood: MOOD.alert }) },
  { id: 'rest', label: 'Отдых', drive: () => ({ mood: MOOD.rest }) },
  { id: 'attack', label: 'Атака', drive: ({ view, ev }) => { ev(1.3, () => view.attack()); return { mood: MOOD.hunt }; } },
  { id: 'roar', label: 'Рык', drive: ({ view, ev }) => { ev(2.2, () => view.roar()); return { mood: MOOD.hunt }; } },
  { id: 'hit', label: 'Попадание', drive: ({ view, ev }) => { ev(0.9, () => view.hit()); return { mood: MOOD.flee }; } },
  { id: 'dead', label: 'Гибель', drive: () => ({ dead: true }) },
];

/** Plays one clip on one subject; `advance` steps it (treadmill clips report ground velocity). */
class Actor {
  readonly obj = new THREE.Group();
  private t = 0;
  private next = new Map<number, number>();
  private pilot: AstronautView | null = null;
  private beast: CreatureView | null = null;
  vel = new THREE.Vector3();
  /** Rifle pitch for aiming clips (slider). */
  aimPitch = 0;

  constructor(readonly subject: 'pilot' | Species, private clip: PilotClip | CreatureClip, private outfit: Outfit = OUTFIT) {
    this.rebuild();
  }

  private rebuild() {
    this.pilot?.dispose();
    this.beast?.dispose();
    this.pilot = this.beast = null;
    if (this.subject === 'pilot') { this.pilot = new AstronautView(this.outfit, 'NOVA'); this.obj.add(this.pilot.group); }
    else {
      this.beast = new CreatureView(this.subject);
      this.obj.add(this.beast.group);
      // sea creatures swim in the pool
      if (this.subject.aquatic) this.beast.group.position.y = SEA_Y;
    }
    this.t = 0;
    this.next.clear();
  }

  setClip(c: PilotClip | CreatureClip) {
    this.clip = c;
    this.obj.position.set(0, 0, 0);
    this.rebuild();
  }

  get clipDef() { return this.clip; }

  advance(dt: number) {
    const period = (this.clip as PilotClip).period;
    this.t += dt;
    if (period && this.t > period) { this.t -= period; this.next.clear(); }
    if (this.beast && this.clip.id === 'dead' && this.t > 4) this.rebuild();
    let slot = 0;
    const ev = (every: number, fn: () => void) => {
      const k = slot++;
      const due = this.next.get(k) ?? 0.2;
      if (this.t >= due) { fn(); this.next.set(k, this.t + every); }
    };
    if (this.pilot) {
      const c = this.clip as PilotClip;
      let inp: Partial<AnimInput>;
      if (c.course === 'vault' || c.course === 'climb') {
        const k = course(c.course, this.t);
        this.obj.position.set(0, k.y, k.z);
        inp = k.inp;
      } else if (c.course === 'slope') {
        // 45° ramp along -Z
        const z = 6 - ((this.t * 2.2) % 12) / Math.SQRT2;
        this.obj.position.set(0, Math.max(0, 6 - z), z);
        inp = c.drive({ t: this.t, dt, view: this.pilot, obj: this.obj, ev });
      } else inp = c.drive({ t: this.t, dt, view: this.pilot, obj: this.obj, ev });
      const fwd = inp.fwd ?? 0, side = inp.side ?? 0;
      this.vel.set(c.course ? 0 : side, 0, c.course ? 0 : -fwd);
      this.pilot.visorUp = VISOR_UP;
      this.pilot.lightsOn = VISOR_UP > 0;
      this.pilot.update(dt, {
        speed: Math.hypot(fwd, side), fwd, side, vUp: 0, ground: true, jet: false, look: this.aimPitch, turn: 0, aimPitch: this.aimPitch, ...inp,
      });
    } else if (this.beast) {
      const inp = (this.clip as CreatureClip).drive({ t: this.t, view: this.beast, sp: this.subject as Species, ev });
      this.vel.set(0, 0, -(inp.speed ?? 0));
      if (inp.turn) this.obj.rotation.y += inp.turn * dt;
      this.beast.update(dt, { speed: 0, turn: 0, mood: MOOD.graze, dead: false, ...inp });
    }
  }

  dispose() {
    this.pilot?.dispose();
    this.beast?.dispose();
    this.obj.removeFromParent();
  }
}

function gridTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#5d6b52';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 400; i++) {
    g.fillStyle = `rgba(${40 + Math.random() * 40},${60 + Math.random() * 40},${35 + Math.random() * 30},0.35)`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 6 + Math.random() * 10, 6 + Math.random() * 10);
  }
  g.strokeStyle = 'rgba(255,255,255,0.22)';
  g.lineWidth = 2;
  g.strokeRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.repeat.set(20, 20);
  return t;
}

export function startLab(canvas: HTMLCanvasElement) {
  const params = new URLSearchParams(location.search);
  const r = new Renderer(canvas, { ...QUALITY.high, pixelRatio: 1 });
  const scene = r.scene;
  scene.background = new THREE.Color('#9fc4e8');
  scene.fog = new THREE.Fog('#9fc4e8', 40, 140);
  const hemi = new THREE.HemisphereLight('#dfefff', '#4a4a3a', 1.4);
  const sun = new THREE.DirectionalLight('#fff2dc', 2.4);
  sun.position.set(-8, 14, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 60 });
  sun.shadow.bias = -0.0004;
  scene.add(hemi, sun, sun.target);
  // reflections for visors and metal rings (as the game's sky environment gives)
  const pmrem = new THREE.PMREMGenerator(r.gl);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  const tex = gridTexture();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
  ground.receiveShadow = true;
  scene.add(ground);
  // props for the traversal courses
  const stone = new THREE.MeshStandardMaterial({ color: '#8c8279', flatShading: true, roughness: 0.9 });
  const block = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.1, 1.6).translate(0, 0.55, 0), stone);
  const wall = new THREE.Mesh(new THREE.BoxGeometry(4, 2.5, 1.2).translate(0, 1.25, 0), new THREE.MeshStandardMaterial({ color: '#5a4a5e', flatShading: true, roughness: 0.7 }));
  const ramp = new THREE.Mesh(new THREE.BoxGeometry(4, 0.4, 12).rotateX(Math.PI / 4).translate(0, 3.8, 1.9), new THREE.MeshStandardMaterial({ color: '#a89a86', flatShading: true, roughness: 0.9, side: THREE.DoubleSide }));
  for (const m of [block, wall, ramp]) { m.castShadow = m.receiveShadow = true; m.visible = false; scene.add(m); }
  // the pool: a sandy floor patch under a see-through water surface
  const pool = new THREE.Group();
  const sand = new THREE.Mesh(new THREE.CircleGeometry(26, 40).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#d8c48e', roughness: 1 }));
  sand.position.y = 0.01;
  sand.receiveShadow = true;
  const surf = new THREE.Mesh(new THREE.CircleGeometry(26, 40).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#3ab4c8', roughness: 0.08, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false }));
  surf.position.y = POOL_Y;
  const vol = new THREE.Mesh(new THREE.CylinderGeometry(26, 26, POOL_Y, 40, 1, true).translate(0, POOL_Y / 2, 0), new THREE.MeshBasicMaterial({ color: '#2a8aa8', transparent: true, opacity: 0.12, side: THREE.BackSide, depthWrite: false }));
  pool.add(sand, surf, vol);
  pool.visible = false;
  scene.add(pool);

  const cam = r.camera;
  cam.position.set(4.5, 2.6, 5.5);
  const controls = new OrbitControls(cam, canvas);
  controls.target.set(0, 1, 0);
  controls.enableDamping = true;
  controls.update();

  // ---------------------------------------------------------------- UI
  const ui = document.createElement('div');
  ui.id = 'lab';
  ui.innerHTML = `
    <div class="panel lab-panel">
      <h2>Лаборатория анимаций</h2>
      <div class="lab-sec">Персонаж</div><div class="lab-row" id="lab-subjects"></div>
      <div class="lab-sec">Анимация</div><div class="lab-row" id="lab-clips"></div>
      <div class="lab-sec">Наряд пилота</div><div class="lab-row lab-outfit" id="lab-outfit"></div>
      <label class="lab-sl">Скорость воспроизведения <input type="range" id="lab-speed" min="0.1" max="2" step="0.05" value="1"><b id="lab-speed-v">1.0×</b></label>
      <label class="lab-sl">Наклон прицела <input type="range" id="lab-pitch" min="-1" max="1" step="0.05" value="0"></label>
      <div class="lab-row"><button id="lab-pause">Пауза</button><button id="lab-step">Кадр →</button><button id="lab-sheet">Сетка кадров</button><button id="lab-exit">Выход</button></div>
      <p class="lab-hint">Мышь: вращать камеру, колесо: приблизить. Все существа идут строем при выборе «Все существа».</p>
    </div>
    <div id="lab-labels"></div>`;
  document.body.appendChild(ui);
  const $ = (id: string) => document.getElementById(id)!;
  const labels = $('lab-labels');

  let actors: Actor[] = [];
  let subject: 'pilot' | 'all' | number = 'pilot';
  let clipId = 'walk';
  let paused = false;
  let rate = 1;
  let pitch = 0;
  let sheet = false;

  const clipsFor = (s: typeof subject) => (s === 'pilot' ? PILOT_CLIPS : CREATURE_CLIPS);
  const renderButtons = () => {
    const subs = $('lab-subjects');
    subs.innerHTML = '';
    const opts: [typeof subject, string][] = [['pilot', 'Пилот'], ...SPECIES.map((s, i) => [i, s.name] as [number, string]), ['all', 'Все существа']];
    for (const [id, label] of opts) {
      const b = document.createElement('button');
      b.textContent = label;
      b.classList.toggle('on', id === subject);
      b.onclick = () => { subject = id; if (!clipsFor(subject).some((c) => c.id === clipId)) clipId = clipsFor(subject)[1].id; sheet = false; build(); };
      subs.appendChild(b);
    }
    const cl = $('lab-clips');
    cl.innerHTML = '';
    for (const c of clipsFor(subject)) {
      const b = document.createElement('button');
      b.textContent = c.label;
      b.dataset.clip = c.id;
      b.classList.toggle('on', c.id === clipId && !sheet);
      b.onclick = () => { clipId = c.id; sheet = false; build(); };
      cl.appendChild(b);
    }
  };

  const clear = () => {
    for (const a of actors) a.dispose();
    actors = [];
    labels.innerHTML = '';
  };
  const label = (a: Actor, text: string) => {
    const d = document.createElement('div');
    d.className = 'lab-label';
    d.textContent = text;
    labels.appendChild(d);
    (a as Actor & { label?: HTMLElement }).label = d;
  };

  /** Normal mode: one subject (or the whole bestiary in a row) playing the chosen clip. */
  function build() {
    clear();
    const clips = clipsFor(subject);
    const clip = clips.find((c) => c.id === clipId) ?? clips[0];
    const course = (clip as PilotClip).course;
    block.visible = course === 'vault';
    wall.visible = course === 'climb';
    ramp.visible = course === 'slope';
    const swimClip = !!(clip as PilotClip).pool;
    pool.visible = swimClip || subject === 'all' || (typeof subject === 'number' && !!SPECIES[subject].aquatic);
    if (subject === 'all') {
      SPECIES.forEach((sp, i) => {
        const a = new Actor(sp, clip);
        a.obj.position.x = (i - (SPECIES.length - 1) / 2) * 3.6;
        scene.add(a.obj);
        actors.push(a);
        label(a, sp.name);
      });
      controls.target.set(0, 1, 0);
      cam.position.set(8, 6, -15);
    } else {
      const a = new Actor(subject === 'pilot' ? 'pilot' : SPECIES[subject], clip);
      scene.add(a.obj);
      actors.push(a);
      // pilots and animals face -Z: look at them from the front-right (courses: from the side)
      if (course === 'slope') { controls.target.set(0, 2.4, 3.4); cam.position.set(6.5, 6.8, 6.2); }
      else if (course) { controls.target.set(0, 1.4, 1.6); cam.position.set(6.2, 2.4, 0.6); }
      else if (swimClip) { const y = (clip.id === 'tread' || clip.id === 'crawl' ? POOL_Y - 0.4 : POOL_Y - 2.8); controls.target.set(0, y, 0); cam.position.set(3.4, y + 0.9, -3.6); }
      else if (typeof subject === 'number' && SPECIES[subject].aquatic) { controls.target.set(0, SEA_Y, 0); cam.position.set(3.2, SEA_Y + 1.2, -4.2); }
      else { controls.target.set(0, 0.95, 0); cam.position.set(2.4, 1.5, -3.1); }
    }
    controls.update();
    renderButtons();
  }

  /** Frames the camera (from the front-left, above) on a rectangle of the set. */
  function frameBox(w: number, d: number, cz: number) {
    const dist = Math.max(w * 0.62, d * 0.8) + 3;
    controls.target.set(0, 0.2, cz);
    cam.position.set(dist * 0.18, dist * 0.55, cz - dist * 0.85);
    controls.update();
  }

  /** Contact sheet: clips laid out as strips of frozen phases, labelled, framed for one screenshot. */
  function buildSheet(kind: 'pilot' | 'creatures' | 'outfits', from = 0, to = 99) {
    clear();
    sheet = true;
    block.visible = wall.visible = ramp.visible = false;
    pool.visible = false;
    const dt = 1 / 60;
    const turnToCam = 0.55;
    if (kind === 'outfits') {
      // every suit part on a pilot otherwise in the starter kit, a row per slot
      const idle = PILOT_CLIPS[0];
      const colW = 1.2, rowD = 2.4;
      // page 0: suit, helmet, visor; page 1: backpack, chest, lights, patch
      const rows = from > 0 ? SLOTS.slice(3) : SLOTS.slice(0, 3);
      const perRow = Math.max(...rows.map((sl) => ITEMS.filter((i) => i.slot === sl).length));
      rows.forEach((sl, row) => {
        ITEMS.filter((i) => i.slot === sl).forEach((it, col) => {
          const a = new Actor('pilot', idle, { ...parseLook(''), [sl]: it.id });
          for (let t = 0; t < 1.3; t += dt) a.advance(dt);
          a.obj.position.x = -(col - (perRow - 1) / 2) * colW;
          a.obj.position.z = (row - (rows.length - 1) / 2) * rowD;
          // backpacks are shown from behind, patches from the right shoulder
          a.obj.rotation.y = sl === 'pack' ? Math.PI - 0.35 : sl === 'patch' ? Math.PI / 2 + 0.25 : 0.35;
          scene.add(a.obj);
          actors.push(a);
          label(a, it.name);
        });
      });
      frameBox(perRow * colW, rows.length * rowD, 0);
    } else if (kind === 'pilot') {
      const clips = PILOT_CLIPS.filter((c) => !c.course).slice(from, to + 1);
      // swim clips are posed in mid-air on the sheet (no pool), each at its own height
      const swimY = (c: PilotClip) => (c.pool ? 1.2 : 0);
      const phases = [0.2, 0.5, 0.8];
      const cols = 3, rows = Math.ceil(clips.length / cols), stripW = 5.2, rowD = 4.4;
      clips.forEach((c, i) => {
        const col = i % cols, row = Math.floor(i / cols);
        phases.forEach((ph, k) => {
          const a = new Actor('pilot', c);
          for (let t = 0; t < 1.2 + ph * 1.3; t += dt) a.advance(dt);
          // camera looks along +Z, so screen-right is -X
          a.obj.position.x = -((col - (cols - 1) / 2) * stripW + (k - 1) * 1.35);
          a.obj.position.z = (row - (rows - 1) / 2) * rowD;
          if (c.pool) a.obj.position.y = swimY(c);
          a.obj.rotation.y = turnToCam;
          scene.add(a.obj);
          actors.push(a);
          if (k === 1) label(a, c.label);
        });
      });
      frameBox(cols * stripW, rows * rowD, 0);
    } else {
      const clips = CREATURE_CLIPS;
      const species = SPECIES.slice(from, Math.min(to, SPECIES.length - 1) + 1);
      // one block per species: its clips in rows of six
      const perRow = 6, colW = 3.6, rowD = 4.2;
      const rowsPer = Math.ceil(clips.length / perRow);
      species.forEach((sp, si) => {
        clips.forEach((c, ci) => {
          const col = ci % perRow, row = si * rowsPer + Math.floor(ci / perRow);
          const a = new Actor(sp, c);
          for (let t = 0; t < 1.6 + ci * 0.05; t += dt) a.advance(dt);
          a.obj.position.x = -(col - (perRow - 1) / 2) * colW;
          a.obj.position.z = (row - (species.length * rowsPer - 1) / 2) * rowD;
          a.obj.rotation.y = turnToCam;
          scene.add(a.obj);
          actors.push(a);
          label(a, ci === 0 ? `${sp.name}: ${c.label}` : c.label);
        });
      });
      frameBox(perRow * colW, species.length * rowsPer * rowD, 0);
    }
    renderButtons();
  }

  $('lab-speed').addEventListener('input', (e) => { rate = Number((e.target as HTMLInputElement).value); $('lab-speed-v').textContent = `${rate.toFixed(2)}×`; });
  $('lab-pitch').addEventListener('input', (e) => { pitch = Number((e.target as HTMLInputElement).value); });
  $('lab-pause').onclick = () => { paused = !paused; $('lab-pause').textContent = paused ? 'Дальше' : 'Пауза'; };
  $('lab-step').onclick = () => { paused = true; $('lab-pause').textContent = 'Дальше'; stepOnce = true; };
  $('lab-sheet').onclick = () => (sheet ? build() : buildSheet(subject === 'pilot' ? 'pilot' : 'creatures'));
  $('lab-exit').onclick = () => { location.search = ''; };
  let stepOnce = false;

  // ---------------------------------------------------------------- loop
  let last = performance.now();
  const proj = new THREE.Vector3();
  function frame() {
    requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!sheet && (!paused || stepOnce)) {
      const d = stepOnce ? 1 / 30 : dt * rate;
      stepOnce = false;
      for (const a of actors) {
        a.advance(d);
        // treadmill: the ground slides under whoever is walking in place
        if (actors.length && a === actors[0]) {
          tex.offset.x += (a.vel.x * d) / 10;
          tex.offset.y -= (a.vel.z * d) / 10;
        }
      }
      for (const a of actors) a.aimPitch = pitch;
    }
    controls.update();
    r.render();
    const W = window.innerWidth, H = window.innerHeight;
    for (const a of actors) {
      const el = (a as Actor & { label?: HTMLElement }).label;
      if (!el) continue;
      proj.copy(a.obj.position).setY(a.obj.position.y + 2.4).project(cam);
      el.style.transform = `translate(${(proj.x * 0.5 + 0.5) * W}px, ${(-proj.y * 0.5 + 0.5) * H}px) translate(-50%, -100%)`;
      el.style.display = proj.z < 1 ? '' : 'none';
    }
  }

  const initSubject = params.get('subject');
  if (initSubject === 'all') subject = 'all';
  else if (initSubject && initSubject !== 'pilot') subject = Math.max(0, Math.min(SPECIES.length - 1, Number(initSubject) || 0));
  if (params.get('clip')) clipId = params.get('clip')!;
  if (params.get('ui') === '0') ui.querySelector<HTMLElement>('.lab-panel')!.style.display = 'none';
  // outfit selectors (one per slot) and the visor switch
  const of = $('lab-outfit');
  for (const sl of SLOTS) {
    const sel = document.createElement('select');
    sel.title = SLOT_NAMES[sl];
    for (const it of ITEMS.filter((i) => i.slot === sl)) {
      const o = document.createElement('option');
      o.value = it.id;
      o.textContent = `${SLOT_NAMES[sl]}: ${it.name}`;
      sel.appendChild(o);
    }
    sel.value = OUTFIT[sl];
    sel.onchange = () => { OUTFIT = { ...OUTFIT, [sl]: sel.value }; if (!sheet) build(); };
    of.appendChild(sel);
  }
  const vb = document.createElement('button');
  vb.textContent = 'Светофильтр ↕';
  vb.onclick = () => { VISOR_UP = VISOR_UP ? 0 : 1; };
  of.appendChild(vb);

  const sheetKind = params.get('sheet');
  if (sheetKind === 'pilot' || sheetKind === 'creatures' || sheetKind === 'outfits') {
    buildSheet(sheetKind, Number(params.get('from') ?? 0), Number(params.get('to') ?? 99));
  } else build();
  requestAnimationFrame(frame);
  (window as unknown as { __lab: unknown }).__lab = {
    ready: true,
    play: (s: typeof subject, c: string) => { subject = s; clipId = c; build(); },
    sheet: (k: 'pilot' | 'creatures' | 'outfits', from?: number, to?: number) => buildSheet(k, from, to),
    /** Dresses the lab pilot (outfit look code) and sets the visor (1 = up). */
    dress: (look: string, visor = VISOR_UP) => { OUTFIT = parseLook(look); VISOR_UP = visor; build(); },
    look: () => lookCode(OUTFIT),
    /** Camera on the pilot's upper body (`side` turns round them). */
    close: (side = 0) => {
      controls.target.set(0, 1.45, 0);
      cam.position.set(Math.sin(side) * 1.9, 1.65, -Math.cos(side) * 1.9);
      controls.update();
    },
    pause: (p: boolean) => { paused = p; },
    /** Restarts the current clip and advances it to `t` seconds with a fixed step, then pauses. */
    seek: (t: number) => {
      build();
      paused = true;
      for (const a of actors) for (let k = 0; k < t * 60; k++) a.advance(1 / 60);
    },
  };
}
