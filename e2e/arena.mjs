// Arena 3×3 in the browser: sign up at the station, the warm-up at the team gate, the fight with bots, the score.
// Usage: npm run build && node e2e/arena.mjs   (screenshots land in e2e/out/arena/)
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';

const LAUNCH = { headless: !process.env.E2E_HEADED, args: process.env.E2E_GPU ? ['--ignore-gpu-blocklist', '--enable-gpu'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] };
const PORT = 8093;
const OUT = new URL('./out/arena/', import.meta.url).pathname;
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
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://localhost:${PORT}/?name=Arena&autostart=1${QS}`);
  await page.waitForFunction(() => window.__game?.self && window.__game.pred.ready, null, { timeout: 90000, polling: 250 });
  const shot = async (file, wait = 1200) => { await sleep(wait); await page.screenshot({ path: `${OUT}/${file}` }); console.log('screenshot', file); };
  const chat = (text) => page.evaluate((t) => window.__game.conn.chat(t), text);
  const arena = () => page.evaluate(() => window.__game.arenaHud.state);

  await chat('/tp dock');
  for (let i = 0; i < 10 && !(await page.evaluate(() => window.__game.pred.mode === 2)); i++) {
    await sleep(1500);
    await page.evaluate(() => window.__game.conn.action({ a: 'dock' }));
  }
  await page.waitForFunction(() => window.__game.pred.mode === 2, null, { timeout: 15000, polling: 250 });
  await page.click('#station .st-arena');
  await page.waitForFunction(() => window.__game.arenaHud.state.phase === 'queue', null, { timeout: 10000, polling: 200 });
  await shot('01-queue.png', 300);
  await page.waitForFunction(() => window.__game.arenaHud.state.phase === 'warmup' && window.__game.pred.mode === 0, null, { timeout: 20000, polling: 200 });
  await shot('02-warmup.png', 2500);
  await page.waitForFunction(() => window.__game.arenaHud.state.phase === 'fight', null, { timeout: 15000, polling: 200 }).catch(async (e) => { console.log(JSON.stringify(await arena())); throw e; });
  // into the fight, guns blazing (the dev /god keeps the pilot alive for the pictures); a little
  // autopilot in the page steers at the nearest enemy, like a player would with the mouse
  await chat('/god');
  await page.evaluate(() => {
    const g = window.__game;
    window.__aim = setInterval(() => {
      const me = g.shipW, team = g.arenaHud.state.team;
      let best = null, bd = Infinity;
      for (const [id, r] of g.remotes) {
        if (!r.visible || r.info?.kind !== 1 || g.arenaHud.teamOf(id) === undefined || g.arenaHud.teamOf(id) === team) continue;
        const d = Math.hypot(r.p.x - me.p.x, r.p.y - me.p.y, r.p.z - me.p.z);
        if (d < bd) { bd = d; best = r; }
      }
      if (!best) return;
      const q = me.q, x = best.p.x - me.p.x, y = best.p.y - me.p.y, z = best.p.z - me.p.z;
      // world → ship-local (inverse rotation)
      const ix = -q.x, iy = -q.y, iz = -q.z, w = q.w;
      const tx = 2 * (iy * z - iz * y), ty = 2 * (iz * x - ix * z), tz = 2 * (ix * y - iy * x);
      const lx = x + w * tx + (iy * tz - iz * ty), ly = y + w * ty + (iz * tx - ix * tz), lz = z + w * tz + (ix * ty - iy * tx);
      const yaw = Math.atan2(lx, -lz), pitch = Math.atan2(ly, Math.hypot(lx, lz));
      g.input.vx = Math.max(-1, Math.min(1, yaw * 2.5));
      g.input.vy = Math.max(-1, Math.min(1, -pitch * 2.5));
      g.ctrl.throttle = bd > 600 ? 0.9 : 0.35;
    }, 50);
  });
  await page.mouse.down();
  for (let i = 0; i < 8; i++) {
    await shot(`03-fight-${i}.png`, 1600);
  }
  await page.mouse.up();
  await page.keyboard.down('Tab');
  await shot('04-score.png', 400);
  await page.keyboard.up('Tab');
  console.log('arena:', JSON.stringify(await arena()));
  await page.evaluate(() => clearInterval(window.__aim));
  await chat('/god');
  // the bots settle it; the score screen at the end, then back at the station
  await page.waitForFunction(() => window.__game.arenaHud.state.phase === 'over', null, { timeout: 400000, polling: 500 });
  await shot('05-over.png', 1500);
  await page.waitForFunction(() => window.__game.pred.mode === 2 && window.__game.arenaHud.state.phase === 'none', null, { timeout: 30000, polling: 300 });
  await shot('06-back.png', 1000);
} catch (e) {
  errors.push(String(e?.stack ?? e));
} finally {
  await browser?.close();
  server.kill();
}
if (errors.length) { console.error('ERRORS:\n' + errors.join('\n')); process.exit(1); }
console.log('ok');
