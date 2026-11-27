// ui-sfx.ts — tiny Web Audio blips for DOM buttons (landing + play page).
// Same aesthetic as the in-game sfx: short square-wave arcade ticks.
// AudioContext is created lazily on first click (autoplay policies).

let ctx: AudioContext | null = null;

const getCtx = (): AudioContext | null => {
  if (ctx) return ctx;
  try {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  } catch {
    return null;
  }
  return ctx;
};

// One short arcade blip. `up` sweeps the pitch upward, `down` for "back" actions.
export function sfxBlip(up = true): void {
  const c = getCtx();
  if (!c) return;
  if (c.state === 'suspended') c.resume();
  const t = c.currentTime;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = 'square';
  o.frequency.setValueAtTime(up ? 620 : 400, t);
  o.frequency.exponentialRampToValueAtTime(up ? 940 : 240, t + 0.07);
  g.gain.setValueAtTime(0.06, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + 0.1);
}

// Wire every element matching `selector` (present now or later) with a blip.
export function attachBlips(selector: string, up = true): void {
  const fire = () => sfxBlip(up);
  const bind = () => {
    document.querySelectorAll(selector).forEach((el) => {
      if ((el as any).__blip) return;
      (el as any).__blip = true;
      el.addEventListener('click', fire);
    });
  };
  bind();
  new MutationObserver(bind).observe(document.body, { childList: true, subtree: true });
}
