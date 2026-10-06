import {
  CARGO_KEYS, CARGO_NAMES, cargoCount, combatStats, flightStats, UPGRADE_COST, MAX_LEVEL, REPAIR_COST_PER_HP, MISSILE_COST, UPGRADE_KEYS, type CargoKey, type UpgradeKey,
} from '../../shared/economy.ts';
import type { Action, PilotInfo } from '../../shared/net/protocol.ts';
import type { MarketMsg } from '../../shared/market.ts';
import { getSystem } from '../../shared/galaxy/system-gen.ts';
import { FACTION_COLORS, objectiveText, RANKS, rankOf } from '../../shared/contracts.ts';
import { HULL_KEYS, HULLS, type HullKey } from '../../shared/ships/hulls.ts';
import { batchesPossible, inputsText, RECIPES } from '../../shared/refinery.ts';

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

export interface LabelData { id: number; x: number; y: number; text: string; sub: string; npc: boolean; hull: number; site?: boolean; goal?: boolean; bubble?: string; ally?: boolean }
export interface TargetBox { x: number; y: number; size: number; name: string; info: string; shield: number; hull: number; lock: 0 | 1 | 2 }
/** A row of the group panel. */
export interface GroupRow { name: string; leader: boolean; where: string; hull: number }
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
  private market: MarketMsg | null = null;
  private marketAt = 0;
  private groupEl = $('#group-panel');
  onChat: (text: string) => void = () => {};
  onAction: (a: Action) => void = () => {};
  onWardrobe: () => void = () => {};
  onContracts: () => void = () => {};
  onTyping: (typing: boolean) => void = () => {};
  onGroup: (what: 'yes' | 'no' | 'leave') => void = () => {};

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
    this.groupEl.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (b?.dataset.g) this.onGroup(b.dataset.g as 'yes' | 'no' | 'leave');
    });
    this.chatInput.addEventListener('focus', () => this.onTyping(true));
    this.chatInput.addEventListener('blur', () => this.onTyping(false));
    this.station.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'close-station') this.showStation(false);
      else if (act === 'wardrobe') this.onWardrobe();
      else if (act === 'contracts') this.onContracts();
      else if (act === 'upgrade') this.onAction({ a: 'upgrade', key: b.dataset.key! });
      else if (act === 'ship') this.onAction({ a: b.dataset.op === 'buy' ? 'buyShip' : 'setShip', ship: b.dataset.key as HullKey });
      else if (act === 'refine') this.onAction({ a: 'refine', recipe: b.dataset.key!, n: b.dataset.n === 'all' ? undefined : Number(b.dataset.n) });
      else if (act === 'trade') {
        const key = b.dataset.key as CargoKey, n = b.dataset.n === 'all' ? undefined : Number(b.dataset.n);
        this.onAction(b.dataset.op === 'buy' ? { a: 'buy', key, n: n ?? 999 } : { a: 'sell', key, n });
      }
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
    const bed = cargoCount(p.roverBed);
    $('.pp-bed-row').classList.toggle('hidden', !bed);
    $('.pp-bed').textContent = `${bed}/${p.roverBedCap}`;
    $('.pp-bed').title = CARGO_KEYS.filter((k) => p.roverBed[k]).map((k) => `${CARGO_NAMES[k]} ${p.roverBed[k]}`).join(', ');
    $('.pp-missiles').textContent = String(p.missiles);
    $('.pp-system').textContent = system;
    $('.pp-rank').textContent = RANKS[rankOf(p.career.xp)].name;
    $('.pp-tasks').innerHTML = p.career.active.map((c) => `<div class="pp-task${c.have >= c.need ? ' full' : ''}" style="--fc:${FACTION_COLORS[c.faction]}"><b>◆ ${esc(c.title)}</b><span>${esc(objectiveText(c))}</span></div>`).join('');
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
    // banners that arrive together (contract done + promotion) stack instead of replacing each other
    while (box.children.length >= 2) box.firstElementChild!.remove();
    box.append(d);
    setTimeout(() => d.remove(), 7200);
  }

  /** Planet weather in the pilot panel: now / what is coming (null hides it). */
  forecast(text: string | null) {
    $('.pp-sky').classList.toggle('hidden', !text);
    if (text) $('.pp-forecast').textContent = text;
  }

  /** Storm warning over the suit bar: hazard, damage per second and protection (null hides it). */
  weatherChip(w: { icon: string; text: string; level: 0 | 1 | 2 } | null) {
    const el = $('#weather-chip');
    el.style.display = w ? 'block' : 'none';
    if (!w) return;
    el.textContent = `${w.icon} ${w.text}`;
    el.className = ['safe', 'warn', 'bad'][w.level];
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
        el.innerHTML = '<div class="lb-bubble"></div><span class="lb-t"></span><small></small><div class="lb-bar"><i></i></div>';
        this.labelLayer.appendChild(el);
        this.labels.set(l.id, el);
      }
      el.classList.toggle('npc', l.npc);
      el.classList.toggle('site', !!l.site);
      el.classList.toggle('goal', !!l.goal);
      el.classList.toggle('ally', !!l.ally);
      el.style.left = `${l.x}px`;
      el.style.top = `${l.y}px`;
      (el.querySelector('.lb-t') as HTMLElement).textContent = l.text;
      (el.querySelector('.lb-bubble') as HTMLElement).textContent = l.bubble ?? '';
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

  /** `deck`: opened from a terminal on the station deck (closable, no "walk out" button); `focus`: a section to scroll to. */
  showStation(open: boolean, name = '', deck = false, focus?: string) {
    const was = !this.station.classList.contains('hidden');
    this.station.classList.toggle('hidden', !open);
    this.station.classList.toggle('deck', deck);
    if (open && !was) {
      $('.st-title').textContent = name;
      if (this.lastPilot) this.renderStation(this.lastPilot);
    }
    const card = $('.st-card', this.station);
    if (open && !was) card.scrollTop = 0;
    if (open && focus) $(focus, this.station)?.scrollIntoView({ block: 'start' });
  }

  /** Pilots in the group (empty hides the panel) and a pending invitation. */
  group(rows: GroupRow[], invite: string | null) {
    this.groupEl.classList.toggle('hidden', !rows.length && !invite);
    $('.gp-title', this.groupEl).style.display = rows.length ? '' : 'none';
    $('.gp-leave', this.groupEl).classList.toggle('hidden', !rows.length);
    $('.gp-list', this.groupEl).innerHTML = rows.map((r) => `<div class="gp-m"><b>${r.leader ? '★ ' : ''}${esc(r.name)}</b><span>${esc(r.where)}</span><i><u style="width:${Math.round(r.hull * 100)}%"></u></i></div>`).join('');
    const inv = $('.gp-invite', this.groupEl);
    inv.classList.toggle('hidden', !invite);
    if (invite) $('span', inv).textContent = `${invite} зовёт вас в группу`;
  }

  setMarket(m: MarketMsg) {
    this.market = m;
    this.marketAt = performance.now();
    if (!this.station.classList.contains('hidden') && this.lastPilot) this.renderMarket(this.lastPilot);
  }

  /** Prices here and through the gates, with buy and sell buttons. */
  private renderMarket(p: PilotInfo) {
    const m = this.market;
    const box = $('.mk-table');
    if (!m) { box.innerHTML = '<p class="mk-hint">Загрузка цен…</p>'; return; }
    const room = combatStats(p.upgrades, p.ship).cargoCap - cargoCount(p.cargo);
    const left = Math.max(0, m.next - (performance.now() - this.marketAt));
    $('.mk-next').textContent = `· цены сменятся через ${Math.max(1, Math.ceil(left / 60000))} мин`;
    const others = m.others;
    const head = `<tr><th>Товар</th><th>Трюм</th><th title="Сколько станция платит за единицу">Платят</th><th title="Почём станция продаёт (только то, чем богата система)">Продают</th><th></th>${others.map((o) => `<th title="Сколько платят в системе ${esc(getSystem(o.system).name)} (⇄ — там же продают)">${esc(getSystem(o.system).name)}</th>`).join('')}</tr>`;
    const rows = CARGO_KEYS.map((k) => {
      const q = m.here.goods[k];
      const all = [q.sell, ...others.map((o) => o.goods[k].sell)];
      const hi = Math.max(...all), lo = Math.min(...all);
      const cls = (v: number) => `num${all.length > 1 && v === hi ? ' best' : all.length > 1 && v === lo ? ' low' : ''}`;
      const have = p.cargo[k];
      const btn = (op: string, n: string, text: string, off: boolean) => `<button data-act="trade" data-op="${op}" data-key="${k}" data-n="${n}" ${off ? 'disabled' : ''}>${text}</button>`;
      const acts = [
        btn('sell', '1', '−1', !have), btn('sell', 'all', 'всё', !have),
        q.buy ? btn('buy', '1', '+1', !room || p.credits < q.buy) + btn('buy', '5', '+5', !room || p.credits < q.buy) : '',
      ].join('');
      return `<tr><td>${CARGO_NAMES[k]}</td><td class="num">${have}</td><td class="${cls(q.sell)}">${q.sell}</td><td class="num${q.buy ? '' : ' na'}">${q.buy ?? '—'}</td><td>${acts}</td>${others.map((o) => `<td class="${cls(o.goods[k].sell)}">${o.goods[k].sell}${o.goods[k].buy ? '<small title="Продаёт"> ⇄</small>' : ''}</td>`).join('')}</tr>`;
    }).join('');
    box.innerHTML = `<table>${head}${rows}</table>`;
  }

  renderStation(p: PilotInfo, hull?: { hull: number; max: number }) {
    const c = p.cargo;
    const q = this.market?.here.goods;
    const value = q ? CARGO_KEYS.reduce((n, k) => n + c[k] * q[k].sell, 0) : 0;
    $('.st-cargo').innerHTML = `Груз: ${cargoCount(c)}/${combatStats(p.upgrades, p.ship).cargoCap}${q ? ` · по местным ценам ≈ <b>${value} кр</b>` : ''}<br>Баланс: <b>${p.credits} кр</b>` +
      (hull ? `<br>Корпус: ${Math.round(hull.hull)}/${hull.max} (ремонт ${Math.ceil((hull.max - hull.hull) * REPAIR_COST_PER_HP)} кр)` : '') +
      `<br>Ракеты: ${p.missiles} (${MISSILE_COST} кр/шт)`;
    $('.st-upgrades').innerHTML = UPGRADE_KEYS.map((k) => {
      const lvl = p.upgrades[k];
      const max = lvl >= MAX_LEVEL;
      const cost = max ? 0 : UPGRADE_COST[lvl + 1];
      return `<div class="upg"><span>${UPGRADE_NAMES[k]} — ур. ${lvl}</span><button data-act="upgrade" data-key="${k}" ${max || p.credits < cost ? 'disabled' : ''}>${max ? 'макс.' : `${cost} кр`}</button></div>`;
    }).join('');
    this.renderMarket(p);
    this.renderRefinery(p);
    this.renderYard(p);
  }

  /** Smelter recipes: what goes in, what comes out, and what a batch earns at this station's prices. */
  private renderRefinery(p: PilotInfo) {
    const q = this.market?.here.goods;
    $('.rf-list').innerHTML = RECIPES.map((r) => {
      const can = batchesPossible(r, p.cargo, p.credits);
      const cost = Object.entries(r.inputs).reduce((n, [k, v]) => n + (q ? q[k as CargoKey].sell * v : 0), 0);
      const gain = q ? q[r.key].sell - cost - r.fee : 0;
      const btn = (n: string, text: string, off: boolean) => `<button data-act="refine" data-key="${r.key}" data-n="${n}" ${off ? 'disabled' : ''}>${text}</button>`;
      return `<div class="rf${can ? ' can' : ''}"><div class="rf-io"><b>${CARGO_NAMES[r.key]}</b><span>${esc(inputsText(r))} → 1 · ${r.fee} кр</span><small>${esc(r.blurb)}</small></div>` +
        `<div class="rf-gain">${q ? `здесь <b class="${gain > 0 ? 'up' : 'down'}">${gain > 0 ? '+' : ''}${gain} кр</b> за партию` : ''}<br><span>в трюме: ${p.cargo[r.key]} · хватит на ${can}</span></div>` +
        `<div class="rf-acts">${btn('1', '×1', can < 1)}${btn('5', '×5', can < 5)}${btn('all', 'всё', can < 1)}</div></div>`;
    }).join('');
  }

  /** Shipyard: the ship classes with their numbers under the pilot's upgrades. */
  private renderYard(p: PilotInfo) {
    const load = cargoCount(p.cargo);
    $('.yard-list').innerHTML = HULL_KEYS.map((k) => {
      const h = HULLS[k], c = combatStats(p.upgrades, k), f = flightStats(p.upgrades, k);
      const mine = p.ship === k, owned = p.ships.includes(k);
      const fits = load <= c.cargoCap;
      const btn = mine ? '<button disabled>Ваш корабль</button>'
        : owned ? `<button data-act="ship" data-op="set" data-key="${k}" ${fits ? '' : 'disabled title="Груз не поместится в трюм"'}>Пересесть</button>`
        : `<button class="buy" data-act="ship" data-op="buy" data-key="${k}" ${p.credits < h.price ? 'disabled' : ''}>Купить — ${h.price} кр</button>`;
      return `<div class="yard${mine ? ' on' : ''}"><b>${esc(h.name)}</b><p>${esc(h.blurb)}</p><ul>` +
        `<li><span>Трюм</span> ${c.cargoCap}</li><li><span>Корпус / щит</span> ${c.maxHull} / ${c.maxShield}</li>` +
        `<li><span>Урон лазера</span> ${c.laserDamage.toFixed(1)}</li><li><span>Скорость</span> ${Math.round(f.maxSpeed)} (форсаж ${Math.round(f.boostSpeed)})</li>` +
        (h.mining ? '<li><span>Бурение астероидов</span> да</li>' : '') + `</ul>${btn}</div>`;
    }).join('');
  }

  setDead(dead: boolean) {
    this.deadEl.classList.toggle('hidden', !dead);
  }
}
