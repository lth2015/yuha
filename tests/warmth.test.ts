/**
 * 温度 — the reading on a song's sleeve.
 *
 * It replaces `N°{random}`: three digits derived from the cover seed, which
 * looked like a catalogue number, could collide between two songs, and whose
 * first review from a real reader was the question "what does this mean?".
 * A label that invites that question has already failed.
 *
 * The scale is ours and measures nothing physical. What these pin is the part
 * that has to be true anyway: that the number comes from the song rather than
 * from a seed, that the same song always reads the same, and that a song
 * which has told us nothing gets no reading at all instead of a confident 50.
 *
 * No database: a pure function.
 */
import { describe, expect, it } from 'vitest';
import { songWarmth } from '@yuha/contracts';

describe('the reading', () => {
  it('is the same every time for the same song', () => {
    const song = { mood: 'warm', styles: ['acoustic', 'folk'], vocalMode: 'with_vocals' } as const;
    expect(songWarmth(song)).toBe(songWarmth(song));
  });

  it('puts a warm song above a cold one', () => {
    const warm = songWarmth({ mood: 'warm', styles: ['acoustic'], vocalMode: 'with_vocals' })!;
    const cold = songWarmth({ mood: 'tense', styles: ['trap'], vocalMode: 'instrumental' })!;
    expect(warm).toBeGreaterThan(cold);
  });

  it('uses the whole range rather than bunching near the middle', () => {
    // A reading that is always 45-55 tells nobody anything.
    const low = songWarmth({ mood: 'tense', styles: ['techno'], vocalMode: 'instrumental' })!;
    const high = songWarmth({ mood: 'warm', styles: ['soul'], vocalMode: 'with_vocals' })!;
    expect(low).toBeLessThan(25);
    expect(high).toBeGreaterThan(80);
  });

  it('stays inside 1..99 however extreme the song', () => {
    for (const mood of ['warm', 'tense'] as const) {
      for (const styles of [['soul', 'acoustic', 'folk'], ['trap', 'techno', 'metal']]) {
        for (const vocalMode of ['with_vocals', 'instrumental'] as const) {
          const n = songWarmth({ mood, styles, vocalMode })!;
          expect(n).toBeGreaterThanOrEqual(1);
          expect(n).toBeLessThanOrEqual(99);
          expect(Number.isInteger(n)).toBe(true);
        }
      }
    }
  });

  it('averages the styles rather than stacking them', () => {
    // Three warm tags describe one song more precisely; they do not make it
    // three times warmer, and summing would run every tagged song to 99.
    const one = songWarmth({ mood: 'calm', styles: ['soul'] })!;
    const three = songWarmth({ mood: 'calm', styles: ['soul', 'soul', 'soul'] })!;
    expect(three).toBe(one);
  });

  it('ignores a tag it does not know instead of hashing it', () => {
    // Hashing is how the old label came to mean nothing. Doing it again
    // behind a better name would be worse, not better.
    const known = songWarmth({ mood: 'calm', styles: ['jazz'] });
    const plus = songWarmth({ mood: 'calm', styles: ['jazz', '中国风', 'something nobody typed before'] });
    expect(plus).toBe(known);
  });

  it('reads nothing from a song that has said nothing', () => {
    expect(songWarmth({})).toBeNull();
    expect(songWarmth({ mood: null, styles: [] })).toBeNull();
    expect(songWarmth({ styles: ['完全自定义'] })).toBeNull();
  });

  it('still reads a song that has styles but no recorded mood', () => {
    expect(songWarmth({ mood: null, styles: ['jazz'] })).not.toBeNull();
  });

  it('does not care how a tag was capitalised or spaced', () => {
    expect(songWarmth({ mood: 'calm', styles: ['  Jazz '] })).toBe(songWarmth({ mood: 'calm', styles: ['jazz'] }));
  });

  it('lets a voice warm the song, a little', () => {
    const sung = songWarmth({ mood: 'calm', styles: ['pop'], vocalMode: 'with_vocals' })!;
    const not = songWarmth({ mood: 'calm', styles: ['pop'], vocalMode: 'instrumental' })!;
    expect(sung).toBeGreaterThan(not);
    expect(sung - not).toBeLessThan(12);
  });
});
