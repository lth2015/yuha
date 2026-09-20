import { useMemo } from 'react';
import { useI18n } from '../lib/i18n';

/**
 * YUHA cover system (acceptance §3): a quiet three-tone canvas — soft petal,
 * lavender, sage — carrying the dimensional petal. The composition is
 * deliberate, not scattered: one petal, placed with consistent margins and a
 * deterministic tilt, plus an index mark in the corner. Tone and tilt derive
 * from the song id, so a cover is stable across refreshes and never implies
 * genre, tier or quality.
 */
function seedOf(seed: number): () => number {
  let a = (seed || 7) >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TONES = [
  { bg: '#FFE4D8', mark: 'color' }, // petal-soft
  { bg: '#E8E3F5', mark: 'ink' }, // lavender
  { bg: '#E1E7D9', mark: 'ink' }, // sage
];

export function CoverArt({
  seed,
  title,
  size = 220,
  className,
  playing = false,
}: {
  seed: number;
  title: string;
  size?: number;
  className?: string;
  playing?: boolean;
}) {
  const { t } = useI18n();
  const art = useMemo(() => {
    const rand = seedOf(seed);
    const tone = TONES[Math.floor(rand() * TONES.length)]!;
    // A tight family of tilts: the petal always leans, never lies flat.
    const rotate = [-16, -8, 6, 14][Math.floor(rand() * 4)]!;
    const scale = 0.58 + rand() * 0.08;
    const index = String(1 + Math.floor(rand() * 999)).padStart(3, '0');
    return { tone, rotate, scale, index };
  }, [seed]);

  const colored = art.tone.mark === 'color';

  return (
    <span
      className={`cover-art${className ? ` ${className}` : ''}${playing ? ' is-playing' : ''}`}
      style={{ background: art.tone.bg, width: size, height: size }}
      role="img"
      aria-label={t('cover.aria', { title })}
    >
      <svg
        viewBox="0 0 96 96"
        className="cover-art__petal"
        style={{ width: `${art.scale * 100}%`, transform: `rotate(${art.rotate}deg)` }}
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={`ca-${seed}-a`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={colored ? '#FF9668' : '#3A3E37'} />
            <stop offset="100%" stopColor={colored ? '#D8512E' : '#20221F'} />
          </linearGradient>
        </defs>
        <path d="M81 12C83 41 62 71 27 85C31 70 43 55 54 47C66 37 75 24 81 12Z" fill={`url(#ca-${seed}-a)`} />
        <path
          d="M14 24C37 23 53 34 54 49C40 47 22 38 14 24Z"
          fill={colored ? '#F46B45' : '#20221F'}
          opacity={colored ? 1 : 0.82}
        />
        <path d="M81 12C83 41 62 71 27 85C31 70 43 55 54 47C66 37 75 24 81 12Z" fill="#FFFFFF" opacity={colored ? 0.14 : 0.06} />
      </svg>
      <span className="cover-art__index" aria-hidden="true">
        N°{art.index}
      </span>
    </span>
  );
}
