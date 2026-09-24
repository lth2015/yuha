import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  IDEMPOTENCY_HEADER,
  createGenerationRequest,
  idempotencyKeySchema,
} from '@yuha/contracts';
import { getBalance, getTrackForUser, listOpenJobs, trackEvent } from '@yuha/db';
import type { AppContext } from '../context.js';
import { cancelGeneration, createGeneration, getJobView, toJobView } from '../services/generation.js';

export default async function generationRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { ctx } = opts;

  /**
   * POST /v1/generations — 202 with a job id (§10).
   * The idempotency key is mandatory: without it a network retry would create a
   * second job and a second charge.
   */
  app.post(
    '/v1/generations',
    {
      preHandler: app.requireAgeConfirmed,
      config: {
        rateLimit: {
          max: ctx.config.GENERATION_RATE_LIMIT_PER_HOUR,
          timeWindow: '1 hour',
          keyGenerator: (req: { user?: { id: string }; ip: string }) => req.user?.id ?? req.ip,
        },
      },
    },
    async (req, reply) => {
      const rawKey = req.headers[IDEMPOTENCY_HEADER];
      const parsedKey = idempotencyKeySchema.safeParse(Array.isArray(rawKey) ? rawKey[0] : rawKey);
      if (!parsedKey.success) {
        throw new AppError('VALIDATION_FAILED', `a valid ${IDEMPOTENCY_HEADER} header is required`);
      }
      const body = createGenerationRequest.parse(req.body);

      const result = await createGeneration(ctx, {
        userId: req.user!.id,
        idempotencyKey: parsedKey.data,
        request: body,
      });

      // The full job view, so the client can render the progress screen without
      // an immediate follow-up GET.
      return reply.status(202).send({
        ...toJobView(ctx, result.job),
        deduplicated: result.deduplicated,
      });
    },
  );

  /** GET /v1/jobs/:id — owner-scoped status polling with backoff hints. */
  app.get('/v1/jobs/:id', { preHandler: app.requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return getJobView(ctx, id, req.user!.id);
  });

  app.post('/v1/jobs/:id/cancel', { preHandler: app.requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return cancelGeneration(ctx, { jobId: id, userId: req.user!.id });
  });

  /**
   * Open jobs for the current user, so the studio can restore in-flight work
   * after a refresh or a re-login (GEN-10).
   */
  app.get('/v1/jobs', { preHandler: app.requireAuth }, async (req) => {
    const rows = await listOpenJobs(req.user!.id);
    return { items: rows.map((r) => toJobView(ctx, r)) };
  });

  const editRequestSchema = z.object({
    /** The creator's change instructions, screened like any prompt. */
    instructions: z.string().trim().min(1).max(300),
  });

  /**
   * POST /v1/tracks/:id/edit — GPT-assisted track editing.
   *
   * Loads the owner's delivered song, has the text provider rewrite lyrics and
   * styles per the instructions, then submits a NEW generation (1 credit, same
   * idempotency guarantees) seeded from the revision. The original is never
   * mutated — an edit is a new take.
   */
  app.post(
    '/v1/tracks/:id/edit',
    { preHandler: app.requireAgeConfirmed },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const rawKey = req.headers[IDEMPOTENCY_HEADER];
      const parsedKey = idempotencyKeySchema.safeParse(Array.isArray(rawKey) ? rawKey[0] : rawKey);
      if (!parsedKey.success) {
        throw new AppError('VALIDATION_FAILED', `a valid ${IDEMPOTENCY_HEADER} header is required`);
      }
      const body = editRequestSchema.parse(req.body);

      const track = await getTrackForUser(id, req.user!.id);
      if (!track) throw new AppError('NOT_FOUND', 'track not found');
      if (track.state !== 'deliverable') throw new AppError('TRACK_NOT_DELIVERABLE', 'only finished songs can be edited');

      if (!ctx.text.reviseSong) {
        throw new AppError('UNSUPPORTED_CAPABILITY', 'the configured text provider cannot edit songs');
      }

      const { checkPrompt } = await import('@yuha/providers');
      const safety = checkPrompt(body.instructions);
      if (!safety.allowed) {
        throw new AppError('PROMPT_BLOCKED', `instructions rejected: ${safety.reason}`, {
          reason: safety.reason,
          hintKey: safety.hintKey,
          appealable: safety.appealable,
        });
      }

      const revision = await ctx.text.reviseSong({
        instructions: body.instructions,
        original: {
          title: track.title,
          styles: track.styles ?? [],
          lyrics: track.lyrics,
          instrumental: track.vocal_mode === 'instrumental',
          durationSeconds: Math.round(track.duration_ms / 1000),
        },
      });

      await trackEvent({
        name: 'song_edit_requested',
        userRef: req.user!.id,
        props: { track_id: track.id, revision_status: revision.status },
        runMode: ctx.config.mode,
        isInternal: ctx.config.isDemo,
      }).catch(() => undefined);

      if (revision.status !== 'ok') {
        throw new AppError('GENERATION_FAILED', `the editor could not process these instructions: ${revision.reason}`);
      }

      const raw = Math.round(track.duration_ms / 1000);
      const duration: 30 | 60 | 120 | 180 | 240 = ([30, 60, 120, 180, 240] as const).includes(raw as 30) ? (raw as 30 | 60 | 120 | 180 | 240) : 120;
      const result = await createGeneration(ctx, {
        userId: req.user!.id,
        idempotencyKey: parsedKey.data,
        request: {
          mode: 'custom',
          ...(revision.title ? { title: `${revision.title}` } : {}),
          prompt: body.instructions,
          ...(revision.lyrics && track.vocal_mode === 'with_vocals' ? { lyrics: revision.lyrics } : {}),
          styles: revision.styles,
          instrumental: track.vocal_mode === 'instrumental',
          energy: 0.5,
          durationSeconds: [30, 60, 120, 180, 240].includes(duration) ? duration : 120,
          visibility: track.visibility,
        },
      });

      return reply.status(202).send({
        ...toJobView(ctx, result.job),
        deduplicated: result.deduplicated,
        revision: { title: revision.title, styles: revision.styles, hasLyrics: !!revision.lyrics },
      });
    },
  );

  /**
   * UI-03 requires the create screen to show the real remaining balance before
   * submission, not an optimistic client-side number.
   */
  app.get('/v1/entitlements/summary', { preHandler: app.requireAuth }, async (req) => {
    const balance = await getBalance(req.user!.id);
    return {
      availableUnits: balance.available,
      reservedUnits: balance.reserved,
      costOfNextGeneration: 1,
    };
  });
}
