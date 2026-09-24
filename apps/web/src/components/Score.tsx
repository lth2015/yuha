import { useEffect, useRef } from 'react';
import { subscribeBeat } from '../lib/beat';
import { scoreFromText, type Score as ScoreData } from '../lib/score';

/**
 * Draws a piece of writing as a score.
 *
 * A playhead sweeps the band; notes brighten and swell as it passes, so the
 * drawing reads as something being *played* rather than as a static chart.
 * While audio is actually running the sweep hands over to the real analyser
 * (lib/beat) — the same rule the rest of the app follows: audio-reactive
 * visuals read real analysis data, never a random number pretending to be a
 * beat.
 *
 * Canvas rather than SVG: a hundred strokes redrawn every frame is a hundred
 * DOM mutations per frame in SVG, and the whole point is that it moves while
 * you type.
 */
function describe(ghosting: boolean, score: ScoreData): string {
  if (ghosting) return 'An example score, waiting for your description.';
  if (!score.notes.length) return 'An empty score, waiting for a description.';
  return `A score drawn from your description: ${score.phrases} phrases.`;
}

export function Score({
  text,
  score,
  className,
  height = 168,
  label,
  /** Square sleeves want a denser, calmer drawing than the hero band. */
  compact = false,
  ghost,
  progress,
  head,
  onSeek,
}: {
  /** The writing to read as music. Ignored when `score` is given. */
  text?: string;
  /** A prebuilt score — used by sleeves, which only hold a seed. */
  score?: ScoreData;
  /**
   * Drawn faintly while `text` is empty. The composer already shows an example
   * sentence as its placeholder; showing that sentence's score says what the
   * band is for far better than an empty frame does.
   */
  ghost?: string;
  className?: string;
  height?: number;
  label?: string;
  compact?: boolean;
  /**
   * 0..1 — how much of the score has been committed to tape. Notes past it
   * stay ghosted and the playhead works only within the written region, so
   * the drawing reads as a recording being laid down.
   *
   * It must be fed from something real. This is driven by the job's phase,
   * never by a timer: a bar that advances on its own while nothing is
   * happening is exactly the dishonesty this product has ruled out.
   */
  progress?: number;
  /**
   * 0..1 — where the playhead actually is. Given this, the head stops
   * sweeping and reports playback position instead, which turns the drawing
   * into the transport for the song rather than an animation beside it.
   */
  head?: number;
  /** Makes the score seekable. Receives 0..1. */
  onSeek?: ((fraction: number) => void) | undefined;
}) {
  const resolved = score ?? scoreFromText(text ?? '');
  const isGhost = !score && !(text ?? '').trim() && !!ghost?.trim();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dataRef = useRef<ScoreData>(isGhost ? scoreFromText(ghost!) : resolved);
  const ghostRef = useRef(isGhost);
  /** Set whenever something that affects the drawing changes. */
  const dirty = useRef(true);
  const progressRef = useRef(progress);
  const headRef = useRef(head);
  const beat = useRef({ energy: 0, playing: false });
  const reduced = useRef(false);

  // Re-read the text outside the animation loop: parsing on every frame would
  // burn the frame budget for a result that only changes on keystroke.
  useEffect(() => {
    ghostRef.current = isGhost;
    dataRef.current = isGhost ? scoreFromText(ghost!) : (score ?? scoreFromText(text ?? ''));
    dirty.current = true;
  }, [text, score, ghost, isGhost]);

  useEffect(() => {
    progressRef.current = progress;
    dirty.current = true;
  }, [progress]);

  useEffect(() => {
    headRef.current = head;
    dirty.current = true;
  }, [head]);

  useEffect(() => subscribeBeat((energy, playing) => {
    beat.current = { energy, playing };
  }), []);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    reduced.current = mq.matches;
    const onChange = (e: MediaQueryListEvent) => { reduced.current = e.matches; };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let w = 0;
    let h = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dirty.current = true;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const start = performance.now();

    let wasStill = false;

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const { notes } = dataRef.current;
      const { energy, playing } = beat.current;
      const pinned = headRef.current !== undefined;
      const stillNow = reduced.current || (compact && !playing) || pinned;
      // A still drawing only needs painting when something actually changed.
      if (stillNow && wasStill && !dirty.current) return;
      wasStill = stillNow;
      dirty.current = false;
      ctx.clearRect(0, 0, w, h);
      ctx.globalAlpha = ghostRef.current ? 0.26 : 1;

      const baseline = h * 0.62;
      const ceiling = h * 0.1;
      const span = baseline - ceiling;
      // The reflection is shallower than the note, the way a reflection is.
      const mirror = (h - baseline) * 0.82;

      // The staff line: always present, so silence still has a shape.
      ctx.strokeStyle = 'rgba(255,255,255,0.09)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, baseline + 0.5);
      ctx.lineTo(w, baseline + 0.5);
      ctx.stroke();

      if (notes.length === 0) {
        // Resting state: a few faint ticks — the room before anything is said.
        ctx.fillStyle = 'rgba(255,255,255,0.13)';
        for (let i = 0; i < 9; i += 1) {
          const x = (w / 10) * (i + 1);
          ctx.fillRect(x, baseline - 5, 1, 10);
        }
        return;
      }

      // The playhead: a slow idle sweep, or real progress while audio plays.
      const still = stillNow;
      const cut = progressRef.current;
      const cycle = still ? 0.5 : ((now - start) / 5200) % 1;
      // A pinned head reports real playback position. Otherwise the head
      // sweeps, and while recording it works the written region only — it
      // cannot run ahead of what has actually been committed.
      const at = headRef.current ?? (cut === undefined ? cycle : cycle * cut);
      const headX = Math.max(0, Math.min(1, at)) * w;

      for (const n of notes) {
        if (n.rest) continue;
        const x = 12 + n.x * (w - 24);
        // Proximity to the playhead, 0..1, over a narrow window.
        const near = Math.max(0, 1 - Math.abs(x - headX) / (w * 0.14));
        const swell = still ? 0 : near * (playing ? 0.35 + energy * 0.75 : 0.3);
        const top = baseline - span * n.pitch * (1 + swell);
        const lw = 1.5 + n.weight * 1.6 + near * 1.8;

        // Low notes sit in the petal, high notes lift into the violet, mixed
        // in RGB. Interpolating the *hue* instead would travel through green,
        // which is not a brand colour and reads as a bug.
        const t = n.pitch;
        const r = Math.round(255 + (139 - 255) * t);
        const g = Math.round(122 + (124 - 122) * t);
        const b = Math.round(77 + (255 - 77) * t);
        // Past the recording cut a note is present but not yet real. Past
        // the playhead it is real but not yet reached — a softer difference.
        const written = cut === undefined || n.x <= cut;
        const pin = headRef.current;
        // A head at zero means the song has not started, not that every note
        // is unreached — dimming the whole score there reads as disabled.
        const reached = pin === undefined || pin <= 0 || n.x <= pin;
        const dim = written ? (reached ? 1 : 0.5) : 0.16;
        const alpha = (0.34 + n.weight * 0.26 + near * 0.4) * dim;
        ctx.lineWidth = lw;
        ctx.lineCap = 'round';
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${Math.min(1, alpha)})`;
        ctx.beginPath();
        ctx.moveTo(x, baseline);
        ctx.lineTo(x, top);
        ctx.stroke();

        // The reflection. Dimmer and shorter, so it reads as a surface the
        // notes stand on rather than as a second set of notes.
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${Math.min(1, alpha) * 0.3})`;
        ctx.beginPath();
        ctx.moveTo(x, baseline);
        ctx.lineTo(x, baseline + mirror * n.pitch * (1 + swell * 0.6));
        ctx.stroke();

        // The head of the note, brightest right under the playhead.
        if (near > 0.15 && written) {
          ctx.fillStyle = `rgba(${Math.min(255, r + 40)}, ${Math.min(255, g + 40)}, ${Math.min(255, b + 30)}, ${near * 0.9})`;
          ctx.beginPath();
          ctx.arc(x, top, 1.4 + near * 2.1, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Phrase feet: one short mark under the first note of each word, so the
      // score shows how the sentence breaks, not only how it sounds.
      let lastPhrase = -1;
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      for (const n of notes) {
        if (n.rest || n.phrase === lastPhrase) continue;
        lastPhrase = n.phrase;
        const x = 12 + n.x * (w - 24);
        ctx.fillRect(x - 3, baseline + mirror + 8, 6, 1);
      }

      if (!still) {
        // Light pooling on the staff line where the playhead is. Additive, so
        // it brightens the notes it passes instead of covering them.
        const peak = playing ? 0.26 + energy * 0.24 : 0.13;
        const reach = span * 0.95;
        const glow = ctx.createRadialGradient(headX, baseline, 0, headX, baseline, reach);
        glow.addColorStop(0, `rgba(255, 238, 228, ${peak})`);
        glow.addColorStop(0.45, `rgba(255, 210, 190, ${peak * 0.32})`);
        glow.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = glow;
        ctx.fillRect(headX - reach, baseline - reach, reach * 2, reach);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [compact]);

  // Derived from the prop, not from the ref: the ref is updated in an effect
  // and would always describe the previous keystroke.
  const described = resolved;
  const seek = (clientX: number) => {
    const el = canvasRef.current;
    if (!el || !onSeek) return;
    const r = el.getBoundingClientRect();
    if (!r.width) return;
    onSeek(Math.max(0, Math.min(1, (clientX - r.left) / r.width)));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!onSeek || head === undefined) return;
    const stepBy = e.shiftKey ? 0.1 : 0.02;
    if (e.key === 'ArrowRight') { e.preventDefault(); onSeek(Math.min(1, head + stepBy)); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); onSeek(Math.max(0, head - stepBy)); }
    else if (e.key === 'Home') { e.preventDefault(); onSeek(0); }
    else if (e.key === 'End') { e.preventDefault(); onSeek(1); }
  };

  // An empty label marks the canvas decorative: inside a sleeve the wrapper
  // already carries the description, and a second role="img" would make a
  // screen reader announce the same artwork twice.
  const decorative = label === '';
  return (
    <canvas
      ref={canvasRef}
      className={`score${className ? ` ${className}` : ''}${onSeek ? ' is-seekable' : ''}`}
      style={{ height }}
      {...(onSeek
        ? {
            // Interactive, so it is a slider and must be operable by keyboard,
            // not only by pointer.
            role: 'slider',
            tabIndex: 0,
            'aria-label': label ?? describe(isGhost, described),
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuenow': Math.round((head ?? 0) * 100),
            'aria-valuetext': `${Math.round((head ?? 0) * 100)}%`,
            onPointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              seek(e.clientX);
            },
            onPointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => {
              if (e.buttons) seek(e.clientX);
            },
            onKeyDown,
          }
        : decorative
          ? { 'aria-hidden': true }
          : {
              role: 'img',
              'aria-label': label ?? describe(isGhost, described),
            })}
    />
  );
}
