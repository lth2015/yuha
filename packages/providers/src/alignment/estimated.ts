import type { LyricTimings } from '@yuha/contracts';
import type { AlignmentProvider, AlignmentRequest, AlignmentResult } from './types.js';

const SECTION_RE = /^\s*[[(](?:verse|chorus|bridge|intro|outro|pre-?chorus|hook|refrain|interlude|instrumental)[^)\]]*[)\]]\s*$/i;

/** Vowel clusters as a syllable proxy; CJK characters weigh by count. */
function weight(text: string): number {
  const syl = (text.toLowerCase().match(/[aeiouyäöüéèáàíóú]+/g) ?? []).length;
  const cjk = (text.match(/[\u3040-\u30ff\u4e00-\u9fff\u3005\u3006]/g) ?? []).length;
  return Math.max(2, syl + cjk * 0.6);
}

/**
 * Deterministic estimator: line timings weighted by sung length, sections
 * get a pause, first/last lines breathe at the edges.
 *
 * This is NOT alignment — nothing listened to the audio. It exists so synced
 * lyrics work before a real model is wired in, and every row it produces is
 * labelled `estimated` so the interface can say so.
 */
export class EstimatedAlignmentProvider implements AlignmentProvider {
  readonly kind = 'estimated-v1';

  async align(req: AlignmentRequest): Promise<AlignmentResult> {
    const leadIn = Math.min(3, req.durationSeconds * 0.08);
    const tailOut = Math.min(4, req.durationSeconds * 0.1);
    const SECTION_PAUSE = 0.6;

    let section = '';
    const entries: Array<{ section: string; text: string; weight: number }> = [];
    for (const raw of req.lyrics.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (SECTION_RE.test(line)) {
        section = line.replace(/^[[(]\s*|\s*[)\]]$/g, '');
        continue;
      }
      entries.push({ section, text: line, weight: weight(line) });
    }
    if (!entries.length) return { status: 'failed', reason: 'no lyric lines' };

    const pauses = entries.map((e, i) =>
      i > 0 && e.section && e.section !== entries[i - 1]!.section ? SECTION_PAUSE : 0,
    );
    const totalWeight = entries.reduce((sum, e, i) => sum + e.weight + pauses[i]!, 0);
    const singable = Math.max(1, req.durationSeconds - leadIn - tailOut);

    let t = leadIn;
    const lines: LyricTimings['lines'] = entries.map((e, i) => {
      const span = (singable * (e.weight + pauses[i]!)) / totalWeight;
      const line = { text: e.text, section: e.section, start: Number(t.toFixed(3)), end: Number((t + span).toFixed(3)) };
      t += span;
      return line;
    });

    return {
      status: 'ok',
      timings: { source: 'estimated', lines, aligner: this.kind },
    };
  }
}
