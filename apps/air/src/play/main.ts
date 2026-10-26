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
import { songUrl } from '../engine/prefill.ts';
import { decodeSketch, shareUrl } from '../engine/share.ts';
import { format, pickLang, STRINGS, type Key } from './i18n.ts';
import { createLight } from './light.ts';
import { sceneFor } from './scenes.ts';
import { createObservation } from './observe.ts';
import { createSynth, type Synth } from './synth.ts';
import { attachTouch } from './touch.ts';
import './play.css';

/** Margin between deciding a note and the audio clock reaching it. */
const SAFETY_S = 0.02;
/** How long after the last frame a replay keeps sounding (reverb and release). */
const TAIL_MS = 2500;
const RING_LENGTH = 2 * Math.PI * 26;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

/* ---------- words ---------- */

const lang = pickLang(navigator.languages?.length ? navigator.languages : [navigator.language]);
const t = (key: Key, vars: Record<string, string | number> = {}) => format(STRINGS[lang][key], vars);
document.documentElement.lang = { zh: 'zh-Hans', ja: 'ja', en: 'en' }[lang];
document.title = t('title');
for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(el.dataset.i18n as Key);
for (const el of document.querySelectorAll<HTMLElement>('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria as Key));
const seconds = (ms: number) => Math.round(ms / 1000);

/*
 * The moderator's numbers for the usability test (#35), only with #observe in the
 * address: a faint dot in the corner opens them. Moderator-facing, so in English
 * and outside the string table. Nothing is stored or sent.
 */
const observing = location.hash === '#observe';
const observation = createObservation(performance.now());
if (observing) {
  const panel = Object.assign(document.createElement('pre'), { id: 'observe', hidden: true });
  const dot = Object.assign(document.createElement('button'), { id: 'observe-dot', type: 'button', textContent: '·' });
  dot.setAttribute('aria-label', 'Observer numbers');
  dot.addEventListener('click', () => {
    panel.textContent = observation.line();
    panel.hidden = !panel.hidden;
  });
  document.body.append(dot, panel);
}
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
  light.scene(sceneFor(preset.id));
  light.progress(0);
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
  replayButton.textContent = t(next === 'replaying' ? 'stop' : 'replay');
  againButton.disabled = shareButton.disabled = next === 'replaying';
  listenButton.textContent = t(next === 'shared-replaying' ? 'stop' : 'listen');
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
  observation.performanceEnded(s.frames.at(-1)!.t);
  sketch = s;
  light.cursor(null);
  $('#ended-length').textContent = t('ended.length', { n: seconds(s.frames.at(-1)!.t) });
  setMode('ended');
}

const touch = attachTouch(stage, {
  down() {
    observation.touch(performance.now());
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
  if (mode === 'playing') {
    ringArc.style.strokeDashoffset = String(RING_LENGTH * (1 - session.elapsed() / MAX_MS));
    light.progress(session.elapsed() / MAX_MS);
  }
}
requestAnimationFrame(tick);

doneButton.addEventListener('click', () => {
  const out = session.finish();
  if (out.status === 'ended') finishWith(out.sketch);
  else if (out.status === 'too-short') {
    observation.tooShort(session.elapsed());
    say(t('toast.tooShort'));
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
  light.scene(sceneFor(p.id));
  light.progress(0);
  for (const e of perform(p, s.seed, s.frames)) {
    synth.play(e, start + e.t / 1000);
    light.note(e, 150 + e.t);
  }
  let raf = 0;
  const follow = () => {
    raf = requestAnimationFrame(follow);
    light.cursor(frameAt(s.frames, performance.now() - startedAt));
    light.progress(Math.max(0, performance.now() - startedAt) / MAX_MS);
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
  observation.replay();
  replay(sketch, 'replaying', 'ended');
});

againButton.addEventListener('click', () => {
  stopReplay?.();
  fresh();
  setMode('ready');
});

/* ---------- the parameter card ---------- */


toSongButton.addEventListener('click', () => {
  if (!sketch) return;
  observation.toSong(performance.now());
  const c = describeSketch(sketch);
  $('#card-mood').textContent = c.moodName[lang];
  $('#card-words').textContent = c.words[lang];
  $('#card-fact-mood').textContent = c.moodName[lang];
  $('#card-tempo').textContent = t(`tempo.${c.tempo}`);
  $('#card-energy').textContent = t(`energy.${c.energy.id}`);
  // Phase 3: /create on yuha.studio, already filled in from this sketch.
  $<HTMLAnchorElement>('#card-go').href = songUrl(c);
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
  observation.share();
  const url = shareUrl(__SHARE_BASE__ || location.href, sketch);
  // Must be called inside the click; refused in some frames, so fall back to a field to copy from.
  navigator.clipboard.writeText(url).then(
    () => say(t('toast.copied')),
    () => {
      shareField.value = url;
      shareField.hidden = false;
      shareField.focus();
      shareField.select();
      say(t('toast.copyByHand'));
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
  light.scene(sceneFor(received.presetId));
  $('#shared-length').textContent = t('shared.length', { n: seconds(received.frames.at(-1)!.t) });
  setMode('shared');
} else {
  setMode('ready');
  if (location.hash.length > 12) say(t('toast.broken'));
}
