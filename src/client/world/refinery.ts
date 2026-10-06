import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import refineryUrl from '../assets/refinery.glb?url';
import { REFINERY } from '../../shared/station/deck.ts';

/**
 * The smelter on the promenade, modelled in Blender (tools/blender/build_refinery.py →
 * assets/refinery.glb), in deck coordinates. It works while you watch: the furnace hatch
 * and the molten stream flicker and light the floor, moulds ride the conveyor and cool
 * from orange to steel on the way, the robot arm swings and the crystal on the cutting
 * chuck spins under the laser.
 */
let template: Promise<THREE.Object3D> | null = null;
function loadRefinery(): Promise<THREE.Object3D> {
  template ??= new GLTFLoader().loadAsync(refineryUrl).then((g) => {
    g.scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.receiveShadow = true;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (m.name === 'Glass') Object.assign(m, { transparent: true, opacity: 0.16, depthWrite: false });
      }
    });
    return g.scene;
  });
  return template;
}

const HOT = new THREE.Color('#ff6a10'), COLD = new THREE.Color('#000000');
const HOT_BASE = new THREE.Color('#ff9a40'), COLD_BASE = new THREE.Color('#c8ccd2');

export class RefineryView {
  readonly group = new THREE.Group();
  private ingots: { o: THREE.Object3D; mat: THREE.MeshStandardMaterial }[] = [];
  private x0 = 0;
  private x1 = 1;
  private chuck: THREE.Object3D | null = null;
  private arm: THREE.Object3D | null = null;
  /** Glowing materials with their emission strength from the model. */
  private molten: [THREE.MeshStandardMaterial, number][] = [];
  private laser: [THREE.MeshStandardMaterial, number][] = [];
  private light = new THREE.PointLight('#ff7a20', 30, 14, 1.6);
  private disposed = false;

  constructor() {
    this.light.position.set(REFINERY.furnace.x, 1.9, REFINERY.furnace.z + 2.2);
    this.group.add(this.light);
    loadRefinery().then((scene) => {
      if (this.disposed) return;
      const room = scene.clone(true);
      room.traverse((o) => {
        if (/^Ingot_\d+$/.test(o.name) && o instanceof THREE.Mesh) {
          // each mould cools on its own: its own copy of the hot material
          const mats = (Array.isArray(o.material) ? o.material : [o.material]).map((m) => m.name === 'HotIngot' ? m.clone() : m);
          o.material = Array.isArray(o.material) ? mats : mats[0];
          const mat = mats.find((m) => m.name === 'HotIngot') as THREE.MeshStandardMaterial | undefined;
          if (mat) this.ingots.push({ o, mat });
        }
        if (!(o instanceof THREE.Mesh)) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          const list = m.name === 'Molten' ? this.molten : m.name === 'Laser' ? this.laser : null;
          const sm = m as THREE.MeshStandardMaterial;
          if (list && !list.some(([x]) => x === sm)) list.push([sm, sm.emissiveIntensity]);
        }
      });
      this.chuck = room.getObjectByName('Chuck') ?? null;
      this.arm = room.getObjectByName('Arm') ?? null;
      if (this.ingots.length > 1) {
        const xs = this.ingots.map((i) => i.o.position.x);
        const gap = (Math.max(...xs) - Math.min(...xs)) / (this.ingots.length - 1);
        this.x0 = Math.min(...xs);
        this.x1 = this.x0 + gap * this.ingots.length;
      }
      this.group.add(room);
    }).catch((e) => console.warn('refinery model failed to load', e));
  }

  update(time: number) {
    const flick = 0.85 + 0.1 * Math.sin(time * 11) + 0.06 * Math.sin(time * 23.7 + 1.3);
    this.light.intensity = 30 * flick;
    for (const [m, k] of this.molten) m.emissiveIntensity = k * flick;
    for (const [m, k] of this.laser) m.emissiveIntensity = k * (0.7 + 0.3 * Math.sin(time * 40));
    // the moulds ride the conveyor from the tap to the arm, cooling on the way
    const span = this.x1 - this.x0, speed = 0.18;
    this.ingots.forEach(({ o, mat }, i) => {
      const t = (((time * speed + (i * span) / this.ingots.length) % span) + span) % span;
      o.position.x = this.x0 + t;
      const k = Math.min(1, t / (span * 0.75));
      mat.emissive.copy(HOT).lerp(COLD, k);
      mat.color.copy(HOT_BASE).lerp(COLD_BASE, k);
    });
    if (this.chuck) this.chuck.rotation.y = time * 2.4;
    if (this.arm) this.arm.rotation.y = Math.sin(time * 0.6) * 0.7;
  }

  dispose() {
    this.disposed = true;
    for (const { mat } of this.ingots) mat.dispose();
  }
}
