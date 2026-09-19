/**
 * Synced-lyrics timing engine.
 *
 * Real word-level timing would have to come from the vocal model; ours does
 * not provide it yet. What we can do honestly — and what reads beautifully —
 * is weight each lyric line by its sung length (vowel clusters as a syllable
 * proxy, sections as pauses) and lay the lines across the song's duration.
 * The result syncs well enough for karaoke display and is deterministic.
 */
export interface LyricLine {
  /** Section marker ([Verse] etc.) this line belongs to. */
  section: string;
  text: string;
  /** Seconds from song start. */
  start: number;
  end: number;
}

const SECTION_RE = /^\s*[[(](?:verse|chorus|bridge|intro|outro|pre-?chorus|hook|refrain|interlude|instrumental)[^)\]]*[)\]]\s*$/i;

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
    if (SECTION_RE.test(trimmed)) {
      section = trimmed.replace(/^[[(]\s*|\s*[)\]]$/g, '');
      continue;
    }
    entries.push({ section, text: trimmed, weight: weight(trimmed) });
  }
  if (!entries.length) return { lines: [], sections: [] };

  // Instrumental breathing room: sections get a short pause before they start.
  const SECTION_PAUSE = 0.6;
  const sectionSwitch = entries.map((e, i) => (i > 0 && e.section && e.section !== entries[i - 1]!.section ? SECTION_PAUSE : 0));

  const totalWeight = entries.reduce((sum, e, i) => sum + e.weight + sectionSwitch[i]!, 0);
  const singable = Math.max(1, durationSeconds - leadIn - tailOut);

  let t = leadIn;
  const lines: LyricLine[] = entries.map((e, i) => {
    const span = (singable * (e.weight + sectionSwitch[i]!)) / totalWeight;
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
  const span = Math.max(0.001, line.end - line.start);
  return Math.min(1, Math.max(0, (seconds - line.start) / span));
}
