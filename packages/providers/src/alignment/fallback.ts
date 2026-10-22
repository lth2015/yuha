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
    try {
      const primary = await this.primary.align(req);
      if (primary.status === 'ok') return primary;
    } catch {
      // An unavailable adapter must not make a vocal track look lyric-less.
      // The fallback retains honest provenance (`estimated`).
    }
    return this.fallback.align(req);
  }
}
