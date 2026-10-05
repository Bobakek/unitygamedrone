import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { SystemDef } from '../../shared/galaxy/system-gen.ts';
import type { V3 } from '../../shared/math/vec.ts';
import { DECK_Y, PAD, ROOMS, TERMINALS, type TerminalKind } from '../../shared/station/deck.ts';
import { add, newParts, type Parts } from '../entities/ship-builder.ts';
import { glowTexture } from './textures.ts';

const solidMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.7, metalness: 0.15 });
const metalMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.4, metalness: 0.6 });
const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
const glassMat = new THREE.MeshStandardMaterial({ color: '#9ad8ff', roughness: 0.05, metalness: 0.9, transparent: true, opacity: 0.1, depthWrite: false });

const SCREEN: Record<TerminalKind, string> = { trade: '#6affb0', upgrades: '#6ac8ff', contracts: '#ffb43a', wardrobe: '#e07aff' };
const FIELD_VS = `varying vec2 vUv;
#include <common>
#include <logdepthbuf_pars_vertex>
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
#include <logdepthbuf_vertex>
}`;
const FIELD_FS = `uniform float t; varying vec2 vUv;
#include <logdepthbuf_pars_fragment>
void main(){
#include <logdepthbuf_fragment>
  float edge = smoothstep(0.0, 0.06, vUv.x) * smoothstep(1.0, 0.94, vUv.x) * smoothstep(0.0, 0.08, vUv.y) * smoothstep(1.0, 0.92, vUv.y);
  float band = 0.5 + 0.5 * sin(vUv.y * 60.0 - t * 2.0);
  float k = (0.05 + 0.06 * band) * edge + (1.0 - edge) * 0.25;
  gl_FragColor = vec4(vec3(0.35, 0.75, 1.0) * k, 1.0); }`;

/** A sprite with text drawn on a canvas (signs and terminal names). */
function textSprite(text: string, color: string, h = 0.6): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 96;
  const g = c.getContext('2d')!;
  g.font = 'bold 54px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = color;
  g.shadowBlur = 16;
  g.fillStyle = color;
  g.fillText(text, 256, 50);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
  sp.scale.set((h * 512) / 96, h, 1);
  return sp;
}

/**
 * The walkable inside of a station, built in deck coordinates (see
 * station/deck.ts) and placed inside the station's hull: the hangar with the
 * pilot's ship on its pad and the bay's force field, the airlock with sliding
 * doors and the promenade with big windows on real space, four terminals, a
 * hologram of the star system, planters and benches.
 */
export class StationInterior {
  readonly group = new THREE.Group();
  /** Station orientation (local −Z faces the docking bay's side). */
  readonly q = new THREE.Quaternion();
  private doors: { mesh: THREE.Mesh; open: number; z: number; side: number }[] = [];
  private holo = new THREE.Group();
  private field: THREE.ShaderMaterial;

  constructor(sys: SystemDef, facing: THREE.Vector3) {
    this.q.setFromUnitVectors(new THREE.Vector3(0, 0, -1), facing.clone().normalize());
    const p = newParts();
    this.hangar(p);
    this.corridor(p);
    this.promenade(p);
    for (const [list, mat] of [[[...p.hull, ...p.glass], solidMat], [p.metal, metalMat], [p.glow, glowMat]] as const) {
      if (!list.length) continue;
      const m = new THREE.Mesh(mergeGeometries(list as THREE.BufferGeometry[])!, mat);
      m.receiveShadow = mat !== glowMat;
      this.group.add(m);
    }
    // windows: the side walls of the promenade and its end wall towards the planet
    const glass = [
      new THREE.BoxGeometry(0.08, 6.3, 70).translate(-26, 4.35, -5),
      new THREE.BoxGeometry(0.08, 6.3, 70).translate(26, 4.35, -5),
      new THREE.BoxGeometry(52, 8, 0.08).translate(0, 4.5, 30),
    ];
    this.group.add(new THREE.Mesh(mergeGeometries(glass)!, glassMat));
    // the docking bay's force field
    this.field = new THREE.ShaderMaterial({ uniforms: { t: { value: 0 } }, vertexShader: FIELD_VS, fragmentShader: FIELD_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    const field = new THREE.Mesh(new THREE.PlaneGeometry(56, 16), this.field);
    field.position.set(0, 8, -108);
    this.group.add(field);
    // sliding doors at both ends of the airlock
    const doorMat = new THREE.MeshStandardMaterial({ color: '#5a6270', roughness: 0.5, metalness: 0.5, flatShading: true });
    for (const z of [-80, -40]) {
      for (const side of [-1, 1]) {
        const d = new THREE.Mesh(new THREE.BoxGeometry(4, 4.2, 0.3), doorMat);
        d.position.set(side * 2, 2.1, z);
        this.group.add(d);
        this.doors.push({ mesh: d, open: 0, z, side });
      }
    }
    // terminal names and signs
    for (const t of TERMINALS) {
      const s = textSprite(t.name, SCREEN[t.kind], 0.5);
      s.position.set(t.x, 2.8, t.z);
      this.group.add(s);
    }
    for (const [text, x, y, z] of [['ПРОМЕНАД', 0, 5.6, -39.5], ['АНГАР', 0, 6, -80.5], [sys.station.name, 0, 8.2, 29.3]] as [string, number, number, number][]) {
      const s = textSprite(text, '#8ff8ff', 1.1);
      s.position.set(x, y, z);
      this.group.add(s);
    }
    // the system as a hologram over its pedestal
    this.holo.position.set(0, 3.2, -12);
    const star = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color(sys.star.color).multiplyScalar(2), blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    star.scale.setScalar(0.9);
    this.holo.add(star);
    const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 0.7, 1.1), transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const maxR = Math.max(...sys.planets.map((pl) => Math.hypot(pl.center.x - sys.star.pos.x, pl.center.z - sys.star.pos.z)));
    sys.planets.forEach((pl, i) => {
      const r = 0.5 + (Math.hypot(pl.center.x - sys.star.pos.x, pl.center.z - sys.star.pos.z) / maxR) * 1.7;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.008, 4, 48), ringMat);
      ring.rotation.x = Math.PI / 2;
      this.holo.add(ring);
      const orbit = new THREE.Group();
      orbit.rotation.y = i * 1.9;
      orbit.userData.speed = 0.25 / r;
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.06 + pl.radius / 70000, 10, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(pl.atmo?.color ?? '#a8a098').multiplyScalar(1.6), toneMapped: false }));
      ball.position.x = r;
      orbit.add(ball);
      this.holo.add(orbit);
    });
    this.group.add(this.holo);
  }

  private hangar(p: Parts) {
    const floor = '#3a3f48', wall = '#6a7280', dark = '#2a2e34', trim = '#ffb040';
    add(p, new THREE.BoxGeometry(60, 0.4, 28), floor, false, [0, -0.2, -94]);
    // the pad: a dark disc ringed with lamps and hazard stripes
    add(p, new THREE.CylinderGeometry(7, 7, 0.08, 32), dark, 'metal', [PAD.x, 0.04, PAD.z]);
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      add(p, new THREE.BoxGeometry(1.3, 0.05, 0.35), k % 2 ? trim : '#1a1a1a', false, [PAD.x + Math.cos(a) * 7.6, 0.03, PAD.z + Math.sin(a) * 7.6], [0, -a, 0]);
    }
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + 0.2;
      add(p, new THREE.BoxGeometry(0.5, 0.06, 0.5), '#ffd27a', true, [PAD.x + Math.cos(a) * 6.4, 0.08, PAD.z + Math.sin(a) * 6.4], undefined, undefined, 2.2);
    }
    // a walkway line from the ramp to the airlock
    for (let z = -88; z < -80; z += 1.2) add(p, new THREE.BoxGeometry(0.3, 0.03, 0.7), trim, false, [6, 0.02, z]);
    add(p, new THREE.BoxGeometry(10, 0.03, 0.3), trim, false, [1, 0.02, -88]);
    // walls with ribs and light strips, the ceiling with trusses
    for (const s of [-1, 1]) {
      add(p, new THREE.BoxGeometry(0.6, 18, 28), wall, false, [s * 30.3, 9, -94]);
      for (let z = -106; z <= -82; z += 6) add(p, new THREE.BoxGeometry(0.8, 18, 0.7), dark, 'metal', [s * 29.8, 9, z]);
      add(p, new THREE.BoxGeometry(0.15, 0.4, 26), '#8ff8ff', true, [s * 29.5, 4, -94], undefined, undefined, 1.6);
    }
    add(p, new THREE.BoxGeometry(26, 18, 0.6), wall, false, [-17, 9, -79.7]);
    add(p, new THREE.BoxGeometry(26, 18, 0.6), wall, false, [17, 9, -79.7]);
    add(p, new THREE.BoxGeometry(8, 13.6, 0.6), wall, false, [0, 11.2, -79.7]);
    add(p, new THREE.BoxGeometry(61, 0.6, 29), dark, 'metal', [0, 18.3, -94]);
    for (let z = -106; z <= -82; z += 7) add(p, new THREE.BoxGeometry(60, 1.2, 0.8), dark, 'metal', [0, 17.2, z]);
    for (const x of [-18, 0, 18]) add(p, new THREE.BoxGeometry(6, 0.15, 1.4), '#fff4e0', true, [x, 17.4, -94], undefined, undefined, 2);
    // the bay opening: a heavy frame around the force field
    add(p, new THREE.BoxGeometry(60, 2, 1.4), dark, 'metal', [0, 17, -108]);
    add(p, new THREE.BoxGeometry(60, 0.6, 1.4), trim, false, [0, 0.3, -108]);
    for (const s of [-1, 1]) add(p, new THREE.BoxGeometry(2, 18, 1.4), dark, 'metal', [s * 29, 9, -108]);
    for (const s of [-1, 1]) add(p, new THREE.BoxGeometry(0.3, 16, 0.3), '#6ac8ff', true, [s * 27.8, 8, -107.6], undefined, undefined, 2);
    // crates, fuel tanks and a gantry crane over the pad
    for (const [x, z, n] of [[-24, -84, 3], [-26, -100, 2], [24, -103, 3], [22, -84, 2]]) {
      for (let k = 0; k < n; k++) add(p, new THREE.BoxGeometry(2.4, 2.4, 2.4), ['#8a6a3a', '#5a6a4a', '#4a5a7a'][k % 3], false, [x + (k % 2) * 2.6, 1.2 + Math.floor(k / 2) * 2.4, z]);
    }
    for (const z of [-104, -100]) add(p, new THREE.CylinderGeometry(1.1, 1.1, 5, 12), '#c8ccd2', 'metal', [26.5, 2.5, z]);
    for (const s of [-1, 1]) add(p, new THREE.BoxGeometry(0.8, 14, 0.8), dark, 'metal', [s * 12, 7, -96]);
    add(p, new THREE.BoxGeometry(25, 1, 1.2), trim, 'metal', [0, 14, -96]);
  }

  private corridor(p: Parts) {
    const wall = '#7a828e', dark = '#2a2e34';
    add(p, new THREE.BoxGeometry(8, 0.3, 40), '#4a5260', false, [0, -0.15, -60]);
    for (const s of [-1, 1]) {
      add(p, new THREE.BoxGeometry(0.5, 4.5, 40), wall, false, [s * 4.25, 2.25, -60]);
      for (let z = -78; z <= -42; z += 4) add(p, new THREE.BoxGeometry(0.6, 4.5, 0.4), dark, 'metal', [s * 4, 2.25, z]);
      add(p, new THREE.BoxGeometry(0.12, 0.25, 38), '#ffb040', true, [s * 3.9, 0.6, -60], undefined, undefined, 1.4);
    }
    add(p, new THREE.BoxGeometry(9, 0.4, 40), dark, 'metal', [0, 4.7, -60]);
    for (let z = -76; z <= -44; z += 5) add(p, new THREE.BoxGeometry(2.4, 0.1, 0.8), '#e8f4ff', true, [0, 4.45, z], undefined, undefined, 1.8);
  }

  private promenade(p: Parts) {
    const floor = '#8a929c', border = '#5a626e', wall = '#c8ccd2', dark = '#3a4048';
    add(p, new THREE.BoxGeometry(52, 0.3, 70), floor, false, [0, -0.15, -5]);
    add(p, new THREE.BoxGeometry(6, 0.02, 64), '#4a7a9a', false, [0, 0.01, -8]);
    for (const s of [-1, 1]) {
      add(p, new THREE.BoxGeometry(1.2, 0.04, 70), border, false, [s * 25, 0.02, -5]);
      // sill and upper wall around the long windows, mullions every 5 m
      add(p, new THREE.BoxGeometry(0.6, 1.2, 70), wall, false, [s * 26.3, 0.6, -5]);
      add(p, new THREE.BoxGeometry(0.6, 1.5, 70), wall, false, [s * 26.3, 8.25, -5]);
      for (let z = -40; z <= 30; z += 5) add(p, new THREE.BoxGeometry(0.7, 9, 0.4), dark, 'metal', [s * 26.2, 4.5, z]);
    }
    // the end window towards the planet: a frame and mullions
    add(p, new THREE.BoxGeometry(53, 0.5, 0.6), dark, 'metal', [0, 0.25, 30.3]);
    add(p, new THREE.BoxGeometry(53, 1, 0.6), dark, 'metal', [0, 8.6, 30.3]);
    for (let x = -26; x <= 26; x += 6.5) add(p, new THREE.BoxGeometry(0.4, 9, 0.6), dark, 'metal', [x, 4.5, 30.3]);
    // back wall with the airlock door, ceiling with light panels
    add(p, new THREE.BoxGeometry(22, 9, 0.6), wall, false, [-15, 4.5, -40.3]);
    add(p, new THREE.BoxGeometry(22, 9, 0.6), wall, false, [15, 4.5, -40.3]);
    add(p, new THREE.BoxGeometry(8, 4.8, 0.6), wall, false, [0, 6.6, -40.3]);
    add(p, new THREE.BoxGeometry(53, 0.4, 71), '#b8bcc4', false, [0, 9.2, -5]);
    for (let x = -18; x <= 18; x += 12) for (let z = -32; z <= 22; z += 9) add(p, new THREE.BoxGeometry(5, 0.1, 1.2), '#fff8ec', true, [x, 8.95, z], undefined, undefined, 1.6);
    // terminals: pedestal, slanted screen, a glowing base
    for (const t of TERMINALS) {
      const face = t.x < 0 ? 1 : -1;
      add(p, new THREE.BoxGeometry(1.1, 1.1, 1.4), dark, 'metal', [t.x, 0.55, t.z]);
      add(p, new THREE.BoxGeometry(0.1, 0.9, 1.3), SCREEN[t.kind], true, [t.x + face * 0.45, 1.5, t.z], [0, 0, face * 0.45], undefined, 1.8);
      add(p, new THREE.CylinderGeometry(1.2, 1.2, 0.04, 20), SCREEN[t.kind], true, [t.x, 0.03, t.z], undefined, undefined, 0.8);
    }
    // the holo-map pedestal
    add(p, new THREE.CylinderGeometry(2.6, 2.9, 0.9, 24), dark, 'metal', [0, 0.45, -12]);
    add(p, new THREE.TorusGeometry(2.6, 0.08, 6, 32).rotateX(Math.PI / 2), '#6ac8ff', true, [0, 0.92, -12], undefined, undefined, 2);
    // planters with plants and benches facing the windows
    const planter = (x: number, z: number) => {
      add(p, new THREE.BoxGeometry(2, 0.9, 2), '#6a5a48', false, [x, 0.45, z]);
      add(p, new THREE.ConeGeometry(0.9, 2.6, 6), '#3a7a4a', false, [x, 2.2, z]);
      add(p, new THREE.SphereGeometry(0.7, 6, 5), '#4a8a5a', false, [x + 0.4, 1.6, z - 0.3]);
    };
    for (const x of [-16, 0, 16]) planter(x, 24);
    for (const x of [-22, 22]) for (const z of [-30, 12]) planter(x, z);
    for (const x of [-8, 8]) {
      add(p, new THREE.BoxGeometry(4.5, 0.15, 1.1), '#7a5a3a', false, [x, 0.5, 20]);
      for (const s of [-1, 1]) add(p, new THREE.BoxGeometry(0.2, 0.5, 1), dark, 'metal', [x + s * 2, 0.25, 20]);
    }
  }

  /** Deck point → world (station at `stationPos`). */
  toWorld(stationPos: V3, p: V3, out: V3): V3 {
    const v = new THREE.Vector3(p.x, p.y + DECK_Y, p.z).applyQuaternion(this.q);
    out.x = stationPos.x + v.x; out.y = stationPos.y + v.y; out.z = stationPos.z + v.z;
    return out;
  }

  /** World point → deck. */
  toDeck(stationPos: V3, w: V3): THREE.Vector3 {
    return new THREE.Vector3(w.x - stationPos.x, w.y - stationPos.y, w.z - stationPos.z).applyQuaternion(this.q.clone().invert()).add(new THREE.Vector3(0, -DECK_Y, 0));
  }

  /** Deck direction → world. */
  dirToWorld(d: V3): THREE.Vector3 {
    return new THREE.Vector3(d.x, d.y, d.z).applyQuaternion(this.q);
  }

  /** Ceiling of the room above a deck point (null: not on the deck). */
  ceil(x: number, z: number): number | null {
    return ROOMS.find((r) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1)?.ceil ?? null;
  }

  /** Doors slide open for the pilot (`me`, deck coordinates), the hologram turns, the field shimmers. */
  update(dt: number, time: number, me: { x: number; z: number } | null) {
    for (const d of this.doors) {
      const near = me ? Math.abs(me.z - d.z) < 6 && Math.abs(me.x) < 6 : false;
      d.open += ((near ? 1 : 0) - d.open) * Math.min(1, dt * 5);
      d.mesh.position.x = d.side * (2 + d.open * 3.6);
    }
    this.holo.rotation.y += dt * 0.08;
    for (const o of this.holo.children) if (o.userData.speed) o.rotation.y += dt * o.userData.speed;
    this.field.uniforms.t.value = time;
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
      if (o instanceof THREE.Sprite) { o.material.map?.dispose(); o.material.dispose(); }
    });
    this.field.dispose();
  }
}
