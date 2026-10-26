/**
 * The visible half of the answer: light where each note was played, sized by
 * how strongly and coloured by register, and a mark for the finger. Notes are
 * placed from the note events alone, so a replay of the same events draws the
 * same light. Never driven by invented beats.
 *
 * Two scenes (scenes.ts). On paper, each note is a soft bloom. On the lake
 * (春江), a pale landscape in YUHA's palette: faint distant hills, a still lake,
 * a sun that rises with the performance and lies on the water, two far birds
 * and a few drifting petals. Each note is a ripple on the water or soft light
 * in the sky. Everything is drawn faint: it is a ground for the sound, not a show.
 */
import type { NoteEvent } from '../engine/performer.ts';
import { HORIZON, lakeTone, ridge, splashFor, sunAt, type SceneId } from './scenes.ts';

type Kind = 'bloom' | 'ripple' | 'glow' | 'mist';
type Bloom = { kind: Kind; x: number; y: number; born: number; life: number; size: number; hue: number; sat: number; light: number; alpha: number; seed: number };
type Cursor = { x: number; y: number; active: boolean };

/** Small deterministic noise, so a replay scatters its light the same way. */
const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

export function createLight(canvas: HTMLCanvasElement) {
  const g = canvas.getContext('2d')!;
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const blooms: Bloom[] = [];
  let finger: Cursor | null = null;
  /** Harmony arrives right after its melody note; its bloom sits beside that note, not beside the centre. */
  let melodyPan = 0;
  let scale = 1;
  let scene: SceneId = 'paper';
  /** How far through the longest performance we are, 0…1: the sun's height. */
  let progress = 0;
  /** Eased towards `progress`, so the sun glides when a new performance resets it. */
  let shown = 0;

  const resize = () => {
    scale = Math.min(2, devicePixelRatio || 1);
    canvas.width = canvas.clientWidth * scale;
    canvas.height = canvas.clientHeight * scale;
  };
  resize();
  addEventListener('resize', resize);

  // Paper: low notes warm (petal orange), high notes cool (violet).
  const hueFor = (pitch: number) => 18 - Math.min(1, Math.max(0, (pitch - 55) / 29)) * 75;

  const W = () => canvas.width;
  const H = () => canvas.height;
  const px = (x: number) => x * W();
  const py = (y: number) => (1 - y) * H();

  /** The YUHA mark: a drifting petal (apps/web/public/brand/yuha-mark-orange.svg), 96 units wide. */
  const PETAL = [new Path2D('M81 12C83 41 62 71 27 85C31 70 43 55 54 47C66 37 75 24 81 12Z'), new Path2D('M14 24C37 23 53 34 54 49C40 47 22 38 14 24Z')];
  /** A few petals and two far birds: decoration, drifting so slowly it reads as stillness. */
  const PETALS = Array.from({ length: 5 }, (_, i) => ({ x: hash(i + 11), y: 0.5 + hash(i + 21) * 0.45, speed: 0.5 + hash(i + 31), size: 0.6 + hash(i + 41) * 0.6, spin: hash(i + 51) * 6.28 }));
  const BIRDS = [{ x: 0.22, y: 0.78, s: 1 }, { x: 0.27, y: 0.8, s: 0.75 }];

  /** Hills from scenes.ts as a filled shape down to the shore, misting out at the foot. */
  function hills(layer: number, ink: string, alpha: number) {
    const w = W();
    const horizon = py(HORIZON);
    // A wide screen shows more of the range, not the same hills stretched flat.
    const span = Math.max(1, (w / H()) * 1.4);
    g.beginPath();
    g.moveTo(0, horizon);
    for (let i = 0; i <= 160; i += 1) g.lineTo((i / 160) * w, py(ridge(layer, (i / 160) * span)));
    g.lineTo(w, horizon);
    g.closePath();
    const fill = g.createLinearGradient(0, py(ridge(layer, 0.5) + 0.08), 0, horizon);
    fill.addColorStop(0, `rgba(${ink}, ${alpha})`);
    fill.addColorStop(1, `rgba(${ink}, ${alpha * 0.35})`);
    g.fillStyle = fill;
    g.fill();
  }

  function lakeBackdrop(now: number) {
    const w = W();
    const h = H();
    const horizon = py(HORIZON);
    const short = Math.min(w, h);

    // Sky: the paper, warming a little towards the far shore.
    const sky = g.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, '#f6f5f0');
    sky.addColorStop(1, '#f5efe6');
    g.fillStyle = sky;
    g.fillRect(0, 0, w, horizon);

    // The sun, rising behind the hills; pale petal, never a glare.
    shown += (progress - shown) * (calm ? 1 : 0.04);
    const sun = sunAt(shown);
    const sx = px(sun.x);
    const sy = py(sun.y);
    const sr = short * sun.r;
    const breath = calm ? 1 : 0.94 + 0.06 * Math.sin(now / 1800);
    const halo = g.createRadialGradient(sx, sy, sr * 0.8, sx, sy, sr * 6);
    halo.addColorStop(0, `rgba(244, 107, 69, ${0.1 * breath})`);
    halo.addColorStop(0.4, `rgba(244, 140, 100, ${0.035 * breath})`);
    halo.addColorStop(1, 'rgba(244, 160, 120, 0)');
    g.fillStyle = halo;
    g.beginPath();
    g.arc(sx, sy, sr * 6, 0, Math.PI * 2);
    g.fill();
    const disc = g.createRadialGradient(sx, sy, 0, sx, sy, sr * 1.06);
    disc.addColorStop(0, 'rgba(255, 216, 198, 0.85)');
    disc.addColorStop(0.8, 'rgba(255, 204, 182, 0.78)');
    disc.addColorStop(1, 'rgba(255, 200, 176, 0)');
    g.fillStyle = disc;
    g.beginPath();
    g.arc(sx, sy, sr * 1.06, 0, Math.PI * 2);
    g.fill();

    // Distant hills in faint ink, farthest palest; they stand in front of the low sun.
    hills(0, '123, 129, 119', 0.13);
    hills(1, '110, 120, 112', 0.17);
    hills(2, '97, 102, 93', 0.22);
    // Haze lying along the far shore.
    const haze = g.createLinearGradient(0, horizon - short * 0.05, 0, horizon + short * 0.02);
    haze.addColorStop(0, 'rgba(246, 245, 240, 0)');
    haze.addColorStop(1, 'rgba(246, 245, 240, 0.7)');
    g.fillStyle = haze;
    g.fillRect(0, horizon - short * 0.05, w, short * 0.07);

    // The lake: still, a shade cooler than the paper.
    const water = g.createLinearGradient(0, horizon, 0, h);
    water.addColorStop(0, '#eef0e9');
    water.addColorStop(1, '#f4f4ef');
    g.fillStyle = water;
    g.fillRect(0, horizon, w, h - horizon);

    // Long, faint lines of a calm surface, barely moving.
    for (let i = 0; i < 9; i += 1) {
      const depth = (i + 0.5) / 9;
      const y = horizon + (h - horizon) * depth ** 1.5;
      const drift = calm ? 0 : Math.sin(now / 5000 + i) * w * 0.02;
      const x0 = w * (0.08 + 0.5 * hash(i + 61)) + drift;
      const len = w * (0.15 + 0.25 * hash(i + 71));
      const line = g.createLinearGradient(x0, 0, x0 + len, 0);
      line.addColorStop(0, 'rgba(123, 129, 119, 0)');
      line.addColorStop(0.5, `rgba(123, 129, 119, ${0.12 * (1 - depth * 0.4)})`);
      line.addColorStop(1, 'rgba(123, 129, 119, 0)');
      g.fillStyle = line;
      g.fillRect(x0, y, len, Math.max(1, scale));
    }

    // The sun on the water: a soft column of petal-coloured glints.
    for (let i = 0; i < 16; i += 1) {
      const depth = i / 16;
      const y = horizon + 2 * scale + (h - horizon) * 0.6 * depth ** 1.4;
      const spread = sr * (0.5 + depth * 1.6);
      const r = hash(i + (calm ? 0 : Math.floor(now / 700 + i * 0.4)));
      const len = spread * (0.4 + 0.6 * r);
      const cx = sx + (calm ? 0 : Math.sin(now / 1300 + i * 1.9) * spread * 0.3);
      const a = 0.22 * (1 - depth) * (calm ? 0.8 : 0.6 + 0.4 * Math.sin(now / 420 + i * 2.1));
      const glint = g.createLinearGradient(cx - len / 2, 0, cx + len / 2, 0);
      glint.addColorStop(0, 'rgba(244, 107, 69, 0)');
      glint.addColorStop(0.5, `rgba(244, 107, 69, ${a})`);
      glint.addColorStop(1, 'rgba(244, 107, 69, 0)');
      g.fillStyle = glint;
      g.fillRect(cx - len / 2, y, len, Math.max(1, scale * 1.2));
    }

    // Two far birds and a few drifting petals.
    g.strokeStyle = 'rgba(97, 102, 93, 0.35)';
    g.lineWidth = Math.max(1, scale);
    for (const b of BIRDS) {
      const bx = px((b.x + (calm ? 0 : now / 400000)) % 1.1);
      const by = py(b.y) + (calm ? 0 : Math.sin(now / 900 + b.x * 9) * 2 * scale);
      const span = short * 0.012 * b.s;
      const flap = calm ? 0.35 : 0.25 + 0.15 * Math.sin(now / 260 + b.x * 20);
      g.beginPath();
      g.moveTo(bx - span, by - span * flap);
      g.quadraticCurveTo(bx - span * 0.4, by - span * 0.1, bx, by);
      g.quadraticCurveTo(bx + span * 0.4, by - span * 0.1, bx + span, by - span * flap);
      g.stroke();
    }
    for (const p of PETALS) {
      const t = calm ? 0 : now / 1000;
      const x = (p.x + t * 0.004 * p.speed) % 1.15 - 0.05;
      const y = p.y - ((t * 0.0025 * p.speed) % 0.6) + Math.sin(t * 0.4 + p.spin) * 0.01;
      if (y < HORIZON + 0.02) continue;
      const size = short * 0.00022 * p.size;
      g.save();
      g.translate(px(x), py(y));
      g.rotate(p.spin + (calm ? 0 : Math.sin(t * 0.3 + p.spin) * 0.5));
      g.scale(size, size);
      g.translate(-48, -48);
      g.fillStyle = 'rgba(244, 107, 69, 0.28)';
      for (const path of PETAL) g.fill(path);
      g.restore();
    }
  }

  function drawNote(b: Bloom, age: number, short: number) {
    const x = px(b.x);
    const y = py(b.y);
    const fade = 1 - age;
    if (b.kind === 'bloom') {
      const r = short * b.size * (calm ? 0.6 : 0.25 + 0.75 * Math.sqrt(age));
      const fill = g.createRadialGradient(x, y, 0, x, y, r);
      fill.addColorStop(0, `hsla(${b.hue}, 85%, 62%, ${b.alpha * fade})`);
      fill.addColorStop(1, `hsla(${b.hue}, 85%, 62%, 0)`);
      g.fillStyle = fill;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
      return;
    }
    const tone = (a: number) => `hsla(${b.hue}, ${b.sat}%, ${b.light}%, ${a})`;
    if (b.kind === 'ripple') {
      // Flatter the further out on the water, as rings on a river are seen from its bank.
      const flat = 0.16 + 0.22 * Math.min(1, (HORIZON - b.y) / HORIZON);
      for (const lag of [0, 0.22]) {
        const a = age - lag;
        if (a <= 0) continue;
        const rx = short * b.size * (calm ? 0.8 : 0.15 + 1.1 * Math.sqrt(a));
        g.strokeStyle = tone(b.alpha * (1 - a) ** 1.6 * (lag ? 0.55 : 1));
        g.lineWidth = Math.max(1, 1.1 * scale);
        g.beginPath();
        g.ellipse(x, y, rx, rx * flat, 0, 0, Math.PI * 2);
        g.stroke();
      }
      const glow = g.createRadialGradient(x, y, 0, x, y, short * b.size * 0.6);
      glow.addColorStop(0, tone(0.22 * fade));
      glow.addColorStop(1, tone(0));
      g.fillStyle = glow;
      g.beginPath();
      g.ellipse(x, y, short * b.size * 0.6, short * b.size * 0.6 * flat, 0, 0, Math.PI * 2);
      g.fill();
      return;
    }
    if (b.kind === 'glow') {
      // A note in the sky: a soft, pale bloom, opening as it fades.
      const r = short * b.size * (calm ? 0.8 : 0.35 + 0.65 * Math.sqrt(age));
      const fill = g.createRadialGradient(x, y, 0, x, y, r);
      fill.addColorStop(0, tone(b.alpha * fade));
      fill.addColorStop(1, tone(0));
      g.fillStyle = fill;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
      return;
    }
    // Mist: a held chord lies along the far shore as a band of haze.
    const w = W() * 0.9;
    const my = py(HORIZON + 0.02);
    const band = g.createRadialGradient(x, my, 0, x, my, w / 2);
    band.addColorStop(0, `rgba(255, 255, 255, ${b.alpha * Math.sin(Math.PI * age)})`);
    band.addColorStop(1, 'rgba(255, 255, 255, 0)');
    g.fillStyle = band;
    g.beginPath();
    g.ellipse(x, my, w / 2, short * 0.05, 0, 0, Math.PI * 2);
    g.fill();
  }

  function draw(now: number) {
    g.clearRect(0, 0, canvas.width, canvas.height);
    if (scene === 'lake') lakeBackdrop(now);
    const short = Math.min(canvas.width, canvas.height);
    for (let i = blooms.length - 1; i >= 0; i -= 1) {
      const b = blooms[i]!;
      const age = (now - b.born) / b.life;
      if (age >= 1) {
        blooms.splice(i, 1);
        continue;
      }
      if (age < 0) continue;
      drawNote(b, age, short);
    }
    if (finger?.active) {
      const x = px(finger.x);
      const y = py(finger.y);
      g.fillStyle = 'rgba(32, 34, 31, 0.18)';
      g.beginPath();
      g.arc(x, y, 6 * scale, 0, Math.PI * 2);
      g.fill();
    }
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);

  return {
    /** Which picture to draw (scenes.ts); also tells the page's colours via `body[data-scene]`. */
    scene(id: SceneId) {
      scene = id;
      document.body.dataset['scene'] = id;
    },
    /** Share of the longest performance played so far, 0…1. */
    progress(p: number) {
      progress = p;
    },
    /** Where the finger is drawn now: the live finger, or the replayed one. */
    cursor(f: Cursor | null) {
      finger = f;
    },
    /** Drop everything scheduled, e.g. when a replay is stopped. */
    clear() {
      blooms.length = 0;
    },
    /** `delayMs`: how far in the future the note sounds, so the light opens with it. */
    note(e: NoteEvent, delayMs: number) {
      if (e.voice === 'lead') melodyPan = e.pan;
      // Where the note was played (carried by the event, so a replay draws the
      // same light); harmony opens beside the melody, on its side of the field.
      const x = Math.min(1, Math.max(0, e.x + (e.voice === 'harmony' ? (e.pan - melodyPan) * 0.12 : 0)));
      const born = performance.now() + delayMs;
      const seed = e.t * 0.37 + e.pitch * 13.1 + x * 101;
      if (scene === 'lake') {
        const tone = lakeTone(e.pitch);
        const kind: Kind = e.voice === 'pad' ? 'mist' : splashFor(e.y);
        blooms.push({
          kind, x, y: e.y, born, seed, ...tone,
          life: kind === 'mist' ? 3200 : kind === 'ripple' ? 1800 + e.velocity * 900 : 1100 + e.velocity * 700,
          size: (kind === 'ripple' ? 0.05 + e.velocity * 0.09 : 0.06 + e.velocity * 0.08) * (1 + e.width * 0.5),
          alpha: kind === 'mist' ? 0.35 : kind === 'ripple' ? 0.6 : 0.4,
        });
      } else {
        blooms.push({
          kind: 'bloom', x, y: e.y, born, seed, sat: 85, light: 62,
          life: e.voice === 'pad' ? 2400 : 900 + e.velocity * 700,
          // The light widens with the sound field.
          size: (e.voice === 'pad' ? 0.9 : 0.08 + e.velocity * 0.14) * (1 + e.width * 0.8),
          hue: hueFor(e.pitch),
          alpha: e.voice === 'pad' ? 0.06 : 0.55,
        });
      }
      if (blooms.length > 160) blooms.splice(0, blooms.length - 160);
    },
  };
}
