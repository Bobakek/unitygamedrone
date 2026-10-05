import {
  cannotTake, FACTION_COLORS, FACTION_NAMES, FACTION_SHORT, FACTIONS, KIND_NAMES, objectiveText, RANKS, rankOf, REP_NAMES, repLevel,
  rewardText, type ContractDef, type Faction,
} from '../../shared/contracts.ts';
import { getSystem } from '../../shared/galaxy/system-gen.ts';
import type { Action, BoardMsg, PilotInfo } from '../../shared/net/protocol.ts';
import { ITEMS, repNeedText, repOk, SLOT_NAMES } from '../../shared/outfit.ts';

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const tierDots = (t: number) => '●'.repeat(t) + '○'.repeat(3 - t);

type Tab = 'board' | 'mine' | 'rep';

/**
 * The station contract board: offers from the factions (and the Syndicate's
 * shady ones), the pilot's active contracts with progress, and their rank and
 * standing with what it unlocks.
 */
export class ContractsUi {
  private el = $('#contracts');
  private tab: Tab = 'board';
  private board: BoardMsg | null = null;
  private boardAt = 0;
  private pilot: PilotInfo | null = null;
  private timer = 0;
  onAction: (a: Action) => void = () => {};

  constructor() {
    $('.ct-close', this.el).addEventListener('click', () => this.close());
    this.el.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('button');
      if (!t) return;
      if (t.dataset.tab) { this.tab = t.dataset.tab as Tab; this.render(); }
      else if (t.dataset.take) this.onAction({ a: 'takeContract', id: t.dataset.take });
      else if (t.dataset.drop) this.onAction({ a: 'dropContract', id: t.dataset.drop });
    });
  }

  get open(): boolean {
    return !this.el.classList.contains('hidden');
  }

  show(p: PilotInfo) {
    this.pilot = p;
    this.el.classList.remove('hidden');
    this.render();
    clearInterval(this.timer);
    this.timer = window.setInterval(() => this.tick(), 1000);
  }

  close() {
    this.el.classList.add('hidden');
    clearInterval(this.timer);
  }

  setBoard(b: BoardMsg) {
    this.board = b;
    this.boardAt = performance.now();
    if (this.open) this.render();
  }

  setPilot(p: PilotInfo) {
    this.pilot = p;
    if (this.open) this.render();
  }

  private tick() {
    const el = this.el.querySelector('.ct-next');
    if (el) el.textContent = this.nextText();
  }

  private nextText() {
    if (!this.board) return '';
    const ms = Math.max(0, this.board.next - (performance.now() - this.boardAt));
    const s = Math.ceil(ms / 1000);
    return `Новые предложения через ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  private render() {
    const p = this.pilot;
    if (!p) return;
    const c = p.career;
    const rank = rankOf(c.xp);
    $('.ct-title', this.el).textContent = this.board ? `Контракты · ${getSystem(this.board.system).station.name}` : 'Контракты';
    $('.ct-rank', this.el).textContent = `${RANKS[rank].name} · ${c.active.length}/${RANKS[rank].slots}`;
    $('.ct-tabs', this.el).innerHTML = ([['board', 'Доска'], ['mine', `Мои (${c.active.length})`], ['rep', 'Репутация']] as [Tab, string][])
      .map(([k, n]) => `<button data-tab="${k}" class="${k === this.tab ? 'on' : ''}">${n}</button>`).join('');
    const body = $('.ct-body', this.el);
    if (this.tab === 'board') body.innerHTML = this.boardHtml(p);
    else if (this.tab === 'mine') body.innerHTML = this.mineHtml(p);
    else body.innerHTML = this.repHtml(p);
  }

  private card(o: ContractDef, foot: string, have?: number) {
    const prog = have !== undefined ? `<div class="ct-prog"><i style="width:${Math.min(100, (have / o.need) * 100)}%"></i></div>` : '';
    return `<div class="ct-card" style="--fc:${FACTION_COLORS[o.faction]}">
      <div class="ct-head"><span class="ct-fac">${FACTION_SHORT[o.faction]} · ${KIND_NAMES[o.kind]}</span><span class="ct-tier" title="Уровень ${o.tier}">${tierDots(o.tier)}</span></div>
      <div class="ct-name">${esc(o.title)}</div>
      <div class="ct-desc">${esc(o.desc)}</div>
      <div class="ct-obj">◆ ${esc(objectiveText(o, have ?? 0))}</div>${prog}
      <div class="ct-rew">${esc(rewardText(o.reward, o.faction, o.side))}</div>
      ${foot}</div>`;
  }

  private boardHtml(p: PilotInfo) {
    if (!this.board) return '<p class="ct-empty">Доска загружается…</p>';
    const c = p.career;
    const foot = (o: ContractDef) => {
      if (c.active.some((a) => a.id === o.id)) return '<button disabled>Взят</button>';
      if (c.done.includes(o.id)) return '<button disabled>Выполнен</button>';
      const why = cannotTake(o, c);
      return why ? `<div class="ct-why">${esc(why)}</div>` : `<button data-take="${esc(o.id)}">Взять контракт</button>`;
    };
    const legal = this.board.offers.filter((o) => o.faction !== 'pirate');
    const shady = this.board.offers.filter((o) => o.faction === 'pirate');
    return `<div class="ct-grid">${legal.map((o) => this.card(o, foot(o))).join('')}</div>
      <h3 class="ct-shady">Теневые предложения <small>— Синдикат «Чёрная звезда»</small></h3>
      <div class="ct-grid">${shady.map((o) => this.card(o, foot(o))).join('') || '<p class="ct-empty">Сегодня тихо.</p>'}</div>
      <p class="ct-next">${this.nextText()}</p>`;
  }

  private mineHtml(p: PilotInfo) {
    const list = p.career.active;
    if (!list.length) return '<p class="ct-empty">Активных контрактов нет — загляните на доску.</p>';
    return `<div class="ct-grid">${list.map((o) => this.card(o, `<button class="ghost" data-drop="${esc(o.id)}">Отказаться${o.kind === 'intercept' ? '' : ` (${FACTION_SHORT[o.faction]} −2)`}</button>`, o.have)).join('')}</div>
      <p class="ct-next">Цели активных контрактов — в навигации (Tab) и на радаре.</p>`;
  }

  private repHtml(p: PilotInfo) {
    const c = p.career;
    const r = rankOf(c.xp), next = RANKS[r + 1];
    const k = next ? (c.xp - RANKS[r].xp) / (next.xp - RANKS[r].xp) : 1;
    const rank = `<div class="ct-rankbox"><b>${RANKS[r].name}</b><span>${c.xp} опыта${next ? ` · до звания «${next.name}» ещё ${next.xp - c.xp}` : ' · высшее звание'}</span>
      <div class="ct-prog"><i style="width:${k * 100}%"></i></div>
      <span>Контрактов одновременно: ${RANKS[r].slots} · задания до ${RANKS[r].tier} уровня</span></div>`;
    const bar = (f: Faction) => {
      const v = c.rep[f];
      const left = v < 0 ? 50 + v / 2 : 50, width = Math.abs(v) / 2;
      return `<div class="ct-rep" style="--fc:${FACTION_COLORS[f]}"><div class="ct-rep-h"><b>${FACTION_NAMES[f]}</b><span>${REP_NAMES[repLevel(v)]} · ${v > 0 ? '+' : ''}${v}</span></div>
        <div class="ct-rep-bar"><i style="left:${left}%;width:${width}%"></i><em></em></div></div>`;
    };
    const items = ITEMS.filter((it) => it.rep).map((it) => {
      const ok = repOk(it, c.rep);
      return `<div class="ct-unlock ${ok ? 'ok' : ''}"><span>${ok ? '✓' : '🔒'} ${esc(it.name)} <small>${SLOT_NAMES[it.slot]}</small></span><small>${repNeedText(it)}</small></div>`;
    }).join('');
    const notes = `<p class="ct-note">Друг Синдиката: пиратские корабли и турели не нападают первыми (пока вы не стреляете по пиратам).
      Федерация ниже −25: вас объявляют в розыск — за ваш корабль другим пилотам положена награда.</p>`;
    return rank + FACTIONS.map(bar).join('') + notes + `<h3>Снаряжение за репутацию (гардероб)</h3><div class="ct-unlocks">${items}</div>`;
  }
}
