/**
 * `formatJst` is named for, and the admin console labels its output as,
 * Japan time (「统计区间（日本时间）」). It formatted in the browser's own zone
 * instead, so a console opened anywhere but Japan — or a UTC test browser —
 * showed every timestamp nine hours off under a label promising JST.
 */
import { describe, expect, it } from 'vitest';
import { formatJst } from '../apps/web/src/lib/session.js';

describe('formatJst', () => {
  it('shows Japan time whatever zone the browser is in', () => {
    expect(formatJst('2026-10-28T10:41:00Z')).toContain('19:41');
    // Crossing midnight moves the date too.
    expect(formatJst('2026-10-28T20:00:00Z', false)).toContain('29');
  });
});
