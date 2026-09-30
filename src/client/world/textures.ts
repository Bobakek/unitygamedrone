import * as THREE from 'three';

let glow: THREE.Texture | null = null;

/** Soft radial sprite used for engine glows, muzzle flashes, sparks and stars. */
export function glowTexture(): THREE.Texture {
  if (glow) return glow;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.2, 'rgba(255,255,255,0.55)');
  gr.addColorStop(0.5, 'rgba(255,255,255,0.12)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  glow = new THREE.CanvasTexture(c);
  glow.colorSpace = THREE.SRGBColorSpace;
  return glow;
}

let ring: THREE.Texture | null = null;

/** Soft ring used for explosion shockwaves. */
export function ringTexture(): THREE.Texture {
  if (ring) return ring;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(64, 64, 30, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,0)');
  gr.addColorStop(0.7, 'rgba(255,255,255,0.8)');
  gr.addColorStop(0.85, 'rgba(255,255,255,0.35)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  ring = new THREE.CanvasTexture(c);
  ring.colorSpace = THREE.SRGBColorSpace;
  return ring;
}

export const LOGDEPTH_VS_PARS = '#include <common>\n#include <logdepthbuf_pars_vertex>\n';
export const LOGDEPTH_VS = '#include <logdepthbuf_vertex>\n';
export const LOGDEPTH_FS_PARS = '#include <logdepthbuf_pars_fragment>\n';
export const LOGDEPTH_FS = '#include <logdepthbuf_fragment>\n';
