import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claimNextShot,
  finishDrawnSceneMvs,
  finishShot,
  recordShotSubmitted,
  releaseShot,
  runningShot,
  startQueuedSceneMvs,
} from '@yuha/db';
import { CLIP_MAX_SECONDS, type StorageAdapter, type VideoProvider } from '@yuha/providers';

/**
 * Drawing a scene MV's shots (docs/AI_SCENE_MV_TICKETS.md, T5).
 *
 * One tick does one thing for the one shot on the machine: ask for it, ask
 * how it is going, or collect it. The records (packages/db/src/scene-mvs.ts)
 * hold every rule about order, tries and cancels; this file only talks to the
 * video service and storage, and is safe to run in every worker process,
 * because the claim is one step across all of them.
 *
 * What it can and cannot stop: the dgxv service has no cancel. A cancelled
 * job's shot that is already on the GPU finishes there and is thrown away;
 * no further shot of that job is asked for.
 */
export interface SceneMvDeps {
  video: VideoProvider;
  storage: StorageAdapter;
  owner: string;
  log: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
  /** A shot on the machine longer than this has failed (the service takes 1.5–3 minutes, more when queued). */
  shotTimeoutMs?: number;
  ffprobePath?: string;
}

export type TickOutcome = 'idle' | 'submitted' | 'waiting' | 'stored' | 'failed' | 'released';

/** How long each shot is: the span shared out, at most what the service draws. */
export function shotSeconds(clipStart: number, clipEnd: number, shots: number): number {
  return Math.max(1, Math.min(CLIP_MAX_SECONDS, Math.ceil((clipEnd - clipStart) / Math.max(1, shots))));
}

export async function sceneMvTick(d: SceneMvDeps): Promise<TickOutcome> {
  await startQueuedSceneMvs();
  let shot = await runningShot();
  if (!shot) {
    if (!(await claimNextShot(d.owner))) {
      await finishDrawnSceneMvs();
      return 'idle';
    }
    shot = await runningShot();
    if (!shot) return 'idle';
  }

  if (!shot.provider_clip_id) {
    const sub = await d.video.submit({
      prompt: shot.prompt,
      seconds: shotSeconds(shot.clip_start, shot.clip_end, shot.shot_count),
      // The first version is vertical only (docs/AI_SCENE_MV_SPEC.md).
      orientation: 'portrait',
    });
    if (sub.status === 'accepted') {
      await recordShotSubmitted(shot.id, sub.id);
      d.log('info', 'scene mv shot submitted', { shotId: shot.id, sceneMvId: shot.scene_mv_id, attempt: shot.attempts });
      return 'submitted';
    }
    if (sub.retryable) {
      // Busy or unreachable is the platform's; the shot keeps its tries.
      await releaseShot(shot.id);
      d.log('warn', 'scene mv shot not accepted; will ask again', { shotId: shot.id, reason: sub.reason });
      return 'released';
    }
    await finishShot(shot.id, { status: 'failed', failure: sub.reason });
    d.log('error', 'scene mv shot refused', { shotId: shot.id, reason: sub.reason });
    return 'failed';
  }

  const state = await d.video.status(shot.provider_clip_id);
  const age = Date.now() - new Date(shot.started_at ?? Date.now()).getTime();
  if (state.status === 'queued' || state.status === 'running' || (state.status === 'unknown' && state.reason !== 'not_found')) {
    if (age > (d.shotTimeoutMs ?? 30 * 60_000)) {
      await finishShot(shot.id, { status: 'failed', failure: 'timeout' });
      d.log('error', 'scene mv shot timed out', { shotId: shot.id, state: state.status });
      return 'failed';
    }
    if (state.status === 'unknown') d.log('warn', 'scene mv: video service could not be asked', { reason: state.reason });
    return 'waiting';
  }
  if (state.status === 'failed' || state.status === 'unknown') {
    const failure = state.status === 'failed' ? state.reason : 'lost';
    await finishShot(shot.id, { status: 'failed', failure });
    d.log('warn', 'scene mv shot failed', { shotId: shot.id, failure, attempt: shot.attempts });
    return 'failed';
  }

  // Succeeded: collect, check it is a silent video, keep it.
  let failure: string | null = null;
  try {
    const bytes = await d.video.fetchClip(shot.provider_clip_id);
    const kinds = await streamKinds(bytes, d.ffprobePath);
    if (kinds.includes('audio')) failure = 'clip_has_audio';
    else if (!kinds.includes('video')) failure = 'clip_has_no_video';
    else {
      const key = `scene-mv/${shot.owner_id}/${shot.scene_mv_id}/shot-${shot.idx}.mp4`;
      await d.storage.put({ zone: 'delivery', key, body: bytes, contentType: 'video/mp4' });
      await finishShot(shot.id, { status: 'succeeded', clipKey: key });
      await finishDrawnSceneMvs();
      return 'stored';
    }
  } catch (err) {
    failure = 'fetch_failed';
    d.log('warn', 'scene mv clip could not be collected', { shotId: shot.id, err: (err as Error).message.slice(0, 120) });
  }
  await finishShot(shot.id, { status: 'failed', failure });
  return 'failed';
}

async function streamKinds(bytes: Buffer, ffprobe = 'ffprobe'): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), 'yuha-shot-'));
  const file = join(dir, 'shot.mp4');
  try {
    await writeFile(file, bytes);
    return await new Promise<string[]>((resolve, reject) => {
      const p = spawn(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      p.stdout.on('data', (c) => (out += String(c)));
      p.on('error', reject);
      p.on('close', () => resolve(out.split('\n').map((l) => l.trim()).filter(Boolean)));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
