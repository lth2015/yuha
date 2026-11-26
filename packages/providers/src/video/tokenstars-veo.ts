import { isIP } from 'node:net';
import { fetchAudio, isPublicAddress } from '../net/fetch-audio.js';
import { failureCode } from './http.js';
import { clipRequestProblem, type ClipRequest, type ClipState, type ClipSubmit, type VideoProvider } from './types.js';

/**
 * Google Veo 3.1 through TokenStars (docs/VEO_VIA_TOKENSTARS.md, read from
 * docs.tokenstars.ai on 2026-11-26; the spec is docs/AI_SCENE_MV_VEO_SPEC.md).
 *
 *   POST /v1/video/generations         {model, prompt, size, aspect_ratio, duration, generate_audio} → task_id
 *   GET  /v1/video/generations/{id}    data.status queued | processing | succeeded | failed; data.url, data.error
 *   Authorization: Bearer <the TokenStars key YUHA already uses for text>
 *
 * Every request is the cheap one the spec allows, whatever the caller asks:
 * 720p, 9:16, no generated audio (the MV uses the song's own), a duration Veo
 * draws (4/6/8 s), and only the models the product owner enabled. Billing is
 * per second of video, so these are the cost controls, not preferences.
 *
 * What TokenStars does not offer, and what that means here:
 *   - no idempotency key: a submit that goes unanswered is `uncertain`, never
 *     retried automatically — it may be running and billed;
 *   - no cancel: `discard` does nothing; a clip already asked for is drawn;
 *   - no free health endpoint for video: `health` lists models (no generation).
 *
 * Unverified until the first paid smoke test: whether `data.url` redirects
 * elsewhere (redirects are refused, so a redirect would fail the fetch loudly)
 * and the exact response field names beyond the documented examples.
 */
export const VEO_MODELS = ['veo-3.1-lite-generate-001', 'veo-3.1-fast-generate-001'] as const;
export type VeoModel = (typeof VEO_MODELS)[number];

export interface TokenStarsVeoConfig {
  /** Documented: https://www.tokenstars.ai */
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  maxClipBytes?: number;
  /** Plain http to this machine, for tests. */
  allowInsecureLocal?: boolean;
}

type Raw = Record<string, unknown>;
const ID = /^[0-9A-Za-z_-]{1,96}$/;

export class TokenStarsVeoProvider implements VideoProvider {
  readonly kind = 'tokenstars-veo';
  readonly durations = [4, 6, 8] as const;
  private readonly base: URL;
  private readonly local: boolean;
  private readonly cfg: TokenStarsVeoConfig;

  constructor(cfg: TokenStarsVeoConfig) {
    if (!(VEO_MODELS as readonly string[]).includes(cfg.model)) {
      throw new Error(`VEO_MODEL must be one of ${VEO_MODELS.join(', ')}`);
    }
    const base = new URL(cfg.baseUrl);
    const host = base.hostname;
    this.local = host === 'localhost' || (isIP(host) !== 0 && !isPublicAddress(host));
    if (base.protocol !== 'https:' && !(cfg.allowInsecureLocal && this.local)) {
      throw new Error('TOKENSTARS_BASE_URL must use https');
    }
    if (!cfg.apiKey) throw new Error('TOKENSTARS_API_KEY is required');
    this.base = base;
    this.cfg = cfg;
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ code: number; json: Raw } | { error: 'timeout' | 'network' }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 30_000);
    try {
      const res = await fetch(new URL(path, this.base), {
        method,
        headers: { authorization: `Bearer ${this.cfg.apiKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        redirect: 'error',
      });
      return { code: res.status, json: ((await res.json().catch(() => ({}))) ?? {}) as Raw };
    } catch (err) {
      return { error: (err as Error).name === 'AbortError' ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
    }
  }

  async submit(req: ClipRequest): Promise<ClipSubmit> {
    const problem = clipRequestProblem(req);
    if (problem) return { status: 'rejected', reason: 'invalid_request', retryable: false, detail: problem };
    if (!(this.durations as readonly number[]).includes(req.seconds)) {
      return { status: 'rejected', reason: 'invalid_request', retryable: false, detail: 'Veo draws 4, 6 or 8 seconds' };
    }
    const r = await this.call('POST', '/v1/video/generations', {
      model: this.cfg.model,
      prompt: req.prompt,
      size: '720p',
      aspect_ratio: '9:16',
      duration: req.seconds,
      generate_audio: false,
    });
    // Sent, then nothing came back: it may be running and billed. Not "try again".
    if ('error' in r) return { status: 'rejected', reason: 'uncertain', retryable: false, detail: r.error };
    const id = [r.json.task_id, r.json.id].find((v): v is string => typeof v === 'string' && ID.test(v));
    if (r.code >= 200 && r.code < 300 && id) return { status: 'accepted', id };
    if (r.code >= 200 && r.code < 300) return { status: 'rejected', reason: 'uncertain', retryable: false, detail: 'accepted without an id' };
    if (r.code === 401 || r.code === 403) return { status: 'rejected', reason: 'unauthorized', retryable: false };
    if (r.code === 400 || r.code === 422) return { status: 'rejected', reason: 'invalid_request', retryable: false };
    // 402: the account's balance. Nothing to retry until someone tops it up.
    if (r.code === 402) return { status: 'rejected', reason: 'unavailable', retryable: false, detail: 'insufficient_balance' };
    if (r.code === 429) return { status: 'rejected', reason: 'queue_full', retryable: true };
    // A 5xx after the body was sent could still have been accepted upstream.
    if (r.code >= 500) return { status: 'rejected', reason: 'unavailable', retryable: true, detail: `http_${r.code}` };
    return { status: 'rejected', reason: 'unavailable', retryable: false, detail: `http_${r.code}` };
  }

  private async poll(id: string): Promise<{ state: ClipState; url?: string }> {
    if (!ID.test(id)) return { state: { status: 'unknown', reason: 'not_found' } };
    const r = await this.call('GET', `/v1/video/generations/${id}`);
    if ('error' in r) return { state: { status: 'unknown', reason: 'unreachable' } };
    if (r.code === 401 || r.code === 403) return { state: { status: 'unknown', reason: 'unauthorized' } };
    if (r.code === 404) return { state: { status: 'unknown', reason: 'not_found' } };
    if (r.code !== 200) return { state: { status: 'unknown', reason: 'unreachable' } };
    const d = (r.json.data && typeof r.json.data === 'object' ? r.json.data : r.json) as Raw;
    switch (d.status) {
      case 'queued':
        return { state: { status: 'queued', queuePosition: null } };
      case 'processing':
      case 'running':
        return { state: { status: 'running', queuePosition: null } };
      case 'succeeded':
        return { state: { status: 'succeeded' }, url: typeof d.url === 'string' ? d.url : undefined };
      case 'failed': {
        const why = typeof d.error === 'string' ? d.error : '';
        // A code, never the words: an error can quote the prompt.
        return { state: { status: 'failed', reason: /SafetyFilter|content policy/i.test(why) ? 'refused_by_model' : failureCode(why) } };
      }
      default:
        return { state: { status: 'unknown', reason: 'unreachable' } };
    }
  }

  async status(id: string): Promise<ClipState> {
    return (await this.poll(id)).state;
  }

  async fetchClip(id: string): Promise<Buffer> {
    // A fresh link each time: the one from an earlier poll may have expired (24 h).
    const { state, url } = await this.poll(id);
    if (state.status !== 'succeeded' || !url) throw new Error(`clip ${id} has no bytes (${state.status})`);
    return fetchAudio(url, {
      allowedHosts: [this.base.hostname],
      allowedContentTypes: ['video/mp4', 'application/octet-stream'],
      maxBytes: this.cfg.maxClipBytes ?? 60 * 1024 * 1024,
      timeoutMs: this.cfg.timeoutMs ?? 60_000,
      allowInsecureSelfHosted: this.local,
      allowPrivateAddresses: this.local,
      headers: { authorization: `Bearer ${this.cfg.apiKey}` },
    });
  }

  /** TokenStars documents no cancel or delete for video: a clip asked for is drawn, and kept there per its terms. */
  async discard(): Promise<void> {}

  async health(): Promise<{ ok: boolean; queued: number | null }> {
    // Listing models costs nothing; generating anything would.
    const r = await this.call('GET', '/v1/models');
    return { ok: !('error' in r) && r.code === 200, queued: null };
  }
}
