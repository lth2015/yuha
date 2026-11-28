import { randomUUID } from 'node:crypto';
import type { PoolConnection } from 'mysql2/promise';
import type { LyricTimings } from '@yuha/contracts';
import { execute, query, queryOne, withTx } from './pool.js';

/**
 * "Align it again" requests for one song (migration 0035). The queue, and the
 * proposals it produces; never the song's saved timing.
 */
export type LyricProposalStatus = 'queued' | 'running' | 'ready' | 'failed';

export interface LyricProposalRow {
  id: string;
  track_id: string;
  owner_id: string;
  status: LyricProposalStatus;
  lyrics_sha: string;
  timings: (LyricTimings & { masterSha?: string }) | null;
  failure: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

/** A request left running longer than this was cut off (a pod roll); it is reported failed. */
const PROPOSAL_STALE_MINUTES = 15;

function parse(row: LyricProposalRow | null | undefined): LyricProposalRow | null {
  if (!row) return null;
  if (typeof row.timings === 'string') row.timings = JSON.parse(row.timings) as LyricProposalRow['timings'];
  return row;
}

/** The song's latest request, whatever its state. */
export async function latestLyricProposal(trackId: string, tx?: PoolConnection): Promise<LyricProposalRow | null> {
  return parse(
    await queryOne<LyricProposalRow>(`SELECT * FROM lyric_proposals WHERE track_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`, [trackId], tx),
  );
}

/**
 * Asks for a proposal, under a lock on the song so two quick taps (or two
 * tabs) queue one job: the open request when there is one, else a new one,
 * else `limited` when the day's tries are used. A try is one the aligner
 * answered (or is answering): the platform's own failures — unreachable,
 * timed out, interrupted, an error — are not the owner's to spend.
 */
export async function openOrInsertLyricProposal(params: {
  trackId: string;
  ownerId: string;
  lyricsSha: string;
  perDay: number;
}): Promise<{ id: string } | { limited: true }> {
  return withTx(async (tx) => {
    await queryOne(`SELECT id FROM tracks WHERE id = ? FOR UPDATE`, [params.trackId], tx);
    const open = await queryOne<{ id: string }>(
      `SELECT id FROM lyric_proposals WHERE track_id = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`,
      [params.trackId],
      tx,
    );
    if (open) return { id: open.id };
    const used = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM lyric_proposals
        WHERE track_id = ? AND created_at > UTC_TIMESTAMP(3) - INTERVAL 1 DAY
          AND (status = 'ready' OR failure = 'low_coverage' OR failure = 'lyrics_changed')`,
      [params.trackId],
      tx,
    );
    if (Number(used?.n ?? 0) >= params.perDay) return { limited: true };
    const id = randomUUID();
    await execute(`INSERT INTO lyric_proposals (id, track_id, owner_id, lyrics_sha) VALUES (?, ?, ?, ?)`, [id, params.trackId, params.ownerId, params.lyricsSha], tx);
    return { id };
  });
}

export async function getLyricProposal(id: string): Promise<LyricProposalRow | null> {
  return parse(await queryOne<LyricProposalRow>(`SELECT * FROM lyric_proposals WHERE id = ?`, [id]));
}

/** A queued request with nobody draining it, for whoever next looks. */
export async function anyQueuedLyricProposal(): Promise<boolean> {
  return !!(await queryOne(`SELECT id FROM lyric_proposals WHERE status = 'queued' LIMIT 1`));
}

export async function insertLyricProposal(params: { trackId: string; ownerId: string; lyricsSha: string }): Promise<string> {
  const id = randomUUID();
  await execute(`INSERT INTO lyric_proposals (id, track_id, owner_id, lyrics_sha) VALUES (?, ?, ?, ?)`, [
    id,
    params.trackId,
    params.ownerId,
    params.lyricsSha,
  ]);
  return id;
}

/**
 * Takes the oldest queued request, or none. Read back rather than trusting
 * affectedRows (CLAUDE.md: the driver counts matched rows), so two processes
 * reaching for the same row cannot both believe they have it.
 */
export async function claimNextLyricProposal(owner: string): Promise<LyricProposalRow | null> {
  const next = await queryOne<{ id: string }>(`SELECT id FROM lyric_proposals WHERE status = 'queued' ORDER BY created_at, id LIMIT 1`);
  if (!next) return null;
  const token = `run:${owner}`;
  await execute(
    `UPDATE lyric_proposals SET status = 'running', started_at = UTC_TIMESTAMP(3), failure = ?
      WHERE id = ? AND status = 'queued'`,
    [token, next.id],
  );
  const row = parse(await queryOne<LyricProposalRow>(`SELECT * FROM lyric_proposals WHERE id = ?`, [next.id]));
  if (!row || row.status !== 'running' || row.failure !== token) return null;
  await execute(`UPDATE lyric_proposals SET failure = NULL WHERE id = ?`, [row.id]);
  return { ...row, failure: null };
}

export async function finishLyricProposal(
  id: string,
  outcome: { status: 'ready'; timings: LyricTimings & { masterSha: string } } | { status: 'failed'; failure: string },
): Promise<void> {
  await execute(
    `UPDATE lyric_proposals SET status = ?, timings = ?, failure = ?, finished_at = UTC_TIMESTAMP(3) WHERE id = ? AND status = 'running'`,
    [
      outcome.status,
      outcome.status === 'ready' ? JSON.stringify(outcome.timings) : null,
      outcome.status === 'failed' ? outcome.failure.slice(0, 64) : null,
      id,
    ],
  );
}

/** Requests left running by a process that stopped, reported as failed rather than waited on forever. */
export async function failStaleLyricProposals(): Promise<void> {
  await execute(
    `UPDATE lyric_proposals SET status = 'failed', failure = 'interrupted', finished_at = UTC_TIMESTAMP(3)
      WHERE status = 'running' AND started_at < UTC_TIMESTAMP(3) - INTERVAL ? MINUTE`,
    [PROPOSAL_STALE_MINUTES],
  );
}

/** The song's proposals, with its words: gone when the words go. */
export async function deleteLyricProposals(trackId: string): Promise<void> {
  await execute(`DELETE FROM lyric_proposals WHERE track_id = ?`, [trackId]);
}

/** How many requests are ahead of this one in the queue. */
export async function lyricProposalsAhead(row: LyricProposalRow): Promise<number> {
  const r = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM lyric_proposals WHERE status IN ('queued','running') AND (created_at < ? OR (created_at = ? AND id < ?))`,
    [row.created_at, row.created_at, row.id],
  );
  return Number(r[0]?.n ?? 0);
}
