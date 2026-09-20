/**
 * Real beat energy from the shared audio element (Web Audio AnalyserNode).
 *
 * The spec is explicit: audio-reactive visuals may only read actual analysis
 * data — no random-number "beats". This module taps the player's audio
 * element once (crossOrigin anonymous; the API serves CORS for our origin)
 * and exposes a smoothed energy level 0..1 via a subscription, so petals and
 * notes can breathe with what is genuinely playing. If the tap fails (no
 * AudioContext, CORS refusal), energy stays 0 and consumers fall back to the
 * plain playing/not-playing state.
 */
type Listener = (energy: number, playing: boolean) => void;

let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let freq: Uint8Array<ArrayBuffer> | null = null;
let attached: HTMLAudioElement | null = null;
let raf = 0;
let smoothed = 0;
const listeners = new Set<Listener>();

function loop() {
  raf = requestAnimationFrame(loop);
  if (!analyser || !freq) return;
  analyser.getByteFrequencyData(freq);
  // Average of the low-mid bins (roughly the rhythm band) → 0..1.
  let sum = 0;
  const n = Math.min(48, freq.length);
  for (let i = 0; i < n; i += 1) sum += freq[i]!;
  const raw = n ? sum / n / 255 : 0;
  // Smooth rise, quick release — reads as a beat without flicker.
  smoothed = raw > smoothed ? smoothed + (raw - smoothed) * 0.55 : smoothed * 0.88;
  const playing = !attached?.paused;
  for (const l of listeners) l(Math.min(1, smoothed), playing);
}

/** Taps the given audio element exactly once per page load. */
export function attachBeat(audio: HTMLAudioElement): void {
  if (attached === audio) return;
  attached = audio;
  try {
    audio.crossOrigin = 'anonymous';
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx ??= new AC();
    const source = ctx.createMediaElementSource(audio);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;
    freq = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    source.connect(analyser);
    analyser.connect(ctx.destination);
    if (!raf) loop();
  } catch {
    // Untappable audio: consumers degrade to playing-state animation.
    analyser = null;
  }
}

export function subscribeBeat(listener: Listener): () => void {
  listeners.add(listener);
  listener(smoothed, attached ? !attached.paused : false);
  return () => listeners.delete(listener);
}

/** Resume the AudioContext after a user gesture (autoplay policy). */
export function wakeBeat(): void {
  if (ctx?.state === 'suspended') void ctx.resume();
}
