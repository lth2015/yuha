/**
 * A song's sleeve colours, shared by the sleeve on the page (CoverArt) and the
 * pictures drawn for sharing (lib/share-art.ts), so a shared card is the same
 * song you see in your library.
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
 * Saturated sleeves: a lit corner, a body in the family colour, and a deep
 * edge. On the warm-white page these read as album art — colour you want to
 * press — while the deep edge still gives the white score marks drawn on top
 * enough ground to hold.
 */
const FAMILIES = {
  ember: ['#FFB38A', '#F46B45', '#7E2A17'],
  violet: ['#CDBDFF', '#7B66E0', '#2B2069'],
  teal: ['#A6EADF', '#2FA59A', '#0E4643'],
  magenta: ['#FFB6DC', '#D9468F', '#57163B'],
  crimson: ['#FFA3A3', '#D23B4E', '#56111E'],
  indigo: ['#AFC6FF', '#4A6BD8', '#15285F'],
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

/** The sleeve's three colours and where its light falls (percent of width/height). */
export function sleeveColors(seed: number, styles?: readonly string[]) {
  const rand = seedOf(seed);
  const [lit, body, edge] = FAMILIES[familyFor(styles, rand)];
  // Where the light falls is the seed's job, so two songs of the same style
  // are relatives rather than twins.
  const x = 14 + Math.floor(rand() * 72);
  const y = 8 + Math.floor(rand() * 84);
  return { lit, body, edge, x, y };
}
