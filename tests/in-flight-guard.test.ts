/**
 * Pressing download twice downloaded the song twice.
 *
 * In the full-screen Now Playing view the button had no busy state at all: no
 * `disabled`, no change of label, and the action ends in
 * `window.location.href = …`, which in an overlay changes nothing on screen.
 * So the press produced no response for the whole round trip — creating the
 * export, signing the url — and the obvious thing to do was press again. The
 * same action on the song page underneath was already guarded by `disabled`,
 * which is the tell: one call site was protected and the other was not.
 *
 * `disabled={busy}` would not have been enough on its own either. `setBusy` is
 * React state and does not apply until the next render, so two presses inside
 * one frame both read `busy === false` and both go. The guard has to be
 * synchronous, which is what a ref is for — and that is this.
 */
import { describe, expect, it } from 'vitest';
import { createInFlightGuard, PENDING_AFTER_MS, shouldShowPending } from '../apps/web/src/lib/in-flight.js';

describe('running an action at most once at a time', () => {
  it('lets the first caller through', () => {
    expect(createInFlightGuard().begin()).toBe(true);
  });

  it('turns away everyone else until it ends', () => {
    const guard = createInFlightGuard();
    expect(guard.begin()).toBe(true);
    expect(guard.begin()).toBe(false);
    expect(guard.begin()).toBe(false);
    guard.end();
    expect(guard.begin()).toBe(true);
  });

  it('refuses a second caller in the same tick, which React state cannot', () => {
    // The actual failure: two presses inside one frame. A `busy` flag in state
    // is still false for both, because the re-render has not happened.
    const guard = createInFlightGuard();
    const admitted = [guard.begin(), guard.begin(), guard.begin()].filter(Boolean);
    expect(admitted).toHaveLength(1);
  });

  it('is released even when the action threw', () => {
    // A failed export must leave the button usable; otherwise one network
    // blip disables download for the rest of the session.
    const guard = createInFlightGuard();
    guard.begin();
    try {
      throw new Error('export failed');
    } catch {
      guard.end();
    }
    expect(guard.begin()).toBe(true);
  });

  it('reports whether something is running, for the label', () => {
    const guard = createInFlightGuard();
    expect(guard.busy()).toBe(false);
    guard.begin();
    expect(guard.busy()).toBe(true);
    guard.end();
    expect(guard.busy()).toBe(false);
  });

  it('keeps separate actions separate', () => {
    // Downloading must not disable deleting.
    const a = createInFlightGuard();
    const b = createInFlightGuard();
    a.begin();
    expect(b.begin()).toBe(true);
  });
});

/**
 * Showing "preparing…" for one frame is worse than showing nothing.
 *
 * Measured after the first fix landed: the export round trip is 12ms against a
 * local API, so the label swapped and swapped back inside a frame and read as
 * a glitch. On a real connection the same call is slow enough to matter, which
 * is the case the reader complained about. Both have to be right, so the
 * pending state waits a moment before it appears and does not appear at all if
 * the work finished first.
 *
 * The guard above is separate and unconditional: it blocks the second press
 * from the very first millisecond, whatever is on screen.
 */
describe('when to admit that something is taking a moment', () => {
  it('says nothing for work that finishes quickly', () => {
    expect(shouldShowPending(12, 200)).toBe(false);
    expect(shouldShowPending(199, 200)).toBe(false);
  });

  it('shows the pending state once the wait is noticeable', () => {
    expect(shouldShowPending(200, 200)).toBe(true);
    expect(shouldShowPending(1500, 200)).toBe(true);
  });

  it('treats work that has not finished as still waiting', () => {
    // `null` is "no end yet": the caller is mid-flight.
    expect(shouldShowPending(null, 200)).toBe(true);
  });

  it('never shows it for zero-length work', () => {
    expect(shouldShowPending(0, 200)).toBe(false);
  });
});
