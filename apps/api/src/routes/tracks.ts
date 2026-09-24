import type { FastifyInstance } from 'fastify';
import {
  AppError,
  createExportRequest,
  listTracksQuery,
  type LicenseSnapshotView,
  type TrackView,
} from '@yuha/contracts';
import type { LyricTimings } from '@yuha/contracts';
import {
  getLicenseSnapshot,
  getMasterAsset,
  getPublicTrack,
  getTrackForUser,
  hasLicense,
  countLicenses,
  listAssets,
  listTracks,
  softDeleteTrack,
  trackEvent,
  type TrackRow,
} from '@yuha/db';
import { licenseStateFor } from '../services/market.js';
import type { AppContext } from '../context.js';
import { createExport, issueDownloadUrl } from '../services/exports.js';
import { LICENSE_DISCLAIMER } from '../services/delivery.js';
import { toPublicTrackView } from './explore.js';

async function toTrackView(
  ctx: AppContext,
  row: TrackRow,
  viewerId: string,
): Promise<TrackView> {
  const master = await getMasterAsset(row.id);
  // A suspended track gets no playable URL at all — the pause has to be real,
  // not a hidden button (SEC-10 / SEC-01).
  const previewUrl =
    master && row.state === 'deliverable'
      ? (
          await ctx.storage.signedUrl({
            zone: 'delivery',
            key: master.storage_key,
            ttlSeconds: ctx.config.DOWNLOAD_URL_TTL_SECONDS,
          })
        ).url
      : null;

  return {
    trackId: row.id,
    projectId: row.project_id,
    jobId: row.job_id,
    title: row.title,
    artistName: null,
    artistId: row.owner_id,
    state: row.state,
    scene: row.scene as TrackView['scene'],
    mood: (row.mood ?? null) as TrackView['mood'],
    styles: row.styles ?? [],
    vocalMode: row.vocal_mode,
    visibility: row.visibility,
    durationSeconds: row.duration_ms / 1000,
    playCount: row.play_count,
    coverSeed: row.cover_seed,
    lyricTimings: (row.lyric_timings ?? null) as LyricTimings | null,
    licenseCount: await countLicenses(row.id),
    licensedByMe: viewerId === row.owner_id ? false : await hasLicense(row.id, viewerId),
    createdAt: row.created_at.toISOString(),
    previewUrl,
    demo: ctx.config.isDemo,
  };
}

export default async function trackRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { ctx } = opts;

  /** GET /v1/tracks — private library, scoped to the caller (UI-08). */
  app.get('/v1/tracks', { preHandler: app.requireAuth }, async (req) => {
    const q = listTracksQuery.parse(req.query);
    const rows = await listTracks({
      userId: req.user!.id,
      limit: q.limit + 1,
      cursor: q.cursor,
      state: q.state,
      q: q.q,
      projectId: q.projectId,
    });
    const page = rows.slice(0, q.limit);
    const items = await Promise.all(page.map((r) => toTrackView(ctx, r, req.user!.id)));
    return {
      items,
      nextCursor: rows.length > q.limit ? page[page.length - 1]!.created_at.toISOString() : null,
    };
  });

  /**
   * GET /v1/tracks/:id — owner detail with exports, or a published song read
   * anonymously (same view shape as Explore so one card component renders both).
   */
  app.get('/v1/tracks/:id', { preHandler: app.requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const track = await getTrackForUser(id, req.user!.id);
    if (track) {
      const assets = await listAssets(track.id);
      return {
        ...(await toTrackView(ctx, track, req.user!.id)),
        lyrics: track.lyrics,
        exports: assets
          .filter((a) => a.kind === 'export')
          .map((a) => ({
            exportId: a.id,
            format: a.format,
            clipStartSeconds: (a.clip_start_ms ?? 0) / 1000,
            clipDurationSeconds: (a.clip_duration_ms ?? 0) / 1000,
            fadeOut: a.fade_out_ms > 0,
            byteSize: a.byte_size,
            sha256: a.sha256,
            createdAt: a.created_at.toISOString(),
          })),
      };
    }
    // Not the owner: visible only if it is published.
    const publicRow = await getPublicTrack(id);
    if (!publicRow) throw new AppError('NOT_FOUND', 'track not found');
    const master = await getMasterAsset(publicRow.id);
    const lic = await licenseStateFor(publicRow.id, req.user!.id);
    const previewUrl = master
      ? (
          await ctx.storage.signedUrl({
            zone: 'delivery',
            key: master.storage_key,
            ttlSeconds: ctx.config.DOWNLOAD_URL_TTL_SECONDS,
          })
        ).url
      : null;
    return {
      ...toPublicTrackView(ctx, publicRow, {
        previewUrl,
        licenseCount: lic.licenseCount,
        licensedByMe: lic.licensedByMe,
      }),
      lyrics: publicRow.lyrics,
      exports: [],
    };
  });

  /** POST /v1/tracks/:id/exports — trimming and re-downloads never cost credits. */
  app.post(
    '/v1/tracks/:id/exports',
    {
      preHandler: app.requireAuth,
      config: {
        rateLimit: {
          max: ctx.config.EXPORT_RATE_LIMIT_PER_HOUR,
          timeWindow: '1 hour',
          keyGenerator: (req: { user?: { id: string }; ip: string }) => req.user?.id ?? req.ip,
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = createExportRequest.parse(req.body);
      return createExport(ctx, { userId: req.user!.id, trackId: id, request: body });
    },
  );

  /** Re-issues a short-lived link for an existing export (UI-08 "再ダウンロード"). */
  app.post('/v1/exports/:exportId/download-url', { preHandler: app.requireAuth }, async (req) => {
    const { exportId } = req.params as { exportId: string };
    return issueDownloadUrl(ctx, { userId: req.user!.id, assetId: exportId });
  });

  /**
   * GET /v1/tracks/:id/license — the terms in force when the track was made.
   * Provider contract commercials are deliberately not exposed.
   */
  app.get('/v1/tracks/:id/license', { preHandler: app.requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const track = await getTrackForUser(id, req.user!.id);
    if (!track) throw new AppError('NOT_FOUND', 'track not found');

    const snap = await getLicenseSnapshot(track.id);
    if (!snap) throw new AppError('NOT_FOUND', 'no licence record for this track');

    const assets = await listAssets(track.id);
    const view: LicenseSnapshotView = {
      trackId: track.id,
      licenseVersion: snap.license_version,
      providerId: snap.provider_id,
      providerModel: snap.provider_model,
      generatedAt: snap.generated_at.toISOString(),
      territory: snap.territory,
      allowedUses: snap.allowed_uses,
      prohibitedUses: snap.prohibited_uses,
      sourceSha256: snap.source_sha256,
      derivedVersions: assets.map((a) => ({
        kind: a.kind,
        format: a.format,
        sha256: a.sha256,
        createdAt: a.created_at.toISOString(),
      })),
      status: snap.status,
      commercialDeliveryEnabled: snap.commercial_delivery,
      disclaimer: LICENSE_DISCLAIMER,
    };
    return view;
  });

  app.delete('/v1/tracks/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = await softDeleteTrack({ trackId: id, userId: req.user!.id });
    if (!deleted) {
      // Either it does not exist, or it is evidence in an open rights case and
      // must be preserved. The message says which without leaking other users' data.
      const track = await getTrackForUser(id, req.user!.id);
      if (!track) throw new AppError('NOT_FOUND', 'track not found');
      throw new AppError(
        'TRACK_SUSPENDED',
        'この楽曲は権利申立の調査中のため削除できません。削除リクエストとして受け付けます。',
      );
    }
    await trackEvent({
      name: 'track_deleted',
      userRef: req.user!.id,
      runMode: ctx.config.mode,
      isInternal: ctx.config.isDemo,
    });
    return reply.status(204).send();
  });

  /**
   * Self-reported adoption (§11.2). "Adopted" means the creator actually used
   * the track in their content — deliberately distinct from a download, so the
   * cost-per-adopted-result metric is not inflated by curiosity downloads.
   */
  app.post('/v1/tracks/:id/adopted', { preHandler: app.requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const track = await getTrackForUser(id, req.user!.id);
    if (!track) throw new AppError('NOT_FOUND', 'track not found');
    const body = (req.body ?? {}) as { publishedUrl?: string };
    await trackEvent({
      name: 'track_adopted',
      userRef: req.user!.id,
      props: {
        track_id: track.id,
        // Self-reported and verified URLs are reported separately (§10).
        self_reported: !body.publishedUrl,
        has_url: !!body.publishedUrl,
      },
      runMode: ctx.config.mode,
      isInternal: ctx.config.isDemo,
    });
    return reply.status(202).send({ recorded: true });
  });
}
