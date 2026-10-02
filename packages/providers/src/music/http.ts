import { z } from 'zod';
import { withCanonicalSections, type MusicIntent } from '@yuha/contracts';
import type {
  MusicCapabilities,
  MusicPollResult,
  MusicProvider,
  MusicSubmitRequest,
  MusicSubmitResult,
} from './types.js';
import { rewriteAudioOrigin } from './audio-url.js';

/**
 * Configurable HTTP music-provider adapter.
 *
 * PROJECT_TASK.md §3.2 forbids inventing a vendor's endpoint paths, model ids
 * or response shapes. No such details are hard-coded here: every path and every
 * JSON pointer comes from configuration that an operator fills in from the
 * signed API documentation. If the mapping is absent the adapter refuses to
 * construct, rather than guessing and reporting a fabricated integration.
 *
 * What IS encoded here is our own side of the contract: a stable idempotency
 * key, bounded timeouts, no user-supplied URLs, and error classification into
 * the four outcomes the job state machine understands.
 */
export const httpMusicProviderConfig = z.object({
  providerId: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  contractVersion: z.string().min(1),
  licenseVersion: z.string().min(1),
  territory: z.string().min(1),
  allowedUses: z.array(z.string()),
  prohibitedUses: z.array(z.string()),

  /** Paths relative to baseUrl, taken from the provider's own documentation. */
  submitPath: z.string().min(1),
  pollPath: z.string().min(1),
  cancelPath: z.string().optional(),

  /** Dot-paths into the provider's JSON response. Supplied, never guessed. */
  requestIdField: z.string().min(1),
  statusField: z.string().min(1),
  audioUrlField: z.string().min(1),
  /**
   * Optional `from-origin=>to-origin`, for a service whose audio links carry an
   * address only its own network can reach. See music/audio-url.ts.
   */
  audioUrlRewrite: z.string().optional(),
  /** Provider status strings mapped onto our vocabulary. */
  statusMap: z.object({
    pending: z.array(z.string()),
    completed: z.array(z.string()),
    failed: z.array(z.string()),
    rejected: z.array(z.string()),
  }),
  /** Header name for an upstream idempotency key, when the provider supports one. */
  idempotencyHeader: z.string().optional(),

  supportsInstrumentalOnly: z.boolean(),
  supportsVocals: z.boolean().default(true),
  supportsCancel: z.boolean(),
  supportsWebhook: z.boolean(),
  supportsStatusQuery: z.boolean(),
  supportedDurationsSeconds: z.array(z.number().int().positive()).min(1),
  supportedFormats: z.array(z.enum(['mp3', 'wav'])).min(1),
  /** Only true once a signed agreement covers delivering output to end users. */
  commercialDeliveryPermitted: z.boolean(),
  maxConcurrency: z.number().int().positive(),
  dataRegion: z.string(),
  costPerRequestMinor: z.number().int().nonnegative(),
  billFailedRequests: z.boolean(),
  costIsEstimate: z.boolean(),
  timeoutMs: z.number().int().positive().default(60_000),
  /** Maximum bytes we will pull from the provider's audio URL (SEC-05). */
  maxAudioBytes: z.number().int().positive().default(25 * 1024 * 1024),
  /** Hosts we will fetch audio from. Anything else is refused (SEC-05). */
  allowedAudioHosts: z.array(z.string().min(1)).min(1),
});

export type HttpMusicProviderConfig = z.infer<typeof httpMusicProviderConfig>;

function readPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

/**
 * The English words the music service recognises as a voice.
 *
 * It finds them by scanning the production brief with word-boundary regexes
 * (deploy/dgx/music/server/app.py, _VOICE_WORDS) and emits the matching tag.
 * So the way to ask for a duet is to make sure the brief says "duet" — which
 * means a creator can choose one without that service being redeployed.
 *
 * `auto` is absent on purpose: it means "do not ask", and the service then
 * tags a generic lead vocal exactly as it did before this existed.
 */
const VOICE_WORDS: Record<string, string> = {
  female: 'female vocals',
  male: 'male vocals',
  duet: 'duet',
  choir: 'choir',
};

function briefWithVoice(intent: MusicIntent): string {
  if (intent.vocalMode === 'instrumental') return intent.brief;
  const word = VOICE_WORDS[intent.voice ?? 'auto'];
  if (!word) return intent.brief;
  if (intent.brief.toLowerCase().includes(word)) return intent.brief;
  // Prepended, not appended: the tag builder keeps only the first four
  // phrases of the brief, so a voice added at the end can fall off the back.
  // Still capped at the brief's contract maximum.
  return `${word}, ${intent.brief}`.slice(0, 400);
}

export class HttpMusicProvider implements MusicProvider {
  private readonly cfg: HttpMusicProviderConfig;

  constructor(cfg: HttpMusicProviderConfig) {
    this.cfg = httpMusicProviderConfig.parse(cfg);
  }

  capabilities(): MusicCapabilities {
    const c = this.cfg;
    return {
      providerId: c.providerId,
      model: c.model,
      contractVersion: c.contractVersion,
      supportedDurationsSeconds: c.supportedDurationsSeconds,
      supportedFormats: c.supportedFormats,
      supportsInstrumentalOnly: c.supportsInstrumentalOnly,
      supportsVocals: c.supportsVocals,
      supportsIdempotencyKey: !!c.idempotencyHeader,
      supportsCancel: c.supportsCancel && !!c.cancelPath,
      supportsWebhook: c.supportsWebhook,
      supportsStatusQuery: c.supportsStatusQuery,
      commercialDeliveryPermitted: c.commercialDeliveryPermitted,
      maxConcurrency: c.maxConcurrency,
      dataRegion: c.dataRegion,
      licenseVersion: c.licenseVersion,
      territory: c.territory,
      allowedUses: c.allowedUses,
      prohibitedUses: c.prohibitedUses,
      costPerRequestMinor: c.costPerRequestMinor,
      billFailedRequests: c.billFailedRequests,
      costIsEstimate: c.costIsEstimate,
    };
  }

  private async call(
    path: string,
    init: { method: string; body?: unknown; idempotencyKey?: string },
  ): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
    const url = new URL(path, this.cfg.baseUrl);
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.cfg.apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (init.idempotencyKey && this.cfg.idempotencyHeader) {
      headers[this.cfg.idempotencyHeader] = init.idempotencyKey;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const res = await fetch(url, {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
        redirect: 'error',
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { ok: res.ok, status: res.status, json, text: text.slice(0, 2000) };
    } finally {
      clearTimeout(timer);
    }
  }

  private classify(status: string): 'pending' | 'completed' | 'failed' | 'rejected' | 'unrecognised' {
    const m = this.cfg.statusMap;
    if (m.pending.includes(status)) return 'pending';
    if (m.completed.includes(status)) return 'completed';
    if (m.rejected.includes(status)) return 'rejected';
    if (m.failed.includes(status)) return 'failed';
    return 'unrecognised';
  }

  async submit(req: MusicSubmitRequest): Promise<MusicSubmitResult> {
    // Only parameters the provider actually supports are sent. AI-05: we do not
    // pretend a control was honoured just because the user set it locally.
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      duration_seconds: req.intent.durationSeconds,
      prompt: briefWithVoice(req.intent),
      tempo: req.intent.tempoHint,
      energy: req.intent.energy,
      instruments: req.intent.instruments,
      style_tags: req.intent.styles,
      format: req.format,
    };
    if (req.intent.vocalMode === 'instrumental' && this.cfg.supportsInstrumentalOnly) {
      body['instrumental'] = true;
    } else if (this.cfg.supportsVocals) {
      body['instrumental'] = false;
      // The creator's own markers stay on the song page; the model is given
      // the English tags it was prompted with. `[高潮部分]` means nothing to
      // it, `[chorus]` does, and an unrecognised marker is passed through
      // rather than guessed at.
      if (req.intent.lyrics) body['lyrics'] = withCanonicalSections(req.intent.lyrics);
    }

    let res;
    try {
      res = await this.call(this.cfg.submitPath, {
        method: 'POST',
        body,
        idempotencyKey: req.requestKey,
      });
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError';
      // A timeout is genuinely ambiguous — the provider may have accepted the
      // request. GEN-06: report unknown so the worker verifies instead of
      // re-submitting a possibly-billable request.
      return {
        status: aborted ? 'unknown' : 'failed',
        providerRequestId: null,
        code: aborted ? 'upstream_timeout' : 'upstream_unreachable',
        message: (err as Error).message,
      };
    }

    if (res.status === 429 || res.status >= 500) {
      return {
        status: 'unknown',
        providerRequestId: null,
        code: `upstream_${res.status}`,
        message: 'upstream busy or unavailable',
      };
    }
    if (!res.ok) {
      return {
        status: res.status === 422 || res.status === 400 ? 'rejected' : 'failed',
        providerRequestId: null,
        code: `upstream_${res.status}`,
        message: res.text,
      };
    }

    const requestId = readPath(res.json, this.cfg.requestIdField);
    if (typeof requestId !== 'string' || !requestId) {
      return {
        status: 'unknown',
        providerRequestId: null,
        code: 'upstream_response_unmapped',
        message: `requestIdField "${this.cfg.requestIdField}" not present in the response`,
      };
    }

    const statusRaw = readPath(res.json, this.cfg.statusField);
    if (typeof statusRaw === 'string') {
      const kind = this.classify(statusRaw);
      if (kind === 'completed') {
        const audioUrl = readPath(res.json, this.cfg.audioUrlField);
        if (typeof audioUrl === 'string') {
          return {
            status: 'completed',
            providerRequestId: requestId,
            audio: {
              kind: 'url',
              url: rewriteAudioOrigin(audioUrl, this.cfg.audioUrlRewrite),
              format: req.format,
              providerRequestId: requestId,
            },
          };
        }
      }
      if (kind === 'rejected') {
        return { status: 'rejected', providerRequestId: requestId, code: statusRaw, message: res.text };
      }
      if (kind === 'failed') {
        return { status: 'failed', providerRequestId: requestId, code: statusRaw, message: res.text };
      }
    }
    return { status: 'submitted', providerRequestId: requestId };
  }

  async poll(params: { requestKey: string; providerRequestId?: string | null }): Promise<MusicPollResult> {
    if (!this.cfg.supportsStatusQuery) return { status: 'pending' };
    const ref = params.providerRequestId ?? params.requestKey;
    const path = this.cfg.pollPath.replace('{id}', encodeURIComponent(ref));
    let res;
    try {
      res = await this.call(path, { method: 'GET' });
    } catch {
      return { status: 'pending' };
    }
    if (res.status === 404) return { status: 'not_found' };
    if (!res.ok) return { status: 'pending' };

    const statusRaw = readPath(res.json, this.cfg.statusField);
    if (typeof statusRaw !== 'string') return { status: 'pending' };
    switch (this.classify(statusRaw)) {
      case 'completed': {
        const audioUrl = readPath(res.json, this.cfg.audioUrlField);
        if (typeof audioUrl !== 'string') {
          return { status: 'failed', code: 'upstream_missing_audio_url', message: 'completed without an audio url' };
        }
        return {
          status: 'completed',
          audio: {
            kind: 'url',
            url: rewriteAudioOrigin(audioUrl, this.cfg.audioUrlRewrite),
            format: 'mp3',
            providerRequestId: ref,
          },
        };
      }
      case 'rejected':
        return { status: 'rejected', code: statusRaw, message: res.text };
      case 'failed':
        return { status: 'failed', code: statusRaw, message: res.text };
      default:
        return { status: 'pending' };
    }
  }

  async cancel(params: { requestKey: string; providerRequestId?: string | null }): Promise<boolean> {
    if (!this.cfg.cancelPath || !this.cfg.supportsCancel) return false;
    const ref = params.providerRequestId ?? params.requestKey;
    const path = this.cfg.cancelPath.replace('{id}', encodeURIComponent(ref));
    try {
      const res = await this.call(path, { method: 'POST' });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Hosts this provider is allowed to serve audio from — enforced by the fetcher. */
  allowedAudioHosts(): string[] {
    return this.cfg.allowedAudioHosts;
  }

  maxAudioBytes(): number {
    return this.cfg.maxAudioBytes;
  }
}
