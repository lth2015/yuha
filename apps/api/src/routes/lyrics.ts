import type { FastifyInstance } from 'fastify';
import { AppError, lyricDraftRequest, type LyricDraftResponse } from '@yuha/contracts';
import { claimLyricDraft, recordCostEvent, settleLyricDraft, trackEvent } from '@yuha/db';
import type { AppContext } from '../context.js';
import { assertWithinDailyBudget } from '../services/generation.js';

/**
 * POST /v1/lyrics/draft — lyrics written before generation.
 *
 * A sung sketch from Air composition arrives on /create with these in the
 * lyrics box, to read and edit before anything is generated. No credit pays
 * for the call, so it is held to LYRIC_DRAFTS_PER_DAY per account in any 24
 * hours (counted race-safely in lyric_drafts, which keeps no text), and the
 * daily upstream budget applies as it does to generation.
 *
 * Order matters for what counts: shape, capability and prompt screening come
 * before the claim, so a refusal of ours costs the creator nothing; once the
 * model is called the draft counts, whatever comes back, because it was paid.
 */
export default async function lyricsRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { ctx } = opts;

  app.post(
    '/v1/lyrics/draft',
    { preHandler: app.requireAgeConfirmed },
    async (req): Promise<LyricDraftResponse> => {
      const body = lyricDraftRequest.parse(req.body);
      const userId = req.user!.id;

      const write = ctx.text.writeLyrics?.bind(ctx.text);
      if (!write) throw new AppError('UNSUPPORTED_CAPABILITY', 'the configured text provider cannot write lyrics');

      const { checkLyrics, checkPrompt } = await import('@yuha/providers');
      const safety = checkPrompt(body.prompt);
      if (!safety.allowed) {
        throw new AppError('PROMPT_BLOCKED', `prompt rejected: ${safety.reason}`, {
          reason: safety.reason,
          hintKey: safety.hintKey,
          appealable: safety.appealable,
        });
      }
      await assertWithinDailyBudget(ctx);

      const limit = ctx.config.LYRIC_DRAFTS_PER_DAY;
      const claim = await claimLyricDraft(userId, limit);
      if (!claim) throw new AppError('RATE_LIMITED', `at most ${limit} lyric drafts in 24 hours`, { limit });

      const result = await write({
        prompt: body.prompt,
        styles: body.styles,
        durationSeconds: body.durationSeconds === 'auto' ? 120 : body.durationSeconds,
      });
      // The model's words are screened like a creator's lyrics before they are handed over.
      const screened = result.status === 'ok' ? checkLyrics(result.lyrics) : null;
      const outcome = result.status !== 'ok' ? result.status : screened!.allowed ? 'ok' : 'refused';

      await settleLyricDraft(claim.id, outcome);
      await recordCostEvent({
        jobId: null,
        providerId: ctx.text.providerId,
        providerKind: 'text',
        eventType: outcome === 'ok' ? 'success' : outcome === 'refused' ? 'rejected' : 'failure',
        billable: true,
        costMinor: result.usage.costMinor,
        isEstimate: result.usage.costIsEstimate,
        usage: {
          purpose: 'lyric_draft',
          promptTokens: result.usage.promptTokens ?? null,
          completionTokens: result.usage.completionTokens ?? null,
          requestId: result.requestId,
        },
      });
      await trackEvent({
        name: 'lyrics_drafted',
        userRef: userId,
        props: { status: outcome },
        runMode: ctx.config.mode,
        isInternal: ctx.config.isDemo,
      }).catch(() => undefined);

      if (result.status === 'failed') throw new AppError('UPSTREAM_UNAVAILABLE', `lyrics could not be written: ${result.reason}`);
      if (outcome === 'refused') throw new AppError('UPSTREAM_REJECTED', 'the lyrics model declined this description');
      return { lyrics: (result as { lyrics: string }).lyrics, remaining: claim.remaining };
    },
  );
}
