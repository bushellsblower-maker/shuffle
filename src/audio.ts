/**
 * Synthesized sound kit; nothing is loaded from the network.
 *
 * The slide rumble keeps its own path (brown-ish noise → bandpass → master).
 * Every other effect goes through an SFX bus with a gentle compressor and a
 * short synthesized room reverb, so hits read as objects in a bar, not beeps.
 */
export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private slideGain: GainNode | null = null;
  private slideFilter: BiquadFilterNode | null = null;
  private noise: AudioBuffer | null = null;
  private white: AudioBuffer | null = null;
  private sfx: GainNode | null = null;
  private room: GainNode | null = null;
  private lastClack = -1;
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

    this.white = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const w = this.white.getChannelData(0);
    for (let i = 0; i < w.length; i++) w[i] = Math.random() * 2 - 1;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -9;
    comp.knee.value = 8;
    comp.ratio.value = 3;
    comp.attack.value = 0.002;
    comp.release.value = 0.18;
    comp.connect(this.master);
    this.sfx = ctx.createGain();
    this.sfx.gain.value = 0.9;
    this.sfx.connect(comp);

    const verb = ctx.createConvolver();
    verb.buffer = this.impulse(1.4, 3.2);
    const verbTone = ctx.createBiquadFilter();
    verbTone.type = "lowpass";
    verbTone.frequency.value = 4200;
    this.room = ctx.createGain();
    this.room.gain.value = 0.32;
    this.room.connect(verb).connect(verbTone).connect(comp);
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

  /* ---------- building blocks ---------- */

  /** Stereo decaying-noise impulse response for a small, slightly bright room. */
  private impulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < n; i++) {
        const k = i / n;
        ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - k, decay) * (i < ctx.sampleRate * 0.012 ? 0.3 : 1);
      }
    }
    return buf;
  }

  /** Output stage for one voice: dry to the SFX bus, plus `wet` into the room. */
  private out(gain: number, wet = 0): GainNode {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.value = gain;
    g.connect(this.sfx!);
    if (wet > 0) {
      const send = ctx.createGain();
      send.gain.value = wet;
      g.connect(send).connect(this.room!);
    }
    return g;
  }

  /** Percussive envelope: near-instant attack, exponential decay. */
  private perc(param: AudioParam, t: number, peak: number, decay: number, attack = 0.002): void {
    param.setValueAtTime(0.0001, t);
    param.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    param.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private osc(type: OscillatorType, freq: number, t: number, dur: number, dest: AudioNode, peak: number, decay: number, bendTo?: number, attack?: number): OscillatorNode {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (bendTo) o.frequency.exponentialRampToValueAtTime(bendTo, t + dur);
    const g = ctx.createGain();
    this.perc(g.gain, t, peak, decay, attack);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + (attack ?? 0.002) + decay + 0.05);
    return o;
  }

  private noiseHit(t: number, dest: AudioNode, peak: number, decay: number, type: BiquadFilterType, freq: number, q = 0.7, freqTo?: number, attack?: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (freqTo) f.frequency.exponentialRampToValueAtTime(freqTo, t + decay);
    f.Q.value = q;
    const g = ctx.createGain();
    this.perc(g.gain, t, peak, decay, attack);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 0.5);
    src.stop(t + (attack ?? 0.002) + decay + 0.05);
  }

  /** Struck metal: a few inharmonic partials that die faster the higher they are. */
  private ring(f0: number, t: number, dest: AudioNode, peak: number, decay: number): void {
    const partials = [
      [1, 1, 1],
      [2.76, 0.5, 0.55],
      [5.4, 0.28, 0.32],
      [8.93, 0.14, 0.2],
    ];
    for (const [ratio, amp, life] of partials) this.osc("sine", f0 * ratio, t, decay * life, dest, peak * amp, decay * life);
  }

  private ready(): boolean {
    return !!(this.ctx && this.sfx && this.room && this.white);
  }

  /* ---------- effects ---------- */

  /** Chrome weights colliding: a sharp tick, a short metallic ring, and some body. */
  clack(impulse: number): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const v = Math.min(1, impulse / 2.6);
    if (t - this.lastClack < 0.03 && v < 0.5) return;
    this.lastClack = t;
    const out = this.out(0.35 + v * 1.1, 0.22 + v * 0.18);
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 2600 + v * 9000;
    tone.connect(out);
    this.noiseHit(t, tone, 0.9, 0.012, "highpass", 2400, 0.8);
    this.ring(1650 + Math.random() * 380, t, tone, 0.22 + v * 0.18, 0.1 + v * 0.14);
    this.osc("triangle", 360 + Math.random() * 40, t, 0.05, tone, 0.35 * v + 0.05, 0.05, 220);
  }

  /** Hand pushing a heavy weight off: a low thump with a burst of wax scrape. */
  launch(power: number): void {
    if (!this.ready()) return;
    const t = this.ctx!.currentTime;
    const out = this.out(0.7 + power * 0.6, 0.08);
    this.osc("sine", 120 + power * 30, t, 0.14, out, 0.9, 0.16, 48);
    this.osc("triangle", 240, t, 0.05, out, 0.18, 0.045, 150);
    this.noiseHit(t, out, 0.45 + power * 0.3, 0.07, "lowpass", 1600, 0.6, 400);
    this.noiseHit(t + 0.01, out, 0.1 + power * 0.18, 0.22 + power * 0.18, "bandpass", 900 + power * 700, 0.9, 500, 0.03);
  }

  /** A weight dropping into the gutter or pit: heavy thud, then a little metal rattle as it settles. */
  drop(): void {
    if (!this.ready()) return;
    const t = this.ctx!.currentTime;
    const out = this.out(1.4, 0.2);
    this.osc("sine", 105, t, 0.22, out, 1, 0.26, 42);
    this.noiseHit(t, out, 0.55, 0.09, "lowpass", 900, 0.8, 250);
    this.noiseHit(t, out, 0.2, 0.03, "bandpass", 2600, 1.2);
    [0.07, 0.13, 0.17].forEach((dt, i) => this.ring(980 + i * 140 + Math.random() * 60, t + dt, out, 0.07 / (i + 1), 0.08));
  }

  /** Round won: a quick bright chord stinger, bigger for bigger rounds. */
  score(points: number): void {
    if (!this.ready()) return;
    const t = this.ctx!.currentTime;
    const out = this.out(0.35, 0.55);
    const chord = [392, 493.9, 587.3, 784, 987.8, 1174.7];
    const n = Math.min(chord.length, 3 + Math.floor(points / 2));
    for (let i = 0; i < n; i++) this.bell(chord[i], t + i * 0.045, out, 0.22, 0.9 + i * 0.08);
    this.pluck(98, t, out, 0.35, 0.5);
    this.noiseHit(t, out, 0.12, 0.35, "highpass", 6000, 0.7, 9000, 0.01);
  }

  /** Blank round: a soft, falling two-note "dud" on a muted mallet. */
  blank(): void {
    if (!this.ready()) return;
    const t = this.ctx!.currentTime;
    const out = this.out(0.4, 0.35);
    this.pluck(220, t, out, 0.35, 0.35);
    this.pluck(164.8, t + 0.16, out, 0.35, 0.55);
    this.osc("sine", 82.4, t + 0.16, 0.5, out, 0.4, 0.5, 70);
  }

  /** Match won: a short brass fanfare over a held chord and a cymbal swell. */
  win(): void {
    if (!this.ready()) return;
    const t = this.ctx!.currentTime;
    const out = this.out(0.3, 0.5);
    const hits: [number[], number, number][] = [
      [[392, 523.3, 659.3], 0, 0.14],
      [[392, 523.3, 659.3], 0.16, 0.14],
      [[392, 523.3, 659.3], 0.32, 0.14],
      [[440, 587.3, 698.5], 0.5, 0.28],
      [[523.3, 659.3, 784, 1046.5], 0.82, 1.3],
    ];
    for (const [notes, at, len] of hits) for (const f of notes) this.brass(f, t + at, len, out, 0.14);
    this.pluck(65.4, t + 0.82, out, 0.6, 1.2);
    this.noiseHit(t + 0.62, out, 0.16, 1.4, "highpass", 5000, 0.5, 7000, 0.2);
  }

  /** UI press: a small mechanical click. */
  tick(): void {
    if (!this.ready()) return;
    const t = this.ctx!.currentTime;
    const out = this.out(0.8, 0.05);
    this.noiseHit(t, out, 0.5, 0.012, "bandpass", 3800, 1.5);
    this.osc("sine", 1900, t, 0.02, out, 0.12, 0.018, 1500);
  }

  /** Online: your turn, or your opponent just arrived. */
  chime(): void {
    if (!this.ready()) return;
    const t = this.ctx!.currentTime;
    const out = this.out(0.4, 0.5);
    this.bell(659.3, t, out, 0.2, 0.7);
    this.bell(987.8, t + 0.11, out, 0.18, 0.9);
  }

  /* ---------- instruments ---------- */

  /** Soft bell: fundamental plus a detuned octave and a quiet inharmonic shimmer. */
  private bell(f: number, t: number, dest: AudioNode, peak: number, decay: number): void {
    this.osc("sine", f, t, decay, dest, peak, decay, undefined, 0.004);
    this.osc("sine", f * 2.001, t, decay * 0.6, dest, peak * 0.35, decay * 0.6, undefined, 0.004);
    this.osc("sine", f * 3.01, t, decay * 0.3, dest, peak * 0.12, decay * 0.3, undefined, 0.004);
  }

  /** Muted string / mallet: a triangle through a closing low-pass. */
  private pluck(f: number, t: number, dest: AudioNode, peak: number, decay: number): void {
    const ctx = this.ctx!;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 2;
    lp.frequency.setValueAtTime(f * 8, t);
    lp.frequency.exponentialRampToValueAtTime(f * 1.5, t + decay);
    lp.connect(dest);
    this.osc("triangle", f, t, decay, lp, peak, decay, undefined, 0.003);
  }

  /** Brass-ish voice: detuned saws through a filter that swells open then settles. */
  private brass(f: number, t: number, len: number, dest: AudioNode, peak: number): void {
    const ctx = this.ctx!;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 1.2;
    lp.frequency.setValueAtTime(f * 1.2, t);
    lp.frequency.linearRampToValueAtTime(f * 6, t + 0.05);
    lp.frequency.exponentialRampToValueAtTime(f * 2.5, t + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.03);
    g.gain.setValueAtTime(peak * 0.8, t + len * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.18);
    lp.connect(g).connect(dest);
    for (const detune of [-7, 6]) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = f;
      o.detune.value = detune;
      o.connect(lp);
      o.start(t);
      o.stop(t + len + 0.25);
    }
  }
}
