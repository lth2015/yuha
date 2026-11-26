import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clipRequestProblem, type ClipRequest, type ClipState, type ClipSubmit, type VideoProvider } from './types.js';

/**
 * Clips drawn by ffmpeg's test pattern, in this process: for development and
 * CI, where there is no GPU. It keeps the dgxv service's rules — 1–8 seconds,
 * an orientation, one clip at a time, a bounded queue, no audio — so a
 * pipeline tested against it meets the same refusals in production. Jobs
 * live in memory and are gone on restart, as the demo music provider's are.
 *
 * `failNext` makes the next clips fail, so the pipeline's retries can be tested.
 */
export interface DemoVideoOptions {
  maxQueue?: number;
  /** Pretend drawing takes this long, so queued and running states can be seen. */
  delayMs?: number;
  ffmpegPath?: string;
}

const SIZE = { portrait: [288, 512], landscape: [512, 288] } as const;

interface Job {
  req: ClipRequest;
  state: ClipState;
  bytes?: Buffer;
}

export class DemoVideoProvider implements VideoProvider {
  readonly kind = 'demo-video';
  private readonly jobs = new Map<string, Job>();
  private readonly order: string[] = [];
  private running = false;
  private readonly opts: Required<DemoVideoOptions>;
  /** How many of the next clips to fail, and with what. */
  failNext: { count: number; reason: string } = { count: 0, reason: 'out_of_memory' };
  /** Every request made, for tests to inspect. */
  readonly submitted: ClipRequest[] = [];

  constructor(opts: DemoVideoOptions = {}) {
    this.opts = { maxQueue: opts.maxQueue ?? 8, delayMs: opts.delayMs ?? 100, ffmpegPath: opts.ffmpegPath ?? 'ffmpeg' };
  }

  async submit(req: ClipRequest): Promise<ClipSubmit> {
    const problem = clipRequestProblem(req);
    if (problem) return { status: 'rejected', reason: 'invalid_request', retryable: false, detail: problem };
    const open = [...this.jobs.values()].filter((j) => j.state.status === 'queued' || j.state.status === 'running').length;
    if (open >= this.opts.maxQueue) return { status: 'rejected', reason: 'queue_full', retryable: true, detail: `${open} clips waiting` };
    const id = randomUUID().replace(/-/g, '');
    this.submitted.push(req);
    this.jobs.set(id, { req, state: { status: 'queued', queuePosition: open } });
    this.order.push(id);
    void this.drain();
    return { status: 'accepted', id };
  }

  async status(id: string): Promise<ClipState> {
    const job = this.jobs.get(id);
    if (!job) return { status: 'unknown', reason: 'not_found' };
    if (job.state.status === 'queued') return { status: 'queued', queuePosition: this.order.indexOf(id) + (this.running ? 1 : 0) };
    return job.state;
  }

  /** Every clip let go of, for tests to inspect. */
  readonly discarded: string[] = [];

  async discard(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    this.discarded.push(id);
    if (job.state.status === 'queued') {
      this.order.splice(this.order.indexOf(id), 1);
      job.state = { status: 'failed', reason: 'cancelled_by_service' };
    }
    if (job.state.status === 'succeeded' || job.state.status === 'failed') this.jobs.delete(id);
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
        job.state = { status: 'running', queuePosition: null };
        await new Promise((r) => setTimeout(r, this.opts.delayMs));
        if (this.failNext.count > 0) {
          this.failNext.count -= 1;
          job.state = { status: 'failed', reason: this.failNext.reason };
          continue;
        }
        try {
          job.bytes = await this.draw(job.req);
          job.state = { status: 'succeeded' };
        } catch (err) {
          job.state = { status: 'failed', reason: `demo_ffmpeg: ${(err as Error).message.slice(0, 40)}` };
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async draw(req: ClipRequest): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), 'yuha-demo-clip-'));
    const out = join(dir, 'clip.mp4');
    const [w, h] = SIZE[req.orientation];
    try {
      await new Promise<void>((resolve, reject) => {
        const p = spawn(this.opts.ffmpegPath, [
          '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=24`,
          '-t', String(req.seconds), '-pix_fmt', 'yuv420p', '-an', out,
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
