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
const BEAT_FADE = 1.3; // ~12 triplet steps: combat bus eases in/out, no hard drop

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let mel: GainNode | null = null;
let beatBus: GainNode | null = null;
let nb: Float32Array | null = null;
let timer: number | null = null;
let mStep = 0;
let mBar = 0;
let mNext = 0;
let mInt = 0;
let playing = false;
// Auto-cycle: title vamp -> combat -> back to vamp, advanced on completed bars.
let cycleOn = false;
let cycleBars = 0;
const CYCLE_VAMP = 12; // ~15.5s of menu vamp at 185 BPM before the drop
const CYCLE_COMBAT = 12; // ~15.5s combat phrase before falling back to the vamp

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
  if (!ctx || !beatBus) return;
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
  g.connect(beatBus);
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
      if (cycleOn && ++cycleBars >= (mInt ? CYCLE_COMBAT : CYCLE_VAMP)) {
        cycleBars = 0;
        bgmSetIntensity(mInt ? 0 : 1);
      }
    }
    mNext += STEP;
  }
}

export function bgmSetIntensity(intensity: 0 | 1) {
  if (intensity !== mInt) {
    mBar = 0;
    // Ease the combat bus toward its new level over BEAT_FADE seconds so the
    // vamp/drop boundary never slams. Anchor the ramp to the next scheduled
    // step (the lookahead is ~150 ms ahead, hence the small floor).
    if (beatBus && ctx) {
      const t = Math.max(mNext, ctx.currentTime) + 0.05;
      beatBus.gain.cancelScheduledValues(t);
      beatBus.gain.setValueAtTime(beatBus.gain.value, t);
      beatBus.gain.linearRampToValueAtTime(intensity ? 1 : 0.0001, t + BEAT_FADE);
    }
  }
  mInt = intensity;
}

/** Toggle the automatic title-vamp <-> combat cycle. Always restarts on vamp. */
export function bgmSetCycle(on: boolean) {
  cycleOn = on;
  cycleBars = 0;
  if (on) bgmSetIntensity(0);
}

/** Start the loop. Resolves a lazily created AudioContext (call from a click). */
export async function bgmStart(): Promise<boolean> {
  if (!ctx) {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    // Landing mix: the vamp sits UNDER reading volume (~-8 dB vs the game's
    // 0.6 bus). Background music must never compete with the copy.
    master.gain.value = 0.24;
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
    // Combat bus: drums + bass + stabs ride here so the drop eases in and out
    // instead of slamming. Ramps are scheduled ahead by the lookahead loop.
    beatBus = ctx.createGain();
    beatBus.gain.setValueAtTime(0.0001, ctx.currentTime);
    beatBus.connect(master);
  }
  if (ctx.state === 'suspended') await ctx.resume();
  if (playing) return true;
  playing = true;
  if (cycleOn) {
    cycleBars = 0;
    bgmSetIntensity(0);
  }
  if (beatBus && ctx) {
    // A restart after a combat phrase must not inherit the open bus.
    beatBus.gain.cancelScheduledValues(ctx.currentTime);
    beatBus.gain.setValueAtTime(0.0001, ctx.currentTime);
  }
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
