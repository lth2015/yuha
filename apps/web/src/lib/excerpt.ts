/**
 * The excerpt a song video is made from (video plan 2026-11-28, §一).
 *
 * One choice per video: heard before it is made (the song page plays it from
 * its start and stops at its end), then handed to the photo MV and the cover
 * video alike, so what was auditioned is what the MP4 carries. The server is
 * told the same start and duration; nothing else picks a window.
 */
import type { TimedLine } from './share-art';

/** The share preset: short enough for a post, long enough for a chorus. */
export const SHARE_SECONDS = 30;
/** Begin a breath before the chorus, so it is arrived at rather than cut into. */
const LEAD_IN = 1.5;
/** Where an instrumental's excerpt is centred: past the intro, before the close. */
const MIDDLE = 0.45;
export const NUDGE_SECONDS = 5;

const CHORUS = /chorus|hook|refrain|副歌|高潮|サビ/i;

export interface Excerpt {
  start: number;
  duration: number;
  /** Why it starts there: shown beside it, so the person knows what was chosen for them. */
  why: 'saved' | 'chorus' | 'middle' | 'chosen';
}

const round = (n: number) => Math.round(n * 10) / 10;

function fit(start: number, duration: number, songSeconds: number): number {
  return round(Math.min(Math.max(0, start), Math.max(0, songSeconds - duration)));
}

/**
 * Where to start. A start the person confirmed before wins; then a breath
 * before the first chorus the timeline trusts (the `lines` given are the
 * trusted ones — an unsure chorus is not one to aim at); else the middle.
 */
export function recommendExcerpt(lines: TimedLine[], songSeconds: number, seconds: number, saved?: number | null): Excerpt {
  const duration = round(Math.max(3, Math.min(seconds, songSeconds)));
  if (typeof saved === 'number' && Number.isFinite(saved)) {
    return { start: fit(saved, duration, songSeconds), duration, why: 'saved' };
  }
  const chorus = lines.find((l) => CHORUS.test(l.section));
  if (chorus) return { start: fit(chorus.start - LEAD_IN, duration, songSeconds), duration, why: 'chorus' };
  return { start: fit(songSeconds * MIDDLE - duration / 2, duration, songSeconds), duration, why: 'middle' };
}

export function nudgeExcerpt(excerpt: Excerpt, seconds: number, songSeconds: number): Excerpt {
  return { ...excerpt, start: fit(excerpt.start + seconds, excerpt.duration, songSeconds), why: 'chosen' };
}

/**
 * A new length. An excerpt chosen for the person is chosen again (a minute
 * from the chorus is not thirty seconds from it, moved); one they moved or
 * kept keeps its start, refitted inside the song.
 */
export function resizeExcerpt(excerpt: Excerpt, seconds: number, songSeconds: number, lines: TimedLine[]): Excerpt {
  if (excerpt.why === 'chorus' || excerpt.why === 'middle') return recommendExcerpt(lines, songSeconds, seconds);
  const duration = round(Math.max(3, Math.min(seconds, songSeconds)));
  return { ...excerpt, duration, start: fit(excerpt.start, duration, songSeconds) };
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function excerptLabel(excerpt: Excerpt): string {
  return `${clock(excerpt.start)}–${clock(excerpt.start + excerpt.duration)}`;
}

/*
 * The start a person settled on, per song, on this device: so the excerpt is
 * still theirs after a sign-up detour or a reload. A number, nothing else.
 */
const KEY = (trackId: string) => `yuha.excerpt.${trackId}`;

export function savedExcerptStart(trackId: string): number | null {
  try {
    const raw = localStorage.getItem(KEY(trackId));
    const n = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

export function saveExcerptStart(trackId: string, start: number): void {
  try {
    localStorage.setItem(KEY(trackId), String(start));
  } catch {
    /* private browsing: the choice simply is not remembered */
  }
}
