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

const SKY_FS = `uniform vec3 zen; uniform vec3 hor; uniform vec3 up; uniform vec3 sun; uniform vec3 sunC; uniform float alpha; uniform float day; varying vec3 vDir;
void main(){
  vec3 d = normalize(vDir);
  float e = dot(d, up);
  vec3 col = mix(hor, zen, pow(clamp(e, 0.0, 1.0), 0.45));
  col = mix(col, hor * 0.6, clamp(-e * 4.0, 0.0, 1.0));
  col *= 0.08 + 0.92 * day;
  float s = max(dot(d, sun), 0.0);
  col += sunC * (pow(s, 900.0) * 6.0 + pow(s, 8.0) * 0.22 * day);
  gl_FragColor = vec4(col, alpha * (0.35 + 0.65 * day)); }`;

/** Camera-attached sky gradient used while inside a planet's atmosphere. */
export class SkyDome {
  readonly mesh: THREE.Mesh;
  readonly u = {
    zen: { value: new THREE.Color() }, hor: { value: new THREE.Color() }, up: { value: new THREE.Vector3(0, 1, 0) },
    sun: { value: new THREE.Vector3(1, 0, 0) }, sunC: { value: new THREE.Color('#fff4e0') }, alpha: { value: 0 }, day: { value: 1 },
  };
  constructor() {
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(700, 32, 16),
      new THREE.ShaderMaterial({
        uniforms: this.u,
        vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
        fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, depthTest: false,
        // opaque pass + manual alpha blending, drawn right after the space backdrop
        transparent: false, blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      }),
    );
    this.mesh.renderOrder = -8;
    this.mesh.frustumCulled = false;
  }
}
