import * as THREE from 'three';
import type { StarDef } from '../../shared/galaxy/system-gen.ts';
import { mulberry32 } from '../../shared/math/rng.ts';
import { glowTexture } from './textures.ts';

const NOISE_GLSL = `
float hash(vec3 p){ p = fract(p*0.3183099+.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float vnoise(vec3 x){ vec3 i=floor(x); vec3 f=fract(x); f=f*f*(3.0-2.0*f);
 return mix(mix(mix(hash(i+vec3(0,0,0)),hash(i+vec3(1,0,0)),f.x), mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
            mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x), mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z); }
float fbm3(vec3 p){ float a=0.5, s=0.0; for(int i=0;i<6;i++){ s+=a*vnoise(p); p*=2.02; a*=0.5; } return s; }
`;

/**
 * Space backdrop (nebula shader + star field) baked once per system into a
 * cube map and used as scene.background — a single texture lookup per pixel.
 */
export class SpaceBackdrop {
  readonly texture: THREE.CubeTexture;
  private rt: THREE.WebGLCubeRenderTarget;

  constructor(renderer: THREE.WebGLRenderer, seed: number, size = 1024) {
    const rnd = mulberry32(seed);
    const palettes = [['#2c2a7a', '#b04a8a'], ['#173f6e', '#3fa0a0'], ['#4a1f5e', '#c0603a'], ['#1e2a6e', '#6a3cb0']];
    const pal = palettes[Math.floor(rnd() * palettes.length)];
    const scene = new THREE.Scene();
    const neb = new THREE.ShaderMaterial({
      uniforms: { bg: { value: new THREE.Color('#050818') }, c1: { value: new THREE.Color(pal[0]) }, c2: { value: new THREE.Color(pal[1]) }, amt: { value: 0.5 }, axis: { value: new THREE.Vector3(rnd() - 0.5, 1, rnd() - 0.5).normalize() } },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: NOISE_GLSL + `uniform vec3 bg,c1,c2,axis; uniform float amt; varying vec3 vDir;
        void main(){ vec3 d = normalize(vDir); float band = exp(-pow(dot(d, axis)*2.4, 2.0));
          float n = fbm3(d*2.4); float m = fbm3(d*4.5+3.1);
          float neb = smoothstep(0.38,0.8,n)*band;
          vec3 col = bg + mix(c1,c2,smoothstep(0.3,0.7,m))*neb*amt + c1*band*0.1*amt;
          gl_FragColor = vec4(col,1.0); }`,
      side: THREE.BackSide, depthWrite: false,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 64, 32), neb);
    sky.renderOrder = -1;
    scene.add(sky);
    const c = new THREE.Color();
    for (const [count, px] of [[6000, 1.0], [300, 2.0]] as const) {
      const pos = new Float32Array(count * 3), col = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u);
        pos.set([Math.cos(a) * s * 800, u * 800, Math.sin(a) * s * 800], i * 3);
        c.setHSL(0.5 + rnd() * 0.2, 0.35, 0.75).multiplyScalar(0.4 + rnd() * 0.9);
        col.set([c.r, c.g, c.b], i * 3);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const m = new THREE.PointsMaterial({ size: px * (size / 1024), sizeAttenuation: false, vertexColors: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, transparent: true });
      scene.add(new THREE.Points(geo, m));
    }
    this.rt = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false });
    const cam = new THREE.CubeCamera(1, 2000, this.rt);
    const tm = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    cam.update(renderer, scene);
    renderer.toneMapping = tm;
    this.texture = this.rt.texture;
    scene.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material | undefined)?.dispose(); });
  }

  dispose() {
    this.rt.dispose();
  }
}

/** Glowing star mesh + corona sprite at the system origin. */
export class Sun {
  readonly group = new THREE.Group();
  readonly color: THREE.Color;
  constructor(def: StarDef) {
    this.color = new THREE.Color(def.color);
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(def.radius, 3), new THREE.MeshBasicMaterial({ color: this.color.clone().multiplyScalar(3.2), toneMapped: false }));
    const corona = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: this.color.clone().multiplyScalar(1.4), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
    corona.scale.setScalar(def.radius * 9);
    this.group.add(core, corona);
  }
}
