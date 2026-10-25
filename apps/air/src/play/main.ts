/**
 * #28 · the first performance: one preset, one finger, nothing sounds wrong.
 *
 * Touch → GestureFrame → engine → note events → synth and light. Audio is
 * unlocked and the context created synchronously inside the first
 * pointerdown (iOS allows it nowhere else), using the silent-element method
 * #27 found to work with the silent switch on.
 */
import { unlockAudio } from '../audio/unlock.ts';
import { createPerformer, LOOKAHEAD_MS } from '../engine/performer.ts';
import { PRESETS } from '../engine/presets.ts';
import { createLight } from './light.ts';
import { createSynth, type Synth } from './synth.ts';
import { attachTouch } from './touch.ts';
import './play.css';

/** Margin between deciding a note and the audio clock reaching it. */
const SAFETY_S = 0.02;

const stage = document.querySelector<HTMLElement>('#stage')!;
const hint = document.querySelector<HTMLElement>('#hint')!;
const light = createLight(document.querySelector<HTMLCanvasElement>('#light')!);

let ctx: AudioContext | null = null;
let synth: Synth | null = null;
// A new seed per visit: the same gesture plays a little differently each time.
const performer = createPerformer(PRESETS[0]!, (Math.random() * 2 ** 32) >>> 0);

attachTouch(stage, {
  down() {
    unlockAudio({ audioSession: true, silentElement: true });
    if (!ctx) {
      ctx = new AudioContext({ latencyHint: 'interactive' });
      synth = createSynth(ctx);
    }
    if (ctx.state !== 'running') void ctx.resume();
    hint.hidden = true;
  },
  frame(f) {
    light.frame(f);
    if (!ctx || !synth) return;
    // Frame time and audio time are tied at "now": an event `ahead` ms after
    // this frame sounds that much after the audio clock's present.
    const now = ctx.currentTime + SAFETY_S;
    for (const e of performer.push(f)) {
      const ahead = Math.min(LOOKAHEAD_MS, Math.max(0, e.t - f.t));
      synth.play(e, now + ahead / 1000);
      light.note(e, SAFETY_S * 1000 + ahead);
    }
  },
});
