import type { FastifyInstance } from 'fastify';
import { AppError, setVisibilityRequest, type TrackView } from '@yuha/contracts';
import type { LyricTimings } from '@yuha/contracts';
import {
  getMasterAsset,
  getPublicTrack,
  listPublicTracks,
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
    licenseCount: opts.licenseCount ?? 0,
    licensedByMe: opts.licensedByMe ?? null,
    createdAt: row.created_at.toISOString(),
    previewUrl: opts.previewUrl,
    demo: ctx.config.isDemo,
  };
}

/**
 * How many songs the showcase hands out.
 *
 * The seeded showcase is six; the cap is what stops a growing public catalogue
 * from turning a landing page into an unbounded query.
 */
const SHOWCASE_LIMIT = 12;

async function previewUrlFor(ctx: AppContext, trackId: string): Promise<string | null> {
  const master = await getMasterAsset(trackId);
  if (!master) return null;
  return (
    await ctx.storage.signedUrl({
      zone: 'delivery',
      key: master.storage_key,
      ttlSeconds: ctx.config.DOWNLOAD_URL_TTL_SECONDS,
    })
  ).url;
}

/**
 * The showcase list, the play counter, and the visibility flip.
 *
 * The ranked public feed that once lived here was removed in b63d66b as a
 * product decision, and its listing in 91be961. `GET /v1/explore` is back by a
 * later decision, but deliberately smaller than what was deleted: a capped,
 * newest-first list of published songs so the landing page can be heard before
 * anyone signs up. No ranking, no trending, no like counter — those were the
 * parts that had no reader, and they are not coming back with it.
 *
 * It is the one route in this app that answers without a bearer token. That is
 * the point of it: a visitor with no account is exactly who it is for. It
 * returns only what `getPublicTrack` would already hand out for the same song,
 * so it widens who can list published songs, never what a published song
 * reveals.
 */
export default async function exploreRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { ctx } = opts;

  /**
   * GET /v1/explore — the landing page's showcase, no sign-in required.
   *
   * Rate-limited per IP like the play counter beside it, because it is
   * unauthenticated and each row costs a signed-URL round trip.
   */
  app.get(
    '/v1/explore',
    {
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
    },
    async () => {
      const rows = await listPublicTracks(SHOWCASE_LIMIT);
      const items = await Promise.all(
        rows.map(async (row) =>
          toPublicTrackView(ctx, row, {
            previewUrl: await previewUrlFor(ctx, row.id),
            licenseCount: 0,
            // Nobody is signed in on this route, so there is no "me" to answer
            // for. null is the view's own word for "not known", not for "no".
            licensedByMe: null,
          }),
        ),
      );
      return { items };
    },
  );

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
  app.post('/v1/tracks/:id/visibility', { preHandler: app.requireAuth }, async (req) => {
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
