/**
 * Style tags in the reader's language.
 *
 * A tag is the music model's vocabulary and stays English everywhere it is
 * stored or sent; only what a person reads is translated. A user reported that
 * a row of `lofi`, `synthwave`, `dnb` is a wall for an ordinary listener, so
 * the create page, song cards and the song page show 低保真, 合成器浪潮,
 * 鼓打贝斯 instead, and the English tag stays one hover away.
 *
 * Tags arrive in many spellings (people type `Lo-Fi`, the AI writes
 * `chinese_pop`), so a tag is folded to one form before it is looked up. A tag
 * with no entry is shown as written, with underscores as spaces: it may be a
 * word the creator typed in their own language, and it is theirs.
 *
 * Pure, so tests/style-label.test.ts can pin it.
 */

/** The styles the create page offers as chips, in order. */
export const STYLE_PRESETS = [
  'lofi',
  'synthwave',
  'trap',
  'pop',
  'acoustic',
  'ambient',
  'dnb',
  'rock',
  'jazz',
  'cinematic',
  'hyperpop',
  'house',
];

// Spelled out so scripts/check-i18n.mjs can see every key in all three dictionaries.
const KEYS: Record<string, string> = {
  lofi: 'style.lofi',
  synthwave: 'style.synthwave',
  trap: 'style.trap',
  pop: 'style.pop',
  acoustic: 'style.acoustic',
  ambient: 'style.ambient',
  dnb: 'style.dnb',
  rock: 'style.rock',
  jazz: 'style.jazz',
  cinematic: 'style.cinematic',
  hyperpop: 'style.hyperpop',
  house: 'style.house',
  soul: 'style.soul',
  folk: 'style.folk',
  bossa: 'style.bossa',
  chinese_traditional: 'style.chinese_traditional',
  guzheng: 'style.guzheng',
  ballad: 'style.ballad',
  piano: 'style.piano',
  city_pop: 'style.city_pop',
  edm: 'style.edm',
  techno: 'style.techno',
  drill: 'style.drill',
  metal: 'style.metal',
  chill: 'style.chill',
  rnb: 'style.rnb',
  hip_hop: 'style.hip_hop',
  rap: 'style.rap',
  electronic: 'style.electronic',
  classical: 'style.classical',
  orchestral: 'style.orchestral',
  funk: 'style.funk',
  disco: 'style.disco',
  reggae: 'style.reggae',
  blues: 'style.blues',
  country: 'style.country',
  indie: 'style.indie',
  kpop: 'style.kpop',
  jpop: 'style.jpop',
  cpop: 'style.cpop',
  anime: 'style.anime',
  idol: 'style.idol',
  japanese_idol: 'style.japanese_idol',
  kawaii: 'style.kawaii',
  vlog: 'style.vlog',
  arcade: 'style.arcade',
  chiptune: 'style.chiptune',
  gaming: 'style.gaming',
  epic: 'style.epic',
  battle: 'style.battle',
  night: 'style.night',
  fashion: 'style.fashion',
  dreamy: 'style.dreamy',
  warm: 'style.warm',
  calm: 'style.calm',
  melancholic: 'style.melancholic',
  confident: 'style.confident',
  playful: 'style.playful',
  tense: 'style.tense',
  uplifting: 'style.uplifting',
  soft: 'style.soft',
  intimate: 'style.intimate',
  sad: 'style.sad',
  happy: 'style.happy',
  romantic: 'style.romantic',
  mandarin: 'style.mandarin',
  cantonese: 'style.cantonese',
  japanese: 'style.japanese',
  guitar: 'style.guitar',
  synth: 'style.synth',
  strings: 'style.strings',
  lullaby: 'style.lullaby',
  study: 'style.study',
  sleep: 'style.sleep',
};

/** Other spellings of a tag in KEYS, after folding. */
const ALIASES: Record<string, string> = {
  '8 bit': 'chiptune',
  '8bit': 'chiptune',
  'bossa nova': 'bossa',
  'c pop': 'cpop',
  'chinese': 'mandarin',
  'chinese pop': 'cpop',
  'chinese_pop': 'cpop',
  'd&b': 'dnb',
  'drum & bass': 'dnb',
  'drum and bass': 'dnb',
  'drum n bass': 'dnb',
  'game': 'gaming',
  'games': 'gaming',
  'hiphop': 'hip_hop',
  'j pop': 'jpop',
  'k pop': 'kpop',
  'lo fi': 'lofi',
  'mandopop': 'cpop',
  'melancholy': 'melancholic',
  'orchestra': 'orchestral',
  'r and b': 'rnb',
  'r&b': 'rnb',
};

type Say = (key: string) => string;

/** Lowercase, trimmed, `_` and `-` as spaces, runs of spaces as one. */
function fold(tag: string): string {
  return tag.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

export function styleLabel(tag: string, say: Say): string {
  const folded = fold(tag);
  const id = ALIASES[folded] ?? ALIASES[tag.trim().toLowerCase()] ?? folded.replace(/ /g, '_');
  const key = KEYS[id];
  return key ? say(key) : tag.trim().replace(/_+/g, ' ');
}
