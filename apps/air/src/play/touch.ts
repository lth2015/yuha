/**
 * Pointer events → GestureFrame, one frame per animation frame while a finger
 * is down (so a resting finger still moves the music forward) and one more
 * when it lifts. Height counts upward and speed is measured in screen
 * short-sides per second, so it reads the same on a phone and a monitor.
 *
 * Openness and spread arrive with #29; until then they are 0 and null.
 */
import type { GestureFrame } from '../engine/frame.ts';

/** Short-sides per second that counts as "as fast as it gets". */
const FAST = 1.6;
const SMOOTH_MS = 80;

export function attachTouch(
  el: HTMLElement,
  handlers: { down(e: PointerEvent): void; frame(f: GestureFrame): void },
): void {
  let origin: number | null = null;
  let pointer: number | null = null;
  let pos = { x: 0.5, y: 0.5 };
  let prev: { x: number; y: number; t: number } | null = null;
  let speed = 0;
  let raf = 0;

  const read = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    pos = { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height)) };
  };

  const emit = (active: boolean) => {
    const now = performance.now();
    origin ??= now;
    const r = el.getBoundingClientRect();
    const short = Math.min(r.width, r.height) || 1;
    if (prev && now > prev.t) {
      const dx = ((pos.x - prev.x) * r.width) / short;
      const dy = ((pos.y - prev.y) * r.height) / short;
      const raw = Math.hypot(dx, dy) / ((now - prev.t) / 1000);
      speed += (Math.min(1, raw / FAST) - speed) * (1 - Math.exp(-(now - prev.t) / SMOOTH_MS));
    }
    prev = { ...pos, t: now };
    handlers.frame({ t: now - origin, active, x: pos.x, y: pos.y, speed, openness: 0, spread: null, confidence: 1, source: 'touch' });
  };

  const loop = () => {
    emit(true);
    raf = requestAnimationFrame(loop);
  };

  el.addEventListener('pointerdown', (e) => {
    if (pointer !== null) return;
    e.preventDefault();
    pointer = e.pointerId;
    el.setPointerCapture?.(e.pointerId);
    read(e);
    prev = null;
    speed = 0;
    // Synchronously, inside the gesture: this is where audio is unlocked.
    handlers.down(e);
    emit(true);
    raf = requestAnimationFrame(loop);
  });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerId === pointer) read(e);
  });
  const up = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return;
    pointer = null;
    cancelAnimationFrame(raf);
    emit(false);
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}
