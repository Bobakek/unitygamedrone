// Animation lab screenshots: contact sheets for the pilot and all creatures, plus a few live clips.
// Usage: npm run build && node e2e/anim-lab.mjs [clip ...]   (screenshots in e2e/out/anim/)
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';
// E2E_GPU=1 renders on the real GPU (a local machine), otherwise software WebGL (CI, containers); E2E_HEADED=1 shows the window.
const LAUNCH = { headless: !process.env.E2E_HEADED, args: process.env.E2E_GPU ? ['--ignore-gpu-blocklist', '--enable-gpu'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] };

const PORT = 8094;
const OUT = new URL('./out/anim/', import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const server = spawn(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], {
  env: { ...process.env, PORT: String(PORT), DB_PATH: ':memory:' },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) break; } catch { /* starting */ }
  await sleep(200);
}
const errors = [];
const browser = await chromium.launch(LAUNCH);
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const open = async (q) => {
    await page.goto(`http://localhost:${PORT}/?lab${q}`);
    await page.waitForFunction(() => window.__lab?.ready, null, { timeout: 30000, polling: 200 });
  };
  const species = Array.from({ length: 12 }, (_, i) => i);
  for (const [q, name] of [['&sheet=outfits&from=0', 'sheet-outfits-1'], ['&sheet=outfits&from=1', 'sheet-outfits-2'], ['&sheet=pilot&from=0&to=8', 'sheet-pilot-1'], ['&sheet=pilot&from=9&to=16', 'sheet-pilot-2'], ['&sheet=pilot&from=17&to=22', 'sheet-pilot-swim'], ...species.map((i) => [`&sheet=creatures&from=${i}&to=${i}`, `sheet-creature-${i}`])]) {
    await open(`${q}&ui=0`);
    await sleep(2500);
    await page.screenshot({ path: `${OUT}/${name}.png` });
  }
  const clips = process.argv.slice(2).length ? process.argv.slice(2) : ['strafeR', 'back', 'vault', 'climb', 'shoot', 'harvest', 'scramble', 'hurt', 'fidget', 'crawl', 'underSwim'];
  // clip times (s) to freeze for the montage
  const TIMES = { vault: [1.0, 1.2, 1.45], climb: [1.95, 2.35, 2.75], scramble: [1.5, 2.2, 2.6], shoot: [0.45, 0.8, 1.2], harvest: [0.6, 0.9, 1.3], hurt: [0.3, 0.38, 0.5], fidget: [0.9, 1.4, 1.9] };
  await open('&clip=walk&ui=0');
  for (const c of clips) {
    await page.evaluate((x) => window.__lab.play('pilot', x), c);
    const wide = ['vault', 'climb', 'scramble'].includes(c);
    const times = TIMES[c] ?? [0.8, 1.05, 1.3];
    for (let k = 1; k <= 3; k++) {
      await page.evaluate((t) => window.__lab.seek(t), times[k - 1]);
      await sleep(400);
      const clip = wide ? { x: 250, y: 100, width: 900, height: 700 } : { x: 450, y: 120, width: 500, height: 700 };
      await page.screenshot({ path: `${OUT}/pilot-${c}-${k}.png`, clip });
    }
  }
  // close-ups of the suit: front with the visor down, face behind the raised visor, back, a full kit
  for (const [look, visor, side, name] of [['', 0, 0.3, 'suit-front'], ['', 1, -0.3, 'suit-face'], ['', 0, 3.0, 'suit-back'],
    ['suit-orange.helmet-dome.visor-silver.pack-o2.chest-plate.lights-eva.patch-skull', 1, 0.5, 'suit-orange'],
    ['suit-graphite.helmet-armored.visor-amber.pack-jet.chest-rig.lights-eva.patch-wings', 0, 2.4, 'suit-graphite'],
    // faction gear bought for reputation
    ['suit-navy.helmet-dome.visor-gold.pack-plss.chest-aegis.lights-eva.patch-flag', 0, 0.4, 'suit-navy'],
    ['suit-miner.helmet-dome.visor-amber.pack-deep.chest-rig.lights-eva.patch-planet', 1, 2.3, 'suit-miner'],
    ['suit-raider.helmet-armored.visor-chameleon.pack-raider.chest-plate.lights-none.patch-skull', 0, 2.5, 'suit-raider']]) {
    await page.evaluate(([l, v]) => { window.__lab.play('pilot', 'idle'); window.__lab.dress(l, v); window.__lab.seek(1.2); }, [look, visor]);
    await page.evaluate((s) => window.__lab.close(s), side);
    await sleep(800);
    await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: 350, y: 80, width: 700, height: 760 } });
  }
  // one montage of all clip frames (rows = clips), cropped to the subject
  const imgs = clips.map((c) => `<div class="row"><b>${c}</b>${[1, 2, 3].map((k) => `<img src="data:image/png;base64,${readFileSync(`${OUT}/pilot-${c}-${k}.png`).toString('base64')}">`).join('')}</div>`).join('');
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.setContent(`<body style="margin:0;background:#111;color:#fff;font:14px sans-serif">${imgs}<style>.row{display:flex;align-items:center;gap:4px;margin:4px}.row b{width:80px}img{height:260px}</style></body>`);
  await sleep(300);
  await page.screenshot({ path: `${OUT}/montage-pilot.png`, fullPage: true });
  await page.setViewportSize({ width: 1400, height: 900 });
  console.log('shots in', OUT);
} catch (e) {
  errors.push(String(e.stack || e));
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
if (errors.length) { console.error('ERRORS:\n' + errors.join('\n')); process.exit(1); }
console.log('anim lab OK');
