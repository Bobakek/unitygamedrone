// End-to-end smoke test: starts the server, drives two browser clients and saves screenshots.
// Usage: npm run build && npm run e2e   (screenshots land in e2e/out/)
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';

const PORT = 8090;
const OUT = new URL('./out/', import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const server = spawn(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], {
  env: { ...process.env, PORT: String(PORT), DEV: '1', DB_PATH: `${OUT}/e2e.db` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitHealth() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('server did not start');
}

const errors = [];
let browser;
try {
  await waitHealth();
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

  async function open(name) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
    await page.goto(`http://localhost:${PORT}/?name=${name}&autostart=1`);
    await page.waitForFunction(() => window.__game?.self && window.__game.pred.ready, null, { timeout: 60000, polling: 250 });
    return page;
  }
  const shot = async (page, file, wait = 2500) => {
    await sleep(wait);
    await page.screenshot({ path: `${OUT}/${file}` });
    console.log('screenshot', file);
  };
  const chat = (page, text) => page.evaluate((t) => window.__game.conn.chat(t), text);
  const mode = (page) => page.evaluate(() => window.__game.pred.mode);

  const a = await open('Alpha');
  await page_keyHelp(a);
  await shot(a, '01-space-station.png', 4000);

  await chat(a, '/tp 1');
  await shot(a, '02-planet-orbit.png', 6000);

  await chat(a, '/land 1');
  await shot(a, '03-landed.png', 7000);

  await a.keyboard.press('KeyG');
  await a.waitForFunction(() => window.__game.pred.mode === 1, null, { timeout: 15000, polling: 250 });
  await shot(a, '04-on-foot.png', 4000);
  await a.keyboard.down('KeyW');
  await sleep(2500);
  await a.keyboard.up('KeyW');
  await shot(a, '05-walking.png', 800);
  // harvest the nearest node if we are standing next to one
  const harvested = await a.evaluate(() => {
    const g = window.__game;
    const nodes = g.props.visibleNodes;
    if (!nodes.length) return 'no nodes';
    const n = nodes.reduce((b, x) => (Math.hypot(x.pos.x - g.charPos.x, x.pos.y - g.charPos.y, x.pos.z - g.charPos.z) < Math.hypot(b.pos.x - g.charPos.x, b.pos.y - g.charPos.y, b.pos.z - g.charPos.z) ? x : b));
    return `nearest node ${Math.round(Math.hypot(n.pos.x - g.charPos.x, n.pos.y - g.charPos.y, n.pos.z - g.charPos.z))} m (${nodes.length} visible)`;
  });
  console.log('resources:', harvested);

  await a.keyboard.press('KeyG');
  await a.waitForFunction(() => window.__game.pred.mode === 0, null, { timeout: 15000, polling: 250 });
  console.log('boarded ship, mode', await mode(a));

  // second pilot joins at the station; Alpha returns there too
  await chat(a, '/tp station');
  const b = await open('Bravo');
  await sleep(2000);
  const seen = await b.evaluate(() => [...window.__game.remotes.values()].filter((r) => r.info && !r.info.npc && r.info.kind === 1).map((r) => r.info.name));
  console.log('Bravo sees players:', seen);
  if (!seen.includes('Alpha')) errors.push('Bravo does not see Alpha');
  await shot(b, '06-two-pilots.png', 1500);

  // combat: Alpha goes near a planet (outside the safe zone), spawns a pirate and fights it
  await chat(a, '/tp field');
  await sleep(1500);
  await chat(a, '/god');
  await chat(a, '/pirate');
  await sleep(1500);
  await a.keyboard.press('KeyT');
  await a.mouse.move(640, 360);
  await a.mouse.down();
  await shot(a, '07-combat.png', 2500);
  await a.mouse.up();
  const fx = await a.evaluate(() => ({ bolts: window.__game.effects.bolts.length, target: window.__game.targetId }));
  console.log('combat state', fx);

  await chat(a, '/tp dock');
  await sleep(1500);
  await a.keyboard.press('KeyF');
  await a.waitForFunction(() => window.__game.pred.mode === 2, null, { timeout: 15000, polling: 250 });
  await shot(a, '08-docked.png', 2000);

  await a.click('#station button.primary');
  await a.waitForFunction(() => window.__game.pred.mode === 0, null, { timeout: 15000, polling: 250 });
  const sys0 = await a.evaluate(() => window.__game.sys.id);
  await chat(a, '/tp gate');
  await sleep(1500);
  await a.keyboard.press('KeyF');
  await a.waitForFunction((s0) => window.__game.sys.id !== s0 && window.__game.pred.ready, sys0, { timeout: 20000, polling: 250 });
  console.log('jumped from system', sys0, 'to', await a.evaluate(() => `${window.__game.sys.id} (${window.__game.sys.name})`));
  await shot(a, '09-new-system.png', 4000);

  const perf = await a.evaluate(() => ({ chunks: window.__game.planets.map((p) => p.chunks) }));
  console.log('planet chunks visible:', perf.chunks);
} catch (e) {
  errors.push(`fatal: ${e.stack || e}`);
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}

async function page_keyHelp(page) {
  await page.keyboard.press('KeyH');
  await sleep(300);
  await page.screenshot({ path: `${OUT}/00-help.png` });
  await page.keyboard.press('KeyH');
}

if (errors.length) {
  console.error('E2E FAILED:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('E2E OK');
