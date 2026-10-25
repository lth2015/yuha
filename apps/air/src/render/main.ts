/**
 * Dev-only (not a build entry): renders a scripted gesture offline through the
 * same engine and synth the instrument uses, so a listening check (#28, #29,
 * #33) hears exactly what a finger would. Driven by scripts/render-air.mjs.
 */
import type { GestureFrame } from '../engine/frame.ts';
import { perform } from '../engine/performer.ts';
import { PRESETS } from '../engine/presets.ts';
import { createSynth } from '../play/synth.ts';

/** A person who knows no music, playing for `seconds`: rests, rises, rushes, lifts, wanders. */
function gesture(seed: number, seconds: number): GestureFrame[] {
  let s = seed >>> 0 || 1;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const frames: GestureFrame[] = [];
  let y = 0.35;
  let x = 0.5;
  let speed = 0;
  let active = false;
  let phase = { until: 0, aimY: 0.35, aimSpeed: 0, active: true };
  for (let t = 0; t <= seconds * 1000; t += 1000 / 60) {
    if (t >= phase.until) {
      const kind = r();
      phase =
        kind < 0.12
          ? { until: t + 600 + r() * 900, aimY: y, aimSpeed: 0, active: false } // lift, breathe
          : kind < 0.3
            ? { until: t + 1500 + r() * 2000, aimY: y, aimSpeed: 0, active: true } // rest the finger
            : { until: t + 1200 + r() * 2500, aimY: 0.05 + r() * 0.9, aimSpeed: r() ** 0.7, active: true }; // move
    }
    const k = 1 - Math.exp(-(1000 / 60) / 400);
    y += (phase.aimY - y) * k;
    speed += (phase.aimSpeed - speed) * k;
    x = Math.min(1, Math.max(0, x + (r() - 0.5) * speed * 0.05));
    active = t < 300 ? false : phase.active;
    frames.push({ t, active, x, y, speed, openness: 0, spread: null, confidence: 1, source: 'touch' });
  }
  return frames;
}

async function render(seed: number, seconds: number, presetIndex = 0): Promise<string> {
  const rate = 44_100;
  const ctx = new OfflineAudioContext(2, Math.ceil((seconds + 3) * rate), rate);
  const synth = createSynth(ctx);
  for (const e of perform(PRESETS[presetIndex]!, seed, gesture(seed, seconds))) synth.play(e, e.t / 1000);
  const audio = await ctx.startRendering();
  // 16-bit stereo WAV.
  const n = audio.length;
  const buf = new ArrayBuffer(44 + n * 4);
  const v = new DataView(buf);
  const ascii = (at: number, str: string) => [...str].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + n * 4, true);
  ascii(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, n * 4, true);
  const [L, R] = [audio.getChannelData(0), audio.getChannelData(1)];
  let peak = 0;
  for (let i = 0; i < n; i += 1) {
    v.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i]!)) * 0x7fff, true);
    v.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i]!)) * 0x7fff, true);
    peak = Math.max(peak, Math.abs(L[i]!), Math.abs(R[i]!));
  }
  (window as unknown as { lastPeak: number }).lastPeak = peak;
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

Object.assign(window, { render });
