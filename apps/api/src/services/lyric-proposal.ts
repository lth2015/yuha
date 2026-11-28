import { createHash, randomUUID } from 'node:crypto';
import { AppError, lyricTimings, timingsMatchLyrics, trustedMask, type LyricTimings } from '@yuha/contracts';
import { EstimatedAlignmentProvider, type AlignmentResult } from '@yuha/providers';
import {
  anyQueuedLyricProposal,
  claimNextLyricProposal,
  failStaleLyricProposals,
  finishLyricProposal,
  getLyricProposal,
  getMasterAsset,
  getTrack,
  latestLyricProposal,
  openOrInsertLyricProposal,
  queryOne,
  storeDeliveredLyricTimings,
  withTx,
  lyricProposalsAhead,
  type LyricProposalRow,
  type TrackRow,
} from '@yuha/db';
import type { AppContext } from '../context.js';
import { alignerFor } from './aligner-choice.js';
import { lyricSyncStateOf } from './lyric-sync-state.js';

/**
 * "Align it again", for one song, by its owner (docs/LYRIC_ALIGNMENT.md).
 *
 * The aligner is asked with the song's own audio, so it works for a song of
 * any age (the DGX keeps its renders only days). The result is stored apart
 * from the song until the owner chooses to use it. Nothing is charged.
 *
 * One request at a time per process, because each is a GPU job on the box
 * that renders customers' songs.
 */
const PER_SONG_PER_DAY = 3;

const OWNER = randomUUID().slice(0, 12);
let draining = false;

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** At start: anything left queued by the process before this one. */
export async function resumeLyricProposals(ctx: AppContext, log: (msg: string, err?: unknown) => void): Promise<void> {
  if (await anyQueuedLyricProposal().catch(() => false)) drainLyricProposals(ctx, log);
}

/** An estimator asked again only estimates again: the button is offered where something can listen. */
export function realAligner(ctx: AppContext): boolean {
  return ctx.alignment.kind !== new EstimatedAlignmentProvider().kind;
}

/** Words to align: a sung song with at least one line that is not a section tag. */
function sungLyrics(track: TrackRow): string | null {
  if (track.vocal_mode === 'instrumental' || !track.lyrics) return null;
  return track.lyrics.split('\n').some((l) => l.trim() && !/^\[[^\]]*\]$/.test(l.trim())) ? track.lyrics : null;
}

export interface LyricProposalView {
  id: string;
  status: 'queued' | 'running' | 'ready' | 'failed';
  /** Requests before this one; only while queued. */
  ahead?: number;
  timings?: LyricTimings;
  applied?: boolean;
  canApply?: boolean;
  /** low_coverage | timeout | unreachable | lyrics_changed | interrupted | error */
  failure?: string;
}

async function viewOf(row: LyricProposalRow, current?: TrackRow): Promise<LyricProposalView> {
  const base = { id: row.id, status: row.status };
  if (row.status === 'queued') return { ...base, ahead: await lyricProposalsAhead(row) };
  if (row.status === 'failed') return { ...base, ...(row.failure ? { failure: row.failure } : {}) };
  if (row.status !== 'ready' || !row.timings) return base;
  const { masterSha, ...timings } = row.timings;
  return {
    ...base,
    timings,
    canApply: Boolean(masterSha),
    ...(current?.lyric_timings?.appliedProposalId === row.id ? { applied: true } : {}),
  };
}

async function ownedSung(trackId: string, userId: string): Promise<{ track: TrackRow; lyrics: string }> {
  const track = await getTrack(trackId);
  if (!track || track.deleted_at || track.owner_id !== userId) throw new AppError('NOT_FOUND', 'no such song');
  const lyrics = sungLyrics(track);
  if (track.state !== 'deliverable' || !lyrics) throw new AppError('CONFLICT', 'this song has no sung words to align');
  return { track, lyrics };
}

export async function requestLyricProposal(ctx: AppContext, trackId: string, userId: string, log: (msg: string, err?: unknown) => void) {
  // Switched off: the same answer for every song, so it says nothing about whose any is.
  if (!(await ctx.features()).lyricAutoAlignEnabled) throw new AppError('SERVICE_DISABLED', 'automatic alignment is not available');
  // Then whose song: a stranger hears "no such song" whatever is configured.
  const { track, lyrics } = await ownedSung(trackId, userId);
  if (!realAligner(ctx)) throw new AppError('SERVICE_DISABLED', 'automatic alignment is not available');
  await failStaleLyricProposals();
  // Asked again while the first waits: that one, not a second GPU job (under a lock, so two taps are one).
  const out = await openOrInsertLyricProposal({ trackId: track.id, ownerId: userId, lyricsSha: sha(lyrics), perDay: PER_SONG_PER_DAY });
  if ('limited' in out) {
    throw new AppError('RATE_LIMITED', 'this song has been aligned again three times today', { retryAfterSeconds: 3600 });
  }
  drainLyricProposals(ctx, log);
  return viewOf((await getLyricProposal(out.id))!);
}

export async function readLyricProposal(
  ctx: AppContext,
  trackId: string,
  userId: string,
  log: (msg: string, err?: unknown) => void,
): Promise<LyricProposalView | null> {
  const track = await getTrack(trackId);
  if (!track || track.deleted_at || track.owner_id !== userId) throw new AppError('NOT_FOUND', 'no such song');
  await failStaleLyricProposals();
  const latest = await latestLyricProposal(track.id);
  // Left queued by a process that stopped (a pod roll): whoever looks next starts the queue again.
  if (latest?.status === 'queued') drainLyricProposals(ctx, log);
  return latest ? viewOf(latest, track) : null;
}

/** Apply a stored result only to the same song, words and master. */
export async function applyLyricProposal(trackId: string, userId: string, proposalId: string) {
  return withTx(async (tx) => {
    // New requests also lock the song, so the latest proposal cannot change during this write.
    await queryOne('SELECT id FROM tracks WHERE id = ? FOR UPDATE', [trackId], tx);
    const track = await getTrack(trackId, tx);
    if (!track || track.deleted_at || track.owner_id !== userId) throw new AppError('NOT_FOUND', 'no such song');
    const proposal = await latestLyricProposal(trackId, tx);
    const lyrics = track.state === 'deliverable' ? sungLyrics(track) : null;
    if (!lyrics || proposal?.id !== proposalId || proposal.status !== 'ready'
      || proposal.owner_id !== userId || proposal.lyrics_sha !== sha(lyrics)
      || proposal.timings?.source !== 'aligned' || !proposal.timings.masterSha) {
      throw new AppError('CONFLICT', 'no current alignment result to use');
    }
    const { masterSha, ...timings } = proposal.timings;
    const wrote = await storeDeliveredLyricTimings({
      trackId, lyrics, masterSha, timings: { ...timings, appliedProposalId: proposalId },
    }, tx);
    if (!wrote) throw new AppError('CONFLICT', 'the song has changed or already has a saved correction');
    return {
      trackId,
      lyricTimings: timings,
      lyricSync: lyricSyncStateOf({ ...track, lyric_timings: timings }, null),
    };
  });
}

/** The kind of failure, for the page to say in words; the full reason is logged. */
function failureOf(result: AlignmentResult): string {
  const why = result.status === 'ok' ? (result.fallbackReason ?? 'estimated') : result.reason;
  // Only a refusal that names coverage is "heard too little": a 422 for a
  // request the aligner could not read (an older DGX without `audio_b64`)
  // is not the song's fault, and must not be told as if it were.
  if (/coverage/.test(why)) return 'low_coverage';
  if (/timeout/.test(why)) return 'timeout';
  if (/threw|ECONN|fetch failed|no_audio_url/.test(why)) return 'unreachable';
  return 'error';
}

/** Works through the queue, one at a time, in the background of the request that started it. */
function drainLyricProposals(ctx: AppContext, log: (msg: string, err?: unknown) => void): void {
  if (draining) return;
  draining = true;
  void (async () => {
    try {
      for (;;) {
        const row = await claimNextLyricProposal(OWNER);
        if (!row) break;
        await processOne(ctx, row, log);
      }
    } catch (err) {
      log('lyric proposal queue stopped', err);
    } finally {
      draining = false;
    }
  })();
}

async function processOne(ctx: AppContext, row: LyricProposalRow, log: (msg: string, err?: unknown) => void) {
  try {
    const track = await getTrack(row.track_id);
    const lyrics = track && !track.deleted_at ? sungLyrics(track) : null;
    if (!track || !lyrics) return finishLyricProposal(row.id, { status: 'failed', failure: 'gone' });
    // An answer for words the song no longer has is not offered.
    if (sha(lyrics) !== row.lyrics_sha) return finishLyricProposal(row.id, { status: 'failed', failure: 'lyrics_changed' });
    const master = await getMasterAsset(track.id);
    if (!master) return finishLyricProposal(row.id, { status: 'failed', failure: 'error' });
    const audio = await ctx.storage.get('delivery', master.storage_key);
    const method = await alignerFor(ctx, track.owner_id);
    const durationSeconds = track.duration_ms / 1000;
    const result = await ctx.alignment.align({ ...(method ? { method } : {}), lyrics, durationSeconds, providerRequestId: '', audio });
    // Only what the aligner heard is offered; an estimate would only repeat what the song has.
    if (result.status === 'ok' && result.timings.source === 'aligned' && !result.fallbackReason) {
      const parsed = lyricTimings.safeParse(result.timings);
      if (!parsed.success || !timingsMatchLyrics(lyrics, parsed.data) || parsed.data.lines.some((line, i, lines) =>
        line.start > durationSeconds || line.end > durationSeconds + 1 || line.end < line.start
        || (i > 0 && line.start < lines[i - 1]!.start))) {
        log('lyric proposal rejected an invalid timeline');
        return finishLyricProposal(row.id, { status: 'failed', failure: 'error' });
      }
      if (!trustedMask(parsed.data).some(Boolean)) {
        return finishLyricProposal(row.id, { status: 'failed', failure: 'low_coverage' });
      }
      return finishLyricProposal(row.id, { status: 'ready', timings: { ...parsed.data, masterSha: master.sha256 } });
    }
    const failure = failureOf(result);
    log(`lyric proposal not aligned (${failure}): ${result.status === 'ok' ? result.fallbackReason : result.reason}`);
    return finishLyricProposal(row.id, { status: 'failed', failure });
  } catch (err) {
    log('lyric proposal failed', err);
    return finishLyricProposal(row.id, { status: 'failed', failure: 'error' });
  }
}
