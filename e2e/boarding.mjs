// Boarding in the browser: a disabled pirate smoking in space, docking with it, the fight with its crew
// on its deck, the strongbox and the helm, back to the ship, and the prize sold at the shipyard.
// Usage: npm run build && node e2e/boarding.mjs   (screenshots land in e2e/out/boarding/)
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';

const LAUNCH = { headless: !process.env.E2E_HEADED, args: process.env.E2E_GPU ? ['--ignore-gpu-blocklist', '--enable-gpu'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] };
const PORT = 8094;
const OUT = new URL('./out/boarding/', import.meta.url).pathname;
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
  const page = await browser.newPage({ viewport: { width: VW, height: VH } });
  page.setDefaultTimeout(STEP_MS);
  page.on('pageerror', (e) => errors.push(`page: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.goto(`http://localhost:${PORT}/?name=Corsair&autostart=1${QS}`);
  await page.waitForFunction(() => window.__game?.self && window.__game.pred.ready, null, { timeout: 90000, polling: 250 });
  const shot = async (file, wait = 1500) => { await sleep(wait); await page.screenshot({ path: `${OUT}/${file}` }); console.log('screenshot', file); };
  const chat = (text) => page.evaluate((t) => window.__game.conn.chat(t), text);
  const mode = () => page.evaluate(() => window.__game.pred.mode);
  const aboard = () => page.evaluate(() => ({ ...window.__game.aboard }));

  // ---- a pirate knocked out ahead: smoke, a label, the prompt; F docks with it
  await chat('/tp open');
  await sleep(1500);
  await chat('/god');
  await chat('/disable');
  await page.waitForFunction(() => [...window.__game.remotes.values()].some((r) => r.state && r.state.flags & 128), null, { timeout: 15000, polling: 250 });
  await shot('01-disabled.png', 2500);
  await page.keyboard.press('KeyF');
  await page.waitForFunction(() => window.__game.pred.mode === 6 && window.__game.aboard.id > 0, null, { timeout: 15000, polling: 250 });
  await shot('02-airlock.png', 2500);
  console.log('aboard:', await aboard());

  // ---- the fight: walk into the corridor, the crew comes; we shoot back
  await chat('/aboard corridor');
  await sleep(2500);
  await page.evaluate(() => { const g = window.__game; g.input.locked = true; });
  const crewHurt = await page.evaluate(async () => {
    const g = window.__game;
    // turn towards the nearest living crewman and fire for a while
    const t0 = performance.now();
    while (performance.now() - t0 < 9000) {
      let best = null, bd = 1e9;
      for (const r of g.remotes.values()) {
        if (r.state?.frame !== 254 || !r.info?.npc || r.state.flags & 64) continue;
        const d = Math.hypot(r.bp.x - g.pred.char.p.x, r.bp.z - g.pred.char.p.z);
        if (d < bd) { bd = d; best = r; }
      }
      if (best) {
        const c = g.pred.char, want = Math.atan2(best.bp.x - c.p.x, best.bp.z - c.p.z), have = Math.atan2(c.f.x, c.f.z);
        let d = want - have; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
        g.ctrl.yawAcc = -d;
        g.ctrl.footPitch = Math.atan2(1.05 - 1.45, Math.max(1, bd));
        g.input.buttons |= 1;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    g.input.buttons &= ~1;
    return [...g.remotes.values()].filter((r) => r.state?.frame === 254 && r.info?.npc).map((r) => Math.round(r.state.hull * 100));
  });
  console.log('crew hull after the firefight (%):', crewHurt);
  await shot('03-firefight.png', 200);
  if (!crewHurt.length) errors.push('no crew seen aboard');

  // ---- clear the rest, empty the strongbox, take the helm
  await chat('/aboard clear');
  await page.waitForFunction(() => window.__game.aboard.crew === 0, null, { timeout: 10000, polling: 200 });
  await chat('/aboard chest');
  await sleep(1500);
  const before = await page.evaluate(() => window.__game.pilot.credits);
  await page.keyboard.press('KeyF');
  await page.waitForFunction(() => window.__game.aboard.looted || window.__game.pilot.credits > 0, null, { timeout: 10000, polling: 200 });
  await shot('04-strongbox.png', 1500);
  console.log('credits', before, '->', await page.evaluate(() => window.__game.pilot.credits));
  await chat('/aboard helm');
  await sleep(1500);
  await shot('05-bridge.png', 500);
  await page.keyboard.press('KeyF');
  await page.waitForFunction(() => window.__game.aboard.claimed && window.__game.pilot.prizes.length === 1, null, { timeout: 10000, polling: 200 });
  await shot('06-claimed.png', 800);

  // ---- back through the airlock: the prize crew takes the ship away
  await chat('/aboard hatch');
  await sleep(1200);
  await page.keyboard.press('KeyG');
  await page.waitForFunction(() => window.__game.pred.mode === 0, null, { timeout: 10000, polling: 200 });
  await shot('07-back-in-ship.png', 2000);

  // ---- the shipyard buys the prize
  await chat('/tp dock');
  await sleep(1500);
  await page.keyboard.press('KeyF');
  await page.waitForFunction(() => window.__game.pred.mode === 2, null, { timeout: 15000, polling: 250 });
  await page.waitForFunction(() => document.querySelector('#station .yard-prizes button[data-act="prize"]'), null, { timeout: 10000, polling: 200 });
  await page.evaluate(() => document.querySelector('#station .st-yard').scrollIntoView());
  await shot('08-prize-at-shipyard.png', 500);
  const credits = await page.evaluate(() => window.__game.pilot.credits);
  await page.click('#station .yard-prizes button[data-act="prize"]');
  await page.waitForFunction((c) => window.__game.pilot.prizes.length === 0 && window.__game.pilot.credits > c, credits, { timeout: 10000, polling: 200 });
  console.log('sold the prize:', credits, '->', await page.evaluate(() => window.__game.pilot.credits));
  if ((await mode()) !== 2) errors.push('not docked at the end');
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
