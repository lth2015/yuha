/**
 * A production plan: the decisions a producer makes before a song is
 * rendered — the hook and where it comes back, what each section is for, what
 * carries through, how it ends (docs/MUSIC_PRODUCTION_SPEC.md).
 *
 * The engine cannot take most of this. It takes a short tag string and the
 * lyrics with section markers, nothing per section, no timing, no melody. So
 * the plan is a record of intent, and `compileProductionPlan` lowers the part
 * the engine CAN take into exactly two fields of the intent:
 *
 *   - `brief`: up to two short production phrases, appended into whatever
 *     the service's four-phrase cut leaves free (engine-tags.ts) after the
 *     voice and the brief's own phrases — never displacing one;
 *   - `lyrics`: `[intro]` before and `[outro]` after, known tags only, every
 *     sung line untouched — and not even that for a creator's own lyrics.
 *
 * Everything else about the intent — style, instruments, tempo, energy,
 * voice, length — is left alone, so an A/B comparison changes one variable.
 * Whether the model hears any of it is what the benchmark is for; nothing
 * here claims it does.
 */
import { z } from 'zod';
import type { MusicIntent } from './generation.js';
import {
  ENGINE_BRIEF_PHRASES,
  ENGINE_PHRASE_WORDS,
  briefWithVoice,
  engineBriefPhrases,
  engineTagsV2,
} from './engine-tags.js';
import { canonicalSectionTag, sectionName } from './sections.js';

export const PRODUCTION_TEMPLATES = ['pop', 'ballad'] as const;
export type ProductionTemplate = (typeof PRODUCTION_TEMPLATES)[number];

export const PRODUCTION_SECTION_ROLES = ['intro', 'verse', 'pre-chorus', 'chorus', 'bridge', 'outro'] as const;

const text = (max: number) => z.string().trim().min(1).max(max);

export const productionSection = z.object({
  role: z.enum(PRODUCTION_SECTION_ROLES),
  /** Lyric lines it carries, as indexes into the sung lines (inclusive); null when instrumental. */
  lines: z.tuple([z.number().int().min(0), z.number().int().min(0)]).nullable(),
  /** Share of the song, relative; the audio decides where it really falls. */
  share: z.number().positive().max(1),
  /** What the section is for. */
  job: text(120),
  /** What changes against the section before it. */
  change: text(120),
  /** How it is entered. */
  entry: text(80),
});

export const productionPlan = z.object({
  version: z.literal(1),
  template: z.enum(PRODUCTION_TEMPLATES),
  /** The hook: a short figure on one instrument, stated, sung, and taken back. */
  motif: z.object({ instrument: text(40), idea: text(80) }),
  /** One or two instruments that run through the whole song. */
  coreInstruments: z.array(text(40)).min(1).max(2),
  sections: z.array(productionSection).min(3).max(14),
  ending: text(120),
});
export type ProductionPlan = z.infer<typeof productionPlan>;
export type ProductionSection = z.infer<typeof productionSection>;

const spoken = (instrument: string) => instrument.replaceAll('_', ' ').trim().toLowerCase();

interface Stanza {
  role: ProductionSection['role'];
  lines: [number, number];
}

/** The lyric stanzas, with the section each one's marker names (verse when it names none we plan for). */
function stanzas(lyrics: string): Stanza[] {
  const out: Stanza[] = [];
  let role: ProductionSection['role'] | null = null;
  let start = -1;
  let sung = 0;
  const close = () => {
    if (start >= 0) out.push({ role: role ?? 'verse', lines: [start, sung - 1] });
    start = -1;
  };
  for (const raw of lyrics.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      close();
      role = null;
      continue;
    }
    const name = sectionName(line);
    if (name !== null) {
      close();
      const tag = canonicalSectionTag(name);
      role = (PRODUCTION_SECTION_ROLES as readonly string[]).includes(tag ?? '')
        ? (tag as ProductionSection['role']) : 'verse';
      continue;
    }
    if (start < 0) start = sung;
    sung++;
  }
  close();
  return out;
}

const WORDS: Record<ProductionTemplate, {
  intro: string; outro: string; ending: string;
  job: Record<'verse' | 'pre-chorus' | 'chorus' | 'bridge', string>;
  change: Record<'verse' | 'pre-chorus' | 'chorus' | 'bridge', string>;
}> = {
  pop: {
    intro: 'state the hook alone on the motif instrument',
    outro: 'the motif instrument alone, returning to the hook',
    ending: 'end on the hook, motif instrument alone, no fade',
    job: {
      verse: 'tell the story; leave room for the voice',
      'pre-chorus': 'build tension toward the hook',
      chorus: 'sing the hook in full',
      bridge: 'step aside harmonically before the last chorus',
    },
    change: {
      verse: 'thinner drums, bass sits low',
      'pre-chorus': 'drums gather, harmony climbs',
      chorus: 'bass and drums open up; harmonies on the last one',
      bridge: 'pull the drums back',
    },
  },
  ballad: {
    intro: 'the motif, sparse, on the motif instrument',
    outro: 'the motif again, slower, and let it ring',
    ending: 'resolve on the motif and let the last chord ring',
    job: {
      verse: 'close, intimate voice; the words carry it',
      'pre-chorus': 'breathe in before the chorus',
      chorus: 'open the register; the melody of the motif',
      bridge: 'the quietest point before the last chorus',
    },
    change: {
      verse: 'piano or guitar and voice, little else',
      'pre-chorus': 'a held chord and a breath',
      chorus: 'strings or pad enter; higher register',
      bridge: 'strip back to one instrument',
    },
  },
};

/**
 * The plan a template makes for an intent. The hook goes on the first
 * instrument the intent already has, so the plan adds no instrument.
 */
export function productionPlanFor(template: ProductionTemplate, intent: Pick<MusicIntent, 'instruments' | 'lyrics'>): ProductionPlan {
  const w = WORDS[template];
  const instrument = spoken(intent.instruments[0] ?? 'piano');
  const body = stanzas(intent.lyrics ?? '');
  const share = body.length ? 0.84 / body.length : 0.84;
  const sections: ProductionSection[] = [
    { role: 'intro', lines: null, share: 0.07, job: w.intro, change: 'the hook, alone', entry: 'from silence' },
    ...body.map((s, i): ProductionSection => {
      const role = s.role === 'intro' || s.role === 'outro' ? 'verse' : s.role;
      const last = role === 'chorus' && !body.slice(i + 1).some((b) => b.role === 'chorus');
      return {
        role, lines: s.lines, share: Math.round(share * 100) / 100,
        job: w.job[role], change: last && template === 'pop' ? 'everything in; add harmonies' : w.change[role],
        entry: role === 'chorus' ? 'a drum fill or a held breath' : 'drop the density',
      };
    }),
    { role: 'outro', lines: null, share: 0.09, job: w.outro, change: 'band falls away', entry: 'straight from the last line' },
  ];
  return productionPlan.parse({
    version: 1, template,
    motif: { instrument, idea: template === 'pop' ? 'a four-note hook' : 'a slow two-bar phrase' },
    coreInstruments: [instrument, ...intent.instruments.slice(1, 2).map(spoken)],
    sections, ending: w.ending,
  });
}

/** The phrases a plan puts in front of the engine. Each fits the service's six-word phrase. */
export function productionPhrases(plan: ProductionPlan): string[] {
  const m = plan.motif.instrument;
  return plan.template === 'pop'
    ? [`${m} hook returns in chorus`, 'sparse verse lifts into chorus']
    : [`${m} motif opens and closes`, 'intimate verse swells into chorus'];
}

export type CompileFailure = 'instrumental' | 'no_lyrics' | 'motif_not_in_arrangement' | 'over_budget';

export type CompiledPlan =
  | {
      ok: true;
      intent: MusicIntent;
      report: {
        productionPhrases: string[];
        /** Brief phrases the engine heard before and no longer does. Always empty: the compiler refuses instead. */
        displacedPhrases: string[];
        addedTags: string[];
        /** The tag string the service will build from this intent. */
        engineTags: string;
      };
    }
  | { ok: false; reason: CompileFailure };

const BRIEF_MAX = 400;

/** Lower a plan onto an intent's brief and lyrics, or say why it cannot be. */
export function compileProductionPlan(
  intent: MusicIntent,
  plan: ProductionPlan,
  opts: { creatorLyrics?: boolean } = {},
): CompiledPlan {
  if (intent.vocalMode === 'instrumental') return { ok: false, reason: 'instrumental' };
  if (!intent.lyrics?.trim()) return { ok: false, reason: 'no_lyrics' };
  if (!intent.instruments.map(spoken).includes(spoken(plan.motif.instrument))) {
    return { ok: false, reason: 'motif_not_in_arrangement' };
  }

  const phrases = productionPhrases(plan);
  if (phrases.some((p) => p.split(/\s+/).length > ENGINE_PHRASE_WORDS || /[,.;:!?\n]/.test(p))) {
    return { ok: false, reason: 'over_budget' };
  }
  // Only slots the brief leaves free. The voice the adapter puts first takes
  // one, and every phrase of the brief the engine hears today keeps its place:
  // pushing one out would change what the song is about as well as how it is
  // produced, and the comparison would no longer have one variable. Phrases
  // are in priority order — the hook coming back first.
  const voiced = briefWithVoice(intent) !== intent.brief;
  const own = engineBriefPhrases(intent.brief);
  const room = ENGINE_BRIEF_PHRASES - (voiced ? 1 : 0) - Math.min(own.length, ENGINE_BRIEF_PHRASES);
  const placed = phrases.slice(0, Math.max(0, room));
  if (placed.length === 0) return { ok: false, reason: 'over_budget' };
  const brief = [intent.brief.trim().replace(/[,.;:!?\s]+$/, ''), ...placed].join(', ');
  if (brief.length > BRIEF_MAX) return { ok: false, reason: 'over_budget' };

  let lyrics = intent.lyrics;
  const addedTags: string[] = [];
  if (!opts.creatorLyrics) {
    const lines = lyrics.split(/\r?\n/);
    const firstTag = lines.find((l) => l.trim())?.trim() ?? '';
    const lastTag = [...lines].reverse().find((l) => l.trim())?.trim() ?? '';
    const tagOf = (l: string) => { const n = sectionName(l); return n === null ? null : canonicalSectionTag(n); };
    if (plan.sections[0]?.role === 'intro' && tagOf(firstTag) !== 'intro') {
      lyrics = `[intro]\n\n${lyrics}`;
      addedTags.push('intro');
    }
    if (plan.sections.at(-1)?.role === 'outro' && tagOf(lastTag) !== 'outro') {
      lyrics = `${lyrics.trimEnd()}\n\n[outro]`;
      addedTags.push('outro');
    }
  }

  const compiled: MusicIntent = { ...intent, brief, lyrics };
  const sent = briefWithVoice(compiled);
  const heard = engineBriefPhrases(sent).slice(0, ENGINE_BRIEF_PHRASES);
  if (!placed.every((p) => heard.includes(p))) return { ok: false, reason: 'over_budget' };
  const before = engineBriefPhrases(briefWithVoice(intent)).slice(0, ENGINE_BRIEF_PHRASES);
  const engineTags = engineTagsV2({
    style_tags: compiled.styles, instruments: compiled.instruments, prompt: sent,
    instrumental: false, tempo: compiled.tempoHint, energy: compiled.energy,
  });
  // The fourteen-tag cap comes after the phrases: a long style list can still cut one off.
  const reached = engineTags.split(', ');
  if (!placed.every((p) => reached.includes(p))) return { ok: false, reason: 'over_budget' };
  return {
    ok: true,
    intent: compiled,
    report: { productionPhrases: placed, displacedPhrases: before.filter((p) => !heard.includes(p)), addedTags, engineTags },
  };
}
