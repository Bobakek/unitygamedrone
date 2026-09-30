import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { Quality } from './quality.ts';

/** Gentle colour grade in linear HDR: contrast, saturation, warm/cool split and vignette. */
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, vignette: { value: 0.32 }, saturation: { value: 1.1 }, contrast: { value: 1.05 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float vignette; uniform float saturation; uniform float contrast; varying vec2 vUv;
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = mix(vec3(l), c.rgb, saturation);
      c.rgb = pow(max(c.rgb, 0.0), vec3(contrast)) * mix(vec3(1.0, 0.99, 1.03), vec3(1.03, 1.0, 0.96), smoothstep(0.0, 0.6, l));
      vec2 d = vUv - 0.5;
      c.rgb *= 1.0 - vignette * smoothstep(0.35, 0.85, length(d * vec2(1.25, 1.0)));
      gl_FragColor = c;
    }`,
};

/** WebGL renderer with log depth (0.1 m … 2000 km in one frustum), bloom and grading. */
export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private composer: EffectComposer | null = null;
  q: Quality;

  constructor(canvas: HTMLCanvasElement, q: Quality) {
    this.q = q;
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
    this.gl.toneMapping = THREE.NeutralToneMapping;
    this.gl.toneMappingExposure = 1.0;
    this.gl.shadowMap.type = THREE.PCFShadowMap;
    this.camera = new THREE.PerspectiveCamera(65, 1, 0.1, 3e6);
    this.apply(q);
    window.addEventListener('resize', () => this.resize());
  }

  get low() {
    return this.q.level === 'low';
  }

  /** (Re)builds the post chain and resolution for a quality preset. */
  apply(q: Quality) {
    const shadowsChanged = this.q.shadows !== q.shadows;
    this.q = q;
    const dpr = window.devicePixelRatio || 1;
    this.gl.setPixelRatio(q.pixelRatio < 1 ? Math.min(dpr, 1) * q.pixelRatio : Math.min(dpr, q.pixelRatio));
    this.gl.shadowMap.enabled = q.shadows;
    this.composer?.dispose();
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: q.msaa });
    this.composer = new EffectComposer(this.gl, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    if (q.bloom) this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.45, 0.5, 0.88));
    if (q.grade) this.composer.addPass(new ShaderPass(GradeShader));
    this.composer.addPass(new OutputPass());
    if (shadowsChanged) {
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(m)) m.forEach((x) => (x.needsUpdate = true));
        else if (m) m.needsUpdate = true;
      });
    }
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.gl.setSize(w, h, false);
    this.composer!.setPixelRatio(this.gl.getPixelRatio());
    this.composer!.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.composer!.render();
  }
}
