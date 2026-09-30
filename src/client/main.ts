import { Game } from './game.ts';

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

const lowBox = $('login-low') as HTMLInputElement;
try {
  lowBox.checked = localStorage.getItem('nova.low') === '1';
} catch { /* ignore */ }
if (params.get('q') === 'low' || location.hash === '#low') lowBox.checked = true;

let started = false;
function start() {
  if (started) return;
  const name = nameInput.value.trim();
  if (name.length < 2) {
    err.textContent = 'Введите позывной (2–16 символов)';
    return;
  }
  started = true;
  try {
    localStorage.setItem('nova.low', lowBox.checked ? '1' : '0');
  } catch { /* ignore */ }
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
  }, offline, lowBox.checked);
}

$('login-go').addEventListener('click', start);
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') start();
});
nameInput.focus();
if (params.get('autostart') === '1' && nameInput.value) start();
