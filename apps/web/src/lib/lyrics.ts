/**
 * Synced-lyrics timing engine.
 *
 * Real word-level timing would have to come from the vocal model; ours does
 * not provide it yet. What we can do honestly — and what reads beautifully —
 * is weight each lyric line by its sung length (vowel clusters as a syllable
 * proxy, sections as pauses) and lay the lines across the song's duration.
 * The result syncs well enough for karaoke display and is deterministic.
 */
import { sectionName } from '@yuha/contracts';

export interface LyricLine {
  /** Section marker ([Verse] etc.) this line belongs to. */
  section: string;
  text: string;
  /** Seconds from song start. */
  start: number;
  end: number;
  /** Per-word (CJK: per-character) timing, when an aligner heard the vocal. */
  words?: Array<{ w: string; start: number; end: number }>;
}

/** Rough syllable proxy: groups of vowels, plus a floor so short lines still breathe. */
function weight(text: string): number {
  const syl = (text.toLowerCase().match(/[aeiouyäöüéèáàíóúú]+/g) ?? []).length;
  // CJK: no spaces between words — count characters more directly.
  const cjk = (text.match(/[\u3040-\u30ff\u4e00-\u9fff\u3005\u3006]/g) ?? []).length;
  return Math.max(2, syl + cjk * 0.6);
}

/**
 * Builds a time axis for the lyrics. `durationSeconds` is the audio length;
 * `leadIn`/`tailOut` keep the first/last lines from slamming against the edges.
 */
export function buildLyricTimeline(
  lyrics: string,
  durationSeconds: number,
  opts: { leadIn?: number; tailOut?: number } = {},
): { lines: LyricLine[]; sections: string[] } {
  const leadIn = opts.leadIn ?? Math.min(3, durationSeconds * 0.08);
  const tailOut = opts.tailOut ?? Math.min(4, durationSeconds * 0.1);

  const raw = lyrics.split(/\r?\n/);
  let section = '';
  const entries: Array<{ section: string; text: string; weight: number }> = [];
  for (const line of raw) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const marker = sectionName(trimmed);
    if (marker !== null) {
      section = marker;
      continue;
    }
    entries.push({ section, text: trimmed, weight: weight(trimmed) });
  }
  if (!entries.length) return { lines: [], sections: [] };

/*
   * Section gaps are silence BEFORE the line, not extra length ON it.
   *
   * This read `span = singable * (weight + pause) / totalWeight`, which does not
   * insert a gap anywhere: the first line of a new section started at the exact
   * instant the previous line ended, and was merely held on screen longer. The
   * comment above it said sections "get a pause before they start", and nothing
   * in the code did that.
   *
   * Both reported symptoms come out of this. Nothing pauses over an interlude,
   * because there is no gap in the timeline to pause in — the lyrics walk
   * straight through the instrumental between a verse and a chorus. And the
   * inflated line is highlighted for longer than it is sung, so from the first
   * section change onwards the highlight sits behind the voice, and the error
   * accumulates with every section after it.
   *
   * SECTION_GAP_SECONDS is a guess and is marked as one. A real interlude is
   * somewhere between zero and ten seconds and this estimator has never heard
   * the audio — knowing where the singing actually stops is the whole job of
   * the aligner. Two seconds is enough to read as a pause without stalling a
   * song that does not have one.
   */
  const SECTION_GAP_SECONDS = 2;
  const gaps = entries.map((e, i) => (i > 0 && e.section && e.section !== entries[i - 1]!.section ? SECTION_GAP_SECONDS : 0));
  const gapTotal = gaps.reduce((a: number, b: number) => a + b, 0);

  const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0);
  const singable = Math.max(1, durationSeconds - leadIn - tailOut - gapTotal);

  let t = leadIn;
  const lines: LyricLine[] = entries.map((e, i) => {
    t += gaps[i]!;
    const span = (singable * e.weight) / totalWeight;
    const line: LyricLine = { section: e.section, text: e.text, start: t, end: t + span };
    t += span;
    return line;
  });

  const sections = [...new Set(lines.map((l) => l.section).filter(Boolean))];
  return { lines, sections };
}

/** The line active at `seconds`; -1 before the first line. */
export function activeLineIndex(lines: LyricLine[], seconds: number): number {
  for (let i = 0; i < lines.length; i += 1) {
    if (seconds < lines[i]!.start) return i - 1;
    if (seconds >= lines[i]!.start && seconds < lines[i]!.end) return i;
  }
  return lines.length - 1;
}

/** Progress within the active line, 0..1 — drives the karaoke fill. */
export function lineProgress(lines: LyricLine[], index: number, seconds: number): number {
  const line = lines[index];
  if (!line) return 0;
  // Aligned: fill by sung characters, weighting each word by its length, so a
  // held syllable holds the fill and a rushed phrase races it.
  if (line.words?.length) {
    const total = line.words.reduce((n, w) => n + Math.max(1, [...w.w].length), 0);
    let done = 0;
    for (const w of line.words) {
      const len = Math.max(1, [...w.w].length);
      if (seconds >= w.end) done += len;
      else if (seconds > w.start) done += (len * (seconds - w.start)) / Math.max(0.001, w.end - w.start);
      else break;
    }
    return Math.min(1, Math.max(0, done / total));
  }
  const span = Math.max(0.001, line.end - line.start);
  return Math.min(1, Math.max(0, (seconds - line.start) / span));
}
