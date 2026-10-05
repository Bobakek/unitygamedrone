import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { Action, PilotInfo } from '../../shared/net/protocol.ts';
import { gearStats, ITEMS, itemEffect, owns, repNeedText, repOk, SLOT_NAMES, SLOTS, validOutfit, type Outfit, type Slot } from '../../shared/outfit.ts';
import { AstronautView } from '../entities/astronaut.ts';

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

/**
 * The station wardrobe: a turntable preview of the pilot in the outfit being
 * tried on, and the catalogue by slot — buy new parts, put on owned ones,
 * see what each changes.
 */
export class Wardrobe {
  private el = $('#wardrobe');
  private canvas = $<HTMLCanvasElement>('#wd-canvas');
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 0.72, 0.1, 50);
  private astro: AstronautView | null = null;
  private pilot: PilotInfo | null = null;
  private worn: Outfit = validOutfit(null, []);
  private trying: Outfit = validOutfit(null, []);
  private slot: Slot = 'suit';
  private yaw = 0.4;
  private drag: number | null = null;
  private last = 0;
  private raf = 0;
  private visor = 0;
  onAction: (a: Action) => void = () => {};

  constructor() {
    this.camera.position.set(0, 1.12, -4.1);
    this.camera.lookAt(0, 0.95, 0);
    const sun = new THREE.DirectionalLight('#fff4e6', 2.2);
    sun.position.set(-2, 4, -3);
    this.scene.add(new THREE.HemisphereLight('#dfe9ff', '#3a3530', 1.0), sun);
    $('.wd-close', this.el).addEventListener('click', () => this.close());
    $('.wd-visor', this.el).addEventListener('click', () => { this.visor = this.visor ? 0 : 1; });
    $('.wd-tabs', this.el).addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-slot]');
      if (!b) return;
      this.slot = b.dataset.slot as Slot;
      this.render();
    });
    $('.wd-items', this.el).addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const card = t.closest<HTMLElement>('.wd-item');
      if (!card) return;
      const id = card.dataset.id!;
      const btn = t.closest<HTMLElement>('button[data-do]');
      if (btn?.dataset.do === 'buy') this.onAction({ a: 'buyItem', id });
      else if (btn?.dataset.do === 'equip') this.onAction({ a: 'equip', id });
      // any click tries the part on
      this.trying = { ...this.trying, [ITEMS.find((i) => i.id === id)!.slot]: id };
      this.dress();
      this.render();
    });
    this.canvas.addEventListener('pointerdown', (e) => { this.drag = e.clientX; this.canvas.setPointerCapture(e.pointerId); });
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.drag === null) return;
      this.yaw += (e.clientX - this.drag) * 0.012;
      this.drag = e.clientX;
    });
    this.canvas.addEventListener('pointerup', () => { this.drag = null; });
  }

  get open(): boolean {
    return !this.el.classList.contains('hidden');
  }

  show(p: PilotInfo) {
    this.el.classList.remove('hidden');
    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
      this.renderer.toneMapping = THREE.NeutralToneMapping;
      this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      const pm = new THREE.PMREMGenerator(this.renderer);
      this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
      this.scene.environmentIntensity = 0.6;
    }
    const w = this.canvas.clientWidth || 300, h = this.canvas.clientHeight || 420;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.pilot = null;
    this.setPilot(p, true);
    this.last = performance.now();
    cancelAnimationFrame(this.raf);
    const loop = () => {
      if (!this.open) return;
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    loop();
  }

  close() {
    this.el.classList.add('hidden');
    cancelAnimationFrame(this.raf);
  }

  /** New pilot info (after a purchase or change): refresh the list; `reset` drops the try-on. */
  setPilot(p: PilotInfo, reset = false) {
    const wornBefore = this.worn;
    this.pilot = p;
    this.worn = validOutfit(p.outfit, p.items);
    // a part just bought or put on replaces what was being tried in that slot
    if (reset) this.trying = { ...this.worn };
    else for (const s of SLOTS) if (this.worn[s] !== wornBefore[s]) this.trying[s] = this.worn[s];
    this.dress();
    if (this.open) this.render();
  }

  private dress() {
    if (!this.pilot) return;
    if (!this.astro) {
      this.astro = new AstronautView(this.trying, this.pilot.name);
      this.scene.add(this.astro.group);
    } else this.astro.dress(this.trying, this.pilot.name);
  }

  private frame() {
    const now = performance.now(), dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (!this.astro || !this.renderer) return;
    if (this.drag === null) this.yaw += dt * 0.35;
    this.astro.group.rotation.y = this.yaw;
    this.astro.visorUp = this.visor;
    this.astro.lightsOn = this.visor > 0;
    this.astro.update(dt, { speed: 0, vUp: 0, ground: true, jet: false, look: 0, turn: 0 });
    this.renderer.render(this.scene, this.camera);
  }

  private render() {
    const p = this.pilot;
    if (!p) return;
    $('.wd-tabs', this.el).innerHTML = SLOTS.map((s) => `<button data-slot="${s}" class="${s === this.slot ? 'on' : ''}">${SLOT_NAMES[s]}</button>`).join('');
    $('.wd-items', this.el).innerHTML = ITEMS.filter((i) => i.slot === this.slot).map((it) => {
      const have = owns(p.items, it.id), on = this.worn[it.slot] === it.id, trying = this.trying[it.slot] === it.id;
      const fx = itemEffect(it);
      const locked = !have && !repOk(it, p.career.rep);
      const action = on ? '<button disabled>Надето</button>'
        : have ? '<button data-do="equip">Надеть</button>'
        : locked ? `<button disabled>🔒 ${it.price} кр</button>`
        : `<button data-do="buy" ${p.credits < it.price ? 'disabled' : ''}>Купить · ${it.price} кр</button>`;
      return `<div class="wd-item${trying ? ' trying' : ''}${on ? ' on' : ''}" data-id="${it.id}">
        <div class="wd-name">${it.name}<span>${it.price ? (have ? 'куплено' : `${it.price} кр`) : 'бесплатно'}</span></div>
        <div class="wd-desc">${it.desc}</div>${fx ? `<div class="wd-fx">${fx}</div>` : ''}${it.rep ? `<div class="wd-lock">${locked ? '🔒' : '✓'} Репутация: ${repNeedText(it)}</div>` : ''}${action}</div>`;
    }).join('');
    // what the tried-on outfit changes against what is worn
    const now = gearStats(this.worn), next = gearStats(this.trying);
    const row = (label: string, a: number, b: number, unit: string, better: 'up' | 'down' = 'up') => {
      const d = b - a, good = better === 'up' ? d > 0 : d < 0;
      return `<div><span>${label}</span><b>${+b.toFixed(2)}${unit}</b>${d ? `<i class="${good ? 'up' : 'down'}">${d > 0 ? '+' : ''}${+d.toFixed(2)}</i>` : ''}</div>`;
    };
    $('.wd-stats', this.el).innerHTML = row('Прочность', now.hp, next.hp, '') + row('Воздух', now.airTime, next.airTime, ' с')
      + row('Расход джетпака', now.fuelDrain, next.fuelDrain, '/с', 'down') + row('Самопочинка', now.regenRate, next.regenRate, '/с')
      + row('Биообразцы', now.samples, next.samples, '');
    $('.wd-credits', this.el).textContent = `Баланс: ${p.credits} кр`;
  }
}
