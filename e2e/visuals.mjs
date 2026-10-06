// Visual tour: low flight, landing and on-foot shots on several planet types.
// Usage: npm run build && node e2e/visuals.mjs   (screenshots in e2e/out/visuals/)
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';
// E2E_GPU=1 renders on the real GPU (a local machine), otherwise software WebGL (CI, containers); E2E_HEADED=1 shows the window.
const LAUNCH = { headless: !process.env.E2E_HEADED, args: process.env.E2E_GPU ? ['--ignore-gpu-blocklist', '--enable-gpu'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] };

const PORT = 8092;
const OUT = new URL('./out/visuals/', import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
// On a slow software renderer: E2E_Q=low (graphics preset), E2E_VIEWPORT=960x540, E2E_TIMEOUT=120000 (ms per step).
const [VW, VH] = (process.env.E2E_VIEWPORT ?? '1280x720').split('x').map(Number);
const QS = process.env.E2E_Q ? `&q=${process.env.E2E_Q}` : '';
const STEP_MS = Number(process.env.E2E_TIMEOUT ?? 30000);
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
const browser = await chromium.launch(LAUNCH);
try {
  const page = await browser.newPage({ viewport: { width: VW, height: VH } });
  page.setDefaultTimeout(STEP_MS);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://localhost:${PORT}/?name=Tourist&autostart=1${QS}`);
  await page.waitForFunction(() => window.__game?.self && window.__game.pred.ready, null, { timeout: 60000, polling: 250 });
  const chat = (t) => page.evaluate((x) => window.__game.conn.chat(x), t);
  const mode = (m) => page.waitForFunction((x) => window.__game.pred.mode === x, m, { timeout: Math.max(20000, STEP_MS), polling: 250 });
  const only = process.argv[2];
  // Share of props whose base is off the terrain as currently drawn (LOD) by more than 0.3 m.
  const grounding = () => page.evaluate(() => {
    const g = window.__game;
    const np = g.nearPlanet;
    if (!np) return null;
    const pv = g.planets[np.index];
    const out = { n: 0, bad: 0, worst: 0 };
    for (const tier of [g.props.big, g.props.small]) {
      const gr = tier.ground;
      for (let i = 0; i < gr.n; i++) {
        const dir = { x: gr.up[i * 3], y: gr.up[i * 3 + 1], z: gr.up[i * 3 + 2] };
        const hr = pv.renderedHeight(gr.cube[i * 3], gr.cube[i * 3 + 1], gr.cube[i * 3 + 2], dir);
        if (hr === null) continue;
        const a = tier.meshes[gr.mesh[i]].solid.instanceMatrix.array, o = gr.slot[i] * 16;
        const lift = (a[o + 12] - gr.base[i * 3]) * dir.x + (a[o + 13] - gr.base[i * 3 + 1]) * dir.y + (a[o + 14] - gr.base[i * 3 + 2]) * dir.z;
        if (lift < -100) continue; // deliberately sunk: that LOD puts its ground under the sea
        const err = Math.abs(gr.h[i] + lift - hr);
        out.n++;
        if (err > 0.3) out.bad++;
        out.worst = Math.max(out.worst, err);
      }
    }
    return out;
  });
  const checkGround = async (label) => {
    // measure once the terrain has settled (the props re-snap right after each LOD change)
    for (let i = 0; i < 40; i++) {
      const settled = await page.evaluate(() => {
        const g = window.__game, np = g.nearPlanet;
        return !np || g.planets[np.index].lodVersion === g.props.lodSeen;
      });
      if (settled) break;
      await sleep(250);
    }
    const gm = await grounding();
    console.log('grounding', label, JSON.stringify(gm));
    if (gm && gm.n > 50 && gm.bad / gm.n > 0.01) errors.push(`${label}: ${gm.bad}/${gm.n} props off the drawn terrain`);
  };
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
    await checkGround(`${name} flight`);
    await chat(`/land ${idx}`);
    await sleep(9000);
    await page.screenshot({ path: `${OUT}/${name}-2-landed.png` });
    await checkGround(`${name} landed`);
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
  // wildlife on four biomes (peaceful herd + predator), shot from the pilot's view
  if (!only || only === 'fauna') {
    await chat('/god');
    for (const [sys, idx, name, a, b] of [[0, 2, 'terran', 0, 1], [0, 1, 'alien', 2, 3], [0, 3, 'ice', 6, 7], [1, 2, 'desert', 4, 5]]) {
      if ((await page.evaluate(() => window.__game.sys.id)) !== sys) {
        await chat(`/system ${sys}`);
        await page.waitForFunction((s) => window.__game.sys.id === s && window.__game.pred.ready, sys, { timeout: 30000, polling: 250 });
      }
      await chat(`/land ${idx}`);
      await sleep(6000);
      await page.keyboard.press('KeyG');
      await mode(1);
      await chat(`/fauna ${a} 16`);
      await chat(`/fauna ${b} 26`);
      await sleep(3500);
      await page.screenshot({ path: `${OUT}/fauna-${name}.png` });
      console.log('done fauna', name, await page.evaluate(() => [...window.__game.remotes.values()].filter((r) => r.info?.kind === 5).length));
      await page.keyboard.press('KeyG');
      await sleep(1500);
    }
    await chat('/god');
  }
  // the sea: a beach from the pilot's camera, then diving among sea life and sea creatures
  if (!only || only === 'water') {
    if ((await page.evaluate(() => window.__game.sys.id)) !== 0) {
      await chat('/system 0');
      await page.waitForFunction(() => window.__game.sys.id === 0 && window.__game.pred.ready, null, { timeout: 30000, polling: 250 });
    }
    await chat('/god');
    await chat('/tp beach 2');
    await sleep(14000);
    await page.evaluate(() => { window.__game.ctrl.footPitch = -0.12; });
    await sleep(3000);
    await page.screenshot({ path: `${OUT}/water-beach.png` });
    await chat('/tp dive 2');
    await sleep(14000);
    await chat('/fauna 9 16');
    await chat('/fauna 8 12');
    await page.evaluate(() => { window.__game.ctrl.footPitch = -0.15; });
    await sleep(12000);
    await page.screenshot({ path: `${OUT}/water-under.png` });
    const st = await page.evaluate(() => {
      const g = window.__game;
      return { under: g.camUnder, swim: g.pred.char?.swim, fish: g.sealife.count, bed: g.props.sea.meshes.reduce((a, m) => a + m.solid.count, 0), sea: [...g.remotes.values()].filter((r) => r.info?.kind === 5 && [8, 9, 10, 11].includes(r.info.species)).length };
    });
    console.log('water', JSON.stringify(st));
    if (!st.under || !st.swim) errors.push(`water: not under water (${JSON.stringify(st)})`);
    if (st.fish < 20 || st.bed < 50 || st.sea < 1) errors.push(`water: sea life missing (${JSON.stringify(st)})`);
    await page.evaluate(() => { window.__game.ctrl.footPitch = 0.9; });
    await sleep(5000);
    await page.screenshot({ path: `${OUT}/water-surface-below.png` });
    await chat('/god');
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
    // on foot at night: visor up (face visible), helmet lamps on
    await chat('/wear lights-eva');
    await page.keyboard.press('KeyG');
    await mode(1);
    await page.evaluate(() => { window.__game.ctrl.footPitch = -0.05; window.__game.ctrl.footDist = 2.4; });
    await sleep(6000);
    await page.screenshot({ path: `${OUT}/terran-night-foot.png` });
    const lamps = await page.evaluate(() => ({ visor: window.__game.myAstro?.visorUp, lights: window.__game.myAstro?.lightsOn }));
    console.log('night on foot', JSON.stringify(lamps));
    if (!lamps.visor || !lamps.lights) errors.push(`night: visor/lamps not switched (${JSON.stringify(lamps)})`);
  }
  // storms on foot: thunderstorm, blizzard, acid rain, radiation (system 0) and a sandstorm (system 1)
  if (!only || only === 'weather') {
    const storm = async (sysId, type, kind, file, extra) => {
      if ((await page.evaluate(() => window.__game.sys.id)) !== sysId) {
        await chat(`/system ${sysId}`);
        await page.waitForFunction((x) => window.__game.sys.id === x && window.__game.pred.ready, sysId, { timeout: STEP_MS, polling: 250 });
      }
      const idx = await page.evaluate((t) => window.__game.sys.planets.findIndex((p) => p.type === t), type);
      await chat(`/land ${idx}`);
      await sleep(4000);
      await page.keyboard.press('KeyG');
      await mode(1);
      await chat(`/weather ${kind} 1`);
      await page.evaluate(() => { window.__game.ctrl.footPitch = -0.02; window.__game.ctrl.footDist = 4.5; });
      await sleep(5000);
      if (extra) await extra();
      await page.screenshot({ path: `${OUT}/${file}.png` });
      const st = await page.evaluate(() => ({ kind: window.__game.wx.kind, k: +window.__game.wx.k.toFixed(2), chip: document.querySelector('#weather-chip').textContent, sky: document.querySelector('.pp-forecast').textContent }));
      console.log('weather', file, JSON.stringify(st));
      if (st.kind !== kind || st.k < 0.5) errors.push(`${file}: weather not shown (${JSON.stringify(st)})`);
      await chat('/weather clear');
      await page.keyboard.press('KeyG');
      await mode(0);
    };
    await chat('/god');
    await storm(0, 'terran', 'storm', 'weather-storm', async () => { await chat('/strike 1'); await sleep(700); });
    await storm(0, 'ice', 'blizzard', 'weather-blizzard');
    await storm(0, 'alien', 'acid', 'weather-acid');
    await storm(0, 'barren', 'radiation', 'weather-radiation');
    await storm(1, 'desert', 'sandstorm', 'weather-sandstorm');
    await chat('/god');
  }
  // a crashed ship: outside, in the dark hold with lamps and guard drones, and the bridge with its log
  if (!only || only === 'wreck') {
    if ((await page.evaluate(() => window.__game.sys.id)) !== 0) {
      await chat('/system 0');
      await page.waitForFunction(() => window.__game.sys.id === 0 && window.__game.pred.ready, null, { timeout: STEP_MS, polling: 250 });
    }
    const idx = await page.evaluate(() => window.__game.sys.planets.findIndex((p) => p.type === 'ice'));
    await chat('/god');
    await chat(`/tp wreck${idx}`);
    await sleep(5000);
    await page.keyboard.press('KeyG');
    await mode(1);
    await page.evaluate(() => { window.__game.ctrl.footPitch = 0.12; window.__game.ctrl.footDist = 7; });
    await sleep(5000);
    await page.screenshot({ path: `${OUT}/wreck-outside.png` });
    await chat('/inside hold');
    await page.evaluate(() => { window.__game.ctrl.footPitch = -0.02; window.__game.ctrl.footDist = 3.2; });
    await sleep(6000);
    await page.screenshot({ path: `${OUT}/wreck-hold.png` });
    const st = await page.evaluate(() => ({ indoor: +window.__game.indoorK.toFixed(2), lamps: window.__game.myAstro?.lightsOn, drones: [...window.__game.remotes.values()].filter((r) => r.info?.species === 12).length }));
    console.log('wreck hold', JSON.stringify(st));
    if (st.indoor < 0.9 || !st.lamps) errors.push(`wreck: not dark inside (${JSON.stringify(st)})`);
    await chat('/inside bridge');
    await sleep(4000);
    await page.keyboard.press('KeyF');
    await sleep(1500);
    await page.screenshot({ path: `${OUT}/wreck-log.png` });
    const log = await page.evaluate(() => document.querySelector('#shiplog .log-title').textContent);
    console.log('wreck log', log);
    if (!log.includes('Бортовой журнал')) errors.push('wreck: no ship log on the bridge');
    await page.evaluate(() => document.querySelector('#shiplog .log-close').click());
    await chat('/god');
  }
  // the station inside: the hangar with the ship on its pad, the promenade with its window and terminals
  if (!only || only === 'station') {
    if ((await page.evaluate(() => window.__game.sys.id)) !== 0) {
      await chat('/system 0');
      await page.waitForFunction(() => window.__game.sys.id === 0 && window.__game.pred.ready, null, { timeout: STEP_MS, polling: 250 });
    }
    if ((await page.evaluate(() => window.__game.pred.mode)) === 1) { await page.keyboard.press('KeyG'); await mode(0); }
    await chat('/tp dock');
    // dock as soon as the client offers it (slow renderers take a while to get there)
    await page.waitForFunction(() => { const el = document.querySelector('#prompt'); return el.style.display !== 'none' && el.textContent.includes('стыков'); }, null, { timeout: Math.max(20000, STEP_MS), polling: 250 });
    await page.keyboard.press('KeyF');
    await mode(2);
    // close the station window: the hangar camera circles the ship on its pad
    await page.evaluate(() => document.querySelector('#station button[data-act="close-station"]').click());
    await sleep(5000);
    await page.screenshot({ path: `${OUT}/station-docked.png` });
    await page.keyboard.press('KeyG');
    await mode(4);
    // the pilot steps out facing the airlock: turn round to the ship
    await page.evaluate(() => { const g = window.__game; g.ctrl.yawAcc = 2.35; g.ctrl.footPitch = 0.12; g.ctrl.footDist = 6; });
    await sleep(5000);
    await page.screenshot({ path: `${OUT}/station-hangar.png` });
    await page.evaluate(() => { window.__game.ctrl.yawAcc = Math.PI; });
    await sleep(4000);
    await page.screenshot({ path: `${OUT}/station-hangar-airlock.png` });
    await chat('/deck contracts');
    await page.evaluate(() => { window.__game.ctrl.footPitch = 0.05; window.__game.ctrl.footDist = 4; });
    await sleep(4000);
    await page.screenshot({ path: `${OUT}/station-terminal.png` });
    await page.keyboard.press('KeyF');
    await page.waitForFunction(() => !document.querySelector('#contracts').classList.contains('hidden'), null, { timeout: STEP_MS, polling: 250 });
    await page.evaluate(() => document.querySelector('#contracts .ct-close').click());
    // the promenade's end window looks down on the planet; a second pilot walks in front and says hello
    await chat('/deck window');
    await page.evaluate(() => { const g = window.__game; g.ctrl.footPitch = 0.08; g.ctrl.footDist = 5; });
    const b = await browser.newPage({ viewport: { width: 480, height: 270 } });
    b.on('pageerror', (e) => errors.push(`Bravo: ${e.message}`));
    await b.goto(`http://localhost:${PORT}/?name=Bravo&autostart=1&q=low`);
    await b.waitForFunction(() => window.__game?.self && window.__game.pred.ready, null, { timeout: Math.max(60000, STEP_MS), polling: 250 });
    await b.evaluate(() => window.__game.conn.chat('/tp dock'));
    await b.waitForFunction(() => { const el = document.querySelector('#prompt'); return el.style.display !== 'none' && el.textContent.includes('стыков'); }, null, { timeout: Math.max(20000, STEP_MS), polling: 250 });
    await b.keyboard.press('KeyF');
    await b.waitForFunction(() => window.__game.pred.mode === 2, null, { timeout: STEP_MS, polling: 250 });
    await b.keyboard.press('KeyG');
    await b.waitForFunction(() => window.__game.pred.mode === 4, null, { timeout: STEP_MS, polling: 250 });
    await b.evaluate(() => window.__game.conn.chat('/deck window'));
    await sleep(1000);
    // a few steps ahead and to the left, then turn to face Tourist
    await b.keyboard.down('KeyW');
    await b.keyboard.down('KeyA');
    await sleep(1400);
    await b.keyboard.up('KeyA');
    await b.keyboard.up('KeyW');
    await b.evaluate(() => { window.__game.ctrl.yawAcc = 2.6; });
    await b.evaluate(() => window.__game.conn.chat('Всем привет! Кто летит к обломкам?'));
    await sleep(3500);
    await page.screenshot({ path: `${OUT}/station-promenade.png` });
    const met = await page.evaluate(() => {
      const r = [...window.__game.remotes.values()].find((x) => x.info?.name === 'Bravo' && x.info.kind === 2);
      return { bravo: !!r, bubble: [...document.querySelectorAll('.lb-bubble')].some((e) => e.textContent.includes('привет') && e.offsetParent) };
    });
    console.log('station meet', JSON.stringify(met));
    if (!met.bravo || !met.bubble) errors.push(`station: the other pilot or their chat bubble is missing (${JSON.stringify(met)})`);
    await b.close();
    // and back over the holo-map to the terminals
    await page.evaluate(() => { window.__game.ctrl.yawAcc = Math.PI; });
    await sleep(4000);
    await page.screenshot({ path: `${OUT}/station-holo.png` });
    const st = await page.evaluate(() => ({ mode: window.__game.pred.mode, p: window.__game.pred.char?.p, indoor: +window.__game.indoorK.toFixed(2) }));
    console.log('station deck', JSON.stringify(st));
    if (st.mode !== 4) errors.push(`station: not on the deck (${JSON.stringify(st)})`);
    await chat('/deck ramp');
    await sleep(1500);
    await page.keyboard.press('KeyG');
    await mode(2);
    console.log('done station');
  }
  // the planetary rover: unloaded from the landed ship, driven over the terrain, then parked
  if (!only || only === 'rover') {
    if ((await page.evaluate(() => window.__game.sys.id)) !== 0) {
      await chat('/system 0');
      await page.waitForFunction(() => window.__game.sys.id === 0 && window.__game.pred.ready, null, { timeout: 30000, polling: 250 });
    }
    await chat('/god');
    await chat(`/land ${process.env.ROVER_PLANET ?? 2} day`);
    await chat('/weather clear');
    await sleep(6000);
    await chat('/rover');
    await mode(5);
    await page.waitForFunction(() => window.__game.myRover?.ready, null, { timeout: 30000, polling: 250 });
    await sleep(2500);
    const p0 = await page.evaluate(() => ({ ...window.__game.pred.rover.p }));
    // (software WebGL runs the game slower than real time: drive by simulated ticks, not wall time)
    const ticks = () => page.evaluate(() => window.__game.ctrl.seq);
    const hold = async (n) => { const t0 = await ticks(); while ((await ticks()) - t0 < n) await sleep(100); };
    await page.keyboard.down('KeyW');
    await hold(75);
    await page.keyboard.down('KeyD');
    await hold(25);
    await page.keyboard.up('KeyD');
    await hold(30);
    await page.screenshot({ path: `${OUT}/rover-drive.png` });
    await page.keyboard.up('KeyW');
    await page.keyboard.down('Space');
    await hold(60);
    await page.keyboard.up('Space');
    const st = await page.evaluate((a) => {
      const r = window.__game.pred.rover;
      return { moved: Math.hypot(r.p.x - a.x, r.p.y - a.y, r.p.z - a.z), v: Math.hypot(r.v.x, r.v.y, r.v.z), ground: r.ground, susp: r.susp.map((x) => +x.toFixed(2)) };
    }, p0);
    console.log('rover drive', JSON.stringify(st));
    if (st.moved < 10) errors.push(`rover: did not drive (${JSON.stringify(st)})`);
    // a three-quarter view from the front: swing the chase camera around and hold it there
    await page.evaluate(() => { const c = window.__game.ctrl; c.roverYaw = 2.4; c.roverLook = 1e9; c.roverDist = 8; c.footPitch = -0.15; });
    await sleep(2000);
    await page.addStyleTag({ content: '#prompt { visibility: hidden !important; }' }).then((h) => h.evaluate((e) => e.id = 'e2e-hide'));
    await page.screenshot({ path: `${OUT}/rover.png` });
    await page.evaluate(() => document.getElementById('e2e-hide')?.remove());
    await page.evaluate(() => { window.__game.ctrl.roverLook = 0; });
    await page.keyboard.press('KeyG');
    await mode(1);
    await sleep(2500);
    await page.screenshot({ path: `${OUT}/rover-parked.png` });
    const parked = await page.evaluate(() => [...window.__game.remotes.values()].some((r) => r.info?.kind === 6 && r.view?.ready && r.visible));
    if (!parked) errors.push('rover: the parked rover is not drawn');
    console.log('done rover');
  }
} catch (e) {
  errors.push(String(e.stack || e));
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
if (errors.length) { console.error('ERRORS:\n' + errors.join('\n')); process.exit(1); }
console.log('visual tour OK');
