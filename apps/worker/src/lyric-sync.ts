import { EstimatedAlignmentProvider, type AlignmentResult } from '@yuha/providers';
import {
  claimNextLyricSync,
  finishLyricSync,
  getMasterAsset,
  lyricsSha,
  retryLyricSync,
  storeDeliveredLyricTimings,
  type ClaimedLyricSync,
} from '@yuha/db';
import type { PipelineDeps } from './pipeline.js';

/**
 * Automatic lyric sync, after delivery and apart from it
 * (docs/AUTOMATIC_LYRIC_SYNC_TICKETS.md L4a).
 *
 * A due job is claimed, the aligner asked, and a timeline it heard is applied
 * through the guarded write — nobody saves anything. An estimate the aligner
 * fell back to is a failure, not a sync: it is retried, and only after the
 * last attempt is a labelled estimate kept, so a song never reads as synced
 * when nothing heard it.
 */

/** Waits before the 2nd, 3rd and 4th attempt: a blip, a restart, an outage. */
const LYRIC_SYNC_BACKOFF_SECONDS = [60, 300, 1800];
const MAX_ATTEMPTS = LYRIC_SYNC_BACKOFF_SECONDS.length + 1;

type LyricSyncTickOutcome = 'idle' | 'worked';

export async function lyricSyncTick(d: PipelineDeps): Promise<LyricSyncTickOutcome> {
  const job = await claimNextLyricSync(d.owner);
  if (!job) return 'idle';
  try {
    await runOne(d, job);
  } catch (err) {
    // An attempt that threw is an attempt: the job is not left running for the stale sweep to find.
    await settleFailure(d, job, `error: ${(err as Error).message}`.slice(0, 64), null);
  }
  return 'worked';
}

async function runOne(d: PipelineDeps, job: ClaimedLyricSync): Promise<void> {
  const lyrics = job.lyrics;
  // Deleted, or its words are not the ones this job was for: nothing to do.
  if (!lyrics || lyricsSha(lyrics) !== job.lyrics_sha) {
    await finishLyricSync(job.id, d.owner, 'kept', 'song_changed');
    return;
  }
  const master = await getMasterAsset(job.track_id);
  if (!master || master.sha256 !== job.master_sha256) {
    await finishLyricSync(job.id, d.owner, 'kept', 'audio_changed');
    return;
  }

  const durationSeconds = job.duration_ms / 1000;
  // The aligner's own copy of the render when it still has one; otherwise the song itself.
  const result = job.provider_request_id
    ? await d.ctx.alignment.align({ lyrics, durationSeconds, providerRequestId: job.provider_request_id })
    : await d.ctx.alignment.align({
        lyrics,
        durationSeconds,
        providerRequestId: '',
        audio: await d.ctx.storage.get('delivery', master.storage_key),
      });

  if (result.status === 'ok' && result.timings.source === 'aligned' && !result.fallbackReason) {
    const written = await storeDeliveredLyricTimings({
      trackId: job.track_id,
      lyrics,
      timings: result.timings,
      masterSha: job.master_sha256,
    });
    await finishLyricSync(job.id, d.owner, written ? 'applied' : 'kept', written ? null : 'song_changed');
    d.log('info', written ? 'lyric sync applied' : 'lyric sync kept the song’s timing', { trackId: job.track_id, attempt: job.attempts });
    return;
  }
  await settleFailure(d, job, reasonOf(result), result.status === 'ok' ? result : null);
}

function reasonOf(result: AlignmentResult): string {
  return (result.status === 'ok' ? (result.fallbackReason ?? 'estimated') : result.reason).slice(0, 64);
}

async function settleFailure(
  d: PipelineDeps,
  job: ClaimedLyricSync,
  reason: string,
  fallback: Extract<AlignmentResult, { status: 'ok' }> | null,
): Promise<void> {
  if (job.attempts < MAX_ATTEMPTS) {
    await retryLyricSync(job.id, d.owner, LYRIC_SYNC_BACKOFF_SECONDS[job.attempts - 1]!, reason);
    d.log('warn', 'lyric sync will be retried', { trackId: job.track_id, attempt: job.attempts, reason });
    return;
  }
  // Out of attempts: the song keeps a labelled estimate, as it did when the
  // aligner was asked during delivery — still counted as not synced.
  if (job.lyrics) {
    const estimate =
      fallback ??
      (await new EstimatedAlignmentProvider().align({ lyrics: job.lyrics, durationSeconds: job.duration_ms / 1000, providerRequestId: '' }));
    if (estimate.status === 'ok') {
      await storeDeliveredLyricTimings({
        trackId: job.track_id,
        lyrics: job.lyrics,
        timings: { ...estimate.timings, source: 'estimated', fallbackReason: reason.slice(0, 200) },
        masterSha: job.master_sha256,
      }).catch(() => false);
    }
  }
  await finishLyricSync(job.id, d.owner, 'failed', reason);
  d.log('warn', 'lyric sync gave up; the song keeps an estimate', { trackId: job.track_id, attempts: job.attempts, reason });
}

/** The worker loop: one GPU job at a time, and a short rest when the queue is empty. */
export async function lyricSyncLoop(d: PipelineDeps & { stopped: () => boolean; idleMs?: number }): Promise<void> {
  while (!d.stopped()) {
    let outcome: LyricSyncTickOutcome = 'idle';
    try {
      outcome = await lyricSyncTick(d);
    } catch (err) {
      d.log('error', 'lyric sync loop step failed', { err: (err as Error).message.slice(0, 200) });
    }
    await new Promise((r) => setTimeout(r, outcome === 'worked' ? 200 : (d.idleMs ?? 5_000)));
  }
}
