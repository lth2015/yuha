import { z } from 'zod';
import { AudioFormat, JobPhase, JobState, Mood, Scene, TempoHint, TrackState, Visibility, VocalMode, VoiceChoice } from './enums.js';
import { SECTION_GAP_SECONDS, sectionName } from './sections.js';

/**
 * Song creation contract (Suno-class product scope).
 *
 * Two creation modes:
 *  - `simple`  — a natural-language description; the platform writes the brief
 *                (and the lyrics, when vocals are on).
 *  - `custom`  — the creator supplies lyrics and style tags directly.
 *
 * Durations are provider-capability-gated: the request states what the creator
 * wants, `POST /v1/generations` rejects what the configured provider cannot
 * actually deliver (AI-05).
 */
export const SONG_DURATIONS = [30, 60, 120, 180, 240] as const;
export type SongDuration = (typeof SONG_DURATIONS)[number];

/** zod enums are string-keyed; a literal union is the number-valued equivalent. */
const songDurationSchema = z.union([
  z.literal(30),
  z.literal(60),
  z.literal(120),
  z.literal(180),
  z.literal(240),
]);

/**
 * Let the song be as long as the words need.
 *
 * The creator had to name a length before writing a line, and the four on
 * offer are not lengths anybody knows in advance — "is this a 2:00 song or a
 * 3:00 song" is a question about an arrangement that does not exist yet. With
 * `auto` the length is read off the lyrics instead.
 *
 * Deterministic on purpose, rather than another model call: the same
 * per-line budget the intent prompt uses to *write* lyrics is the one used
 * here to *measure* them, so a song written to fit and a song measured to fit
 * agree. Section markers are not sung but an interlude still takes time, so
 * each one costs a gap. The result is the shortest offered length that holds
 * the words; if nothing does, the longest, because a song cut short is worse
 * than one with room to breathe.
 */
export function fitDurationToLyrics(
  lyrics: string,
  secondsPerLine: number,
  supported: readonly number[] = SONG_DURATIONS,
): number {
  const options = [...supported].sort((a, b) => a - b);
  const longest = options[options.length - 1]!;
  const fallback = options.includes(120) ? 120 : longest;

  let sung = 0;
  let markers = 0;
  for (const raw of lyrics.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (sectionName(line) !== null) markers += 1;
    else sung += 1;
  }
  if (sung === 0) return fallback;

  // Lead-in and tail-out match the timeline's own edges, so the words are not
  // laid out tighter than they will be sung.
  const needed = sung * secondsPerLine + markers * SECTION_GAP_SECONDS + 3 + 4;
  return options.find((d) => d >= needed) ?? longest;
}

export const CreateMode = z.enum(['simple', 'custom']);
export type CreateMode = z.infer<typeof CreateMode>;

/** UI-03 heritage: counted by Unicode code point, never by UTF-16 unit. */
export const PROMPT_MAX_CODEPOINTS = 500;
export const LYRICS_MAX_CODEPOINTS = 3000;
export const TITLE_MAX_CODEPOINTS = 120;
export const MAX_STYLE_TAGS = 6;
export const STYLE_TAG_MAX_LENGTH = 40;

/**
 * The three states `energy` actually has.
 *
 * It travels as a float because that is the shape the music service accepts,
 * but on arrival it is compressed into one of three words — see build_tags_v2
 * in deploy/dgx/music/server/app.py:
 *
 *   e < 0.35 -> "mellow"   |   e > 0.7 -> "energetic"   |   otherwise -> nothing
 *
 * and the text provider turns the same number into a tempo hint at its own
 * boundaries. A 0..1 slider therefore offered a hundred positions for three
 * outcomes, and its default — 0.5 — sat in the band that contributes nothing
 * at all: moving it anywhere from 35% to 70% changed not one character of what
 * the model was asked for. `http.ts` carries a note (AI-05) that we do not
 * pretend a control was honoured just because the creator set it locally; a
 * percentage readout on a three-state control is that same pretence, in
 * resolution rather than in kind.
 *
 * One value per band, each chosen to clear both the word and the tempo
 * threshold at once, so the choice is audible twice over.
 */
export const ENERGY_LEVELS = [
  { id: 'mellow', value: 0.2 },
  { id: 'medium', value: 0.5 },
  { id: 'strong', value: 0.85 },
] as const;

export type EnergyLevelId = (typeof ENERGY_LEVELS)[number]['id'];

export const promptSchema = z
  .string()
  .trim()
  .refine((v) => [...v].length <= PROMPT_MAX_CODEPOINTS, {
    message: `prompt must be at most ${PROMPT_MAX_CODEPOINTS} Unicode code points`,
  });

export const lyricsSchema = z
  .string()
  .trim()
  .refine((v) => [...v].length <= LYRICS_MAX_CODEPOINTS, {
    message: `lyrics must be at most ${LYRICS_MAX_CODEPOINTS} Unicode code points`,
  });

/**
 * A title is one line, however it was pasted.
 *
 * It is rendered in an `h1`, in the browser tab and in a link preview, and a
 * newline survives into all three and breaks each one differently. `.trim()`
 * alone only took the ends off. Collapsing runs of whitespace is done here
 * rather than at a route so that both doors into this field — the title given
 * at generation and a later rename — cannot disagree about it.
 */
export const titleSchema = z
  .string()
  .transform((v) => v.replace(/\s+/g, ' ').trim())
  .refine((v) => v.length > 0, { message: 'title must not be blank' })
  .refine((v) => [...v].length <= TITLE_MAX_CODEPOINTS, {
    message: `title must be at most ${TITLE_MAX_CODEPOINTS} Unicode code points`,
  });

export const renameTrackRequest = z.object({ title: titleSchema });
export type RenameTrackRequest = z.infer<typeof renameTrackRequest>;

export const styleTagSchema = z
  .string()
  .trim()
  .min(1)
  .max(STYLE_TAG_MAX_LENGTH, `each style tag is at most ${STYLE_TAG_MAX_LENGTH} characters`);

export const createGenerationRequest = z
  .object({
    projectId: z.string().uuid().optional(),
    mode: CreateMode.default('simple'),
    title: titleSchema.optional(),
    prompt: promptSchema.default(''),
    lyrics: lyricsSchema.optional(),
    styles: z.array(styleTagSchema).max(MAX_STYLE_TAGS).default([]),
    /** When true the song has no vocals; when false the provider sings the lyrics. */
    instrumental: z.boolean().default(false),
    /**
     * 0..1, but only three bands of it are distinguishable downstream — see
     * ENERGY_LEVELS. Kept a float because that is what the music service
     * accepts, so narrowing it here would force a redeploy of that service to
     * change nothing a listener can hear.
     */
    energy: z.number().min(0).max(1).default(0.5),
    /** A named length, or `auto` to take it from the lyrics (fitDurationToLyrics). */
    durationSeconds: z.union([songDurationSchema, z.literal('auto')]).default(120),
    voice: VoiceChoice.default('auto'),
    visibility: Visibility.default('private'),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'simple' && !v.prompt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['prompt'],
        message: 'a description is required in simple mode',
      });
    }
    if (v.mode === 'custom' && v.instrumental && !v.prompt && v.styles.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['styles'],
        message: 'custom instrumental needs a description or at least one style tag',
      });
    }
  });
export type CreateGenerationRequest = z.infer<typeof createGenerationRequest>;

/**
 * The 202 body is the full job view plus `deduplicated`, so the client can
 * render the progress screen immediately without a second round trip.
 */
export const createGenerationResponse = z.object({
  jobId: z.string().uuid(),
  projectId: z.string().uuid(),
  state: JobState,
  phase: JobPhase,
  /** true when an existing job was returned for a replayed idempotency key. */
  deduplicated: z.boolean(),
});
export type CreateGenerationResponse = z.infer<typeof createGenerationResponse>;

/**
 * Structured intent produced by the text model and then re-validated server
 * side. AI-03: the model never decides billing, entitlement or licence state,
 * so nothing money-related appears in this schema.
 */
export const musicIntent = z.object({
  scene: Scene,
  mood: Mood,
  energy: z.number().min(0).max(1),
  tempoHint: TempoHint,
  instruments: z.array(z.string().min(1).max(32)).min(1).max(6),
  durationSeconds: z.number().int().positive(),
  vocalMode: VocalMode,
  /**
   * Who sings it. Defaulted rather than required: the text model does not
   * choose this — the creator does, and the pipeline writes their choice over
   * whatever the model returned.
   */
  voice: VoiceChoice.default('auto'),
  /** Style tags echoed to the provider and shown on the song card. */
  styles: z.array(z.string().min(1).max(40)).max(MAX_STYLE_TAGS),
  /** Short English brief handed to the music provider. Never the raw user text. */
  brief: z.string().min(1).max(400),
  /** Custom-mode lyrics, passed through only after the same safety screening. */
  lyrics: z.string().max(LYRICS_MAX_CODEPOINTS).nullable(),
  /** Title chosen at intent time; the user's own title (if any) wins. */
  title: z.string().max(TITLE_MAX_CODEPOINTS).nullable(),
});
export type MusicIntent = z.infer<typeof musicIntent>;

export const jobEstimate = z.object({
  /** Inclusive range in seconds. UI-04 forbids a fabricated precise percentage. */
  minSeconds: z.number().int().nonnegative(),
  maxSeconds: z.number().int().nonnegative(),
  delayed: z.boolean(),
});

export const jobView = z.object({
  jobId: z.string().uuid(),
  projectId: z.string().uuid(),
  state: JobState,
  phase: JobPhase,
  mode: CreateMode,
  title: z.string().nullable(),
  prompt: z.string(),
  styles: z.array(z.string()),
  instrumental: z.boolean(),
  energy: z.number(),
  durationSeconds: z.number(),
  visibility: Visibility,
  trackId: z.string().uuid().nullable(),
  errorCode: z.string().nullable(),
  estimate: jobEstimate,
  createdAt: z.string(),
  updatedAt: z.string(),
  /** true while the run mode is demo, so the UI can keep the banner visible. */
  demo: z.boolean(),
});
export type JobView = z.infer<typeof jobView>;

/**
 * Lyric timing data for synced display.
 *
 * `source` is the honesty label: 'aligned' comes from a real vocal-sync model
 * (forced alignment over the audio), 'estimated' is our deterministic
 * weighting of lines across the song length. The UI shows which one it has.
 */
export const lyricTimings = z.object({
  /**
   * Where the numbers came from, best first.
   *
   * `corrected` outranks both: a person heard the song and moved the line, so
   * it is the only one of the three that is not a model's opinion. A
   * re-alignment must never overwrite it.
   */
  source: z.enum(['corrected', 'aligned', 'estimated']),
  lines: z
    .array(
      z.object({
        text: z.string(),
        section: z.string(),
        start: z.number().nonnegative(),
        end: z.number().nonnegative(),
        /** Word-level segments, when the alignment model provides them. */
        words: z
          .array(z.object({ w: z.string(), start: z.number().nonnegative(), end: z.number().nonnegative() }))
          .optional(),
      }),
    )
    .max(200),
  /** Model/procedure that produced the timings, recorded for provenance. */
  aligner: z.string().max(64),
});
export type LyricTimings = z.infer<typeof lyricTimings>;

export const trackView = z.object({
  trackId: z.string().uuid(),
  projectId: z.string().uuid(),
  jobId: z.string().uuid(),
  title: z.string(),
  /** Display name of the creator (Explore cards); null falls back to "You". */
  artistName: z.string().nullable(),
  artistId: z.string().uuid(),
  state: TrackState,
  scene: Scene,
  mood: Mood.nullable(),
  styles: z.array(z.string()),
  vocalMode: VocalMode,
  visibility: Visibility,
  durationSeconds: z.number(),
  /*
   * No `playCount`. It is still counted in `tracks.play_count` and still
   * incremented by POST /v1/explore/:id/plays, because operations needs to
   * know what is actually listened to. It is deliberately absent from the
   * view a client receives: a number that cannot reach the browser cannot
   * be rendered back onto a song page by a later change.
   */
  /** Deterministic seed for the generated cover art. */
  coverSeed: z.number().int(),
  /** Timings for synced lyrics; null when the song has no lyrics. */
  lyricTimings: lyricTimings.nullable(),
  /** How many people licensed this song on the Market. */
  licenseCount: z.number().int().nonnegative(),
  /** True when the viewer has bought a license for this song (download rights). */
  licensedByMe: z.boolean().nullable(),
  createdAt: z.string(),
  /** Short-lived preview URL; re-issued on each read (SEC-04). */
  previewUrl: z.string().nullable(),
  demo: z.boolean(),
});
export type TrackView = z.infer<typeof trackView>;

export const listTracksQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  state: TrackState.optional(),
  q: z.string().max(100).optional(),
  projectId: z.string().uuid().optional(),
});

export const listTracksResponse = z.object({
  items: z.array(trackView),
  nextCursor: z.string().nullable(),
});

export const exploreResponse = z.object({
  items: z.array(trackView),
  nextCursor: z.string().nullable(),
});
export type ExploreResponse = z.infer<typeof exploreResponse>;

/**
 * Trimming and re-downloads never cost a credit (UI-06 heritage). Clip length
 * is now any 5s..duration window rather than the fixed 15/30 pair, because
 * song length is creator-chosen.
 */
export const MIN_CLIP_SECONDS = 5;

export const createExportRequest = z
  .object({
    clipStartSeconds: z.number().min(0),
    clipDurationSeconds: z.number().int().min(MIN_CLIP_SECONDS),
    fadeOut: z.boolean().default(false),
    format: AudioFormat.default('mp3'),
  })
  .superRefine((v, ctx) => {
    if (v.clipStartSeconds + v.clipDurationSeconds > 240) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['clipDurationSeconds'],
        message: 'clip window exceeds the maximum song length',
      });
    }
  });
export type CreateExportRequest = z.infer<typeof createExportRequest>;

export const exportView = z.object({
  exportId: z.string().uuid(),
  trackId: z.string().uuid(),
  format: AudioFormat,
  clipStartSeconds: z.number(),
  clipDurationSeconds: z.number(),
  fadeOut: z.boolean(),
  byteSize: z.number().int(),
  sha256: z.string(),
  downloadUrl: z.string(),
  downloadUrlExpiresAt: z.string(),
  /** true when an identical export already existed and was reused. */
  reused: z.boolean(),
});
export type ExportView = z.infer<typeof exportView>;

export const cancelJobResponse = z.object({
  jobId: z.string().uuid(),
  state: JobState,
  cancelled: z.boolean(),
  /** Explains the outcome when cancellation lost the race to the worker. */
  reason: z.string().nullable(),
});

export const setVisibilityRequest = z.object({ visibility: Visibility });
export type SetVisibilityRequest = z.infer<typeof setVisibilityRequest>;
