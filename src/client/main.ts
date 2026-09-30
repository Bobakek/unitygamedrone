import { Game } from './game.ts';
import { loadSettings, saveSettings, type QualityLevel } from './core/quality.ts';

const $ = (id: string) => document.getElementById(id)!;
const nameInput = $('login-name') as HTMLInputElement;
const err = $('login-error');

let saved: { name?: string; token?: string } = {};
try {
  saved = JSON.parse(localStorage.getItem('nova.pilot') ?? '{}');
} catch { /* ignore */ }
nameInput.value = saved.name ?? '';
const params = new URLSearchParams(location.search);
if (params.get('name')) nameInput.value = params.get('name')!;
/** Single-player build (VITE_OFFLINE=1) or ?offline=1: the game server runs inside the page. */
const offline = import.meta.env.VITE_OFFLINE === '1' || params.get('offline') === '1';
if (offline) {
  $('login-hint').textContent = 'Одиночный режим: игровой сервер работает прямо в браузере, прогресс хранится локально. Команды разработчика: /help в чате.';
}

const settings = loadSettings();
const qSelect = $('login-quality') as HTMLSelectElement;
const forced = params.get('q') ?? (location.hash === '#low' ? 'low' : null);
if (forced && ['low', 'medium', 'high', 'ultra'].includes(forced)) settings.quality = forced as QualityLevel;
qSelect.value = settings.quality;

let started = false;
function start() {
  if (started) return;
  const name = nameInput.value.trim();
  if (name.length < 2) {
    err.textContent = 'Введите позывной (2–16 символов)';
    return;
  }
  started = true;
  settings.quality = qSelect.value as QualityLevel;
  saveSettings(settings);
  $('login').classList.add('hidden');
  $('loading').classList.remove('hidden');
  const token = saved.name?.toLowerCase() === name.toLowerCase() ? saved.token : undefined;
  new Game($('view') as HTMLCanvasElement, name, token, (msg) => {
    $('loading').classList.add('hidden');
    $('hud').classList.add('hidden');
    $('login').classList.remove('hidden');
    err.textContent = msg;
    ($('login-go') as HTMLButtonElement).textContent = 'Переподключиться';
    ($('login-go') as HTMLButtonElement).onclick = () => location.reload();
  }, offline, settings);
}

$('login-go').addEventListener('click', start);
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') start();
});
nameInput.focus();
if (params.get('autostart') === '1' && nameInput.value) start();
