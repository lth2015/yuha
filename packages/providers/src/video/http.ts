import { isIP } from 'node:net';
import { fetchAudio, isPublicAddress } from '../net/fetch-audio.js';
import { clipRequestProblem, type ClipRequest, type ClipState, type ClipSubmit, type VideoProvider } from './types.js';

/**
 * The video service on dgxv, as the product owner described it (2026-11-26):
 *
 *   POST /v1/videos                {prompt, duration, orientation, mute} → id
 *   GET  /v1/videos/{id}           queued | running | succeeded | failed
 *   GET  /v1/videos/{id}/content   the MP4
 *   GET  /health                   no key
 *   every other request: header X-API-Key
 *
 * Unverified until a real call: the names of the response fields. The id is
 * read from `id` (or `job_id`), the failure from `error` (or `detail`), the
 * queue position from `queue_position` when present. The first request
 * against the real box should be checked against this.
 *
 * HTTPS by default, with two narrow exceptions, each off unless configured:
 *   - `allowInsecureLocal`: plain http to this machine or network, for
 *     development and tests; a public address is refused.
 *   - `allowInsecureSelfHosted`: plain http to the box's public IP, the
 *     exception the music box runs under (deploy/PRODUCTION_CUTOVER.md),
 *     chosen by the product owner for the proof of concept. An IP literal
 *     only: a hostname can be repointed by DNS. What it gives up: prompts,
 *     the key and the clips cross the network unencrypted, so the firewall
 *     admitting only YUHA's egress addresses is what protects the service.
 *
 * Clip bytes are fetched only from the base host, through the guarded
 * fetcher: no redirects, a size cap, a timeout.
 */
export interface HttpVideoConfig {
  baseUrl: string;
  apiKey: string;
  allowInsecureLocal?: boolean;
  allowInsecureSelfHosted?: boolean;
  timeoutMs?: number;
  /** An 8-second clip is a few MB; this is a ceiling, not an estimate. */
  maxClipBytes?: number;
}

type Raw = Record<string, unknown>;
const ID = /^[0-9A-Za-z_-]{1,64}$/;

export class HttpVideoProvider implements VideoProvider {
  readonly kind = 'dgx-video';
  private readonly base: URL;
  private readonly insecure: boolean;
  private readonly local: boolean;
  private readonly cfg: HttpVideoConfig;

  constructor(cfg: HttpVideoConfig) {
    let base: URL;
    try {
      base = new URL(cfg.baseUrl);
    } catch {
      throw new Error('VIDEO_BASE_URL is not a valid URL');
    }
    const host = base.hostname.replace(/^\[|\]$/g, '');
    this.local = host === 'localhost' || (isIP(host) !== 0 && !isPublicAddress(host));
    const publicIp = isIP(host) !== 0 && isPublicAddress(host);
    this.insecure = base.protocol === 'http:';
    const allowed = (cfg.allowInsecureLocal && this.local) || (cfg.allowInsecureSelfHosted && publicIp);
    if (base.protocol !== 'https:' && !(this.insecure && allowed)) {
      throw new Error(
        'VIDEO_BASE_URL must use https; plain http is allowed only to a local address in development, ' +
          'or to a public IP literal with VIDEO_ALLOW_INSECURE_SELF_HOSTED',
      );
    }
    if (!cfg.apiKey) throw new Error('VIDEO_API_KEY is required');
    this.base = base;
    this.cfg = cfg;
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ code: number; json: Raw } | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 15_000);
    try {
      const res = await fetch(new URL(path, this.base), {
        method,
        headers: { 'x-api-key': this.cfg.apiKey, ...(body ? { 'content-type': 'application/json' } : {}) },
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
    const problem = clipRequestProblem(req);
    if (problem) return { status: 'rejected', reason: 'invalid_request', retryable: false, detail: problem };
    const r = await this.call('POST', '/v1/videos', {
      prompt: req.prompt,
      duration: req.seconds,
      orientation: req.orientation,
      mute: true,
    });
    if (!r) return { status: 'rejected', reason: 'unavailable', retryable: true, detail: 'unreachable' };
    const id = typeof r.json.id === 'string' ? r.json.id : typeof r.json.job_id === 'string' ? r.json.job_id : null;
    const detail = typeof r.json.detail === 'string' ? r.json.detail.slice(0, 200) : typeof r.json.error === 'string' ? r.json.error.slice(0, 200) : undefined;
    if (r.code >= 200 && r.code < 300 && id && ID.test(id)) return { status: 'accepted', id };
    if (r.code === 401 || r.code === 403) return { status: 'rejected', reason: 'unauthorized', retryable: false };
    if (r.code === 400 || r.code === 422) return { status: 'rejected', reason: 'invalid_request', retryable: false, detail };
    if (r.code === 429 || r.code === 503) return { status: 'rejected', reason: 'queue_full', retryable: true, detail };
    return { status: 'rejected', reason: 'unavailable', retryable: true, detail: `http_${r.code}` };
  }

  async status(id: string): Promise<ClipState> {
    if (!ID.test(id)) return { status: 'unknown', reason: 'not_found' };
    const r = await this.call('GET', `/v1/videos/${id}`);
    if (!r) return { status: 'unknown', reason: 'unreachable' };
    if (r.code === 401 || r.code === 403) return { status: 'unknown', reason: 'unauthorized' };
    if (r.code === 404) return { status: 'unknown', reason: 'not_found' };
    if (r.code !== 200) return { status: 'unknown', reason: 'unreachable' };
    const j = r.json;
    switch (j.status) {
      case 'queued':
      case 'running':
        return { status: j.status, queuePosition: typeof j.queue_position === 'number' ? j.queue_position : null };
      case 'succeeded':
        return { status: 'succeeded' };
      case 'failed': {
        // A fixed code, never the service's prose: a message can quote the prompt.
        const why = `${typeof j.error === 'string' ? j.error : ''} ${typeof j.detail === 'string' ? j.detail : ''}`;
        return { status: 'failed', reason: failureCode(why) };
      }
      default:
        return { status: 'unknown', reason: 'unreachable' };
    }
  }

  async fetchClip(id: string): Promise<Buffer> {
    if (!ID.test(id)) throw new Error('not a clip id');
    return fetchAudio(new URL(`/v1/videos/${id}/content`, this.base).toString(), {
      allowedHosts: [this.base.hostname],
      allowedContentTypes: ['video/mp4', 'application/octet-stream'],
      maxBytes: this.cfg.maxClipBytes ?? 50 * 1024 * 1024,
      timeoutMs: this.cfg.timeoutMs ?? 60_000,
      allowInsecureSelfHosted: this.insecure,
      allowPrivateAddresses: this.local,
      headers: { 'x-api-key': this.cfg.apiKey },
    });
  }
}

/** What the service said went wrong, as one of a few codes; its words are not kept. */
export function failureCode(message: string): string {
  if (/out of memory|\boom\b|cuda.*memory/i.test(message)) return 'out_of_memory';
  if (/time ?out|timed out/i.test(message)) return 'timeout';
  if (/thermal|temperature|too hot/i.test(message)) return 'thermal';
  if (/safety|nsfw|blocked|refus/i.test(message)) return 'refused_by_model';
  return 'service_failed';
}
