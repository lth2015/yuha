import type { PoolConnection } from 'mysql2/promise';
import { execute, newId, query, queryOne, withTx } from './pool.js';

/** A private problem report about one song (migration 0027, docs/ISSUE_REPORTS_SPEC.md). */
export interface IssueReportRow {
  id: string;
  report_number: string;
  user_id: string;
  track_id: string;
  kind: string;
  at_seconds: number | null;
  note: string | null;
  audio_consent: number;
  context: Record<string, unknown>;
  status: 'open' | 'resolved';
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  /** Migration 0028 (docs/FAILURE_COMPENSATION_SPEC.md): the credit given back on resolution, if any. */
  compensation_batch_id: string | null;
  compensated_units: number | null;
  created_at: Date;
  updated_at: Date;
}

function parsed(row: IssueReportRow): IssueReportRow {
  const c = row.context as unknown;
  return { ...row, context: typeof c === 'string' ? (JSON.parse(c) as Record<string, unknown>) : (c as Record<string, unknown>) };
}

/** IR- and eight characters a person can read out on the phone. */
function reportNumber(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = 'IR-';
  for (let i = 0; i < 8; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

export async function insertIssueReport(
  params: {
    userId: string;
    trackId: string;
    kind: string;
    atSeconds: number | null;
    note: string | null;
    audioConsent: boolean;
    context: Record<string, unknown>;
  },
  tx?: PoolConnection,
): Promise<IssueReportRow> {
  const id = newId();
  // A collision on the number is a retry, not an error the person sees.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await execute(
        `INSERT INTO issue_reports (id, report_number, user_id, track_id, kind, at_seconds, note, audio_consent, context)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, reportNumber(), params.userId, params.trackId, params.kind, params.atSeconds, params.note,
          params.audioConsent ? 1 : 0, JSON.stringify(params.context)],
        tx,
      );
      break;
    } catch (err) {
      if (attempt < 3 && (err as { code?: string }).code === 'ER_DUP_ENTRY') continue;
      throw err;
    }
  }
  return parsed((await queryOne<IssueReportRow>(`SELECT * FROM issue_reports WHERE id = ?`, [id], tx))!);
}

export async function listIssueReportsForTrack(trackId: string, userId: string): Promise<IssueReportRow[]> {
  return (
    await query<IssueReportRow>(
      `SELECT * FROM issue_reports WHERE track_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 50`,
      [trackId, userId],
    )
  ).map(parsed);
}

/** Reports filed in the last hour by one account, for the per-account limit. */
export async function countRecentIssueReports(userId: string): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM issue_reports WHERE user_id = ? AND created_at > UTC_TIMESTAMP(3) - INTERVAL 1 HOUR`,
    [userId],
  );
  return Number(row?.n ?? 0);
}

export interface IssueReportListRow extends IssueReportRow {
  track_title: string | null;
  track_deleted: number;
  user_email: string;
}

export async function listIssueReports(status: 'open' | 'resolved' | 'all', limit = 100): Promise<IssueReportListRow[]> {
  return (
    await query<IssueReportListRow>(
      `SELECT r.*, t.title AS track_title, (t.deleted_at IS NOT NULL) AS track_deleted, u.email AS user_email
         FROM issue_reports r
         JOIN tracks t ON t.id = r.track_id
         JOIN users u ON u.id = r.user_id
        WHERE (? = 'all' OR r.status = ?)
        ORDER BY r.created_at DESC
        LIMIT ?`,
      [status, status, limit],
    )
  ).map((r) => parsed(r) as IssueReportListRow);
}

export async function getIssueReport(id: string): Promise<IssueReportRow | null> {
  const row = await queryOne<IssueReportRow>(`SELECT * FROM issue_reports WHERE id = ?`, [id]);
  return row ? parsed(row) : null;
}

/** True when this call moved it from open to resolved; false when it already was. */
/**
 * Marks an open report resolved. Inside `tx` when given, so a compensation
 * written in the same transaction stands or falls with the resolution.
 */
export async function resolveIssueReport(
  params: {
    id: string;
    resolution: string;
    resolvedBy: string;
    compensation?: { batchId: string; units: number } | null;
  },
  tx?: PoolConnection,
): Promise<boolean> {
  const run = async (conn: PoolConnection) => {
    // Under the row's lock: who resolved it is not evidence of THIS call
    // doing so — the same person resolving twice would read as success.
    const row = await queryOne<{ status: string }>(`SELECT status FROM issue_reports WHERE id = ? FOR UPDATE`, [params.id], conn);
    if (row?.status !== 'open') return false;
    await execute(
      `UPDATE issue_reports
          SET status = 'resolved', resolution = ?, resolved_by = ?, resolved_at = UTC_TIMESTAMP(3),
              compensation_batch_id = ?, compensated_units = ?
        WHERE id = ?`,
      [params.resolution, params.resolvedBy, params.compensation?.batchId ?? null, params.compensation?.units ?? null, params.id],
      conn,
    );
    return true;
  };
  return tx ? run(tx) : withTx(run);
}

/** Locks an open report for resolution, so its checks and its writes see the same row. */
export async function lockIssueReport(id: string, tx: PoolConnection): Promise<IssueReportRow | null> {
  const row = await queryOne<IssueReportRow>(`SELECT * FROM issue_reports WHERE id = ? FOR UPDATE`, [id], tx);
  return row ? parsed(row) : null;
}
