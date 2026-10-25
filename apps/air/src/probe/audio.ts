/**
 * The side-effecting half of the probe: unlock audio inside the gesture, then
 * play a short chime through Web Audio.
 *
 * Both candidate fixes are UNVERIFIED on a real iPhone — finding out is the
 * point of #27:
 *
 * - `audio-session`: set `navigator.audioSession.type = 'playback'`, which
 *   asks WebKit to treat the page's audio as media rather than as a ringer
 *   sound. Exposed by recent Safari; whether it is available on a given
 *   version, or only in a secure context, is what the trial rows record.
 * - `silent-element`: start a looping, silent <audio> element in the same
 *   gesture. A playing media element is believed to move the page's audio
 *   session to the media channel, taking Web Audio with it.
 *
 * Everything that must happen in the gesture happens synchronously in
 * `strike`: iOS only lets a user gesture create or resume an AudioContext and
 * start a media element.
 */
import type { Method } from './probe.ts';

type AudioSessionNavigator = Navigator & { audioSession?: { type: string } };

export const audioSessionAvailable = (): boolean =>
  typeof navigator !== 'undefined' && typeof (navigator as AudioSessionNavigator).audioSession === 'object';

let ctx: AudioContext | null = null;
let silent: HTMLAudioElement | null = null;
let unlocked = false;

/** Half a second of 8-bit mono silence as a WAV, built here so no asset is fetched. */
function silentWavUrl(): string {
  const rate = 8000;
  const samples = rate / 2;
  const buf = new ArrayBuffer(44 + samples);
  const v = new DataView(buf);
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + samples, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate, true); // byte rate
  v.setUint16(32, 1, true); // block align
  v.setUint16(34, 8, true); // bits per sample
  ascii(36, 'data');
  v.setUint32(40, samples, true);
  for (let i = 0; i < samples; i += 1) v.setUint8(44 + i, 128); // 8-bit silence is the midpoint
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

/**
 * What the browser refused while unlocking. Unlocking happens once per page
 * load, so these hold for every trial on this load, not just the first.
 */
export const unlockProblems: string[] = [];

function unlock(method: Method) {
  if (unlocked) return;
  unlocked = true;
  if (method === 'audio-session' || method === 'both') {
    const nav = navigator as AudioSessionNavigator;
    if (nav.audioSession) {
      try {
        nav.audioSession.type = 'playback';
      } catch (e) {
        unlockProblems.push(`audioSession: ${(e as Error).message}`);
      }
    } else {
      unlockProblems.push('audioSession: not exposed');
    }
  }
  if (method === 'silent-element' || method === 'both') {
    silent = new Audio(silentWavUrl());
    silent.loop = true;
    silent.setAttribute('playsinline', '');
    silent.play().catch((e: Error) => unlockProblems.push(`silent element: ${e.name}`));
  }
}

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
  unlock(method);
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
