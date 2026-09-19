import type { AppContext } from '@loopscene/api';
import { deliver, failJob, handleLateResult, quarantineKey } from '@loopscene/api';
import { musicIntent, type MusicIntent } from '@loopscene/contracts';
import {
  extendLease,
  getJob,
  insertAttempt,
  incrementAttempt,
  latestAttempt,
  query,
  recordCostEvent,
  releaseLease,
  releaseReservation,
  setTrackLyricTimings,
  transitionJob,
  updateAttempt,
  withTx,
  type JobRow,
} from '@loopscene/db';
import { fetchAudio, HttpMusicProvider, redactPrompt, type MusicAudioRef } from '@loopscene/providers';

export interface PipelineDeps {
  ctx: AppContext;
  owner: string;
  log: (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;
}

/**
 * Runs one step of a job's lifecycle.
 *
 * The function is written so that being invoked twice for the same job — a
 * duplicated SQS message, a redelivery after a crash — is safe: every state
 * change goes through `transitionJob` with the version the worker read, so the
 * loser of a race simply does nothing (GEN-04/GEN-05/GEN-08).
 */
export async function runJobStep(deps: PipelineDeps, jobId: string): Promise<void> {
  const { ctx, owner, log } = deps;

  const job = await getJob(jobId);
  if (!job) {
    log('warn', 'job not found', { jobId });
    return;
  }
  if (['DELIVERED', 'FAILED', 'REJECTED', 'CANCELLED'].includes(job.state)) return;

  try {
    switch (job.state) {
      case 'QUEUED':
        await submitJob(deps, job);
        break;
      case 'SUBMITTED':
      case 'PROCESSING':
      case 'UNKNOWN':
        await pollJob(deps, job);
        break;
      default:
        log('warn', 'job in unexpected state for worker', { jobId, state: job.state });
    }
  } finally {
    await releaseLease(jobId, owner).catch(() => undefined);
  }
}

/** Cost accounting for one upstream interaction (AI-06). */
async function recordMusicCost(
  ctx: AppContext,
  params: {
    job: JobRow;
    attemptId: string | null;
    eventType: 'success' | 'failure' | 'rejected' | 'retry' | 'late_success' | 'cancelled';
  },
): Promise<void> {
  const caps = ctx.music.capabilities();
  // Whether a failure is billable comes from the configured contract. It is
  // never assumed to be free just because it failed.
  const billable = params.eventType === 'success' || params.eventType === 'late_success' || caps.billFailedRequests;
  await recordCostEvent({
    jobId: params.job.id,
    attemptId: params.attemptId,
    providerId: caps.providerId,
    providerKind: 'music',
    eventType: params.eventType,
    billable,
    costMinor: billable ? caps.costPerRequestMinor : 0,
    isEstimate: caps.costIsEstimate,
    contractVersion: caps.contractVersion,
  });
}

/**
 * QUEUED → SUBMITTED. Resolves the creative intent, then hands a request to
 * the music provider under a stable idempotency key.
 */
async function submitJob(deps: PipelineDeps, job: JobRow): Promise<void> {
  const { ctx, log } = deps;

  // GEN-12: the user asked to cancel and the provider has not been called yet,
  // so the cancellation wins. The version guard means only one of the two
  // outcomes can happen — never "cancelled" *and* a charge.
  if (job.cancel_requested_at) {
    const cancelled = await withTx(async (tx) => {
      const moved = await transitionJob(
        {
          jobId: job.id,
          expectedVersion: job.version,
          from: 'QUEUED',
          to: 'CANCELLED',
          patch: { errorCode: 'cancelled_by_user', clearLease: true },
        },
        tx,
      );
      if (!moved) return false;
      await releaseReservation({ userId: job.user_id, jobId: job.id, reason: 'cancelled_by_user' }, tx);
      return true;
    });
    if (cancelled) {
      log('info', 'job cancelled before submission', { jobId: job.id });
      return;
    }
  }

  const input = job.input as {
    mode?: 'simple' | 'custom';
    prompt: string;
    lyrics?: string | null;
    styles?: string[];
    instrumental?: boolean;
    title?: string | null;
    energy: number;
    durationSeconds: number;
  };

  // ---- text model: turn the creator's description into validated parameters
  const intentResult = await ctx.text.extractIntent({
    scene: 'daily_log', // The provider derives the real scene from styles.
    mode: input.mode ?? 'simple',
    prompt: input.prompt,
    lyrics: input.mode === 'custom' ? (input.lyrics ?? null) : null,
    styles: input.styles ?? [],
    instrumental: input.instrumental ?? true,
    title: input.title ?? null,
    energy: input.energy,
    durationSeconds: input.durationSeconds,
  });

  await recordCostEvent({
    jobId: job.id,
    providerId: ctx.text.providerId,
    providerKind: 'text',
    eventType: intentResult.status === 'ok' ? 'success' : 'failure',
    billable: true,
    costMinor: intentResult.usage.costMinor,
    isEstimate: intentResult.usage.costIsEstimate,
    usage: {
      promptTokens: intentResult.usage.promptTokens ?? null,
      completionTokens: intentResult.usage.completionTokens ?? null,
      requestId: intentResult.requestId,
    },
  });

  if (intentResult.status !== 'ok') {
    log('warn', 'intent extraction failed', {
      jobId: job.id,
      status: intentResult.status,
      prompt: redactPrompt(input.prompt),
    });
    await failJob(ctx, {
      job,
      to: intentResult.status === 'refused' ? 'REJECTED' : 'FAILED',
      errorCode: intentResult.status === 'refused' ? 'text_model_refused' : 'text_model_failed',
      errorDetail: intentResult.status === 'failed' ? intentResult.code : intentResult.reason,
    });
    return;
  }

  // Server-side re-validation. AI-03: the model's output is data, and it never
  // reaches the music provider without passing our own schema. The creator's
  // own choices (duration, vocal mode, title) are re-imposed here rather than
  // trusted from the model.
  const parsed = musicIntent.safeParse({
    ...intentResult.intent,
    durationSeconds: input.durationSeconds,
    vocalMode: input.instrumental === false ? 'with_vocals' : 'instrumental',
    lyrics: input.instrumental === false ? (input.lyrics ?? intentResult.intent.lyrics ?? null) : null,
    title: input.title ?? intentResult.intent.title ?? null,
  });
  if (!parsed.success) {
    await failJob(ctx, { job, to: 'FAILED', errorCode: 'intent_schema_invalid' });
    return;
  }
  const intent = parsed.data;

  // ---- music provider
  const attemptNo = await withTx(async (tx) => incrementAttempt(job.id, tx));
  const attempt = await withTx(async (tx) =>
    insertAttempt(
      {
        jobId: job.id,
        attemptNo,
        providerId: ctx.music.capabilities().providerId,
        providerModel: ctx.music.capabilities().model,
        // Redacted envelope: the brief, not the user's raw text (SEC-06).
        requestPayload: { intent: { ...intent, brief: intent.brief.slice(0, 200) } },
      },
      tx,
    ),
  );

  const result = await ctx.music.submit({
    intent,
    requestKey: job.provider_request_key,
    format: 'mp3',
  });

  switch (result.status) {
    case 'submitted': {
      await updateAttempt({
        attemptId: attempt.id,
        status: 'submitted',
        providerRequestId: result.providerRequestId,
      });
      await withTx(async (tx) => {
        await transitionJob(
          {
            jobId: job.id,
            expectedVersion: job.version,
            from: 'QUEUED',
            to: 'SUBMITTED',
            patch: { resolvedParams: intent as unknown as Record<string, unknown> },
          },
          tx,
        );
      });
      log('info', 'submitted to music provider', { jobId: job.id, attemptNo });
      break;
    }
    case 'completed': {
      await updateAttempt({
        attemptId: attempt.id,
        status: 'succeeded',
        providerRequestId: result.providerRequestId,
        finished: true,
      });
      const moved = await withTx(async (tx) =>
        transitionJob(
          {
            jobId: job.id,
            expectedVersion: job.version,
            from: 'QUEUED',
            to: 'SUBMITTED',
            patch: { resolvedParams: intent as unknown as Record<string, unknown> },
          },
          tx,
        ),
      );
      if (moved) await processAudio(deps, moved, intent, result.audio, attempt.id);
      break;
    }
    case 'rejected': {
      await updateAttempt({ attemptId: attempt.id, status: 'rejected', errorCode: result.code, finished: true });
      await recordMusicCost(ctx, { job, attemptId: attempt.id, eventType: 'rejected' });
      // §6.1: a provider rejection is not the user's fault and costs no credit.
      await failJob(ctx, { job, to: 'REJECTED', errorCode: 'upstream_rejected', errorDetail: result.code });
      break;
    }
    case 'failed': {
      await updateAttempt({ attemptId: attempt.id, status: 'failed', errorCode: result.code, finished: true });
      await recordMusicCost(ctx, { job, attemptId: attempt.id, eventType: 'failure' });
      await failJob(ctx, { job, to: 'FAILED', errorCode: 'upstream_failed', errorDetail: result.code });
      break;
    }
    case 'unknown': {
      // GEN-06: the request may well have been accepted. Move to UNKNOWN and
      // verify by querying; never re-submit a possibly-billable request blind.
      await updateAttempt({ attemptId: attempt.id, status: 'unknown', errorCode: result.code });
      await withTx(async (tx) => {
        await transitionJob(
          {
            jobId: job.id,
            expectedVersion: job.version,
            from: 'QUEUED',
            to: 'UNKNOWN',
            patch: {
              resolvedParams: intent as unknown as Record<string, unknown>,
              errorCode: result.code,
            },
          },
          tx,
        );
      });
      log('warn', 'submission outcome unknown, entering verification', { jobId: job.id, code: result.code });
      break;
    }
  }
}

/**
 * SUBMITTED / UNKNOWN / PROCESSING → terminal.
 *
 * Always queries by the stable request key, so verifying an UNKNOWN job cannot
 * accidentally start a second generation.
 */
async function pollJob(deps: PipelineDeps, job: JobRow): Promise<void> {
  const { ctx, log } = deps;
  const caps = ctx.music.capabilities();

  if (!caps.supportsStatusQuery) {
    // Without a status query there is nothing safe to do but wait for the
    // provider's webhook; the reconciler will time the job out eventually.
    return;
  }

  const attempt = await latestAttempt(job.id);
  const result = await ctx.music.poll({
    requestKey: job.provider_request_key,
    providerRequestId: attempt?.provider_request_id ?? null,
  });

  const intent = job.resolved_params
    ? (musicIntent.safeParse(job.resolved_params).data ?? null)
    : null;

  switch (result.status) {
    case 'pending':
      return;

    case 'not_found': {
      if (job.state === 'UNKNOWN') {
        // Verified: the provider never accepted it. Safe to fail and refund —
        // this is exactly the evidence GEN-06 requires before acting.
        await failJob(ctx, {
          job,
          to: 'FAILED',
          errorCode: 'upstream_no_record',
          errorDetail: 'provider has no record of this request key',
        });
        log('info', 'verification found no upstream record; credit released', { jobId: job.id });
      }
      return;
    }

    case 'completed': {
      if (!intent) {
        await failJob(ctx, { job, to: 'FAILED', errorCode: 'missing_resolved_params' });
        return;
      }
      if (attempt) {
        await updateAttempt({ attemptId: attempt.id, status: 'succeeded', finished: true });
      }
      await processAudio(deps, job, intent, result.audio, attempt?.id ?? null);
      return;
    }

    case 'rejected': {
      if (attempt) await updateAttempt({ attemptId: attempt.id, status: 'rejected', errorCode: result.code, finished: true });
      await recordMusicCost(ctx, { job, attemptId: attempt?.id ?? null, eventType: 'rejected' });
      await failJob(ctx, { job, to: 'REJECTED', errorCode: 'upstream_rejected', errorDetail: result.code });
      return;
    }

    case 'failed': {
      if (attempt) await updateAttempt({ attemptId: attempt.id, status: 'failed', errorCode: result.code, finished: true });
      await recordMusicCost(ctx, { job, attemptId: attempt?.id ?? null, eventType: 'failure' });
      await failJob(ctx, { job, to: 'FAILED', errorCode: 'upstream_failed', errorDetail: result.code });
      return;
    }
  }
}

/**
 * Fetch → quarantine → verify → deliver.
 *
 * Audio is written to the quarantine zone and checked before anything reaches
 * the user's library (AI-07). A file that fails the checks never becomes
 * downloadable and never consumes a credit.
 */
async function processAudio(
  deps: PipelineDeps,
  job: JobRow,
  intent: MusicIntent,
  audioRef: MusicAudioRef,
  attemptId: string | null,
): Promise<void> {
  const { ctx, owner, log } = deps;

  const processing = await withTx(async (tx) =>
    transitionJob({ jobId: job.id, expectedVersion: job.version, from: job.state, to: 'PROCESSING' }, tx),
  );
  // Another worker or a webhook already took this job forward.
  if (!processing) return;

  // The download and the audio checks can take a while; keep the lease alive
  // rather than holding a database transaction open (GEN-05).
  await extendLease({ jobId: job.id, owner, leaseSeconds: ctx.config.JOB_LEASE_SECONDS });

  let buffer: Buffer;
  try {
    if (audioRef.kind === 'buffer') {
      buffer = audioRef.buffer!;
    } else {
      // SEC-05: only the provider's allow-listed hosts, https only, size and
      // time capped, redirects refused.
      const hosts =
        ctx.music instanceof HttpMusicProvider
          ? ctx.music.allowedAudioHosts()
          : [];
      const maxBytes = ctx.music instanceof HttpMusicProvider ? ctx.music.maxAudioBytes() : 25 * 1024 * 1024;
      buffer = await fetchAudio(audioRef.url!, {
        allowedHosts: hosts,
        maxBytes,
        timeoutMs: ctx.config.MUSIC_TIMEOUT_MS,
      });
    }
  } catch (err) {
    await recordMusicCost(ctx, { job: processing, attemptId, eventType: 'failure' });
    await failJob(ctx, {
      job: processing,
      to: 'FAILED',
      errorCode: 'audio_fetch_failed',
      errorDetail: (err as Error).message,
    });
    return;
  }

  // Raw provider output lands in the quarantine zone first — a bucket the
  // delivery path cannot read from.
  const attempt = await latestAttempt(job.id);
  await ctx.storage.put({
    zone: 'quarantine',
    key: quarantineKey(job.id, attempt?.attempt_no ?? 1),
    body: buffer,
    contentType: audioRef.format === 'wav' ? 'audio/wav' : 'audio/mpeg',
  });

  const check = await ctx.audio.checkOutput(buffer, {
    expectedDurationSeconds: intent.durationSeconds,
    durationToleranceMs: ctx.config.AUDIO_DURATION_TOLERANCE_MS,
    minMeanVolumeDb: ctx.config.AUDIO_MIN_MEAN_VOLUME_DB,
    minBytes: ctx.config.AUDIO_MIN_BYTES,
  });

  if (!check.ok) {
    log('warn', 'output check failed', { jobId: job.id, failures: check.failures });
    // The upstream call still cost money even though we will not deliver it.
    await recordMusicCost(ctx, { job: processing, attemptId, eventType: 'failure' });
    await failJob(ctx, {
      job: processing,
      to: 'REJECTED',
      errorCode: 'output_check_failed',
      errorDetail: check.failures.join(','),
    });
    return;
  }

  // GEN-09: the credit was already given back (a verification timeout, or a
  // failure the user was refunded for) and the result has only now arrived.
  // The user must not be charged a second time.
  const refunded = await query<{ id: string }>(
    `SELECT id FROM ledger_entries
      WHERE job_id = ? AND entry_type IN ('release', 'compensate') LIMIT 1`,
    [job.id],
  );
  if (refunded.length > 0) {
    await recordMusicCost(ctx, { job: processing, attemptId, eventType: 'late_success' });
    await handleLateResult(ctx, { job: processing, trackId: processing.track_id });
    log('warn', 'late upstream success after compensation; user not re-charged', { jobId: job.id });
    return;
  }

  const delivered = await deliver(ctx, {
    job: processing,
    intent,
    audio: buffer,
    format: audioRef.format,
    durationMs: check.probe?.durationMs ?? intent.durationSeconds * 1000,
    providerRequestId: audioRef.providerRequestId,
  });

  if (delivered) {
    await recordMusicCost(ctx, { job: processing, attemptId, eventType: 'success' });
    log('info', 'delivered', { jobId: job.id, trackId: delivered.trackId });

    // Synced lyrics: line timings for songs with lyrics. With no real
    // vocal-sync model configured this is the estimator, labelled as such;
    // failure never affects delivery itself.
    if (intent.lyrics && intent.vocalMode === 'with_vocals') {
      const alignment = await ctx.alignment.align({
        lyrics: intent.lyrics,
        durationSeconds: intent.durationSeconds,
        providerRequestId: audioRef.providerRequestId,
      });
      if (alignment.status === 'ok') {
        await setTrackLyricTimings({ trackId: delivered.trackId, timings: alignment.timings }).catch((err) =>
          log('warn', 'lyric timing storage failed', { jobId: job.id, error: (err as Error).message }),
        );
      } else {
        log('warn', 'lyric alignment failed; lyrics will display unsynced', {
          jobId: job.id,
          reason: alignment.reason,
        });
      }
    }
  }
}
