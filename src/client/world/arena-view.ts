import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import arenaUrl from '../assets/arena.glb?url';
import { ARENA, TEAM_COLORS, type ArenaLayout } from '../../shared/arena.ts';
import { FieldView } from './structures.ts';
import { LOGDEPTH_FS, LOGDEPTH_FS_PARS, LOGDEPTH_VS, LOGDEPTH_VS_PARS } from './textures.ts';

/**
 * The arena in space: the cover rocks, a launch gate behind each team's start line and buoys on
 * the edge of the field (tools/blender/build_arena.py → assets/arena.glb), plus the field's
 * boundary: a faint hex shell that lights up as a ship comes close to it. Lives in arena-local
 * space (the group is placed at the arena's centre).
 */
let template: Promise<THREE.Object3D> | null = null;
function loadArena(): Promise<THREE.Object3D> {
  template ??= new GLTFLoader().loadAsync(arenaUrl).then((g) => g.scene);
  return template;
}

const SHELL_VS = `varying vec3 vP; varying vec3 vN; varying vec3 vV;
${LOGDEPTH_VS_PARS}
void main(){ vP = position; vec4 mv = modelViewMatrix*vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv;
${LOGDEPTH_VS}
}`;
// hex cells on the sphere, brightest near the point the ship is closest to
const SHELL_FS = `uniform vec3 near; uniform float k; uniform float t; uniform vec3 c; varying vec3 vP; varying vec3 vN; varying vec3 vV;
${LOGDEPTH_FS_PARS}
float hex(vec2 p){ p = abs(mod(p, vec2(1.0, 1.732)) - vec2(0.5, 0.866)); return max(p.x * 0.866 + p.y * 0.5, p.x); }
void main(){
${LOGDEPTH_FS}
  vec3 n = normalize(vP);
  vec2 uv = vec2(atan(n.z, n.x) * 40.0, asin(n.y) * 40.0);
  float edge = smoothstep(0.42, 0.5, hex(uv)) + smoothstep(0.42, 0.5, hex(uv + vec2(0.5, 0.866)));
  float d = distance(vP, near);
  float spot = exp(-d * d / 160000.0) * k;
  float wave = 0.6 + 0.4 * sin(t * 2.0 - d * 0.02);
  gl_FragColor = vec4(c * (edge * (0.004 + spot * wave) + spot * 0.05), 1.0);
}`;

export class ArenaView {
  readonly group = new THREE.Group();
  private field: FieldView;
  private shell: THREE.Mesh;
  private shellU = { near: { value: new THREE.Vector3() }, k: { value: 0 }, t: { value: 0 }, c: { value: new THREE.Color('#ff9a40') } };
  private glows: THREE.MeshStandardMaterial[] = [];
  private buoyGlows: THREE.MeshStandardMaterial[] = [];
  private gone = false;

  constructor(readonly layout: ArenaLayout, readonly key: string) {
    const c = layout.center;
    this.field = new FieldView(layout.field);
    this.group.add(this.field.group);
    this.shell = new THREE.Mesh(
      new THREE.SphereGeometry(ARENA.radius, 96, 48),
      new THREE.ShaderMaterial({ uniforms: this.shellU, vertexShader: SHELL_VS, fragmentShader: SHELL_FS, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.shell.frustumCulled = false;
    this.group.add(this.shell);
    loadArena().then((scene) => {
      if (this.gone) return;
      const gate = scene.getObjectByName('SpawnGate'), buoy = scene.getObjectByName('Buoy');
      ([0, 1] as const).forEach((team) => {
        if (!gate) return;
        const g = this.tinted(gate, TEAM_COLORS[team], this.glows);
        const s = layout.spawns[team];
        const to = new THREE.Vector3(c.x - s.x, c.y - s.y, c.z - s.z).normalize();
        // the ships start just in front of the ring, noses through it
        g.position.set(s.x - c.x - to.x * 40, s.y - c.y + 9, s.z - c.z - to.z * 40);
        g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), to);
        g.scale.setScalar(2.7);
        this.group.add(g);
      });
      if (buoy) {
        // a belt round the equator and two thinner ones above and below
        for (const [lat, n] of [[0, 28], [0.6, 16], [-0.6, 16]] as const) {
          for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2 + lat;
            const r = ARENA.radius * Math.cos(lat);
            const b = this.tinted(buoy, '#ff9a20', this.buoyGlows);
            b.position.set(Math.cos(a) * r, Math.sin(lat) * ARENA.radius, Math.sin(a) * r);
            b.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.position.clone().normalize());
            b.scale.setScalar(2.2);
            this.group.add(b);
          }
        }
      }
    });
  }

  /** A clone with its own TeamGlow / TeamPaint / BuoyGlow materials in `color`. */
  private tinted(src: THREE.Object3D, color: string, glows: THREE.MeshStandardMaterial[]): THREE.Object3D {
    const o = src.clone(true);
    o.position.set(0, 0, 0);
    const own = new Map<THREE.Material, THREE.Material>();
    o.traverse((m) => {
      if (!(m instanceof THREE.Mesh)) return;
      const swap = (mat: THREE.Material) => {
        if (mat.name !== 'TeamGlow' && mat.name !== 'TeamPaint' && mat.name !== 'BuoyGlow') return mat;
        let cpy = own.get(mat) as THREE.MeshStandardMaterial | undefined;
        if (!cpy) {
          cpy = (mat as THREE.MeshStandardMaterial).clone();
          if (mat.name === 'TeamPaint') cpy.color.set(color);
          else { cpy.color.set(color); cpy.emissive.set(color); glows.push(cpy); }
          own.set(mat, cpy);
        }
        return cpy;
      };
      m.material = Array.isArray(m.material) ? m.material.map(swap) : swap(m.material);
    });
    return o;
  }

  /** `focus`: the local ship in arena-local coordinates (the shell lights up where it is near). */
  update(time: number, focus: THREE.Vector3) {
    const d = focus.length();
    const n = d > 1 ? focus.clone().multiplyScalar(ARENA.radius / d) : new THREE.Vector3(0, ARENA.radius, 0);
    this.shellU.near.value.copy(n);
    this.shellU.k.value = THREE.MathUtils.smoothstep(d, ARENA.radius - 700, ARENA.radius - 50) * 1.6 + (d > ARENA.radius ? 0.8 : 0);
    this.shellU.t.value = time;
    const pulse = 4 + Math.sin(time * 3) * 2.5;
    for (const m of this.glows) m.emissiveIntensity = pulse;
    const blink = Math.sin(time * 4) > 0.2 ? 7 : 1.5;
    for (const m of this.buoyGlows) m.emissiveIntensity = blink;
  }

  dispose() {
    this.gone = true;
    this.group.removeFromParent();
    this.shell.geometry.dispose();
    (this.shell.material as THREE.Material).dispose();
    this.glows.forEach((m) => m.dispose());
    this.buoyGlows.forEach((m) => m.dispose());
  }
}
