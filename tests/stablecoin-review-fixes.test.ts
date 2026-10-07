/**
 * The rest of what two adversarial reviews found.
 *
 * Each of these was real while the suite was green. The pattern they share is
 * the one worth naming: a value that was written down wrong, a record that was
 * never written at all, or a return value that was computed and thrown away.
 * None of them needed an attacker.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { getChainCursor, query, setChainCursor } from '@yuha/db';
import {
  ChainNode,
  DualChainReader,
  encodeTransferCalldata,
  probeFinality,
  verifyTokenDecimals,
  type ChainObservation,
  type JsonRpcParams,
  type JsonRpcTransport,
  type TokenSpec,
} from '@yuha/providers';
import { settleStablecoinObservation } from '../apps/api/src/services/stablecoin-settle.js';
import {
  expireStaleIntents,
  resetTokenGateForTests,
  SCAN_STREAM,
  verifyConfiguredTokens,
} from '../apps/api/src/services/stablecoin-scan.js';
import { createStablecoinQuote } from '../apps/api/src/services/stablecoin.js';
import { balanceOf, createHarness, resetData, teardown, type Harness, type TestUser, seedScanCursor, verifiedChainStub } from './helpers/harness.js';

let h: Harness;
let callNo = 0;
const freshIp = () => ({ 'x-forwarded-for': `198.51.100.${(callNo++ % 200) + 10}` });

const RECEIVER = '0x9999999999999999999999999999999999999999';
const STRANGER = '0x3333333333333333333333333333333333333333';
const JPYC = '0xe7c3d8c9a439fede00d2600032d5db0be71c3c29';
const USDC = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
const AMOUNT = 980n * 10n ** 18n;
const accountA = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const PAYER = accountA.address.toLowerCase();

beforeAll(async () => {
  h = await createHarness({
    STABLECOIN_ENABLED: 'true',
    STABLECOIN_JPYC_ENABLED: 'true',
    STABLECOIN_RECEIVER_ADDRESS: RECEIVER,
    POLYGON_RPC_PRIMARY_URL: 'https://primary.invalid/rpc',
    POLYGON_RPC_SECONDARY_URL: 'https://secondary.invalid/rpc',
  });
  /*
   * The chain reader the quote path now needs.
   *
   * Quoting asks each configured token for its own `decimals()` before
   * computing an amount from the constant in the whitelist — the check that
   * used to exist only in the worker, which neither quotes nor delivers. A
   * real `DualChainReader` over a stub transport means the gate is exercised
   * rather than skipped.
   */
  h.ctx.chain = verifiedChainStub();
});
beforeEach(async () => {
  await resetData();
  await query(`DELETE FROM chain_cursors`);
  // Quoting refuses when nothing is watching the chain; the tests about where
  // a quote starts watching move this forward themselves.
  await seedScanCursor(1n);
  /*
   * The decimals gate memoises per process, keyed on the configured chain and
   * token addresses rather than on the reader — correct in production, where
   * the reader is fixed for the life of the process, and something a test file
   * that swaps readers has to clear between tests. Without this, one test's
   * verdict decides another's.
   */
  resetTokenGateForTests();
});
afterAll(async () => {
  await teardown();
});

async function linkedUser(email: string): Promise<TestUser> {
  const user = await h.createUser({ email });
  const ch = await h.app.inject({
    method: 'POST',
    url: '/v1/payments/stablecoin/wallet-challenge',
    headers: { ...user.authHeader, ...freshIp() },
    payload: { address: accountA.address, chainId: 137 } as never,
  });
  const { nonce, message } = ch.json() as { nonce: string; message: string };
  await h.app.inject({
    method: 'POST',
    url: '/v1/payments/stablecoin/wallet-verify',
    headers: { ...user.authHeader, ...freshIp() },
    payload: { nonce, address: accountA.address, signature: await accountA.signMessage({ message }) } as never,
  });
  return user;
}

const quote = (user: TestUser, key: string) =>
  createStablecoinQuote(h.ctx, {
    userId: user.id,
    priceKey: 'drop_5',
    idempotencyKey: key,
    tokenKey: 'jpyc',
    payer: accountA.address,
  });

/** A reader whose nodes answer `decimals()` and `eth_chainId` as told. */
function chainStubAnswering(callResult: string, chainId: number): DualChainReader {
  const node = (label: string) =>
    new ChainNode({
      label,
      async request(method: string) {
        if (method === 'eth_call') return callResult;
        if (method === 'eth_chainId') return `0x${chainId.toString(16)}`;
        throw new Error(`the stub was asked for ${method}`);
      },
    });
  return new DualChainReader(node('stub-a'), node('stub-b'));
}

function observe(over: Partial<{ amount: bigint; token: string; to: string; status: 0 | 1; extraLogFirst: boolean }> = {}): ChainObservation {
  const amount = over.amount ?? AMOUNT;
  const token = over.token ?? JPYC;
  const to = over.to ?? RECEIVER;
  const payment = { token, from: PAYER, to, value: amount, logIndex: 3, blockNumber: 500n };
  const noise = { token: STRANGER, from: PAYER, to: STRANGER, value: 1n, logIndex: 0, blockNumber: 500n };
  return {
    transaction: {
      hash: '0xaa', chainId: 137, from: PAYER, to: token, value: 0n,
      input: encodeTransferCalldata(to, amount), nonce: 11, blockNumber: 500n, blockHash: '0xbb',
    },
    receipt: { status: over.status ?? 1, blockNumber: 500n, blockHash: '0xbb' },
    transferLogs: over.extraLogFirst ? [noise, payment] : [payment],
    block: { number: 500n, hash: '0xbb', timestampMs: Date.now() },
    canonicalBlockHashAtHeight: '0xbb',
    finalizedBlockNumber: 600n,
  };
}

describe('a payment the verifier refuses is still money that arrived', () => {
  it('is written down, so an operator can see it', async () => {
    /*
     * A refusal left only a `stablecoin_attempts` row, which nothing in the
     * console surfaces. A customer paying USDC against a JPYC quote had real
     * money arrive that appeared in neither operator queue.
     */
    const user = await linkedUser('rej-usdc@example.jp');
    await quote(user, 'rej-usdc-0001');
    const out = await settleStablecoinObservation(h.ctx, observe({ token: USDC }));
    expect(out.kind).toBe('rejected');

    /*
     * In `stablecoin_orphan_transfers`, and deliberately NOT in
     * `chain_transfer_events`.
     *
     * The first version of this fix wrote the row to the evidence table, whose
     * unique key on (chain, tx, log) is the claim that a payment has been
     * spent. So recording this refusal CLAIMED the customer's real payment:
     * after they re-quoted in the right currency, the same transfer answered
     * `already_settled` forever and the order never moved. A reviewer proved
     * it with the scan's own overlap re-read.
     */
    const evidence = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM chain_transfer_events`);
    expect(Number(evidence[0]!.n)).toBe(0);

    const rows = await query<{ amount_atomic: string; reason: string; token_address: string; intent: string | null }>(
      `SELECT amount_atomic, reason, token_address, refused_for_intent_id AS intent
         FROM stablecoin_orphan_transfers`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount_atomic).toBe(AMOUNT.toString());
    expect(rows[0]!.reason).toBe('token_not_quoted');
    expect(rows[0]!.token_address).toBe(USDC);
    // Which intent it was refused FOR is recorded; it is not a claim on it.
    expect(rows[0]!.intent).not.toBeNull();
    expect((await balanceOf(user.id)).available).toBe(0);
  });

  it('writes nothing for a transaction that failed, because nothing moved', async () => {
    const user = await linkedUser('rej-failed@example.jp');
    await quote(user, 'rej-failed-0001');
    await settleStablecoinObservation(h.ctx, observe({ status: 0 }));
    const rows = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM chain_transfer_events`);
    expect(Number(rows[0]!.n)).toBe(0);
    const orphans = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM stablecoin_orphan_transfers`);
    expect(Number(orphans[0]!.n)).toBe(0);
  });
});

describe('money from a wallet with nothing open', () => {
  it('is recorded from the log that paid us, not from log zero', async () => {
    /*
     * These fields came from `transferLogs[0]`, and a transaction's first
     * Transfer is usually not the payment. The operator queue showed the wrong
     * amount to refund, keyed on a log index that was not the payment's.
     */
    const out = await settleStablecoinObservation(h.ctx, observe({ extraLogFirst: true }));
    expect(out.kind).toBe('unattributed');
    const rows = await query<{ amount_atomic: string; to_address: string; log_index: number }>(
      `SELECT amount_atomic, to_address, log_index FROM stablecoin_orphan_transfers`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount_atomic).toBe(AMOUNT.toString());
    expect(rows[0]!.to_address).toBe(RECEIVER.toLowerCase());
    expect(Number(rows[0]!.log_index)).toBe(3);
  });

  it('records BOTH when two transfers in one transaction pay us, and settles neither', async () => {
    /*
     * The fix above was "the log that paid us, not log zero", and a reviewer
     * pointed out that it still picks: `.find()` takes the first match, so
     * with two payments to our address the node's array order chose which
     * amount an operator was shown and which key was written. Choosing is the
     * thing to stop doing.
     */
    const obs = observe();
    obs.transferLogs = [
      { token: JPYC, from: PAYER, to: RECEIVER, value: AMOUNT, logIndex: 3, blockNumber: 500n },
      { token: JPYC, from: PAYER, to: RECEIVER, value: 1n, logIndex: 5, blockNumber: 500n },
    ];
    const out = await settleStablecoinObservation(h.ctx, obs);
    expect(out.kind).toBe('unattributed');
    expect(out.kind === 'unattributed' && out.reason).toMatch(/more than one transfer/);

    const rows = await query<{ log_index: number; amount_atomic: string }>(
      `SELECT log_index, amount_atomic FROM stablecoin_orphan_transfers ORDER BY log_index`,
    );
    expect(rows.map((r) => Number(r.log_index))).toEqual([3, 5]);
    const evidence = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM chain_transfer_events`);
    expect(Number(evidence[0]!.n)).toBe(0);
  });
});

describe('an order that can no longer be paid', () => {
  it('cannot be re-quoted after a refund', async () => {
    const user = await linkedUser('refunded@example.jp');
    const q = await quote(user, 'refunded-0001');
    await query(`UPDATE orders SET status = 'refunded' WHERE id = ?`, [q.orderId]);
    await expect(quote(user, 'refunded-0001')).rejects.toThrow(/no longer be paid/);
  });

  it('sends a payment that cannot move the order to review rather than reporting success', async () => {
    /*
     * `markOrderPaid` returns `changed`, which was discarded — so a second
     * payment on a refunded order was taken, delivered nothing, and answered
     * `fulfilled`.
     */
    const user = await linkedUser('unpayable@example.jp');
    const q = await quote(user, 'unpayable-0001');
    await query(`UPDATE orders SET status = 'refunded' WHERE id = ?`, [q.orderId]);

    const out = await settleStablecoinObservation(h.ctx, observe());
    expect(out.kind).toBe('review');
    expect((await balanceOf(user.id)).available).toBe(0);
    // The money is on the record even though the order could not take it.
    const rows = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM chain_transfer_events`);
    expect(Number(rows[0]!.n)).toBe(1);

    /*
     * And the intent is IN REVIEW, which is the half the first fix missed.
     *
     * It closed the intent as `confirmed` and then consulted `markOrderPaid`,
     * so this committed an intent in `confirmed` with an evidence row —
     * invisible to the review queue (wrong state) and to the unattributed
     * queue (it has an intent), while the accounting export counted it as
     * settled revenue against an order that was never delivered. The word
     * "review" came back to a caller that only logs it. A second reviewer
     * found that the fix had reproduced the defect it was fixing.
     */
    const intents = await query<{ state: string }>(`SELECT state FROM stablecoin_intents WHERE order_id = ?`, [
      q.orderId,
    ]);
    expect(intents[0]!.state).toBe('review');
    const { listStablecoinReviews, listStablecoinAccounting } = await import('@yuha/db');
    expect(await listStablecoinReviews()).toHaveLength(1);
    // And it is not counted as revenue.
    const accounting = await listStablecoinAccounting({ from: new Date(0), to: new Date(Date.now() + 86_400_000) });
    expect(accounting).toHaveLength(0);
  });
});

describe('who the payer is', () => {
  it('is the token contract’s record, not the transaction’s sender', async () => {
    /*
     * Attribution read `observation.transaction.from`, which came from one
     * node and was compared with nothing before the lookup — the verifier
     * compares it, but the verifier runs after attribution, so it never saw
     * it. A reviewer altered that one field in one RPC response and a real
     * payment became unattributable, permanently, with no alarm.
     *
     * The agreed Transfer log is the only sound source: it is the token
     * contract's own record of who paid, from a receipt both nodes describe
     * identically. A transaction whose SENDER is somebody else — a relayer
     * pulling an approved balance — is then attributed to the wallet whose
     * tokens moved and refused as `wrong_payer`, which is a refusal on the
     * record instead of silence.
     */
    const user = await linkedUser('relayed@example.jp');
    await quote(user, 'relayed-0001');

    const obs = observe();
    obs.transaction.from = STRANGER;
    const out = await settleStablecoinObservation(h.ctx, obs);
    expect(out.kind).toBe('rejected');
    expect(out.kind === 'rejected' && out.reason).toBe('wrong_payer');

    // Recorded against the intent it was refused for, so it is findable.
    const rows = await query<{ reason: string; intent: string | null }>(
      `SELECT reason, refused_for_intent_id AS intent FROM stablecoin_orphan_transfers`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe('wrong_payer');
    expect(rows[0]!.intent).not.toBeNull();
    expect((await balanceOf(user.id)).available).toBe(0);
  });
});

describe('the token check standing between a constant and a quote', () => {
  it('refuses to quote when the contract disagrees with the whitelist', async () => {
    /*
     * `verifyConfiguredTokens` had exactly one caller: the worker, once, at
     * startup. The worker scans. It is the API that computes every quote from
     * `token.decimals` and the API that settles a reported hash — so "the
     * scanner refuses to start" was true and beside the point: a mistyped
     * constant still priced a quote a trillion times wrong and still
     * delivered against it.
     */
    const user = await linkedUser('wrongdec@example.jp');
    const liar = chainStubAnswering(`0x${(6).toString(16).padStart(64, '0')}`, 137);
    const ctx = { ...h.ctx, chain: liar } as typeof h.ctx;
    await expect(
      createStablecoinQuote(ctx, {
        userId: user.id,
        priceKey: 'drop_5',
        idempotencyKey: 'wrongdec-0001',
        tokenKey: 'jpyc',
        payer: accountA.address,
      }),
    ).rejects.toThrow(/not available right now|misconfigured/);
  });

  it('refuses when an endpoint is not the chain this build was configured for', async () => {
    /*
     * `eth_chainId` was never called anywhere in the repository, while a
     * comment in the RPC client claimed the caller compared it. The
     * configuration requires the two URLs to differ, which two endpoints onto
     * the same WRONG chain satisfy perfectly.
     */
    const wrongChain = chainStubAnswering(`0x${(18).toString(16).padStart(64, '0')}`, 80_002);
    const problems = await verifyConfiguredTokens(h.ctx, wrongChain);
    expect(problems.some((p) => p.token === 'chain' && /not 137/.test(p.reason))).toBe(true);
  });
});

describe('a quote nobody paid', () => {
  it('stops holding the wallet once it expires', async () => {
    /*
     * `closeIntent({ state: 'expired' })` had no caller and no sweep. One
     * abandoned quote held a wallet's only slot forever, so every later quote
     * that wallet made for a different order was refused, permanently.
     */
    const user = await linkedUser('stale@example.jp');
    const first = await quote(user, 'stale-0001');
    await query(`UPDATE stablecoin_quotes SET expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 MINUTE WHERE id = ?`, [
      first.quoteId,
    ]);

    // Before the sweep: a different order is refused.
    await expect(quote(user, 'stale-0002')).rejects.toThrow(/already has a payment waiting/);

    expect(await expireStaleIntents({ graceSeconds: 0 })).toBe(1);
    const rows = await query<{ state: string; open_key: string | null }>(
      `SELECT state, open_key FROM stablecoin_intents WHERE quote_id = ?`,
      [first.quoteId],
    );
    expect(rows[0]!.state).toBe('expired');
    expect(rows[0]!.open_key).toBeNull();

    // And now the wallet can buy something else.
    await expect(quote(user, 'stale-0003')).resolves.toBeTruthy();
  });

  it('leaves a live quote alone', async () => {
    const user = await linkedUser('live@example.jp');
    await quote(user, 'live-0001');
    expect(await expireStaleIntents({ graceSeconds: 0 })).toBe(0);
  });

  it('holds the slot through the grace period, because an on-time payment is seen late', async () => {
    /*
     * Giving `expired` a caller created a worse defect than the one it fixed.
     * The scanner reads FINALIZED blocks, every fifteen seconds, so a payment
     * made inside the quote window is routinely first seen a minute after the
     * window closed. Sweeping on the deadline turned those on-time payments
     * into money from a wallet with nothing open: paid in time, nothing
     * delivered, nothing automatic to repair it. A reviewer reproduced it with
     * no attacker and no unusual timing at all.
     */
    const user = await linkedUser('grace@example.jp');
    const q = await quote(user, 'grace-0001');
    await query(`UPDATE stablecoin_quotes SET expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 MINUTE WHERE id = ?`, [
      q.quoteId,
    ]);

    // One minute past expiry, with a fifteen-minute grace: still held.
    expect(await expireStaleIntents({ graceSeconds: 900 })).toBe(0);

    // And the payment that arrives in that window still settles by itself.
    const out = await settleStablecoinObservation(h.ctx, observe());
    expect(out.kind).toBe('review');
    expect(out.kind === 'review' && out.reason).toBe('included_after_expiry');
    // Which is a person's decision, not a loss: it is in the review queue with
    // its evidence, rather than orphaned with the quote gone.
    const rows = await query<{ state: string }>(`SELECT state FROM stablecoin_intents WHERE quote_id = ?`, [q.quoteId]);
    expect(rows[0]!.state).toBe('review');
  });
});

describe('where a quote starts watching', () => {
  it('is where the scanner has reached, not block zero', async () => {
    /*
     * Hardcoded 0 disabled `before_start_block` entirely: the verifier bounds
     * inclusion only from above, so an arbitrarily old transfer could satisfy
     * a brand-new quote.
     */
    await setChainCursor({ chainId: 137, stream: SCAN_STREAM, block: 7_000n });
    const user = await linkedUser('startblock@example.jp');
    const q = await quote(user, 'startblock-0001');
    const rows = await query<{ start_block: string | number }>(
      `SELECT start_block FROM stablecoin_quotes WHERE id = ?`,
      [q.quoteId],
    );
    expect(BigInt(rows[0]!.start_block)).toBe(7_000n);
    expect(await getChainCursor({ chainId: 137, stream: SCAN_STREAM })).toBe(7_000n);
  });

  it('refuses a payment older than the quote', async () => {
    await setChainCursor({ chainId: 137, stream: SCAN_STREAM, block: 7_000n });
    const user = await linkedUser('oldpayment@example.jp');
    await quote(user, 'oldpayment-0001');
    // The observation is in block 500, far below where this quote starts.
    const out = await settleStablecoinObservation(h.ctx, observe());
    expect(out.kind).toBe('rejected');
    expect(out.kind === 'rejected' && out.reason).toBe('before_start_block');
    expect((await balanceOf(user.id)).available).toBe(0);
  });
});

describe('quoting before anything is watching the chain', () => {
  it('is refused, rather than priced from block zero', async () => {
    /*
     * `start_block` was `cursor ?? 0n`, and zero is not a conservative
     * default: `before_start_block` is the only bound on how OLD a satisfying
     * transfer may be, so a start block of zero let any historical transfer
     * from a verified wallet settle a brand-new quote — once per (chain, tx,
     * log), which is once for every old payment that wallet ever made to this
     * address. Reachable from the API alone, through the report endpoint,
     * with the scanner never having run.
     */
    await query(`DELETE FROM chain_cursors`);
    const user = await linkedUser('nocursor@example.jp');
    await expect(quote(user, 'nocursor-0001')).rejects.toThrow(/not being watched for yet/);
  });

  it('falls back to the configured start block when one is set', async () => {
    // A deployment can say where to begin; what it cannot do is begin at zero
    // by saying nothing.
    await query(`DELETE FROM chain_cursors`);
    const user = await linkedUser('cfgstart@example.jp');
    const ctx = { ...h.ctx, config: { ...h.ctx.config, STABLECOIN_SCAN_START_BLOCK: 4_200 } } as typeof h.ctx;
    const q = await createStablecoinQuote(ctx, {
      userId: user.id,
      priceKey: 'drop_5',
      idempotencyKey: 'cfgstart-0001',
      tokenKey: 'jpyc',
      payer: accountA.address,
    });
    const rows = await query<{ start_block: string | number }>(
      `SELECT start_block FROM stablecoin_quotes WHERE id = ?`,
      [q.quoteId],
    );
    expect(BigInt(rows[0]!.start_block)).toBe(4_200n);
  });
});

describe('the token decimals check that only a comment claimed', () => {
  const spec = (decimals: number): TokenSpec => ({
    key: 'jpyc', chainId: 137, address: JPYC, decimals, label: 'JPYC',
  });

  /** How a real `decimals()` answers: one 32-byte word. */
  const word = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

  it('accepts a contract that reports what the whitelist says', async () => {
    const problems = await verifyTokenDecimals(async () => word(18), [spec(18)]);
    expect(problems).toEqual([]);
  });

  it('refuses a contract that reports something else', async () => {
    // Six where eighteen was configured is a factor of a trillion, and every
    // quote would be "a number" that looked fine.
    const problems = await verifyTokenDecimals(async () => word(6), [spec(18)]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.kind).toBe('mismatch');
    expect(problems[0]!.reason).toMatch(/reports 6 decimals/);
  });

  it('refuses a contract that cannot be asked, and says so RETRYABLY', async () => {
    // The distinction is load-bearing: the worker latched on any problem at
    // all, so one timeout at boot permanently stopped the scanner, the
    // quote-expiry sweep and the scan cursor while the API kept selling.
    const problems = await verifyTokenDecimals(async () => {
      throw new Error('execution reverted');
    }, [spec(18)]);
    expect(problems[0]!.reason).toMatch(/could not be read/);
    expect(problems[0]!.kind).toBe('unavailable');
  });

  it('refuses an answer that is not a uint256 word, rather than making a number of it', async () => {
    // An address-shaped answer from a contract that is not a token used to be
    // read as an enormous "decimals"; an EOA answers '0x'.
    for (const answer of ['0x', '0x12', `0x${'ff'.repeat(20)}`]) {
      const problems = await verifyTokenDecimals(async () => answer, [spec(18)]);
      expect(problems, answer).toHaveLength(1);
      expect(problems[0]!.reason, answer).toMatch(/not a uint256 word/);
    }
  });
});

describe('the finality probe', () => {
  const hex = (n: number) => `0x${n.toString(16)}`;
  function node(over: { latest: number; finalized: number; finalizedHash?: string; atHeightHash?: string }): ChainNode {
    const transport: JsonRpcTransport = {
      label: 'fake',
      async request(method: string, params: JsonRpcParams) {
        if (method === 'eth_blockNumber') return hex(over.latest);
        if (method === 'eth_getBlockByNumber') {
          const tag = params[0] as string;
          if (tag === 'finalized') {
            return { number: hex(over.finalized), hash: over.finalizedHash ?? '0xaa', timestamp: hex(1_700_000_000) };
          }
          return { number: tag, hash: over.atHeightHash ?? '0xaa', timestamp: hex(1_700_000_000) };
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    return new ChainNode(transport);
  }

  it('refuses a finalized header that is not the block at that height', async () => {
    // A node answering the tag from a cache, another network, or thin air.
    const p = await probeFinality(node({ latest: 1_000, finalized: 990, finalizedHash: '0xaa', atHeightHash: '0xbb' }));
    expect(p.supported).toBe(false);
    expect(p.reason).toMatch(/is not the block at height 990/);
  });

  it('accepts a node whose finalized header really is at that height', async () => {
    const p = await probeFinality(node({ latest: 1_000, finalized: 990 }));
    expect(p.supported).toBe(true);
  });
});
