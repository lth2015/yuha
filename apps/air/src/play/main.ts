/**
 * The instrument: touch → session → engine → synth and light, then replay.
 *
 * A performance starts at the first touch and lasts at most 30 seconds (or
 * until 「完成」). The engine is fed only what the session keeps, which is
 * also what the sketch records, so 「回放」 plays back the same events — the
 * same notes at the same moments, the same light in the same places.
 *
 * Audio is unlocked and the context created synchronously inside the first
 * pointerdown (iOS allows it nowhere else), using the silent-element method
 * #27 found to work with the silent switch on.
 */
import { unlockAudio } from '../audio/unlock.ts';
import type { GestureFrame } from '../engine/frame.ts';
import { createPerformer, LOOKAHEAD_MS, perform, type NoteEvent, type Performer } from '../engine/performer.ts';
import { PRESETS, type Preset } from '../engine/presets.ts';
import { createSession, MAX_MS, type Sketch } from '../engine/session.ts';
import { createLight } from './light.ts';
import { createSynth, type Synth } from './synth.ts';
import { attachTouch } from './touch.ts';
import './play.css';

/** Margin between deciding a note and the audio clock reaching it. */
const SAFETY_S = 0.02;
/** How long after the last frame a replay keeps sounding (reverb and release). */
const TAIL_MS = 2500;
const RING_LENGTH = 2 * Math.PI * 26;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const stage = $('#stage');
const hint = $('#hint');
const ring = $('#ring');
const ringArc = document.querySelector<SVGCircleElement>('#ring-arc')!;
const doneButton = $<HTMLButtonElement>('#done');
const ended = $('#ended');
const replayButton = $<HTMLButtonElement>('#replay');
const againButton = $<HTMLButtonElement>('#again');
const toast = $('#toast');
const light = createLight($<HTMLCanvasElement>('#light'));

let ctx: AudioContext | null = null;
let liveSynth: Synth | null = null;

type Mode = 'ready' | 'playing' | 'ended' | 'replaying';
let mode: Mode = 'ready';
let preset: Preset = PRESETS[0]!;
let seed = 0;
let session = createSession({ presetId: preset.id, seed });
let performer: Performer = createPerformer(preset, seed);
let sketch: Sketch | null = null;

function fresh() {
  // A new seed each time: the same gesture plays a little differently.
  seed = (Math.random() * 2 ** 32) >>> 0;
  preset = PRESETS[0]!;
  session = createSession({ presetId: preset.id, seed });
  performer = createPerformer(preset, seed);
  sketch = null;
}
fresh();

function setMode(next: Mode) {
  mode = next;
  ring.hidden = next !== 'playing';
  ended.hidden = next !== 'ended' && next !== 'replaying';
  replayButton.textContent = next === 'replaying' ? '停止' : '回放';
  againButton.disabled = next === 'replaying';
  stage.setAttribute('aria-hidden', String(next === 'ended' || next === 'replaying'));
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function say(text: string) {
  toast.textContent = text;
  toast.hidden = false;
  // A newer message gets its full time on screen.
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 2200);
}

/** Schedule live events against the audio clock, tied at "now" to the frame that produced them. */
function playLive(events: NoteEvent[], frame: GestureFrame) {
  if (!ctx || !liveSynth) return;
  const now = ctx.currentTime + SAFETY_S;
  for (const e of events) {
    const ahead = Math.min(LOOKAHEAD_MS, Math.max(0, e.t - frame.t));
    liveSynth.play(e, now + ahead / 1000);
    light.note(e, SAFETY_S * 1000 + ahead);
  }
}

function offer(raw: GestureFrame) {
  if (mode !== 'ready' && mode !== 'playing') return;
  const out = session.push(raw);
  if (out.frame) playLive(performer.push(out.frame), out.frame);
  if (out.status === 'playing' && mode === 'ready') {
    setMode('playing');
    hint.hidden = true;
  }
  if (out.status === 'ended') finishWith(out.sketch);
}

function finishWith(s: Sketch) {
  sketch = s;
  light.cursor(null);
  $('#ended-length').textContent = `${Math.round(s.frames.at(-1)!.t / 1000)} 秒`;
  setMode('ended');
}

const touch = attachTouch(stage, {
  down() {
    unlockAudio({ audioSession: true, silentElement: true });
    if (!ctx) {
      ctx = new AudioContext({ latencyHint: 'interactive' });
      liveSynth = createSynth(ctx);
    }
    if (ctx.state !== 'running') void ctx.resume();
  },
  frame(f) {
    if (mode === 'ready' || mode === 'playing') light.cursor(f);
    offer(f);
  },
});

/* While a performance runs with no finger down, time still passes: tell the session. */
function tick() {
  requestAnimationFrame(tick);
  if (mode !== 'playing') return;
  const t = touch.time();
  if (t !== null && !touch.fingerDown()) {
    offer({ t, active: false, x: 0.5, y: 0.5, speed: 0, openness: 0, spread: null, confidence: 1, source: 'touch' });
  }
  // offer() may just have ended the performance.
  if (mode === 'playing') ringArc.style.strokeDashoffset = String(RING_LENGTH * (1 - session.elapsed() / MAX_MS));
}
requestAnimationFrame(tick);

doneButton.addEventListener('click', () => {
  const out = session.finish();
  if (out.status === 'ended') finishWith(out.sketch);
  else if (out.status === 'too-short') {
    say('再多玩一会儿，再听回放');
    fresh();
    setMode('ready');
    hint.hidden = false;
  }
});

/* ---------- replay ---------- */

let stopReplay: (() => void) | null = null;

replayButton.addEventListener('click', () => {
  if (stopReplay) {
    stopReplay();
    return;
  }
  if (!ctx || !sketch) return;
  // A click is a gesture: wake audio in case the page was in the background.
  if (ctx.state !== 'running') void ctx.resume();
  const s = sketch;
  const out = ctx.createGain();
  out.connect(ctx.destination);
  const synth = createSynth(ctx, out);
  const p = PRESETS.find((x) => x.id === s.presetId)!;
  const start = ctx.currentTime + 0.15;
  const startedAt = performance.now() + 150;
  for (const e of perform(p, s.seed, s.frames)) {
    synth.play(e, start + e.t / 1000);
    light.note(e, 150 + e.t);
  }
  const last = s.frames.at(-1)!.t;
  let raf = 0;
  const follow = () => {
    raf = requestAnimationFrame(follow);
    light.cursor(frameAt(s.frames, performance.now() - startedAt));
  };
  follow();
  const done = setTimeout(() => stopReplay?.(), 150 + last + TAIL_MS);
  stopReplay = () => {
    clearTimeout(done);
    cancelAnimationFrame(raf);
    // Fade rather than cut, then let go of everything still scheduled.
    out.gain.setTargetAtTime(0, ctx!.currentTime, 0.05);
    setTimeout(() => out.disconnect(), 400);
    light.clear();
    light.cursor(null);
    stopReplay = null;
    setMode('ended');
  };
  setMode('replaying');
});

againButton.addEventListener('click', () => {
  stopReplay?.();
  fresh();
  setMode('ready');
  hint.hidden = false;
});

/** The finger as it was `t` ms into the sketch, interpolated between kept frames. */
function frameAt(frames: GestureFrame[], t: number) {
  let i = 0;
  while (i + 1 < frames.length && frames[i + 1]!.t <= t) i += 1;
  const a = frames[i]!;
  const b = frames[i + 1];
  if (!b || !a.active || !b.active) return { x: a.x, y: a.y, active: a.active && t >= a.t };
  const k = Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, active: true };
}

setMode('ready');
