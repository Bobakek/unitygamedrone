// Freight contracts in the browser: the board, containers in the hold with a deadline, a pirate raid, delivery.
// Usage: npm run build && node e2e/freight.mjs   (screenshots land in e2e/out/freight/)
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';

const LAUNCH = { headless: !process.env.E2E_HEADED, args: process.env.E2E_GPU ? ['--ignore-gpu-blocklist', '--enable-gpu'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] };
const PORT = 8093;
const OUT = new URL('./out/freight/', import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const [VW, VH] = (process.env.E2E_VIEWPORT ?? '1280x720').split('x').map(Number);
const QS = `&q=${process.env.E2E_Q ?? 'low'}`;
const STEP_MS = Number(process.env.E2E_TIMEOUT ?? 30000);

const server = spawn(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], {
  env: { ...process.env, PORT: String(PORT), DEV: '1', DB_PATH: `${OUT}/e2e.db` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitHealth() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) return; } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('server did not start');
}

const errors = [];
let browser;
try {
  await waitHealth();
  browser = await chromium.launch(LAUNCH);
  async function open(name) {
    const page = await browser.newPage({ viewport: { width: VW, height: VH } });
    page.setDefaultTimeout(STEP_MS);
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
    await page.goto(`http://localhost:${PORT}/?name=${name}&autostart=1${QS}`);
    await page.waitForFunction(() => window.__game?.self && window.__game.pred.ready, null, { timeout: 90000, polling: 250 });
    return page;
  }
  const shot = async (page, file, wait = 1500) => { await sleep(wait); await page.screenshot({ path: `${OUT}/${file}` }); console.log('screenshot', file); };
  const chat = (page, text) => page.evaluate((t) => window.__game.conn.chat(t), text);

  const a = await open('Alpha');
  const me = () => a.evaluate(() => { const p = window.__game.pilot; return { credits: p.credits, active: p.career.active.map((c) => ({ id: c.id, kind: c.kind, system: c.system, due: c.due })) }; });

  // ---- the board at the station, flying the hauler
  const dock = async () => {
    await chat(a, '/tp dock');
    for (let i = 0; i < 10 && await a.evaluate(() => window.__game.pred.mode !== 2); i++) { await sleep(1500); await a.keyboard.press('KeyF'); }
  };
  await dock();
  await a.waitForFunction(() => window.__game.pred.mode === 2, null, { timeout: 15000, polling: 250 });
  await chat(a, '/credits 5000');
  await chat(a, '/xp 2000');
  await chat(a, '/ship hauler');
  await a.waitForFunction(() => window.__game.pilot.ship === 'hauler', null, { timeout: 10000, polling: 200 });
  await a.evaluate(() => document.querySelector('#station button[data-act="contracts"]').click());
  await a.waitForFunction(() => document.querySelector('#contracts .ct-freight') && [...document.querySelectorAll('#contracts button[data-take]')].length, null, { timeout: 30000, polling: 250 });
  await a.evaluate(() => [...document.querySelectorAll('#contracts .ct-card')].find((c) => c.querySelector('.ct-freight'))?.scrollIntoView());
  await shot(a, '01-board.png', 800);
  const id = await a.evaluate(() => {
    const card = [...document.querySelectorAll('#contracts .ct-card')].find((c) => c.querySelector('.ct-freight') && c.querySelector('button[data-take]'));
    const b = card?.querySelector('button[data-take]'); b?.click(); return b?.dataset.take;
  });
  if (!id) throw new Error('no freight offer to take');
  await a.waitForFunction((i) => window.__game.pilot.career.active.some((c) => c.id === i), id, { timeout: 10000, polling: 200 });
  await a.evaluate(() => document.querySelector('#contracts button[data-tab="mine"]').click());
  await shot(a, '02-taken.png', 800);
  const job = (await me()).active.find((c) => c.id === id);
  console.log('taken:', job);
  if (!job.due) errors.push('freight has no deadline');
  await a.evaluate(() => document.querySelector('#contracts .ct-close').click());

  // ---- a raid in open space
  await a.click('#station button[data-act="undock"]');
  await a.waitForFunction(() => window.__game.pred.mode === 0, null, { timeout: 15000, polling: 250 });
  await chat(a, '/god');
  await chat(a, '/tp open');
  await sleep(2000);
  await chat(a, '/raid');
  try {
    await a.waitForFunction(() => [...window.__game.remotes.values()].filter((r) => r.info?.npc).length >= 1 && document.querySelector('.pp-task .ct-due'), null, { timeout: Math.max(20000, STEP_MS), polling: 250 });
  } catch { errors.push('no raiders or no deadline in the HUD'); }
  await shot(a, '03-raid.png', 2500);

  // ---- delivery at the destination
  const before = (await me()).credits;
  await chat(a, `/system ${job.system}`);
  await a.waitForFunction((s) => window.__game.sys?.id === s, job.system, { timeout: 30000, polling: 250 });
  await sleep(1500);
  await dock();
  try {
    await a.waitForFunction((i) => !window.__game.pilot.career.active.some((c) => c.id === i), id, { timeout: 20000, polling: 250 });
  } catch { errors.push('freight not delivered on docking'); }
  await shot(a, '04-delivered.png', 1500);
  console.log('credits', before, '->', (await me()).credits);
  if ((await me()).credits <= before) errors.push('no payment for freight');
} catch (e) {
  errors.push(`fatal: ${e.stack || e}`);
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}

if (errors.length) {
  console.error('E2E FAILED:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('E2E OK');
