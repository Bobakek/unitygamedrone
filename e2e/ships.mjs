// Ship classes in the browser: the shipyard, the hauler, the mining ship drilling an asteroid, seen by another pilot.
// Usage: npm run build && node e2e/ships.mjs   (screenshots land in e2e/out/ships/)
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';

const LAUNCH = { headless: !process.env.E2E_HEADED, args: process.env.E2E_GPU ? ['--ignore-gpu-blocklist', '--enable-gpu'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] };
const PORT = 8092;
const OUT = new URL('./out/ships/', import.meta.url).pathname;
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
  const b = await open('Bravo');
  const pilot = (page) => page.evaluate(() => ({ ship: window.__game.pilot.ship, ships: window.__game.pilot.ships, cargo: { ...window.__game.pilot.cargo } }));

  // ---- shipyard: buy the hauler
  await chat(a, '/tp dock');
  await sleep(1500);
  await a.keyboard.press('KeyF');
  await a.waitForFunction(() => window.__game.pred.mode === 2, null, { timeout: 15000, polling: 250 });
  await chat(a, '/credits 10000');
  await a.waitForFunction(() => document.querySelector('#station .yard button[data-op="buy"][data-key="hauler"]:not([disabled])'), null, { timeout: 10000, polling: 200 });
  await a.evaluate(() => document.querySelector('#station .st-yard').scrollIntoView());
  await shot(a, '01-shipyard.png', 500);
  await a.click('#station .yard button[data-op="buy"][data-key="hauler"]');
  await a.waitForFunction(() => window.__game.pilot.ship === 'hauler', null, { timeout: 10000, polling: 200 });
  console.log('bought:', await pilot(a));
  await a.click('#station button[data-act="undock"]');
  await a.waitForFunction(() => window.__game.pred.mode === 0, null, { timeout: 15000, polling: 250 });
  await shot(a, '02-hauler.png', 4000);
  // Bravo flies over and sees the hauler
  await chat(b, '/tp dock');
  const seen = () => b.evaluate(() => [...window.__game.remotes.values()].filter((r) => r.info?.name === 'Alpha').map((r) => ({ cls: r.view?.bp?.cls, radius: r.view?.radius, info: r.info?.bp?.cls })));
  try {
    await b.waitForFunction(() => [...window.__game.remotes.values()].some((r) => r.info?.name === 'Alpha' && r.view?.bp?.cls === 'hauler' && r.view.radius > 11), null, { timeout: Math.max(20000, STEP_MS), polling: 250 });
  } catch { errors.push(`Bravo does not see Alpha's hauler: ${JSON.stringify(await seen())}`); }
  await shot(b, '02b-hauler-seen.png', 500);

  // ---- the mining ship at an asteroid
  await chat(a, '/ship miner');
  await a.waitForFunction(() => window.__game.pilot.ship === 'miner', null, { timeout: 10000, polling: 200 });
  await chat(a, '/tp rock');
  await chat(a, '/god');
  await sleep(2500);
  // hold the trigger with the stick centred (a real mouse click would grab the pointer and steer)
  await a.evaluate(() => { const i = window.__game.input; i.centerCursor(); i.buttons |= 1; });
  await chat(a, '/tp rock');
  await a.waitForFunction(() => window.__game.pilot.cargo.ore + window.__game.pilot.cargo.crystal >= 2, null, { timeout: Math.max(30000, STEP_MS), polling: 250 });
  await shot(a, '03-mining.png', 300);
  await a.evaluate(() => { window.__game.input.buttons &= ~1; });
  console.log('mined:', (await pilot(a)).cargo);
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
