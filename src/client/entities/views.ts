import * as THREE from 'three';
import type { Blueprint } from '../../shared/ships/blueprint.ts';
import { buildShip, type BuiltShip } from './ship-builder.ts';
import { glowTexture } from '../world/textures.ts';

const hullMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.55, metalness: 0.12 });
const metalMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.32, metalness: 0.85 });
const glassMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.06, metalness: 0.3, emissive: '#10202a' });
const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });

const FRESNEL_VS = `varying vec3 vN; varying vec3 vV;
#include <common>
#include <logdepthbuf_pars_vertex>
void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv;
#include <logdepthbuf_vertex>
}`;
const SHIELD_FS = `uniform vec3 c; uniform float k; varying vec3 vN; varying vec3 vV;
#include <logdepthbuf_pars_fragment>
void main(){
#include <logdepthbuf_fragment>
float d = abs(dot(vN, vV)); gl_FragColor = vec4(c * pow(1.0 - d, 2.5) * k, 1.0); }`;

export class ShipView {
  readonly group = new THREE.Group();
  private flames: THREE.Mesh[] = [];
  private flameMats: THREE.MeshBasicMaterial[] = [];
  private sprites: THREE.Sprite[] = [];
  private shield: THREE.Mesh;
  private shieldU: { c: { value: THREE.Color }; k: { value: number } };
  private shieldFlash = 0;
  readonly built: BuiltShip;
  throttle = 0;
  boost = false;
  cruise = false;
  landed = false;

  constructor(public bp: Blueprint) {
    this.built = buildShip(bp);
    for (const [g, m] of [[this.built.hull, hullMat], [this.built.metal, metalMat], [this.built.glass, glassMat]] as const) {
      const mesh = new THREE.Mesh(g, m);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
    this.group.add(new THREE.Mesh(this.built.glow, glowMat));
    const gc = new THREE.Color(bp.glow);
    for (const e of this.built.engines) {
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
    this.shieldU = { c: { value: new THREE.Color('#59c7ff') }, k: { value: 0 } };
    this.shield = new THREE.Mesh(
      new THREE.IcosahedronGeometry(this.built.radius * 1.05, 3),
      new THREE.ShaderMaterial({ uniforms: this.shieldU, vertexShader: FRESNEL_VS, fragmentShader: SHIELD_FS, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }),
    );
    this.shield.visible = false;
    this.group.add(this.shield);
  }

  hit(shield: boolean) {
    if (shield) this.shieldFlash = 1;
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
      this.sprites[i].scale.setScalar(this.built.engines[i].r * (on ? 2 + t * 2.5 : 1.3));
    }
    if (this.shieldFlash > 0) {
      this.shieldFlash = Math.max(0, this.shieldFlash - dt * 3);
      this.shieldU.k.value = this.shieldFlash * 1.2;
      this.shield.visible = true;
    } else this.shield.visible = false;
  }

  dispose() {
    this.group.removeFromParent();
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
