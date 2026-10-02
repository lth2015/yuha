/**
 * The cap has to agree with the counter, and both have to agree with the
 * contract. `maxLength` did not: it counts UTF-16 code units while everything
 * else counts code points, so an emoji spends two of one budget and one of the
 * other. Caught by scripts/check-codepoint-limits.mjs; these pin the helper
 * that replaced it.
 */
import { describe, expect, it } from 'vitest';
import { clampToCodePoints, codePointLength } from '../apps/web/src/lib/codepoints.js';

describe('counting and cutting in code points', () => {
  it('counts an astral character once, the way the contract does', () => {
    expect(codePointLength('🎵')).toBe(1);
    expect('🎵'.length).toBe(2); // what maxLength would have charged
    expect(codePointLength('雨上がりの放課後')).toBe(8);
    expect(codePointLength('')).toBe(0);
  });

  it('leaves anything inside the limit exactly as it was', () => {
    expect(clampToCodePoints('雨上がり', 8)).toBe('雨上がり');
    expect(clampToCodePoints('🎵🎵', 2)).toBe('🎵🎵');
    expect(clampToCodePoints('', 5)).toBe('');
  });

  it('cuts at the limit counted in code points, not in units', () => {
    // Ten emoji are 20 UTF-16 units. A limit of 10 keeps all ten.
    const ten = '🎵'.repeat(10);
    expect(clampToCodePoints(ten, 10)).toBe(ten);
    expect(clampToCodePoints(ten, 4)).toBe('🎵'.repeat(4));
  });

  it('never cuts through the middle of a character', () => {
    // `'🎵🎵'.slice(0, 3)` ends mid-pair and renders as a replacement
    // character: a field that corrupts what was typed into it is worse than
    // one that accepts too much.
    const cut = clampToCodePoints('🎵🎵🎵', 2);
    expect(cut).toBe('🎵🎵');
    expect(cut).not.toContain('�');
    expect([...cut].every((c) => c.codePointAt(0)! > 0xffff)).toBe(true);
  });
});
