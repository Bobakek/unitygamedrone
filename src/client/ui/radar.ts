export interface Blip { x: number; y: number; z: number; kind: 'npc' | 'player' | 'missile' | 'station' | 'gate' | 'node' | 'poi' | 'loot'; sel?: boolean }

/** Top-down radar. Blip coordinates are camera-relative (x right, y up, z backwards), metres. */
export class Radar {
  private ctx: CanvasRenderingContext2D;
  constructor(private canvas: HTMLCanvasElement, private range = 6000) {
    this.ctx = canvas.getContext('2d')!;
  }

  draw(blips: Blip[]) {
    const c = this.ctx, W = this.canvas.width, R = W / 2 - 8;
    c.clearRect(0, 0, W, W);
    c.save();
    c.translate(W / 2, W / 2);
    c.strokeStyle = 'rgba(143,248,255,0.18)';
    c.lineWidth = 1;
    for (const f of [0.33, 0.66, 1]) { c.beginPath(); c.arc(0, 0, R * f, 0, Math.PI * 2); c.stroke(); }
    c.beginPath(); c.moveTo(-R, 0); c.lineTo(R, 0); c.moveTo(0, -R); c.lineTo(0, R); c.stroke();
    c.fillStyle = 'rgba(143,248,255,0.9)';
    c.beginPath(); c.moveTo(0, -6); c.lineTo(4, 4); c.lineTo(-4, 4); c.closePath(); c.fill();
    const colors: Record<Blip['kind'], string> = { npc: '#ff5a6a', player: '#8ff8ff', missile: '#ffd050', station: '#6dff9c', gate: '#c9a0ff', node: '#ffb060', poi: '#ffe066', loot: '#8ff8ff' };
    for (const b of blips) {
      const d = Math.hypot(b.x, b.z);
      const k = Math.min(1, Math.sqrt(d / this.range)) * R / (d || 1);
      const px = b.x * k, py = b.z * k;
      const edge = d > this.range;
      c.fillStyle = colors[b.kind];
      c.globalAlpha = edge ? 0.5 : 1;
      const sz = b.kind === 'station' || b.kind === 'gate' || b.kind === 'poi' ? 4 : b.kind === 'loot' ? 2 : 3;
      c.fillRect(px - sz / 2, py - sz / 2, sz, sz);
      if (!edge && Math.abs(b.y) > 30) {
        c.strokeStyle = colors[b.kind];
        c.beginPath();
        c.moveTo(px, py);
        c.lineTo(px, py - Math.sign(b.y) * Math.min(10, Math.abs(b.y) / 100 + 3));
        c.stroke();
      }
      if (b.sel) { c.strokeStyle = '#fff'; c.strokeRect(px - 5, py - 5, 10, 10); }
    }
    c.restore();
    c.globalAlpha = 1;
  }
}
