/**
 * What written lyrics are checked for without a person (docs/LYRICS_MODEL.md).
 *
 * Each check is something that goes wrong in a sung, aligned song: digits and
 * Latin abbreviations are where the aligner loses its place, a missing or
 * unrepeated chorus is a song with no hook, and lyrics far longer or shorter
 * than the song are rushed or padded by the singer. Whether the words are any
 * good needs a reader; the report leaves room for one.
 */
import { sungLines } from './probe-checks.mjs';

export function lyricLanguage(text) {
  if (/[぀-ヿ]/.test(text)) return 'ja';
  if (/[一-鿿]/.test(text)) return 'zh';
  return 'en';
}

/**
 * @param brief {{ lang: string, durationSeconds: number, prompt: string }}
 * @param lyrics string
 * @param secondsPerLine number
 */
export function checkLyrics(brief, lyrics, secondsPerLine = 4.5) {
  const lines = sungLines(lyrics);
  const tags = (lyrics.match(/^\s*\[([^\]]+)\]\s*$/gm) ?? []).map((t) => t.trim().slice(1, -1).toLowerCase());
  const target = brief.durationSeconds / secondsPerLine;
  const checks = [];
  checks.push({ check: 'language', ok: lyricLanguage(lines.join('\n')) === brief.lang, detail: lyricLanguage(lines.join('\n')) });
  checks.push({
    check: 'length',
    ok: lines.length >= target * 0.6 && lines.length <= target * 1.6,
    detail: `${lines.length} lines for ~${Math.round(target)}`,
  });
  checks.push({ check: 'sections', ok: tags.includes('verse') && (brief.durationSeconds < 60 || tags.includes('chorus')), detail: tags.join(' ') || 'none' });
  const choruses = tags.filter((t) => t === 'chorus').length;
  const repeated = lines.length !== new Set(lines).size;
  checks.push({ check: 'hook returns', ok: choruses >= 2 || repeated, detail: `${choruses} chorus tag(s)${repeated ? ', repeated lines' : ''}` });
  const digits = lines.filter((l) => /[0-9０-９]/.test(l));
  checks.push({ check: 'no digits', ok: digits.length === 0, detail: digits.length ? digits.slice(0, 2).join(' / ') : 'none' });
  if (brief.lang !== 'en') {
    const latin = lines.filter((l) => /[A-Za-z]{2,}/.test(l));
    const asked = /[A-Za-z]{2,}/.test(brief.prompt);
    checks.push({ check: 'no Latin letters', ok: asked || latin.length === 0, detail: latin.length ? latin.slice(0, 2).join(' / ') : 'none' });
  }
  return checks;
}
