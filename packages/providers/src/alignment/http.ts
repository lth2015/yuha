import type { LyricTimings } from '@loopscene/contracts';
import type { AlignmentProvider, AlignmentRequest, AlignmentResult } from './types.js';

/**
 * Configurable forced-alignment adapter — where a real vocal-sync model
 * plugs in.
 *
 * Like the HTTP music adapter, no vendor endpoint is invented: submit path,
 * auth header and the JSON pointers for line/word timings all come from
 * configuration, filled in from the model's documentation. If the mapping is
 * absent, the adapter refuses to construct rather than guessing.
 *
 * Expected response shape (extracted via configurable dot-paths):
 *   lines[].{text|start|end}, optional lines[].words[].{w|start|end}
 */
export interface HttpAlignmentConfig {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  /** POST path; receives {lyrics, audio_url, duration_seconds}. */
  submitPath: string;
  /** Path to the lines array in the JSON response. */
  linesField: string;
  lineTextField: string;
  lineStartField: string;
  lineEndField: string;
  wordsField?: string;
  wordTextField?: string;
  wordStartField?: string;
  wordEndField?: string;
  sectionField?: string;
  timeoutMs?: number;
  /** Where the rendered audio can be fetched by the aligner. */
  audioUrlResolver: (params: { providerRequestId: string }) => string | null;
}

export class HttpAlignmentProvider implements AlignmentProvider {
  readonly kind: string;
  private readonly cfg: HttpAlignmentConfig;

  constructor(cfg: HttpAlignmentConfig) {
    if (!cfg.linesField) throw new Error('ALIGNMENT_LINES_FIELD must be configured from the model documentation');
    this.cfg = cfg;
    this.kind = cfg.providerId;
  }

  async align(req: AlignmentRequest): Promise<AlignmentResult> {
    const audioUrl = this.cfg.audioUrlResolver({ providerRequestId: req.providerRequestId });
    if (!audioUrl) return { status: 'failed', reason: 'no audio url available for alignment' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 60_000);
    try {
      const res = await fetch(new URL(this.cfg.submitPath, this.cfg.baseUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${this.cfg.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ lyrics: req.lyrics, audio_url: audioUrl, duration_seconds: req.durationSeconds }),
        signal: controller.signal,
        redirect: 'error',
      });
      if (!res.ok) return { status: 'failed', reason: `aligner_http_${res.status}` };
      const json = (await res.json()) as Record<string, unknown>;

      const read = (obj: unknown, path: string): unknown =>
        path.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), obj);

      const rawLines = read(json, this.cfg.linesField);
      if (!Array.isArray(rawLines) || !rawLines.length) {
        return { status: 'failed', reason: 'aligner response had no lines' };
      }
      const lines: LyricTimings['lines'] = [];
      for (const raw of rawLines.slice(0, 200)) {
        const text = read(raw, this.cfg.lineTextField);
        const start = read(raw, this.cfg.lineStartField);
        const end = read(raw, this.cfg.lineEndField);
        if (typeof text !== 'string' || typeof start !== 'number' || typeof end !== 'number') {
          return { status: 'failed', reason: 'aligner line missing text/start/end' };
        }
        const section = this.cfg.sectionField ? read(raw, this.cfg.sectionField) : undefined;
        const rawWords = this.cfg.wordsField ? read(raw, this.cfg.wordsField) : undefined;
        const words =
          Array.isArray(rawWords) && this.cfg.wordTextField && this.cfg.wordStartField && this.cfg.wordEndField
            ? rawWords
                .map((w) => {
                  const ww = read(w, this.cfg.wordTextField!);
                  const ws = read(w, this.cfg.wordStartField!);
                  const we = read(w, this.cfg.wordEndField!);
                  return typeof ww === 'string' && typeof ws === 'number' && typeof we === 'number'
                    ? { w: ww, start: ws, end: we }
                    : null;
                })
                .filter((w): w is { w: string; start: number; end: number } => w !== null)
            : undefined;
        lines.push({
          text,
          section: typeof section === 'string' ? section : '',
          start,
          end,
          ...(words && words.length ? { words } : {}),
        });
      }
      return { status: 'ok', timings: { source: 'aligned', lines, aligner: this.cfg.providerId } };
    } catch (err) {
      return { status: 'failed', reason: (err as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }
}
