/**
 * The probe set and what is checked of each probe without a person
 * (docs/quality/PROBE_RUNBOOK.md).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createGenerationRequest, lyricsSchema } from '@yuha/contracts';
// @ts-expect-error — a plain .mjs module shared with the script
import { checkProbe, sungLines } from '../scripts/lib/probe-checks.mjs';

const set = JSON.parse(readFileSync(new URL('../docs/quality/probe-set.json', import.meta.url), 'utf8')) as {
  durationSeconds: number;
  probes: Array<{ id: string; lang: string; title: string; styles: string[]; voice: string; lyrics: string }>;
};

describe('the probe set', () => {
  it('is three languages, two songs each, with unique ids', () => {
    expect(new Set(set.probes.map((p) => p.id)).size).toBe(set.probes.length);
    for (const lang of ['zh', 'ja', 'en']) expect(set.probes.filter((p) => p.lang === lang)).toHaveLength(2);
  });

  it('is something the API accepts as it stands', () => {
    for (const p of set.probes) {
      expect(lyricsSchema.safeParse(p.lyrics).success, p.id).toBe(true);
      const req = createGenerationRequest.safeParse({
        mode: 'custom',
        title: p.title,
        prompt: `quality probe ${p.id}`,
        lyrics: p.lyrics,
        styles: p.styles,
        voice: p.voice,
        instrumental: false,
        durationSeconds: set.durationSeconds,
      });
      expect(req.success, `${p.id}: ${JSON.stringify(req.error?.issues)}`).toBe(true);
      expect(sungLines(p.lyrics).length).toBeGreaterThanOrEqual(8);
    }
  });
});

describe('a probe’s checks', () => {
  const probe = set.probes[0]!;
  const lines = sungLines(probe.lyrics) as string[];
  const timeline = (source: string) => ({
    source,
    aligner: 'mms_fa',
    lines: lines.map((text, i) => ({ text, start: i * 5, end: i * 5 + 4 })),
  });

  it('passes a whole, aligned song', () => {
    const checks = checkProbe(probe, 60, { durationSeconds: 60, lyricTimings: timeline('aligned') }) as Array<{ ok: boolean }>;
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it('fails a short song, an estimate, a missing line and a line past the end', () => {
    const fail = (track: unknown) =>
      (checkProbe(probe, 60, track) as Array<{ check: string; ok: boolean }>).filter((c) => !c.ok).map((c) => c.check);
    expect(fail({ durationSeconds: 30, lyricTimings: timeline('aligned') })).toContain('length');
    expect(fail({ durationSeconds: 60, lyricTimings: timeline('estimated') })).toEqual(['aligned']);
    const short = timeline('aligned');
    short.lines.pop();
    expect(fail({ durationSeconds: 60, lyricTimings: short })).toEqual(['every line timed']);
    const late = timeline('aligned');
    late.lines[late.lines.length - 1]!.end = 90;
    expect(fail({ durationSeconds: 60, lyricTimings: late })).toEqual(['timeline inside the song']);
    expect(fail({ durationSeconds: 60, lyricTimings: null })).toEqual(expect.arrayContaining(['aligned', 'every line timed']));
  });
});
