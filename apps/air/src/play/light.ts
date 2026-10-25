/**
 * The visible half of the answer: a soft bloom where the finger is for each
 * note, sized by how strongly it was played and coloured by register, and a
 * faint trace of the finger itself. Driven only by real note events and
 * frames, never by invented beats.
 */
import type { GestureFrame } from '../engine/frame.ts';
import type { NoteEvent } from '../engine/performer.ts';

type Bloom = { x: number; y: number; born: number; life: number; size: number; hue: number; alpha: number };

export function createLight(canvas: HTMLCanvasElement) {
  const g = canvas.getContext('2d')!;
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const blooms: Bloom[] = [];
  let finger: GestureFrame | null = null;
  let scale = 1;

  const resize = () => {
    scale = Math.min(2, devicePixelRatio || 1);
    canvas.width = canvas.clientWidth * scale;
    canvas.height = canvas.clientHeight * scale;
  };
  resize();
  addEventListener('resize', resize);

  // Low notes warm (petal orange), high notes cool (violet).
  const hueFor = (pitch: number) => 18 - Math.min(1, Math.max(0, (pitch - 55) / 29)) * 75;

  function draw(now: number) {
    g.clearRect(0, 0, canvas.width, canvas.height);
    const short = Math.min(canvas.width, canvas.height);
    for (let i = blooms.length - 1; i >= 0; i -= 1) {
      const b = blooms[i]!;
      const age = (now - b.born) / b.life;
      if (age >= 1) {
        blooms.splice(i, 1);
        continue;
      }
      if (age < 0) continue;
      const r = short * b.size * (calm ? 0.6 : 0.25 + 0.75 * Math.sqrt(age));
      const x = b.x * canvas.width;
      const y = (1 - b.y) * canvas.height;
      const fill = g.createRadialGradient(x, y, 0, x, y, r);
      fill.addColorStop(0, `hsla(${b.hue}, 85%, 62%, ${b.alpha * (1 - age)})`);
      fill.addColorStop(1, `hsla(${b.hue}, 85%, 62%, 0)`);
      g.fillStyle = fill;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
    if (finger?.active) {
      const x = finger.x * canvas.width;
      const y = (1 - finger.y) * canvas.height;
      g.fillStyle = 'rgba(32, 34, 31, 0.18)';
      g.beginPath();
      g.arc(x, y, 6 * scale, 0, Math.PI * 2);
      g.fill();
    }
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);

  return {
    frame(f: GestureFrame) {
      finger = f;
    },
    /** `delayMs`: how far in the future the note sounds, so the bloom opens with it. */
    note(e: NoteEvent, delayMs: number) {
      if (!finger) return;
      blooms.push({
        x: finger.x,
        y: finger.y,
        born: performance.now() + delayMs,
        life: e.voice === 'pad' ? 2400 : 900 + e.velocity * 700,
        size: e.voice === 'pad' ? 0.9 : 0.08 + e.velocity * 0.14,
        hue: hueFor(e.pitch),
        alpha: e.voice === 'pad' ? 0.06 : 0.55,
      });
      if (blooms.length > 160) blooms.splice(0, blooms.length - 160);
    },
  };
}
