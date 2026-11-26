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
import { seasonOfOccasion, type Dedication, type Season } from '@yuha/contracts';
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

/**
 * A holiday song's pictures carry its season (docs/HOLIDAY_SPEC.md): a little
 * snow for Christmas; for New Year, a nengajo's thin vermilion frame and its
 * sun. Kept to the edges, so nothing that is read sits under it.
 */
async function drawHolidayTrim(
  ctx: CanvasRenderingContext2D,
  season: Season,
  shape: 'card' | 'video',
  box: { x: number; y: number; w: number; h: number },
): Promise<void> {
  /*
   * Codex's trims (apps/web/public/holiday, PR #90) are drawn for the whole
   * picture — 1200×630 or 720×1280 — and are transparent wherever this file
   * puts words. So they go over the full canvas at their own size: squeezed
   * into the card's right-hand panel, as the drawn trim below is, they would
   * be half as wide and out of place. The drawn trim stays as the fallback
   * when the image cannot be loaded.
   */
  const file = `/holiday/${shape === 'video' ? 'video-' : ''}${season === 'xmas' ? 'xmas' : 'newyear'}.png`;
  const art = await loadImage(file);
  if (art) {
    ctx.drawImage(art, 0, 0, ctx.canvas.width, ctx.canvas.height);
    return;
  }
  ctx.save();
  if (season === 'xmas') {
    for (let i = 0; i < 26; i += 1) {
      const x = box.x + ((i * 97) % box.w);
      const y = box.y + ((i * 53) % Math.round(box.h * 0.22));
      const r = 3 + (i % 4);
      ctx.fillStyle = i % 3 === 0 ? 'rgba(185, 201, 222, 0.9)' : 'rgba(255, 255, 255, 0.92)';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    ctx.strokeStyle = '#c8372a';
    ctx.lineWidth = 3;
    ctx.strokeRect(box.x + 18, box.y + 18, box.w - 36, box.h - 36);
    ctx.fillStyle = '#d7402b';
    ctx.beginPath();
    ctx.arc(box.x + box.w - 78, box.y + 78, 30, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
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
  const season = seasonOfOccasion(song.dedication?.occasion);
  if (season) await drawHolidayTrim(ctx, season, 'card', { x: CARD_HEIGHT, y: 0, w: CARD_WIDTH - CARD_HEIGHT, h: CARD_HEIGHT });

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
function clipWindow(lines: TimedLine[], songSeconds: number, seconds: number): { start: number; duration: number } {
  const chorus = lines.find((l) => CHORUS.test(l.section));
  const anchor = chorus ?? lines[0];
  let start = anchor ? Math.max(0, anchor.start - 1.5) : songSeconds * 0.25;
  // As long as asked (or the whole song), moved back to fit rather than cut
  // short: a chorus near the end used to give a minute's request twenty seconds.
  const duration = Math.max(3, Math.min(seconds, songSeconds));
  if (start + duration > songSeconds) start = Math.max(0, songSeconds - duration);
  return { start, duration };
}

export function planShareClip(lines: TimedLine[], songSeconds: number, maxFrames = 24, seconds = CLIP_SECONDS): ClipPlan {
  const { start, duration } = clipWindow(lines, songSeconds, seconds);
  const end = start + duration;

  /*
   * A frame wherever a line starts or ends, carrying the line sung at that
   * moment or none. Only starts used to make frames, so a line stayed on the
   * screen across the gap after it — and, with unsure lines left out by the
   * shared timing rule, across those too: the video showed a line nobody was
   * singing (Codex review, PR #157). The photo video already took a line off
   * when it ended; now both do.
   */
  const at = (t: number) => lines.find((l) => l.start <= t && l.end > t)?.text ?? null;
  const times = new Set<number>([0]);
  for (const l of lines) {
    for (const edge of [l.start, l.end]) {
      if (edge > start && edge < end - 0.5) times.add(Number((edge - start).toFixed(2)));
    }
  }
  const frames: ClipPlan['frames'] = [];
  for (const t of [...times].sort((a, b) => a - b)) {
    if (frames.length >= maxFrames) break;
    const line = at(start + t);
    if (frames.length && frames[frames.length - 1]!.line === line) continue;
    frames.push({ at: t, line });
  }
  return { start: Number(start.toFixed(2)), duration: Number(duration.toFixed(2)), frames };
}

const PHOTO_CLIP_SECONDS = 30;
/** What the server takes (apps/api/src/routes/share.ts, photo-video). */
const PHOTO_MAX_FRAMES = 200;
/** Longer than this on one photo and a long video becomes a slideshow of three stills. */
const PHOTO_MAX_HOLD = 8;
const ENDING_SECONDS = 2;

export interface PhotoClipPlan {
  start: number;
  duration: number;
  /**
   * From each moment: which photo (by the order chosen) and which line, if one
   * is being sung. The last frame of a clip long enough has `ending`: the
   * closing two seconds (Codex's end frame, PR #96).
   */
  frames: Array<{ at: number; photo: number; line: string | null; ending?: true }>;
}

/**
 * The photo video's timeline (docs/PHOTO_MV_SPEC.md): the same thirty seconds
 * the share video would choose, the photos sharing it out evenly in the order
 * picked, and a new frame wherever the photo or the sung line changes. A line
 * leaves the screen when it ends rather than hanging over the next photo.
 */
export function planPhotoClip(lines: TimedLine[], songSeconds: number, photos: number, seconds = PHOTO_CLIP_SECONDS): PhotoClipPlan {
  const { start, duration } = clipWindow(lines, songSeconds, seconds);
  const end = start + duration;
  const count = Math.max(1, photos);
  // Each photo once in a short clip; in a long one they take turns, so none
  // holds the screen for long (a minute of three photos was twenty seconds each).
  const slots = duration <= PHOTO_CLIP_SECONDS ? count : Math.max(count, Math.ceil(duration / PHOTO_MAX_HOLD));
  const slot = duration / slots;
  const round = (n: number) => Number(n.toFixed(2));
  const cuts = new Set<number>([0]);
  for (let i = 1; i < slots; i += 1) cuts.add(round(i * slot));
  for (const l of lines) {
    if (l.end <= start || l.start >= end) continue;
    if (l.start > start) cuts.add(round(l.start - start));
    if (l.end < end) cuts.add(round(l.end - start));
  }
  const times = [...cuts].filter((t) => t < duration - 0.25).sort((a, b) => a - b);
  const frames: PhotoClipPlan['frames'] = times.map((at) => {
    const t = start + at;
    const sung = lines.find((l) => l.start <= t + 0.001 && l.end > t + 0.001);
    return { at, photo: Math.min(slots - 1, Math.floor((at + 0.001) / slot)) % count, line: sung?.text ?? null };
  });
  // Every photo keeps its cut; lyric cuts give way first when there are too many.
  while (frames.length > PHOTO_MAX_FRAMES) {
    const i = frames.findIndex((f, k) => k > 0 && f.photo === frames[k - 1]!.photo);
    if (i < 0) break;
    frames.splice(i, 1);
  }
  // The closing two seconds: the last photo, the end frame and the logo, nothing sung.
  if (duration >= 8) {
    const endAt = round(duration - ENDING_SECONDS);
    const kept = frames.filter((f) => f.at < endAt);
    kept.push({ at: endAt, photo: (slots - 1) % count, line: null, ending: true });
    return { start: round(start), duration: round(duration), frames: kept };
  }
  return { start: round(start), duration: round(duration), frames };
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
  const season = seasonOfOccasion(song.dedication?.occasion);
  if (season) await drawHolidayTrim(ctx, season, 'video', { x: 0, y: 0, w: VIDEO_WIDTH, h: VIDEO_HEIGHT });

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

/**
 * One frame of the photo video (docs/PHOTO_MV_SPEC.md): the photo filling the
 * frame, cropped to the middle, darkened toward the foot so white type holds
 * on any picture; the song's title and the line being sung below, the
 * waveform band left clear for the server.
 */
export async function drawPhotoFrame(
  song: ShareSong,
  labels: ShareLabels,
  photo: HTMLCanvasElement,
  line: string | null,
  ending = false,
): Promise<HTMLCanvasElement> {
  await fontsReady(`${song.title}${line ?? ''}`, labels.lang);
  const canvas = document.createElement('canvas');
  canvas.width = VIDEO_WIDTH;
  canvas.height = VIDEO_HEIGHT;
  const ctx = canvas.getContext('2d')!;
  const family = fontFamily(labels.lang);

  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
  const scale = Math.max(VIDEO_WIDTH / photo.width, VIDEO_HEIGHT / photo.height);
  const w = photo.width * scale;
  const h = photo.height * scale;
  ctx.drawImage(photo, (VIDEO_WIDTH - w) / 2, (VIDEO_HEIGHT - h) / 2, w, h);

  const top = ctx.createLinearGradient(0, 0, 0, 180);
  top.addColorStop(0, 'rgba(0,0,0,0.38)');
  top.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, VIDEO_WIDTH, 180);
  const foot = ctx.createLinearGradient(0, VIDEO_HEIGHT * 0.5, 0, VIDEO_HEIGHT);
  foot.addColorStop(0, 'rgba(0,0,0,0)');
  foot.addColorStop(0.45, 'rgba(0,0,0,0.42)');
  foot.addColorStop(1, 'rgba(0,0,0,0.72)');
  ctx.fillStyle = foot;
  ctx.fillRect(0, VIDEO_HEIGHT * 0.5, VIDEO_WIDTH, VIDEO_HEIGHT * 0.5);

  const logo = await loadImage('/brand/yuha-logo-reverse.svg');
  if (ending) {
    /*
     * The closing frame: the photo dimmed so the white logo holds on any
     * picture (the end frame itself is only a faint border and grain, and
     * says so), Codex's frame over it, the logo in the middle.
     */
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.fillRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
    const border = await loadImage('/photo/photo-mv-end.png');
    if (border) ctx.drawImage(border, 0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
    if (logo) ctx.drawImage(logo, (VIDEO_WIDTH - 264) / 2, (VIDEO_HEIGHT - 80) / 2 - 40, 264, 80);
  } else if (logo) {
    ctx.drawImage(logo, 40, 44, 99, 30);
  }

  const left = 56;
  const width = VIDEO_WIDTH - left * 2;
  ctx.textBaseline = 'alphabetic';
  if (line && !ending) {
    ctx.font = `700 40px ${family}`;
    ctx.fillStyle = '#ffffff';
    const lines = wrapText(ctx, line, width, 2);
    let ly = WAVE_TOP - 40 - (lines.length - 1) * 52;
    for (const l of lines) {
      ctx.fillText(l, left, ly);
      ly += 52;
    }
  }
  ctx.fillStyle = 'rgba(255,255,255,0.86)';
  ctx.font = `500 26px ${family}`;
  const title = labels.to ? `${labels.to} · ${song.title}` : song.title;
  ctx.fillText(wrapText(ctx, title, width, 1)[0] ?? '', left, WAVE_TOP + WAVE_HEIGHT + 46);
  ctx.fillStyle = 'rgba(255,255,255,0.62)';
  ctx.font = `400 22px ${family}`;
  ctx.fillText(labels.site, left, WAVE_TOP + WAVE_HEIGHT + 84);
  return canvas;
}

/**
 * A chosen photo, decoded once, turned upright by its own orientation tag and
 * scaled to at most 1440 px on its long side: ten full-size phone photos held
 * as bitmaps would be most of a phone's memory. Null when the browser cannot
 * read it (HEIC outside Safari, a broken file).
 */
export async function loadPhoto(file: Blob): Promise<HTMLCanvasElement | null> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, 1440 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas;
  } catch {
    return null;
  }
}

/** JPEG base64 of a frame, for POST /v1/tracks/:id/share-video. */
export async function frameJpeg(canvas: HTMLCanvasElement, quality = 0.86): Promise<string> {
  const blob = await toBlob(canvas, 'image/jpeg', quality);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
