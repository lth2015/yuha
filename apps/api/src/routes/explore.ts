import type { FastifyInstance } from 'fastify';
import { AppError, setVisibilityRequest, type TrackView } from '@yuha/contracts';
import type { LyricTimings } from '@yuha/contracts';
import {
  getPublicTrack,
  getTrackForUser,
  hasLicense,
  countLicenses,
  incrementPlayCount,
  setTrackVisibility,
  softDeleteTrack,
  trackEvent,
  withTx,
  type TrackWithArtist,
} from '@yuha/db';
import { licenseStateFor } from '../services/market.js';
import type { AppContext } from '../context.js';

export function toPublicTrackView(
  ctx: AppContext,
  row: TrackWithArtist,
  opts: {
    previewUrl: string | null;
    licenseCount?: number;
    licensedByMe?: boolean | null;
  },
): TrackView {
  return {
    trackId: row.id,
    projectId: row.project_id,
    jobId: row.job_id,
    title: row.title,
    artistName: row.artist_name,
    artistId: row.owner_id,
    state: row.state,
    scene: row.scene as TrackView['scene'],
    mood: (row.mood ?? null) as TrackView['mood'],
    styles: row.styles ?? [],
    vocalMode: row.vocal_mode,
    visibility: row.visibility,
    durationSeconds: row.duration_ms / 1000,
    coverSeed: row.cover_seed,
    lyricTimings: (row.lyric_timings ?? null) as LyricTimings | null,
    dedication: row.dedication ?? null,
    licenseCount: opts.licenseCount ?? 0,
    licensedByMe: opts.licensedByMe ?? null,
    createdAt: row.created_at.toISOString(),
    previewUrl: opts.previewUrl,
    demo: ctx.config.isDemo,
  };
}

/**
 * The play counter and the visibility flip.
 *
 * `GET /v1/explore`, a capped newest-first list of published songs for the
 * home page, was removed on 2026-11-25 by product decision: there is no
 * browsable list of songs (CLAUDE.md, "No public feed"). Songs are private, and
 * "public" means anyone holding the link can open it.
 *
 * Earlier: a ranked feed (removed in b63d66b, its listing in 91be961), then
 * this smaller showcase list, now gone too.
 */
export default async function exploreRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { ctx } = opts;

  /** POST /v1/explore/:id/plays — engagement counter; rate-limited per IP. */
  app.post(
    '/v1/explore/:id/plays',
    {
      // It reads `req.user?.id` below, which was always undefined without
      // this: no hook ran, so every play was recorded anonymously even when
      // the caller sent a token.
      preHandler: app.optionalAuth,
      config: {
        rateLimit: { max: 120, timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      await incrementPlayCount(id);
      await trackEvent({
        name: 'song_played',
        userRef: req.user?.id ?? null,
        props: { track_id: id },
        runMode: ctx.config.mode,
        isInternal: ctx.config.isDemo,
      }).catch(() => undefined);
      return reply.status(202).send({ recorded: true });
    },
  );
  /**
   * POST /v1/tracks/:id/visibility — publish to Explore, or pull back.
   *
   * Unpublishing revokes the shared link immediately.
   */
  app.post('/v1/tracks/:id/visibility', { preHandler: app.requireAuth, config: { guestAllowed: true } }, async (req) => {
    const { id } = req.params as { id: string };
    const body = setVisibilityRequest.parse(req.body);
    const moved = await setTrackVisibility({
      trackId: id,
      ownerId: req.user!.id,
      visibility: body.visibility,
    });
    if (!moved) {
      const track = await getTrackForUser(id, req.user!.id);
      if (!track) throw new AppError('NOT_FOUND', 'song not found');
      throw new AppError('TRACK_NOT_DELIVERABLE', 'only finished songs can be published');
    }
    await trackEvent({
      name: body.visibility === 'public' ? 'song_published' : 'song_unpublished',
      userRef: req.user!.id,
      props: { track_id: id },
      runMode: ctx.config.mode,
      isInternal: ctx.config.isDemo,
    });
    return { trackId: id, visibility: body.visibility };
  });
}
