/**
 * What the self-hosted music engine is actually told.
 *
 * The HTTP body YUHA sends (style_tags, instruments, tempo, energy, prompt)
 * is not what ACE-Step receives. The DGX service turns it into one short tag
 * string (`build_tags_v2` in deploy/dgx/music/server/app.py), and on the way
 * it keeps only the first FOUR phrases of the brief, each at most six words,
 * and at most fourteen tags in all. Anything a planner adds past that budget
 * is dropped without a word — which is why a production plan is compiled
 * against this function, and why a Python test asserts this port and the
 * service agree on every request the production benchmark sends
 * (deploy/dgx/music/server/test_bench_production.py).
 *
 * A port, not a design: change app.py and this together, or the parity test
 * fails.
 */
import type { MusicIntent } from './generation.js';

/** `brief` phrases the service keeps, and how long each may be. */
export const ENGINE_BRIEF_PHRASES = 4;
export const ENGINE_PHRASE_WORDS = 6;
export const ENGINE_MAX_TAGS = 14;

/**
 * The word the service's voice detector matches (app.py, _VOICE_WORDS).
 * `auto` is absent: it means "do not ask".
 */
export const VOICE_BRIEF_WORDS: Record<string, string> = {
  female: 'female vocals',
  male: 'male vocals',
  duet: 'duet',
  choir: 'choir',
};

/**
 * The brief as sent: the creator's voice choice named FIRST, because only the
 * first four phrases survive. Moved here from the HTTP adapter so the plan
 * compiler counts the same slots the adapter will use.
 */
export function briefWithVoice(intent: Pick<MusicIntent, 'brief' | 'vocalMode' | 'voice'>): string {
  if (intent.vocalMode === 'instrumental') return intent.brief;
  const word = VOICE_BRIEF_WORDS[intent.voice ?? 'auto'];
  if (!word) return intent.brief;
  if (intent.brief.toLowerCase().includes(word)) return intent.brief;
  return `${word}, ${intent.brief}`.slice(0, 400);
}

// Python's `\b` is Unicode-aware; JavaScript's is ASCII-only. Spelled out so
// `女声` is matched exactly where the service matches it.
const W = '[\\p{L}\\p{N}\\p{M}_]';
const word = (alternatives: string) => new RegExp(`(?<!${W})(?:${alternatives})(?!${W})`, 'iu');
const VOICE_PATTERNS: Array<[RegExp, string]> = [
  [word('female|woman|girl|女声|女性ボーカル'), 'female vocals'],
  [word('male|man|boy|男声|男性ボーカル'), 'male vocals'],
  [word('choir|chorus vocals|合唱'), 'choir'],
  [word('duet|对唱|デュエット'), 'duet'],
];
const FILLER = /^(?:a|an|the|with|and|of|in|for|some|very|little|bit)\s+/i;

/** Every phrase of a brief the service would consider, in order, before the four-phrase cut. */
export function engineBriefPhrases(brief: string): string[] {
  const out: string[] = [];
  for (const raw of brief.trim().split(/[,.;:!?\n]+/)) {
    const frag = raw.trim().toLowerCase().replace(FILLER, '');
    if (frag && frag.split(/\s+/).length <= ENGINE_PHRASE_WORDS) out.push(frag);
  }
  return out;
}

/** The fields of the HTTP body the tag builder reads. */
export interface EngineTagInput {
  style_tags?: string[] | null;
  instruments?: string[] | null;
  prompt?: string | null;
  instrumental?: boolean | null;
  tempo?: string | null;
  energy?: number | null;
}

/** `build_tags_v2`, exactly. */
export function engineTagsV2(req: EngineTagInput): string {
  const tags: string[] = [];
  for (const t of req.style_tags ?? []) tags.push(t.replaceAll('_', ' ').trim());
  for (const t of req.instruments ?? []) tags.push(t.replaceAll('_', ' ').trim());
  const brief = (req.prompt ?? '').trim();
  if (req.instrumental) {
    tags.push('instrumental');
  } else {
    const voice = VOICE_PATTERNS.find(([pattern]) => pattern.test(brief))?.[1];
    tags.push(voice ?? 'lead vocals', 'clear vocals');
  }
  if (req.tempo) {
    tags.push(({ slow: 'slow tempo', medium: 'mid-tempo', fast: 'fast tempo' } as Record<string, string>)[req.tempo]
      ?? `${req.tempo} tempo`);
  }
  if (req.energy !== null && req.energy !== undefined) {
    tags.push(req.energy < 0.35 ? 'mellow' : req.energy > 0.7 ? 'energetic' : '');
  }
  tags.push(...engineBriefPhrases(brief).slice(0, ENGINE_BRIEF_PHRASES));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const k = t.toLowerCase();
    if (t && !seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  return out.slice(0, ENGINE_MAX_TAGS).join(', ');
}
