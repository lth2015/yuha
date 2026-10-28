/**
 * Pictures of a song, for posting it (docs/GIFT_AND_SHARE_SPEC.md).
 *
 * Drawn here rather than on the server because this is where the song's look
 * lives: the sleeve colours (lib/sleeve.ts), its score (lib/score.ts) and the
 * fonts the page already loaded for Chinese and Japanese. The server has none
 * of those, and a link preview in the wrong typeface with tofu for every
 * character is worse than none.
 *
 * Two shapes from the same parts: the 1200×630 card that X, Facebook and LINE
 * show under a link, and the 720×1280 frames a share video is cut from.
 */
import type { Dedication } from '@yuha/contracts';
import { scoreFromSeed } from './score';
import { sleeveColors } from './sleeve';
import { NO_LINE_START } from './line-break';

export interface ShareSong {
  title: string;
  coverSeed: number;
  styles: string[];
  dedication: Dedication | null;
}

/** Words the pictures need, already in the reader's language. */
export interface ShareLabels {
  /** "写给 小林" — present only for a song written for somebody. */
  to?: string;
  /** "生日快乐" — the occasion said as a line, when it has one. */
  occasion?: string;
  /** Under a song for nobody in particular: its styles, say. */
  detail?: string;
  site: string;
  /** The reader's language: Chinese text is set in a Chinese face first (see fontFamily). */
  lang?: 'zh' | 'ja' | 'en';
}

const INK = '#20221f';
const MUTED = '#6b6d66';
const PAPER = '#f6f5f0';
const PETAL = '#F46B45';

/*
 * The page's stack leads with M PLUS 2, which carries Japanese kanji but not
 * simplified Chinese: in 谢谢你那年夏天, 谢 falls back to another face while
 * 那年夏天 stays in M PLUS 2, and on a picture the two weights sit side by
 * side in one line. For Chinese, the platform's Chinese faces come first.
 */
const CHINESE_FACES = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", "Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Zen Hei"';

function fontFamily(lang?: ShareLabels['lang']): string {
  const page = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
  return lang === 'zh' ? `${CHINESE_FACES}, ${page}` : page;
}

/** The page's fonts, loaded at the weights the pictures use, before anything is measured. */
async function fontsReady(sample: string, lang?: ShareLabels['lang']): Promise<void> {
  const family = fontFamily(lang);
  try {
    await Promise.all([
      document.fonts.load(`700 48px ${family}`, sample),
      document.fonts.load(`400 24px ${family}`, sample),
    ]);
    await document.fonts.ready;
  } catch {
    /* draw with whatever is there */
  }
}

/** The sleeve: its lit field and its score in white, as the library shows it. */
function drawSleeve(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  song: Pick<ShareSong, 'coverSeed' | 'styles'>,
  head?: number,
): void {
  const { lit, body, edge, x: lx, y: ly } = sleeveColors(song.coverSeed, song.styles);
  const cx = x + (w * lx) / 100;
  const cy = y + (h * ly) / 100;
  const r = Math.hypot(w, h) * 1.05;
  const field = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  field.addColorStop(0, lit);
  field.addColorStop(0.6, body);
  field.addColorStop(1, edge);
  ctx.fillStyle = field;
  ctx.fillRect(x, y, w, h);

  const { notes } = scoreFromSeed(song.coverSeed, 52);
  const bandTop = y + h * 0.24;
  const bandH = h * 0.52;
  const baseline = bandTop + bandH * 0.62;
  const span = bandH * 0.52;
  const mirror = (bandTop + bandH - baseline) * 0.82;
  const left = x + w * 0.08;
  const width = w * 0.84;
  const headX = head === undefined ? undefined : left + head * width;
  const scale = w / 420;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = Math.max(1, scale);
  ctx.beginPath();
  ctx.moveTo(left, baseline);
  ctx.lineTo(left + width, baseline);
  ctx.stroke();
  for (const n of notes) {
    if (n.rest) continue;
    const nx = left + n.x * width;
    const near = headX === undefined ? 0 : Math.max(0, 1 - Math.abs(nx - headX) / (width * 0.14));
    const top = baseline - span * n.pitch * (1 + near * 0.4);
    const alpha = Math.min(1, 0.4 + n.weight * 0.3 + near * 0.35);
    ctx.lineWidth = (1.5 + n.weight * 1.6 + near * 1.8) * scale;
    ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
    ctx.beginPath();
    ctx.moveTo(nx, baseline);
    ctx.lineTo(nx, top);
    ctx.stroke();
    ctx.strokeStyle = `rgba(255,255,255,${alpha * 0.3})`;
    ctx.beginPath();
    ctx.moveTo(nx, baseline);
    ctx.lineTo(nx, baseline + mirror * n.pitch);
    ctx.stroke();
  }
  if (headX !== undefined) {
    const reach = span * 1.1;
    const glow = ctx.createRadialGradient(headX, baseline, 0, headX, baseline, reach);
    glow.addColorStop(0, 'rgba(255,238,228,0.45)');
    glow.addColorStop(0.45, 'rgba(255,210,190,0.14)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = glow;
    ctx.fillRect(headX - reach, baseline - reach, reach * 2, reach * 2);
  }
  ctx.restore();
}

/**
 * Lines of `text` that fit `maxWidth`, at most `maxLines`, the last one cut
 * with an ellipsis. Breaks between words where there are spaces, and between
 * characters where there are none — Chinese and Japanese are written without.
 */

export function wrapText(ctx: Pick<CanvasRenderingContext2D, 'measureText'>, text: string, maxWidth: number, maxLines: number): string[] {
  const tokens = text.includes(' ') ? text.split(/(\s+)/) : [...text];
  const lines: string[] = [];
  let line = '';
  for (const tok of tokens) {
    const next = line + tok;
    if (ctx.measureText(next).width <= maxWidth || !line || NO_LINE_START.has(tok)) {
      line = next;
      continue;
    }
    lines.push(line.trimEnd());
    line = tok.trimStart();
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line.trimEnd());
  const used = lines.join('').replace(/\s+/g, '').length;
  if (used < text.replace(/\s+/g, '').length && lines.length) {
    let last = lines[lines.length - 1]!;
    while (last && ctx.measureText(`${last}…`).width > maxWidth) last = [...last].slice(0, -1).join('');
    lines[lines.length - 1] = `${last}…`;
  }
  return lines;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not draw'))), type, quality),
  );
}

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

/** The link-preview card: sleeve on the left, who and what on the right. */
async function drawShareCard(song: ShareSong, labels: ShareLabels): Promise<HTMLCanvasElement> {
  await fontsReady(`${song.title}${labels.to ?? ''}${labels.occasion ?? ''}${song.dedication?.note ?? ''}`, labels.lang);
  const canvas = document.createElement('canvas');
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const ctx = canvas.getContext('2d')!;
  const family = fontFamily(labels.lang);

  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  drawSleeve(ctx, 0, 0, CARD_HEIGHT, CARD_HEIGHT, song);

  const left = CARD_HEIGHT + 64;
  const width = CARD_WIDTH - left - 64;
  const logo = await loadImage('/brand/yuha-logo.svg');
  if (logo) ctx.drawImage(logo, left, 60, 115, 35);

  ctx.textBaseline = 'alphabetic';
  let y = 190;
  if (labels.to) {
    ctx.fillStyle = PETAL;
    ctx.font = `500 30px ${family}`;
    ctx.fillText(labels.to, left, y);
    y += 74;
    if (labels.occasion) {
      ctx.fillStyle = INK;
      ctx.font = `700 58px ${family}`;
      for (const l of wrapText(ctx, labels.occasion, width, 2)) {
        ctx.fillText(l, left, y);
        y += 70;
      }
    }
    ctx.fillStyle = INK;
    ctx.font = `500 34px ${family}`;
    for (const l of wrapText(ctx, `《${song.title}》`, width, 2)) {
      ctx.fillText(l, left, y);
      y += 46;
    }
    if (song.dedication?.note) {
      y += 10;
      ctx.fillStyle = MUTED;
      ctx.font = `400 26px ${family}`;
      for (const l of wrapText(ctx, song.dedication.note, width, 3)) {
        if (y > CARD_HEIGHT - 110) break;
        ctx.fillText(l, left, y);
        y += 38;
      }
    }
  } else {
    ctx.fillStyle = INK;
    ctx.font = `700 56px ${family}`;
    for (const l of wrapText(ctx, song.title, width, 3)) {
      ctx.fillText(l, left, y);
      y += 68;
    }
    if (labels.detail) {
      y += 8;
      ctx.fillStyle = MUTED;
      ctx.font = `400 28px ${family}`;
      for (const l of wrapText(ctx, labels.detail, width, 2)) {
        ctx.fillText(l, left, y);
        y += 40;
      }
    }
  }

  ctx.fillStyle = PETAL;
  ctx.fillRect(left, CARD_HEIGHT - 92, 40, 4);
  ctx.fillStyle = MUTED;
  ctx.font = `400 24px ${family}`;
  ctx.fillText(labels.site, left, CARD_HEIGHT - 52);
  return canvas;
}

/** The card as PNG bytes, base64, for PUT /v1/tracks/:id/share-card. */
export async function shareCardPng(song: ShareSong, labels: ShareLabels): Promise<string> {
  const blob = await toBlob(await drawShareCard(song, labels), 'image/png');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export const VIDEO_WIDTH = 720;
export const VIDEO_HEIGHT = 1280;
/** The band the server draws the waveform into (apps/api/src/services/share-video.ts). */
const WAVE_TOP = 1072;
const WAVE_HEIGHT = 96;

/** One sung line on a timeline, as SyncedLyrics has them. */
export interface TimedLine {
  text: string;
  section: string;
  start: number;
  end: number;
}

export interface ClipPlan {
  start: number;
  duration: number;
  /** What is on screen from each moment of the clip: the line being sung, or none. */
  frames: Array<{ at: number; line: string | null }>;
}

const CHORUS = /chorus|hook|refrain|副歌|高潮|サビ/i;
const CLIP_SECONDS = 20;

/**
 * Which twenty seconds to post. The chorus when the song has one marked — it
 * is the part people remember — else from just before the first sung line,
 * else (an instrumental) from a quarter of the way in, past the intro.
 */
export function planShareClip(lines: TimedLine[], songSeconds: number, maxFrames = 24): ClipPlan {
  const chorus = lines.find((l) => CHORUS.test(l.section));
  const anchor = chorus ?? lines[0];
  let start = anchor ? Math.max(0, anchor.start - 1.5) : songSeconds * 0.25;
  const duration = Math.max(3, Math.min(CLIP_SECONDS, songSeconds - start));
  if (start + duration > songSeconds) start = Math.max(0, songSeconds - duration);
  const end = start + duration;

  const frames: ClipPlan['frames'] = [];
  // Whatever is being sung as the clip opens is on the first frame.
  const opening = lines.find((l) => l.start <= start && l.end > start);
  frames.push({ at: 0, line: opening?.text ?? null });
  for (const l of lines) {
    if (l.start > start && l.start < end - 0.5 && frames.length < maxFrames) {
      frames.push({ at: Number((l.start - start).toFixed(2)), line: l.text });
    }
  }
  return { start: Number(start.toFixed(2)), duration: Number(duration.toFixed(2)), frames };
}

/** One frame of the share video: the sleeve above, who and what below, the line being sung. */
export async function drawVideoFrame(
  song: ShareSong,
  labels: ShareLabels,
  line: string | null,
  head: number,
): Promise<HTMLCanvasElement> {
  await fontsReady(`${song.title}${labels.to ?? ''}${line ?? ''}`, labels.lang);
  const canvas = document.createElement('canvas');
  canvas.width = VIDEO_WIDTH;
  canvas.height = VIDEO_HEIGHT;
  const ctx = canvas.getContext('2d')!;
  const family = fontFamily(labels.lang);
  const { body, edge } = sleeveColors(song.coverSeed, song.styles);

  // Below the sleeve the colour carries on, deepening, so the frame is one piece.
  const ground = ctx.createLinearGradient(0, VIDEO_WIDTH, 0, VIDEO_HEIGHT);
  ground.addColorStop(0, body);
  ground.addColorStop(1, edge);
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
  drawSleeve(ctx, 0, 0, VIDEO_WIDTH, VIDEO_WIDTH, song, head);
  // A scrim so white type holds on the lightest sleeve.
  const scrim = ctx.createLinearGradient(0, VIDEO_WIDTH - 200, 0, VIDEO_HEIGHT);
  scrim.addColorStop(0, 'rgba(0,0,0,0)');
  scrim.addColorStop(0.35, 'rgba(0,0,0,0.28)');
  scrim.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.fillStyle = scrim;
  ctx.fillRect(0, VIDEO_WIDTH - 200, VIDEO_WIDTH, VIDEO_HEIGHT);

  const logo = await loadImage('/brand/yuha-logo-reverse.svg');
  if (logo) ctx.drawImage(logo, 40, 44, 99, 30);

  const left = 56;
  const width = VIDEO_WIDTH - left * 2;
  let y = 800;
  ctx.textBaseline = 'alphabetic';
  if (labels.to) {
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.font = `500 30px ${family}`;
    ctx.fillText(labels.occasion ? `${labels.to} · ${labels.occasion}` : labels.to, left, y);
    y += 58;
  }
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 42px ${family}`;
  for (const l of wrapText(ctx, labels.to ? `《${song.title}》` : song.title, width, 2)) {
    ctx.fillText(l, left, y);
    y += 54;
  }
  if (line) {
    ctx.font = `700 38px ${family}`;
    ctx.fillStyle = '#ffffff';
    const lines = wrapText(ctx, line, width, 2);
    let ly = WAVE_TOP - 34 - (lines.length - 1) * 50;
    for (const l of lines) {
      ctx.fillText(l, left, ly);
      ly += 50;
    }
  }
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = `400 24px ${family}`;
  ctx.fillText(labels.site, left, WAVE_TOP + WAVE_HEIGHT + 64);
  return canvas;
}

/** JPEG base64 of a frame, for POST /v1/tracks/:id/share-video. */
export async function frameJpeg(canvas: HTMLCanvasElement): Promise<string> {
  const blob = await toBlob(canvas, 'image/jpeg', 0.86);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
