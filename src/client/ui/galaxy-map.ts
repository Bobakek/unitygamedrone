import { getGalaxy, jumpsFrom, route, SECURITY_COLORS, SECURITY_NAMES } from '../../shared/galaxy/galaxy.ts';
import { getSystem } from '../../shared/galaxy/system-gen.ts';

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const SVG = 'http://www.w3.org/2000/svg';
const PAD = 6;

const jumpsText = (n: number) => (n === 1 ? '1 прыжок' : n >= 2 && n <= 4 ? `${n} прыжка` : `${n} прыжков`);

/**
 * Galaxy map (M): stars, jump lanes, the security zones, where the pilot is and
 * their contract targets. Clicking a star selects it; "Проложить маршрут" makes
 * the next gate of the route a navigation point.
 */
export class GalaxyMap {
  private el = $('#galaxy');
  private svg = $('#galaxy svg') as unknown as SVGSVGElement;
  private info = $('.gx-info', this.el);
  private here = 0;
  private selected = -1;
  private routeTo: number | null = null;
  private goals = new Set<number>();
  onRoute: (to: number | null) => void = () => {};

  constructor() {
    const g = getGalaxy();
    const xs = g.stars.map((s) => s.x), ys = g.stars.map((s) => s.y);
    const x0 = Math.min(...xs) - PAD, y0 = Math.min(...ys) - PAD;
    this.svg.setAttribute('viewBox', `${x0} ${y0} ${Math.max(...xs) + PAD - x0} ${Math.max(...ys) + PAD - y0}`);
    $('.gx-close', this.el).addEventListener('click', () => this.close());
    this.el.addEventListener('click', (e) => {
      const t = e.target as Element;
      const star = t.closest('[data-star]');
      if (star) { this.selected = Number(star.getAttribute('data-star')); this.render(); return; }
      const b = t.closest<HTMLElement>('button');
      if (b?.dataset.route === 'set' && this.selected >= 0) { this.routeTo = this.selected === this.here ? null : this.selected; this.onRoute(this.routeTo); this.render(); }
      else if (b?.dataset.route === 'clear') { this.routeTo = null; this.onRoute(null); this.render(); }
    });
  }

  get open(): boolean {
    return !this.el.classList.contains('hidden');
  }

  /** Where the pilot is, their route and the systems their contracts lead to. */
  update(here: number, routeTo: number | null, goals: Iterable<number>) {
    if (this.here !== here && this.selected === this.here) this.selected = here;
    this.here = here;
    this.routeTo = routeTo;
    this.goals = new Set(goals);
    if (this.open) this.render();
  }

  toggle(force?: boolean) {
    const show = force ?? !this.open;
    this.el.classList.toggle('hidden', !show);
    if (show) {
      if (this.selected < 0) this.selected = this.routeTo ?? this.here;
      this.render();
    }
  }

  close() {
    this.toggle(false);
  }

  private render() {
    const g = getGalaxy();
    const path = this.routeTo !== null ? [this.here, ...route(this.here, this.routeTo)] : [];
    const onPath = new Set<string>();
    for (let i = 1; i < path.length; i++) onPath.add([path[i - 1], path[i]].sort((a, b) => a - b).join('-'));
    const svg = this.svg;
    svg.replaceChildren();
    const el = (tag: string, attrs: Record<string, string | number>, parent: Element = svg) => {
      const e = document.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      parent.appendChild(e);
      return e;
    };
    for (const [a, b] of g.lanes) {
      const A = g.stars[a], B = g.stars[b], hot = onPath.has(`${a}-${b}`);
      el('line', { x1: A.x, y1: A.y, x2: B.x, y2: B.y, class: hot ? 'gx-lane hot' : 'gx-lane' });
    }
    for (const s of g.stars) {
      const grp = el('g', { 'data-star': s.id, class: 'gx-star', transform: `translate(${s.x} ${s.y})` });
      el('circle', { r: 3.2, class: 'gx-hit' }, grp);
      if (s.id === this.selected) el('circle', { r: 2.6, class: 'gx-sel' }, grp);
      el('circle', { r: s.id === this.here ? 1.6 : 1.1, fill: getSystem(s.id).star.color, stroke: SECURITY_COLORS[s.security], 'stroke-width': 0.35 }, grp);
      if (s.id === this.here) el('circle', { r: 2.2, class: 'gx-here' }, grp);
      const label = el('text', { y: -2.4, class: s.id === this.here ? 'gx-name here' : 'gx-name' }, grp);
      label.textContent = (this.goals.has(s.id) ? '◆ ' : '') + s.name;
    }
    this.renderInfo(path);
  }

  private renderInfo(path: number[]) {
    const g = getGalaxy();
    const id = this.selected >= 0 ? this.selected : this.here;
    const s = g.stars[id], sys = getSystem(id);
    const hops = jumpsFrom(this.here)[id];
    const lines = [
      `<h3>${s.name}${id === this.here ? ' <small>(вы здесь)</small>' : ''}</h3>`,
      `<p><span style="color:${SECURITY_COLORS[s.security]}">● ${SECURITY_NAMES[s.security]}</span> · планет: ${sys.planets.length} · врат: ${sys.gates.length}</p>`,
      `<p>Станция: ${sys.station.name}</p>`,
      id !== this.here ? `<p>Отсюда: ${jumpsText(hops)}</p>` : '',
      this.goals.has(id) ? '<p class="gx-goal">◆ Здесь цель контракта</p>' : '',
    ];
    if (this.routeTo !== null) {
      lines.push(`<p class="gx-route">Маршрут: ${path.map((i) => g.stars[i].name).join(' → ')}</p>`);
    }
    const buttons = [
      id !== this.here && this.routeTo !== id ? '<button class="primary" data-route="set">Проложить маршрут</button>' : '',
      this.routeTo !== null ? '<button data-route="clear">Сбросить маршрут</button>' : '',
    ];
    this.info.innerHTML = lines.join('') + `<div class="gx-buttons">${buttons.join('')}</div>`;
  }
}
