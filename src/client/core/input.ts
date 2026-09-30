/** Keyboard + mouse state with pointer lock and a virtual flight "stick" cursor. */
export class Input {
  keys = new Set<string>();
  pressed = new Set<string>();
  buttons = 0;
  clicked = new Set<number>();
  released = new Set<number>();
  /** Virtual cursor offset from screen centre, each axis in [-1, 1]. */
  vx = 0;
  vy = 0;
  /** Accumulated raw mouse movement since last consume (pixels). */
  dx = 0;
  dy = 0;
  wheel = 0;
  locked = false;
  typing = false;
  /** Mouse sensitivity multiplier from settings. */
  sensitivity = 1;
  /** When false the virtual cursor follows the absolute mouse position. */
  private mouseX = 0;
  private mouseY = 0;

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (this.typing) return;
      if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.buttons = 0; });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked && e.button === 0) this.requestLock();
      this.buttons |= 1 << e.button;
      this.clicked.add(e.button);
    });
    window.addEventListener('mouseup', (e) => {
      this.buttons &= ~(1 << e.button);
      this.released.add(e.button);
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); }, { passive: true });
    window.addEventListener('mousemove', (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
      if (this.locked) {
        this.dx += e.movementX;
        this.dy += e.movementY;
        const k = this.sensitivity / (0.28 * Math.min(window.innerWidth, window.innerHeight));
        this.vx += e.movementX * k;
        this.vy += e.movementY * k;
        const l = Math.hypot(this.vx, this.vy);
        if (l > 1) { this.vx /= l; this.vy /= l; }
      } else {
        const k = 1 / (0.28 * Math.min(window.innerWidth, window.innerHeight));
        this.vx = Math.max(-1, Math.min(1, (this.mouseX - window.innerWidth / 2) * k));
        this.vy = Math.max(-1, Math.min(1, (this.mouseY - window.innerHeight / 2) * k));
      }
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
    });
  }

  requestLock() {
    try {
      const r = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch { /* not available (e.g. headless) */ }
  }

  releaseLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  down(code: string) { return this.keys.has(code); }
  hit(code: string) { return this.pressed.has(code); }
  mouse(b: number) { return (this.buttons & (1 << b)) !== 0; }

  centerCursor() { this.vx = 0; this.vy = 0; }

  consumeMouse() {
    const r = { dx: this.dx, dy: this.dy };
    this.dx = 0;
    this.dy = 0;
    return r;
  }

  /** Call once per rendered frame after all consumers ran. */
  endFrame() {
    this.pressed.clear();
    this.clicked.clear();
    this.released.clear();
    this.wheel = 0;
  }
}
