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

/**
 * Every wallet this account has proved control of.
 *
 * The interface needs it to know whether connecting a wallet should ask for a
 * signature or go straight to a quote. Without it the page either prompts for
 * a SIWE signature on every single purchase, or guesses from the text of an
 * error message.
 */
export async function listVerifiedWallets(userId: string, tx?: PoolConnection): Promise<VerifiedWalletRow[]> {
  return query<VerifiedWalletRow>(
    `SELECT user_id, chain_id, address, challenge_id, verified_at, last_used_at
       FROM verified_wallets WHERE user_id = ? ORDER BY verified_at`,
    [userId],
    tx,
  );
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
  order_open_key: string | null;
  prepared_at: Date | null;
  resolved_at: Date | null;
}

const QUOTE_COLUMNS = `id, order_id, user_id, token_key, chain_id, token_address, token_decimals,
  receiver, payer, price_jpy, amount_atomic, rate_text, rate_provider, rate_source_at,
  rate_observed_at, rounded_up, start_block, config_version, expires_at, created_at`;

/*
 * An explicit column list, and the fifth time this codebase has been bitten by
 * one that omitted a newly added column while the row type claimed it. The
 * rule that came out of the MFA lock defect — where `failed_attempts` was in
 * the type, absent from the SELECT, and read as `undefined` by a security
 * check — is that this list and `StablecoinIntentRow` are edited in the same
 * change, always.
 */
const INTENT_COLUMNS = `id, quote_id, order_id, chain_id, payer, predicted_nonce, state,
  open_key, order_open_key, prepared_at, resolved_at`;

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
    `INSERT INTO stablecoin_intents
       (id, quote_id, order_id, chain_id, payer, state, open_key, order_open_key)
     VALUES (?, ?, ?, ?, ?, 'quoted', ?, ?)`,
    // Two slots, both held by this row: the wallet's and the ORDER's. One
    // wallet could not open two payments; one order could, through two
    // wallets, and paying both took two payments for one delivery.
    [intentId, quoteId, params.orderId, params.chainId, payer, openKeyFor(params.chainId, payer), params.orderId],
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

/**
 * Open intents whose quote ran out, and ran out LONG ENOUGH ago.
 *
 * `closeIntent({ state: 'expired' })` had no caller at all, so one abandoned
 * quote held a wallet's only slot forever and every later quote that wallet
 * made for a different order was refused — permanently, with the customer's
 * only escape being to re-quote the same order.
 *
 * Giving it a caller then created a worse defect, because it fired the instant
 * the quote expired. A payment is only SEEN after the block holding it is
 * finalized plus up to one scan interval, so a payment made inside the quote
 * window — the verifier's own criterion — was routinely scanned after the
 * sweep had already closed its intent, arriving as money from a wallet with
 * nothing open. The customer paid on time and got nothing, automatically.
 *
 * `graceSeconds` is how long after expiry a slot is still held: it must cover
 * finality plus the scan interval, with room to spare, because the cost of
 * waiting is a held wallet slot and the cost of not waiting is a lost payment.
 *
 * `submitted` and `confirming` are excluded as well: those states mean a
 * payment is in flight, and nothing writes them today — which is exactly why
 * the filter belongs here now rather than after something does.
 */
export async function findExpiredOpenIntents(
  params: { graceSeconds: number; limit?: number } = { graceSeconds: 0 },
): Promise<StablecoinIntentRow[]> {
  return query<StablecoinIntentRow>(
    // Written out with the alias rather than reusing INTENT_COLUMNS: `id` and
    // `order_id` exist on both tables, so an unqualified list is ambiguous and
    // a regex that qualified only `id` would have left `order_id` broken.
    `SELECT i.id, i.quote_id, i.order_id, i.chain_id, i.payer, i.predicted_nonce,
            i.state, i.open_key, i.order_open_key, i.prepared_at, i.resolved_at
       FROM stablecoin_intents i
       JOIN stablecoin_quotes q ON q.id = i.quote_id
      WHERE i.open_key IS NOT NULL
        AND q.expires_at <= UTC_TIMESTAMP(3) - INTERVAL ? SECOND
        AND i.state NOT IN ('submitted', 'confirming')
      ORDER BY q.expires_at
      LIMIT ?`,
    [params.graceSeconds, params.limit ?? 100],
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
        SET state = ?, open_key = NULL, order_open_key = NULL,
            resolved_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3)
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
  if (res.affectedRows > 0) {
    /*
     * This transfer may have been recorded as orphaned on an earlier pass — a
     * payment that arrived before its quote, or one refused and then re-quoted
     * correctly. Settling it does not erase that record; it dates it, so the
     * operator queue stops showing money that has since been delivered.
     */
    await execute(
      `UPDATE stablecoin_orphan_transfers
          SET settled_at = UTC_TIMESTAMP(3)
        WHERE chain_id = ? AND tx_hash = ? AND log_index = ? AND settled_at IS NULL`,
      [params.chainId, params.txHash.toLowerCase(), params.logIndex],
      tx,
    );
  }
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

// ------------------------------------------------------------------- review

export interface ReviewItem {
  intent_id: string;
  order_id: string;
  user_id: string;
  state: string;
  payer: string;
  chain_id: number;
  token_key: string;
  /** What the order asked for. */
  expected_atomic: string;
  price_jpy: number;
  quote_expires_at: Date;
  /** What actually arrived, when something did. */
  received_atomic: string | null;
  tx_hash: string | null;
  log_index: number | null;
  block_number: string | number | null;
  block_time: Date | null;
  order_status: string;
  created_at: Date;
}

/**
 * Payments a person has to look at.
 *
 * Short, over, late and unattributed money all land here rather than being
 * guessed at. The join reaches the evidence so the answer does not need a
 * second round trip per row — an operator looking at a list of payments is
 * deciding about money and should see the amounts side by side.
 */
const REVIEW_SELECT = `SELECT i.id            AS intent_id,
            i.order_id,
            q.user_id,
            i.state,
            i.payer,
            i.chain_id,
            q.token_key,
            q.amount_atomic AS expected_atomic,
            q.price_jpy,
            q.expires_at    AS quote_expires_at,
            e.amount_atomic AS received_atomic,
            e.tx_hash,
            e.log_index,
            e.block_number,
            e.block_time,
            o.status        AS order_status,
            i.created_at
       FROM stablecoin_intents i
       JOIN stablecoin_quotes q ON q.id = i.quote_id
       JOIN orders o            ON o.id = i.order_id
       LEFT JOIN chain_transfer_events e ON e.intent_id = i.id`;

export async function listStablecoinReviews(limit = 100): Promise<ReviewItem[]> {
  return query<ReviewItem>(`${REVIEW_SELECT} WHERE i.state = 'review' ORDER BY i.created_at LIMIT ?`, [limit]);
}

/**
 * One payment in review, by id.
 *
 * The console's decision path found its subject with
 * `listStablecoinReviews(500).find(...)` over a list ordered oldest-first, so
 * past five hundred items in review a decision about real money answered
 * NOT_FOUND — and the console itself listed a hundred, so the two disagreed
 * about what existed. A lookup by id cannot run out.
 */
export async function getStablecoinReviewItem(intentId: string, tx?: PoolConnection): Promise<ReviewItem | undefined> {
  return queryOne<ReviewItem>(`${REVIEW_SELECT} WHERE i.id = ? AND i.state = 'review'`, [intentId], tx);
}

/** Takes an intent out of review once a person has decided what it was. */
export async function resolveReview(
  params: { intentId: string; state: 'confirmed' | 'cancelled' },
  tx?: PoolConnection,
): Promise<boolean> {
  const res = await execute(
    `UPDATE stablecoin_intents
        SET state = ?, resolved_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3)
      WHERE id = ? AND state = 'review'`,
    [params.state, params.intentId],
    tx,
  );
  return res.affectedRows > 0;
}

// -------------------------------------------------------------- accounting

export interface AccountingRow {
  order_id: string;
  price_key: string;
  track_id: string | null;
  price_jpy: number;
  token_key: string;
  chain_id: number;
  token_address: string;
  received_atomic: string;
  payer: string;
  receiver: string;
  tx_hash: string;
  log_index: number;
  block_time: Date | null;
  payment_received_at: Date | null;
  service_delivered_at: Date | null;
  rate_text: string | null;
  rate_provider: string | null;
  rate_observed_at: Date | null;
}

/**
 * Settled stablecoin payments, for the monthly reconciliation.
 *
 * Deliberately carries payment_received_at and service_delivered_at as
 * SEPARATE columns and no third one combining them: §13 is explicit that the
 * revenue-recognition date per SKU is the tax accountant's to set, and this
 * export must not quietly decide it by emitting one date and calling it
 * revenue.
 */
export async function listStablecoinAccounting(params: { from: Date; to: Date }): Promise<AccountingRow[]> {
  return query<AccountingRow>(
    `SELECT o.id                     AS order_id,
            o.price_key,
            JSON_UNQUOTE(JSON_EXTRACT(o.metadata, '$.track_id')) AS track_id,
            q.price_jpy,
            q.token_key,
            q.chain_id,
            q.token_address,
            e.amount_atomic          AS received_atomic,
            q.payer,
            q.receiver,
            e.tx_hash,
            e.log_index,
            e.block_time,
            o.paid_at                AS payment_received_at,
            o.entitlement_granted_at AS service_delivered_at,
            q.rate_text,
            q.rate_provider,
            q.rate_observed_at
       FROM chain_transfer_events e
       JOIN stablecoin_intents i ON i.id = e.intent_id
       JOIN stablecoin_quotes q  ON q.id = i.quote_id
       JOIN orders o             ON o.id = i.order_id
      WHERE i.state = 'confirmed'
        AND o.paid_at >= ? AND o.paid_at < ?
      ORDER BY o.paid_at`,
    [params.from, params.to],
  );
}

// ------------------------------------------------- money we cannot attribute

/**
 * Money that arrived and is not a settled payment.
 *
 * Deliberately a different table from `chain_transfer_events`, and the reason
 * is the most expensive defect this feature has produced. That table's unique
 * key on (chain, tx, log) is the anti-replay claim: one Transfer, one order,
 * once. Writing a row there for money we were NOT attributing — a transfer
 * from a wallet with nothing open, or one the verifier refused that
 * nonetheless really paid us — took the claim without giving the payment, and
 * every later observation of the real payment then answered `already_settled`.
 * The order stayed pending, nothing was delivered, and no console action could
 * attach it, because the only queue that lists such rows is read-only.
 *
 * Rows here claim nothing. They are the record that money moved, upserted on
 * every observation, and a transfer can appear here and settle normally later.
 */
export interface OrphanTransferRow {
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
  block_time: Date | null;
  reason: string;
  refused_for_intent_id: string | null;
  observed_at: Date;
  settled_at: Date | null;
  claimed_at: Date | null;
  claimed_by: string | null;
  claimed_order_id: string | null;
  dismissed_at: Date | null;
  dismissed_by: string | null;
  note: string | null;
}

const ORPHAN_COLUMNS = `id, chain_id, tx_hash, log_index, token_address, from_address, to_address,
  amount_atomic, block_number, block_hash, block_time, reason, refused_for_intent_id, observed_at,
  settled_at, claimed_at, claimed_by, claimed_order_id, dismissed_at, dismissed_by, note`;

/**
 * Records, or re-records, one unattributable transfer.
 *
 * An upsert and not an insert-if-absent: the scanner re-reads an overlapping
 * window every pass, and the second sighting of the same money is not an
 * error. It refreshes `reason` — a transfer refused as `token_not_quoted`
 * today may be refused for a different reason after a re-quote — and never
 * touches an operator's decision.
 */
export async function recordOrphanTransfer(
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
    reason: string;
    refusedForIntentId: string | null;
  },
  tx?: PoolConnection,
): Promise<OrphanTransferRow> {
  await execute(
    `INSERT INTO stablecoin_orphan_transfers
       (id, chain_id, tx_hash, log_index, token_address, from_address, to_address,
        amount_atomic, block_number, block_hash, block_time, reason, refused_for_intent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       reason = VALUES(reason),
       refused_for_intent_id = VALUES(refused_for_intent_id),
       block_number = VALUES(block_number),
       block_hash = VALUES(block_hash),
       block_time = VALUES(block_time)`,
    [
      newId(),
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
      params.reason,
      params.refusedForIntentId,
    ],
    tx,
  );
  const row = await queryOne<OrphanTransferRow>(
    `SELECT ${ORPHAN_COLUMNS} FROM stablecoin_orphan_transfers
      WHERE chain_id = ? AND tx_hash = ? AND log_index = ?`,
    [params.chainId, params.txHash.toLowerCase(), params.logIndex],
    tx,
  );
  if (!row) throw new Error('orphan transfer insert failed to read back');
  return row;
}

export async function getOrphanTransfer(id: string, tx?: PoolConnection): Promise<OrphanTransferRow | undefined> {
  return queryOne<OrphanTransferRow>(
    `SELECT ${ORPHAN_COLUMNS} FROM stablecoin_orphan_transfers WHERE id = ?`,
    [id],
    tx,
  );
}

/** Money still waiting for a person: not settled, not claimed, not dismissed. */
export async function listOpenOrphanTransfers(limit = 100): Promise<OrphanTransferRow[]> {
  return query<OrphanTransferRow>(
    `SELECT ${ORPHAN_COLUMNS} FROM stablecoin_orphan_transfers
      WHERE settled_at IS NULL AND claimed_at IS NULL AND dismissed_at IS NULL
      ORDER BY observed_at
      LIMIT ?`,
    [limit],
  );
}

/**
 * An operator attached this money to an order, or decided it is not ours to
 * deliver against.
 *
 * The UPDATE matches only a row no one has decided about, so two operators
 * acting at once cannot both win, and the caller must treat `false` as "it was
 * already decided" rather than retrying.
 */
export async function settleOrphanDecision(
  params:
    | { id: string; decision: 'claimed'; actorId: string; orderId: string; note: string }
    | { id: string; decision: 'dismissed'; actorId: string; note: string },
  tx?: PoolConnection,
): Promise<boolean> {
  const res =
    params.decision === 'claimed'
      ? await execute(
          `UPDATE stablecoin_orphan_transfers
              SET claimed_at = UTC_TIMESTAMP(3), claimed_by = ?, claimed_order_id = ?, note = ?
            WHERE id = ? AND claimed_at IS NULL AND dismissed_at IS NULL AND settled_at IS NULL`,
          [params.actorId, params.orderId, params.note, params.id],
          tx,
        )
      : await execute(
          `UPDATE stablecoin_orphan_transfers
              SET dismissed_at = UTC_TIMESTAMP(3), dismissed_by = ?, note = ?
            WHERE id = ? AND claimed_at IS NULL AND dismissed_at IS NULL AND settled_at IS NULL`,
          [params.actorId, params.note, params.id],
          tx,
        );
  return res.affectedRows > 0;
}

// ------------------------------------------------------------ refunds owed

/**
 * Marks the evidence for an intent as money we owe back.
 *
 * Rejecting a payment in review changed a state and nothing else, so the money
 * left every queue with no record that anything was owed. There is no
 * automated stablecoin refund by design — §13 keeps that in human hands on a
 * hardware wallet — which is precisely why the obligation has to be written
 * down somewhere a person can list.
 */
export async function markRefundOwed(intentId: string, tx?: PoolConnection): Promise<number> {
  const res = await execute(
    `UPDATE chain_transfer_events
        SET refund_owed_at = UTC_TIMESTAMP(3)
      WHERE intent_id = ? AND refund_owed_at IS NULL`,
    [intentId],
    tx,
  );
  return res.affectedRows;
}

export interface RefundOwedRow {
  tx_hash: string;
  log_index: number;
  chain_id: number;
  token_address: string;
  from_address: string;
  amount_atomic: string;
  refund_owed_at: Date;
  order_id: string | null;
  user_id: string | null;
}

export async function listRefundsOwed(limit = 100): Promise<RefundOwedRow[]> {
  return query<RefundOwedRow>(
    `SELECT e.tx_hash, e.log_index, e.chain_id, e.token_address, e.from_address,
            e.amount_atomic, e.refund_owed_at, i.order_id, q.user_id
       FROM chain_transfer_events e
       LEFT JOIN stablecoin_intents i ON i.id = e.intent_id
       LEFT JOIN stablecoin_quotes q  ON q.id = i.quote_id
      WHERE e.refund_owed_at IS NOT NULL
      ORDER BY e.refund_owed_at
      LIMIT ?`,
    [limit],
  );
}

/**
 * The most recent intent for an order, open or closed.
 *
 * Needed by the console's "attach this money to that order" action: the
 * evidence row has a foreign key to an intent, and by the time a person is
 * attaching unattributed money, that order's intent has usually expired.
 */
export async function findLatestIntentForOrder(
  orderId: string,
  tx?: PoolConnection,
): Promise<StablecoinIntentRow | undefined> {
  return queryOne<StablecoinIntentRow>(
    `SELECT ${INTENT_COLUMNS} FROM stablecoin_intents
      WHERE order_id = ? ORDER BY created_at DESC LIMIT 1`,
    [orderId],
    tx,
  );
}

/**
 * Confirms an intent a person has decided about, whatever state it was left in.
 *
 * Separate from `closeIntent`, which only matches a row still holding its slot
 * — correct for the automatic path, where closing an already-closed intent
 * would mean two settlements raced. This one is reached only from an operator
 * action with an audit row behind it, and the state it usually finds is
 * `expired`.
 */
export async function confirmIntentByDecision(intentId: string, tx?: PoolConnection): Promise<boolean> {
  const res = await execute(
    `UPDATE stablecoin_intents
        SET state = 'confirmed', open_key = NULL, order_open_key = NULL,
            resolved_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3)
      WHERE id = ? AND state <> 'confirmed'`,
    [intentId],
    tx,
  );
  return res.affectedRows > 0;
}

/**
 * The evidence row for one Transfer, if it has one.
 *
 * Settlement needs to recognise money it has already settled BEFORE it starts
 * reasoning about intents: the scanner re-reads an overlapping block range on
 * every pass, and by then the intent that payment belongs to is closed. The
 * code leaned on `INSERT IGNORE` reporting `claimed: false` to notice, which
 * worked only while the unattributed path was also writing to this table —
 * and that was the defect. Asking is clearer and does not need a write.
 */
export async function findTransferEvent(
  params: { chainId: number; txHash: string; logIndex: number },
  tx?: PoolConnection,
): Promise<(TransferEventRow & { order_id: string | null }) | undefined> {
  return queryOne<TransferEventRow & { order_id: string | null }>(
    `SELECT e.id, e.chain_id, e.tx_hash, e.log_index, e.token_address, e.from_address, e.to_address,
            e.amount_atomic, e.block_number, e.block_hash, e.canonical, e.intent_id, i.order_id
       FROM chain_transfer_events e
       LEFT JOIN stablecoin_intents i ON i.id = e.intent_id
      WHERE e.chain_id = ? AND e.tx_hash = ? AND e.log_index = ?`,
    [params.chainId, params.txHash.toLowerCase(), params.logIndex],
    tx,
  );
}
