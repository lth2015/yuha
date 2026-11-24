import type { FastifyInstance } from 'fastify';
import {
  AppError,
  LYRIC_ANGLES,
  isSungLine,
  lyricDraftRequest,
  lyricLineRequest,
  type LyricAngle,
  type LyricDraftResponse,
  type LyricLineResponse,
} from '@yuha/contracts';
import { claimLyricDrafts, recordCostEvent, settleLyricDraft, trackEvent } from '@yuha/db';
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
      // Three versions are three calls and count as three (docs/LYRIC_COWRITE_SPEC.md).
      const angles: Array<LyricAngle | undefined> = body.variants === 3 ? [...LYRIC_ANGLES] : [undefined];
      const claim = await claimLyricDrafts(userId, limit, angles.length);
      if (!claim) throw new AppError('RATE_LIMITED', `at most ${limit} lyric drafts in 24 hours`, { limit, needed: angles.length });

      const durationSeconds = body.durationSeconds === 'auto' ? 120 : body.durationSeconds;
      const written = await Promise.all(
        angles.map(async (angle, i) => {
          const result = await write({ prompt: body.prompt, styles: body.styles, durationSeconds, ...(angle ? { angle } : {}) });
          // The model's words are screened like a creator's lyrics before they are handed over.
          const screened = result.status === 'ok' ? checkLyrics(result.lyrics) : null;
          const outcome = result.status !== 'ok' ? result.status : screened!.allowed ? 'ok' : 'refused';
          await settleLyricDraft(claim.ids[i]!, outcome);
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
            props: { status: outcome, ...(angle ? { angle } : {}) },
            runMode: ctx.config.mode,
            isInternal: ctx.config.isDemo,
          }).catch(() => undefined);
          return { angle, outcome, lyrics: outcome === 'ok' ? (result as { lyrics: string }).lyrics : null };
        }),
      );

      const ok = written.filter((w) => w.lyrics !== null);
      if (!ok.length) {
        if (written.every((w) => w.outcome === 'refused')) throw new AppError('UPSTREAM_REJECTED', 'the lyrics model declined this description');
        throw new AppError('UPSTREAM_UNAVAILABLE', 'lyrics could not be written');
      }
      return {
        lyrics: ok[0]!.lyrics!,
        remaining: claim.remaining,
        ...(body.variants === 3 ? { variants: ok.map((w) => ({ angle: w.angle!, lyrics: w.lyrics! })) } : {}),
      };
    },
  );

  /**
   * POST /v1/lyrics/line — three other ways to say one line
   * (docs/LYRIC_LINE_SPEC.md). Same order as a draft: shape, capability and
   * screening first, so nothing of ours that refuses costs a draft; then one
   * draft is claimed and the model called.
   *
   * The lyrics are screened as well as the description: they go to the model
   * as context, and whatever they say is the creator's own text.
   */
  app.post(
    '/v1/lyrics/line',
    { preHandler: app.requireAgeConfirmed },
    async (req): Promise<LyricLineResponse> => {
      const body = lyricLineRequest.parse(req.body);
      const userId = req.user!.id;
      if (!isSungLine(body.lyrics.split('\n')[body.line])) {
        throw new AppError('VALIDATION_FAILED', 'line must be a sung line of the lyrics, not empty and not a section marker');
      }

      const rewrite = ctx.text.rewriteLine?.bind(ctx.text);
      if (!rewrite) throw new AppError('UNSUPPORTED_CAPABILITY', 'the configured text provider cannot rewrite a line');

      const { checkLyrics, checkPrompt } = await import('@yuha/providers');
      for (const verdict of [body.prompt ? checkPrompt(body.prompt) : null, checkLyrics(body.lyrics)]) {
        if (verdict && !verdict.allowed) {
          throw new AppError('PROMPT_BLOCKED', `rejected: ${verdict.reason}`, {
            reason: verdict.reason,
            hintKey: verdict.hintKey,
            appealable: verdict.appealable,
          });
        }
      }
      await assertWithinDailyBudget(ctx);

      const limit = ctx.config.LYRIC_DRAFTS_PER_DAY;
      const claim = await claimLyricDrafts(userId, limit, 1);
      if (!claim) throw new AppError('RATE_LIMITED', `at most ${limit} lyric drafts in 24 hours`, { limit, needed: 1 });

      const result = await rewrite({ prompt: body.prompt, lyrics: body.lyrics, line: body.line, styles: body.styles });
      // Each alternative is screened like a creator's line before it is offered.
      const lines = result.status === 'ok' ? result.lines.filter((l) => checkLyrics(l).allowed) : [];
      const outcome = result.status !== 'ok' ? result.status : lines.length ? 'ok' : 'refused';
      await settleLyricDraft(claim.ids[0]!, outcome);
      await recordCostEvent({
        jobId: null,
        providerId: ctx.text.providerId,
        providerKind: 'text',
        eventType: outcome === 'ok' ? 'success' : outcome === 'refused' ? 'rejected' : 'failure',
        billable: true,
        costMinor: result.usage.costMinor,
        isEstimate: result.usage.costIsEstimate,
        usage: {
          purpose: 'lyric_line',
          promptTokens: result.usage.promptTokens ?? null,
          completionTokens: result.usage.completionTokens ?? null,
          requestId: result.requestId,
        },
      });
      await trackEvent({
        name: 'lyric_line_rewritten',
        userRef: userId,
        props: { status: outcome },
        runMode: ctx.config.mode,
        isInternal: ctx.config.isDemo,
      }).catch(() => undefined);

      if (outcome === 'refused') throw new AppError('UPSTREAM_REJECTED', 'the lyrics model declined this line');
      if (outcome !== 'ok') throw new AppError('UPSTREAM_UNAVAILABLE', 'the line could not be rewritten');
      return { lines, remaining: claim.remaining };
    },
  );
}
