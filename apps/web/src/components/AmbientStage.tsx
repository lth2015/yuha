import { useEffect, useMemo, useRef, useState } from 'react';
import { subscribeBeat, wakeBeat } from '../lib/beat';

/**
 * The ambient stage: petals drifting down and music notes lifting off the
 * cover, breathing with the actual rhythm (lib/beat reads a real analyser —
 * no random beats). When nothing plays, the field rests: petals hang, notes
 * wait. prefers-reduced-motion stills everything to a composed arrangement.
 */

/** A single petal as drawn geometry (never emoji). */
function Petal({ size, delay, dur, sway, left, tone }: { size: number; delay: number; dur: number; sway: number; left: string; tone: string }) {
  return (
    <svg
      className="ambient__petal"
      viewBox="0 0 96 96"
      style={{ width: size, left, animationDelay: `${delay}s`, animationDuration: `${dur}s`, '--sway': `${sway}px` } as React.CSSProperties}
      aria-hidden="true"
    >
      <path d="M81 12C83 41 62 71 27 85C31 70 43 55 54 47C66 37 75 24 81 12Z" fill={tone} opacity="0.5" />
      <path d="M14 24C37 23 53 34 54 49C40 47 22 38 14 24Z" fill={tone} opacity="0.34" />
    </svg>
  );
}

/** A note as drawn geometry: stem + head, gently rotating. */
function Note({ size, delay, dur, left, bottom, tone }: { size: number; delay: number; dur: number; left: string; bottom: string; tone: string }) {
  return (
    <svg
      className="ambient__note"
      viewBox="0 0 24 24"
      style={{ width: size, left, bottom, animationDelay: `${delay}s`, animationDuration: `${dur}s` }}
      aria-hidden="true"
    >
      <path
        d="M9 18.5A2.5 2.5 0 1 1 6.5 16c.9 0 1.7.4 2 1V5.5L18 3.5V15A2.5 2.5 0 1 1 15.5 12.5c.9 0 1.7.4 2 1V6L9 7.8Z"
        fill={tone}
      />
    </svg>
  );
}

export function AmbientStage({ className, seed = 1 }: { className?: string; seed?: number }) {
  const [energy, setEnergy] = useState(0);
  const [playing, setPlaying] = useState(false);
  const fieldRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => subscribeBeat((e, p) => {
    setEnergy(e);
    setPlaying(p);
  }), []);

  // Wake the AudioContext on first pointer interaction near the stage.
  useEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    const wake = () => wakeBeat();
    el.addEventListener('pointerdown', wake);
    return () => el.removeEventListener('pointerdown', wake);
  }, []);

  const petals = useMemo(() => {
    const tones = ['#F46B45', '#E8A18B', '#C9B08A', '#D8C5B2'];
    // Deterministic layout from the seed: same song, same drift.
    let a = (seed || 3) >>> 0;
    const rnd = () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296);
    return Array.from({ length: 7 }, (_, i) => ({
      size: 14 + Math.round(rnd() * 16),
      left: `${6 + Math.round(rnd() * 86)}%`,
      delay: -Math.round(rnd() * 14),
      dur: 11 + Math.round(rnd() * 8),
      sway: 26 + Math.round(rnd() * 34),
      tone: tones[(i + seed) % tones.length]!,
    }));
  }, [seed]);

  const notes = useMemo(() => {
    let a = (seed * 7919 + 13) >>> 0;
    const rnd = () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296);
    return Array.from({ length: 5 }, (_, i) => ({
      size: 13 + Math.round(rnd() * 10),
      left: `${14 + Math.round(rnd() * 70)}%`,
      bottom: `${8 + Math.round(rnd() * 16)}%`,
      delay: -Math.round(rnd() * 5),
      dur: 3.4 + rnd() * 2,
      tone: i % 2 === 0 ? 'var(--ink)' : 'var(--petal-deep)',
    }));
  }, [seed]);

  return (
    <div
      ref={fieldRef}
      className={`ambient${playing ? ' is-live' : ''}${className ? ` ${className}` : ''}`}
      style={{ '--energy': energy.toFixed(3) } as React.CSSProperties}
      aria-hidden="true"
    >
      {petals.map((p, i) => (
        <Petal key={i} {...p} />
      ))}
      {notes.map((n, i) => (
        <Note key={i} {...n} />
      ))}
    </div>
  );
}
