import { z } from 'zod';
import type { MusicIntent } from './generation.js';

/**
 * AI BGM (docs/BGM_STUDIO_PLAN.md): instrumental background music for a
 * video, made by the song pipeline from these choices.
 *
 * The music model is told what was chosen through a deterministic template,
 * not through the text model: every choice is pinned to words the model
 * receives (tests/bgm.test.ts), and nothing is claimed that is not sent.
 * Tempo in particular is a hint in words — ACE-Step takes no BPM — and the
 * page says "tempo feel", never a number.
 */
export const BGM_SCENARIOS = ['travel', 'food', 'pet', 'vlog', 'ad', 'tech', 'holiday'] as const;
export const BGM_GENRES = ['japanese_healing', 'lofi', 'jazz', 'pop', 'ambient', 'electronic', 'cinematic'] as const;
export const BGM_MOODS = ['warm', 'romantic', 'cheerful', 'calm', 'energetic', 'mysterious'] as const;
export const BGM_TEMPOS = ['slow', 'medium', 'fast'] as const;
/** 15 s is rendered directly; the DGX takes 10–240 s (deploy/dgx/music/server/app.py MIN_DUR). */
export const BGM_DURATIONS = [15, 30, 60] as const;
export const BGM_NOTE_MAX = 300;

export const bgmRequest = z.object({
  scenario: z.enum(BGM_SCENARIOS),
  genre: z.enum(BGM_GENRES),
  mood: z.enum(BGM_MOODS),
  durationSeconds: z.union([z.literal(15), z.literal(30), z.literal(60)]),
  tempo: z.enum(BGM_TEMPOS).default('medium'),
  /** Optional words of the creator's own; screened, and turned into English by the text model, never sent raw. */
  note: z.string().max(BGM_NOTE_MAX).default(''),
});
export type BgmRequest = z.infer<typeof bgmRequest>;

/** The defaults the page opens with (PRD 3.2). */
export const BGM_DEFAULTS: BgmRequest = {
  scenario: 'vlog',
  genre: 'japanese_healing',
  mood: 'warm',
  durationSeconds: 30,
  tempo: 'medium',
  note: '',
};

const SCENARIO_WORDS: Record<(typeof BGM_SCENARIOS)[number], string> = {
  travel: 'a travel video, open and bright',
  food: 'a food and cooking video, cozy',
  pet: 'a pet video, light and playful',
  vlog: 'a daily vlog, unobtrusive',
  ad: 'a product advertisement, polished and clean',
  tech: 'a technology product video, modern and precise',
  holiday: 'a festive holiday video',
};

const GENRES: Record<(typeof BGM_GENRES)[number], { styles: string[]; instruments: string[]; words: string }> = {
  japanese_healing: { styles: ['japanese healing', 'acoustic'], instruments: ['acoustic guitar', 'piano', 'glockenspiel'], words: 'gentle Japanese healing acoustic' },
  lofi: { styles: ['lo-fi', 'chillhop'], instruments: ['dusty drums', 'electric piano', 'bass'], words: 'lo-fi chillhop' },
  jazz: { styles: ['jazz', 'smooth jazz'], instruments: ['upright bass', 'piano', 'brushed drums'], words: 'smooth jazz' },
  pop: { styles: ['pop', 'upbeat pop'], instruments: ['synth', 'electric guitar', 'drums'], words: 'bright pop' },
  ambient: { styles: ['ambient'], instruments: ['warm pad', 'soft synth', 'texture'], words: 'airy ambient' },
  electronic: { styles: ['electronic'], instruments: ['synth bass', 'drum machine', 'arpeggiator'], words: 'clean electronic' },
  cinematic: { styles: ['cinematic', 'orchestral'], instruments: ['strings', 'piano', 'soft percussion'], words: 'cinematic orchestral' },
};

/** The intent's own mood vocabulary (enums.ts Mood) and the word the model hears. */
const MOODS: Record<(typeof BGM_MOODS)[number], { mood: MusicIntent['mood']; word: string }> = {
  warm: { mood: 'warm', word: 'warm' },
  romantic: { mood: 'dreamy', word: 'romantic' },
  cheerful: { mood: 'playful', word: 'cheerful' },
  calm: { mood: 'calm', word: 'calm' },
  energetic: { mood: 'uplifting', word: 'energetic' },
  mysterious: { mood: 'tense', word: 'mysterious' },
};

const TEMPO_ENERGY: Record<(typeof BGM_TEMPOS)[number], number> = { slow: 0.2, medium: 0.5, fast: 0.85 };
const TEMPO_WORDS: Record<(typeof BGM_TEMPOS)[number], string> = { slow: 'slow', medium: 'mid', fast: 'fast' };

const SCENARIO_TITLES: Record<(typeof BGM_SCENARIOS)[number], string> = {
  travel: 'Travel', food: 'Food', pet: 'Pet', vlog: 'Vlog', ad: 'Ad', tech: 'Tech', holiday: 'Holiday',
};
const GENRE_TITLES: Record<(typeof BGM_GENRES)[number], string> = {
  japanese_healing: 'Healing', lofi: 'Lo-fi', jazz: 'Jazz', pop: 'Pop', ambient: 'Ambient', electronic: 'Electronic', cinematic: 'Cinematic',
};

/** The music intent for a BGM, from its choices alone. */
export function bgmIntent(bgm: BgmRequest): MusicIntent {
  const g = GENRES[bgm.genre];
  const m = MOODS[bgm.mood];
  const brief =
    `Instrumental background music for ${SCENARIO_WORDS[bgm.scenario]}. ${g.words}, ${m.word} mood, ${TEMPO_WORDS[bgm.tempo]} tempo. ` +
    'Steady groove, soft intro, clean natural ending, no vocals, sits under narration without competing for attention.';
  return {
    scene: 'daily_log',
    mood: m.mood,
    energy: TEMPO_ENERGY[bgm.tempo],
    tempoHint: bgm.tempo,
    instruments: g.instruments,
    durationSeconds: bgm.durationSeconds,
    vocalMode: 'instrumental',
    voice: 'auto',
    styles: [...g.styles, m.word],
    brief: brief.slice(0, 400),
    lyrics: null,
    title: `${SCENARIO_TITLES[bgm.scenario]} BGM · ${GENRE_TITLES[bgm.genre]}`,
  };
}
