import { createHmac } from 'node:crypto';
import { removeSceneMvsOfTrack } from './scene-mv-cleanup.js';
import { AppError, CONSENT_VERSION } from '@yuha/contracts';
import { deleteLyricProposals,
  anonymiseUser,
  execute,
  findByExternalId,
  forgetAsset,
  forgetShareCard,
  lockGuestTrial,
  getMasterAsset,
  getShareCard,
  grantUnits,
  insertGuest,
  insertLicenseSnapshot,
  listOpenJobs,
  listExpiredGuestTrials,
  markGuestClaimed,
  clearClaimedTrialRefs,
  markGuestPurged,
  moveGuestOwnership,
  query,
  queryOne,
  revokeUnusedUnits,
  trialCounts,
  withTx,
  type Tx,
} from '@yuha/db';
import { licenseSnapshotFor } from './delivery.js';
import type { AppContext } from '../context.js';
import { GUEST_PROVIDER, guestSessionIssuer } from '../auth/guest.js';

async function hasSpentTrialCredit(guestId: string, tx: Tx): Promise<boolean> {
  const spent = await queryOne<{ n: number }>(
    `SELECT COALESCE(SUM(consumed_units), 0) AS n FROM entitlement_batches WHERE user_id = ? AND source = 'promo_trial'`,
    [guestId],
    tx,
  );
  return Number(spent?.n ?? 0) > 0;
}

/**
 * Opening a trial without an account (docs/GROWTH_SPEC.md, part three).
 *
 * Who may: the switch is on; this browser has not had one; this network has
 * had fewer than GUEST_TRIAL_PER_NETWORK today; the site has opened fewer than
 * GUEST_TRIAL_DAILY_LIMIT today. "Today" is the day in Japan, where the site's
 * people are. What is kept about the visitor is two keyed hashes, never the
 * address or the browser's own id (docs/legal/PRIVACY_CHANGES_2026-11.md).
 */
const JST_OFFSET_MS = 9 * 3600_000;

/** Midnight in Japan at the start of `now`'s Japanese day, as a UTC instant. */
export function japanDayStart(now: Date): Date {
  const shifted = now.getTime() + JST_OFFSET_MS;
  return new Date(shifted - (shifted % 86_400_000) - JST_OFFSET_MS);
}

/**
 * The key the two hashes are made with, or null when the server has none.
 *
 * There used to be a third fallback, a string written in this file. A key
 * anyone can read is no key: every IPv4 address hashed under it can be
 * recovered by trying them all. So without a server secret there is no trial,
 * rather than a hash that only looks like one. Production always has the
 * session secret (Google sign-in cannot work without it).
 */
function hashKey(ctx: AppContext): string | null {
  return ctx.config.STORAGE_SIGNING_SECRET ?? ctx.config.GOOGLE_SESSION_SECRET ?? ctx.config.DEV_AUTH_SECRET ?? null;
}

function keyed(secret: string, kind: 'device' | 'ip', value: string): string {
  return createHmac('sha256', `${secret}:guest-${kind}`).update(value).digest('hex');
}

export async function openGuestTrial(
  ctx: AppContext,
  params: { deviceId: string; ip: string; now?: Date; source?: string | null },
): Promise<{ token: string; expiresAt: Date; userId: string }> {
  if (!(await ctx.features()).guestTrialEnabled) {
    throw new AppError('SERVICE_DISABLED', 'trying without an account is not available');
  }
  const issuer = guestSessionIssuer(ctx.config);
  if (!issuer) throw new AppError('SERVICE_DISABLED', 'no session secret is configured');

  const secret = hashKey(ctx);
  if (!secret) throw new AppError('SERVICE_DISABLED', 'no secret to key the trial limits with');
  const deviceRef = keyed(secret, 'device', params.deviceId);
  const ipRef = keyed(secret, 'ip', params.ip);
  const dayStart = japanDayStart(params.now ?? new Date());

  const guest = await withTx(async (tx) => {
    const counts = await trialCounts({ deviceRef, ipRef, dayStart }, tx);
    const refuse = (reason: 'device' | 'network' | 'day') => {
      throw new AppError('TRIAL_LIMIT_REACHED', `no trial: ${reason}`, { reason });
    };
    if (counts.device > 0) refuse('device');
    if (counts.day >= ctx.config.GUEST_TRIAL_DAILY_LIMIT) refuse('day');
    if (counts.network >= ctx.config.GUEST_TRIAL_PER_NETWORK) refuse('network');

    const user = await insertGuest({ deviceRef, ipRef, consentVersion: CONSENT_VERSION, source: params.source ?? null }, tx);
    await grantUnits(
      {
        userId: user.id,
        source: 'promo_trial',
        sourceRef: `guest:${user.id}`,
        units: 1,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
        reason: 'guest_trial_grant',
      },
      tx,
    );
    return user;
  });

  const { token, expiresAt } = issuer.issue({ provider: GUEST_PROVIDER, externalId: guest.external_id, email: guest.email });
  return { token, expiresAt, userId: guest.id };
}

/**
 * A guest signs up and keeps the song (docs/GROWTH_SPEC.md, part three).
 *
 * Inside one transaction: the songs, jobs, projects, audio rows and share
 * cards take the account as their owner; each delivered song gets the
 * authorship record delivery held back, naming the account; the trial is
 * marked claimed and the guest session ends. Then, if the guest spent its one
 * song, one unused unit of the account's own welcome grant is taken back, so
 * a person gets FREE_TRIAL_UNITS songs free in all, however they arrived.
 */
export async function claimGuestTrial(
  ctx: AppContext,
  params: { guestToken: string; userId: string },
): Promise<{ claimed: number; alreadyClaimed?: true }> {
  const issuer = guestSessionIssuer(ctx.config);
  const claims = issuer?.verify(params.guestToken, GUEST_PROVIDER);
  if (!claims) throw new AppError('NOT_FOUND', 'no such trial');
  const guest = await findByExternalId(GUEST_PROVIDER, claims.sub);
  if (!guest || guest.role !== 'guest') throw new AppError('NOT_FOUND', 'no such trial');
  const features = await ctx.features();

  return withTx(async (tx) => {
    // A retry can arrive before the original request has finished. Read the
    // outcome under the same lock that protects the transfer and welcome grant.
    const trial = await lockGuestTrial(guest.id, tx);
    if (!trial || trial.purged_at) throw new AppError('NOT_FOUND', 'this trial has ended');
    if (trial.claimed_by) {
      if (trial.claimed_by !== params.userId) throw new AppError('CONFLICT', 'this trial already belongs to another account');
      // Older servers could close an empty trial without transferring a song.
      if (!await hasSpentTrialCredit(guest.id, tx)) throw new AppError('NOT_FOUND', 'this trial has no song to claim');
      return { claimed: 0, alreadyClaimed: true };
    }
    const tracks = await moveGuestOwnership({ guestId: guest.id, userId: params.userId }, tx);
    if (!tracks.length) {
      if ((await listOpenJobs(guest.id, 1, tx)).length) throw new AppError('TRACK_NOT_DELIVERABLE', 'this trial song is still being made');
      throw new AppError('NOT_FOUND', 'this trial has no song to claim');
    }
    for (const t of tracks) {
      const master = await getMasterAsset(t.id, tx);
      if (!master) continue;
      await insertLicenseSnapshot(
        licenseSnapshotFor(ctx, features, { trackId: t.id, userId: params.userId, sha256: master.sha256, generatedAt: t.created_at }),
        tx,
      );
    }
    await markGuestClaimed({ guestId: guest.id, userId: params.userId }, tx);
    // The campaign that brought the trial brought the account too, if the
    // account is new and came with none of its own (docs/ATTRIBUTION_SPEC.md).
    const came = await queryOne<{ s: string | null }>(`SELECT acquisition_source AS s FROM users WHERE id = ?`, [guest.id], tx);
    if (came?.s) {
      await execute(
        `UPDATE users SET acquisition_source = ?
          WHERE id = ? AND acquisition_source IS NULL AND created_at >= UTC_TIMESTAMP(3) - INTERVAL 1 DAY`,
        [came.s, params.userId],
        tx,
      );
    }

    if (await hasSpentTrialCredit(guest.id, tx)) {
      const welcome = await queryOne<{ id: string }>(
        `SELECT id FROM entitlement_batches WHERE user_id = ? AND source = 'promo_trial' AND source_ref = ?`,
        [params.userId, `trial:${params.userId}`],
        tx,
      );
      if (welcome) {
        await revokeUnusedUnits({ userId: params.userId, batchId: welcome.id, reason: 'guest_trial_claimed', maxUnits: 1 }, tx);
      }
    }
    return { claimed: tracks.length };
  });
}

/**
 * Trials nobody claimed within seven days, deleted with their audio
 * (docs/legal/PRIVACY_CHANGES_2026-11.md). Not the account-deletion path:
 * that keeps a deleted song's audio for 90 days, and the promise here is 7.
 * An object's row goes only once the object has, as in that path; a song under
 * an open rights complaint is kept until the review closes.
 */
export async function purgeExpiredGuestTrials(
  ctx: AppContext,
  opts: { now?: Date; log?: { error: (obj: unknown, msg: string) => void } } = {},
): Promise<number> {
  const cutoff = new Date((opts.now ?? new Date()).getTime() - 7 * 86_400_000);
  let purged = 0;
  for (const trial of await listExpiredGuestTrials(cutoff)) {
    const guestId = trial.user_id;
    let allGone = true;
    const tracks = await query<{ id: string; open_cases: number }>(
      `SELECT t.id, (SELECT COUNT(*) FROM rights_cases rc WHERE rc.track_id = t.id
                      AND rc.status IN ('received','under_review','suspended')) AS open_cases
         FROM tracks t WHERE t.owner_id = ?`,
      [guestId],
    );
    for (const track of tracks) {
      if (Number(track.open_cases) > 0) {
        allGone = false;
        continue;
      }
      for (const asset of await query<{ id: string; storage_key: string }>(`SELECT id, storage_key FROM asset_versions WHERE track_id = ?`, [track.id])) {
        try {
          await ctx.storage.remove('delivery', asset.storage_key);
          await forgetAsset(asset.id);
        } catch (err) {
          allGone = false;
          opts.log?.error({ err, key: asset.storage_key }, 'could not remove a trial song');
        }
      }
      const card = await getShareCard(track.id);
      if (card) {
        try {
          await ctx.storage.remove('delivery', card.storage_key);
          await forgetShareCard(track.id);
        } catch (err) {
          allGone = false;
          opts.log?.error({ err, key: card.storage_key }, 'could not remove a trial share card');
        }
      }
      await execute(
        `UPDATE tracks SET deleted_at = UTC_TIMESTAMP(3), state = 'deleted', title = '', lyrics = NULL,
                           lyric_timings = NULL, dedication = NULL, updated_at = UTC_TIMESTAMP(3) WHERE id = ?`,
        [track.id],
      );
      // Its "align it again" proposals hold lines of the lyrics: they go with them.
      await deleteLyricProposals(track.id);
      if (!(await removeSceneMvsOfTrack(ctx.storage, track.id, opts.log, ctx.video))) allGone = false;
    }
    for (const a of await query<{ job_id: string; attempt_no: number }>(
      `SELECT a.job_id, a.attempt_no FROM generation_attempts a JOIN generation_jobs j ON j.id = a.job_id WHERE j.user_id = ?`,
      [guestId],
    )) {
      try {
        await ctx.storage.remove('quarantine', `${a.job_id}/attempt-${a.attempt_no}.audio`);
      } catch (err) {
        opts.log?.error({ err, jobId: a.job_id }, 'could not remove a trial attempt');
      }
    }
    // What the visitor wrote goes with the song.
    await execute(`UPDATE generation_jobs SET input = JSON_OBJECT('erased', true), updated_at = UTC_TIMESTAMP(3) WHERE user_id = ?`, [guestId]);
    // Tried again next sweep while anything is left; the guest row and the hashes go when it is all gone.
    if (!allGone) continue;
    await withTx(async (tx) => {
      await anonymiseUser({ userId: guestId, tombstone: guestId }, tx);
      await markGuestPurged(guestId, tx);
    });
    purged += 1;
  }
  // A claimed trial's song is the account's now, but the two hashes were only
  // ever for counting trials, and the promise is seven days whatever happened next.
  await clearClaimedTrialRefs(cutoff);
  return purged;
}
