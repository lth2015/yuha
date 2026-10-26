/**
 * The instrument: touch → session → engine → synth and light, then replay.
 *
 * A performance starts at the first touch and lasts at most 30 seconds (or
 * until 「完成」). The engine is fed only what the session keeps, which is
 * also what the sketch records, so 「回放」 plays back the same events — the
 * same notes at the same moments, the same light in the same places.
 *
 * 「复制链接」 puts the sketch in a link's #fragment (#31); opening such a link
 * offers 「聆听」 — the same replay, so a friend hears what was played — and
 * then 「自己来一段」. Nothing is sent anywhere: the fragment never leaves the
 * browser.
 *
 * 「让它成为一首歌」 shows the parameter card (#32): the sketch said back as the
 * mood, tempo and energy a song request would use, and a link to YUHA. It
 * sends nothing; generation itself is phase 3.
 *
 * Audio is unlocked and the context created synchronously inside the first
 * gesture (iOS allows it nowhere else), using the silent-element method #27
 * found to work with the silent switch on.
 */
import { unlockAudio } from '../audio/unlock.ts';
import type { GestureFrame } from '../engine/frame.ts';
import { createPerformer, LOOKAHEAD_MS, perform, type NoteEvent, type Performer } from '../engine/performer.ts';
import { PRESETS, presetFor, type Preset } from '../engine/presets.ts';
import { createSession, MAX_MS, type Sketch } from '../engine/session.ts';
import { describeSketch } from '../engine/describe.ts';
import { decodeSketch, shareUrl } from '../engine/share.ts';
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
const shareButton = $<HTMLButtonElement>('#share');
const shareField = $<HTMLInputElement>('#share-url');
const sharedPanel = $('#shared');
const listenButton = $<HTMLButtonElement>('#listen');
const ownButton = $<HTMLButtonElement>('#own');
const toSongButton = $<HTMLButtonElement>('#to-song');
const card = $('#card');
const light = createLight($<HTMLCanvasElement>('#light'));

let ctx: AudioContext | null = null;
let liveSynth: Synth | null = null;

type Mode = 'ready' | 'playing' | 'ended' | 'replaying' | 'shared' | 'shared-replaying' | 'card';
let mode: Mode = 'ready';
let preset: Preset = PRESETS[0]!;
let seed = 0;
let session = createSession({ presetId: preset.id, seed });
let performer: Performer = createPerformer(preset, seed);
let sketch: Sketch | null = null;

function fresh() {
  // A new seed each time: the same gesture plays a little differently, and the seed
  // also picks the preset (key, tempo, harmony and voice), so 重来 may sound new.
  seed = (Math.random() * 2 ** 32) >>> 0;
  preset = presetFor(seed);
  session = createSession({ presetId: preset.id, seed });
  performer = createPerformer(preset, seed);
  sketch = null;
  if (ctx) {
    liveSynth?.release();
    liveSynth = createSynth(ctx, ctx.destination, preset.timbre);
  }
}
fresh();

function setMode(next: Mode) {
  mode = next;
  ring.hidden = next !== 'playing';
  ended.hidden = next !== 'ended' && next !== 'replaying';
  sharedPanel.hidden = next !== 'shared' && next !== 'shared-replaying';
  card.hidden = next !== 'card';
  toSongButton.disabled = next === 'replaying';
  replayButton.textContent = next === 'replaying' ? '停止' : '回放';
  againButton.disabled = shareButton.disabled = next === 'replaying';
  listenButton.textContent = next === 'shared-replaying' ? '停止' : '聆听';
  ownButton.disabled = next === 'shared-replaying';
  hint.hidden = next !== 'ready';
  if (next !== 'ended') shareField.hidden = true;
  stage.setAttribute('aria-hidden', String(next !== 'ready' && next !== 'playing'));
}

/** Audio may only start inside a gesture; every button that plays calls this first. */
function wake() {
  unlockAudio({ audioSession: true, silentElement: true });
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    liveSynth = createSynth(ctx, ctx.destination, preset.timbre);
  }
  if (ctx.state !== 'running') void ctx.resume();
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
  if (out.status === 'playing' && mode === 'ready') setMode('playing');
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
    wake();
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
  }
});

/* ---------- replay: your own sketch, or a friend's ---------- */

let stopReplay: (() => void) | null = null;

/** Plays a sketch back through the same engine; `after` is the mode to return to. */
function replay(s: Sketch, playing: Mode, after: Mode) {
  if (!ctx) return;
  const p = PRESETS.find((x) => x.id === s.presetId)!;
  const synth = createSynth(ctx, ctx.destination, p.timbre);
  const start = ctx.currentTime + 0.15;
  const startedAt = performance.now() + 150;
  for (const e of perform(p, s.seed, s.frames)) {
    synth.play(e, start + e.t / 1000);
    light.note(e, 150 + e.t);
  }
  let raf = 0;
  const follow = () => {
    raf = requestAnimationFrame(follow);
    light.cursor(frameAt(s.frames, performance.now() - startedAt));
  };
  follow();
  const done = setTimeout(() => stopReplay?.(), 150 + s.frames.at(-1)!.t + TAIL_MS);
  stopReplay = () => {
    clearTimeout(done);
    cancelAnimationFrame(raf);
    synth.release();
    light.clear();
    light.cursor(null);
    stopReplay = null;
    setMode(after);
  };
  setMode(playing);
}

replayButton.addEventListener('click', () => {
  if (stopReplay) return stopReplay();
  if (!sketch) return;
  wake();
  replay(sketch, 'replaying', 'ended');
});

againButton.addEventListener('click', () => {
  stopReplay?.();
  fresh();
  setMode('ready');
});

/* ---------- the parameter card ---------- */

const TEMPO_NAME = { slow: '慢', medium: '中速', fast: '快' } as const;
const ENERGY_NAME = { mellow: '舒缓', medium: '适中', strong: '强烈' } as const;

toSongButton.addEventListener('click', () => {
  if (!sketch) return;
  const c = describeSketch(sketch);
  $('#card-mood').textContent = c.moodName.zh;
  $('#card-words').textContent = c.words.zh;
  $('#card-fact-mood').textContent = c.moodName.zh;
  $('#card-tempo').textContent = TEMPO_NAME[c.tempo];
  $('#card-energy').textContent = ENERGY_NAME[c.energy.id];
  setMode('card');
  $<HTMLAnchorElement>('#card-go').focus();
});

$('#card-back').addEventListener('click', () => {
  setMode('ended');
  toSongButton.focus();
});

/* ---------- sharing ---------- */

shareButton.addEventListener('click', () => {
  if (!sketch) return;
  const url = shareUrl(__SHARE_BASE__ || location.href, sketch);
  // Must be called inside the click; refused in some frames, so fall back to a field to copy from.
  navigator.clipboard.writeText(url).then(
    () => say('链接已复制，发给朋友吧'),
    () => {
      shareField.value = url;
      shareField.hidden = false;
      shareField.focus();
      shareField.select();
      say('长按上面的链接，全选后复制');
    },
  );
});

let received: Sketch | null = null;

listenButton.addEventListener('click', () => {
  if (stopReplay) return stopReplay();
  if (!received) return;
  wake();
  replay(received, 'shared-replaying', 'shared');
});

ownButton.addEventListener('click', () => {
  stopReplay?.();
  received = null;
  // Drop the friend's sketch from the address, so a reload starts fresh.
  history.replaceState(null, '', location.pathname + location.search);
  fresh();
  setMode('ready');
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

/* Opened from a shared link? A short fragment is someone else's anchor, not a broken sketch. */
received = decodeSketch(location.hash);
if (received) {
  $('#shared-length').textContent = `${Math.round(received.frames.at(-1)!.t / 1000)} 秒`;
  setMode('shared');
} else {
  setMode('ready');
  if (location.hash.length > 12) say('这个链接打不开了，来演奏你自己的吧');
}
