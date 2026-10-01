/**
 * YUHA brand components.
 *
 * The masters in /public/brand are the source of truth — BrandLogo inlines
 * the delivered yuha-logo.svg paths so the kerning is exactly as designed.
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
/**
 * The nav/footer lockup, inlined from /public/brand/yuha-logo.svg (same paths,
 * same kerning). Inline rather than <img> for two reasons: the master's wordmark
 * is hard-coded ink #20221F, which disappears on the dark studio, and an <img>
 * is one more request that can fail (it rendered as a broken image in the
 * footer). Here the petal keeps the brand orange and the wordmark takes
 * `currentColor`, i.e. the theme's --ink, so it reads on any surface.
 */
export function BrandLogo({ width = 132, className }: { width?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 328 100"
      width={width}
      height={(width * 100) / 328}
      role="img"
      aria-label="YUHA"
      className={`brand-lockup${className ? ` ${className}` : ''}`}
    >
      <g fill="#F46B45">
        <path d={PETAL_PATHS[0]} />
        <path d={PETAL_PATHS[1]} />
      </g>
      <g
        transform="translate(115 12)"
        fill="none"
        stroke="currentColor"
        strokeWidth={10}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M7 18L21 49C23 54 27 54 29 49L43 18M29 49L19 72" />
        <path d="M64 18V39C64 58 93 58 93 39V18" />
        <path d="M116 1V52M116 34C116 13 146 13 146 34V52" />
        <path d="M202 35C202 12 171 12 171 35C171 59 202 59 202 35ZM202 19V52" />
      </g>
    </svg>
  );
}
