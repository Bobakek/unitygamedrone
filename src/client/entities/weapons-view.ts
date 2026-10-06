import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import weaponsUrl from '../assets/weapons.glb?url';
import { MOUNTS, type ModuleKey } from '../../shared/modules.ts';
import type { Blueprint } from '../../shared/ships/blueprint.ts';
import { glowTexture } from '../world/textures.ts';

/**
 * Weapon modules and mines modelled in Blender (tools/blender/build_weapons.py → assets/weapons.glb):
 * root nodes Railgun, MinePod, EmpEmitter and Mine. The modules sit on the ship's mounts
 * (MOUNTS in modules.ts); Paint takes the pilot's colour, MineGlow blinks on mines.
 */
const NODE: Record<ModuleKey, string> = { railgun: 'Railgun', mines: 'MinePod', emp: 'EmpEmitter' };

let templates: Promise<Map<string, THREE.Object3D>> | null = null;
function load(): Promise<Map<string, THREE.Object3D>> {
  templates ??= new GLTFLoader().loadAsync(weaponsUrl).then((g) => {
    const out = new Map<string, THREE.Object3D>();
    for (const o of g.scene.children) {
      o.traverse((m) => { if (m instanceof THREE.Mesh) { m.castShadow = true; m.receiveShadow = true; } });
      o.position.set(0, 0, 0);
      out.set(o.name, o);
    }
    return out;
  });
  return templates;
}

/** The modules fitted to one ship: built on its mounts, re-built when the fit changes. */
export class ModuleRig {
  readonly group = new THREE.Group();
  private mats: THREE.Material[] = [];
  private glows: THREE.MeshStandardMaterial[] = [];
  private key = '';
  private gone = false;
  /** Seconds since a slot fired (the glow flares and dies down). */
  private flare = 0;

  constructor(private bp: Blueprint) {}

  set(mods: readonly ModuleKey[] | undefined) {
    const key = (mods ?? []).join();
    if (key === this.key) return;
    this.key = key;
    const mounts = MOUNTS[this.bp.cls] ?? [];
    load().then((t) => {
      if (this.gone || this.key !== key) return;
      this.clear();
      (mods ?? []).forEach((m, slot) => {
        const at = mounts[slot];
        const src = t.get(NODE[m]);
        if (!at || !src) return;
        const o = src.clone(true);
        this.tint(o);
        o.position.set(at.p.x, at.p.y, at.p.z);
        o.scale.setScalar(at.scale);
        // hung under the hull: upside down about the forward axis
        if (at.down) o.rotation.z = Math.PI;
        this.group.add(o);
      });
    });
  }

  private tint(o: THREE.Object3D) {
    const own = new Map<THREE.Material, THREE.Material>();
    o.traverse((m) => {
      if (!(m instanceof THREE.Mesh)) return;
      const swap = (mat: THREE.Material) => {
        if (mat.name !== 'Paint' && mat.name !== 'RailGlow' && mat.name !== 'EmpGlow') return mat;
        let c = own.get(mat);
        if (!c) {
          const sm = mat.clone() as THREE.MeshStandardMaterial;
          if (mat.name === 'Paint') sm.color.set(this.bp.hull2);
          else this.glows.push(sm);
          own.set(mat, sm);
          this.mats.push(sm);
          c = sm;
        }
        return c;
      };
      m.material = Array.isArray(m.material) ? m.material.map(swap) : swap(m.material);
    });
  }

  /** A module fired: its glow flares. */
  fired() {
    this.flare = 0;
  }

  update(dt: number, time: number) {
    this.flare += dt;
    const k = 0.75 + 0.25 * Math.sin(time * 3) + Math.max(0, 3 - this.flare * 6);
    for (const g of this.glows) g.emissiveIntensity = k;
  }

  private clear() {
    for (const c of [...this.group.children]) c.removeFromParent();
    this.mats.forEach((m) => m.dispose());
    this.mats = [];
    this.glows = [];
  }

  dispose() {
    this.gone = true;
    this.clear();
    this.group.removeFromParent();
  }
}

const OWN = new THREE.Color('#3cff7a'), FOE = new THREE.Color('#ff2a1a');

/** A proximity mine: slowly tumbling, its lamps blinking once armed (green: ours, red: someone else's). */
export class MineView {
  readonly group = new THREE.Group();
  private lamp: THREE.MeshStandardMaterial | null = null;
  private halo: THREE.Sprite;
  private spin = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
  private t = Math.random() * 10;
  private gone = false;
  armed = false;

  constructor(private own: boolean) {
    const c = own ? OWN : FOE;
    this.halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: c.clone().multiplyScalar(1.5), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
    this.halo.scale.setScalar(5);
    this.group.add(this.halo);
    load().then((t) => {
      const src = t.get('Mine');
      if (!src || this.gone) return;
      const o = src.clone(true);
      // a mine is a little bigger than the model's metre: easier to spot and to dodge
      o.scale.setScalar(1.6);
      o.traverse((m) => {
        if (!(m instanceof THREE.Mesh)) return;
        const swap = (mat: THREE.Material) => {
          if (mat.name !== 'MineGlow') return mat;
          if (!this.lamp) {
            const lamp = mat.clone() as THREE.MeshStandardMaterial;
            lamp.emissive.copy(c);
            lamp.color.copy(c);
            this.lamp = lamp;
          }
          return this.lamp;
        };
        m.material = Array.isArray(m.material) ? m.material.map(swap) : swap(m.material);
      });
      this.group.add(o);
    });
  }

  update(dt: number) {
    this.t += dt;
    this.group.children.at(-1)?.rotateOnAxis(this.spin, dt * 0.4);
    // unarmed: a steady dim glow; armed: a sharp blink, faster for enemy mines
    const blink = this.armed ? (Math.sin(this.t * (this.own ? 4 : 9)) > 0.2 ? 1 : 0.08) : 0.35;
    if (this.lamp) this.lamp.emissiveIntensity = 8 * blink;
    this.halo.material.opacity = blink;
    this.halo.scale.setScalar(this.armed ? 6 + blink * 4 : 4);
  }

  dispose() {
    this.gone = true;
    this.group.removeFromParent();
    this.lamp?.dispose();
    this.halo.material.dispose();
  }
}
