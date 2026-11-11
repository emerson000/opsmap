// Console cues, synthesized with Web Audio from short tone patterns (no audio files). The new-track and
// hostile-track patterns follow the radar console cues of the Console Sound Library; the splash is the
// new-track beep falling instead of rising. Quiet by design, and at most one cue per moment.
import type { Cue } from '../../core/model/cues';

const SOUND_KEY = 'opsmap.ui.sound';
const read = () => { try { return globalThis.localStorage?.getItem(SOUND_KEY); } catch { return null; } };
export const sound = $state({ on: read() !== 'off' });
export function setSound(on: boolean): void {
  sound.on = on;
  try { globalThis.localStorage?.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch { /* storage may be disabled */ }
  if (on) play('track');
}

/** [frequency Hz (0 = silence), seconds] steps. */
type Step = [number, number];
const PATTERNS: Record<Cue, { steps: Step[]; gain: number }> = {
  track: { steps: [[1400, 0.06], [0, 0.04], [1900, 0.08]], gain: 0.12 },
  hostile: { steps: Array.from({ length: 5 }, (): Step[] => [[2400, 0.1], [0, 0.05]]).flat(), gain: 0.09 },
  splash: { steps: [[1900, 0.06], [0, 0.04], [1400, 0.12]], gain: 0.12 },
};
const MIN_GAP_MS = 1200;

let ctx: AudioContext | null = null;
let last = -Infinity;

/** Browsers start audio only after a user gesture: the first press or key creates the audio context. */
function unlock(): void {
  if (ctx || typeof window === 'undefined') return;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return;
  try { ctx = new Ctor(); } catch { ctx = null; }
}
if (typeof window !== 'undefined') {
  for (const type of ['pointerdown', 'keydown'] as const) window.addEventListener(type, unlock, { once: false, passive: true, capture: true });
}

export function play(cue: Cue): void {
  if (!sound.on || !ctx) return;
  const now = performance.now();
  if (now - last < MIN_GAP_MS) return;
  last = now;
  if (ctx.state === 'suspended') void ctx.resume();
  const { steps, gain } = PATTERNS[cue];
  let t = ctx.currentTime + 0.01;
  for (const [freq, seconds] of steps) {
    if (freq > 0) {
      const osc = ctx.createOscillator(), amp = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = freq;
      // 3 ms fades, as in the library, so tones start and stop without clicks.
      amp.gain.setValueAtTime(0, t);
      amp.gain.linearRampToValueAtTime(gain, t + 0.003);
      amp.gain.setValueAtTime(gain, t + seconds - 0.003);
      amp.gain.linearRampToValueAtTime(0, t + seconds);
      osc.connect(amp).connect(ctx.destination);
      osc.start(t); osc.stop(t + seconds + 0.01);
    }
    t += seconds;
  }
}
