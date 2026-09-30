// Visual tour: low flight, landing and on-foot shots on several planet types.
// Usage: npm run build && node e2e/visuals.mjs   (screenshots in e2e/out/visuals/)
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';

const PORT = 8092;
const OUT = new URL('./out/visuals/', import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const server = spawn(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], {
  env: { ...process.env, PORT: String(PORT), DEV: '1', DB_PATH: `${OUT}/v.db` },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) break; } catch { /* starting */ }
  await sleep(200);
}
const errors = [];
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://localhost:${PORT}/?name=Tourist&autostart=1`);
  await page.waitForFunction(() => window.__game?.self && window.__game.pred.ready, null, { timeout: 60000, polling: 250 });
  const chat = (t) => page.evaluate((x) => window.__game.conn.chat(x), t);
  const mode = (m) => page.waitForFunction((x) => window.__game.pred.mode === x, m, { timeout: 20000, polling: 250 });
  const only = process.argv[2];
  const tour = [[0, 2, 'terran'], [0, 1, 'alien'], [0, 3, 'ice'], [0, 0, 'barren'], [1, 2, 'desert']];
  for (const [sys, idx, name] of tour) {
    if (only && only !== name) continue;
    if ((await page.evaluate(() => window.__game.sys.id)) !== sys) {
      await chat(`/system ${sys}`);
      await page.waitForFunction((s) => window.__game.sys.id === s && window.__game.pred.ready, sys, { timeout: 30000, polling: 250 });
    }
    await chat(`/tp low${idx}`);
    await sleep(9000);
    await page.screenshot({ path: `${OUT}/${name}-1-flight.png` });
    await chat(`/land ${idx}`);
    await sleep(9000);
    await page.screenshot({ path: `${OUT}/${name}-2-landed.png` });
    await page.keyboard.press('KeyG');
    await mode(1);
    await page.keyboard.down('KeyW');
    await page.keyboard.down('ShiftLeft');
    await sleep(2500);
    await page.screenshot({ path: `${OUT}/${name}-3-run.png` });
    await page.keyboard.up('ShiftLeft');
    await page.keyboard.up('KeyW');
    await page.keyboard.press('KeyG');
    await sleep(1500);
    console.log('done', name);
  }
  // surface sites: ruins and a pirate outpost
  if (!only || only === 'sites') {
    if ((await page.evaluate(() => window.__game.sys.id)) !== 0) {
      await chat('/system 0');
      await page.waitForFunction(() => window.__game.sys.id === 0 && window.__game.pred.ready, null, { timeout: 30000, polling: 250 });
    }
    await chat('/god');
    for (const [where, name] of [['ruin1', 'ruin-alien'], ['base1', 'base-alien'], ['ruin3', 'ruin-ice']]) {
      await chat(`/tp ${where}`);
      await sleep(9000);
      await page.screenshot({ path: `${OUT}/site-${name}.png` });
      console.log('done site', name);
    }
    await page.keyboard.press('KeyG');
    await mode(1);
    await page.keyboard.down('KeyW');
    await sleep(2500);
    await page.keyboard.up('KeyW');
    await page.screenshot({ path: `${OUT}/site-ruin-ice-foot.png` });
    await page.keyboard.press('KeyG');
    await sleep(1000);
    await chat('/god');
  }
  // world events spawned right in front of the ship
  if (!only || only === 'events') {
    await chat('/god');
    for (const kind of ['wreck', 'anomaly', 'convoy']) {
      await chat('/tp open');
      await sleep(1500);
      await chat(`/event ${kind}`);
      await sleep(kind === 'convoy' ? 1500 : 4000);
      await page.screenshot({ path: `${OUT}/event-${kind}.png` });
      console.log('done event', kind, await page.evaluate(() => document.querySelector('#announce b')?.textContent ?? ''));
    }
    await chat('/god');
  }
  // day/night: the same terran planet at dusk and at night
  if (!only || only === 'daynight') {
    if ((await page.evaluate(() => window.__game.sys.id)) !== 0) {
      await chat('/system 0');
      await page.waitForFunction(() => window.__game.sys.id === 0 && window.__game.pred.ready, null, { timeout: 30000, polling: 250 });
    }
    for (const when of ['dusk', 'night']) {
      await chat(`/land 2 ${when}`);
      await sleep(9000);
      await page.screenshot({ path: `${OUT}/terran-${when}-landed.png` });
      console.log('done', when, await page.evaluate(() => document.querySelector('.pp-time')?.textContent));
    }
  }
} catch (e) {
  errors.push(String(e.stack || e));
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
if (errors.length) { console.error('ERRORS:\n' + errors.join('\n')); process.exit(1); }
console.log('visual tour OK');
