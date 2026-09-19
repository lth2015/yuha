import type { LyricTimings } from '@loopscene/contracts';

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
}

export type AlignmentResult =
  | { status: 'ok'; timings: LyricTimings }
  | { status: 'failed'; reason: string };

export interface AlignmentProvider {
  readonly kind: string;
  align(req: AlignmentRequest): Promise<AlignmentResult>;
}
