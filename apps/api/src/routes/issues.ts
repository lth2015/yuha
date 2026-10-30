import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, createIssueReportRequest, type IssueKind, type IssueReportView } from '@yuha/contracts';
import {
  countRecentIssueReports,
  getIssueReport,
  getMasterAsset,
  getTrack,
  getTrackForUser,
  insertIssueReport,
  listIssueReports,
  listIssueReportsForTrack,
  lockIssueReport,
  resolveIssueReport,
  withTxRetry,
  writeAuditLog,
  type IssueReportRow,
} from '@yuha/db';
import type { AppContext } from '../context.js';
import { compensateAsOperator } from '../services/operator-grant.js';

/**
 * Reporting a problem with one song, privately (docs/ISSUE_REPORTS_SPEC.md).
 *
 * The owner says what is wrong in a few taps; staff see it with what the
 * server knew attached, and hear the song only when the owner allowed it.
 */
const PER_HOUR = 10;
const AUDIO_URL_TTL_SECONDS = 10 * 60;

function view(r: IssueReportRow): IssueReportView {
  return {
    reportNumber: r.report_number,
    kind: r.kind as IssueKind,
    atSeconds: r.at_seconds,
    note: r.note,
    audioConsent: !!r.audio_consent,
    status: r.status,
    resolution: r.resolution,
    createdAt: r.created_at.toISOString(),
    resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
    compensatedUnits: r.compensated_units ?? null,
  };
}

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

export default async function issueRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { ctx } = opts;
  const staff = app.requireRole(['support', 'admin']);

  app.post(
    '/v1/tracks/:id/issues',
    { preHandler: app.requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      // The owner's song or nothing: a stranger's request and a missing song
      // answer the same, so an id never confirms that a song exists.
      const track = await getTrackForUser(id, req.user!.id);
      if (!track) throw new AppError('NOT_FOUND', 'song not found');
      const body = createIssueReportRequest.parse(req.body);
      if ((await countRecentIssueReports(req.user!.id)) >= PER_HOUR) {
        throw new AppError('RATE_LIMITED', 'that is a lot of reports in an hour — try again a little later');
      }
      const timings = track.lyric_timings;
      const report = await insertIssueReport({
        userId: req.user!.id,
        trackId: track.id,
        kind: body.kind,
        atSeconds: body.atSeconds ?? null,
        note: body.note ? body.note : null,
        audioConsent: body.audioConsent,
        context: {
          jobId: track.job_id,
          trackState: track.state,
          visibility: track.visibility,
          durationMs: track.duration_ms,
          lyricTimingSource: timings?.source ?? null,
          lyricAligner: timings?.aligner ?? null,
          requestId: body.requestId ?? null,
          userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
        },
      });
      return reply.status(201).send(view(report));
    },
  );

  app.get('/v1/tracks/:id/issues', { preHandler: app.requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const track = await getTrackForUser(id, req.user!.id);
    if (!track) throw new AppError('NOT_FOUND', 'song not found');
    return { items: (await listIssueReportsForTrack(track.id, req.user!.id)).map(view) };
  });

  // --------------------------------------------------------------- console

  app.get('/v1/admin/issues', { preHandler: staff }, async (req) => {
    const q = z.object({ status: z.enum(['open', 'resolved', 'all']).default('open') }).parse(req.query);
    const rows = await listIssueReports(q.status);
    return {
      items: rows.map((r) => ({
        id: r.id,
        ...view(r),
        trackId: r.track_id,
        trackTitle: r.track_title,
        trackDeleted: !!r.track_deleted,
        context: r.context,
        userEmail: req.user!.role === 'admin' ? r.user_email : maskEmail(r.user_email),
      })),
    };
  });

  /**
   * A short-lived link to the song's audio — only with the owner's consent,
   * and every opening is audited. Without consent there is no way to get the
   * audio from a report at all.
   */
  app.post('/v1/admin/issues/:id/audio-url', { preHandler: staff }, async (req) => {
    const { id } = req.params as { id: string };
    const report = await getIssueReport(id);
    if (!report) throw new AppError('NOT_FOUND', 'report not found');
    if (!report.audio_consent) throw new AppError('FORBIDDEN', 'the owner did not allow staff to listen to this song');
    const track = await getTrack(report.track_id);
    const master = track && !track.deleted_at ? await getMasterAsset(track.id) : undefined;
    if (!master) throw new AppError('NOT_FOUND', 'the song’s audio is no longer stored');
    const signed = await ctx.storage.signedUrl({ zone: 'delivery', key: master.storage_key, ttlSeconds: AUDIO_URL_TTL_SECONDS });
    await writeAuditLog({
      actorId: req.user!.id,
      actorRole: req.user!.role,
      action: 'issue_report.audio_opened',
      subjectType: 'issue_report',
      subjectId: report.id,
      reason: `listened to the song for ${report.report_number}`,
    });
    return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
  });

  /**
   * Resolves a report, optionally giving one credit back for the song
   * (docs/FAILURE_COMPENSATION_SPEC.md). One transaction: a refused
   * compensation — the song already compensated, the operator's daily
   * allowance spent — leaves the report open and the balance untouched.
   */
  app.post('/v1/admin/issues/:id/resolve', { preHandler: staff }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({ reason: z.string().trim().min(5).max(500), compensate: z.boolean().default(false) })
      .parse(req.body);
    const compensatedUnits = await withTxRetry(async (tx) => {
      const report = await lockIssueReport(id, tx);
      if (!report) throw new AppError('NOT_FOUND', 'report not found');
      if (report.status !== 'open') throw new AppError('CONFLICT', 'this report was already resolved');
      let compensation: { batchId: string; units: number } | null = null;
      if (body.compensate) {
        const track = await getTrack(report.track_id, tx);
        if (!track?.job_id) throw new AppError('CONFLICT', 'this song has no generation to compensate');
        const res = await compensateAsOperator(
          ctx,
          {
            actor: req.user!,
            userId: report.user_id,
            jobId: track.job_id,
            units: 1,
            reason: `${report.report_number}: ${body.reason}`.slice(0, 200),
          },
          tx,
        );
        // One per song: the ledger's (job, compensate) key handed back the
        // earlier batch instead of writing a second one.
        if (!res.created) throw new AppError('CONFLICT', 'this song was already compensated');
        compensation = { batchId: res.batch.id, units: 1 };
      }
      await resolveIssueReport({ id, resolution: body.reason, resolvedBy: req.user!.id, compensation }, tx);
      await writeAuditLog(
        {
          actorId: req.user!.id,
          actorRole: req.user!.role,
          action: 'issue_report.resolved',
          subjectType: 'issue_report',
          subjectId: id,
          reason: body.reason,
          before: { status: 'open' },
          after: { status: 'resolved', compensatedUnits: compensation?.units ?? null },
        },
        tx,
      );
      return compensation?.units ?? null;
    });
    return { status: 'resolved', compensatedUnits };
  });
}
