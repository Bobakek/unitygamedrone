import type { PilotInfo } from '../../shared/net/protocol.ts';
import { TROPHY_KIND_NAMES, TROPHY_KINDS, trophyInfo, type TrophyInfo } from '../../shared/station/trophies.ts';

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * The collection terminal in the cabin: every trophy the pilot has, by kind,
 * newest first, with where it came from. Ship's logs can be read again.
 */
export class TrophiesUi {
  private el = $('#trophies');
  private infos = new Map<string, TrophyInfo>();
  /** Opens a wreck's log (the same window as on the bridge). */
  onReadLog: (site: NonNullable<TrophyInfo['site']>) => void = () => {};

  constructor() {
    $('.tr-close', this.el).addEventListener('click', () => this.close());
    this.el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-log]');
      const site = b ? this.infos.get(b.dataset.log!)?.site : undefined;
      if (site) this.onReadLog(site);
    });
  }

  get open(): boolean {
    return !this.el.classList.contains('hidden');
  }

  show(p: PilotInfo) {
    this.el.classList.remove('hidden');
    this.render(p);
  }

  close() {
    this.el.classList.add('hidden');
  }

  private render(p: PilotInfo) {
    this.infos.clear();
    const list = [...p.trophies].sort((a, b) => b.at - a.at);
    const groups = TROPHY_KINDS.map((kind) => ({ kind, items: [] as { id: string; info: TrophyInfo; at: number }[] }));
    for (const t of list) {
      const info = trophyInfo(t.id);
      if (!info) continue;
      this.infos.set(t.id, info);
      groups.find((g) => g.kind === info.kind)!.items.push({ id: t.id, info, at: t.at });
    }
    $('.tr-count', this.el).textContent = `${list.length} ${plural(list.length)}`;
    const body = $('.tr-body', this.el);
    if (!list.length) {
      body.innerHTML = `<p class="tr-empty">Полки пока пусты. Трофеи появляются сами: реликт из тайника руин, бортовой журнал с мостика разбитого корабля, первые биообразцы нового вида, просканированная аномалия, нашивки за сбитые корабли и звания, медали фракций.</p>`;
      return;
    }
    body.innerHTML = groups.filter((g) => g.items.length).map((g) => `
      <h3>${TROPHY_KIND_NAMES[g.kind]} <small>${g.items.length}</small></h3>
      <div class="tr-list">${g.items.map(({ id, info, at }) => `
        <div class="tr-item">
          <i style="--c:${info.color};--c2:${info.color2}"></i>
          <div><b>${esc(info.name)}</b><span>${esc(info.desc)}${at ? ` · ${new Date(at).toLocaleDateString('ru-RU')}` : ''}</span></div>
          ${info.site ? `<button class="ghost" data-log="${esc(id)}">Читать</button>` : ''}
        </div>`).join('')}</div>`).join('');
  }
}

function plural(n: number) {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? 'трофей' : a >= 2 && a <= 4 && (b < 12 || b > 14) ? 'трофея' : 'трофеев';
}
