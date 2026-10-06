/** Tiny procedural sound kit (WebAudio) — no audio assets. */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private volume = 0.6;
  private engine: { osc: OscillatorNode; osc2: OscillatorNode; gain: GainNode; filter: BiquadFilterNode } | null = null;
  /** Muffles everything under water; `hum` is the deep underwater ambience. */
  private muffle: BiquadFilterNode | null = null;
  private hum: GainNode | null = null;
  private wet = false;
  /** Weather loops: rain hiss and wind howl. */
  private rain: GainNode | null = null;
  private wind: { gain: GainNode; filter: BiquadFilterNode } | null = null;

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
    this.muffle = c.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;
    this.master.connect(this.muffle);
    this.muffle.connect(c.destination);
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
    // underwater ambience: slowly swelling low noise
    const hs = c.createBufferSource(), hf = c.createBiquadFilter(), hg = c.createGain(), lfo = c.createOscillator(), lg = c.createGain();
    hs.buffer = this.noise; hs.loop = true;
    hf.type = 'lowpass'; hf.frequency.value = 180;
    hg.gain.value = 0;
    lfo.frequency.value = 0.13; lg.gain.value = 60;
    lfo.connect(lg); lg.connect(hf.frequency);
    hs.connect(hf); hf.connect(hg); hg.connect(this.master);
    hs.start(); lfo.start();
    this.hum = hg;
    // rain: bright noise; wind: low noise with a slowly wandering band (gusts)
    const rs = c.createBufferSource(), rf = c.createBiquadFilter(), rg = c.createGain();
    rs.buffer = this.noise; rs.loop = true;
    rf.type = 'highpass'; rf.frequency.value = 1800;
    rg.gain.value = 0;
    rs.connect(rf); rf.connect(rg); rg.connect(this.master);
    rs.start();
    this.rain = rg;
    const ws = c.createBufferSource(), wf = c.createBiquadFilter(), wg = c.createGain(), wl = c.createOscillator(), wlg = c.createGain();
    ws.buffer = this.noise; ws.loop = true; ws.playbackRate.value = 0.5;
    wf.type = 'bandpass'; wf.frequency.value = 380; wf.Q.value = 1.8;
    wl.frequency.value = 0.21; wlg.gain.value = 160;
    wl.connect(wlg); wlg.connect(wf.frequency);
    wg.gain.value = 0;
    ws.connect(wf); wf.connect(wg); wg.connect(this.master);
    ws.start(); wl.start();
    this.wind = { gain: wg, filter: wf };
  }

  /** Weather ambience: rain (0..1) and wind (0..1) loudness. */
  weather(rain: number, wind: number) {
    if (!this.ctx || !this.rain || !this.wind) return;
    const t = this.ctx.currentTime;
    this.rain.gain.setTargetAtTime(0.08 * rain, t, 0.5);
    this.wind.gain.gain.setTargetAtTime(0.16 * wind, t, 0.6);
  }

  /** Thunder `delay` seconds from now (sound travels), louder when near. */
  thunder(delay: number, vol: number) {
    setTimeout(() => {
      this.burst(2.6, 220, 0.4 * vol, 'lowpass', 50);
      this.burst(0.25, 1400, 0.12 * vol * vol, 'bandpass', 300);
    }, Math.max(0, delay) * 1000);
  }

  /** One Geiger-counter click. */
  click() { this.burst(0.012, 4200, 0.07, 'highpass'); }

  /** Under water: muffled world and a low ambience. */
  underwater(on: boolean) {
    if (on === this.wet || !this.ctx || !this.muffle || !this.hum) return;
    this.wet = on;
    const t = this.ctx.currentTime;
    this.muffle.frequency.setTargetAtTime(on ? 650 : 20000, t, 0.08);
    this.hum.gain.setTargetAtTime(on ? 0.35 : 0, t, 0.2);
  }

  /** Entering or leaving the water. */
  splash(k = 1) { this.burst(0.35, 900, 0.14 * k, 'bandpass', 300); this.burst(0.2, 3200, 0.05 * k, 'highpass'); }
  bubbles() { this.burst(0.12, 700 + Math.random() * 500, 0.03, 'bandpass', 1800); }

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

  /** Electric drive whine of the rover: pitch follows the speed, loudness the throttle. */
  roverMotor(speed: number, throttle: number) {
    if (!this.engine || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.engine.gain.gain.setTargetAtTime(0.015 + throttle * 0.04 + Math.min(0.03, speed * 0.0015), t, 0.1);
    this.engine.filter.frequency.setTargetAtTime(500 + speed * 90, t, 0.2);
    this.engine.osc.frequency.setTargetAtTime(55 + speed * 7, t, 0.2);
  }

  silenceEngine() {
    if (this.engine && this.ctx) this.engine.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
  }
}
