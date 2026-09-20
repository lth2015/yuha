import { useMemo } from 'react';

/**
 * YUHA cover system (acceptance §3): a quiet three-tone canvas — soft petal,
 * lavender, sage — carrying the dimensional petal mark. Tone, rotation and
 * scale derive from the song id, so a cover is stable across refreshes and
 * never implies genre, tier or quality.
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
  const art = useMemo(() => {
    const rand = seedOf(seed);
    const tone = TONES[Math.floor(rand() * TONES.length)]!;
    const rotate = -30 + Math.round(rand() * 50); // -30…20 deg
    const scale = 0.6 + rand() * 0.16;
    const x = 18 + Math.round(rand() * 14);
    const y = 14 + Math.round(rand() * 12);
    const label = title
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('');
    return { tone, rotate, scale, x, y, label: label || 'Y' };
  }, [seed, title]);

  return (
    <span
      className={`cover-art${className ? ` ${className}` : ''}${playing ? ' is-playing' : ''}`}
      style={{ background: art.tone.bg, width: size, height: size }}
      role="img"
      aria-label={`「${title}」的封面`}
    >
      <svg
        viewBox="0 0 96 96"
        className="cover-art__petal"
        style={{
          left: `${art.x}%`,
          top: `${art.y}%`,
          width: `${art.scale * 64}%`,
          transform: `rotate(${art.rotate}deg)`,
        }}
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={`ca-${seed}-a`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={art.tone.mark === 'color' ? '#FF8A5C' : '#3A3E37'} />
            <stop offset="100%" stopColor={art.tone.mark === 'color' ? '#D8512E' : '#20221F'} />
          </linearGradient>
        </defs>
        <path
          d="M81 12C83 41 62 71 27 85C31 70 43 55 54 47C66 37 75 24 81 12Z"
          fill={`url(#ca-${seed}-a)`}
        />
        <path
          d="M14 24C37 23 53 34 54 49C40 47 22 38 14 24Z"
          fill={art.tone.mark === 'color' ? '#F46B45' : '#20221F'}
          opacity={art.tone.mark === 'color' ? 1 : 0.82}
        />
      </svg>
      <span className="cover-art__label" aria-hidden="true">
        {art.label}
      </span>
    </span>
  );
}
