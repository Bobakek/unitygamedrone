import {
  CARGO_KEYS, CARGO_NAMES, cargoCount, cargoValue, UPGRADE_COST, MAX_LEVEL, PRICES, REPAIR_COST_PER_HP, MISSILE_COST, UPGRADE_KEYS, type UpgradeKey,
} from '../../shared/economy.ts';
import type { Action, PilotInfo } from '../../shared/net/protocol.ts';

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

export interface LabelData { id: number; x: number; y: number; text: string; sub: string; npc: boolean; hull: number; site?: boolean }
export interface TargetBox { x: number; y: number; size: number; name: string; info: string; shield: number; hull: number; lock: 0 | 1 | 2 }
export interface FlightData { speed: number; throttle: number; boost: number; energy: number; shield: number; hull: number; mode: string }

const UPGRADE_NAMES: Record<UpgradeKey, string> = { weapons: 'Лазеры', shields: 'Щиты', hull: 'Броня', engine: 'Двигатель', cargo: 'Трюм' };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** DOM overlay: panels, labels, markers, toasts, chat, station and help screens. */
export class Hud {
  private root = $('#hud');
  private labels = new Map<number, HTMLElement>();
  private labelLayer = $('#labels');
  private cross = $('#crosshair');
  private cursor = $('#cursor');
  private lead = $('#lead');
  private tbox = $('#target-box');
  private navm = $('#nav-marker');
  private promptEl = $('#prompt');
  private station = $('#station');
  private deadEl = $('#dead');
  private help = $('#help');
  private chatInput = $<HTMLInputElement>('#chat-input');
  private chatLog = $('#chat-log');
  private lastPilot: PilotInfo | null = null;
  onChat: (text: string) => void = () => {};
  onAction: (a: Action) => void = () => {};
  onTyping: (typing: boolean) => void = () => {};

  constructor() {
    this.chatInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const t = this.chatInput.value.trim();
        if (t) this.onChat(t);
        this.chatInput.value = '';
        this.chatInput.blur();
      } else if (e.key === 'Escape') this.chatInput.blur();
    });
    this.chatInput.addEventListener('focus', () => this.onTyping(true));
    this.chatInput.addEventListener('blur', () => this.onTyping(false));
    this.station.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'upgrade') this.onAction({ a: 'upgrade', key: b.dataset.key! });
      else if (act) this.onAction({ a: act } as Action);
    });
  }

  show() {
    this.root.classList.remove('hidden');
  }

  focusChat() {
    this.chatInput.focus();
  }

  toggleHelp(force?: boolean) {
    this.help.classList.toggle('hidden', force === undefined ? undefined : !force);
  }

  setPilot(p: PilotInfo, system: string) {
    this.lastPilot = p;
    $('.pp-name').textContent = p.name;
    $('.pp-credits').textContent = `${p.credits.toLocaleString('ru-RU')} кр`;
    $('.pp-cargo').textContent = `${cargoCount(p.cargo)}/${p.cargoCap}`;
    $('.pp-cargo').title = CARGO_KEYS.map((k) => `${CARGO_NAMES[k]} ${p.cargo[k]}`).join(', ');
    $('.pp-missiles').textContent = String(p.missiles);
    $('.pp-system').textContent = system;
    if (!this.station.classList.contains('hidden')) this.renderStation(p);
  }

  /** On-foot HUD: aim reticle, suit integrity and (in or after a dive) air, 0..1 (null hides all). */
  suit(v: number | null, air = 1) {
    $('#foot-aim').style.display = v === null ? 'none' : 'block';
    const el = $('#suit');
    el.style.display = v === null ? 'none' : 'block';
    if (v === null) return;
    ($('.suit-bar i', el)).style.width = `${Math.max(0, Math.min(100, v))}%`;
    el.classList.toggle('low', v < 35);
    el.classList.toggle('wet', air < 0.999);
    el.classList.toggle('gasp', air < 0.25);
    ($('.air-bar i', el)).style.width = `${Math.max(0, Math.min(1, air)) * 100}%`;
  }

  /** Red vignette pulse when the pilot is hurt. */
  hurt(k: number) {
    const el = $('#hurt');
    el.style.transition = 'none';
    el.style.opacity = String(Math.min(1, 0.35 + k));
    void el.offsetWidth;
    el.style.transition = 'opacity 0.6s';
    el.style.opacity = '0';
  }

  /** Big centred banner for world events. */
  announce(text: string, sub: string, kind: 'info' | 'warn' | 'good' = 'info') {
    const box = $('#announce');
    const d = document.createElement('div');
    d.className = kind;
    const b = document.createElement('b');
    b.textContent = text;
    const s = document.createElement('span');
    s.textContent = sub;
    d.append(b, s);
    box.replaceChildren(d);
    setTimeout(() => d.remove(), 7200);
  }

  /** Local solar time on the planet below (null hides it). */
  clock(c: { planet: string; hours: number } | null) {
    $('.pp-clock').classList.toggle('hidden', !c);
    if (!c) return;
    const h = Math.floor(c.hours), m = Math.floor((c.hours - h) * 60);
    const icon = c.hours >= 6 && c.hours < 18 ? '☀' : '☾';
    $('.pp-where').textContent = c.planet;
    $('.pp-time').textContent = `${icon} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  flight(f: FlightData) {
    $('.fp-speed b').textContent = String(Math.round(f.speed));
    $('.fp-mode').textContent = f.mode;
    const set = (sel: string, v: number) => { ($(`${sel} i`)).style.width = `${Math.max(0, Math.min(1, v)) * 100}%`; };
    set('.thr', Math.max(0, f.throttle));
    set('.bst', f.boost);
    set('.nrg', f.energy);
    set('.shd', f.shield);
    set('.hul', f.hull);
  }

  setFlightVisible(v: boolean) {
    $('#flight-panel').style.display = v ? '' : 'none';
    this.cross.style.display = v ? '' : 'none';
    this.cursor.style.display = v ? '' : 'none';
  }

  crosshair(x: number, y: number) {
    this.cross.style.transform = `translate(${x}px, ${y}px)`;
  }

  cursorAt(x: number, y: number) {
    this.cursor.style.transform = `translate(${x}px, ${y}px) rotate(45deg)`;
  }

  leadAt(p: { x: number; y: number } | null) {
    this.lead.style.display = p ? 'block' : 'none';
    if (p) this.lead.style.transform = `translate(${p.x}px, ${p.y}px)`;
  }

  target(t: TargetBox | null) {
    if (!t) { this.tbox.style.display = 'none'; return; }
    const s = Math.max(24, Math.min(160, t.size));
    Object.assign(this.tbox.style, { display: 'block', left: `${t.x - s / 2}px`, top: `${t.y - s / 2}px`, width: `${s}px`, height: `${s}px` });
    $('.tb-name', this.tbox).textContent = t.name;
    $('.tb-info', this.tbox).textContent = t.info;
    ($('.tb-bars .sh', this.tbox)).style.width = `${t.shield * 100}%`;
    ($('.tb-bars .hl', this.tbox)).style.width = `${t.hull * 100}%`;
    this.tbox.classList.toggle('locking', t.lock === 1);
    this.tbox.classList.toggle('locked', t.lock === 2);
  }

  navMarker(m: { x: number; y: number; text: string } | null) {
    if (!m) { this.navm.style.display = 'none'; return; }
    this.navm.style.display = 'block';
    this.navm.style.left = `${m.x}px`;
    this.navm.style.top = `${m.y}px`;
    $('.nm-text', this.navm).textContent = m.text;
  }

  navList(items: { name: string; dist: string }[], sel: number) {
    $('.np-list').innerHTML = items.map((it, i) => `<div class="np-item${i === sel ? ' sel' : ''}"><span>${esc(it.name)}</span><span>${it.dist}</span></div>`).join('');
  }

  setLabels(list: LabelData[]) {
    const seen = new Set<number>();
    for (const l of list) {
      seen.add(l.id);
      let el = this.labels.get(l.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'label';
        el.innerHTML = '<span class="lb-t"></span><small></small><div class="lb-bar"><i></i></div>';
        this.labelLayer.appendChild(el);
        this.labels.set(l.id, el);
      }
      el.classList.toggle('npc', l.npc);
      el.classList.toggle('site', !!l.site);
      el.style.left = `${l.x}px`;
      el.style.top = `${l.y}px`;
      (el.querySelector('.lb-t') as HTMLElement).textContent = l.text;
      (el.querySelector('small') as HTMLElement).textContent = l.sub;
      (el.querySelector('.lb-bar i') as HTMLElement).style.width = `${l.hull * 100}%`;
    }
    for (const [id, el] of this.labels) if (!seen.has(id)) { el.remove(); this.labels.delete(id); }
  }

  toast(text: string, kind: 'info' | 'warn' | 'good' = 'info') {
    const el = document.createElement('div');
    el.className = kind;
    el.textContent = text;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 4600);
    while ($('#toasts').children.length > 4) $('#toasts').firstElementChild!.remove();
  }

  feed(text: string) {
    const el = document.createElement('div');
    el.textContent = text;
    $('#feed').appendChild(el);
    setTimeout(() => el.remove(), 6100);
  }

  chat(from: string | null, text: string) {
    const el = document.createElement('div');
    el.innerHTML = from ? `<span class="who">${esc(from)}:</span> ${esc(text)}` : `<span class="sys">${esc(text)}</span>`;
    this.chatLog.appendChild(el);
    while (this.chatLog.children.length > 8) this.chatLog.firstElementChild!.remove();
  }

  prompt(html: string | null) {
    this.promptEl.style.display = html ? 'block' : 'none';
    if (html) this.promptEl.innerHTML = html;
  }

  showStation(open: boolean, name = '') {
    const was = !this.station.classList.contains('hidden');
    this.station.classList.toggle('hidden', !open);
    if (open && !was) {
      $('.st-title').textContent = name;
      if (this.lastPilot) this.renderStation(this.lastPilot);
    }
  }

  renderStation(p: PilotInfo, hull?: { hull: number; max: number }) {
    const c = p.cargo;
    const value = cargoValue(c);
    $('.st-cargo').innerHTML = CARGO_KEYS.map((k) => `${CARGO_NAMES[k]}: ${c[k]} × ${PRICES[k]}`).join('<br>') + `<br><b>Итого: ${value} кр</b> · Баланс: ${p.credits} кр` +
      (hull ? `<br>Корпус: ${Math.round(hull.hull)}/${hull.max} (ремонт ${Math.ceil((hull.max - hull.hull) * REPAIR_COST_PER_HP)} кр)` : '') +
      `<br>Ракеты: ${p.missiles} (${MISSILE_COST} кр/шт)`;
    $('.st-upgrades').innerHTML = UPGRADE_KEYS.map((k) => {
      const lvl = p.upgrades[k];
      const max = lvl >= MAX_LEVEL;
      const cost = max ? 0 : UPGRADE_COST[lvl + 1];
      return `<div class="upg"><span>${UPGRADE_NAMES[k]} — ур. ${lvl}</span><button data-act="upgrade" data-key="${k}" ${max || p.credits < cost ? 'disabled' : ''}>${max ? 'макс.' : `${cost} кр`}</button></div>`;
    }).join('');
  }

  setDead(dead: boolean) {
    this.deadEl.classList.toggle('hidden', !dead);
  }
}
