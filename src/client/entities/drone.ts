import * as THREE from 'three';
import { MOOD } from '../../shared/fauna.ts';

const bodyMat = new THREE.MeshStandardMaterial({ color: '#3a3f46', roughness: 0.45, metalness: 0.7, flatShading: true });
const darkMat = new THREE.MeshStandardMaterial({ color: '#1c1e22', roughness: 0.6, metalness: 0.5, flatShading: true });
const stripeMat = new THREE.MeshStandardMaterial({ color: '#d08030', roughness: 0.6, metalness: 0.2, flatShading: true });

/**
 * A wreck's guard drone: an armoured sphere with a red eye, a gun under it and
 * two side thrusters. It bobs and leans as it moves, the eye flares when it
 * hunts and flashes when hit; a downed drone lies dark and smokes.
 */
export class DroneView {
  readonly group = new THREE.Group();
  private body = new THREE.Group();
  private eye: THREE.MeshBasicMaterial;
  private jets: THREE.MeshBasicMaterial;
  private flash = 0;
  private t = Math.random() * 10;
  private spin = 0;
  dead = false;

  constructor() {
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 1), bodyMat);
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.46, 0.06, 6, 18), darkMat);
    band.rotation.x = Math.PI / 2;
    const stripe = new THREE.Mesh(new THREE.TorusGeometry(0.43, 0.025, 4, 18), stripeMat);
    stripe.rotation.y = Math.PI / 2;
    this.eye = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 0.3, 0.25), toneMapped: false });
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), this.eye);
    eye.position.set(0, 0.04, 0.38);
    const hood = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 0.12, 10, 1, true), darkMat);
    hood.rotation.x = Math.PI / 2;
    hood.position.set(0, 0.04, 0.4);
    const gun = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.42, 6), darkMat);
    gun.rotation.x = Math.PI / 2;
    gun.position.set(0, -0.26, 0.28);
    this.jets = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 1.4, 2.6), toneMapped: false });
    for (const s of [-1, 1]) {
      const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 0.36, 8), darkMat);
      pod.position.set(s * 0.55, -0.05, 0);
      const glow = new THREE.Mesh(new THREE.CircleGeometry(0.09, 10), this.jets);
      glow.rotation.x = Math.PI / 2;
      glow.position.set(s * 0.55, -0.235, 0);
      this.body.add(pod, glow);
    }
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.3, 4), darkMat);
    antenna.position.set(0.15, 0.5, -0.1);
    this.body.add(core, band, stripe, eye, hood, gun, antenna);
    this.body.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = true; });
    this.group.add(this.body);
  }

  hit() {
    this.flash = 1;
  }

  /** `speed` (m/s) leans it into the motion, `mood` hunt flares the eye. */
  update(dt: number, s: { speed: number; mood: number; dead: boolean }) {
    this.t += dt;
    this.flash = Math.max(0, this.flash - dt * 5);
    this.dead = s.dead;
    if (s.dead) {
      // lying on its side, eye and jets out
      this.body.rotation.set(0.9, this.body.rotation.y, 0.5);
      this.body.position.y = -0.1;
      this.eye.color.setRGB(0.08, 0.02, 0.02);
      this.jets.color.setRGB(0, 0, 0);
      return;
    }
    const hunt = s.mood === MOOD.hunt;
    this.body.position.y = Math.sin(this.t * 2.3) * 0.06;
    this.body.rotation.x = Math.min(0.35, s.speed * 0.06);
    this.spin += dt * (hunt ? 0 : 0.4);
    this.body.rotation.z = Math.sin(this.t * 1.7) * 0.05;
    const e = (hunt ? 2.8 + Math.sin(this.t * 14) * 0.6 : 1.6) + this.flash * 3;
    this.eye.color.setRGB(e, 0.25 + this.flash * 2, 0.2 + this.flash * 2);
    const j = 1 + Math.sin(this.t * 31) * 0.25 + s.speed * 0.1;
    this.jets.color.setRGB(0.6 * j, 1.4 * j, 2.6 * j);
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
    this.eye.dispose();
    this.jets.dispose();
  }
}
