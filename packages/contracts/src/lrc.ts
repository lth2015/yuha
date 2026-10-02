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

/** `mm:ss.xx`, centiseconds, as the format specifies. Never negative. */
function stamp(seconds: number): string {
  const total = Math.max(0, seconds);
  const minutes = Math.floor(total / 60);
  const rest = total - minutes * 60;
  const whole = Math.floor(rest);
  const cs = Math.round((rest - whole) * 100);
  // Rounding 59.999 up must carry into the minute rather than print ":60.00".
  const [s, m] = cs === 100 ? [whole + 1, minutes] : [whole, minutes];
  const carried = s === 60 ? [0, m + 1] : [s, m];
  return `${String(carried[1]).padStart(2, '0')}:${String(carried[0]).padStart(2, '0')}.${String(
    cs === 100 ? 0 : cs,
  ).padStart(2, '0')}`;
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

  for (const line of timings.lines) {
    const head = `[${stamp(line.start)}]`;
    if (line.words?.length) {
      // Word tags carry their own times; the line keeps its leading timestamp
      // so a plain player still shows it at the right moment.
      const body = line.words.map((w) => `<${stamp(w.start)}>${w.w}`).join(' ');
      out.push(`${head}${body}`);
    } else {
      out.push(`${head}${line.text}`);
    }
  }

  // A final timestamp with no text is how LRC says "the words stop here";
  // without it a player holds the last line lit until the audio ends.
  const last = timings.lines[timings.lines.length - 1];
  if (last) out.push(`[${stamp(last.end)}]`);

  return out.join('\n') + '\n';
}

/** A filename that survives a download folder: no separators, no surprises. */
export function lrcFileName(title: string | null | undefined): string {
  const base = (title ?? '').trim().replace(/[\\/:*?"<>|\n\r\t]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return `${base || 'lyrics'}.lrc`;
}
