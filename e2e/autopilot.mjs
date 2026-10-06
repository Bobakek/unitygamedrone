// Auto-approach in the browser: T on a pirate, U flies to gun range and holds it with the nose on the
// target; any stick input hands the ship back; U on the station nav point brings the ship in to dock.
// Usage: npm run build && node e2e/autopilot.mjs   (screenshots land in e2e/out/autopilot/)
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';

const LAUNCH = { headless: !process.env.E2E_HEADED, args: process.env.E2E_GPU ? ['--ignore-gpu-blocklist', '--enable-gpu'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] };
const PORT = 8095;
const OUT = new URL('./out/autopilot/', import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const [VW, VH] = (process.env.E2E_VIEWPORT ?? '1280x720').split('x').map(Number);
const QS = `&q=${process.env.E2E_Q ?? 'low'}`;

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
  const page = await browser.newPage({ viewport: { width: VW, height: VH } });
  page.setDefaultTimeout(30000);
  page.on('pageerror', (e) => errors.push(`page: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.goto(`http://localhost:${PORT}/?name=Ace&autostart=1${QS}`);
  await page.waitForFunction(() => window.__game?.self && window.__game.pred.ready, null, { timeout: 90000, polling: 250 });
  const shot = async (file, wait = 800) => { await sleep(wait); await page.screenshot({ path: `${OUT}/${file}` }); console.log('screenshot', file); };
  const chat = (text) => page.evaluate((t) => window.__game.conn.chat(t), text);
  // distance to the target and how well the nose points at it (cosine)
  const geo = () => page.evaluate(() => {
    const g = window.__game, t = g.remotes.get(g.targetId), s = g.shipW;
    if (!t) return null;
    const dx = t.p.x - s.p.x, dy = t.p.y - s.p.y, dz = t.p.z - s.p.z, d = Math.hypot(dx, dy, dz);
    const q = s.q, fx = -2 * (q.x * q.z + q.w * q.y), fy = -2 * (q.y * q.z - q.w * q.x), fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
    return { d: Math.round(d), facing: +((dx * fx + dy * fy + dz * fz) / d).toFixed(2), auto: !!g.auto };
  });

  // ---- a pirate ahead: pick it with T, U flies in and holds about 600 m
  await chat('/tp open');
  await sleep(1500);
  await chat('/god');
  await chat('/pirate');
  await page.waitForFunction(() => [...window.__game.remotes.values()].some((r) => r.visible && r.info?.npc && r.info.kind === 1), null, { timeout: 15000, polling: 250 });
  await sleep(500);
  for (let k = 0; k < 10 && !(await page.evaluate(() => window.__game.targetId)); k++) { await page.keyboard.press('KeyT'); await sleep(500); }
  if (!(await page.evaluate(() => window.__game.targetId))) throw new Error('T picked no target');
  console.log('target picked:', await geo());
  await shot('01-target.png', 300);
  await page.keyboard.press('KeyU');
  await page.waitForFunction(() => !!window.__game.auto, null, { timeout: 3000, polling: 100 });
  const track = [];
  for (let k = 0; k < 20; k++) { await sleep(1000); track.push(await geo()); }
  console.log('approach:', track.map((g) => g && `${g.d}м/${g.facing}`).join(' '));
  const last = track.slice(-6).filter(Boolean);
  if (!last.length) errors.push('target lost during approach');
  else {
    const avg = last.reduce((a, g) => a + g.d, 0) / last.length;
    if (avg < 300 || avg > 1100) errors.push(`did not hold gun range (avg ${Math.round(avg)} m)`);
    if (last.filter((g) => g.facing > 0.8).length < last.length / 2) errors.push('nose was not on the target');
  }
  await shot('02-holding.png', 0);

  // ---- the pilot grabs the controls: auto-approach lets go
  await page.keyboard.down('KeyW');
  await sleep(150);
  await page.keyboard.up('KeyW');
  await sleep(300);
  if (await page.evaluate(() => !!window.__game.auto)) errors.push('W did not switch auto-approach off');

  // ---- station from the nav list: auto-approach brings the ship into docking range, F docks
  await chat('/pirate');
  await chat('/tp field');
  await sleep(2000);
  await page.evaluate(() => { const g = window.__game; g.targetId = 0; g.navIndex = g.navItems.findIndex((n) => n.kind === 'station'); });
  const far = await page.evaluate(() => Math.round(Math.hypot(...['x', 'y', 'z'].map((k) => window.__game.shipW.p[k] - window.__game.sys.station.pos[k]))));
  console.log('station distance before:', far);
  await page.keyboard.press('KeyU');
  await page.waitForFunction(() => !!window.__game.auto, null, { timeout: 3000, polling: 100 });
  await shot('03-to-station.png', 4000);
  await page.waitForFunction(() => window.__game.auto?.arrived, null, { timeout: 120000, polling: 500 });
  await shot('04-at-station.png', 1500);
  await page.keyboard.press('KeyF');
  await page.waitForFunction(() => window.__game.pred.mode === 2, null, { timeout: 15000, polling: 250 });
  console.log('docked after auto-approach');
} catch (e) {
  errors.push(`fatal: ${e.stack || e}`);
  try { errors.push('chat: ' + (await browser.contexts()[0].pages()[0].evaluate(() => document.getElementById('chat-log')?.innerText.slice(-600)))); } catch { /* gone */ }
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}

if (errors.length) {
  console.error('E2E FAILED:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('E2E OK');
