import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clipShapeProblem, type ClipRequest, type ClipState, type ClipSubmit, type VideoProvider } from './types.js';

/**
 * Clips drawn by ffmpeg's test pattern, in this process: for development and
 * CI, where there is no GPU. It keeps the real service's rules — shape
 * limits, one clip at a time, a bounded queue, idempotency keys, cancels, no
 * audio — so a pipeline tested against it meets the same refusals in
 * production. Jobs live in memory and are gone on restart, as the demo music
 * provider's are.
 */
export interface DemoVideoOptions {
  maxQueue?: number;
  /** Pretend drawing takes this long, so queued and running states can be seen. */
  delayMs?: number;
  ffmpegPath?: string;
}

interface Job {
  id: string;
  sha: string;
  req: ClipRequest;
  state: ClipState;
  bytes?: Buffer;
  cancel: boolean;
}

export class DemoVideoProvider implements VideoProvider {
  readonly kind = 'demo-video';
  private readonly jobs = new Map<string, Job>();
  private readonly keys = new Map<string, string>();
  private readonly order: string[] = [];
  private running = false;
  private readonly opts: Required<DemoVideoOptions>;

  constructor(opts: DemoVideoOptions = {}) {
    this.opts = { maxQueue: opts.maxQueue ?? 8, delayMs: opts.delayMs ?? 100, ffmpegPath: opts.ffmpegPath ?? 'ffmpeg' };
  }

  async submit(req: ClipRequest): Promise<ClipSubmit> {
    const problem = clipShapeProblem(req);
    if (problem) return { status: 'rejected', reason: 'invalid_request', retryable: false, detail: problem };
    const { idempotencyKey, ...shape } = req;
    const sha = createHash('sha256').update(JSON.stringify(shape)).digest('hex');
    const prior = this.keys.get(idempotencyKey);
    if (prior) {
      if (this.jobs.get(prior)!.sha !== sha) return { status: 'rejected', reason: 'idempotency_key_reused', retryable: false };
      return { status: 'accepted', id: prior };
    }
    const open = [...this.jobs.values()].filter((j) => j.state.status === 'queued' || j.state.status === 'running').length;
    if (open >= this.opts.maxQueue) return { status: 'rejected', reason: 'queue_full', retryable: true, detail: `${open} clips waiting` };
    const id = randomUUID().replace(/-/g, '');
    this.jobs.set(id, { id, sha, req, state: { status: 'queued', queuePosition: open }, cancel: false });
    this.keys.set(idempotencyKey, id);
    this.order.push(id);
    void this.drain();
    return { status: 'accepted', id };
  }

  async status(id: string): Promise<ClipState> {
    const job = this.jobs.get(id);
    if (!job) return { status: 'unknown', reason: 'not_found' };
    if (job.state.status === 'queued') {
      const ahead = this.order.indexOf(id);
      return { status: 'queued', queuePosition: Math.max(0, ahead) + (this.running ? 1 : 0) };
    }
    return job.state;
  }

  async cancel(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    job.cancel = true;
    if (job.state.status === 'queued') {
      job.state = { status: 'cancelled' };
      this.order.splice(this.order.indexOf(id), 1);
    }
  }

  async fetchClip(id: string): Promise<Buffer> {
    const job = this.jobs.get(id);
    if (!job || job.state.status !== 'succeeded' || !job.bytes) throw new Error(`clip ${id} has no bytes (${job?.state.status ?? 'unknown'})`);
    return job.bytes;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let id = this.order.shift(); id; id = this.order.shift()) {
        const job = this.jobs.get(id)!;
        if (job.state.status !== 'queued') continue;
        job.state = { status: 'running', queuePosition: null };
        const t0 = Date.now();
        try {
          const step = 20;
          for (let waited = 0; waited < this.opts.delayMs && !job.cancel; waited += step) await new Promise((r) => setTimeout(r, step));
          if (job.cancel) {
            job.state = { status: 'cancelled' };
            continue;
          }
          job.bytes = await this.draw(job.req);
          job.state = job.cancel
            ? { status: 'cancelled' }
            : { status: 'succeeded', clipSeconds: frames(job.req) / (job.req.fps ?? 24), generationSeconds: (Date.now() - t0) / 1000, model: 'demo' };
          if (job.cancel) job.bytes = undefined;
        } catch (err) {
          job.state = { status: 'failed', reason: `demo_ffmpeg: ${(err as Error).message.slice(0, 80)}` };
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async draw(req: ClipRequest): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), 'yuha-demo-clip-'));
    const out = join(dir, 'clip.mp4');
    try {
      await new Promise<void>((resolve, reject) => {
        const p = spawn(this.opts.ffmpegPath, [
          '-loglevel', 'error', '-y', '-f', 'lavfi',
          '-i', `testsrc2=size=${req.width}x${req.height}:rate=${req.fps ?? 24}`,
          '-frames:v', String(frames(req)), '-pix_fmt', 'yuv420p', '-an', out,
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        p.stderr.on('data', (d) => (err += String(d)));
        p.on('error', reject);
        p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `ffmpeg exited ${code}`))));
      });
      return await readFile(out);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** The service rounds frames up to 8k+1 (LTX-style pipelines); the demo draws the same count. */
function frames(req: ClipRequest): number {
  const want = Math.max(1, Math.round(req.seconds * (req.fps ?? 24)));
  return 8 * Math.max(1, Math.ceil((want - 1) / 8)) + 1;
}
