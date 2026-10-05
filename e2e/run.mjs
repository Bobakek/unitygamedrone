// End-to-end smoke test: starts the server, drives two browser clients and saves screenshots.
// Usage: npm run build && npm run e2e   (screenshots land in e2e/out/)
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';
// E2E_GPU=1 renders on the real GPU (a local machine), otherwise software WebGL (CI, containers); E2E_HEADED=1 shows the window.
const LAUNCH = { headless: !process.env.E2E_HEADED, args: process.env.E2E_GPU ? ['--ignore-gpu-blocklist', '--enable-gpu'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] };

const PORT = 8090;
const OUT = new URL('./out/', import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
// On a slow software renderer: E2E_Q=low (graphics preset), E2E_VIEWPORT=960x540, E2E_TIMEOUT=120000 (ms per step).
const [VW, VH] = (process.env.E2E_VIEWPORT ?? '1280x720').split('x').map(Number);
const QS = process.env.E2E_Q ? `&q=${process.env.E2E_Q}` : '';
const STEP_MS = Number(process.env.E2E_TIMEOUT ?? 30000);

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
  browser = await chromium.launch(LAUNCH);

  async function open(name, extra = '') {
    const page = await browser.newPage({ viewport: { width: VW, height: VH } });
    page.setDefaultTimeout(STEP_MS);
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
    await page.goto(`http://localhost:${PORT}/?name=${name}&autostart=1${QS}${extra}`);
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

  await chat(a, '/tp low1');
  await shot(a, '02b-low-altitude.png', 7000);

  await chat(a, '/land 1');
  await shot(a, '03-landed.png', 7000);
  // the landed ship sits still in the planet's rotating frame while moving through world space
  const ride = await a.evaluate(async () => {
    const g = window.__game;
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await frame();
    const b0 = { ...g.pred.ship.p }, w0 = { ...g.shipPos };
    await new Promise((r) => setTimeout(r, 2000));
    await frame();
    const b1 = g.pred.ship.p, w1 = g.shipPos;
    return { frame: g.pred.ship.frame, body: Math.hypot(b1.x - b0.x, b1.y - b0.y, b1.z - b0.z), world: Math.hypot(w1.x - w0.x, w1.y - w0.y, w1.z - w0.z) };
  });
  console.log('landed ride:', JSON.stringify(ride));
  if (!ride.frame || ride.body > 0.01 || ride.world < 1) errors.push(`landed ship does not ride the planet: ${JSON.stringify(ride)}`);

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
    const c = g.charPosB; // node positions are in the planet's body frame
    const dist = (x) => Math.hypot(x.pos.x - c.x, x.pos.y - c.y, x.pos.z - c.z);
    const n = nodes.reduce((b, x) => (dist(x) < dist(b) ? x : b));
    return `nearest node ${Math.round(dist(n))} m (${nodes.length} visible)`;
  });
  console.log('resources:', harvested);

  await a.keyboard.press('KeyG');
  await a.waitForFunction(() => window.__game.pred.mode === 0, null, { timeout: 15000, polling: 250 });
  console.log('boarded ship, mode', await mode(a));

  // second pilot joins at the station; Alpha returns there too.
  // Software rendering is CPU-bound, so Alpha drops to low quality via the settings menu meanwhile.
  await chat(a, '/tp station');
  const setQuality = async (page, q) => {
    await page.keyboard.press('KeyO');
    await page.click(`#set-quality button[data-q="${q}"]`);
    await page.click('#set-close');
  };
  await setQuality(a, 'low');
  const b = await open('Bravo', '&q=low');
  await sleep(2000);
  const seen = await b.evaluate(() => [...window.__game.remotes.values()].filter((r) => r.info && !r.info.npc && r.info.kind === 1).map((r) => r.info.name));
  console.log('Bravo sees players:', seen);
  if (!seen.includes('Alpha')) errors.push('Bravo does not see Alpha');
  await shot(b, '06-two-pilots.png', 1500);
  await b.close();
  await setQuality(a, 'high');

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

  // wardrobe: buy oxygen tanks, they are worn at once
  await chat(a, '/credits 2000');
  await a.evaluate(() => document.querySelector('#station button[data-act="wardrobe"]').click());
  await a.waitForFunction(() => !document.querySelector('#wardrobe').classList.contains('hidden'), null, { timeout: 10000, polling: 200 });
  await a.evaluate(() => document.querySelector('.wd-tabs button[data-slot="pack"]').click());
  await a.evaluate(() => document.querySelector('.wd-item[data-id="pack-o2"] button[data-do="buy"]').click());
  await a.waitForFunction(() => window.__game.pilot.outfit.pack === 'pack-o2', null, { timeout: 10000, polling: 200 });
  await shot(a, '08b-wardrobe.png', 3000);
  console.log('wardrobe: bought', await a.evaluate(() => window.__game.pilot.items.join(',')));
  await a.evaluate(() => document.querySelector('.wd-close').click());

  // contracts: take an offer from the station board, it shows in the HUD, finish it (dev) for the reward
  await a.evaluate(() => document.querySelector('#station button[data-act="contracts"]').click());
  await a.waitForFunction(() => !document.querySelector('#contracts').classList.contains('hidden') && document.querySelector('#contracts button[data-take]'), null, { timeout: 30000, polling: 250 });
  const taken = await a.evaluate(() => { const b = document.querySelector('#contracts button[data-take]'); b.click(); return b.dataset.take; });
  await a.waitForFunction((id) => window.__game.pilot.career.active.some((c) => c.id === id), taken, { timeout: 15000, polling: 250 });
  await a.evaluate(() => document.querySelector('#contracts button[data-tab="mine"]').click());
  await shot(a, '08c-contracts.png', 2000);
  if (await a.evaluate(() => document.querySelectorAll('.pp-tasks .pp-task').length) !== 1) errors.push('contract not shown in the HUD tracker');
  const before = await a.evaluate(() => ({ credits: window.__game.pilot.credits, reward: window.__game.pilot.career.active[0].reward }));
  await chat(a, '/finish');
  await a.waitForFunction((id) => window.__game.pilot.career.done.includes(id), taken, { timeout: 15000, polling: 250 });
  const after = await a.evaluate(() => ({ credits: window.__game.pilot.credits, xp: window.__game.pilot.career.xp }));
  console.log('contract', taken, 'done:', JSON.stringify({ before, after }));
  if (after.credits !== before.credits + before.reward.credits || after.xp !== before.reward.xp) errors.push('contract reward not paid');
  await a.evaluate(() => document.querySelector('#contracts .ct-close').click());

  // the station inside: step out into the hangar, use the contracts terminal on the promenade, board again
  await a.evaluate(() => document.querySelector('#station button[data-act="disembark"]').click());
  await a.waitForFunction(() => window.__game.pred.mode === 4, null, { timeout: STEP_MS, polling: 250 });
  // without pointer lock the cursor's offset from the centre steers the view: keep it centred
  await a.mouse.move(VW / 2, VH / 2);
  await shot(a, '08d-hangar.png', 3000);
  await chat(a, '/deck contracts');
  await sleep(1500);
  await a.keyboard.press('KeyF');
  await a.waitForFunction(() => !document.querySelector('#contracts').classList.contains('hidden'), null, { timeout: STEP_MS, polling: 250 });
  await a.evaluate(() => document.querySelector('#contracts .ct-close').click());
  await shot(a, '08e-promenade.png', 1500);
  await chat(a, '/deck ramp');
  await sleep(1500);
  await a.keyboard.press('KeyG');
  await a.waitForFunction(() => window.__game.pred.mode === 2, null, { timeout: STEP_MS, polling: 250 });
  console.log('station deck: walked to the contracts terminal and back on board');

  await a.click('#station button.primary');
  await a.waitForFunction(() => window.__game.pred.mode === 0, null, { timeout: 15000, polling: 250 });
  const sys0 = await a.evaluate(() => window.__game.sys.id);
  await chat(a, '/tp gate');
  // the client offers the jump once its own ship is at the gate (slow renderers take a while to get there)
  await a.waitForFunction(() => { const el = document.querySelector('#prompt'); return el.style.display !== 'none' && el.textContent.includes('прыжок'); }, null, { timeout: Math.max(20000, STEP_MS), polling: 250 });
  await a.keyboard.press('KeyF');
  await a.waitForFunction((s0) => window.__game.sys.id !== s0 && window.__game.pred.ready, sys0, { timeout: Math.max(20000, STEP_MS), polling: 250 });
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
