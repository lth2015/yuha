/**
 * Pointer events → GestureFrame, one frame per animation frame while a finger
 * is down (so a resting finger still moves the music forward) and one more
 * when the last finger lifts. Height counts upward and distances are in
 * screen short-sides, so it reads the same on a phone and a monitor.
 *
 * The first finger plays; a second finger only sets `spread`. If the first
 * lifts while the second stays, the second carries on playing.
 *
 * The keyboard plays too, for anyone who cannot touch the screen (#34): with
 * the stage focused, holding Space or Enter is a finger down, and the arrow
 * keys move it, so key repeat reads as movement and plays like a finger.
 */
import type { GestureFrame } from '../engine/frame.ts';
import { nextOpenness, spreadFrom } from './gesture-math.ts';

/** Short-sides per second that counts as "as fast as it gets". */
const FAST = 1.6;
const SMOOTH_MS = 80;

type Point = { x: number; y: number };

export type Touch = {
  /** Milliseconds on the frames' clock, or null before the first touch. */
  time(): number | null;
  fingerDown(): boolean;
};

export function attachTouch(
  el: HTMLElement,
  handlers: { down(e: Event): void; frame(f: GestureFrame): void },
): Touch {
  let origin: number | null = null;
  /** Down fingers in arrival order; the first one plays. */
  const fingers = new Map<number, Point>();
  let prev: { x: number; y: number; t: number } | null = null;
  let speed = 0;
  let openness = 0;
  let raf = 0;

  const read = (e: PointerEvent): Point => {
    const r = el.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height)) };
  };

  const emit = (active: boolean) => {
    const now = performance.now();
    origin ??= now;
    const r = el.getBoundingClientRect();
    const short = Math.min(r.width, r.height) || 1;
    const [first, second] = [...fingers.values()];
    const pos = first ?? (prev ? { x: prev.x, y: prev.y } : { x: 0.5, y: 0.5 });
    const dt = prev ? now - prev.t : 0;
    if (prev && dt > 0) {
      const dx = ((pos.x - prev.x) * r.width) / short;
      const dy = ((pos.y - prev.y) * r.height) / short;
      const raw = Math.hypot(dx, dy) / (dt / 1000);
      speed += (Math.min(1, raw / FAST) - speed) * (1 - Math.exp(-dt / SMOOTH_MS));
    }
    openness = nextOpenness(openness, dt, speed, active);
    const distance = first && second ? Math.hypot(((first.x - second.x) * r.width) / short, ((first.y - second.y) * r.height) / short) : null;
    prev = { ...pos, t: now };
    handlers.frame({ t: now - origin, active, x: pos.x, y: pos.y, speed, openness, spread: spreadFrom(distance), confidence: 1, source: 'touch' });
  };

  const loop = () => {
    emit(true);
    raf = requestAnimationFrame(loop);
  };

  const press = (id: number, at: Point, e: Event) => {
    const starting = fingers.size === 0;
    fingers.set(id, at);
    if (!starting) return;
    prev = null;
    speed = 0;
    openness = 0;
    // Synchronously, inside the gesture: this is where audio is unlocked.
    handlers.down(e);
    emit(true);
    raf = requestAnimationFrame(loop);
  };

  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture?.(e.pointerId);
    press(e.pointerId, read(e), e);
  });
  el.addEventListener('pointermove', (e) => {
    if (fingers.has(e.pointerId)) fingers.set(e.pointerId, read(e));
  });
  const up = (e: { pointerId: number }) => {
    const wasPlaying = fingers.keys().next().value === e.pointerId;
    if (!fingers.delete(e.pointerId)) return;
    if (fingers.size > 0) {
      // The second finger takes over: start measuring from where it is, or the
      // jump between the two fingers would read as a burst of speed.
      if (wasPlaying) prev = { ...fingers.values().next().value!, t: performance.now() };
      return;
    }
    cancelAnimationFrame(raf);
    emit(false);
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  // Safari's own pinch gesture would zoom the page instead of playing.
  el.addEventListener('gesturestart', (e) => e.preventDefault());

  /* ---------- keyboard ---------- */

  const KEY = -1;
  const STEP = 0.04;
  const keyAt: Point = { x: 0.5, y: 0.5 };
  const MOVES: Record<string, [number, number]> = { ArrowUp: [0, STEP], ArrowDown: [0, -STEP], ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0] };
  el.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (!e.repeat && !fingers.has(KEY)) press(KEY, { ...keyAt }, e);
    } else if (e.key in MOVES) {
      e.preventDefault();
      const [dx, dy] = MOVES[e.key]!;
      keyAt.x = Math.min(1, Math.max(0, keyAt.x + dx));
      keyAt.y = Math.min(1, Math.max(0, keyAt.y + dy));
      if (fingers.has(KEY)) fingers.set(KEY, { ...keyAt });
    }
  });
  el.addEventListener('keyup', (e) => {
    if (e.key === ' ' || e.key === 'Enter') up({ pointerId: KEY });
  });
  el.addEventListener('blur', () => up({ pointerId: KEY }));

  return {
    time: () => (origin === null ? null : performance.now() - origin),
    fingerDown: () => fingers.size > 0,
  };
}
