import * as THREE from 'three';
import type { Blueprint } from '../../shared/ships/blueprint.ts';
import { buildShip } from './ship-builder.ts';
import { isGlbShip, loadGlbShip } from './glb-ship.ts';
import { HULLS, isHull } from '../../shared/ships/hulls.ts';
import { glowTexture } from '../world/textures.ts';

const hullMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.55, metalness: 0.12 });
const metalMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.32, metalness: 0.85 });
const glassMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.06, metalness: 0.3, emissive: '#10202a' });
const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });

const FRESNEL_VS = `varying vec3 vN; varying vec3 vV; varying vec3 vO;
#include <common>
#include <logdepthbuf_pars_vertex>
void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); vN = normalize(normalMatrix*normal); vO = normalize(position); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv;
#include <logdepthbuf_vertex>
}`;
// fresnel shell plus a bright ripple round the point the bolt struck (`hit`, model space)
const SHIELD_FS = `uniform vec3 c; uniform float k; uniform vec3 hit; uniform float hk; uniform float t; varying vec3 vN; varying vec3 vV; varying vec3 vO;
#include <logdepthbuf_pars_fragment>
void main(){
#include <logdepthbuf_fragment>
float d = abs(dot(vN, vV));
float a = 1.0 - dot(vO, hit);
float ring = exp(-pow((a - (1.0 - hk) * 0.5) * 9.0, 2.0)) * hk;
float spot = exp(-a * 14.0) * hk * 1.6;
gl_FragColor = vec4(c * (pow(1.0 - d, 2.5) * k + ring + spot), 1.0); }`;

export class ShipView {
  readonly group = new THREE.Group();
  private flames: THREE.Mesh[] = [];
  private flameMats: THREE.MeshBasicMaterial[] = [];
  private sprites: THREE.Sprite[] = [];
  private shield: THREE.Mesh;
  private shieldU: { c: { value: THREE.Color }; k: { value: number }; hit: { value: THREE.Vector3 }; hk: { value: number }; t: { value: number } };
  /** Recoil of the last shots (0..1): the hull kicks back and the nose lifts a little. */
  private kick = 0;
  private shieldFlash = 0;
  private ownMats: THREE.Material[] = [];
  private gone = false;
  /** Engine exits (flames) in model space and the bounding radius. */
  engines: { pos: THREE.Vector3; r: number }[] = [];
  radius: number;
  throttle = 0;
  boost = false;
  cruise = false;
  landed = false;

  constructor(public bp: Blueprint) {
    this.shieldU = { c: { value: new THREE.Color('#59c7ff') }, k: { value: 0 }, hit: { value: new THREE.Vector3(0, 0, -1) }, hk: { value: 0 }, t: { value: 0 } };
    if (isGlbShip(bp.cls)) {
      // modelled in Blender: loads in the background, flames and shield come with it
      this.radius = (isHull(bp.cls) ? HULLS[bp.cls].radius : 8) * 1.25;
      this.shield = this.makeShield();
      loadGlbShip(bp).then((m) => {
        if (this.gone) { m.materials.forEach((x) => x.dispose()); return; }
        this.ownMats = m.materials;
        this.group.add(m.object);
        this.radius = m.radius;
        this.shield.geometry.dispose();
        this.shield.geometry = new THREE.IcosahedronGeometry(this.radius * 1.05, 3);
        this.addEngines(m.engines);
      });
      return;
    }
    const built = buildShip(bp);
    for (const [g, m] of [[built.hull, hullMat], [built.metal, metalMat], [built.glass, glassMat]] as const) {
      const mesh = new THREE.Mesh(g, m);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
    this.group.add(new THREE.Mesh(built.glow, glowMat));
    this.radius = built.radius;
    this.shield = this.makeShield();
    this.addEngines(built.engines);
  }

  private makeShield() {
    const shield = new THREE.Mesh(
      new THREE.IcosahedronGeometry(this.radius * 1.05, 3),
      new THREE.ShaderMaterial({ uniforms: this.shieldU, vertexShader: FRESNEL_VS, fragmentShader: SHIELD_FS, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }),
    );
    shield.visible = false;
    this.group.add(shield);
    return shield;
  }

  private addEngines(engines: { pos: THREE.Vector3; r: number }[]) {
    this.engines = engines;
    const gc = new THREE.Color(this.bp.glow);
    for (const e of engines) {
      const m = new THREE.MeshBasicMaterial({ color: gc.clone().multiplyScalar(1.6), transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      const cone = new THREE.Mesh(new THREE.ConeGeometry(e.r * 0.9, 1, 8, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5), m);
      cone.position.copy(e.pos);
      this.flames.push(cone);
      this.flameMats.push(m);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: gc.clone().multiplyScalar(0.55), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
      sp.position.copy(e.pos);
      sp.scale.setScalar(e.r * 4);
      this.sprites.push(sp);
      this.group.add(cone, sp);
    }
  }

  /** `at`: the hit point in this ship's model space (the shield ripples from there). */
  hit(shield: boolean, at?: THREE.Vector3) {
    if (!shield) return;
    this.shieldFlash = 1;
    if (at && at.lengthSq() > 1e-6) this.shieldU.hit.value.copy(at).normalize();
  }

  /** A shot leaves the guns. */
  recoil(k = 1) {
    this.kick = Math.min(1, this.kick + 0.55 * k);
  }

  update(dt: number, time: number) {
    const t = this.landed ? 0 : this.cruise ? 1 : Math.max(0, this.throttle);
    const on = !this.landed && (this.cruise || t > 0.03);
    const len = this.cruise ? 16 : 1 + t * 4 * (this.boost ? 1.8 : 1);
    const flicker = 0.9 + Math.sin(time * 40 + this.bp.seed) * 0.1;
    for (let i = 0; i < this.flames.length; i++) {
      this.flames[i].scale.set(1, 1, len * flicker);
      this.flames[i].visible = on;
      this.flameMats[i].opacity = 0.15 + 0.3 * t;
      this.sprites[i].scale.setScalar(this.engines[i].r * (on ? 2 + t * 2.5 : 1.3));
    }
    if (this.shieldFlash > 0) {
      this.shieldFlash = Math.max(0, this.shieldFlash - dt * 3);
      this.shieldU.k.value = this.shieldFlash * 0.7;
      this.shieldU.hk.value = this.shieldFlash;
      this.shield.visible = true;
    } else this.shield.visible = false;
    if (this.kick > 0.002) {
      // the group was just placed for this frame: push it back along its own axis
      this.group.translateZ(this.kick * Math.min(0.9, this.radius * 0.07));
      this.group.rotateX(this.kick * 0.018);
      this.kick *= Math.exp(-dt * 13);
    }
  }

  dispose() {
    this.gone = true;
    this.group.removeFromParent();
    this.ownMats.forEach((m) => m.dispose());
    this.flameMats.forEach((m) => m.dispose());
    this.flames.forEach((f) => f.geometry.dispose());
    this.shield.geometry.dispose();
  }
}

const missileMat = new THREE.MeshStandardMaterial({ color: '#d8d8d8', flatShading: true, roughness: 0.5 });
const missileGeo = new THREE.ConeGeometry(0.35, 2.4, 5).rotateX(-Math.PI / 2);

export class MissileView {
  readonly group = new THREE.Group();
  constructor() {
    this.group.add(new THREE.Mesh(missileGeo, missileMat));
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color('#ffb060').multiplyScalar(2), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
    s.position.z = 1.4;
    s.scale.setScalar(3);
    this.group.add(s);
  }
  dispose() {
    this.group.removeFromParent();
  }
}
