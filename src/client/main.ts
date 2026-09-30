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

let started = false;
function start() {
  if (started) return;
  const name = nameInput.value.trim();
  if (name.length < 2) {
    err.textContent = 'Введите позывной (2–16 символов)';
    return;
  }
  started = true;
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
  });
}

$('login-go').addEventListener('click', start);
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') start();
});
nameInput.focus();
if (params.get('autostart') === '1' && nameInput.value) start();
