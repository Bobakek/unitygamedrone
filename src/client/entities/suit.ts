import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { lookCode, type Outfit } from '../../shared/outfit.ts';

/**
 * An EVA suit in the spirit of NASA's EMU / xEMU, built procedurally onto the
 * astronaut's rig from the outfit: hard upper torso with bearing rings, the
 * display-and-control module and a life-support backpack joined by hoses,
 * bellows at elbows and knees, gloves with fingers, thick-soled boots, a
 * bubble helmet with a visor that lifts to show the face inside, lamps,
 * patches and a name tag.
 *
 * Everything opaque on one joint is merged into one mesh drawn with a single
 * material: vertex colour plus per-vertex roughness, metalness and how much
 * of the woven-fabric normal map shows (`aRM`). Joint geometry is cached per
 * outfit, so a crowd of pilots in the same kit shares it.
 */
export interface SuitJoints {
  hips: THREE.Object3D; spine: THREE.Object3D; head: THREE.Object3D;
  sh: THREE.Object3D[]; el: THREE.Object3D[]; hand: THREE.Object3D[];
  hip: THREE.Object3D[]; kn: THREE.Object3D[]; an: THREE.Object3D[];
}

export interface Suit {
  /** Lifts with `visor.rotation.x` (0 down … -1.25 up); null when the helmet has no movable visor. */
  visor: THREE.Object3D | null;
  /** Whether the face can be seen through the helmet. */
  face: boolean;
  /** Helmet lamp lenses (brightness follows `lamps.color`). */
  lamps: THREE.MeshBasicMaterial;
  /** Jetpack nozzle positions in spine space (flames go there). */
  nozzles: THREE.Vector3[];
  /** Outer surface of the backpack (z in spine space) — where the rifle is slung. */
  backZ: number;
  dispose(): void;
}

type RM = [number, number, number];
/** roughness, metalness, fabric-normal weight */
const FABRIC: RM = [0.92, 0, 1];
const SOFT: RM = [0.95, 0, 1];
const HARD: RM = [0.45, 0, 0];
const METAL: RM = [0.32, 0.85, 0];
const RUBBER: RM = [0.8, 0, 0.1];
const SKIN: RM = [0.6, 0, 0];

interface Scheme {
  fabric: string; soft: string; hard: string; glove: string; palm: string; boot: string; sole: string;
  ring: string; pack: string; hose: string; accent: string; stripe: string | null; inserts: string | null;
  /** Helmet shell (white on most suits). */
  helmet: string;
}
const WHITE: Scheme = {
  fabric: '#eceae4', soft: '#dcd9d1', hard: '#f2f1ec', glove: '#e9e7e0', palm: '#5c616a', boot: '#e4e2dc', sole: '#3b3e45',
  ring: '#b9bec6', pack: '#e7e5df', hose: '#d0d4d9', accent: '#8f99a5', stripe: null, inserts: null, helmet: '#f2f1ec',
};
const SCHEMES: Record<string, Scheme> = {
  'suit-white': WHITE,
  'suit-commander': { ...WHITE, stripe: '#c51f2a' },
  'suit-orange': { ...WHITE, fabric: '#ee7429', soft: '#d6651f', hard: '#f07c30', glove: '#2f3238', palm: '#202227', boot: '#2c2f35', sole: '#1c1e22', accent: '#2a2d33' },
  'suit-orlan': { ...WHITE, fabric: '#eef0f2', soft: '#d6dce4', accent: '#2a5aa8', stripe: '#c51f2a', inserts: '#2a5aa8' },
  'suit-tan': { ...WHITE, fabric: '#c9b58f', soft: '#b39d77', hard: '#d2c19e', glove: '#7a6a52', palm: '#4a4034', boot: '#6c5c46', sole: '#3a3128', pack: '#c2b18e', hose: '#a89878', accent: '#5a4c3a', helmet: '#d6c7a6' },
  'suit-graphite': { ...WHITE, fabric: '#3c4048', soft: '#31343b', hard: '#464a52', glove: '#25282d', palm: '#1a1c20', boot: '#22252a', sole: '#141518', pack: '#4a4e56', hose: '#5a5e66', ring: '#8a9098', accent: '#f07a2a', stripe: '#f07a2a', helmet: '#464a52' },
  // faction suits (sold for reputation)
  'suit-navy': { ...WHITE, fabric: '#26375e', soft: '#1f2d4e', hard: '#2e4170', glove: '#1c2236', palm: '#141826', boot: '#1a2032', sole: '#0f121c', pack: '#2e4170', hose: '#8a96b0', ring: '#d9b45a', accent: '#d9b45a', stripe: '#d9b45a', helmet: '#2e4170' },
  'suit-miner': { ...WHITE, fabric: '#e8c21e', soft: '#cfa914', hard: '#f0cc2a', glove: '#3a3a3a', palm: '#222222', boot: '#4a3a2a', sole: '#1e1a16', pack: '#e0b81c', hose: '#5a5a5a', accent: '#2a2a2a', stripe: '#dfe4ea', helmet: '#f0cc2a' },
  'suit-raider': { ...WHITE, fabric: '#232327', soft: '#1b1b1e', hard: '#2a2a30', glove: '#121214', palm: '#0c0c0e', boot: '#141416', sole: '#0a0a0b', pack: '#2a2a30', hose: '#5a1c22', ring: '#8a2a32', accent: '#d0202e', stripe: '#d0202e', inserts: '#8a1a22', helmet: '#2a2a30' },
};

/** Weather modules: canister colour. */
const MOD_COLORS: Record<string, string> = { 'mod-thermo': '#e0702a', 'mod-filter': '#46a868', 'mod-rad': '#d8c02a', 'mod-wanderer': '#4a86d8' };

// ---------------------------------------------------------------- materials (shared)
let fabricTex: THREE.Texture | null = null;
/** Woven-fabric normal map, generated once. */
function fabricNormal(): THREE.Texture {
  if (fabricTex) return fabricTex;
  const N = 128, c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d')!;
  const img = g.createImageData(N, N);
  const h = (x: number, y: number) => {
    x = (x + N) % N; y = (y + N) % N;
    const warp = Math.sin((x / 8) * Math.PI * 2) * Math.sign(Math.sin((y / 16) * Math.PI * 2));
    const weft = Math.sin((y / 8) * Math.PI * 2) * Math.sign(Math.sin((x / 16) * Math.PI * 2 + 1));
    return 0.5 + 0.18 * warp + 0.18 * weft + 0.04 * Math.sin(x * 1.7 + y * 2.3);
  };
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const nx = -(h(x + 1, y) - h(x - 1, y)) * 2, ny = -(h(x, y + 1) - h(x, y - 1)) * 2;
      const l = Math.hypot(nx, ny, 1);
      const o = (y * N + x) * 4;
      img.data[o] = (nx / l * 0.5 + 0.5) * 255;
      img.data[o + 1] = (ny / l * 0.5 + 0.5) * 255;
      img.data[o + 2] = (1 / l * 0.5 + 0.5) * 255;
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  fabricTex = new THREE.CanvasTexture(c);
  fabricTex.wrapS = fabricTex.wrapT = THREE.RepeatWrapping;
  fabricTex.repeat.set(7, 7);
  fabricTex.colorSpace = THREE.NoColorSpace;
  return fabricTex;
}

let bodyMatCache: THREE.MeshStandardMaterial | null = null;
/** One material for every opaque suit part: vertex colour × per-vertex roughness / metalness / fabric. */
export function bodyMaterial(): THREE.MeshStandardMaterial {
  if (bodyMatCache) return bodyMatCache;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 1, normalMap: fabricNormal(), normalScale: new THREE.Vector2(0.28, 0.28), side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = 'attribute vec3 aRM;\nvarying vec3 vRM;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvRM = aRM;');
    sh.fragmentShader = 'varying vec3 vRM;\n' + sh.fragmentShader
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor *= vRM.x;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor *= vRM.y;')
      .replace('mapN.xy *= normalScale;', 'mapN.xy *= normalScale * vRM.z;');
  };
  m.customProgramCacheKey = () => 'suit-body';
  bodyMatCache = m;
  return m;
}

let glassMat: THREE.MeshStandardMaterial | null = null;
/** Helmet bubble: nearly clear, reflective, more opaque at grazing angles. */
function glassMaterial(): THREE.MeshStandardMaterial {
  if (glassMat) return glassMat;
  const m = new THREE.MeshStandardMaterial({ color: '#f4fbff', roughness: 0.03, metalness: 0, transparent: true, opacity: 0.1, depthWrite: false, envMapIntensity: 2.2 });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', `#include <opaque_fragment>
      float fr = pow(1.0 - abs(dot(normalize(normal), normalize(vViewPosition))), 3.0);
      gl_FragColor.a = clamp(gl_FragColor.a + fr * 0.55, 0.0, 0.85);`);
  };
  m.customProgramCacheKey = () => 'suit-glass';
  glassMat = m;
  return m;
}

const visorMats = new Map<string, THREE.Material>();
function visorMaterial(id: string): THREE.Material {
  let m = visorMats.get(id);
  if (m) return m;
  switch (id) {
    case 'visor-silver': m = new THREE.MeshStandardMaterial({ color: '#dfe4ea', metalness: 1, roughness: 0.06 }); break;
    case 'visor-amber': m = new THREE.MeshStandardMaterial({ color: '#d0802c', metalness: 1, roughness: 0.1 }); break;
    case 'visor-chameleon': m = new THREE.MeshPhysicalMaterial({ color: '#5a6cff', metalness: 1, roughness: 0.08, iridescence: 1, iridescenceIOR: 1.6, iridescenceThicknessRange: [200, 900] }); break;
    case 'visor-clear': m = new THREE.MeshStandardMaterial({ color: '#9ad0ff', metalness: 0.2, roughness: 0.05, transparent: true, opacity: 0.18, depthWrite: false }); break;
    default: m = new THREE.MeshStandardMaterial({ color: '#e2a83c', metalness: 1, roughness: 0.1 });
  }
  visorMats.set(id, m);
  return m;
}

const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });

const texCache = new Map<string, THREE.Texture>();
function canvasTex(key: string, w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.Texture {
  let t = texCache.get(key);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d')!);
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  texCache.set(key, t);
  return t;
}

/** Shoulder flag of the (fictional) Federation. */
function flagTexture() {
  return canvasTex('flag', 96, 64, (g) => {
    g.fillStyle = '#f4f4f4'; g.fillRect(0, 0, 96, 64);
    g.fillStyle = '#1f4fa0'; g.fillRect(0, 0, 96, 22); g.fillRect(0, 42, 96, 22);
    g.fillStyle = '#c8202a'; g.beginPath(); g.moveTo(0, 0); g.lineTo(34, 32); g.lineTo(0, 64); g.fill();
    g.fillStyle = '#f4f4f4'; g.beginPath(); g.arc(12, 32, 6, 0, Math.PI * 2); g.fill();
  });
}

/** Round mission patch for an emblem id. */
function patchTexture(id: string) {
  return canvasTex(`patch:${id}`, 96, 96, (g) => {
    const bg: Record<string, string> = { 'patch-flag': '#1f4fa0', 'patch-planet': '#123a7a', 'patch-star': '#202a44', 'patch-comet': '#101830', 'patch-wings': '#2a3a5a', 'patch-skull': '#151515' };
    g.fillStyle = '#e8c34a'; g.beginPath(); g.arc(48, 48, 47, 0, Math.PI * 2); g.fill();
    g.fillStyle = bg[id] ?? '#1f4fa0'; g.beginPath(); g.arc(48, 48, 41, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#f4f4f4'; g.fillStyle = '#f4f4f4'; g.lineWidth = 4;
    switch (id) {
      case 'patch-planet':
        g.fillStyle = '#5ab0e0'; g.beginPath(); g.arc(48, 48, 17, 0, Math.PI * 2); g.fill();
        g.strokeStyle = '#f0d070'; g.beginPath(); g.ellipse(48, 48, 32, 9, -0.35, 0, Math.PI * 2); g.stroke();
        break;
      case 'patch-star': {
        g.fillStyle = '#f0c840'; g.beginPath();
        for (let i = 0; i < 10; i++) { const r = i % 2 ? 12 : 30, a = (i / 10) * Math.PI * 2 - Math.PI / 2; g.lineTo(48 + Math.cos(a) * r, 48 + Math.sin(a) * r); }
        g.fill();
        break;
      }
      case 'patch-comet':
        g.fillStyle = '#f0f4ff'; g.beginPath(); g.arc(60, 36, 9, 0, Math.PI * 2); g.fill();
        g.strokeStyle = '#8ad0ff'; g.lineWidth = 6; g.beginPath(); g.moveTo(54, 42); g.lineTo(22, 70); g.stroke();
        break;
      case 'patch-wings':
        for (const s of [-1, 1]) { g.beginPath(); g.moveTo(48, 50); g.quadraticCurveTo(48 + s * 18, 30, 48 + s * 34, 36); g.quadraticCurveTo(48 + s * 20, 46, 48, 56); g.fill(); }
        g.fillStyle = '#e8c34a'; g.beginPath(); g.arc(48, 52, 6, 0, Math.PI * 2); g.fill();
        break;
      case 'patch-skull':
        g.beginPath(); g.arc(48, 42, 17, 0, Math.PI * 2); g.fill(); g.fillRect(38, 52, 20, 12);
        g.fillStyle = '#151515'; g.beginPath(); g.arc(41, 42, 5, 0, Math.PI * 2); g.arc(55, 42, 5, 0, Math.PI * 2); g.fill();
        g.strokeStyle = '#f4f4f4'; g.lineWidth = 5; g.beginPath(); g.moveTo(24, 72); g.lineTo(72, 24); g.moveTo(24, 24); g.lineTo(72, 72); g.stroke();
        break;
      default:
        // stylised flag + orbit
        g.fillStyle = '#f4f4f4'; g.fillRect(30, 34, 36, 8); g.fillRect(30, 54, 36, 8);
        g.fillStyle = '#c8202a'; g.beginPath(); g.moveTo(30, 30); g.lineTo(48, 48); g.lineTo(30, 66); g.fill();
    }
  });
}

/** Name tag on the chest pulse. */
function nameTexture(name: string) {
  return canvasTex(`name:${name}`, 192, 40, (g) => {
    g.fillStyle = '#1d2026'; g.fillRect(0, 0, 192, 40);
    g.fillStyle = '#e8eaee'; g.font = 'bold 26px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(name.toUpperCase().slice(0, 12), 96, 21, 184);
  });
}

const decalMats = new Map<THREE.Texture, THREE.MeshStandardMaterial>();
function decalMaterial(t: THREE.Texture, round = false): THREE.MeshStandardMaterial {
  let m = decalMats.get(t);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.85, transparent: round, alphaTest: round ? 0.5 : 0, polygonOffset: true, polygonOffsetFactor: -2 });
    if (round) m.alphaMap = roundMask();
    decalMats.set(t, m);
  }
  return m;
}
let mask: THREE.Texture | null = null;
function roundMask() {
  if (mask) return mask;
  mask = canvasTex('mask', 64, 64, (g) => { g.fillStyle = '#000'; g.fillRect(0, 0, 64, 64); g.fillStyle = '#fff'; g.beginPath(); g.arc(32, 32, 31.5, 0, Math.PI * 2); g.fill(); });
  mask.colorSpace = THREE.NoColorSpace;
  return mask;
}

// ---------------------------------------------------------------- geometry builder
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();

/** Collects parts for one joint and merges them into one geometry (position, normal, uv, color, aRM). */
class Parts {
  readonly list: THREE.BufferGeometry[] = [];
  add(geo: THREE.BufferGeometry, color: string, rm: RM, pos: number[] = [0, 0, 0], rot: number[] = [0, 0, 0], scl: number[] = [1, 1, 1]) {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    _m.compose(_p.set(pos[0], pos[1], pos[2]), _q.setFromEuler(_e.set(rot[0], rot[1], rot[2])), _s.set(scl[0], scl[1], scl[2]));
    g.applyMatrix4(_m);
    const n = g.getAttribute('position').count;
    const c = new THREE.Color(color), col = new Float32Array(n * 3), a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col.set([c.r, c.g, c.b], i * 3); a.set(rm, i * 3); }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aRM', new THREE.BufferAttribute(a, 3));
    this.list.push(g);
    geo.dispose();
    return this;
  }
  merge(): THREE.BufferGeometry | null {
    if (!this.list.length) return null;
    const g = mergeGeometries(this.list)!;
    for (const p of this.list) p.dispose();
    g.computeBoundingSphere();
    return g;
  }
}
/** Same, for unlit glowing bits (lamp lenses, screens). */
class Glow {
  readonly list: THREE.BufferGeometry[] = [];
  add(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, k: number, pos: number[], rot: number[] = [0, 0, 0], scl: number[] = [1, 1, 1]) {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const key of Object.keys(g.attributes)) if (key !== 'position') g.deleteAttribute(key);
    _m.compose(_p.set(pos[0], pos[1], pos[2]), _q.setFromEuler(_e.set(rot[0], rot[1], rot[2])), _s.set(scl[0], scl[1], scl[2]));
    g.applyMatrix4(_m);
    const n = g.getAttribute('position').count, c = new THREE.Color(color).multiplyScalar(k), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.list.push(g);
    geo.dispose();
    return this;
  }
  merge(): THREE.BufferGeometry | null {
    if (!this.list.length) return null;
    const g = mergeGeometries(this.list)!;
    for (const p of this.list) p.dispose();
    return g;
  }
}

const cyl = (rt: number, rb: number, h: number, seg = 16, open = false) => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);
const sph = (r: number, ws = 16, hs = 12) => new THREE.SphereGeometry(r, ws, hs);
const tor = (r: number, t: number, seg = 24) => new THREE.TorusGeometry(r, t, 8, seg);
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const cap = (r: number, l: number, seg = 14) => new THREE.CapsuleGeometry(r, l, 6, seg);
const tube = (pts: number[][], r: number) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p[0], p[1], p[2]))), 24, r, 8, false);

interface Built {
  /** Per joint key: merged opaque geometry and glowing geometry. */
  body: Map<string, THREE.BufferGeometry>;
  glow: Map<string, THREE.BufferGeometry>;
  nozzles: THREE.Vector3[];
  backZ: number;
}
const built = new Map<string, Built>();

/** Builds (or reuses) the joint geometry for an outfit. */
function buildGeometry(o: Outfit): Built {
  const key = lookCode(o);
  const hit = built.get(key);
  if (hit) return hit;
  const S = SCHEMES[o.suit] ?? WHITE;
  const body = new Map<string, Parts>(), glow = new Map<string, Glow>();
  const P = (k: string) => { let p = body.get(k); if (!p) body.set(k, (p = new Parts())); return p; };
  const L = (k: string) => { let p = glow.get(k); if (!p) glow.set(k, (p = new Glow())); return p; };

  // ---- hips: brief, waist bearing
  const hips = P('hips');
  hips.add(cap(0.19, 0.08), S.soft, FABRIC, [0, -0.05, 0], [0, 0, Math.PI / 2], [0.95, 1.15, 0.85]);
  hips.add(tor(0.205, 0.026, 32), S.ring, METAL, [0, 0.06, 0], [Math.PI / 2, 0, 0], [1.05, 0.85, 1]);
  hips.add(cyl(0.2, 0.21, 0.05, 24), S.soft, FABRIC, [0, 0.02, 0], [0, 0, 0], [1.05, 1, 0.85]);
  if (S.inserts) hips.add(cyl(0.212, 0.212, 0.03, 24, true), S.inserts, FABRIC, [0, -0.02, 0], [0, 0, 0], [1.05, 1, 0.86]);
  // weather protection module: a canister on each hip with a status light
  const mc = MOD_COLORS[o.mod];
  if (mc) {
    for (const s of [-1, 1]) {
      hips.add(cap(0.042, 0.11, 12), mc, HARD, [s * 0.225, -0.03, 0.05]);
      hips.add(tor(0.044, 0.008, 12), S.ring, METAL, [s * 0.225, 0.02, 0.05], [Math.PI / 2, 0, 0]);
      L('hips').add(sph(0.011, 8, 6), mc, 1.8, [s * 0.225, 0.075, 0.05]);
    }
  }

  // ---- spine: hard upper torso, rings, chest gear, hoses, backpack
  const sp = P('spine');
  // a barrel-shaped hard upper torso
  sp.add(cap(0.22, 0.27, 24), S.hard, HARD, [0, 0.28, 0], [0, 0, 0], [1.32, 0.86, 0.96]);
  sp.add(tor(0.155, 0.026, 32), S.ring, METAL, [0, 0.575, -0.005], [Math.PI / 2, 0, 0]);
  for (const s of [-1, 1]) sp.add(tor(0.105, 0.022), S.ring, METAL, [s * 0.305, 0.44, 0], [0, Math.PI / 2, 0]);
  if (S.inserts) for (const s of [-1, 1]) sp.add(box(0.03, 0.3, 0.3), S.inserts, HARD, [s * 0.285, 0.22, 0], [0, 0, 0], [1, 1, 1]);
  // chest: display and control module (lower under an armour plate), or a vest with pouches
  const armored = o.chest === 'chest-plate' || o.chest === 'chest-aegis';
  const dcmY = armored ? 0.16 : 0.36;
  const sg = L('spine');
  sp.add(box(0.27, 0.13, 0.085), S.pack, HARD, [0, dcmY, -0.235]);
  sp.add(box(0.27, 0.03, 0.06), S.accent, HARD, [0, dcmY - 0.075, -0.22]);
  for (const [x, c] of [[-0.08, '#e0b020'], [0, '#9aa0a8'], [0.08, '#c03030']] as [number, string][]) sp.add(cyl(0.018, 0.018, 0.03, 10), c, HARD, [x, dcmY - 0.03, -0.285], [Math.PI / 2, 0, 0]);
  sg.add(box(0.09, 0.035, 0.005), '#5ad0ff', 0.6, [0.06, dcmY + 0.02, -0.279]);
  if (o.chest === 'chest-plate') {
    const plate = new THREE.CylinderGeometry(0.3, 0.3, 0.26, 20, 1, true, Math.PI - 0.75, 1.5);
    sp.add(plate, S.accent === '#2a2d33' ? '#4a5058' : '#5a6068', [0.4, 0.3, 0.1], [0, 0.39, -0.02], [0, 0, 0], [1, 1, 0.82]);
    sp.add(plate.clone(), '#3a3f46', [0.5, 0.4, 0], [0, 0.39, -0.025], [0, 0, 0], [1.02, 0.25, 0.84]);
  } else if (o.chest === 'chest-aegis') {
    // Federation fleet armour: a taller navy breastplate with gold rims and a star
    const plate = new THREE.CylinderGeometry(0.3, 0.3, 0.32, 24, 1, true, Math.PI - 0.85, 1.7);
    sp.add(plate, '#2a3a62', [0.35, 0.45, 0.1], [0, 0.37, -0.02], [0, 0, 0], [1, 1, 0.84]);
    for (const y of [0.53, 0.21]) sp.add(plate.clone(), '#d9b45a', METAL, [0, y, -0.025], [0, 0, 0], [1.02, 0.06, 0.86]);
    sp.add(cyl(0.045, 0.045, 0.02, 5), '#e8c46a', METAL, [0, 0.4, -0.27], [Math.PI / 2, 0, 0]);
  } else if (o.chest === 'chest-rig') {
    for (const s of [-1, 1]) sp.add(box(0.05, 0.42, 0.02), '#5e5a48', FABRIC, [s * 0.12, 0.38, -0.205], [0.18, 0, 0]);
    for (const x of [-0.13, 0, 0.13]) sp.add(box(0.1, 0.09, 0.06), '#6a6450', FABRIC, [x, 0.13, -0.235]);
    for (const s of [-1, 1]) sp.add(cyl(0.028, 0.028, 0.1, 12), '#c8ccd2', METAL, [s * 0.2, 0.15, -0.2]);
  }
  // hoses from the backpack round to the chest module
  for (const s of [-1, 1]) sp.add(tube([[s * 0.2, 0.36, 0.2], [s * 0.31, 0.26, 0.04], [s * 0.26, 0.18, -0.17], [s * 0.13, dcmY - 0.02, -0.26]], 0.018), S.hose, RUBBER);

  // backpack
  let backZ = 0.4;
  const nozzles: THREE.Vector3[] = [];
  const plss = (z: number, h = 0.58) => {
    sp.add(box(0.46, h, 0.2), S.pack, HARD, [0, 0.31, z]);
    sp.add(box(0.48, 0.03, 0.21), S.accent, HARD, [0, 0.31 + h / 2 - 0.05, z]);
    sp.add(box(0.36, 0.08, 0.16), S.pack, HARD, [0, 0.31 + h / 2 + 0.04, z - 0.01]);
    for (let i = 0; i < 4; i++) sp.add(box(0.3, 0.012, 0.01), '#7a808a', HARD, [0, 0.12 + i * 0.05, z + 0.102]);
    for (const s of [-1, 1]) sp.add(cyl(0.012, 0.012, h * 0.9, 8), S.ring, METAL, [s * 0.235, 0.31, z + 0.09]);
    sp.add(box(0.36, 0.14, 0.17), S.pack, HARD, [0, 0.31 - h / 2 - 0.07, z]);
    sp.add(cyl(0.007, 0.007, 0.3, 6), '#3a3d44', METAL, [0.17, 0.31 + h / 2 + 0.2, z + 0.02]);
    sp.add(sph(0.012, 8, 6), '#3a3d44', METAL, [0.17, 0.31 + h / 2 + 0.35, z + 0.02]);
  };
  switch (o.pack) {
    case 'pack-o2': {
      plss(0.27, 0.5);
      for (const s of [-1, 1]) {
        sp.add(cap(0.085, 0.36, 16), '#c9cdd3', METAL, [s * 0.12, 0.32, 0.45]);
        sp.add(cyl(0.02, 0.02, 0.05, 10), '#7a808a', METAL, [s * 0.12, 0.6, 0.45]);
        sp.add(tor(0.025, 0.008, 12), '#c03030', METAL, [s * 0.12, 0.63, 0.45], [Math.PI / 2, 0, 0]);
        sp.add(tor(0.088, 0.01, 20), S.accent, HARD, [s * 0.12, 0.2, 0.45], [Math.PI / 2, 0, 0]);
      }
      backZ = 0.54;
      for (const s of [-1, 1]) nozzles.push(new THREE.Vector3(s * 0.11, -0.03, 0.3));
      break;
    }
    case 'pack-jet':
    case 'pack-raider': {
      // the Syndicate's afterburner pack: longer black pods with red fins
      const raider = o.pack === 'pack-raider';
      plss(0.29);
      for (const s of [-1, 1]) {
        sp.add(cyl(raider ? 0.078 : 0.07, raider ? 0.078 : 0.07, raider ? 0.38 : 0.3, 14), raider ? '#24242a' : S.pack, HARD, [s * 0.29, raider ? 0.24 : 0.22, 0.31]);
        sp.add(cyl(0.05, raider ? 0.095 : 0.085, raider ? 0.11 : 0.09, 14, true), '#3a3d44', METAL, [s * 0.29, raider ? 0.0 : 0.03, 0.31]);
        sp.add(box(0.02, raider ? 0.26 : 0.18, raider ? 0.16 : 0.12), raider ? '#d0202e' : S.accent, HARD, [s * 0.37, 0.3, 0.31]);
        if (raider) sg.add(tor(0.06, 0.008, 14), '#ff4030', 1.2, [s * 0.29, 0.06, 0.31], [Math.PI / 2, 0, 0]);
        nozzles.push(new THREE.Vector3(s * 0.29, raider ? -0.04 : -0.01, 0.31));
      }
      break;
    }
    case 'pack-deep': {
      // the Guild's deep-water pack: three yellow tanks
      plss(0.27, 0.5);
      for (const x of [-0.15, 0, 0.15]) {
        sp.add(cap(0.068, 0.36, 16), '#e0b81c', HARD, [x, 0.32, 0.45]);
        sp.add(cyl(0.018, 0.018, 0.05, 10), '#7a808a', METAL, [x, 0.6, 0.45]);
        sp.add(tor(0.07, 0.009, 18), '#2a2a2a', HARD, [x, 0.22, 0.45], [Math.PI / 2, 0, 0]);
      }
      backZ = 0.53;
      for (const s of [-1, 1]) nozzles.push(new THREE.Vector3(s * 0.11, -0.03, 0.3));
      break;
    }
    case 'pack-medic': {
      plss(0.29);
      sp.add(box(0.3, 0.3, 0.05), '#f2f2f2', HARD, [0, 0.36, 0.41]);
      sp.add(box(0.2, 0.06, 0.012), '#d02a2a', HARD, [0, 0.36, 0.437]);
      sp.add(box(0.06, 0.2, 0.012), '#d02a2a', HARD, [0, 0.36, 0.437]);
      for (let i = 0; i < 3; i++) sg.add(sph(0.012, 8, 6), '#40ff80', 1.6, [-0.1 + i * 0.1, 0.18, 0.43]);
      backZ = 0.44;
      for (const s of [-1, 1]) nozzles.push(new THREE.Vector3(s * 0.11, -0.03, 0.3));
      break;
    }
    default:
      plss(0.29);
      for (const s of [-1, 1]) nozzles.push(new THREE.Vector3(s * 0.11, -0.03, 0.3));
  }
  for (const n of nozzles) sp.add(cyl(0.04, 0.055, 0.08, 12, true), '#3a3d44', METAL, [n.x, n.y + 0.04, n.z]);

  // ---- arms
  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? -1 : 1;
    const sh = P(`sh${i}`);
    sh.add(sph(0.118), S.fabric, FABRIC, [0, 0, 0], [0, 0, 0], [0.95, 1, 1]);
    sh.add(cyl(0.096, 0.086, 0.25), S.fabric, FABRIC, [0, -0.15, 0]);
    if (S.stripe) sh.add(cyl(0.099, 0.097, 0.05, 16, true), S.stripe, FABRIC, [0, -0.09, 0]);
    if (S.inserts) sh.add(box(0.02, 0.2, 0.06), S.inserts, FABRIC, [s * 0.093, -0.15, 0]);
    for (let k = 0; k < 3; k++) sh.add(tor(0.086, 0.017, 18), S.soft, SOFT, [0, -0.25 - k * 0.028, 0], [Math.PI / 2, 0, 0]);
    const el = P(`el${i}`);
    el.add(sph(0.087), S.soft, SOFT);
    el.add(cyl(0.081, 0.071, 0.22), S.fabric, FABRIC, [0, -0.13, 0]);
    el.add(tor(0.072, 0.019, 18), S.ring, METAL, [0, -0.262, 0], [Math.PI / 2, 0, 0]);
    if (s < 0) {
      // wrist checklist / computer on the left forearm
      el.add(box(0.11, 0.075, 0.13), '#3a3d44', HARD, [0.02, -0.17, -0.03], [0, 0, 0.05]);
      L(`el${i}`).add(box(0.07, 0.003, 0.08), '#6ae0ff', 0.7, [0.022, -0.17, -0.03], [0, 0, Math.PI / 2 + 0.05]);
    }
    if (S.stripe && !S.inserts) el.add(cyl(0.077, 0.075, 0.04, 16, true), S.stripe, FABRIC, [0, -0.21, 0]);
    // glove: cuff, palm, four fingers and a thumb
    const h = P(`hand${i}`);
    h.add(cyl(0.07, 0.078, 0.075, 16), S.glove, SOFT, [0, -0.015, 0]);
    h.add(cap(0.044, 0.05, 10), S.glove, SOFT, [0, -0.085, -0.005], [0, 0, 0], [1.3, 1, 0.68]);
    h.add(box(0.07, 0.07, 0.01), S.palm, RUBBER, [-s * 0.004, -0.09, 0.028]);
    for (let k = 0; k < 4; k++) h.add(cap(0.0155, 0.045, 8), S.glove, SOFT, [(-0.034 + k * 0.0227) * s, -0.15 - (k === 1 || k === 2 ? 0.006 : 0), -0.008], [0.35, 0, 0]);
    h.add(cap(0.017, 0.04, 8), S.glove, SOFT, [s * -0.03, -0.1, -0.04], [0.9, 0, s * 0.5]);
  }

  // ---- legs
  for (let i = 0; i < 2; i++) {
    const hp = P(`hip${i}`);
    hp.add(sph(0.12), S.fabric, FABRIC, [0, -0.02, 0]);
    hp.add(cyl(0.118, 0.102, 0.33), S.fabric, FABRIC, [0, -0.2, 0]);
    if (S.stripe) hp.add(cyl(0.12, 0.118, 0.05, 16, true), S.stripe, FABRIC, [0, -0.12, 0]);
    if (S.inserts) hp.add(box(0.03, 0.24, 0.08), S.inserts, FABRIC, [(i === 0 ? -1 : 1) * 0.115, -0.2, 0]);
    for (let k = 0; k < 2; k++) hp.add(tor(0.102, 0.02, 18), S.soft, SOFT, [0, -0.36 - k * 0.032, 0], [Math.PI / 2, 0, 0]);
    const kn = P(`kn${i}`);
    kn.add(sph(0.102), S.soft, SOFT);
    kn.add(box(0.11, 0.1, 0.04), S.accent, HARD, [0, 0.0, -0.095], [-0.1, 0, 0]);
    kn.add(cyl(0.097, 0.086, 0.3), S.fabric, FABRIC, [0, -0.2, 0]);
    kn.add(tor(0.088, 0.02, 18), S.ring, METAL, [0, -0.372, 0], [Math.PI / 2, 0, 0]);
    // boot: ankle collar, body, thick sole, toe cap, straps
    const an = P(`an${i}`);
    an.add(cyl(0.088, 0.098, 0.11, 16), S.boot, RUBBER, [0, 0.02, 0]);
    an.add(cap(0.072, 0.17, 12), S.boot, RUBBER, [0, -0.03, -0.045], [Math.PI / 2, 0, 0], [1.25, 1, 0.85]);
    an.add(box(0.17, 0.035, 0.31), S.sole, RUBBER, [0, -0.07, -0.045]);
    an.add(sph(0.075, 14, 10), S.boot, RUBBER, [0, -0.04, -0.17], [0, 0, 0], [1.1, 0.62, 0.8]);
    for (const z of [-0.07, 0.03]) an.add(box(0.165, 0.022, 0.025), S.accent, HARD, [0, -0.0, z]);
  }

  // ---- head: inner head in a comm cap (behind the glass), helmet shell, lamps
  const hd = P('head');
  const hg = L('head');
  const C = new THREE.Vector3(0, 0.13, -0.01);
  if (o.helmet !== 'helmet-armored') {
    hd.add(sph(0.098, 16, 12), '#d8a487', SKIN, [0, 0.11, -0.005], [0, 0, 0], [0.92, 1.05, 1]);
    hd.add(new THREE.SphereGeometry(0.106, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), '#e8e4dc', SOFT, [0, 0.112, 0.01], [-0.35, 0, 0]);
    hd.add(new THREE.SphereGeometry(0.107, 18, 10, Math.PI * 0.15, Math.PI * 0.7, Math.PI * 0.35, Math.PI * 0.35), '#5a4030', SOFT, [0, 0.11, 0.0], [0, 0, 0]);
    for (const s of [-1, 1]) {
      hd.add(cyl(0.035, 0.035, 0.03, 12), '#5a4030', SOFT, [s * 0.098, 0.1, 0.0], [0, 0, Math.PI / 2]);
      hd.add(sph(0.011, 8, 6), '#202020', SKIN, [s * 0.034, 0.128, -0.087]);
      hd.add(box(0.03, 0.006, 0.01), '#6a4a38', SKIN, [s * 0.034, 0.148, -0.088]);
      hd.add(cyl(0.004, 0.004, 0.08, 6), '#2a2a2a', METAL, [s * 0.075, 0.075, -0.055], [0.9, s * 0.6, s * 0.4]);
    }
    hd.add(new THREE.ConeGeometry(0.011, 0.028, 6), '#c89478', SKIN, [0, 0.112, -0.1], [-Math.PI / 2 - 0.3, 0, 0]);
    hd.add(box(0.03, 0.005, 0.01), '#8a5a4a', SKIN, [0, 0.085, -0.09]);
  }
  hd.add(tor(0.16, 0.024, 32), S.ring, METAL, [0, -0.005, -0.005], [Math.PI / 2, 0, 0]);
  if (o.helmet === 'helmet-panorama') {
    hd.add(tor(0.226, 0.009, 32), S.ring, METAL, [C.x, C.y + 0.01, C.z + 0.01], [0, Math.PI / 2, 0], [1, 1, 1]);
    for (const s of [-1, 1]) hd.add(box(0.04, 0.05, 0.06), S.helmet, HARD, [s * 0.215, C.y - 0.06, C.z + 0.04]);
  } else if (o.helmet === 'helmet-armored') {
    hd.add(sph(0.215, 24, 16), S.helmet === '#f2f1ec' ? '#d8dbe0' : S.helmet, HARD, [C.x, C.y, C.z], [0, 0, 0], [1, 1.02, 1.04]);
    hd.add(box(0.2, 0.08, 0.12), S.accent, HARD, [0, C.y - 0.13, C.z - 0.13], [0.35, 0, 0]);
    hd.add(box(0.02, 0.1, 0.18), S.accent, HARD, [0, C.y + 0.2, C.z + 0.02]);
    for (const s of [-1, 1]) hd.add(cyl(0.05, 0.05, 0.03, 14), S.ring, METAL, [s * 0.215, C.y, C.z], [0, 0, Math.PI / 2]);
  } else {
    // EMU bubble under the extravehicular visor assembly: shell over the top and back
    hd.add(new THREE.SphereGeometry(0.224, 28, 16, 0, Math.PI, 0, Math.PI * 0.62), S.helmet, HARD, [C.x, C.y, C.z + 0.005]);
    hd.add(new THREE.SphereGeometry(0.226, 28, 4, Math.PI, Math.PI, Math.PI * 0.08, Math.PI * 0.06), S.helmet, HARD, [C.x, C.y, C.z]);
    hd.add(box(0.05, 0.03, 0.06), '#3a3d44', HARD, [0.1, C.y + 0.21, C.z + 0.04]);
  }
  // helmet lamps in side housings (lit when the outfit has EVA lights)
  if (o.helmet !== 'helmet-armored') {
    for (const s of [-1, 1]) {
      hd.add(box(0.05, 0.06, 0.09), S.helmet, HARD, [s * 0.215, C.y + 0.07, C.z - 0.02]);
      hd.add(cyl(0.017, 0.017, 0.012, 12), '#2a2d33', METAL, [s * 0.215, C.y + 0.07, C.z - 0.068], [Math.PI / 2, 0, 0]);
      hg.add(cyl(0.014, 0.014, 0.006, 12), '#fff4dc', 1, [s * 0.215, C.y + 0.07, C.z - 0.076], [Math.PI / 2, 0, 0]);
    }
  } else {
    for (const s of [-1, 1]) hg.add(box(0.03, 0.012, 0.006), '#fff4dc', 1, [s * 0.11, C.y + 0.1, C.z - 0.21]);
  }

  const out: Built = { body: new Map(), glow: new Map(), nozzles, backZ };
  for (const [k, p] of body) { const g = p.merge(); if (g) out.body.set(k, g); }
  for (const [k, p] of glow) { const g = p.merge(); if (g) out.glow.set(k, g); }
  built.set(key, out);
  return out;
}

/** Dresses the rig: adds the suit meshes to the joints and returns handles for the animated bits. */
export function buildSuit(j: SuitJoints, o: Outfit, name: string): Suit {
  const b = buildGeometry(o);
  const added: THREE.Object3D[] = [];
  const joint = (k: string): THREE.Object3D => {
    if (k === 'hips') return j.hips;
    if (k === 'spine') return j.spine;
    if (k === 'head') return j.head;
    const i = Number(k.slice(-1));
    const base = k.slice(0, -1) as 'sh' | 'el' | 'hand' | 'hip' | 'kn' | 'an';
    return j[base][i];
  };
  const put = (parent: THREE.Object3D, m: THREE.Object3D) => { parent.add(m); added.push(m); return m; };
  // geometry made for this suit alone (the joint geometry is cached and shared)
  const own: THREE.BufferGeometry[] = [];
  const body = bodyMaterial();
  for (const [k, g] of b.body) {
    const m = new THREE.Mesh(g, body);
    m.castShadow = true;
    m.receiveShadow = true;
    put(joint(k), m);
  }
  const lamps = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, color: new THREE.Color(0.25, 0.25, 0.25) });
  for (const [k, g] of b.glow) put(joint(k), new THREE.Mesh(g, k === 'head' ? lamps : glowMat));

  // helmet glass and visor
  const C = new THREE.Vector3(0, 0.13, -0.01);
  let visor: THREE.Object3D | null = null;
  let face = false;
  if (o.helmet !== 'helmet-armored') {
    const r = o.helmet === 'helmet-panorama' ? 0.23 : 0.205;
    const glass = new THREE.Mesh(new THREE.SphereGeometry(r, 28, 18), glassMaterial());
    own.push(glass.geometry);
    glass.position.copy(C);
    glass.renderOrder = 2;
    put(j.head, glass);
    face = true;
    // the visor: a shell over the front that slides up over the top
    const pivot = new THREE.Group();
    pivot.position.copy(C);
    const vr = r + 0.012;
    const band = o.helmet === 'helmet-panorama' ? [0.12, 0.3] : [0.2, 0.42];
    const v = new THREE.Mesh(new THREE.SphereGeometry(vr, 28, 12, Math.PI * 1.08, Math.PI * 0.84, Math.PI * band[0], Math.PI * band[1]), visorMaterial(o.visor));
    v.renderOrder = 3;
    own.push(v.geometry);
    pivot.add(v);
    put(j.head, pivot);
    visor = pivot;
  } else {
    // armoured helmet: a narrow visor slit
    const v = new THREE.Mesh(new THREE.SphereGeometry(0.222, 24, 6, Math.PI * 1.22, Math.PI * 0.56, Math.PI * 0.42, Math.PI * 0.12), visorMaterial(o.visor === 'visor-clear' ? 'visor-silver' : o.visor));
    v.position.copy(C);
    own.push(v.geometry);
    put(j.head, v);
  }

  // decals: flag on the left shoulder, mission patch on the right, name on the chest module
  const plane = (w: number, h: number) => { const g = new THREE.PlaneGeometry(w, h); own.push(g); return g; };
  const flag = new THREE.Mesh(plane(0.085, 0.056), decalMaterial(flagTexture()));
  flag.position.set(-0.123, -0.05, 0);
  flag.rotation.set(0, -Math.PI / 2, 0);
  put(j.sh[0], flag);
  const patch = new THREE.Mesh(plane(0.075, 0.075), decalMaterial(patchTexture(o.patch), true));
  patch.position.set(0.123, -0.05, 0);
  patch.rotation.set(0, Math.PI / 2, 0);
  put(j.sh[1], patch);
  if (name) {
    const dcmY = o.chest === 'chest-plate' || o.chest === 'chest-aegis' ? 0.16 : 0.36;
    const tag = new THREE.Mesh(plane(0.2, 0.04), decalMaterial(nameTexture(name)));
    tag.position.set(0, dcmY + 0.04, -0.2785);
    tag.rotation.y = Math.PI;
    put(j.spine, tag);
  }
  return {
    visor, face, lamps, nozzles: b.nozzles, backZ: b.backZ,
    dispose() {
      for (const m of added) m.removeFromParent();
      for (const g of own) g.dispose();
      lamps.dispose();
    },
  };
}
