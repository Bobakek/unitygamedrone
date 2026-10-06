// Galaxy events in the browser: a raid at the station, a shortage on the market and the contract board, a meteor storm.
// Usage: npm run build && node e2e/galaxy-events.mjs   (screenshots land in e2e/out/galaxy-events/)
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';

const LAUNCH = { headless: !process.env.E2E_HEADED, args: process.env.E2E_GPU ? ['--ignore-gpu-blocklist', '--enable-gpu'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] };
const PORT = 8094;
const OUT = new URL('./out/galaxy-events/', import.meta.url).pathname;
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
  const events = (page) => page.evaluate(() => window.__game.galaxyEvents.map((e) => ({ ...e })));

  const a = await open('Alpha');

  // ---- raid: a banner, raiders around the station, news on the galaxy map
  await chat(a, '/gevent raid 10');
  await a.waitForFunction(() => window.__game.galaxyEvents.some((e) => e.kind === 'raid' && e.system === window.__game.sys.id), null, { timeout: 10000, polling: 200 });
  await chat(a, '/tp dock');
  await a.waitForFunction(() => [...window.__game.infos.values()].filter((i) => i.name.startsWith('Налётчик')).length >= 3, null, { timeout: Math.max(20000, STEP_MS), polling: 250 });
  // face the raiders
  await a.evaluate(() => { const g = window.__game; const r = [...g.infos.values()].find((i) => i.name.startsWith('Налётчик')); if (r) g.targetId = r.id; });
  await shot(a, '01-raid.png');
  await a.keyboard.press('KeyM');
  await shot(a, '02-map.png', 800);
  const mapIcon = await a.evaluate(() => document.querySelectorAll('#galaxy .gx-ev').length);
  if (!mapIcon) errors.push('no event icons on the galaxy map');
  await a.keyboard.press('Escape');

  // ---- shortage: news on the market, a doubled price, an urgent contract
  await chat(a, '/gevent shortage crystal 10');
  await a.waitForFunction(() => window.__game.galaxyEvents.some((e) => e.kind === 'shortage'), null, { timeout: 10000, polling: 200 });
  await sleep(1000);
  await a.keyboard.press('KeyF');
  await a.waitForFunction(() => window.__game.pred.mode === 2, null, { timeout: 15000, polling: 250 });
  await a.waitForFunction(() => document.querySelectorAll('#station .mk-news .mk-ev').length > 0, null, { timeout: 10000, polling: 200 });
  const news = await a.evaluate(() => document.querySelector('#station .mk-news').innerText);
  console.log('market news:', news.replace(/\s+/g, ' '));
  await shot(a, '03-market.png');
  await a.click('#station .st-contracts');
  await a.waitForFunction(() => document.querySelectorAll('.ct-card.urgent').length > 0, null, { timeout: 10000, polling: 200 });
  await shot(a, '04-contracts.png', 800);
  await a.keyboard.press('Escape');

  // ---- storm: meteors streak past in open space
  await chat(a, '/gevent storm 10');
  await a.click('#station button.primary');
  await a.waitForFunction(() => window.__game.pred.mode === 0, null, { timeout: 15000, polling: 250 });
  await chat(a, '/tp field');
  await a.waitForFunction(() => window.__game.galaxyEvents.some((e) => e.kind === 'storm'), null, { timeout: 10000, polling: 200 });
  await shot(a, '05-storm.png', 4000);
  console.log('events:', JSON.stringify(await events(a)));
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
