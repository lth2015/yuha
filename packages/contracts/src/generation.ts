import { z } from 'zod';
import { AudioFormat, JobPhase, JobState, Mood, Scene, TempoHint, TrackState, Visibility, VocalMode } from './enums.js';

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

export const CreateMode = z.enum(['simple', 'custom']);
export type CreateMode = z.infer<typeof CreateMode>;

/** UI-03 heritage: counted by Unicode code point, never by UTF-16 unit. */
export const PROMPT_MAX_CODEPOINTS = 500;
export const LYRICS_MAX_CODEPOINTS = 3000;
export const TITLE_MAX_CODEPOINTS = 120;
export const MAX_STYLE_TAGS = 6;

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

export const titleSchema = z
  .string()
  .trim()
  .min(1)
  .refine((v) => [...v].length <= TITLE_MAX_CODEPOINTS, {
    message: `title must be at most ${TITLE_MAX_CODEPOINTS} Unicode code points`,
  });

export const styleTagSchema = z
  .string()
  .trim()
  .min(1)
  .max(40, 'each style tag is at most 40 characters');

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
    /** 0..1, coarse energy slider. */
    energy: z.number().min(0).max(1).default(0.5),
    durationSeconds: songDurationSchema.default(120),
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
  playCount: z.number().int().nonnegative(),
  likeCount: z.number().int().nonnegative(),
  /** Present on every authenticated read; null for anonymous Explore visits. */
  likedByMe: z.boolean().nullable(),
  /** Deterministic seed for the generated cover art. */
  coverSeed: z.number().int(),
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

export const exploreQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(24),
  sort: z.enum(['trending', 'new']).default('trending'),
  vocal: z.enum(['instrumental', 'vocals']).optional(),
  q: z.string().max(100).optional(),
});
export type ExploreQuery = z.infer<typeof exploreQuery>;

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
