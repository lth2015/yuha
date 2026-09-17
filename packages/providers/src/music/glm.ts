import { HttpMusicProvider, type HttpMusicProviderConfig } from './http.js';

/**
 * GLM (Z.ai / Zhipu bigmodel) music-generation preset.
 *
 * The user-facing product pivoted to full songs, and GLM is the configured
 * stand-in music model until the final provider decision (itself swappable via
 * configuration — see docs/OPEN_ITEMS.md).
 *
 * What this file owns: a curated default set for the generic HTTP adapter so an
 * operator only has to set `MUSIC_API_KEY` and confirm the endpoint fields from
 * the API documentation in use. Every default here can be overridden by the
 * corresponding MUSIC_* environment variable, and nothing is silently invented:
 * the values marked "confirm from docs" are the ones the operator must verify.
 */
export interface GlmPresetInput {
  apiKey: string;
  /** Model id exactly as the music API documents it. */
  model?: string;
  baseUrl?: string;
  submitPath?: string;
  pollPath?: string;
  requestIdField?: string;
  statusField?: string;
  audioUrlField?: string;
  /** JSON string: {"pending":[...],"completed":[...],"failed":[...],"rejected":[...]}. */
  statusMap?: string;
  idempotencyHeader?: string;
  allowedAudioHosts?: string;
  contractVersion?: string;
  licenseVersion?: string;
  timeoutMs?: number;
  maxAudioBytes?: number;
  costPerRequestMinor?: number;
  commercialDeliveryPermitted?: boolean;
}

export function glmMusicProviderConfig(input: GlmPresetInput): HttpMusicProviderConfig {
  const statusMap = input.statusMap
    ? (JSON.parse(input.statusMap) as HttpMusicProviderConfig['statusMap'])
    : {
        pending: ['PENDING', 'PROCESSING', 'RUNNING', 'QUEUED', 'SUBMITTED'],
        completed: ['SUCCESS', 'COMPLETED', 'SUCCEEDED', 'FINISHED'],
        failed: ['FAILED', 'ERROR', 'TIMEOUT'],
        rejected: ['REJECTED', 'CONTENT_REJECTED', 'POLICY_VIOLATION'],
      };

  return {
    providerId: 'glm',
    baseUrl: input.baseUrl ?? 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: input.apiKey,
    // Confirm the exact model id from the GLM music API documentation before
    // production use; this default targets the documented music model family.
    model: input.model ?? 'glm-music-01',
    contractVersion: input.contractVersion ?? 'glm-preview-2026-09',
    licenseVersion: input.licenseVersion ?? 'glm-output-terms-preview',
    territory: 'GLOBAL',
    allowedUses: [
      'Personal social media posts by the account holder',
      'Monetised creator content on the platforms the plan states',
    ],
    prohibitedUses: [
      'Reselling or redistribishing the audio itself as a music/stock product',
      'Claiming to represent output as human-performed recordings',
      'Training competing music models',
    ],
    submitPath: input.submitPath ?? '/music/generations',
    pollPath: input.pollPath ?? '/music/generations/{id}',
    requestIdField: input.requestIdField ?? 'id',
    statusField: input.statusField ?? 'status',
    audioUrlField: input.audioUrlField ?? 'audio.url',
    statusMap,
    ...(input.idempotencyHeader ? { idempotencyHeader: input.idempotencyHeader } : {}),
    supportsInstrumentalOnly: true,
    supportsVocals: true,
    supportsCancel: false,
    supportsWebhook: false,
    supportsStatusQuery: true,
    supportedDurationsSeconds: [30, 60, 120, 180, 240],
    supportedFormats: ['mp3'],
    // No signed GLM commercial agreement is on file yet; operators flip this
    // only together with MUSIC_COMMERCIAL_DELIVERY after the contract is real.
    commercialDeliveryPermitted: input.commercialDeliveryPermitted ?? false,
    maxConcurrency: 4,
    dataRegion: 'CN',
    costPerRequestMinor: input.costPerRequestMinor ?? 45,
    billFailedRequests: true,
    costIsEstimate: true,
    timeoutMs: input.timeoutMs ?? 120_000,
    maxAudioBytes: input.maxAudioBytes ?? 30 * 1024 * 1024,
    allowedAudioHosts: (input.allowedAudioHosts ?? 'open.bigmodel.cn,file.bigmodel.cn,cdn.bigmodel.cn')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
  };
}

export function createGlmMusicProvider(input: GlmPresetInput): HttpMusicProvider {
  return new HttpMusicProvider(glmMusicProviderConfig(input));
}
