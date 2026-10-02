/**
 * The .lrc a song can be downloaded as.
 *
 * It is written from exactly the timings the player highlights against, which
 * is the point: a file whose timestamps differ from what is on screen would
 * be a third opinion about when a line is sung, and there are already two.
 *
 * What it does NOT do is make the timings right. If they came from the
 * estimator they are still a guess, and the file says so in its own header —
 * which is most of why it is worth having. "The sync is off" becomes a line
 * number with a number beside it.
 *
 * No database: a pure function.
 */
import { describe, expect, it } from 'vitest';
import { lrcFileName, toLrc, type LyricTimings } from '@yuha/contracts';

const timings = (over: Partial<LyricTimings> = {}): LyricTimings => ({
  source: 'estimated',
  aligner: 'estimated-v1',
  lines: [
    { text: 'city lights', section: 'verse', start: 3, end: 7.5 },
    { text: 'blur into gold', section: 'verse', start: 7.5, end: 12.25 },
  ],
  ...over,
});

describe('the lrc it writes', () => {
  it('stamps every line in mm:ss.xx', () => {
    const out = toLrc(timings());
    expect(out).toContain('[00:03.00]city lights');
    expect(out).toContain('[00:07.50]blur into gold');
  });

  it('records which kind of timing produced it', () => {
    // A file that leaves the product should carry whether its numbers were
    // heard or guessed; a reader that does not know the tag skips it.
    expect(toLrc(timings())).toContain('[ve:estimated]');
    expect(toLrc(timings({ source: 'aligned', aligner: 'whisper' }))).toContain('[ve:aligned]');
  });

  it('closes with the end of the last line, so nothing stays lit', () => {
    expect(toLrc(timings()).trimEnd().split('\n').pop()).toBe('[00:12.25]');
  });

  it('writes word tags only when the aligner heard words', () => {
    const plain = toLrc(timings());
    expect(plain).not.toContain('<');

    const worded = toLrc(
      timings({
        source: 'aligned',
        aligner: 'whisper',
        lines: [
          {
            text: 'city lights',
            section: 'verse',
            start: 3,
            end: 7.5,
            words: [
              { w: 'city', start: 3, end: 3.8 },
              { w: 'lights', start: 3.9, end: 7.5 },
            ],
          },
        ],
      }),
    );
    expect(worded).toContain('[00:03.00]<00:03.00>city <00:03.90>lights');
  });

  it('carries the title, artist and length when given them', () => {
    const out = toLrc(timings(), { title: '西厢寻他', artist: '<redacted: operator name>', durationSeconds: 239 });
    expect(out).toContain('[ti:西厢寻他]');
    expect(out).toContain('[ar:<redacted: operator name>]');
    expect(out).toContain('[length:03:59]');
  });

  it('never prints a sixtieth second', () => {
    // 59.999 rounds up, and ":60.00" is not a time.
    const out = toLrc(timings({ lines: [{ text: 'a', section: '', start: 59.999, end: 61 }] }));
    expect(out).toContain('[01:00.00]a');
    expect(out).not.toMatch(/:60\./);
  });

  it('makes a filename a download folder will accept', () => {
    expect(lrcFileName('西厢寻他')).toBe('西厢寻他.lrc');
    expect(lrcFileName('a/b:c*d')).toBe('a b c d.lrc');
    expect(lrcFileName('   ')).toBe('lyrics.lrc');
    expect(lrcFileName(null)).toBe('lyrics.lrc');
  });
});
