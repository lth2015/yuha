import type { AlignmentProvider, AlignmentRequest, AlignmentResult } from './types.js';

/**
 * Keeps lyrics visible when a real aligner is temporarily unavailable or
 * rejects a weak vocal match.  The fallback remains explicitly `estimated`;
 * it never represents guessed timing as audio-derived alignment.
 */
export class FallbackAlignmentProvider implements AlignmentProvider {
  readonly kind: string;

  constructor(
    private readonly primary: AlignmentProvider,
    private readonly fallback: AlignmentProvider,
  ) {
    this.kind = `${primary.kind}+${fallback.kind}`;
  }

  async align(req: AlignmentRequest): Promise<AlignmentResult> {
    let why: string;
    try {
      const primary = await this.primary.align(req);
      if (primary.status === 'ok') return primary;
      why = primary.reason;
    } catch (err) {
      // An unavailable adapter must not make a vocal track look lyric-less.
      // The fallback retains honest provenance (`estimated`).
      why = `aligner_threw: ${(err as Error).message}`;
    }
    /*
     * The reason travels with the fallback's result. It was dropped, and the
     * worker logs only a result that is not ok, so a song shown as estimated
     * left no trace of whether the aligner timed out, heard too little, or
     * was down.
     */
    const fallback = await this.fallback.align(req);
    return fallback.status === 'ok' ? { ...fallback, fallbackReason: why } : fallback;
  }
}
