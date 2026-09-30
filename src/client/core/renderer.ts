import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/** WebGL renderer with log depth (0.1 m … 2000 km in one frustum) and a soft bloom pass. */
export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private composer: EffectComposer;
  /** Low quality — lower resolution, no MSAA/bloom/shadows for weak GPUs. */
  constructor(canvas: HTMLCanvasElement, readonly low = false) {
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: !this.low, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
    this.gl.setPixelRatio(this.low ? Math.min(window.devicePixelRatio, 1) * 0.75 : Math.min(window.devicePixelRatio, 1.75));
    this.gl.toneMapping = THREE.NeutralToneMapping;
    this.gl.toneMappingExposure = 1.0;
    this.gl.shadowMap.enabled = !this.low;
    this.gl.shadowMap.type = THREE.PCFShadowMap;
    this.camera = new THREE.PerspectiveCamera(65, 1, 0.1, 3e6);
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: this.low ? 0 : 4 });
    this.composer = new EffectComposer(this.gl, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    if (!this.low) this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.45, 0.5, 0.88));
    this.composer.addPass(new OutputPass());
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.gl.setSize(w, h, false);
    this.composer.setPixelRatio(this.gl.getPixelRatio());
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.composer.render();
  }
}
