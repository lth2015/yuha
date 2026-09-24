import { AppError } from '@yuha/contracts';
import {
  countLicenses,
  getPublicTrack,
  getTrackForUser,
  hasLicense,
  insertOrder,
  findOrderByIdempotencyKey,
  getActiveProduct,
  getActiveSubscription,
  attachCheckoutSession,
  getUser,
  trackEvent,
} from '@yuha/db';
import type { AppContext } from '../context.js';

/**
 * Market monetization: licensing another creator's published song.
 *
 * The price comes from the server catalogue (PAY-01 rules unchanged); the
 * creator's share is frozen into the license row at sale time so a later rate
 * change never rewrites what an earlier sale earned.
 */
export async function createLicenseCheckout(
  ctx: AppContext,
  params: { userId: string; trackId: string; idempotencyKey: string },
): Promise<{ orderId: string; checkoutUrl: string; simulated: boolean }> {
  const track = await getPublicTrack(params.trackId);
  if (!track) throw new AppError('NOT_FOUND', 'song not found on the market');
  if (track.owner_id === params.userId) {
    throw new AppError('CONFLICT', 'this is your own song — creators license their work to others');
  }
  if (await hasLicense(params.trackId, params.userId)) {
    throw new AppError('CONFLICT', 'you already hold a license for this song');
  }

  const product = await getActiveProduct('market_license');
  if (!product || !product.active) throw new AppError('NOT_FOUND', 'market licensing is not available');

  const user = await getUser(params.userId);
  if (!user) throw new AppError('UNAUTHENTICATED', 'user not found');
  if (!user.age_confirmed_at) throw new AppError('AGE_NOT_CONFIRMED', 'age confirmation is required before purchase');

  const existing = await findOrderByIdempotencyKey(params.userId, params.idempotencyKey);
  if (existing?.status === 'paid') throw new AppError('CONFLICT', 'this order has already been paid');

  const order =
    existing ??
    (await insertOrder({
      userId: params.userId,
      priceKey: product.price_key,
      priceVersion: product.version,
      kind: product.kind,
      amountMinor: product.amount_jpy,
      currency: product.currency,
      idempotencyKey: params.idempotencyKey,
      metadata: {
        units: product.units,
        kind: 'market_license',
        track_id: track.id,
        creator_id: track.owner_id,
      },
    }));

  const activeSub = await getActiveSubscription(params.userId);
  const session = await ctx.payments.createCheckout({
    orderId: order.id,
    userId: params.userId,
    userEmail: user.email,
    priceKey: product.price_key,
    priceVersion: product.version,
    amountMinor: product.amount_jpy,
    currency: product.currency,
    stripePriceId: product.stripe_price_id,
    kind: product.kind,
    successUrl: `${ctx.config.PUBLIC_WEB_URL}/song/${track.id}?licensed=1`,
    cancelUrl: `${ctx.config.PUBLIC_WEB_URL}/song/${track.id}`,
    idempotencyKey: `${params.userId}:${params.idempotencyKey}`,
    existingCustomerId: activeSub?.stripe_customer_id ?? null,
  });

  await attachCheckoutSession({ orderId: order.id, sessionId: session.sessionId, customerId: session.customerId });
  await trackEvent({
    name: 'market_license_checkout_started',
    userRef: params.userId,
    props: { track_id: track.id, creator_id: track.owner_id },
    runMode: ctx.config.mode,
    isInternal: ctx.config.isDemo,
  }).catch(() => undefined);

  return { orderId: order.id, checkoutUrl: session.url, simulated: session.simulated };
}

/** Buyer-facing: does the viewer hold a license for this song? */
export async function licenseStateFor(trackId: string, viewerId: string | null | undefined) {
  const count = await countLicenses(trackId);
  if (!viewerId) return { licenseCount: count, licensedByMe: null };
  return { licenseCount: count, licensedByMe: await hasLicense(trackId, viewerId) };
}


export { getTrackForUser };
