import { isIP } from 'node:net';
import { fetchAudio, isPublicAddress } from '../net/fetch-audio.js';
import { clipShapeProblem, type ClipRequest, type ClipState, type ClipSubmit, type VideoProvider } from './types.js';

/**
 * The clip service on the video box (deploy/dgx/video, its README has the API).
 *
 * HTTPS only. The music box is reached over plain HTTP under an explicit
 * production exception (deploy/PRODUCTION_CUTOVER.md); this one is not,
 * because what goes over the wire here is a person's description of a
 * picture, and what comes back is put in front of them. `allowInsecureLocal`
 * exists for a service on this machine or this network during development
 * and tests, and refuses a public address even then.
 *
 * The clip's bytes are fetched only from the host this provider was given,
 * through the same guarded fetcher as music audio: allow-listed host, no
 * redirects, a size cap, a timeout.
 */
export interface HttpVideoConfig {
  baseUrl: string;
  apiKey: string;
  /** Permit plain http to a loopback or private address. Never in production. */
  allowInsecureLocal?: boolean;
  timeoutMs?: number;
  /** A 10-second 1280-edge clip is a few MB; this is a ceiling, not an estimate. */
  maxClipBytes?: number;
}

type Raw = Record<string, unknown>;

export class HttpVideoProvider implements VideoProvider {
  readonly kind = 'dgx-video';
  private readonly base: URL;
  private readonly insecure: boolean;
  private readonly cfg: HttpVideoConfig;

  constructor(cfg: HttpVideoConfig) {
    let base: URL;
    try {
      base = new URL(cfg.baseUrl);
    } catch {
      throw new Error('VIDEO_BASE_URL is not a valid URL');
    }
    const host = base.hostname.replace(/^\[|\]$/g, '');
    const local = host === 'localhost' || (isIP(host) !== 0 && !isPublicAddress(host));
    this.insecure = base.protocol === 'http:';
    if (base.protocol !== 'https:' && !(this.insecure && cfg.allowInsecureLocal && local)) {
      throw new Error('VIDEO_BASE_URL must use https (plain http is allowed only to a local address, in development)');
    }
    if (!cfg.apiKey) throw new Error('VIDEO_API_KEY is required');
    this.base = base;
    this.cfg = cfg;
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ code: number; json: Raw } | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 15_000);
    try {
      const res = await fetch(new URL(path, this.base), {
        method,
        headers: { authorization: `Bearer ${this.cfg.apiKey}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        redirect: 'error',
      });
      return { code: res.status, json: ((await res.json().catch(() => ({}))) ?? {}) as Raw };
    } catch {
      return null; // refused, reset, timed out, redirected: the service could not be asked
    } finally {
      clearTimeout(timer);
    }
  }

  async submit(req: ClipRequest): Promise<ClipSubmit> {
    const problem = clipShapeProblem(req);
    if (problem) return { status: 'rejected', reason: 'invalid_request', retryable: false, detail: problem };
    const r = await this.call(
      'POST',
      '/v1/clips',
      {
        prompt: req.prompt,
        negative_prompt: req.negativePrompt ?? '',
        width: req.width,
        height: req.height,
        seconds: req.seconds,
        fps: req.fps ?? 24,
        ...(req.seed !== undefined ? { seed: req.seed } : {}),
      },
      { 'idempotency-key': req.idempotencyKey },
    );
    if (!r) return { status: 'rejected', reason: 'unavailable', retryable: true, detail: 'unreachable' };
    const detail = typeof r.json.detail === 'string' ? r.json.detail.slice(0, 200) : undefined;
    if ((r.code === 200 || r.code === 202) && typeof r.json.id === 'string') return { status: 'accepted', id: r.json.id };
    if (r.code === 401) return { status: 'rejected', reason: 'unauthorized', retryable: false };
    if (r.code === 409) return { status: 'rejected', reason: 'idempotency_key_reused', retryable: false, detail };
    if (r.code === 422) return { status: 'rejected', reason: 'invalid_request', retryable: false, detail };
    if (r.code === 429) return { status: 'rejected', reason: 'queue_full', retryable: true, detail };
    return { status: 'rejected', reason: 'unavailable', retryable: true, detail: `http_${r.code}` };
  }

  private async raw(id: string): Promise<{ state: ClipState; clipUrl?: string }> {
    if (!/^[0-9a-zA-Z]{1,64}$/.test(id)) return { state: { status: 'unknown', reason: 'not_found' } };
    const r = await this.call('GET', `/v1/clips/${id}`);
    if (!r) return { state: { status: 'unknown', reason: 'unreachable' } };
    if (r.code === 401) return { state: { status: 'unknown', reason: 'unauthorized' } };
    if (r.code !== 200) return { state: { status: 'unknown', reason: r.code === 404 ? 'not_found' : 'unreachable' } };
    const j = r.json;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    switch (j.status) {
      case 'queued':
      case 'running':
        return { state: { status: j.status, queuePosition: num(j.queue_position) } };
      case 'succeeded':
        return {
          state: { status: 'succeeded', clipSeconds: num(j.clip_seconds) ?? 0, generationSeconds: num(j.generation_seconds), model: typeof j.model === 'string' ? j.model : null },
          clipUrl: typeof j.clip_url === 'string' ? j.clip_url : undefined,
        };
      case 'cancelled':
        return { state: { status: 'cancelled' } };
      case 'failed':
        return { state: { status: 'failed', reason: typeof j.error === 'string' ? j.error.slice(0, 64) : 'failed' } };
      default:
        return { state: { status: 'unknown', reason: 'unreachable' } };
    }
  }

  async status(id: string): Promise<ClipState> {
    return (await this.raw(id)).state;
  }

  async cancel(id: string): Promise<void> {
    if (/^[0-9a-zA-Z]{1,64}$/.test(id)) await this.call('POST', `/v1/clips/${id}/cancel`);
  }

  async fetchClip(id: string): Promise<Buffer> {
    // A fresh signed link each time: the one from an earlier poll may have expired.
    const { state, clipUrl } = await this.raw(id);
    if (state.status !== 'succeeded' || !clipUrl) throw new Error(`clip ${id} has no bytes (${state.status})`);
    return fetchAudio(clipUrl, {
      allowedHosts: [this.base.hostname],
      allowedContentTypes: ['video/mp4'],
      maxBytes: this.cfg.maxClipBytes ?? 50 * 1024 * 1024,
      timeoutMs: this.cfg.timeoutMs ?? 60_000,
      allowInsecureSelfHosted: this.insecure,
    });
  }
}
