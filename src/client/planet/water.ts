import * as THREE from 'three';
import type { PlanetDef } from '../../shared/galaxy/system-gen.ts';
import { waterColors } from '../../shared/planet/terrain.ts';

/**
 * Sea water: a transparent surface whose colour, clarity and foam come from the
 * sea-bed depth under each vertex, with a rolling swell, fine ripples, breakers
 * running up the beach and a Snell's window when seen from below; plus the sea
 * bed's caustics and blue-green absorption. Everything is evaluated in the
 * planet's body frame so the waves ride the rotating planet.
 */
export interface SeaUniforms {
  uTime: { value: number };
  /** World (render) → body rotation, and its inverse. */
  uRotInv: { value: THREE.Matrix3 };
  uRot: { value: THREE.Matrix3 };
  /** Camera position in the body frame (render origin = camera). */
  uCamB: { value: THREE.Vector3 };
  uRadius: { value: number };
  uShallow: { value: THREE.Color };
  uDeep: { value: THREE.Color };
  /** Sun direction in the body frame and daylight 0..1 at the camera. */
  uSunB: { value: THREE.Vector3 };
  uDay: { value: number };
  /** Two body axes spanning the caustics plane (least aligned with the camera's up). */
  uCA: { value: THREE.Vector3 };
  uCB: { value: THREE.Vector3 };
  uSwell: { value: THREE.Vector4[] };
  uSwellA: { value: number[] };
  uRip: { value: THREE.Vector4[] };
}

const G = 9.8;
/** Wave set: direction (spread over the sphere so every place gets crossing waves), wavelength, amplitude. */
function waves(n: number, lmin: number, lmax: number, seed: number): { k: THREE.Vector4[]; a: number[] } {
  const k: THREE.Vector4[] = [], a: number[] = [];
  for (let i = 0; i < n; i++) {
    // golden-spiral directions
    const y = 1 - ((i + 0.5) / n) * 2, r = Math.sqrt(1 - y * y), ph = i * 2.39996 + seed;
    const d = new THREE.Vector3(Math.cos(ph) * r, y, Math.sin(ph) * r);
    const L = lmax * Math.pow(lmin / lmax, i / Math.max(1, n - 1));
    const kk = (Math.PI * 2) / L;
    k.push(new THREE.Vector4(d.x * kk, d.y * kk, d.z * kk, Math.sqrt(G * kk)));
    a.push(L * 0.0075);
  }
  return { k, a };
}

export function seaUniforms(def: PlanetDef): SeaUniforms {
  const [sh, dp] = waterColors(def);
  const sw = waves(5, 14, 52, def.seed % 7);
  const rp = waves(7, 0.9, 4.5, 1.3 + (def.seed % 5));
  return {
    uTime: { value: 0 }, uRotInv: { value: new THREE.Matrix3() }, uRot: { value: new THREE.Matrix3() }, uCamB: { value: new THREE.Vector3() },
    uRadius: { value: def.radius },
    uShallow: { value: new THREE.Color(sh[0], sh[1], sh[2]) }, uDeep: { value: new THREE.Color(dp[0], dp[1], dp[2]) },
    uSunB: { value: new THREE.Vector3(0, 1, 0) }, uDay: { value: 1 },
    uCA: { value: new THREE.Vector3(1, 0, 0) }, uCB: { value: new THREE.Vector3(0, 0, 1) },
    uSwell: { value: sw.k }, uSwellA: { value: sw.a }, uRip: { value: rp.k },
  };
}

const m4 = new THREE.Matrix4(), qi = new THREE.Quaternion(), sunB = new THREE.Vector3();

/** Per frame: planet orientation, camera (body frame, metres), time, sun (world) and daylight. */
export function updateSea(u: SeaUniforms, groupQ: THREE.Quaternion, camB: THREE.Vector3, time: number, sunWorld: THREE.Vector3 | null, day: number) {
  u.uTime.value = time;
  u.uRot.value.setFromMatrix4(m4.makeRotationFromQuaternion(groupQ));
  u.uRotInv.value.setFromMatrix4(m4.makeRotationFromQuaternion(qi.copy(groupQ).invert()));
  u.uCamB.value.copy(camB);
  if (sunWorld) u.uSunB.value.copy(sunB.copy(sunWorld).applyQuaternion(qi).normalize());
  u.uDay.value = day;
  // caustics are projected on the body plane facing the camera's "up" most squarely
  const ax = Math.abs(camB.x), ay = Math.abs(camB.y), az = Math.abs(camB.z);
  if (ax >= ay && ax >= az) { u.uCA.value.set(0, 1, 0); u.uCB.value.set(0, 0, 1); }
  else if (ay >= az) { u.uCA.value.set(1, 0, 0); u.uCB.value.set(0, 0, 1); }
  else { u.uCA.value.set(1, 0, 0); u.uCB.value.set(0, 1, 0); }
}

const COMMON = /* glsl */ `
uniform float uTime; uniform mat3 uRotInv; uniform mat3 uRot; uniform vec3 uCamB; uniform float uRadius;
uniform vec3 uShallow; uniform vec3 uDeep; uniform vec3 uSunB; uniform float uDay;
uniform vec4 uSwell[5]; uniform float uSwellA[5]; uniform vec4 uRip[7];
float swell(vec3 x, out vec3 grad) {
  float h = 0.0; grad = vec3(0.0);
  for (int i = 0; i < 5; i++) {
    float ph = dot(uSwell[i].xyz, x) - uSwell[i].w * uTime;
    // slightly peaked crests
    float s = sin(ph), c = cos(ph);
    h += uSwellA[i] * (s + 0.25 * (1.0 - c * c));
    grad += uSwellA[i] * c * (1.0 + 0.5 * s) * uSwell[i].xyz;
  }
  return h;
}
/** Breakers running toward the shore: crests follow the depth contours. */
float breaker(float depth) {
  float band = smoothstep(0.15, 0.9, depth) * (1.0 - smoothstep(2.6, 4.8, depth));
  return band * pow(0.5 + 0.5 * sin(depth * 2.4 + uTime * 1.5), 6.0);
}
`;

/** Material for liquid water (terran / ocean / alien seas). */
export function waterMaterial(u: SeaUniforms): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.05, metalness: 0, transparent: true, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 0.5 });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = `attribute float seabed; varying vec3 vB; varying vec3 vUpB; varying float vDepth; varying float vDist;\n${COMMON}\n`
      + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 rp = (modelMatrix * vec4(position, 1.0)).xyz;
        vB = uRotInv * rp + uCamB;
        vUpB = normal;
        vDepth = -seabed;
        vDist = length(rp);
        vec3 g;
        float amp = smoothstep(0.3, 6.0, vDepth) * (1.0 - 0.7 * smoothstep(250.0, 1200.0, vDist));
        transformed += normal * (swell(vB, g) * amp + breaker(vDepth) * 0.3);`);
    sh.fragmentShader = `varying vec3 vB; varying vec3 vUpB; varying float vDepth; varying float vDist;\n${COMMON}\n`
      + sh.fragmentShader
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        vec3 wUpB = normalize(vUpB);
        float nearK = 1.0 - smoothstep(6.0, 90.0, vDist);
        float midK = 1.0 - smoothstep(150.0, 1000.0, vDist);
        float ampK = smoothstep(0.3, 6.0, vDepth);
        vec3 wSg;
        float wHs = swell(vB, wSg);
        wSg *= ampK * midK;
        vec3 wRg = vec3(0.0);
        float wRn = 0.0;
        for (int i = 0; i < 7; i++) {
          float wPh = dot(uRip[i].xyz, vB) - uRip[i].w * uTime;
          wRn += sin(wPh);
          wRg += cos(wPh) * normalize(uRip[i].xyz) * 0.045;
        }
        wRn /= 3.5;
        vec3 wGrad = wSg + wRg * nearK;
        wGrad -= wUpB * dot(wGrad, wUpB);
        vec3 wNB = normalize(wUpB - wGrad);
        vec3 wV = normalize(uCamB - vB);
        float wCosV = clamp(abs(dot(wV, wNB)), 0.0, 1.0);
        float wDep = max(vDepth, 0.0);
        // light scattered in the water: turquoise shallows, deep blue offshore
        vec3 wBody = mix(uShallow * 1.3, uDeep * 0.75, 1.0 - exp(-wDep * 0.11));
        // see-through: transmittance along the view path to the sea bed, plus Fresnel
        // (clarity follows the smooth surface; ripples only move the reflections)
        float wT = exp(-wDep * 0.24 / max(abs(dot(wV, wUpB)), 0.12));
        float wFres = 0.02 + 0.98 * pow(1.0 - wCosV, 5.0);
        float wAlpha = clamp(1.0 - wT * (1.0 - wFres), 0.0, 1.0);
        // foam: the wash on the beach, lines on the breakers, caps on big swell crests
        float wFn = 0.5 + 0.5 * clamp(wRn, -1.0, 1.0);
        float wWash = (1.0 - smoothstep(0.0, 0.3 + 0.35 * wFn, vDepth)) * step(-0.5, vDepth);
        float wPh = vDepth * 2.4 + uTime * 1.5 + wFn * 1.2;
        float wBand = smoothstep(0.15, 0.9, vDepth) * (1.0 - smoothstep(2.6, 4.8, vDepth));
        float wLines = wBand * (pow(0.5 + 0.5 * sin(wPh), 16.0) * (0.55 + 0.6 * wFn) + pow(0.5 + 0.5 * sin(wPh - 0.7), 4.0) * 0.18 * wFn);
        float wCaps = smoothstep(0.5, 0.95, wHs / 0.55) * smoothstep(0.55, 0.9, wFn) * 0.6 * ampK * midK;
        float wFoam = clamp(wWash * 0.95 + wLines + wCaps, 0.0, 1.0);
        diffuseColor.rgb = mix(wBody, vec3(0.93, 0.96, 0.98), wFoam);
        diffuseColor.a = max(wAlpha, wFoam * 0.97);
        roughnessFactor = mix(0.04 + 0.1 * (1.0 - midK), 0.8, wFoam);
        // light shining through wave crests
        float wSss = smoothstep(0.1, 0.7, wHs / 0.55) * ampK * midK * uDay * max(0.0, dot(uSunB, wUpB)) * 0.35;
        normal = normalize(mat3(viewMatrix) * (uRot * wNB));
        if (!gl_FrontFacing) normal = -normal;`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += uShallow * wSss * (1.0 - wFoam);`)
        .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        if (!gl_FrontFacing) {
          // from below: Snell's window to the sky, total internal reflection outside it
          float wCw = clamp(dot(wV, -wNB), 0.0, 1.0);
          float wWin = smoothstep(0.6, 0.76, wCw);
          vec3 wBelow = uDeep * (0.08 + 0.3 * uDay);
          vec3 wSky = mix(uShallow, vec3(1.0), 0.6) * (0.2 + 1.3 * uDay);
          float wGlare = pow(max(dot(-wV, uSunB), 0.0), 40.0) * 4.0 * uDay;
          gl_FragColor = vec4(mix(wBelow, wSky + wGlare, wWin) + wFoam * 0.3 * uDay, 0.94);
        }`);
  };
  m.customProgramCacheKey = () => 'sea-water';
  return m;
}

/** Terrain material for water worlds: caustics and blue-green absorption on the sea bed. */
export function seaBedMaterial(base: THREE.MeshStandardMaterial, u: SeaUniforms): THREE.MeshStandardMaterial {
  const m = base.clone();
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = `varying vec3 vB; varying float vSeaD;\nuniform mat3 uRotInv; uniform vec3 uCamB; uniform float uRadius;\n`
      + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        vB = uRotInv * (modelMatrix * vec4(position, 1.0)).xyz + uCamB;
        vSeaD = uRadius - length(vB);`);
    sh.fragmentShader = `varying vec3 vB; varying float vSeaD;\nuniform float uTime; uniform vec3 uCA; uniform vec3 uCB; uniform vec3 uShallow; uniform vec3 uDeep;
      float caustic(vec2 uv, float time) {
        // tileable caustic network (period 1 in uv)
        vec2 p = mod(uv * 6.2831853, 6.2831853) - 250.0;
        vec2 i = p;
        float c = 1.0;
        for (int n = 0; n < 4; n++) {
          float t = time * (1.0 - 3.5 / float(n + 1));
          i = p + vec2(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
          c += 1.0 / length(vec2(p.x / (sin(i.x + t) / 0.005), p.y / (cos(i.y + t) / 0.005)));
        }
        c /= 4.0;
        c = 1.17 - pow(c, 1.4);
        return pow(abs(c), 8.0);
      }\n`
      + sh.fragmentShader.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        if (vSeaD > 0.0) {
          vec2 cuv = vec2(dot(vB, uCA), dot(vB, uCB)) / 7.0;
          float ca = caustic(cuv, uTime * 0.55) * 1.4;
          float k = smoothstep(0.0, 0.5, vSeaD) * exp(-vSeaD * 0.06) * 1.5;
          reflectedLight.directDiffuse *= 1.0 + clamp(ca, 0.0, 2.0) * k;
          vec3 tint = mix(vec3(1.0), mix(uShallow, uDeep, smoothstep(4.0, 40.0, vSeaD)) * 1.4, smoothstep(0.0, 12.0, vSeaD) * 0.85);
          reflectedLight.directDiffuse *= tint;
          reflectedLight.indirectDiffuse *= tint;
        }`);
  };
  m.customProgramCacheKey = () => 'sea-bed';
  return m;
}
