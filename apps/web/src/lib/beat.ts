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

let lastPlaying: boolean | null = null;

function loop() {
  raf = requestAnimationFrame(loop);
  if (!analyser || !freq) {
    // No tap (iOS, or it failed): still tell consumers when playback starts
    // and stops — they fall back to that — but only on a change, not per frame.
    const playing = attached ? !attached.paused : false;
    if (playing !== lastPlaying) {
      lastPlaying = playing;
      for (const l of listeners) l(0, playing);
    }
    return;
  }
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

/**
 * Whether this browser may route the player through Web Audio at all.
 *
 * Not on iPhone or iPad. `createMediaElementSource` moves the element's sound
 * into the AudioContext, and iOS plays Web Audio on the RINGER channel: with
 * the silent switch on — most phones, most of the time — the song plays in
 * total silence while the progress bar moves. A plain <audio> element plays on
 * the media channel and ignores the switch. iOS also suspends an AudioContext
 * when the screen locks, which stopped the music on lock. Every iOS browser is
 * WebKit, so Chrome on iPhone is the same case.
 *
 * iPadOS reports itself as a Mac; a Mac with a touch screen is the tell.
 * Visuals there fall back to the playing/paused state, as they already do
 * whenever the tap fails.
 */
export function mayTapAudio(nav: { userAgent: string; maxTouchPoints?: number }): boolean {
  if (/\b(iPhone|iPad|iPod)\b/.test(nav.userAgent)) return false;
  if (/\bMacintosh\b/.test(nav.userAgent) && (nav.maxTouchPoints ?? 0) > 1) return false;
  return true;
}

/** Taps the given audio element exactly once per page load. */
export function attachBeat(audio: HTMLAudioElement): void {
  if (attached === audio) return;
  attached = audio;
  if (typeof navigator !== 'undefined' && !mayTapAudio(navigator)) {
    if (!raf && typeof requestAnimationFrame !== 'undefined') loop();
    return;
  }
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
    if (!raf) loop();
  }
}

export function subscribeBeat(listener: Listener): () => void {
  listeners.add(listener);
  listener(smoothed, attached ? !attached.paused : false);
  return () => listeners.delete(listener);
}

/** Resume the AudioContext after a user gesture (autoplay policy). */
export function wakeBeat(): void {
  // Not only 'suspended': WebKit also has 'interrupted' (a call, another app
  // taking audio), and a context in it is just as silent.
  if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') void ctx.resume();
}
