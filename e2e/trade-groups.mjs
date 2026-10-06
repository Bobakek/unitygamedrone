// Station market and pilot groups in the browser: two clients, trading at the station, an invitation.
// Usage: npm run build && node e2e/trade-groups.mjs   (screenshots land in e2e/out/trade/)
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';

const LAUNCH = { headless: !process.env.E2E_HEADED, args: process.env.E2E_GPU ? ['--ignore-gpu-blocklist', '--enable-gpu'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] };
const PORT = 8091;
const OUT = new URL('./out/trade/', import.meta.url).pathname;
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
  const pilot = (page) => page.evaluate(() => ({ credits: window.__game.pilot.credits, cargo: { ...window.__game.pilot.cargo } }));

  const a = await open('Alpha');
  const b = await open('Bravo');

  // ---- market
  await chat(a, '/tp dock');
  await sleep(1500);
  await a.keyboard.press('KeyF');
  await a.waitForFunction(() => window.__game.pred.mode === 2, null, { timeout: 15000, polling: 250 });
  await a.waitForFunction(() => document.querySelectorAll('#station .mk-table tr').length === 5, null, { timeout: 10000, polling: 200 });
  await chat(a, '/cargo relic 4');
  await chat(a, '/credits 3000');
  await a.waitForFunction(() => window.__game.pilot.cargo.relic === 4, null, { timeout: 10000, polling: 200 });
  const before = await pilot(a);
  await a.click('#station button[data-act="trade"][data-op="sell"][data-key="relic"][data-n="1"]');
  await a.waitForFunction(() => window.__game.pilot.cargo.relic === 3, null, { timeout: 10000, polling: 200 });
  const sold = await pilot(a);
  if (!(sold.credits > before.credits)) errors.push(`selling a relic paid nothing: ${before.credits} → ${sold.credits}`);
  const buyKey = await a.evaluate(() => document.querySelector('#station button[data-act="trade"][data-op="buy"]')?.dataset.key);
  if (!buyKey) errors.push('the station sells nothing');
  else {
    const had = sold.cargo[buyKey];
    await a.click(`#station button[data-act="trade"][data-op="buy"][data-key="${buyKey}"][data-n="5"]`);
    await a.waitForFunction(([k, n]) => window.__game.pilot.cargo[k] === n + 5, [buyKey, had], { timeout: 10000, polling: 200 });
    console.log('bought 5 ×', buyKey);
  }
  const table = await a.evaluate(() => [...document.querySelectorAll('#station .mk-table tr')].map((r) => r.innerText.replace(/\s+/g, ' ').trim()));
  console.log('market:\n  ' + table.join('\n  '));
  await shot(a, '01-market.png');

  // ---- groups
  await chat(a, '/invite Bravo');
  await b.waitForFunction(() => !document.querySelector('#group-panel').classList.contains('hidden') && document.querySelector('.gp-invite span').textContent.includes('Alpha'), null, { timeout: 10000, polling: 200 });
  await shot(b, '02-invite.png', 500);
  await b.keyboard.press('KeyY');
  await a.waitForFunction(() => window.__game.group.members.length === 2, null, { timeout: 10000, polling: 200 });
  await b.waitForFunction(() => window.__game.group.members.length === 2 && document.querySelectorAll('#group-panel .gp-m').length === 2, null, { timeout: 10000, polling: 200 });
  await a.click('#station button.primary');
  await a.waitForFunction(() => window.__game.pred.mode === 0, null, { timeout: 15000, polling: 250 });
  // fly Bravo next to Alpha: the wingmate's label turns green
  await chat(b, '/tp dock');
  await b.waitForFunction(() => [...document.querySelectorAll('#labels .label.ally')].some((l) => l.textContent.includes('Alpha')), null, { timeout: Math.max(20000, STEP_MS), polling: 250 });
  const nav = await b.evaluate(() => window.__game.navItems.filter((n) => n.kind === 'ally').map((n) => n.name));
  if (!nav.includes('Группа: Alpha')) errors.push(`no group mate in the nav list: ${nav}`);
  await chat(b, '/g на связи');
  await a.waitForFunction(() => [...document.querySelectorAll('#chat-log div')].some((d) => d.textContent.includes('на связи')), null, { timeout: 10000, polling: 200 });
  await shot(b, '03-group.png');
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
