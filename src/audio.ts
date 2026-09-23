/** Tiny synthesized sound kit; nothing is loaded from the network. */
export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private slideGain: GainNode | null = null;
  private slideFilter: BiquadFilterNode | null = null;
  private noise: AudioBuffer | null = null;
  muted = localStorage.getItem("shuffle.muted") === "1";

  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    this.master.connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = last * 0.97 + (Math.random() * 2 - 1) * 0.3;
      data[i] = last;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    this.slideFilter = ctx.createBiquadFilter();
    this.slideFilter.type = "bandpass";
    this.slideFilter.frequency.value = 500;
    this.slideFilter.Q.value = 0.8;
    this.slideGain = ctx.createGain();
    this.slideGain.gain.value = 0;
    src.connect(this.slideFilter).connect(this.slideGain).connect(this.master);
    src.start();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    localStorage.setItem("shuffle.muted", m ? "1" : "0");
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.02);
  }

  /** Continuous wood rumble scaled by total sliding speed. */
  slide(speed: number): void {
    if (!this.ctx || !this.slideGain || !this.slideFilter) return;
    const t = this.ctx.currentTime;
    this.slideGain.gain.setTargetAtTime(Math.min(0.5, speed * 0.09), t, 0.05);
    this.slideFilter.frequency.setTargetAtTime(280 + speed * 140, t, 0.08);
  }

  private env(node: AudioNode, gain: number, attack: number, decay: number): GainNode {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    node.connect(g).connect(this.master!);
    return g;
  }

  private tone(type: OscillatorType, freq: number, gain: number, decay: number, delay = 0, bend = 1): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    const t = ctx.currentTime + delay;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * bend, t + decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + decay + 0.05);
  }

  private burst(freq: number, gain: number, decay: number): void {
    if (!this.ctx || !this.noise) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = freq;
    f.Q.value = 2;
    src.connect(f);
    this.env(f, gain, 0.002, decay);
    src.start(this.ctx.currentTime, Math.random());
    src.stop(this.ctx.currentTime + decay + 0.05);
  }

  clack(impulse: number): void {
    const v = Math.min(1, impulse / 3);
    this.tone("triangle", 2100 + Math.random() * 300, 0.35 * v + 0.05, 0.07, 0, 0.7);
    this.tone("sine", 900, 0.25 * v, 0.05);
    this.burst(3500, 0.5 * v + 0.05, 0.04);
  }

  launch(power: number): void {
    this.burst(900, 0.15 + power * 0.25, 0.25);
  }

  drop(): void {
    this.tone("sine", 140, 0.5, 0.25, 0, 0.5);
    this.tone("square", 620, 0.06, 0.12, 0.02, 0.8);
    this.burst(1800, 0.25, 0.1);
  }

  score(points: number): void {
    const notes = [523, 659, 784, 1046, 1318, 1568];
    for (let i = 0; i < Math.min(points, 6) + 1; i++) this.tone("square", notes[i % notes.length], 0.07, 0.18, i * 0.09);
  }

  blank(): void {
    this.tone("sawtooth", 220, 0.08, 0.35, 0, 0.6);
  }

  win(): void {
    [523, 659, 784, 1046, 784, 1046, 1318].forEach((f, i) => this.tone("square", f, 0.08, 0.25, i * 0.12));
  }

  tick(): void {
    this.tone("sine", 1400, 0.05, 0.03);
  }
}
