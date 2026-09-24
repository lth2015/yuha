import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AudioFormat } from '@yuha/contracts';

export interface AudioProbe {
  durationMs: number;
  codec: string | null;
  sampleRate: number | null;
  channels: number | null;
  /** Mean volume in dBFS; used for the silence check. */
  meanVolumeDb: number | null;
  maxVolumeDb: number | null;
}

export interface OutputCheckConfig {
  expectedDurationSeconds: number;
  /** Tolerance in ms. Configurable because it is a contract/quality question (AI-07). */
  durationToleranceMs: number;
  /** Reject anything quieter than this on average — catches empty renders. */
  minMeanVolumeDb: number;
  minBytes: number;
}

export type OutputCheckFailure =
  | 'undecodable'
  | 'empty_file'
  | 'duration_out_of_tolerance'
  | 'silent_or_near_silent'
  | 'unexpected_channel_layout';

export interface OutputCheckResult {
  ok: boolean;
  failures: OutputCheckFailure[];
  probe: AudioProbe | null;
}

function run(cmd: string, args: string[], input?: Buffer): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => stdout.push(d));
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(stdout), stderr }));
    if (input) {
      child.stdin.on('error', () => {
        /* ffmpeg may close stdin early; not fatal */
      });
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

export interface FfmpegOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  /** Hard wall-clock cap on any single audio operation. */
  timeoutMs?: number;
}

export class AudioProcessor {
  private readonly ffmpeg: string;
  private readonly ffprobe: string;

  constructor(opts: FfmpegOptions = {}) {
    this.ffmpeg = opts.ffmpegPath ?? 'ffmpeg';
    this.ffprobe = opts.ffprobePath ?? 'ffprobe';
  }

  async available(): Promise<boolean> {
    try {
      const res = await run(this.ffmpeg, ['-version']);
      return res.code === 0;
    } catch {
      return false;
    }
  }

  /** Probes duration, codec and loudness. Works on a temp file so ffprobe can seek. */
  async probe(buffer: Buffer): Promise<AudioProbe | null> {
    const dir = await mkdtemp(join(tmpdir(), 'loopscene-probe-'));
    const path = join(dir, 'input');
    try {
      await writeFile(path, buffer);
      const meta = await run(this.ffprobe, [
        '-v', 'error',
        '-show_entries', 'stream=codec_name,sample_rate,channels:format=duration',
        '-of', 'json',
        path,
      ]);
      if (meta.code !== 0) return null;

      let parsed: {
        streams?: Array<{ codec_name?: string; sample_rate?: string; channels?: number }>;
        format?: { duration?: string };
      };
      try {
        parsed = JSON.parse(meta.stdout.toString('utf8'));
      } catch {
        return null;
      }
      const stream = parsed.streams?.[0];
      const durationSec = Number.parseFloat(parsed.format?.duration ?? 'NaN');
      if (!Number.isFinite(durationSec)) return null;

      // volumedetect writes its summary to stderr.
      const vol = await run(this.ffmpeg, ['-v', 'info', '-i', path, '-af', 'volumedetect', '-f', 'null', '-']);
      const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(vol.stderr);
      const max = /max_volume:\s*(-?[\d.]+) dB/.exec(vol.stderr);

      return {
        durationMs: Math.round(durationSec * 1000),
        codec: stream?.codec_name ?? null,
        sampleRate: stream?.sample_rate ? Number.parseInt(stream.sample_rate, 10) : null,
        channels: stream?.channels ?? null,
        meanVolumeDb: mean?.[1] ? Number.parseFloat(mean[1]) : null,
        maxVolumeDb: max?.[1] ? Number.parseFloat(max[1]) : null,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Output checks required by AI-07: decodable, non-empty, duration within
   * tolerance, not silent or corrupt.
   *
   * Explicitly NOT a copyright check, and not a vocal detector — a real
   * unintended-vocal check needs a dedicated classifier and, per AI-07, human
   * review. What we can assert automatically is recorded here; the rest is an
   * open item rather than a claimed pass.
   */
  async checkOutput(buffer: Buffer, cfg: OutputCheckConfig): Promise<OutputCheckResult> {
    const failures: OutputCheckFailure[] = [];
    if (buffer.byteLength < cfg.minBytes) {
      return { ok: false, failures: ['empty_file'], probe: null };
    }
    const probe = await this.probe(buffer);
    if (!probe) return { ok: false, failures: ['undecodable'], probe: null };

    const expectedMs = cfg.expectedDurationSeconds * 1000;
    if (Math.abs(probe.durationMs - expectedMs) > cfg.durationToleranceMs) {
      failures.push('duration_out_of_tolerance');
    }
    if (probe.meanVolumeDb !== null && probe.meanVolumeDb < cfg.minMeanVolumeDb) {
      failures.push('silent_or_near_silent');
    }
    if (probe.channels !== null && (probe.channels < 1 || probe.channels > 2)) {
      failures.push('unexpected_channel_layout');
    }
    return { ok: failures.length === 0, failures, probe };
  }

  /**
   * Renders an export: trim to a 15s or 30s window, optional 1s fade-out,
   * loudness normalisation, then encode.
   *
   * UI-07: transcoding MP3 to WAV is not a quality upgrade, so WAV is only
   * produced from a master that was itself delivered in a lossless format —
   * the caller enforces that; this function just does what it is told.
   */
  async renderExport(params: {
    source: Buffer;
    clipStartMs: number;
    clipDurationMs: number;
    fadeOutMs: number;
    format: AudioFormat;
    /** Target integrated loudness (LUFS). */
    loudnessTarget?: number;
  }): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), 'loopscene-export-'));
    const inPath = join(dir, 'in');
    const outPath = join(dir, params.format === 'wav' ? 'out.wav' : 'out.mp3');
    try {
      await writeFile(inPath, params.source);

      const filters: string[] = [];
      if (params.fadeOutMs > 0) {
        const fadeStartSec = Math.max(0, (params.clipDurationMs - params.fadeOutMs) / 1000);
        filters.push(`afade=t=out:st=${fadeStartSec.toFixed(3)}:d=${(params.fadeOutMs / 1000).toFixed(3)}`);
      }
      filters.push(`loudnorm=I=${params.loudnessTarget ?? -14}:TP=-1.5:LRA=11`);

      const args = [
        '-hide_banner', '-v', 'error', '-y',
        '-ss', (params.clipStartMs / 1000).toFixed(3),
        '-t', (params.clipDurationMs / 1000).toFixed(3),
        '-i', inPath,
        '-af', filters.join(','),
        '-map_metadata', '-1', // strip source metadata
      ];
      if (params.format === 'mp3') {
        args.push('-codec:a', 'libmp3lame', '-b:a', '192k', '-ar', '44100');
      } else {
        args.push('-codec:a', 'pcm_s16le', '-ar', '44100');
      }
      args.push(outPath);

      const res = await run(this.ffmpeg, args);
      if (res.code !== 0) {
        throw new Error(`ffmpeg export failed (${res.code}): ${res.stderr.slice(0, 400)}`);
      }
      return await readFile(outPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
