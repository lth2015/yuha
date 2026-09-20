/**
 * YUHA brand components.
 *
 * The SVG masters in /public/brand are the source of truth. The dimensional
 * treatment here (PetalMark) layers the two master petal paths with a warm
 * gradient, a soft ground shadow and a specular highlight — depth applied at
 * render time, never by editing the master files.
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
  dim = true,
  rotate = -10,
  title = 'YUHA petal',
}: {
  size?: number;
  className?: string;
  dim?: boolean;
  rotate?: number;
  title?: string;
}) {
  const id = `petal-${size}-${rotate}`;
  return (
    <svg
      viewBox="0 0 96 96"
      width={size}
      height={size}
      className={`petal-mark${className ? ` ${className}` : ''}`}
      role="img"
      aria-label={title}
      style={{ transform: `rotate(${rotate}deg)` }}
    >
      <defs>
        {/* Warm light from the upper left — the two faces read as folded paper. */}
        <linearGradient id={`${id}-a`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#FF8A5C" />
          <stop offset="55%" stopColor="#F46B45" />
          <stop offset="100%" stopColor="#D8512E" />
        </linearGradient>
        <linearGradient id={`${id}-b`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#FFB08C" />
          <stop offset="100%" stopColor="#F4704B" />
        </linearGradient>
        {/* Specular sheen along the top edge of the sweep face. */}
        <linearGradient id={`${id}-sheen`} x1="0" y1="0" x2="0.6" y2="1">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.55" />
          <stop offset="45%" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
      </defs>
      {dim && (
        /* Ground shadow: the petal floats slightly above the surface. */
        <ellipse cx="46" cy="82" rx="26" ry="6" fill="#8A4A30" opacity="0.14" />
      )}
      <path d={PETAL_PATHS[0]} fill={`url(#${id}-a)`} />
      <path d={PETAL_PATHS[1]} fill={`url(#${id}-b)`} />
      <path d={PETAL_PATHS[0]} fill={`url(#${id}-sheen)`} />
      <path d={PETAL_PATHS[1]} fill="#FFFFFF" opacity="0.22" />
    </svg>
  );
}

/** Horizontal lockup: dimensional mark + the yuha wordmark from the master. */
export function BrandLogo({ width = 128, className }: { width?: number; className?: string }) {
  return (
    <span className={`brand-lockup${className ? ` ${className}` : ''}`} style={{ width }}>
      <PetalMark size={Math.round(width * 0.31)} dim={false} rotate={-10} title="YUHA" />
      <svg
        viewBox="115 6 210 76"
        height={Math.round(width * 0.24)}
        aria-hidden="true"
        className="brand-lockup__word"
      >
        <g
          fill="none"
          stroke="var(--ink)"
          strokeWidth="10"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M7 18L21 49C23 54 27 54 29 49L43 18M29 49L19 72" />
          <path d="M64 18V39C64 58 93 58 93 39V18" />
          <path d="M116 1V52M116 34C116 13 146 13 146 34V52" />
          <path d="M202 35C202 12 171 12 171 35C171 59 202 59 202 35ZM202 19V52" />
        </g>
      </svg>
    </span>
  );
}
