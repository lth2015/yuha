/**
 * Lyric section markers: which lines are structure, and which get sung.
 *
 * The old rule recognised nine English words and nothing else. A creator
 * writing `[rap]`, `[高潮部分]` or `[間奏]` did not get a section — they got a
 * lyric. The marker was laid out on the time axis as a line to be sung, shown
 * to the listener as part of the song, and handed to the music model as words
 * to sing. Nothing warned; the song simply had something in it that nobody
 * wrote.
 *
 * Two separate jobs are pinned here. What the creator sees keeps their own
 * wording, because `[高潮部分]` is what they typed and what they should read
 * back. What the model is sent is the English tag, because that is the
 * vocabulary it was prompted with.
 *
 * No database: pure functions and one timeline.
 */
import { describe, expect, it } from 'vitest';
import { canonicalSectionTag, sectionName, withCanonicalSections } from '@yuha/contracts';
import { EstimatedAlignmentProvider } from '@yuha/providers';

describe('what counts as a marker', () => {
  it('takes any line that is nothing but a square-bracketed token', () => {
    expect(sectionName('[rap]')).toBe('rap');
    expect(sectionName('[高潮部分]')).toBe('高潮部分');
    expect(sectionName('  [ Verse 2 ]  ')).toBe('Verse 2');
    // Unrecognised, but still unmistakably structure rather than singing.
    expect(sectionName('[自由发挥]')).toBe('自由发挥');
  });

  it('leaves backing vocals alone', () => {
    // Round brackets are how backing vocals are written. Treating them as
    // structure would delete a sung line, which is worse than missing a
    // marker — so they count only when the name is one we know.
    expect(sectionName('(ooh ooh la la)')).toBeNull();
    expect(sectionName('(chorus)')).toBe('chorus');
  });

  it('does not touch a line that merely contains brackets', () => {
    expect(sectionName('I called you [twice] last night')).toBeNull();
    expect(sectionName('')).toBeNull();
  });
});

describe('what the music model is told', () => {
  it('translates a marker written in the creator\'s language', () => {
    expect(canonicalSectionTag('副歌')).toBe('chorus');
    expect(canonicalSectionTag('高潮部分')).toBe('chorus');
    expect(canonicalSectionTag('中间节奏')).toBe('interlude');
    expect(canonicalSectionTag('サビ')).toBe('chorus');
    expect(canonicalSectionTag('说唱')).toBe('rap');
  });

  it('ignores the number on a numbered section', () => {
    expect(canonicalSectionTag('Verse 2')).toBe('verse');
    expect(canonicalSectionTag('主歌1')).toBe('verse');
  });

  it('does not mistake a pre-chorus for a chorus', () => {
    expect(canonicalSectionTag('pre-chorus')).toBe('pre-chorus');
    expect(canonicalSectionTag('预副歌')).toBe('pre-chorus');
  });

  it('rewrites only the markers, leaving every sung line byte for byte', () => {
    const written = ['[主歌]', '城市的灯光融成金色', '', '[高潮部分]', '我还在等你'].join('\n');
    expect(withCanonicalSections(written)).toBe(
      ['[verse]', '城市的灯光融成金色', '', '[chorus]', '我还在等你'].join('\n'),
    );
  });

  it('passes an unrecognised marker through rather than guessing', () => {
    expect(withCanonicalSections('[自由发挥]\nla la la')).toBe('[自由发挥]\nla la la');
  });
});

describe('the timeline it produces', () => {
  const align = (lyrics: string) =>
    new EstimatedAlignmentProvider().align({ lyrics, durationSeconds: 60, providerRequestId: 'test' });

  it('never sings a marker', async () => {
    const res = await align(['[rap]', 'one two three four', '[间奏]', 'five six seven eight'].join('\n'));
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    const texts = res.timings.lines.map((l) => l.text);
    expect(texts).toEqual(['one two three four', 'five six seven eight']);
  });

  it('keeps the creator\'s own wording on the line it labels', async () => {
    const res = await align(['[高潮部分]', 'one two three four'].join('\n'));
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.timings.lines[0]!.section).toBe('高潮部分');
  });

  it('opens a real gap at a section it did not used to recognise', async () => {
    const res = await align(['[主歌]', 'one two three four', '[副歌]', 'five six seven eight'].join('\n'));
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    const [first, second] = res.timings.lines;
    expect(second!.start).toBeGreaterThan(first!.end);
  });
});
