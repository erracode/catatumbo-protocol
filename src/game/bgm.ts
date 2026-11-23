// Standalone Web Audio sequencer for "Coquivacoa Steel" (the game's BGM),
// usable outside the Phaser scene (landing page). Same musical DNA as the
// in-game createAudio(): gaita-techno at 185 BPM on a 12-step triplet grid,
// A minor (i - iv - V - i). Deliberately no scene/game dependencies.
//
// Autoplay policy: the AudioContext is created and started lazily on the
// first user gesture, from the toggle button's click handler.

const STEP = 60 / 185 / 3; // triplet eighth (~108 ms)
const ROOTS = [110, 146.83, 164.81, 110]; // i - iv - V - i in A minor
const THIRD = (bar: number) => (bar % 4 === 2 ? 1.26 : 1.19);

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let mel: GainNode | null = null;
let nb: Float32Array | null = null;
let timer: number | null = null;
let mStep = 0;
let mBar = 0;
let mNext = 0;
let mInt = 0;
let playing = false;

function voice(
  f: number,
  dur: number,
  type: OscillatorType,
  vol: number,
  when: number,
  f2 = 0,
  cut = 0,
  dest: AudioNode | null = null,
) {
  if (!ctx) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(vol, when + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  o.type = type;
  o.frequency.setValueAtTime(f, when);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, when + dur);
  let n: AudioNode = g;
  if (cut) {
    const q = ctx.createBiquadFilter();
    q.Q.value = 14;
    q.frequency.setValueAtTime(cut, when);
    q.frequency.exponentialRampToValueAtTime(160, when + dur);
    g.connect(q);
    n = q;
  }
  o.connect(n);
  o.start(when);
  o.stop(when + dur + 0.02);
  if (dest) n.connect(dest);
  else if (master) n.connect(master);
}

function perc(dur: number, vol: number, when: number) {
  if (!ctx || !master) return;
  if (!nb) {
    // Noise buffer must be a real AudioBuffer, not a raw Float32Array.
    nb = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const ch = nb.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
  }
  const src = ctx.createBufferSource();
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, when);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  src.buffer = nb;
  src.connect(g);
  g.connect(master);
  src.start(when, Math.random() * 0.5, dur + 0.02);
}

function schedStep(i: number, when: number) {
  if (!ctx || !master || !mel) return;
  const root = ROOTS[mBar & 3];
  const bar = mInt ? mBar : -1;
  const beat = i % 3 === 0;
  const six = i % 6;
  const third = THIRD(mBar);
  const chorus = bar === 3 || bar === 4 || bar === 7;
  const brk = bar === 5;
  const kick = bar > 0 && !brk;
  // Furruco drone on each 6/8 pulse.
  if (!six) voice(root / 2, STEP * 5.5, 'triangle', 0.22, when, root * 0.53);
  // Tambora 6/8 (X . X X . X) + charrasca scrape.
  if (six % 3 !== 1) voice(six % 3 ? 180 : 95, 0.09, 'sine', 0.2, when, 60);
  perc(0.03, beat ? 0.06 : 0.025, when);
  // Cuatro rasgueo: open strum on the beat, muted on the offbeat.
  if (i % 3 !== 1)
    [1, third, 1.5].forEach((r, k) =>
      voice(root * 2 * r, beat ? 0.2 : 0.05, 'triangle', 0.035, when + k * 0.012, 0, 0, mel),
    );
  // Driving arpeggio.
  voice(
    root * 4 * [1, third, 1.5][i % 3] * (six > 2 ? 2 : 1),
    STEP * 1.1,
    mInt ? 'sawtooth' : 'triangle',
    0.04,
    when,
    0,
    0,
    mel,
  );
  if (!mInt) return;
  // Drums + bass + raves stabs only at combat intensity.
  if (kick && beat) voice(170, 0.18, 'sine', 0.7, when, 40), perc(0.015, 0.2, when);
  if (kick && (i === 3 || i === 9 || (bar === 6 && i > 7))) perc(0.14, 0.2, when);
  if (brk) perc(0.04, 0.1, when), perc(0.04, 0.07, when + STEP / 2);
  voice(
    beat ? root / 2 : root,
    STEP * 0.9,
    'sawtooth',
    0.1,
    when,
    0,
    chorus || brk ? 3500 : 1500,
  );
  if (chorus && (i === 3 || i === 9)) voice(root * 4, STEP, 'sawtooth', 0.05, when, 0, 3500);
}

function pump() {
  if (!ctx || !playing) return;
  const now = ctx.currentTime;
  if (mNext < now) mNext = now + 0.1;
  while (mNext < now + 0.15) {
    schedStep(mStep, mNext);
    if (++mStep === 12) {
      mStep = 0;
      mBar = (mBar + 1) % 8;
    }
    mNext += STEP;
  }
}

export function bgmSetIntensity(intensity: 0 | 1) {
  if (intensity !== mInt) mBar = 0;
  mInt = intensity;
}

/** Start the loop. Resolves a lazily created AudioContext (call from a click). */
export async function bgmStart(): Promise<boolean> {
  if (!ctx) {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.6;
    master.connect(ctx.destination);
    // Phaser/flanger sheen bus for the melodic voices (same as the game).
    mel = ctx.createGain();
    const dl = ctx.createDelay();
    const lfo = ctx.createOscillator();
    const dep = ctx.createGain();
    dep.gain.value = 0.003;
    lfo.frequency.value = 0.6;
    lfo.connect(dep);
    dep.connect(dl.delayTime);
    mel.connect(master);
    mel.connect(dl);
    dl.connect(master);
    lfo.start();
  }
  if (ctx.state === 'suspended') await ctx.resume();
  if (playing) return true;
  playing = true;
  mNext = ctx.currentTime + 0.1;
  timer = window.setInterval(pump, 40);
  return true;
}

export function bgmStop() {
  playing = false;
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

export function bgmIsPlaying() {
  return playing;
}
