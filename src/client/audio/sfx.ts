/** Tiny procedural sound kit (WebAudio) — no audio assets. */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private volume = 0.6;
  private engine: { osc: OscillatorNode; osc2: OscillatorNode; gain: GainNode; filter: BiquadFilterNode } | null = null;

  constructor() {
    const start = () => this.init();
    window.addEventListener('pointerdown', start, { once: true });
    window.addEventListener('keydown', start, { once: true });
  }

  private init() {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
    } catch {
      return;
    }
    const c = this.ctx;
    this.master = c.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(c.destination);
    this.noise = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const osc = c.createOscillator(), osc2 = c.createOscillator(), gain = c.createGain(), filter = c.createBiquadFilter();
    osc.type = 'sawtooth'; osc.frequency.value = 48;
    osc2.type = 'triangle'; osc2.frequency.value = 73;
    filter.type = 'lowpass'; filter.frequency.value = 300;
    gain.gain.value = 0;
    osc.connect(filter); osc2.connect(filter); filter.connect(gain); gain.connect(this.master);
    osc.start(); osc2.start();
    this.engine = { osc, osc2, gain, filter };
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  private env(g: GainNode, t: number, a: number, peak: number, r: number) {
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + r);
  }

  laser(vol = 1) {
    const c = this.ctx; if (!c || !this.master) return;
    const t = c.currentTime, o = c.createOscillator(), g = c.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(1400, t);
    o.frequency.exponentialRampToValueAtTime(240, t + 0.12);
    this.env(g, t, 0.005, 0.06 * vol, 0.12);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.15);
  }

  /** Hand blaster: a short, lower "pew" with a crackle. */
  blaster(vol = 1) {
    const c = this.ctx; if (!c || !this.master) return;
    const t = c.currentTime, o = c.createOscillator(), g = c.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(900, t);
    o.frequency.exponentialRampToValueAtTime(160, t + 0.1);
    this.env(g, t, 0.003, 0.07 * vol, 0.1);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.13);
    this.burst(0.05, 2600, 0.05 * vol, 'highpass');
  }

  private burst(dur: number, freq: number, vol: number, type: BiquadFilterType = 'lowpass', sweep = 0) {
    const c = this.ctx; if (!c || !this.master || !this.noise) return;
    const t = c.currentTime, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = this.noise;
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, t + dur);
    this.env(g, t, 0.01, vol, dur);
    s.connect(f); f.connect(g); g.connect(this.master);
    s.start(t); s.stop(t + dur + 0.05);
  }

  hit(shield: boolean) { this.burst(0.09, shield ? 3000 : 1200, 0.12, shield ? 'highpass' : 'bandpass'); }
  explosion(big: boolean, vol = 1) {
    this.burst(big ? 1.4 : 0.6, 1600, (big ? 0.5 : 0.25) * vol, 'lowpass', 90);
    const c = this.ctx; if (!c || !this.master) return;
    const t = c.currentTime, o = c.createOscillator(), g = c.createGain();
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(30, t + 0.8);
    this.env(g, t, 0.01, 0.35 * vol, 0.8);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.9);
  }
  step(vol = 1) { this.burst(0.06, 500 + Math.random() * 300, 0.05 * vol, 'lowpass'); }
  thud(k = 1) { this.burst(0.18, 260, 0.14 * k, 'lowpass'); }
  mining() { this.burst(0.8, 2400, 0.06, 'bandpass', 900); }
  missile() { this.burst(0.7, 400, 0.18, 'bandpass', 2400); }
  beep(high = false) {
    const c = this.ctx; if (!c || !this.master) return;
    const t = c.currentTime, o = c.createOscillator(), g = c.createGain();
    o.frequency.value = high ? 1320 : 880;
    this.env(g, t, 0.005, 0.05, 0.08);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.1);
  }
  pickup() { this.beep(true); setTimeout(() => this.beep(false), 90); }

  engineLevel(throttle: number, boost: boolean, cruise: boolean) {
    if (!this.engine || !this.ctx) return;
    const t = this.ctx.currentTime;
    const lvl = cruise ? 1 : Math.abs(throttle);
    this.engine.gain.gain.setTargetAtTime(0.03 + lvl * 0.07 + (boost ? 0.04 : 0), t, 0.1);
    this.engine.filter.frequency.setTargetAtTime(200 + lvl * 900 + (cruise ? 1200 : 0), t, 0.2);
    this.engine.osc.frequency.setTargetAtTime(42 + lvl * 30 + (cruise ? 40 : 0), t, 0.2);
  }

  silenceEngine() {
    if (this.engine && this.ctx) this.engine.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
  }
}
