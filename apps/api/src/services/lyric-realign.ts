import { AppError } from '@yuha/contracts';
import { EstimatedAlignmentProvider } from '@yuha/providers';
import {
  createLyricRealignment,
  finishLyricRealignment,
  finishRealignedTrack,
  getLyricRealignment,
  listLyricRealignments,
  previewLyricRealignment,
  realignCandidatesAfter,
  withTxRetry,
  writeAuditLog,
  type LyricRealignmentRow,
} from '@yuha/db';
import type { AppContext } from '../context.js';

/**
 * Re-aligning old songs' lyrics, as the console sees it (docs/LYRIC_ALIGNMENT.md).
 *
 * Shaped like a credit reset, for the same reason: a run is far longer than
 * any request may live — each song is a GPU job on the DGX, queued behind
 * whatever it is rendering — so it is started, runs in the background song
 * by song, and the console polls it. Interrupted, the same key continues it.
 *
 * What it may change is narrow on purpose. A song is rewritten only when the
 * aligner actually heard it (`aligned`); when it could not — audio gone,
 * coverage too low, the box down — the song keeps the timing it had, never
 * an estimate in place of something better. A person's correction is never
 * touched.
 */
export interface LyricRealignmentView {
  id: string;
  idempotencyKey: string;
  status: 'running' | 'done';
  reason: string;
  tracksSeen: number;
  tracksRealigned: number;
  tracksKept: number;
  createdAt: string;
  finishedAt: string | null;
  /** True while this process is running it; false for one left running by a process that stopped. */
  active: boolean;
}

const running = new Set<string>();

function viewOf(r: LyricRealignmentRow): LyricRealignmentView {
  return {
    id: r.id,
    idempotencyKey: r.idempotency_key,
    status: r.status,
    reason: r.reason,
    tracksSeen: r.tracks_seen,
    tracksRealigned: r.tracks_realigned,
    tracksKept: r.tracks_kept,
    createdAt: r.created_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
    active: running.has(r.id),
  };
}

/*
 * Whether this process can hear songs at all. The run executes in the API
 * process, whose configuration is not the worker's: an API left on the
 * estimator would "keep" every song and report a clean run that changed
 * nothing. So it says so, and refuses to start.
 */
const canHear = (ctx: AppContext) => ctx.alignment.kind !== new EstimatedAlignmentProvider().kind;

export async function lyricRealignOverview(ctx: AppContext) {
  const [preview, runs] = await Promise.all([previewLyricRealignment(), listLyricRealignments(10)]);
  return { preview: { ...preview, aligner: ctx.alignment.kind, ready: canHear(ctx) }, runs: runs.map(viewOf) };
}

export async function getLyricRealignView(id: string): Promise<LyricRealignmentView> {
  const r = await getLyricRealignment(id);
  if (!r) throw new AppError('NOT_FOUND', 'no such re-alignment');
  return viewOf(r);
}

/** Starts a run, or continues the one this key started. Returns at once; the run goes on in the background. */
export async function startLyricRealign(
  ctx: AppContext,
  params: { idempotencyKey: string; reason: string; actorId: string; actorRole: string },
): Promise<LyricRealignmentView> {
  const reason = params.reason.trim();
  if (reason.length < 3) throw new AppError('VALIDATION_FAILED', 'a reason is required');
  if (!canHear(ctx)) throw new AppError('CONFLICT', 'no aligner is configured on this server (ALIGNMENT_ADAPTER=http)');

  const out = await withTxRetry(async (tx) => {
    const res = await createLyricRealignment({ idempotencyKey: params.idempotencyKey, actorId: params.actorId, reason }, tx);
    if ('created' in res && res.created) {
      await writeAuditLog(
        {
          actorId: params.actorId,
          actorRole: params.actorRole,
          action: 'lyric_realign.started',
          subjectType: 'lyric_realignment',
          subjectId: res.run.id,
          reason,
        },
        tx,
      );
    }
    return res;
  });
  if ('blockedBy' in out) {
    throw new AppError('CONFLICT', 'another re-alignment is unfinished; continue that one first', { runId: out.blockedBy.id });
  }
  if (out.run.status === 'running' && !running.has(out.run.id)) {
    running.add(out.run.id);
    void runLyricRealign(ctx, out.run.id, params.actorRole)
      .catch((err) =>
        // Left `running` with its cursor: the console offers to continue it.
        console.log(JSON.stringify({ level: 'error', component: 'lyric_realign', ts: new Date().toISOString(), msg: 'lyric_realign_stopped', runId: out.run.id, error: (err as Error).message })),
      )
      .finally(() => running.delete(out.run.id));
  }
  return viewOf((await getLyricRealignment(out.run.id))!);
}

async function runLyricRealign(ctx: AppContext, id: string, actorRole: string): Promise<void> {
  for (;;) {
    const run = await getLyricRealignment(id);
    if (!run || run.status !== 'running') return;
    const songs = await realignCandidatesAfter(run.cursor_track_id, 20);
    if (songs.length === 0) break;
    for (const song of songs) {
      // One at a time: the aligner shares a GPU with paying customers' renders.
      const result = song.provider_request_id
        ? await ctx.alignment
            .align({ lyrics: song.lyrics, durationSeconds: song.duration_ms / 1000, providerRequestId: song.provider_request_id })
            .catch(() => null)
        : null;
      const timings = result?.status === 'ok' ? result.timings : null;
      if (result?.status === 'ok' && result.fallbackReason) {
        console.log(JSON.stringify({ level: 'warn', component: 'lyric_realign', ts: new Date().toISOString(), msg: 'lyric_realign_estimated', runId: id, trackId: song.id, reason: result.fallbackReason }));
      }
      await withTxRetry((tx) => finishRealignedTrack(run, song.id, timings, tx));
    }
  }
  // Done and its audit row in one transaction, as for credit resets.
  await withTxRetry(async (tx) => {
    if (!(await finishLyricRealignment(id, tx))) return;
    const done = (await getLyricRealignment(id, tx))!;
    await writeAuditLog(
      {
        actorId: done.actor_id,
        actorRole,
        action: 'lyric_realign.finished',
        subjectType: 'lyric_realignment',
        subjectId: id,
        reason: done.reason,
        after: { tracksSeen: done.tracks_seen, tracksRealigned: done.tracks_realigned, tracksKept: done.tracks_kept },
      },
      tx,
    );
  });
}
