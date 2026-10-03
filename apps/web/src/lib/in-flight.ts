/**
 * One run of an action at a time, decided synchronously.
 *
 * `disabled={busy}` where `busy` is React state is not enough by itself: the
 * flag does not apply until the next render, so two presses inside one frame
 * both read it as false and both go. A ref decides at the moment of the press.
 *
 * Written because the full-screen player's download had no guard of any kind —
 * no `disabled`, no change of label — and the action ends in
 * `window.location.href = …`, which inside an overlay changes nothing on
 * screen. The press looked like it had done nothing, so it was pressed again,
 * and the song came down several times.
 *
 * Pair it with a `busy` state for the label and the `disabled` attribute: this
 * is the correctness half, and that is the half the reader can see.
 */
export interface InFlightGuard {
  /** True if this caller may proceed; false if one is already running. */
  begin(): boolean;
  /** Always call this, including after a failure — see `runOnce`. */
  end(): void;
  busy(): boolean;
}

export function createInFlightGuard(): InFlightGuard {
  let running = false;
  return {
    begin() {
      if (running) return false;
      running = true;
      return true;
    },
    end() {
      running = false;
    },
    busy() {
      return running;
    },
  };
}

/**
 * How long to let something run before admitting it is taking a moment.
 *
 * Measured, not guessed: the export round trip is 12ms against a local API, so
 * a pending label shown immediately swapped and swapped back inside a frame
 * and read as a glitch. A flicker is worse than silence. On a real connection
 * the same call is slow enough that the reader pressed the button again, which
 * is the problem this whole file exists for — so the state has to appear, just
 * not instantly.
 */
export const PENDING_AFTER_MS = 200;

/**
 * Whether a pending state should be visible.
 *
 * `elapsedMs` is null while the work is still running; a number is how long it
 * took. Separate from the guard on purpose: the guard blocks a second press
 * from the first millisecond whatever is on screen, and this only decides what
 * the reader is told.
 */
export function shouldShowPending(elapsedMs: number | null, afterMs = PENDING_AFTER_MS): boolean {
  if (elapsedMs === null) return true;
  return elapsedMs >= afterMs && afterMs > 0;
}
