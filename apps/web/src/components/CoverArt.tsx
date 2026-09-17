import { useMemo } from 'react';

/**
 * Procedural cover art.
 *
 * Every song gets cover art the moment it exists — derived, deterministic and
 * ours, from the song's cover_seed: a layered gradient with orbital arcs and a
 * grain pass. No stock images, no external requests, no two songs alike.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PALETTES: Array<[string, string, string]> = [
  ['#D4FF62', '#3EE6A8', '#0E1B12'],
  ['#B6A0FF', '#5E4BD9', '#140F2E'],
  ['#FF9E7A', '#E4586B', '#2B0F1A'],
  ['#6BD5FF', '#3D6BFF', '#0B1630'],
  ['#FFE86B', '#FF8FB1', '#301625'],
  ['#8CFFC1', '#2FA871', '#08221A'],
  ['#C9B8FF', '#FF9ED2', '#1D1030'],
  ['#FFD166', '#EF6F4C', '#241009'],
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
    const rand = mulberry32(seed || 1);
    const palette = PALETTES[Math.floor(rand() * PALETTES.length)]!;
    // Orbiting arcs: 2-4 rings at random radii/angles.
    const rings = Array.from({ length: 2 + Math.floor(rand() * 3) }, (_, i) => ({
      r: 18 + rand() * 30,
      cx: 20 + rand() * 60,
      cy: 20 + rand() * 60,
      start: rand() * 360,
      sweep: 60 + rand() * 240,
      width: 1.5 + rand() * 3.5,
      opacity: 0.25 + rand() * 0.5,
      rotate: rand() * 360,
      delay: `${(i * 0.7 + rand()).toFixed(2)}s`,
    }));
    // A drifting blob for depth.
    const blob = { cx: 15 + rand() * 70, cy: 15 + rand() * 70, r: 22 + rand() * 26 };
    const initials = title
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('');
    return { palette, rings, blob, initials: initials || '♪' };
  }, [seed, title]);

  const [hot, mid, deep] = art.palette;

  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={`cover-art${className ? ` ${className}` : ''}${playing ? ' cover-art--playing' : ''}`}
      role="img"
      aria-label={`Cover art for ${title}`}
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <linearGradient id={`bg-${seed}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={mid} stopOpacity="0.85" />
          <stop offset="100%" stopColor={deep} />
        </linearGradient>
        <radialGradient id={`blob-${seed}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={hot} stopOpacity="0.55" />
          <stop offset="100%" stopColor={hot} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="100" height="100" fill={`url(#bg-${seed})`} />
      <circle cx={art.blob.cx} cy={art.blob.cy} r={art.blob.r} fill={`url(#blob-${seed})`} />
      {art.rings.map((ring, i) => (
        <circle
          key={i}
          cx={ring.cx}
          cy={ring.cy}
          r={ring.r}
          fill="none"
          stroke={hot}
          strokeWidth={ring.width}
          strokeLinecap="round"
          strokeDasharray={`${(ring.sweep / 360) * 2 * Math.PI * ring.r} ${2 * Math.PI * ring.r}`}
          strokeDashoffset={0}
          transform={`rotate(${ring.start} ${ring.cx} ${ring.cy})`}
          opacity={ring.opacity}
        />
      ))}
      <text
        x="50"
        y="57"
        textAnchor="middle"
        fontSize="30"
        fontWeight="800"
        fill="#FFFFFF"
        opacity="0.9"
        style={{ letterSpacing: '1px' }}
      >
        {art.initials}
      </text>
    </svg>
  );
}
