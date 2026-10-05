import type { PoolConnection } from 'mysql2/promise';
import { execute, newId, queryOne } from './pool.js';

/**
 * Wallet identity storage for stablecoin payments.
 *
 * Holds no key material and no signatures — only what was asked of a wallet,
 * and whether it answered. Addresses are stored lowercased; the columns use a
 * binary collation, so a mixed-case value is refused by the database rather
 * than silently compared case-insensitively.
 */
export interface WalletChallengeRow {
  id: string;
  user_id: string;
  nonce: string;
  domain: string;
  uri: string;
  chain_id: number;
  claimed_address: string | null;
  issued_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}

export async function createWalletChallenge(
  params: {
    userId: string;
    nonce: string;
    domain: string;
    uri: string;
    chainId: number;
    claimedAddress: string | null;
    expiresAt: Date;
  },
  tx?: PoolConnection,
): Promise<WalletChallengeRow> {
  const id = newId();
  await execute(
    `INSERT INTO wallet_challenges (id, user_id, nonce, domain, uri, chain_id, claimed_address, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.userId,
      params.nonce,
      params.domain,
      params.uri,
      params.chainId,
      params.claimedAddress?.toLowerCase() ?? null,
      params.expiresAt,
    ],
    tx,
  );
  const row = await getWalletChallenge(params.nonce, tx);
  if (!row) throw new Error('wallet challenge insert failed to read back');
  return row;
}

export async function getWalletChallenge(nonce: string, tx?: PoolConnection): Promise<WalletChallengeRow | undefined> {
  return queryOne<WalletChallengeRow>(
    `SELECT id, user_id, nonce, domain, uri, chain_id, claimed_address, issued_at, expires_at, consumed_at
       FROM wallet_challenges WHERE nonce = ?`,
    [nonce],
    tx,
  );
}

/**
 * Spends a challenge exactly once.
 *
 * The UPDATE only matches while `consumed_at` is still null and the challenge
 * has not expired, so two verifications racing on one nonce cannot both win
 * and an expired nonce cannot be spent at all. Returns false when it was
 * already used, which the caller must treat the same as a wrong signature.
 */
export async function consumeWalletChallenge(nonce: string, tx?: PoolConnection): Promise<boolean> {
  const res = await execute(
    `UPDATE wallet_challenges
        SET consumed_at = UTC_TIMESTAMP(3)
      WHERE nonce = ? AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP(3)`,
    [nonce],
    tx,
  );
  return res.affectedRows > 0;
}

export interface VerifiedWalletRow {
  user_id: string;
  chain_id: number;
  address: string;
  challenge_id: string | null;
  verified_at: Date;
  last_used_at: Date | null;
}

/**
 * Records that this account controls this wallet.
 *
 * `verified_wallets_address_uk` makes one wallet belong to at most one account
 * per chain. That is load-bearing rather than tidy: if two accounts could
 * claim the same address, an incoming transfer would match two orders and the
 * one-open-intent rule would be guarding nothing. A wallet already held by
 * someone else is a conflict the caller must surface, not overwrite.
 */
export async function recordVerifiedWallet(
  params: { userId: string; chainId: number; address: string; challengeId: string | null },
  tx?: PoolConnection,
): Promise<{ row: VerifiedWalletRow; heldByAnotherAccount: boolean }> {
  const address = params.address.toLowerCase();
  const existing = await queryOne<VerifiedWalletRow>(
    `SELECT user_id, chain_id, address, challenge_id, verified_at, last_used_at
       FROM verified_wallets WHERE chain_id = ? AND address = ?`,
    [params.chainId, address],
    tx,
  );
  if (existing && existing.user_id !== params.userId) {
    return { row: existing, heldByAnotherAccount: true };
  }
  await execute(
    `INSERT INTO verified_wallets (user_id, chain_id, address, challenge_id)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       challenge_id = VALUES(challenge_id),
       verified_at  = UTC_TIMESTAMP(3)`,
    [params.userId, params.chainId, address, params.challengeId],
    tx,
  );
  const row = await getVerifiedWallet({ userId: params.userId, chainId: params.chainId, address }, tx);
  if (!row) throw new Error('verified wallet insert failed to read back');
  return { row, heldByAnotherAccount: false };
}

/** Module-private until a caller outside needs it — the quote route will. */
async function getVerifiedWallet(
  params: { userId: string; chainId: number; address: string },
  tx?: PoolConnection,
): Promise<VerifiedWalletRow | undefined> {
  return queryOne<VerifiedWalletRow>(
    `SELECT user_id, chain_id, address, challenge_id, verified_at, last_used_at
       FROM verified_wallets WHERE user_id = ? AND chain_id = ? AND address = ?`,
    [params.userId, params.chainId, params.address.toLowerCase()],
    tx,
  );
}
