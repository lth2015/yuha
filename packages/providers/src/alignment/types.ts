import type { LyricTimings } from '@yuha/contracts';

/**
 * Lyric alignment contract.
 *
 * Real word-level timing requires a vocal-sync model (forced alignment over
 * the audio) — a text model cannot hear. This seam is where such a model
 * plugs in; until one is configured, the deterministic estimator provides
 * line-level timings honestly labelled `estimated`.
 */
export interface AlignmentRequest {
  lyrics: string;
  /** The audio's verified duration, in seconds. */
  durationSeconds: number;
  /** Provider request id of the generation, for provenance. */
  providerRequestId: string;
  /**
   * The song itself. Sent when the aligner cannot be pointed at its own copy
   * of the render — it keeps those only for days, and YUHA keeps every song.
   */
  audio?: Buffer;
  /**
   * Which aligner the DGX should use for this request (LYRIC_ALIGNER;
   * deploy/dgx/music README, "Qwen3-ForcedAligner"). Absent: its own default.
   * There is deliberately no way to ask for MMS_FA: its weights are non-commercial.
   */
  method?: 'whisper' | 'qwen';
}

export type AlignmentResult =
  | {
      status: 'ok';
      timings: LyricTimings;
      /** Set when these timings are a fallback: why the aligner before it did not answer. */
      fallbackReason?: string;
    }
  | { status: 'failed'; reason: string };

export interface AlignmentProvider {
  readonly kind: string;
  align(req: AlignmentRequest): Promise<AlignmentResult>;
}
