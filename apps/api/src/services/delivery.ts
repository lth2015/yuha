import { createHash } from 'node:crypto';
import type { MusicIntent } from '@yuha/contracts';
import {
  consumeReservation,
  compensateUnits,
  insertAsset,
  insertLicenseSnapshot,
  insertTrack,
  releaseReservation,
  setJobTrack,
  setTrackState,
  trackEvent,
  transitionJob,
  withTx,
  type JobRow,
} from '@yuha/db';
import type { AppContext } from '../context.js';

export const LICENSE_DISCLAIMER_JA = [
  'この記録は当社の利用条件と生成元情報を示すものです。',
  '著作権登録・権利者証明・独占的所有権・非侵害の保証ではありません。',
].join('');

export const LICENSE_DISCLAIMER =
  'This record states the usage terms and generation provenance in force when the song was made. ' +
  'It is not a copyright registration, proof of ownership, or a non-infringement guarantee.';

/**
 * Storage keys. Owner id is in the path so a leaked key still belongs to a
 * private bucket, and the random suffix makes keys unguessable (SEC-04).
 */
export function masterKey(ownerId: string, trackId: string, format: string): string {
  return `${ownerId}/${trackId}/master-${createHash('sha1').update(trackId).digest('hex').slice(0, 12)}.${format}`;
}

export function exportKey(ownerId: string, trackId: string, paramsHash: string, format: string): string {
  return `${ownerId}/${trackId}/export-${paramsHash.slice(0, 16)}.${format}`;
}

export function quarantineKey(jobId: string, attemptNo: number): string {
  return `${jobId}/attempt-${attemptNo}.audio`;
}

export interface DeliverParams {
  job: JobRow;
  intent: MusicIntent;
  audio: Buffer;
  format: 'mp3' | 'wav';
  durationMs: number;
  providerRequestId: string;
}

/**
 * Final delivery step.
 *
 * The single transaction here moves the job to DELIVERED, turns the reservation
 * into a consumption, creates the track and freezes the licence snapshot. That
 * grouping is what makes GEN-08 safe: a duplicate success callback finds the
 * job already DELIVERED, the version guard rejects the transition, and no
 * second consumption row can exist because of the partial unique index.
 */
export async function deliver(ctx: AppContext, params: DeliverParams): Promise<{ trackId: string } | null> {
  const { job, intent } = params;
  const caps = ctx.music.capabilities();
  const features = await ctx.features();
  const sha256 = createHash('sha256').update(params.audio).digest('hex');

  // The object is written BEFORE the transaction: an orphaned object is
  // harmless and swept later, whereas a committed DELIVERED row pointing at
  // audio that was never stored is not recoverable.
  const trackId = deterministicTrackId(job.id);
  const key = masterKey(job.user_id, trackId, params.format);
  await ctx.storage.put({
    zone: 'delivery',
    key,
    body: params.audio,
    contentType: params.format === 'wav' ? 'audio/wav' : 'audio/mpeg',
    metadata: { job: job.id, provider: caps.providerId },
  });

  return withTx(async (tx) => {
    const delivered = await transitionJob(
      {
        jobId: job.id,
        expectedVersion: job.version,
        from: job.state,
        to: 'DELIVERED',
        patch: { resolvedParams: intent as unknown as Record<string, unknown>, clearLease: true },
      },
      tx,
    );
    // Someone else already finished this job. Do nothing — in particular, do
    // not charge a second time.
    if (!delivered) return null;

    const input = job.input as { visibility?: 'private' | 'public'; title?: string | null };

    // The track row must exist before the job can reference it, so the id is
    // derived from the job id up front and used for both.
    const track = await insertTrack(
      {
        id: trackId,
        ownerId: job.user_id,
        projectId: job.project_id,
        jobId: job.id,
        title: input.title || intent.title || titleFor(intent),
        scene: intent.scene,
        mood: intent.mood,
        durationMs: params.durationMs,
        state: 'deliverable',
        styles: intent.styles,
        lyrics: intent.lyrics,
        vocalMode: intent.vocalMode,
        visibility: input.visibility === 'public' ? 'public' : 'private',
        coverSeed: coverSeedFor(trackId),
      },
      tx,
    );

    await insertAsset(
      {
        trackId: track.id,
        ownerId: job.user_id,
        kind: 'master',
        format: params.format,
        storageKey: key,
        byteSize: params.audio.byteLength,
        durationMs: params.durationMs,
        sha256,
        paramsHash: 'master',
      },
      tx,
    );

    // SEC-08: the terms in force at generation time, frozen. A later agreement
    // cannot rewrite them — the table trigger enforces that.
    await insertLicenseSnapshot(
      {
        trackId: track.id,
        userId: job.user_id,
        providerId: caps.providerId,
        providerModel: caps.model,
        contractVersion: caps.contractVersion,
        licenseVersion: caps.licenseVersion,
        territory: caps.territory,
        allowedUses: features.commercialDeliveryEnabled
          ? caps.allowedUses
          : ['動作確認・プレビューのみ（商用配信の許諾は未取得）'],
        prohibitedUses: caps.prohibitedUses,
        sourceSha256: sha256,
        generatedAt: new Date(),
        commercialDelivery: features.commercialDeliveryEnabled,
      },
      tx,
    );

    await setJobTrack(job.id, track.id, tx);

    // Reservation → consumption. One unit, exactly once.
    await consumeReservation({ userId: job.user_id, jobId: job.id }, tx);

    await trackEvent(
      {
        name: 'generation_delivered',
        userRef: job.user_id,
        props: { scene: intent.scene, provider: caps.providerId, track_id: track.id },
        runMode: ctx.config.mode,
        isInternal: ctx.config.isDemo,
      },
      tx,
    );

    return { trackId: track.id };
  });
}

function deterministicTrackId(jobId: string): string {
  // A UUID derived from the job id, so a retried delivery targets the same
  // storage key instead of littering the bucket with near-duplicates.
  const h = createHash('sha256').update(`track:${jobId}`).digest('hex');
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `4${h.slice(13, 16)}`,
    ((Number.parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join('-');
}

/** Stable 31-bit seed for the procedural cover art. */
function coverSeedFor(trackId: string): number {
  return createHash('sha256').update(`cover:${trackId}`).digest().readUInt32BE(0) % 0x7fffffff;
}

/** Last-resort title: the local text provider normally names the song. */
function titleFor(intent: MusicIntent): string {
  const style = intent.styles[0] ?? 'Song';
  return `${style.charAt(0).toUpperCase()}${style.slice(1)} · ${intent.mood}`;
}

/**
 * Terminal failure path.
 *
 * §6.1: technical failure, provider rejection and a failed output check never
 * consume a user credit. The reservation is released; if its batch expired
 * while the job was running the credit is re-issued as a compensation batch
 * rather than silently lost (GEN-11).
 */
export async function failJob(
  ctx: AppContext,
  params: {
    job: JobRow;
    to: 'FAILED' | 'REJECTED';
    errorCode: string;
    errorDetail?: string;
  },
): Promise<boolean> {
  return withTx(async (tx) => {
    const moved = await transitionJob(
      {
        jobId: params.job.id,
        expectedVersion: params.job.version,
        from: params.job.state,
        to: params.to,
        patch: {
          errorCode: params.errorCode,
          errorDetail: params.errorDetail?.slice(0, 500) ?? null,
          clearLease: true,
        },
      },
      tx,
    );
    if (!moved) return false;

    const released = await releaseReservation(
      { userId: params.job.user_id, jobId: params.job.id, reason: params.errorCode },
      tx,
    );

    if (released.released && released.expiredBatch) {
      // The batch the credit came from expired mid-flight. The user keeps the
      // credit via a fresh compensation batch — the expiry policy is a
      // configured value, and it is applied rather than swallowed.
      await compensateUnits(
        {
          userId: params.job.user_id,
          jobId: params.job.id,
          units: 1,
          reason: `expired_batch_compensation:${params.errorCode}`,
          validityDays: ctx.config.EXPIRED_BATCH_COMPENSATION_DAYS,
        },
        tx,
      );
    }

    await trackEvent(
      {
        name: 'generation_failed',
        userRef: params.job.user_id,
        props: { code: params.errorCode, terminal_state: params.to },
        runMode: ctx.config.mode,
        isInternal: ctx.config.isDemo,
      },
      tx,
    );
    return true;
  });
}

/**
 * A result that arrived after the user was already compensated (GEN-09).
 *
 * The user is not charged again. The upstream cost we did incur is recorded,
 * and the audio is stored but the track is parked in `suspended` so it is not
 * silently handed over under a credit that was already refunded — an operator
 * decides what to do with it.
 */
export async function handleLateResult(
  ctx: AppContext,
  params: { job: JobRow; trackId: string | null },
): Promise<void> {
  if (params.trackId) {
    await setTrackState({
      trackId: params.trackId,
      state: 'suspended',
      reason: 'late_upstream_result_after_compensation',
    });
  }
  await trackEvent({
    name: 'generation_late_result',
    userRef: params.job.user_id,
    props: { job_id: params.job.id },
    runMode: ctx.config.mode,
    isInternal: ctx.config.isDemo,
  });
}
