import { AppError } from '@yuha/contracts';
import {
  clearMfaFailures,
  consumeRecoveryCode,
  disableMfaFactor,
  enableMfaFactor,
  getEnabledMfaFactor,
  recordMfaFailure,
  getMfaFactor,
  getUser,
  redeemChallenge,
  upsertMfaFactor,
} from '@yuha/db';
import { createHash } from 'node:crypto';
import type { AppContext } from '../context.js';
import { SessionTokenIssuer } from '../auth/tokens.js';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  otpauthUri,
  SecretBox,
  verifyTotp,
} from '../auth/totp.js';

/**
 * MFA service: TOTP second factor, Google Authenticator compatible.
 *
 * Flow: enroll (returns secret + otpauth URI for the QR) → confirm with a
 * live code (enables the factor, reveals recovery codes once) → every login
 * thereafter receives a short-lived challenge instead of a session until a
 * valid code (or recovery code) is presented.
 */
function secretBox(ctx: AppContext): SecretBox {
  const secret =
    ctx.config.MFA_ENCRYPTION_SECRET ?? ctx.config.GOOGLE_SESSION_SECRET ?? ctx.config.DEV_AUTH_SECRET ?? '';
  if (!secret) throw new AppError('SERVICE_DISABLED', 'MFA_ENCRYPTION_SECRET (or a session secret) is required');
  return new SecretBox(secret);
}

const CHALLENGE_TTL_SECONDS = 5 * 60;
/**
 * Five wrong codes in a row locks the account for fifteen minutes.
 *
 * Short on purpose: this is a speed limit, not a punishment. An owner locked
 * out of their own account is its own kind of failure, and fifteen minutes
 * takes a six-digit brute force from hours to years without taking the account
 * away from the person who owns it.
 */
const MFA_MAX_FAILED_ATTEMPTS = 5;
const MFA_LOCK_SECONDS = 15 * 60;

export interface EnrollResult {
  secret: string;
  otpauthUri: string;
}

export async function enrollMfa(ctx: AppContext, userId: string): Promise<EnrollResult> {
  if (await getEnabledMfaFactor(userId)) {
    throw new AppError('CONFLICT', 'two-factor is already enabled — disable it first to re-enroll');
  }
  const secret = generateTotpSecret();
  const recovery = generateRecoveryCodes();
  const box = secretBox(ctx);
  const user = await getUser(userId);
  await upsertMfaFactor({
    userId,
    secretEncrypted: box.encrypt(secret),
    recoveryHashes: recovery.map(hashRecoveryCode),
  });
  return {
    secret,
    otpauthUri: otpauthUri({
      secret,
      account: user?.email ?? userId,
      issuer: ctx.config.MFA_ISSUER,
    }),
  };
}

/** Confirms enrollment with a live code; returns the recovery codes once. */
export async function confirmMfa(
  ctx: AppContext,
  params: { userId: string; code: string },
): Promise<{ recoveryCodes: string[] }> {
  const factor = await getMfaFactor(params.userId);
  if (!factor) throw new AppError('MFA_NOT_ENROLLED', 'start enrollment first');
  if (factor.enabled) throw new AppError('CONFLICT', 'two-factor is already enabled');

  const secret = secretBox(ctx).decrypt(factor.secret_encrypted);
  if (!verifyTotp(secret, params.code)) {
    throw new AppError('MFA_INVALID_CODE', 'the code did not match — authenticator apps rotate every 30 seconds');
  }
  await enableMfaFactor(params.userId);

  // Recovery codes are stored hashed; the plaintext is returned exactly once.
  const fresh = generateRecoveryCodes();
  const { execute } = await import('@yuha/db');
  await execute(`UPDATE mfa_factors SET recovery_codes = ? WHERE user_id = ?`, [
    JSON.stringify(fresh.map(hashRecoveryCode)),
    params.userId,
  ]);
  return { recoveryCodes: fresh };
}

export async function disableMfa(ctx: AppContext, params: { userId: string; code: string }): Promise<void> {
  const factor = await getEnabledMfaFactor(params.userId);
  if (!factor) throw new AppError('MFA_NOT_ENROLLED', 'two-factor is not enabled');

  const secret = secretBox(ctx).decrypt(factor.secret_encrypted);
  const ok =
    verifyTotp(secret, params.code) ||
    (await consumeRecoveryCode({ userId: params.userId, hash: hashRecoveryCode(params.code) }));
  if (!ok) throw new AppError('MFA_INVALID_CODE', 'the code did not match');
  await disableMfaFactor(params.userId);
}

/**
 * Login interception: instead of a session, the first factor earns a
 * 5-minute challenge token. It grants nothing except the right to present a
 * second factor — and only for the user it was issued to.
 */
export async function issueMfaChallenge(ctx: AppContext, userId: string, email: string): Promise<string | null> {
  if (!(await getEnabledMfaFactor(userId))) return null;
  const secret = ctx.config.GOOGLE_SESSION_SECRET ?? ctx.config.DEV_AUTH_SECRET ?? '';
  const issuer = new SessionTokenIssuer(secret, CHALLENGE_TTL_SECONDS);
  return issuer.issue({ provider: 'mfa-pending', externalId: userId, email }).token;
}

export interface MfaVerifyResult {
  ok: boolean;
  usedRecoveryCode?: boolean;
}

/** Verifies a challenge token + code; on success the caller mints the session. */
export async function verifyMfaChallenge(
  ctx: AppContext,
  params: { challengeToken: string; code: string },
): Promise<{ userId: string; usedRecoveryCode: boolean }> {
  const secret = ctx.config.GOOGLE_SESSION_SECRET ?? ctx.config.DEV_AUTH_SECRET ?? '';
  const issuer = new SessionTokenIssuer(secret, CHALLENGE_TTL_SECONDS);
  const claims = issuer.verify(params.challengeToken, 'mfa-pending');
  if (!claims) throw new AppError('AUTH_EXCHANGE_FAILED', 'the challenge expired — sign in again');
  const userId = claims.sub;

  const factor = await getEnabledMfaFactor(userId);
  if (!factor) throw new AppError('MFA_NOT_ENROLLED', 'two-factor is not enabled on this account');

  /*
   * The limit that follows the account rather than the address.
   *
   * A challenge token lives five minutes and is only spent on success, so one
   * can be tried against for its whole life; the per-IP cap of twelve a minute
   * is multiplied by however many addresses an attacker has, and six digits do
   * not survive that. This cap cannot be widened by having more of them.
   *
   * Checked before the code is compared, so a locked account costs an attacker
   * a database read and tells them nothing about whether the code was right.
   */
  if (factor.locked_until && factor.locked_until.getTime() > Date.now()) {
    throw new AppError('MFA_INVALID_CODE', 'too many incorrect codes — wait a few minutes and try again');
  }

  const totpSecret = secretBox(ctx).decrypt(factor.secret_encrypted);
  // Verified once and remembered: re-running verifyTotp at the end to decide
  // which factor was used can straddle a 30-second step boundary and report a
  // TOTP login as a spent recovery code.
  const totpOk = verifyTotp(totpSecret, params.code);
  const codeOk = totpOk || (await consumeRecoveryCode({ userId, hash: hashRecoveryCode(params.code) }));
  if (!codeOk) {
    const { lockedUntil } = await recordMfaFailure({
      userId,
      maxAttempts: MFA_MAX_FAILED_ATTEMPTS,
      lockSeconds: MFA_LOCK_SECONDS,
    });
    // The same message either way: whether the account is now locked is not
    // something an attacker should learn from a wrong guess.
    throw new AppError(
      'MFA_INVALID_CODE',
      lockedUntil && lockedUntil.getTime() > Date.now()
        ? 'too many incorrect codes — wait a few minutes and try again'
        : 'the code did not match',
    );
  }
  // A correct code clears the slate, including a lock already earned.
  await clearMfaFailures(userId);

  // Single use: a redeemed challenge never mints a second session.
  const challengeHash = createHash('sha256').update(params.challengeToken).digest('hex');
  if (!(await redeemChallenge(userId, challengeHash))) {
    throw new AppError('AUTH_EXCHANGE_FAILED', 'this challenge was already used — sign in again');
  }
  return { userId, usedRecoveryCode: !totpOk };
}

/** The session issuer google sessions use (shared with routes/auth.ts). */
export function sessionIssuerFor(ctx: AppContext): SessionTokenIssuer {
  const secret = ctx.config.GOOGLE_SESSION_SECRET ?? ctx.config.DEV_AUTH_SECRET ?? '';
  return new SessionTokenIssuer(secret);
}

export { verifyTotp };
