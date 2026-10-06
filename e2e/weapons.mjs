// Weapon modules in the browser: buy and fit them in the station arsenal, fire the railgun and the
// EMP at a pirate (keys 1 / 2 and auto-attack B), drop mines astern, then watch the arena bots use theirs.
// Usage: npm run build && node e2e/weapons.mjs   (screenshots land in e2e/out/weapons/)
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';

const LAUNCH = { headless: !process.env.E2E_HEADED, args: process.env.E2E_GPU ? ['--ignore-gpu-blocklist', '--enable-gpu'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] };
const PORT = 8096;
const OUT = new URL('./out/weapons/', import.meta.url).pathname;
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
  await page.goto(`http://localhost:${PORT}/?name=Gunner&autostart=1${QS}`);
  await page.waitForFunction(() => window.__game?.self && window.__game.pred.ready, null, { timeout: 90000, polling: 250 });
  const shot = async (file, wait = 800) => { await sleep(wait); await page.screenshot({ path: `${OUT}/${file}` }); console.log('screenshot', file); };
  const chat = (text) => page.evaluate((t) => window.__game.conn.chat(t), text);
  // count what the effects draw
  await page.evaluate(() => {
    const fx = window.__game.effects, seen = (window.__fx = { rail: 0, emp: 0, zap: 0 });
    for (const k of ['rail', 'emp', 'zap']) { const f = fx[k].bind(fx); fx[k] = (...a) => { seen[k]++; return f(...a); }; }
  });
  const fx = () => page.evaluate(() => ({ ...window.__fx }));
  const pilot = () => page.evaluate(() => window.__game.pilot);
  const dock = async () => {
    await chat('/tp dock');
    for (let k = 0; k < 20 && (await page.evaluate(() => window.__game.pred.mode)) !== 2; k++) { await sleep(700); await page.keyboard.press('KeyF'); }
    await page.waitForFunction(() => window.__game.pred.mode === 2, null, { timeout: 5000, polling: 200 });
  };

  // ---- the arsenal: buy the railgun and the EMP, they go straight into the two slots
  await chat('/credits 20000');
  await dock();
  await sleep(800);
  await page.click('.arms-list button[data-key="railgun"]');
  await sleep(600);
  await page.click('.arms-list button[data-key="emp"]');
  await sleep(600);
  await page.click('.arms-list button[data-key="mines"]');
  await page.waitForFunction(() => window.__game.pilot?.arms.owned.length === 3, null, { timeout: 5000, polling: 200 });
  let p = await pilot();
  if (JSON.stringify(p.arms.fits.fighter) !== '["railgun","emp"]') errors.push(`fit after buying: ${JSON.stringify(p.arms.fits)}`);
  await page.evaluate(() => document.querySelector('.st-arms')?.scrollIntoView());
  await shot('01-arsenal.png', 600);

  // ---- a pirate ahead: the railgun (1) and the EMP (2)
  await page.click('[data-act="undock"]');
  await page.waitForFunction(() => window.__game.pred.mode === 0, null, { timeout: 10000, polling: 200 });
  await chat('/tp open');
  await sleep(1500);
  await chat('/god');
  await chat('/pirate');
  await page.waitForFunction(() => [...window.__game.remotes.values()].some((r) => r.visible && r.info?.npc && r.info.kind === 1), null, { timeout: 15000, polling: 250 });
  await sleep(400);
  for (let k = 0; k < 10 && !(await page.evaluate(() => window.__game.targetId)); k++) { await page.keyboard.press('KeyT'); await sleep(400); }
  if (!(await page.evaluate(() => window.__game.targetId))) throw new Error('T picked no target');
  // auto-attack flies at it, fires the guns and the modules
  await page.keyboard.press('KeyB');
  let railShot = false;
  for (let k = 0; k < 40 && !railShot; k++) {
    await sleep(250);
    railShot = (await fx()).rail > 0;
    if (railShot) await shot('02-railgun.png', 60);
  }
  if (!railShot) {
    // the pirate dodges about: press 1 by hand with the nose roughly on it
    await page.keyboard.press('Digit1');
    await sleep(600);
    railShot = (await fx()).rail > 0;
    if (railShot) await shot('02-railgun.png', 0);
  }
  if (!railShot) errors.push('no railgun shot');
  // close in for the EMP: the pirate charges at us anyway
  let emp = false;
  for (let k = 0; k < 60 && !emp; k++) {
    await sleep(300);
    const d = await page.evaluate(() => { const g = window.__game, t = g.remotes.get(g.targetId); return t ? Math.hypot(t.p.x - g.shipW.p.x, t.p.y - g.shipW.p.y, t.p.z - g.shipW.p.z) : 1e9; });
    if (d < 380) await page.keyboard.press('Digit2');
    emp = (await fx()).emp > 0;
    if (emp) await shot('03-emp.png', 120);
  }
  if (!emp) errors.push('no EMP pulse');
  const slots = await page.evaluate(() => document.querySelector('.fp-mods')?.innerText);
  console.log('slots:', JSON.stringify(slots), 'effects:', await fx());
  if (!slots?.includes('РЛС') || !slots.includes('ЭМИ')) errors.push(`module slots not on the HUD: ${slots}`);
  await page.keyboard.press('KeyB');

  // ---- mines: swap the EMP for the mine layer, drop a few astern
  await chat('/arms railgun mines');
  await page.waitForFunction(() => JSON.stringify(window.__game.pilot?.arms.fits.fighter) === '["railgun","mines"]', null, { timeout: 5000, polling: 200 });
  await chat('/tp open');
  await sleep(1500);
  // drop three, a few seconds of flight apart, then turn round to look at them
  for (let k = 0; k < 3; k++) {
    await page.keyboard.press('Digit2');
    await page.keyboard.down('KeyW'); await sleep(900); await page.keyboard.up('KeyW');
    await page.keyboard.press('KeyX');
    await sleep(500);
  }
  await sleep(1500);
  const mines = await page.evaluate(() => [...window.__game.remotes.values()].filter((r) => r.info?.kind === 7).length);
  console.log('mines around:', mines);
  if (mines < 2) errors.push(`mines not in space (${mines})`);
  await page.mouse.move(VW * 0.95, VH / 2);
  await page.waitForFunction(() => {
    const g = window.__game, m = [...g.remotes.values()].filter((r) => r.info?.kind === 7 && r.visible);
    if (!m.length) return true;
    const s = g.shipW, q = s.q, fx = -2 * (q.x * q.z + q.w * q.y), fy = -2 * (q.y * q.z - q.w * q.x), fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
    const t = m[0], dx = t.p.x - s.p.x, dy = t.p.y - s.p.y, dz = t.p.z - s.p.z, d = Math.hypot(dx, dy, dz);
    return (dx * fx + dy * fy + dz * fz) / d > 0.97;
  }, null, { timeout: 15000, polling: 50 }).catch(() => errors.push('could not turn round to the mines'));
  await page.mouse.move(VW / 2, VH / 2);
  await page.keyboard.press('KeyX');
  await shot('04-mines.png', 1200);
  p = await pilot();
  if (p.arms.mines !== 6 - mines) errors.push(`mine magazine: ${p.arms.mines} after ${mines} mines`);

  // ---- the arena: bots carry modules and use them
  await dock();
  await page.click('.st-arena');
  await page.waitForFunction(() => window.__game.arenaHud.active && window.__game.arenaHud.armed, null, { timeout: 40000, polling: 300 });
  const before = await fx();
  let best = 0;
  for (let k = 0; k < 40; k++) {
    await sleep(1000);
    const now = await fx();
    const n = now.rail + now.emp - before.rail - before.emp;
    if (n > best) { best = n; await shot(`05-arena-${k}.png`, 0); }
    if (n >= 4) break;
  }
  console.log('arena module shots seen:', best);
  if (best < 1) errors.push('no module fire seen on the arena');
} catch (e) {
  errors.push(String(e?.stack ?? e));
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
