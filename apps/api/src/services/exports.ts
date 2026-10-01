import { createHash } from 'node:crypto';
import { AppError, type CreateExportRequest, type ExportView } from '@yuha/contracts';
import {
  findAsset,
  getAssetForUser,
  getLicensedTrack,
  getLicenseSnapshot,
  getMasterAsset,
  getTrackForUser,
  hasLicense,
  insertAsset,
  trackEvent,
  type TrackRow,
} from '@yuha/db';
import type { AppContext } from '../context.js';
import { exportKey } from './delivery.js';

/** Canonical hash of the export parameters, so an identical request reuses the object. */
function paramsHash(req: CreateExportRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        s: Math.round(req.clipStartSeconds * 1000),
        d: req.clipDurationSeconds,
        f: req.fadeOut,
        fmt: req.format,
      }),
    )
    .digest('hex');
}

const FADE_OUT_MS = 1000;

/**
 * Creates (or reuses) an export.
 *
 * Trimming never costs a generation credit — nothing in this function touches
 * the ledger. Clip windows are any 5s..full-length range the master covers,
 * with an optional 1s fade-out; the master itself is never overwritten.
 */
export async function createExport(
  ctx: AppContext,
  params: { userId: string; trackId: string; request: CreateExportRequest },
): Promise<ExportView> {
  const req = params.request;
  const features = await ctx.features();

  // The owner always qualifies; anyone else needs an active market license
  // for this specific song — knowing the id alone grants nothing (SEC-01).
  let track: TrackRow | undefined = await getTrackForUser(params.trackId, params.userId);
  let viaLicense = false;
  if (!track && (await hasLicense(params.trackId, params.userId))) {
    /*
     * `getLicensedTrack`, not `getPublicTrack`. The public read requires
     * `visibility = 'public'` and `state = 'deliverable'`, so the seller
     * unpublishing or deleting the song silently destroyed every buyer's paid
     * licence — one call, no notice, no refund. Visibility is the seller's
     * decision about their shop front and none of the buyer's business; the
     * retention sweep and account erasure already keep a licensed song's audio
     * on purpose, so this is what reaches it. `suspended` still blocks, below.
     */
    const licensed = await getLicensedTrack(params.trackId);
    if (licensed) {
      track = licensed;
      viaLicense = true;
    }
  }
  if (!track) throw new AppError('NOT_FOUND', 'track not found');
  if (track.state === 'suspended') {
    // SEC-10: while a rights case is open, no new download link is issued.
    throw new AppError('TRACK_SUSPENDED', 'this track is paused pending a rights review');
  }
  // A licence holder may still reach a song its creator has since deleted —
  // that is the whole reason the audio is held back from the retention sweep.
  if (track.state !== 'deliverable' && !(viaLicense && track.state === 'deleted')) {
    throw new AppError('TRACK_NOT_DELIVERABLE', `track is ${track.state}`);
  }

  const master = await getMasterAsset(track.id);
  if (!master) throw new AppError('TRACK_NOT_DELIVERABLE', 'master audio is missing');

  if (viaLicense) {
    const licence = await getLicenseSnapshot(track.id);
    if (licence && licence.status !== 'active') {
      throw new AppError('TRACK_SUSPENDED', `licence record is ${licence.status}`);
    }
  }

  // Range check against the real master duration, not a nominal length.
  const clipStartMs = Math.round(req.clipStartSeconds * 1000);
  const clipDurationMs = req.clipDurationSeconds * 1000;
  if (clipStartMs < 0 || clipStartMs + clipDurationMs > master.duration_ms + ctx.config.AUDIO_DURATION_TOLERANCE_MS) {
    throw new AppError('VALIDATION_FAILED', 'the requested clip range falls outside the track');
  }

  if (req.format === 'wav') {
    // UI-07: transcoding an MP3 master to WAV is not a quality upgrade, so the
    // option only exists when the master itself is lossless AND the plan allows.
    if (!features.wavExportEnabled) {
      throw new AppError('UNSUPPORTED_CAPABILITY', 'WAV export is not enabled');
    }
    if (master.format !== 'wav') {
      throw new AppError(
        'UNSUPPORTED_CAPABILITY',
        'WAV export requires a lossless master; converting MP3 to WAV does not improve quality',
      );
    }
  }

  const licence = await getLicenseSnapshot(track.id);
  if (licence && licence.status !== 'active') {
    throw new AppError('TRACK_SUSPENDED', `licence record is ${licence.status}`);
  }

  const hash = paramsHash(req);
  const existing = await findAsset({
    trackId: track.id,
    ownerId: params.userId,
    kind: 'export',
    paramsHash: hash,
  });
  if (existing) {
    const signed = await ctx.storage.signedUrl({
      zone: 'delivery',
      key: existing.storage_key,
      ttlSeconds: ctx.config.DOWNLOAD_URL_TTL_SECONDS,
      filename: downloadFilename(track.title, existing.format),
    });
    return {
      exportId: existing.id,
      trackId: track.id,
      format: existing.format,
      clipStartSeconds: (existing.clip_start_ms ?? 0) / 1000,
      clipDurationSeconds: (existing.clip_duration_ms ?? 0) / 1000,
      fadeOut: existing.fade_out_ms > 0,
      byteSize: existing.byte_size,
      sha256: existing.sha256,
      downloadUrl: signed.url,
      downloadUrlExpiresAt: signed.expiresAt.toISOString(),
      reused: true,
    };
  }

  const source = await ctx.storage.get('delivery', master.storage_key);
  const rendered = await ctx.audio.renderExport({
    source,
    clipStartMs,
    clipDurationMs,
    fadeOutMs: req.fadeOut ? FADE_OUT_MS : 0,
    format: req.format,
  });

  const key = exportKey(params.userId, track.id, hash, req.format);
  const stored = await ctx.storage.put({
    zone: 'delivery',
    key,
    body: rendered,
    contentType: req.format === 'wav' ? 'audio/wav' : 'audio/mpeg',
  });

  const asset = await insertAsset({
    trackId: track.id,
    ownerId: params.userId,
    kind: 'export',
    format: req.format,
    storageKey: key,
    byteSize: stored.byteSize,
    durationMs: clipDurationMs,
    sha256: stored.sha256,
    clipStartMs,
    clipDurationMs,
    fadeOutMs: req.fadeOut ? FADE_OUT_MS : 0,
    paramsHash: hash,
  });

  await trackEvent({
    name: 'export_created',
    userRef: params.userId,
    props: { track_id: track.id, duration: req.clipDurationSeconds, format: req.format },
    runMode: ctx.config.mode,
    isInternal: ctx.config.isDemo,
  });

  const signed = await ctx.storage.signedUrl({
    zone: 'delivery',
    key,
    ttlSeconds: ctx.config.DOWNLOAD_URL_TTL_SECONDS,
    filename: downloadFilename(track.title, req.format),
  });

  return {
    exportId: asset.id,
    trackId: track.id,
    format: req.format,
    clipStartSeconds: req.clipStartSeconds,
    clipDurationSeconds: req.clipDurationSeconds,
    fadeOut: req.fadeOut,
    byteSize: stored.byteSize,
    sha256: stored.sha256,
    downloadUrl: signed.url,
    downloadUrlExpiresAt: signed.expiresAt.toISOString(),
    reused: false,
  };
}

/**
 * Re-issues a download link for an existing asset. Ownership is re-checked on
 * every call — a previously valid URL expiring is the point, and knowing an
 * asset id is not authorisation (SEC-01/SEC-04).
 */
export async function issueDownloadUrl(
  ctx: AppContext,
  params: { userId: string; assetId: string },
): Promise<{ url: string; expiresAt: string }> {
  const asset = await getAssetForUser(params.assetId, params.userId);
  if (!asset) throw new AppError('NOT_FOUND', 'asset not found');

  /*
   * The owner's read first, then the licence holder's.
   *
   * This was `getTrackForUser` alone, which matches on `owner_id` — so for a
   * buyer it always returned undefined and every re-issue answered "this
   * track is paused pending a rights review". `DOWNLOAD_URL_TTL_SECONDS` is
   * minutes, so a buyer's paid download worked exactly once and then reported
   * a rights review that did not exist.
   */
  let track = await getTrackForUser(asset.track_id, params.userId);
  if (!track && (await hasLicense(asset.track_id, params.userId))) {
    track = await getLicensedTrack(asset.track_id);
  }
  if (!track) throw new AppError('NOT_FOUND', 'track not found');
  if (track.state === 'suspended') {
    throw new AppError('TRACK_SUSPENDED', 'this track is paused pending a rights review');
  }

  const signed = await ctx.storage.signedUrl({
    zone: 'delivery',
    key: asset.storage_key,
    ttlSeconds: ctx.config.DOWNLOAD_URL_TTL_SECONDS,
    filename: downloadFilename(track.title, asset.format),
  });
  return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
}

function downloadFilename(title: string, format: string): string {
  const safe = title.replace(/[^\p{L}\p{N}\-_ ]/gu, '').trim() || 'loopscene';
  return `${safe}.${format}`;
}
