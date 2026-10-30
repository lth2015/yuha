/**
 * What a probe song is checked for without a person (docs/quality/PROBE_RUNBOOK.md).
 *
 * The rest — a missing word, no voice, noise, an ending cut off — needs ears,
 * and the run sheet asks for them. These are the facts the API states.
 */

/** The lines a person would sing: not blank, not a `[Section]` marker. */
export function sungLines(lyrics) {
  return lyrics
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^\[[^\]]*\]$/.test(l));
}

/**
 * @param probe {{ lyrics: string }}
 * @param asked number — seconds asked for
 * @param track {{ durationSeconds: number, lyricTimings: null | { source: string, aligner: string, lines: Array<{ text: string, start: number, end: number }> } }}
 * @returns Array<{ check: string, ok: boolean, detail: string }>
 */
export function checkProbe(probe, asked, track) {
  const lines = sungLines(probe.lyrics);
  const t = track.lyricTimings;
  const timed = t?.lines ?? [];
  const checks = [];
  checks.push({
    check: 'length',
    ok: track.durationSeconds >= asked * 0.9,
    detail: `${track.durationSeconds}s of ${asked}s asked`,
  });
  checks.push({
    check: 'aligned',
    ok: t?.source === 'aligned' || t?.source === 'corrected',
    detail: t ? `${t.source} (${t.aligner})` : 'no timeline',
  });
  checks.push({
    check: 'every line timed',
    ok: timed.length === lines.length && lines.every((l, i) => timed[i]?.text.trim() === l),
    detail: `${timed.length} timed of ${lines.length} sung`,
  });
  const inside = timed.filter((l) => l.end > l.start && l.end <= track.durationSeconds + 0.5);
  checks.push({
    check: 'timeline inside the song',
    ok: timed.length > 0 && inside.length === timed.length,
    detail: `${inside.length}/${timed.length} lines start before they end, within ${track.durationSeconds}s`,
  });
  const ordered = timed.every((l, i) => i === 0 || l.start >= timed[i - 1].start);
  checks.push({ check: 'lines in order', ok: timed.length > 0 && ordered, detail: ordered ? 'yes' : 'a line starts before the one above it' });
  return checks;
}
