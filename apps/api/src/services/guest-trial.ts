import { createHmac } from 'node:crypto';
import { AppError } from '@yuha/contracts';
import { grantUnits, insertGuest, trialCounts, withTx } from '@yuha/db';
import type { AppContext } from '../context.js';
import { GUEST_PROVIDER, guestSessionIssuer } from '../auth/guest.js';

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

function keyed(ctx: AppContext, kind: 'device' | 'ip', value: string): string {
  const secret = ctx.config.STORAGE_SIGNING_SECRET ?? ctx.config.DEV_AUTH_SECRET ?? 'yuha-guest-trial';
  return createHmac('sha256', `${secret}:guest-${kind}`).update(value).digest('hex');
}

export async function openGuestTrial(
  ctx: AppContext,
  params: { deviceId: string; ip: string; now?: Date },
): Promise<{ token: string; expiresAt: Date; userId: string }> {
  if (!(await ctx.features()).guestTrialEnabled) {
    throw new AppError('SERVICE_DISABLED', 'trying without an account is not available');
  }
  const issuer = guestSessionIssuer(ctx.config);
  if (!issuer) throw new AppError('SERVICE_DISABLED', 'no session secret is configured');

  const deviceRef = keyed(ctx, 'device', params.deviceId);
  const ipRef = keyed(ctx, 'ip', params.ip);
  const dayStart = japanDayStart(params.now ?? new Date());

  const guest = await withTx(async (tx) => {
    const counts = await trialCounts({ deviceRef, ipRef, dayStart }, tx);
    const refuse = (reason: 'device' | 'network' | 'day') => {
      throw new AppError('TRIAL_LIMIT_REACHED', `no trial: ${reason}`, { reason });
    };
    if (counts.device > 0) refuse('device');
    if (counts.day >= ctx.config.GUEST_TRIAL_DAILY_LIMIT) refuse('day');
    if (counts.network >= ctx.config.GUEST_TRIAL_PER_NETWORK) refuse('network');

    const user = await insertGuest({ deviceRef, ipRef }, tx);
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
