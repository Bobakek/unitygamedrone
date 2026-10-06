// Storming a pirate base in the browser: the outpost with its force dome and shield generator, the defences
// knocked out, the blast door, the fight with the garrison in the bunker, the capture console, the armory,
// back out to the yard of a held base, and a pirate raid on it.
// Usage: npm run build && node e2e/base-assault.mjs   (screenshots land in e2e/out/base-assault/)
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';

const LAUNCH = { headless: !process.env.E2E_HEADED, args: process.env.E2E_GPU ? ['--ignore-gpu-blocklist', '--enable-gpu'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] };
const PORT = 8095;
const OUT = new URL('./out/base-assault/', import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const [VW, VH] = (process.env.E2E_VIEWPORT ?? '1280x720').split('x').map(Number);
const QS = `&q=${process.env.E2E_Q ?? 'low'}`;
const STEP_MS = Number(process.env.E2E_TIMEOUT ?? 30000);
const PLANET = Number(process.env.E2E_PLANET ?? 1);

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
  await page.goto(`http://localhost:${PORT}/?name=Stormer&autostart=1${QS}`);
  await page.waitForFunction(() => window.__game?.self && window.__game.pred.ready, null, { timeout: 90000, polling: 250 });
  const shot = async (file, wait = 1500) => { await sleep(wait); await page.screenshot({ path: `${OUT}/${file}` }); console.log('screenshot', file); };
  const chat = (text) => page.evaluate((t) => window.__game.conn.chat(t), text);
  const base = () => page.evaluate((pl) => window.__game.bases.find((b) => b.planet === pl), PLANET);
  const status = () => page.evaluate(() => document.querySelector('.pp-base')?.textContent ?? '');

  // ---- the outpost from the air: towers, the shield generator, the dome over the bunker
  await chat('/god');
  await chat(`/tp base${PLANET} day`);
  await page.waitForFunction(() => window.__game.bases.length > 0, null, { timeout: 15000, polling: 250 });
  // hover high over the gate so the whole base is in view
  await page.evaluate(() => { const g = window.__game; g.ctrl.throttle = 0; });
  await shot('01-outpost.png', 6000);
  console.log('base:', JSON.stringify(await base()), '|', await status());
  if (!(await base())?.shield) errors.push('the base has no shield at the start');

  // ---- defences knocked out: the dome goes down
  await chat('/base open');
  await page.waitForFunction((pl) => window.__game.bases.find((b) => b.planet === pl)?.state === 'open', PLANET, { timeout: 10000, polling: 200 });
  await shot('02-defences-down.png', 2500);

  // ---- at the blast door on foot
  await chat('/base door');
  await page.waitForFunction(() => window.__game.pred.mode === 1, null, { timeout: 10000, polling: 200 });
  await shot('03-blast-door.png', 4000);
  const prompt = await page.evaluate(() => document.querySelector('#prompt')?.textContent ?? document.querySelector('.prompt')?.textContent ?? '');
  console.log('prompt at the door:', prompt);
  await page.keyboard.press('KeyF');
  await page.waitForFunction(() => window.__game.pred.mode === 6 && window.__game.aboard.base, null, { timeout: 15000, polling: 250 });
  await shot('04-lift.png', 3000);
  console.log('aboard:', JSON.stringify(await page.evaluate(() => window.__game.aboard)));

  // ---- the garrison comes; shoot back for a while
  await chat('/aboard hall');
  await sleep(2000);
  await page.evaluate(() => { window.__game.input.locked = true; });
  const hurt = await page.evaluate(async () => {
    const g = window.__game;
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
  console.log('garrison hull after the firefight (%):', hurt);
  await shot('05-firefight.png', 200);
  if (!hurt.length) errors.push('no garrison seen in the bunker');

  // ---- the rest of the garrison, the console, the armory
  await chat('/aboard clear');
  await page.waitForFunction(() => window.__game.aboard.crew === 0, null, { timeout: 10000, polling: 200 });
  await chat('/aboard helm');
  await sleep(1500);
  await shot('06-command-post.png', 800);
  await page.keyboard.press('KeyF');
  await page.waitForFunction((pl) => window.__game.bases.find((b) => b.planet === pl)?.state === 'held', PLANET, { timeout: 10000, polling: 200 });
  await shot('07-captured.png', 1500);
  console.log('held:', await status());
  await chat('/aboard chest');
  await sleep(1500);
  await page.keyboard.press('KeyF');
  await page.waitForFunction(() => window.__game.aboard.looted, null, { timeout: 10000, polling: 200 });
  await shot('08-armory.png', 1500);

  // ---- up the lift: the yard of a held base, our towers, the flag
  await chat('/aboard hatch');
  await sleep(1200);
  await page.keyboard.press('KeyG');
  await page.waitForFunction(() => window.__game.pred.mode === 1, null, { timeout: 10000, polling: 200 });
  await shot('09-held-yard.png', 5000);

  // ---- a raid: back in the air over the base, the towers shoot at the raiders
  await chat(`/tp base${PLANET} day`);
  await sleep(2500);
  await chat('/base raid');
  await page.waitForFunction((pl) => (window.__game.bases.find((b) => b.planet === pl)?.raid ?? 0) > 0, PLANET, { timeout: 10000, polling: 200 });
  await shot('10-raid.png', 12000);
  console.log('after the raid started:', await status());
  if ((await base())?.state !== 'held') errors.push('the base fell too quickly');
} catch (e) {
  errors.push(`fatal: ${e.stack || e}`);
  try { errors.push('chat: ' + (await browser.contexts()[0].pages()[0].evaluate(() => document.getElementById('chat-log')?.innerText.slice(-800)))); } catch { /* gone */ }
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}

if (errors.length) {
  console.error('E2E FAILED:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('E2E OK');
