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
 * The colour used to come from the seed alone, with a note here saying a
 * sleeve should never imply genre, tier or quality. Two of those three still
 * hold and are the ones that matter: **nothing here may depend on what
 * someone paid**, so a sleeve never tells you a plan, a price or a verdict on
 * the music. Genre is different, and the shelf argued the other way — four
 * songs side by side in a library, all grey-brown for no reason anyone could
 * name, and the colour was simply noise. So now:
 *
 *   - the **style tags choose the colour family** — the same words the
 *     creator picked, so a lo-fi song is warm and a drum-and-bass one is cold,
 *     and the shelf can be read at a glance;
 *   - the **seed still chooses the variation** inside that family — where the
 *     light falls, and the index — so two lo-fi songs are relatives, not
 *     twins, and every sleeve is stable across refreshes.
 *
 * A song with no style tags keeps the old behaviour and takes its family from
 * the seed, which is the honest answer to "we were not told".
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
 * drown the score drawn on top of it. Each family is three stops: the lit
 * corner, the body, and the near-black edge that lets the sleeve sit on the
 * page instead of on top of it.
 */
const FAMILIES = {
  ember: ['#3a1d17', '#140d12', '#0b0a10'],
  violet: ['#221a3d', '#130f1f', '#0a0a10'],
  teal: ['#10262c', '#0e141c', '#08090f'],
  magenta: ['#2e1a2c', '#150f18', '#0a090e'],
  crimson: ['#3a1620', '#170d12', '#0b090e'],
  indigo: ['#161f3e', '#0f1220', '#08090f'],
} as const;

type Family = keyof typeof FAMILIES;
const FAMILY_NAMES = Object.keys(FAMILIES) as Family[];

/**
 * Style tag to colour family.
 *
 * The twelve tags the composer offers are all here, and so are the words the
 * seeded showcase uses, because those songs are the first thing a visitor
 * sees. The mapping is warmth, not genre theory: what a listener would expect
 * the colour of that word to be.
 */
const STYLE_FAMILY: Record<string, Family> = {
  lofi: 'ember',
  acoustic: 'ember',
  jazz: 'ember',
  warm: 'ember',
  vlog: 'ember',
  synthwave: 'violet',
  cinematic: 'violet',
  dreamy: 'violet',
  epic: 'violet',
  night: 'violet',
  ambient: 'teal',
  house: 'teal',
  chill: 'teal',
  calm: 'teal',
  trap: 'magenta',
  hyperpop: 'magenta',
  pop: 'magenta',
  fashion: 'magenta',
  confident: 'magenta',
  rock: 'crimson',
  tense: 'crimson',
  battle: 'crimson',
  dnb: 'indigo',
  arcade: 'indigo',
  playful: 'indigo',
};

/** FNV-1a, so an unmapped tag still lands on one family and stays there. */
function hashTag(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function familyFor(styles: readonly string[] | undefined, rand: () => number): Family {
  for (const tag of styles ?? []) {
    const hit = STYLE_FAMILY[tag.trim().toLowerCase()];
    if (hit) return hit;
  }
  /*
   * A tag we have never seen — the API allows any string, and the text model
   * invents them — is hashed rather than dropped. Dropping it would make a
   * song with a style look identical to a song with none, which is exactly the
   * information the colour is supposed to carry.
   */
  const first = styles?.[0]?.trim().toLowerCase();
  if (first) return FAMILY_NAMES[hashTag(first) % FAMILY_NAMES.length]!;
  return FAMILY_NAMES[Math.floor(rand() * FAMILY_NAMES.length)]!;
}

export function CoverArt({
  seed,
  title,
  styles,
  size,
  className,
  playing = false,
}: {
  seed: number;
  title: string;
  /** The song's style tags; they choose the colour family. */
  styles?: readonly string[];
  /** Upper bound, not a fixed width: the sleeve always fills its container. */
  size?: number;
  className?: string;
  playing?: boolean;
}) {
  const { t } = useI18n();
  const key = (styles ?? []).join('\u0000');
  const art = useMemo(() => {
    const rand = seedOf(seed);
    const [lit, body, edge] = FAMILIES[familyFor(styles, rand)];
    // Where the light falls is the seed's job, so two songs of the same style
    // are relatives rather than twins.
    const x = 14 + Math.floor(rand() * 72);
    const y = 8 + Math.floor(rand() * 84);
    const field = `radial-gradient(120% 100% at ${x}% ${y}%, ${lit} 0%, ${body} 60%, ${edge} 100%)`;
    const index = String(1 + Math.floor(rand() * 999)).padStart(3, '0');
    // Denser on a big sleeve, sparser on a small one, so the marks keep the
    // same visual weight at every size the grid uses.
    const notes = (size ?? 320) >= 220 ? 52 : 34;
    return { field, index, score: scoreFromSeed(seed, notes) };
    // `key` stands in for `styles`: the array identity changes on every render
    // of a parent that maps over a list, and the colours must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, size, key]);

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
