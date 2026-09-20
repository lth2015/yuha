/**
 * YUHA brand components.
 *
 * The masters in /public/brand are the source of truth — the nav lockup uses
 * the delivered yuha-logo.svg verbatim so the kerning is exactly as designed.
 * PetalMark renders the two master faces with dimensionality (gradient,
 * sheen, ground shadow); the shadow sits OUTSIDE the rotating group so the
 * petal can tilt while its shadow stays on the ground.
 */

/** The two petal faces from the yuha mark master. */
const PETAL_PATHS = [
  // Upper sweep: from lower-left, rising to upper-right.
  'M81 12C83 41 62 71 27 85C31 70 43 55 54 47C66 37 75 24 81 12Z',
  // Fold: tucking in from the upper-left, tip meeting the sweep.
  'M14 24C37 23 53 34 54 49C40 47 22 38 14 24Z',
];

export function PetalMark({
  size = 96,
  className,
  shadow = true,
  rotate = -10,
  title = 'YUHA petal',
}: {
  size?: number;
  className?: string;
  shadow?: boolean;
  rotate?: number;
  title?: string;
}) {
  const id = `petal-${size}-${Math.round(rotate * 100)}`;
  return (
    <span
      className={`petal-mark${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={title}
    >
      {shadow && <span className="petal-mark__ground" aria-hidden="true" />}
      <svg viewBox="0 0 96 96" className="petal-mark__svg" style={{ transform: `rotate(${rotate}deg)` }} aria-hidden="true">
        <defs>
          {/* Warm light from the upper left — the faces read as folded paper. */}
          <linearGradient id={`${id}-a`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#FF9668" />
            <stop offset="55%" stopColor="#F46B45" />
            <stop offset="100%" stopColor="#D8512E" />
          </linearGradient>
          <linearGradient id={`${id}-b`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#FFB08C" />
            <stop offset="100%" stopColor="#F4704B" />
          </linearGradient>
          {/* Specular sheen along the sweep face's top edge. */}
          <linearGradient id={`${id}-sheen`} x1="0.1" y1="0" x2="0.7" y2="1">
            <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.5" />
            <stop offset="50%" stopColor="#FFFFFF" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={PETAL_PATHS[0]} fill={`url(#${id}-a)`} />
        <path d={PETAL_PATHS[1]} fill={`url(#${id}-b)`} />
        <path d={PETAL_PATHS[0]} fill={`url(#${id}-sheen)`} />
        <path d={PETAL_PATHS[1]} fill="#FFFFFF" opacity="0.2" />
      </svg>
    </span>
  );
}

/** Nav lockup: the delivered master lockup, verbatim. */
export function BrandLogo({ width = 132, className }: { width?: number; className?: string }) {
  return (
    <img
      src="/brand/yuha-logo.svg"
      alt="YUHA"
      className={`brand-lockup${className ? ` ${className}` : ''}`}
      style={{ width, height: 'auto' }}
    />
  );
}
