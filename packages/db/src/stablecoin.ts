import type { PoolConnection } from 'mysql2/promise';
import { execute, newId, query, queryOne } from './pool.js';

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

export async function getVerifiedWallet(
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

// ------------------------------------------------------------ quotes & intents

export interface StablecoinQuoteRow {
  id: string;
  order_id: string;
  user_id: string;
  token_key: string;
  chain_id: number;
  token_address: string;
  token_decimals: number;
  receiver: string;
  payer: string;
  price_jpy: number;
  amount_atomic: string;
  rate_text: string | null;
  rate_provider: string | null;
  rate_source_at: Date | null;
  rate_observed_at: Date | null;
  rounded_up: boolean;
  start_block: string | number;
  config_version: number;
  expires_at: Date;
  created_at: Date;
}

export interface StablecoinIntentRow {
  id: string;
  quote_id: string;
  order_id: string;
  chain_id: number;
  payer: string;
  predicted_nonce: number | null;
  state: string;
  open_key: string | null;
  prepared_at: Date | null;
  resolved_at: Date | null;
}

const QUOTE_COLUMNS = `id, order_id, user_id, token_key, chain_id, token_address, token_decimals,
  receiver, payer, price_jpy, amount_atomic, rate_text, rate_provider, rate_source_at,
  rate_observed_at, rounded_up, start_block, config_version, expires_at, created_at`;

const INTENT_COLUMNS = `id, quote_id, order_id, chain_id, payer, predicted_nonce, state,
  open_key, prepared_at, resolved_at`;

/**
 * The key that makes "one open intent per wallet per chain" a unique index.
 * Module-private: callers go through the functions below rather than composing
 * the key themselves, so there is one place that decides its shape.
 */
function openKeyFor(chainId: number, payer: string): string {
  return `${chainId}:${payer.toLowerCase()}`;
}

/**
 * Writes a quote and the intent that holds the payer's slot, in one
 * transaction.
 *
 * The insert into `stablecoin_intents` is what can fail, and failing is the
 * point: `stablecoin_intents_open_uk` refuses a second open intent for the
 * same wallet on the same chain. The caller turns that into a conflict the
 * customer can act on rather than catching it as an error.
 */
export async function insertQuoteWithIntent(
  params: {
    orderId: string;
    userId: string;
    tokenKey: string;
    chainId: number;
    tokenAddress: string;
    tokenDecimals: number;
    receiver: string;
    payer: string;
    priceJpy: number;
    amountAtomic: string;
    rateText: string | null;
    rateProvider: string | null;
    rateSourceAt: Date | null;
    rateObservedAt: Date | null;
    roundedUp: boolean;
    startBlock: bigint;
    configVersion: number;
    expiresAt: Date;
  },
  tx: PoolConnection,
): Promise<{ quote: StablecoinQuoteRow; intent: StablecoinIntentRow }> {
  const quoteId = newId();
  const payer = params.payer.toLowerCase();
  await execute(
    `INSERT INTO stablecoin_quotes
       (id, order_id, user_id, token_key, chain_id, token_address, token_decimals, receiver, payer,
        price_jpy, amount_atomic, rate_text, rate_provider, rate_source_at, rate_observed_at,
        rounded_up, start_block, config_version, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      quoteId,
      params.orderId,
      params.userId,
      params.tokenKey,
      params.chainId,
      params.tokenAddress.toLowerCase(),
      params.tokenDecimals,
      params.receiver.toLowerCase(),
      payer,
      params.priceJpy,
      params.amountAtomic,
      params.rateText,
      params.rateProvider,
      params.rateSourceAt,
      params.rateObservedAt,
      params.roundedUp ? 1 : 0,
      params.startBlock.toString(),
      params.configVersion,
      params.expiresAt,
    ],
    tx,
  );

  const intentId = newId();
  await execute(
    `INSERT INTO stablecoin_intents (id, quote_id, order_id, chain_id, payer, state, open_key)
     VALUES (?, ?, ?, ?, ?, 'quoted', ?)`,
    [intentId, quoteId, params.orderId, params.chainId, payer, openKeyFor(params.chainId, payer)],
    tx,
  );

  const quote = await queryOne<StablecoinQuoteRow>(
    `SELECT ${QUOTE_COLUMNS} FROM stablecoin_quotes WHERE id = ?`,
    [quoteId],
    tx,
  );
  const intent = await queryOne<StablecoinIntentRow>(
    `SELECT ${INTENT_COLUMNS} FROM stablecoin_intents WHERE id = ?`,
    [intentId],
    tx,
  );
  if (!quote || !intent) throw new Error('quote insert failed to read back');
  return { quote, intent };
}

/** The open intent for a wallet, if it has one. */
export async function findOpenIntentForPayer(
  params: { chainId: number; payer: string },
  tx?: PoolConnection,
): Promise<StablecoinIntentRow | undefined> {
  return queryOne<StablecoinIntentRow>(
    `SELECT ${INTENT_COLUMNS} FROM stablecoin_intents WHERE open_key = ?`,
    [openKeyFor(params.chainId, params.payer)],
    tx,
  );
}

export async function findOpenIntentForOrder(
  orderId: string,
  tx?: PoolConnection,
): Promise<StablecoinIntentRow | undefined> {
  return queryOne<StablecoinIntentRow>(
    `SELECT ${INTENT_COLUMNS} FROM stablecoin_intents
      WHERE order_id = ? AND open_key IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    [orderId],
    tx,
  );
}

export async function getQuote(id: string, tx?: PoolConnection): Promise<StablecoinQuoteRow | undefined> {
  return queryOne<StablecoinQuoteRow>(`SELECT ${QUOTE_COLUMNS} FROM stablecoin_quotes WHERE id = ?`, [id], tx);
}

/**
 * Closes an intent: it stops holding the wallet's slot, and the quote it
 * belongs to is kept rather than deleted — a superseded price is part of the
 * record of what the customer was shown.
 *
 * `open_key = NULL` is what frees the slot, and it is set in the same
 * statement as the state so the two cannot disagree.
 */
export async function closeIntent(
  params: { intentId: string; state: 'expired' | 'cancelled' | 'confirmed' | 'review' },
  tx?: PoolConnection,
): Promise<boolean> {
  const res = await execute(
    `UPDATE stablecoin_intents
        SET state = ?, open_key = NULL, resolved_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3)
      WHERE id = ? AND open_key IS NOT NULL`,
    [params.state, params.intentId],
    tx,
  );
  return res.affectedRows > 0;
}

/** Marks an intent prepared and records the nonce the chain predicted, if any. */
export async function markIntentPrepared(
  params: { intentId: string; predictedNonce: number | null },
  tx?: PoolConnection,
): Promise<void> {
  await execute(
    `UPDATE stablecoin_intents
        SET state = 'prepared', predicted_nonce = ?, prepared_at = UTC_TIMESTAMP(3),
            updated_at = UTC_TIMESTAMP(3)
      WHERE id = ? AND state IN ('quoted', 'prepared')`,
    [params.predictedNonce, params.intentId],
    tx,
  );
}

// -------------------------------------------------------- payment evidence

export interface TransferEventRow {
  id: string;
  chain_id: number;
  tx_hash: string;
  log_index: number;
  token_address: string;
  from_address: string;
  to_address: string;
  amount_atomic: string;
  block_number: string | number;
  block_hash: string;
  canonical: boolean;
  intent_id: string | null;
}

/**
 * Writes one Transfer as evidence, exactly once.
 *
 * `chain_transfer_events_evidence_uk` on (chain_id, tx_hash, log_index) is
 * what stops a copied public hash and stops one transfer being claimed by two
 * orders. `claimed: false` means this evidence already existed — which is the
 * normal answer when the scanner re-reads an overlapping block range, and the
 * answer that must NOT lead to a second fulfilment.
 *
 * The insert is attempted rather than preceded by a SELECT: a check-then-act
 * would let two workers both pass the check.
 */
export async function recordTransferEvent(
  params: {
    chainId: number;
    txHash: string;
    logIndex: number;
    tokenAddress: string;
    fromAddress: string;
    toAddress: string;
    amountAtomic: string;
    blockNumber: bigint;
    blockHash: string;
    blockTime: Date | null;
    intentId: string | null;
  },
  tx?: PoolConnection,
): Promise<{ claimed: boolean; row: TransferEventRow }> {
  const id = newId();
  const res = await execute(
    `INSERT IGNORE INTO chain_transfer_events
       (id, chain_id, tx_hash, log_index, token_address, from_address, to_address,
        amount_atomic, block_number, block_hash, block_time, intent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.chainId,
      params.txHash.toLowerCase(),
      params.logIndex,
      params.tokenAddress.toLowerCase(),
      params.fromAddress.toLowerCase(),
      params.toAddress.toLowerCase(),
      params.amountAtomic,
      params.blockNumber.toString(),
      params.blockHash.toLowerCase(),
      params.blockTime,
      params.intentId,
    ],
    tx,
  );
  const row = await queryOne<TransferEventRow>(
    `SELECT id, chain_id, tx_hash, log_index, token_address, from_address, to_address,
            amount_atomic, block_number, block_hash, canonical, intent_id
       FROM chain_transfer_events
      WHERE chain_id = ? AND tx_hash = ? AND log_index = ?`,
    [params.chainId, params.txHash.toLowerCase(), params.logIndex],
    tx,
  );
  if (!row) throw new Error('transfer event insert failed to read back');
  return { claimed: res.affectedRows > 0, row };
}

/** Records one observed hash against an intent, keeping every earlier one. */
export async function recordAttempt(
  params: {
    intentId: string;
    txHash: string;
    nonce: number | null;
    receiptStatus: number | null;
    blockNumber: bigint | null;
    blockHash: string | null;
    blockTime: Date | null;
    verdict: string | null;
  },
  tx?: PoolConnection,
): Promise<void> {
  await execute(
    `INSERT INTO stablecoin_attempts
       (id, intent_id, tx_hash, nonce, receipt_status, block_number, block_hash, block_time, verdict)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       receipt_status = VALUES(receipt_status),
       block_number   = VALUES(block_number),
       block_hash     = VALUES(block_hash),
       block_time     = VALUES(block_time),
       verdict        = VALUES(verdict),
       finalized_at   = IF(VALUES(verdict) = 'fulfil', UTC_TIMESTAMP(3), finalized_at)`,
    [
      newId(),
      params.intentId,
      params.txHash.toLowerCase(),
      params.nonce,
      params.receiptStatus,
      params.blockNumber?.toString() ?? null,
      params.blockHash?.toLowerCase() ?? null,
      params.blockTime,
      params.verdict,
    ],
    tx,
  );
}

// ------------------------------------------------------------- scan cursors

/**
 * Where the log scanner got to.
 *
 * One row per (chain, stream). A restart resumes from here rather than
 * rescanning from genesis or, worse, skipping the gap it was away for.
 */
export async function getChainCursor(
  params: { chainId: number; stream: string },
  tx?: PoolConnection,
): Promise<bigint | undefined> {
  const row = await queryOne<{ last_scanned_block: string | number }>(
    `SELECT last_scanned_block FROM chain_cursors WHERE chain_id = ? AND stream = ?`,
    [params.chainId, params.stream],
    tx,
  );
  return row ? BigInt(row.last_scanned_block) : undefined;
}

/**
 * Moves the cursor forward, and only forward.
 *
 * `GREATEST` in the UPDATE means a pass that somehow computed a lower value
 * cannot rewind the cursor and cause blocks to be re-settled — which would be
 * harmless today, because settlement is idempotent on the evidence key, and is
 * not something to rely on being harmless tomorrow.
 */
export async function setChainCursor(
  params: { chainId: number; stream: string; block: bigint },
  tx?: PoolConnection,
): Promise<void> {
  await execute(
    `INSERT INTO chain_cursors (chain_id, stream, last_scanned_block)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE last_scanned_block = GREATEST(last_scanned_block, VALUES(last_scanned_block))`,
    [params.chainId, params.stream, params.block.toString()],
    tx,
  );
}
