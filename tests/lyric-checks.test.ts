/**
 * The automatic lyric checks (scripts/lib/lyric-checks.mjs) catch what they
 * are named for, and pass what they should.
 */
import { describe, expect, it } from 'vitest';
import { checkLyrics, lyricLanguage } from '../scripts/lib/lyric-checks.mjs';

type Check = { check: string; ok: boolean; detail: string };
const ok = (checks: Check[], name: string) => checks.find((c) => c.check === name)?.ok;
const lines = (n: number, s: string) => Array.from({ length: n }, (_, i) => `${s}${i}`.replace(/\d/g, (d) => '零一二三四五六七八九'[Number(d)]!)).join('\n');

describe('lyric checks', () => {
  const brief = { lang: 'zh', durationSeconds: 60, prompt: '夜班' };

  it('passes a song of the right size with a chorus that returns', () => {
    const song = `[verse]\n${lines(5, '路灯')}\n[chorus]\n${lines(4, '回家')}\n[verse]\n${lines(3, '风')}\n[chorus]\n${lines(4, '回家')}`;
    const c = checkLyrics(brief, song) as Check[];
    expect(c.filter((x) => !x.ok)).toEqual([]);
  });

  it('fails twice the lines the song has room for', () => {
    const song = `[verse]\n${lines(20, '路灯')}\n[chorus]\n${lines(8, '回家')}\n[chorus]\n${lines(2, '回家')}`;
    expect(ok(checkLyrics(brief, song), 'length')).toBe(false);
  });

  it('fails digits, and Latin letters the creator did not write', () => {
    const song = '[verse]\n第1次见面\n在KTV门口\n[chorus]\n回家\n[chorus]\n回家';
    const c = checkLyrics(brief, song) as Check[];
    expect(ok(c, 'no digits')).toBe(false);
    expect(ok(c, 'no Latin letters')).toBe(false);
    expect(ok(checkLyrics({ ...brief, prompt: '在KTV' }, song), 'no Latin letters')).toBe(true);
  });

  it('fails a chorus that never comes back', () => {
    const song = `[verse]\n${lines(6, '路灯')}\n[chorus]\n${lines(6, '回家')}`;
    expect(ok(checkLyrics(brief, song), 'hook returns')).toBe(false);
  });

  it('tells the three languages apart', () => {
    expect(lyricLanguage('雨の駅で')).toBe('ja');
    expect(lyricLanguage('雨天的车站')).toBe('zh');
    expect(lyricLanguage('rainy station')).toBe('en');
  });
});
