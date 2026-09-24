import type { AudioFormat, MusicIntent } from '@yuha/contracts';

/**
 * Music provider adapter contract (AI-04).
 *
 * The interface deliberately separates *capabilities* from *requests*: the API
 * only exposes controls that `capabilities()` reports as genuinely supported,
 * so we never present a duration or an instrumental-only guarantee that the
 * upstream cannot actually honour (AI-05).
 */
export interface MusicCapabilities {
  providerId: string;
  model: string;
  /** Commercial agreement version in force. Frozen into each licence snapshot. */
  contractVersion: string;
  supportedDurationsSeconds: number[];
  supportedFormats: AudioFormat[];
  /** Whether the provider can be asked for instrumental-only output. */
  supportsInstrumentalOnly: boolean;
  /** Whether the provider can sing supplied lyrics. Gates vocal requests (AI-05). */
  supportsVocals: boolean;
  /** Whether a stable request key deduplicates upstream (drives GEN-06 handling). */
  supportsIdempotencyKey: boolean;
  supportsCancel: boolean;
  supportsWebhook: boolean;
  supportsStatusQuery: boolean;
  /** Set false until a signed agreement permits delivering output commercially. */
  commercialDeliveryPermitted: boolean;
  maxConcurrency: number;
  /** Where the provider states it processes data. Surfaced in the privacy page. */
  dataRegion: string;
  licenseVersion: string;
  territory: string;
  allowedUses: string[];
  prohibitedUses: string[];
  /** Per-request modelled cost. `isEstimate` marks a budget assumption, not a quote. */
  costPerRequestMinor: number;
  billFailedRequests: boolean;
  costIsEstimate: boolean;
}

export interface MusicSubmitRequest {
  intent: MusicIntent;
  /** Stable per-job key. Reused verbatim on any retry (GEN-06). */
  requestKey: string;
  format: AudioFormat;
}

export type MusicSubmitResult =
  | { status: 'submitted'; providerRequestId: string }
  | { status: 'completed'; providerRequestId: string; audio: MusicAudioRef }
  | { status: 'rejected'; providerRequestId: string | null; code: string; message: string }
  | { status: 'failed'; providerRequestId: string | null; code: string; message: string }
  /**
   * The request may or may not have been accepted upstream. The worker moves the
   * job to UNKNOWN and verifies rather than blindly resubmitting (GEN-06).
   */
  | { status: 'unknown'; providerRequestId: string | null; code: string; message: string };

export type MusicPollResult =
  | { status: 'pending' }
  | { status: 'completed'; audio: MusicAudioRef }
  | { status: 'rejected'; code: string; message: string }
  | { status: 'failed'; code: string; message: string }
  /** The provider has no record of this request key. */
  | { status: 'not_found' };

export interface MusicAudioRef {
  /** Either an inline buffer (demo/local) or a URL to fetch under SSRF guards. */
  kind: 'buffer' | 'url';
  buffer?: Buffer;
  url?: string;
  format: AudioFormat;
  /** Provider-declared duration; verified locally before delivery (AI-07). */
  declaredDurationSeconds?: number;
  providerRequestId: string;
}

export interface MusicProvider {
  capabilities(): MusicCapabilities;
  submit(req: MusicSubmitRequest): Promise<MusicSubmitResult>;
  /** Queries by the stable request key or provider request id. */
  poll(params: { requestKey: string; providerRequestId?: string | null }): Promise<MusicPollResult>;
  /** Only called when `supportsCancel` is true. */
  cancel?(params: { requestKey: string; providerRequestId?: string | null }): Promise<boolean>;
}
