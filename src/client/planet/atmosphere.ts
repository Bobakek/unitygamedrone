import * as THREE from 'three';
import type { AtmosphereDef } from '../../shared/galaxy/system-gen.ts';
import { LOGDEPTH_FS, LOGDEPTH_FS_PARS, LOGDEPTH_VS, LOGDEPTH_VS_PARS } from '../world/textures.ts';

const VS = `varying vec3 vN; varying vec3 vV; varying vec3 vNW;
${LOGDEPTH_VS_PARS}
void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); vNW = normalize(mat3(modelMatrix)*normal); gl_Position = projectionMatrix*mv;
${LOGDEPTH_VS}
}`;
const OUTER_FS = `uniform vec3 c; uniform vec3 sun; uniform float k; uniform float edge; varying vec3 vN; varying vec3 vV; varying vec3 vNW;
${LOGDEPTH_FS_PARS}
void main(){
${LOGDEPTH_FS}
  float d = dot(vN, vV); float i = pow(smoothstep(0.0, edge, -d), 1.6); float lit = smoothstep(-0.35, 0.5, dot(vNW, sun));
  gl_FragColor = vec4(c * i * (0.12 + lit) * k * 1.3, 1.0); }`;
const INNER_FS = `uniform vec3 c; uniform vec3 sun; uniform float k; varying vec3 vN; varying vec3 vV; varying vec3 vNW;
${LOGDEPTH_FS_PARS}
void main(){
${LOGDEPTH_FS}
  float d = max(dot(vN, vV), 0.0); float i = pow(1.0 - d, 4.0); float lit = smoothstep(-0.25, 0.6, dot(vNW, sun));
  gl_FragColor = vec4(c * i * (0.08 + lit) * k * 1.1, 1.0); }`;

/** Fresnel atmosphere shells seen from space (faded out once inside the atmosphere). */
export class AtmosphereView {
  readonly group = new THREE.Group();
  readonly uniforms: { c: { value: THREE.Color }; sun: { value: THREE.Vector3 }; k: { value: number }; edge: { value: number } };
  constructor(radius: number, def: AtmosphereDef) {
    const outerR = radius * (1 + def.height * 0.6);
    this.uniforms = { c: { value: new THREE.Color(def.color) }, sun: { value: new THREE.Vector3(1, 0, 0) }, k: { value: 1 }, edge: { value: Math.sqrt(1 - (radius / outerR) ** 2) } };
    const mk = (r: number, fs: string, side: THREE.Side) =>
      new THREE.Mesh(new THREE.SphereGeometry(r, 64, 40), new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VS, fragmentShader: fs, side, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
    this.group.add(mk(outerR, OUTER_FS, THREE.BackSide), mk(radius * 1.004, INNER_FS, THREE.FrontSide));
  }
}

const SKY_FS = `uniform vec3 zen; uniform vec3 hor; uniform vec3 up; uniform vec3 sun; uniform vec3 sunC; uniform vec3 sunset; uniform vec3 ground; uniform float alpha; uniform float day; varying vec3 vDir;
void main(){
  vec3 d = normalize(vDir);
  float e = dot(d, up);
  vec3 col = mix(hor, zen, pow(clamp(e, 0.0, 1.0), 0.45));
  // sunrise / sunset: warm band on the horizon, strongest towards the sun
  float se = dot(sun, up);
  float dusk = smoothstep(0.5, 0.05, se) * smoothstep(-0.3, 0.02, se);
  vec3 hd = d - up * e, hs = sun - up * se;
  float toward = pow(max(dot(hd, hs) / (length(hd) * length(hs) + 1e-4), 0.0), 2.0);
  col = mix(col, sunset, dusk * (1.0 - smoothstep(0.0, 0.55, e)) * (0.3 + 0.7 * toward));
  col = mix(col, ground, smoothstep(0.0, 0.25, -e));
  col *= 0.07 + 0.93 * day;
  float s = max(dot(d, sun), 0.0);
  col += sunC * (pow(s, 900.0) * 6.0 + pow(s, 8.0) * (0.22 + 0.4 * dusk) * day);
  gl_FragColor = vec4(col, alpha * (0.35 + 0.65 * day)); }`;

const SKY_VS = 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }';

export function skyUniforms() {
  return {
    zen: { value: new THREE.Color() }, hor: { value: new THREE.Color() }, up: { value: new THREE.Vector3(0, 1, 0) },
    sun: { value: new THREE.Vector3(1, 0, 0) }, sunC: { value: new THREE.Color('#fff4e0') }, sunset: { value: new THREE.Color('#ff8a4a') },
    ground: { value: new THREE.Color('#3a3530') }, alpha: { value: 0 }, day: { value: 1 },
  };
}
export type SkyUniforms = ReturnType<typeof skyUniforms>;

/** Camera-attached sky gradient used while inside a planet's atmosphere. */
export class SkyDome {
  readonly mesh: THREE.Mesh;
  readonly u = skyUniforms();
  constructor() {
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(700, 32, 16),
      new THREE.ShaderMaterial({
        uniforms: this.u, vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, depthTest: false,
        // opaque pass + manual alpha blending, drawn right after the space backdrop
        transparent: false, blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      }),
    );
    this.mesh.renderOrder = -8;
    this.mesh.frustumCulled = false;
  }
}

/**
 * Image-based lighting: a pre-filtered environment of the space backdrop, and
 * one rendered from the current sky (regenerated as the sun, the planet or
 * the local "up" change) so water, glass and metal reflect their surroundings.
 */
export class EnvLighting {
  private pmrem: THREE.PMREMGenerator;
  private spaceRT: THREE.WebGLRenderTarget | null = null;
  private skyRT: THREE.WebGLRenderTarget | null = null;
  private scene = new THREE.Scene();
  private u = skyUniforms();
  private last = { planet: -1, day: -9, up: new THREE.Vector3(), sys: -1 };

  constructor(renderer: THREE.WebGLRenderer) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.u.alpha.value = 1;
    const m = new THREE.ShaderMaterial({ uniforms: this.u, vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false });
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), m));
  }

  space(cube: THREE.CubeTexture): THREE.Texture {
    this.spaceRT?.dispose();
    this.spaceRT = this.pmrem.fromCubemap(cube);
    return this.spaceRT.texture;
  }

  get spaceTexture() {
    return this.spaceRT?.texture ?? null;
  }

  /** Returns the sky environment, re-rendering it only when the inputs moved enough. */
  sky(planetKey: number, from: SkyUniforms): THREE.Texture {
    const up = from.up.value;
    const stale = !this.skyRT || planetKey !== this.last.planet || Math.abs(from.day.value - this.last.day) > 0.06 || up.angleTo(this.last.up) > 0.12;
    if (stale) {
      for (const k of Object.keys(this.u) as (keyof SkyUniforms)[]) {
        if (k === 'alpha') continue;
        const v = this.u[k].value as { copy(o: unknown): unknown } | number;
        if (typeof v === 'number') (this.u[k] as { value: number }).value = from[k].value as number;
        else v.copy(from[k].value);
      }
      this.skyRT?.dispose();
      this.skyRT = this.pmrem.fromScene(this.scene, 0.02, 0.1, 100);
      this.last.planet = planetKey;
      this.last.day = from.day.value;
      this.last.up.copy(up);
    }
    return this.skyRT!.texture;
  }
}
