/**
 * LRC: one timing format, from the timeline to the player to a file on disk.
 *
 * The lyric timings a song carries are already what the player highlights
 * against. Writing them out as LRC does not make them more accurate — the
 * timestamps are the same numbers either way, and if they came from the
 * estimator they are still a guess that never heard the audio. What it does
 * is make them *inspectable*: "the sync is off" stops being a feeling and
 * becomes a line number with a time next to it, which is the difference
 * between a bug report that can be acted on and one that cannot.
 *
 * It is also the format every other player already reads, so a song's words
 * can leave here and still be worth something.
 *
 * Two dialects are produced from one source. Plain LRC gives a timestamp per
 * line, which is all any player needs. When the aligner heard the vocal and
 * returned word segments, those are written too, in the `<mm:ss.xx>` form
 * (sometimes called A2 or enhanced LRC) that karaoke players understand and
 * everything else ignores. Nothing is invented: a song with no word timings
 * simply has no word tags.
 */
import type { LyricTimings } from './generation.js';

function centiseconds(seconds: number): number {
  return Math.max(0, Math.round(seconds * 100));
}

/** `mm:ss.xx` from an already rounded centisecond timestamp. */
function stamp(total: number): string {
  const minutes = Math.floor(total / 6000);
  const seconds = Math.floor(total / 100) % 60;
  const hundredths = total % 100;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
}

/** `mm:ss` — what the `[length:]` tag takes; centiseconds are not used there. */
function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export interface LrcMeta {
  title?: string | null;
  artist?: string | null;
  /** Audio length in seconds, written as the `[length:]` tag. */
  durationSeconds?: number | null;
}

/**
 * Renders timings as an LRC file.
 *
 * The `[re:]`/`[ve:]` tags carry which timing source produced this, because a
 * file that leaves the product should say whether its timestamps were heard
 * or estimated. A reader that does not understand them skips them, as the
 * format requires of unknown tags.
 */
export function toLrc(timings: LyricTimings, meta: LrcMeta = {}): string {
  const out: string[] = [];
  if (meta.title) out.push(`[ti:${meta.title}]`);
  if (meta.artist) out.push(`[ar:${meta.artist}]`);
  if (meta.durationSeconds && meta.durationSeconds > 0) out.push(`[length:${clock(meta.durationSeconds)}]`);
  out.push('[re:YUHA]');
  out.push(`[ve:${timings.source}]`);
  out.push('');

  // A cue that cannot occupy a centisecond would otherwise stay on screen
  // until the next cue (or the end of the audio).
  const lines = timings.lines.filter((line) => centiseconds(line.end) > centiseconds(line.start));
  for (const [index, line] of lines.entries()) {
    const start = centiseconds(line.start);
    const head = `[${stamp(start)}]`;
    if (line.words?.length) {
      // Word tags carry their own times; the line keeps its leading timestamp
      // so a plain player still shows it at the right moment.
      const body = line.words.map((w) => `<${stamp(centiseconds(w.start))}>${w.w}`).join(' ');
      out.push(`${head}${body}`);
    } else {
      out.push(`${head}${line.text}`);
    }
    // LRC displays the last event until another timestamp replaces it. Clear
    // a gap explicitly, but let a new line take over if its timestamp is
    // already at or before this end, including rounding to the same tick.
    const next = lines[index + 1];
    const end = centiseconds(line.end);
    if (!next || end < centiseconds(next.start)) out.push(`[${stamp(end)}]`);
  }

  return out.join('\n') + '\n';
}

/** A filename that survives a download folder: no separators, no surprises. */
export function lrcFileName(title: string | null | undefined): string {
  const base = (title ?? '').trim().replace(/[\\/:*?"<>|\n\r\t]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return `${base || 'lyrics'}.lrc`;
}
