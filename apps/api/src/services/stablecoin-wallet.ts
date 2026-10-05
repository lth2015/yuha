import { randomBytes } from 'node:crypto';
import { AppError } from '@yuha/contracts';
import {
  consumeWalletChallenge,
  createWalletChallenge,
  getWalletChallenge,
  recordVerifiedWallet,
} from '@yuha/db';
import {
  SIWE_STATEMENT,
  buildSiweMessage,
  isValidAddress,
  toDisplayAddress,
  toStoredAddress,
  verifySiweSignature,
  type SiweChallenge,
} from '@yuha/providers';
import type { AppContext } from '../context.js';

/**
 * Proving control of a wallet, before any money moves.
 *
 * A connected address is a claim the browser makes; a signature over a nonce
 * we issued is evidence. Everything downstream — the quote, the intent, the
 * verifier's `verifiedPayer` — rests on this step, so it is the one place
 * where "the client said so" must not be enough.
 */
const CHALLENGE_TTL_SECONDS = 10 * 60;

export interface IssuedChallenge {
  nonce: string;
  /** The exact text the wallet will be asked to sign. */
  message: string;
  expiresAt: Date;
}

function challengeOf(row: {
  domain: string;
  uri: string;
  chain_id: number;
  nonce: string;
  issued_at: Date;
  expires_at: Date;
}): SiweChallenge {
  return {
    domain: row.domain,
    uri: row.uri,
    chainId: row.chain_id,
    nonce: row.nonce,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    statement: SIWE_STATEMENT,
  };
}

/**
 * The domain and URI come from this server's own public URL, never from the
 * request. A request-supplied domain is what makes a signature portable to
 * another site, and the whole point of the field is that it is not.
 */
function originOf(ctx: AppContext): { domain: string; uri: string } {
  const url = new URL(ctx.config.PUBLIC_WEB_URL);
  return { domain: url.host, uri: url.origin };
}

export async function issueWalletChallenge(
  ctx: AppContext,
  params: { userId: string; chainId: number; address: string },
): Promise<IssuedChallenge> {
  // Required, not optional: the message is built around this address, and a
  // placeholder would oblige the client to edit the text before signing —
  // which is the client-supplied-message hazard this design removes.
  if (!isValidAddress(params.address)) {
    throw new AppError('VALIDATION_FAILED', 'that does not look like an Ethereum address');
  }
  const { domain, uri } = originOf(ctx);
  const row = await createWalletChallenge({
    userId: params.userId,
    nonce: randomBytes(16).toString('hex'),
    domain,
    uri,
    chainId: params.chainId,
    claimedAddress: toStoredAddress(params.address),
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000),
  });

  return {
    nonce: row.nonce,
    // Built here from the stored row, and rebuilt identically on verify. The
    // client never sends the message back, so there is nothing to parse and
    // nothing that can disagree with what we issued.
    message: buildSiweMessage(challengeOf(row), params.address),
    expiresAt: row.expires_at,
  };
}

export interface VerifiedWallet {
  address: string;
  chainId: number;
  verifiedAt: Date;
}

export async function verifyWalletChallenge(
  ctx: AppContext,
  params: { userId: string; nonce: string; address: string; signature: string },
): Promise<VerifiedWallet> {
  // One refusal for every way this can fail, so a caller learns whether the
  // nonce was wrong, used, expired or simply not theirs only to the extent
  // that it is their own account.
  const wrong = () => new AppError('VALIDATION_FAILED', 'that signature does not prove control of this wallet');

  if (!isValidAddress(params.address)) throw wrong();
  const row = await getWalletChallenge(params.nonce);
  if (!row || row.user_id !== params.userId) throw wrong();
  // Both conditions are enforced again in SQL by `consumeWalletChallenge`,
  // whose UPDATE only matches an unspent, unexpired row. That is where the
  // guarantee lives — this read is the fast path, not the protection, and the
  // difference matters under concurrency.
  if (row.consumed_at || row.expires_at.getTime() <= Date.now()) throw wrong();
  // Redundant today, and kept deliberately: the message is rebuilt below from
  // `params.address`, so a signature presented for a different wallet already
  // fails recovery. Removing this line breaks no test, which was checked. It
  // stays as a guard against one specific refactor — building the message from
  // the stored `claimed_address` instead — after which it becomes the only
  // thing tying the request's address to the challenge.
  if (row.claimed_address !== toStoredAddress(params.address)) throw wrong();

  const ok = await verifySiweSignature({
    challenge: challengeOf(row),
    address: params.address,
    signature: params.signature,
  });
  if (!ok) throw wrong();

  // Spent only after the signature checks out, and spent before the wallet is
  // recorded: a replay of the same nonce finds it consumed, and a failure
  // between the two leaves the challenge used rather than reusable.
  if (!(await consumeWalletChallenge(params.nonce))) throw wrong();

  const { row: wallet, heldByAnotherAccount } = await recordVerifiedWallet({
    userId: params.userId,
    chainId: row.chain_id,
    address: toStoredAddress(params.address),
    challengeId: row.id,
  });
  if (heldByAnotherAccount) {
    // Surfaced rather than overwritten. Two accounts holding one address would
    // make an incoming transfer ambiguous between two orders.
    throw new AppError('CONFLICT', 'this wallet is already linked to a different YUHA account');
  }

  return {
    address: toDisplayAddress(wallet.address),
    chainId: wallet.chain_id,
    verifiedAt: wallet.verified_at,
  };
}
