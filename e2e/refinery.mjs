// The station smelter in the browser: the furnace on the promenade, its terminal, ore smelted into ingots and parts.
// Usage: npm run build && node e2e/refinery.mjs   (screenshots land in e2e/out/refinery/)
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';

const LAUNCH = { headless: !process.env.E2E_HEADED, args: process.env.E2E_GPU ? ['--ignore-gpu-blocklist', '--enable-gpu'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] };
const PORT = 8093;
const OUT = new URL('./out/refinery/', import.meta.url).pathname;
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
  const a = await browser.newPage({ viewport: { width: VW, height: VH } });
  a.setDefaultTimeout(STEP_MS);
  a.on('pageerror', (e) => errors.push(`page: ${e.message}`));
  a.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await a.goto(`http://localhost:${PORT}/?name=Smelter&autostart=1${QS}`);
  await a.waitForFunction(() => window.__game?.self && window.__game.pred.ready, null, { timeout: 90000, polling: 250 });
  const shot = async (file, wait = 1500) => { await sleep(wait); await a.screenshot({ path: `${OUT}/${file}` }); console.log('screenshot', file); };
  const chat = (text) => a.evaluate((t) => window.__game.conn.chat(t), text);
  const cargo = () => a.evaluate(() => ({ ...window.__game.pilot.cargo, credits: window.__game.pilot.credits }));

  // dock with a hold of ore and crystals
  // (retry: the first teleport can land before the station's world is in)
  for (let i = 0; i < 4 && await a.evaluate(() => window.__game.pred.mode) !== 2; i++) {
    await chat('/tp dock');
    await sleep(2000);
    await a.keyboard.press('KeyF');
    await a.waitForFunction(() => window.__game.pred.mode === 2, null, { timeout: 8000, polling: 250 }).catch(async () => console.log('dock retry:', await a.evaluate(() => document.querySelector('#prompt').textContent)));
  }
  await chat('/cargo ore 12');
  await chat('/cargo crystal 4');
  await a.waitForFunction(() => window.__game.pilot.cargo.ore >= 12, null, { timeout: 10000, polling: 200 });
  // walk out to the promenade and look at the smelter
  await a.evaluate(() => document.querySelector('#station button[data-act="disembark"]').click());
  await a.waitForFunction(() => window.__game.pred.mode === 4, null, { timeout: STEP_MS, polling: 250 });
  await a.mouse.move(VW / 2, VH / 2);
  // a look at the smelter from the promenade
  await chat('/deck smelter');
  await a.evaluate(() => { const g = window.__game; g.ctrl.footPitch = 0.12; g.ctrl.footDist = 6; });
  await shot('01-smelter.png', 5000);
  await chat('/deck refinery');
  await a.evaluate(() => { const g = window.__game; g.ctrl.footPitch = 0.05; g.ctrl.footDist = 4; });
  await sleep(3000);
  const prompt = await a.evaluate(() => document.querySelector('#prompt').textContent);
  if (!prompt.includes('Плавильня')) errors.push(`no smelter prompt: "${prompt}"`);
  await shot('02-terminal.png', 500);
  // the terminal opens the station window at the smelter
  await a.keyboard.press('KeyF');
  await a.waitForFunction(() => !document.querySelector('#station').classList.contains('hidden'), null, { timeout: STEP_MS, polling: 250 });
  await a.waitForFunction(() => document.querySelector('#station .rf button[data-key="ingot"][data-n="all"]:not([disabled])'), null, { timeout: 10000, polling: 200 });
  await shot('03-window.png', 800);
  const before = await cargo();
  await a.click('#station .rf button[data-key="ingot"][data-n="all"]');
  await a.waitForFunction(() => window.__game.pilot.cargo.ingot >= 4, null, { timeout: 10000, polling: 200 });
  await a.waitForFunction(() => document.querySelector('#station .rf button[data-key="parts"][data-n="1"]:not([disabled])'), null, { timeout: 10000, polling: 200 });
  await a.click('#station .rf button[data-key="parts"][data-n="1"]');
  await a.waitForFunction(() => window.__game.pilot.cargo.parts >= 1, null, { timeout: 10000, polling: 200 });
  const after = await cargo();
  console.log('smelted:', JSON.stringify({ before, after }));
  if (after.ore !== 0 || after.ingot !== 2 || after.crystal !== 3 || after.credits >= before.credits) errors.push('smelting went wrong');
  await shot('04-smelted.png', 800);
  // the products are on the market table
  const rows = await a.evaluate(() => [...document.querySelectorAll('#station .mk-table td:first-child')].map((t) => t.textContent));
  for (const n of ['Слитки', 'Оптика', 'Детали']) if (!rows.includes(n)) errors.push(`market has no ${n}: ${rows}`);
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
