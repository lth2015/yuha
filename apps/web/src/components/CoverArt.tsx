import { useMemo } from 'react';
import { useI18n } from '../lib/i18n';
import { scoreFromSeed } from '../lib/score';
import { Score } from './Score';

/**
 * The sleeve.
 *
 * Every song's artwork is its score — the same drawing the composer shows you
 * while you write, squared off and set in a tinted field. That continuity is
 * the point: the shape you watched appear as you described the song is the
 * shape that ends up on the card in your library. A song is not decorated with
 * a logo; it is shown as what it is.
 *
 * Tone and index derive from the track's seed, so a sleeve is stable across
 * refreshes and never implies genre, tier or quality.
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

/**
 * Deep fields, not the pastel squares the light build used — a bright sleeve
 * on a near-black page reads as a hole punched in the canvas, and it would
 * drown the score drawn on top of it.
 */
const FIELDS = [
  'radial-gradient(120% 100% at 22% 12%, #3a1d17 0%, #140d12 62%, #0b0a10 100%)',
  'radial-gradient(120% 100% at 78% 16%, #221a3d 0%, #130f1f 60%, #0a0a10 100%)',
  'radial-gradient(120% 100% at 50% 8%, #10262c 0%, #0e141c 58%, #08090f 100%)',
  'radial-gradient(120% 100% at 14% 84%, #2e1a2c 0%, #150f18 62%, #0a090e 100%)',
];

export function CoverArt({
  seed,
  title,
  size,
  className,
  playing = false,
}: {
  seed: number;
  title: string;
  /** Upper bound, not a fixed width: the sleeve always fills its container. */
  size?: number;
  className?: string;
  playing?: boolean;
}) {
  const { t } = useI18n();
  const art = useMemo(() => {
    const rand = seedOf(seed);
    const field = FIELDS[Math.floor(rand() * FIELDS.length)]!;
    const index = String(1 + Math.floor(rand() * 999)).padStart(3, '0');
    // Denser on a big sleeve, sparser on a small one, so the marks keep the
    // same visual weight at every size the grid uses.
    const notes = (size ?? 320) >= 220 ? 52 : 34;
    return { field, index, score: scoreFromSeed(seed, notes) };
  }, [seed, size]);

  return (
    <span
      className={`cover-art${className ? ` ${className}` : ''}${playing ? ' is-playing' : ''}`}
      style={{ background: art.field, width: '100%', maxWidth: size, aspectRatio: '1 / 1' }}
      role="img"
      aria-label={t('cover.aria', { title })}
    >
      <Score
        score={art.score}
        compact
        height="52%"
        className="cover-art__score"
        label=""
      />
      <span className="cover-art__index" aria-hidden="true">
        N°{art.index}
      </span>
    </span>
  );
}
