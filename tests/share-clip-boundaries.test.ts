/**
 * The share video never shows a line while it is not being sung
 * (apps/web/src/lib/share-art.ts, planShareClip; Codex review of PR #157).
 *
 * Checked the way the renderer reads a plan: from each frame's time on, its
 * line is on screen until the next frame. Every millisecond of the clip is
 * asked "is what is shown being sung now?". Fractional edges (rounding) and a
 * clip with more changes than the server's frame budget are where it broke.
 */
import { describe, expect, it } from 'vitest';
import { planShareClip, type ClipPlan, type TimedLine } from '../apps/web/src/lib/share-art';

const line = (text: string, start: number, end: number): TimedLine => ({ text, section: 'Verse', start, end });

function shownAt(plan: ClipPlan, songSeconds: number): string | null {
  let shown: string | null = null;
  for (const f of plan.frames) if (plan.start + f.at <= songSeconds + 1e-9) shown = f.line;
  return shown;
}

/** Every millisecond: whatever is on screen is being sung then. */
function neverShownUnsung(plan: ClipPlan, lines: TimedLine[]): void {
  for (let ms = 0; ms < plan.duration * 1000; ms += 1) {
    const t = plan.start + ms / 1000;
    const shown = shownAt(plan, t);
    if (shown === null) continue;
    const sung = lines.some((l) => l.text === shown && l.start <= t + 1e-9 && l.end > t + 1e-9);
    if (!sung) throw new Error(`"${shown}" on screen at ${t.toFixed(3)} s, not sung then`);
  }
}

describe('the share video plan', () => {
  it('decides a line at its exact edges, not at the rounded frame time (Codex, PR #157)', () => {
    const lines = [line('one', 2.123, 4.123), line('three', 12.127, 15.127)];
    const plan = planShareClip(lines, 30, 200, 20);
    expect(shownAt(plan, 13)).toBe('three');
    expect(shownAt(plan, 17)).toBeNull();
    expect(shownAt(plan, 3)).toBe('one');
    expect(shownAt(plan, 5)).toBeNull();
    neverShownUnsung(plan, lines);
  });

  it('holds for edges that fall between frame times, and for lines that touch', () => {
    const lines = [
      line('a', 1.004, 2.996),
      line('b', 2.996, 3.001), // five milliseconds, against the next line
      line('c', 3.001, 4.5049),
      line('d', 4.5051, 6.0),
      line('e', 7.3333, 9.6667),
    ];
    const plan = planShareClip(lines, 30, 200, 20);
    neverShownUnsung(plan, lines);
    expect(shownAt(plan, 8)).toBe('e');
    expect(shownAt(plan, 10)).toBeNull();
  });

  it('ends on a blank when there are more changes than frames, rather than hold the last line (Codex, PR #157)', () => {
    const lines = Array.from({ length: 110 }, (_, i) => line(`line${i}`, 2 + i * 1.125, 2 + i * 1.125 + 0.5));
    const plan = planShareClip(lines, 180, 200, 120);
    expect(plan.frames.length).toBeLessThanOrEqual(200);
    expect(plan.frames[plan.frames.length - 1]!.line).toBeNull();
    expect(shownAt(plan, 114)).toBeNull();
    neverShownUnsung(plan, lines);
  });

  it('holds for random fractional timelines at any budget', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let run = 0; run < 40; run += 1) {
      const lines: TimedLine[] = [];
      let t = rand() * 3;
      for (let i = 0; i < 30; i += 1) {
        const start = t + (rand() < 0.4 ? 0 : rand() * 2);
        const end = start + 0.01 + rand() * 3;
        lines.push(line(`l${run}-${i}`, Number(start.toFixed(4)), Number(end.toFixed(4))));
        t = end;
      }
      const plan = planShareClip(lines, 120, 2 + Math.floor(rand() * 60), 60);
      expect(plan.frames.length).toBeLessThanOrEqual(62);
      neverShownUnsung(plan, lines);
    }
  });
});
