/**
 * The side-effecting half of the probe: unlock audio inside the gesture, then
 * play a short chime through Web Audio. The unlock itself, and what #27 found
 * about each method, lives in ../audio/unlock.ts, which the instrument uses
 * too.
 *
 * Everything that must happen in the gesture happens synchronously in
 * `strike`: iOS only lets a user gesture create or resume an AudioContext and
 * start a media element.
 */
import type { Method } from './probe.ts';

import { unlockAudio } from '../audio/unlock.ts';
export { audioSessionAvailable, unlockProblems } from '../audio/unlock.ts';

let ctx: AudioContext | null = null;

/** C major pentatonic across two octaves: any note sounds right against any other. */
const PENTATONIC = [523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66, 1318.51, 1567.98, 1760];

function chime(context: AudioContext, at: number, x: number) {
  const out = context.createGain();
  out.gain.value = 0.22;
  const tone = context.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 3200;
  out.connect(tone).connect(context.destination);
  const root = Math.min(PENTATONIC.length - 5, Math.max(0, Math.floor(x * (PENTATONIC.length - 4))));
  // A rolled triad: root, third and fifth of the scale, 70 ms apart.
  [0, 2, 4].forEach((step, i) => {
    const start = at + i * 0.07;
    const freq = PENTATONIC[root + step]!;
    for (const [type, ratio, level] of [
      ['sine', 1, 1],
      ['triangle', 2, 0.18],
    ] as const) {
      const osc = context.createOscillator();
      osc.type = type;
      osc.frequency.value = freq * ratio;
      const env = context.createGain();
      env.gain.setValueAtTime(0.0001, start);
      env.gain.exponentialRampToValueAtTime(level, start + 0.012);
      env.gain.exponentialRampToValueAtTime(0.0001, start + 1.8);
      osc.connect(env).connect(out);
      osc.start(start);
      osc.stop(start + 1.9);
    }
  });
}

export type Strike = {
  /** performance.now() when the context was running and the chime scheduled. */
  readyAt: Promise<number>;
  baseLatency: number | undefined;
  outputLatency: number | undefined;
  contextStateAtGesture: AudioContextState | 'new';
};

/**
 * A second chance from a `click`, in case this WebKit does not count
 * `pointerdown` as a gesture that may resume audio. Returns whether it had to
 * try, so the trial can say that pointerdown alone was not enough.
 */
export function resumeAgain(): boolean {
  if (!ctx || ctx.state === 'running') return false;
  void ctx.resume();
  return true;
}

/** Call from the pointerdown handler itself, never after an await. */
export function strike(method: Method, x: number): Strike {
  unlockAudio({ audioSession: method === 'audio-session' || method === 'both', silentElement: method === 'silent-element' || method === 'both' });
  const contextStateAtGesture = ctx ? ctx.state : 'new';
  ctx ??= new AudioContext({ latencyHint: 'interactive' });
  const context = ctx;
  const resumed = context.state === 'running' ? Promise.resolve() : context.resume();
  chime(context, context.currentTime + 0.005, x);
  return {
    readyAt: resumed.then(() => performance.now()),
    baseLatency: typeof context.baseLatency === 'number' ? context.baseLatency : undefined,
    outputLatency: typeof context.outputLatency === 'number' ? context.outputLatency : undefined,
    contextStateAtGesture,
  };
}
