import { sectionName } from '@yuha/contracts';
import type { LyricTimings } from '@yuha/contracts';
import type { AlignmentProvider, AlignmentRequest, AlignmentResult } from './types.js';


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
    const SECTION_GAP_SECONDS = 2;

    let section = '';
    const entries: Array<{ section: string; text: string; weight: number }> = [];
    for (const raw of req.lyrics.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const marker = sectionName(line);
      if (marker !== null) {
        section = marker;
        continue;
      }
      entries.push({ section, text: line, weight: weight(line) });
    }
    if (!entries.length) return { status: 'failed', reason: 'no lyric lines' };

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
    const gaps = entries.map((e, i) =>
      i > 0 && e.section && e.section !== entries[i - 1]!.section ? SECTION_GAP_SECONDS : 0,
    );
    const gapTotal = gaps.reduce((a: number, b: number) => a + b, 0);
    const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0);
    // The gaps come out of the same budget, so they cannot push the last line
    // past the end of the song; a lyric-dense short song keeps most of it.
    const singable = Math.max(1, req.durationSeconds - leadIn - tailOut - gapTotal);

    let t = leadIn;
    const lines: LyricTimings['lines'] = entries.map((e, i) => {
      t += gaps[i]!;
      const span = (singable * e.weight) / totalWeight;
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
