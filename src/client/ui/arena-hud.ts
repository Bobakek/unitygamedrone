import { ARENA, TEAM_COLORS, TEAM_NAMES, type ArenaMsg } from '../../shared/arena.ts';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Arena overlay: the score bar at the top (kills this round, rounds won, the clock), the team
 * rosters between rounds and while Tab is held, the queue chip at the station, hit and kill
 * markers on the crosshair and the damage direction ring.
 */
export class ArenaHud {
  private root = document.createElement('div');
  private bar = document.createElement('div');
  private roster = document.createElement('div');
  private queue = document.createElement('div');
  private hitmark = document.createElement('div');
  private dirs = document.createElement('div');
  private nums = document.createElement('div');
  private msg: ArenaMsg = { phase: 'none', until: 0 };
  /** Server time of the last message (the clock counts down locally). */
  private shown = '';
  rosterHeld = false;

  constructor(parent: HTMLElement) {
    this.root.id = 'arena-hud';
    this.bar.className = 'ar-bar hidden';
    this.roster.className = 'ar-roster hidden';
    this.queue.className = 'ar-queue hidden';
    this.hitmark.id = 'hitmark';
    this.dirs.id = 'dmg-dirs';
    this.nums.id = 'dmg-nums';
    this.root.append(this.bar, this.roster, this.queue);
    parent.append(this.root, this.hitmark, this.dirs, this.nums);
  }

  get state() { return this.msg; }
  get active() { return this.msg.phase !== 'none' && this.msg.phase !== 'queue'; }
  /** Can weapons fire now (outside the arena always). */
  get armed() { return !this.active || this.msg.phase === 'fight'; }

  set(m: ArenaMsg) {
    this.msg = m;
    this.shown = '';
  }

  teamOf(ship: number): number | undefined {
    return this.msg.players?.find((p) => p.ship === ship)?.team;
  }

  /** Redraws the bar (once a frame; cheap when nothing changed). */
  frame(now: number) {
    const m = this.msg;
    const left = m.until ? Math.max(0, Math.ceil(m.until - now)) : 0;
    const key = `${m.phase}|${left}|${this.rosterHeld}`;
    if (key === this.shown) return;
    this.shown = key;
    this.queue.classList.toggle('hidden', m.phase !== 'queue');
    if (m.phase === 'queue') {
      this.queue.innerHTML = `<b>Арена 3×3</b> · в очереди ${m.waiting ?? 1} · ${left ? `старт через ${left} с` : 'собираем матч'}<small>свободные места займут боты · /arena — выйти из очереди</small>`;
    }
    const on = this.active;
    this.bar.classList.toggle('hidden', !on);
    const showRoster = on && (this.rosterHeld || m.phase === 'pause' || m.phase === 'over' || m.phase === 'warmup');
    this.roster.classList.toggle('hidden', !showRoster);
    if (!on) return;
    const sc = m.score ?? [0, 0], rd = m.rounds ?? [0, 0], me = m.team ?? 0;
    const pips = (n: number, team: number) => Array.from({ length: ARENA.rounds }, (_, i) => `<i class="${i < n ? 'on' : ''}" style="--c:${TEAM_COLORS[team]}"></i>`).join('');
    const clock = m.phase === 'fight' ? (m.overtime ? 'ОВЕРТАЙМ' : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`)
      : m.phase === 'warmup' ? `СТАРТ ${left}` : m.phase === 'pause' ? 'ПЕРЕРЫВ' : 'ФИНАЛ';
    this.bar.innerHTML =
      `<div class="ar-team${me === 0 ? ' me' : ''}" style="--c:${TEAM_COLORS[0]}"><span>${TEAM_NAMES[0]}</span><b>${sc[0]}</b><div class="ar-pips">${pips(rd[0], 0)}</div></div>` +
      `<div class="ar-mid"><small>Раунд ${m.round ?? 1} · до ${ARENA.kills}</small><b>${clock}</b></div>` +
      `<div class="ar-team${me === 1 ? ' me' : ''}" style="--c:${TEAM_COLORS[1]}"><div class="ar-pips">${pips(rd[1], 1)}</div><b>${sc[1]}</b><span>${TEAM_NAMES[1]}</span></div>`;
    if (!showRoster) return;
    const head = m.phase === 'over' ? (m.winner === me ? 'Победа!' : 'Поражение') : m.phase === 'pause' ? `Раунд за командой «${TEAM_NAMES[m.winner ?? 0]}»` : m.phase === 'warmup' ? `Раунд ${m.round}: старт через ${left} с` : 'Счёт';
    const col = (team: 0 | 1) => (m.players ?? []).filter((p) => p.team === team)
      .map((p) => `<tr class="${p.bot ? 'bot' : ''}"><td>${esc(p.name)}</td><td>${p.kills}</td><td>${p.deaths}</td></tr>`).join('');
    this.roster.innerHTML = `<h3>${head}</h3><div class="ar-cols">` +
      ([0, 1] as const).map((t) => `<table style="--c:${TEAM_COLORS[t]}"><tr><th>${TEAM_NAMES[t]}${t === me ? ' (вы)' : ''}</th><th>Сбил</th><th>Сбит</th></tr>${col(t)}</table>`).join('') +
      `</div><p>${m.phase === 'over' ? 'Возвращаем на станцию…' : 'Tab — счёт · /arena — покинуть арену'}</p>`;
  }

  /** Keeps the hit marker and the damage ring on the crosshair. */
  aim(x: number, y: number) {
    this.hitmark.style.left = this.dirs.style.left = `${x}px`;
    this.hitmark.style.top = this.dirs.style.top = `${y}px`;
  }

  /** The crosshair flashes when our shot hits (bigger and red on a kill). */
  hit(kill = false) {
    const el = this.hitmark;
    el.className = '';
    void el.offsetWidth;
    el.className = kill ? 'kill' : 'on';
  }

  /** A red arc on the ring round the crosshair pointing to where the hit came from (screen angle, 0 = up). */
  damageFrom(angle: number, k: number) {
    const d = document.createElement('i');
    d.style.transform = `rotate(${angle}rad)`;
    d.style.opacity = String(Math.min(1, 0.45 + k));
    this.dirs.append(d);
    setTimeout(() => d.remove(), 900);
    while (this.dirs.children.length > 6) this.dirs.firstElementChild!.remove();
  }

  /** A damage number floating up from a hit on screen. */
  number(x: number, y: number, n: number, shield: boolean) {
    const d = document.createElement('b');
    d.textContent = String(n);
    d.className = shield ? 'sh' : '';
    d.style.left = `${x + (Math.random() - 0.5) * 24}px`;
    d.style.top = `${y - 10}px`;
    this.nums.append(d);
    setTimeout(() => d.remove(), 800);
    while (this.nums.children.length > 24) this.nums.firstElementChild!.remove();
  }
}
