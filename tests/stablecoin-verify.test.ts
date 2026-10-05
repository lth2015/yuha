/**
 * The verifier, with no chain attached.
 *
 * Everything that decides whether an incoming transfer fulfils an order is a
 * pure function over a decoded transaction, its receipt, the Transfer logs and
 * the block it landed in. No RPC, no wallet, no network — which is the point:
 * every rejection the specification demands (§15) is a unit test that runs in
 * milliseconds and cannot pass by accident of a mocked client.
 */
import { describe, expect, it } from 'vitest';
import {
  JPYC_POLYGON,
  USDC_POLYGON,
  encodeTransferCalldata,
  verifyStablecoinPayment,
  type ChainObservation,
  type PaymentExpectation,
} from '@yuha/providers';

const RECEIVER = '0x1111111111111111111111111111111111111111';
const PAYER = '0x2222222222222222222222222222222222222222';
const STRANGER = '0x3333333333333333333333333333333333333333';
const FAKE_TOKEN = '0x4444444444444444444444444444444444444444';

/** 980 JPYC, 18 decimals. */
const AMOUNT = 980n * 10n ** 18n;

const expectation = (over: Partial<PaymentExpectation> = {}): PaymentExpectation => ({
  chainId: 137,
  token: JPYC_POLYGON.address,
  receiver: RECEIVER,
  amountAtomic: AMOUNT,
  verifiedPayer: PAYER,
  startBlock: 1_000n,
  expectedNonce: 7,
  quoteExpiresAt: new Date('2026-10-05T12:10:00Z'),
  ...over,
});

const observation = (over: Partial<ChainObservation> = {}): ChainObservation => ({
  transaction: {
    hash: '0xaa',
    chainId: 137,
    from: PAYER,
    to: JPYC_POLYGON.address,
    value: 0n,
    input: encodeTransferCalldata(RECEIVER, AMOUNT),
    nonce: 7,
    blockNumber: 1_200n,
    blockHash: '0xbb',
  },
  receipt: { status: 1, blockNumber: 1_200n, blockHash: '0xbb' },
  transferLogs: [
    { token: JPYC_POLYGON.address, from: PAYER, to: RECEIVER, value: AMOUNT, logIndex: 3, blockNumber: 1_200n },
  ],
  block: { number: 1_200n, hash: '0xbb', timestampMs: Date.parse('2026-10-05T12:05:00Z') },
  canonicalBlockHashAtHeight: '0xbb',
  finalizedBlockNumber: 1_300n,
  ...over,
});

describe('a payment that is exactly what was asked for', () => {
  it('fulfils, and says which transfer log is the evidence', () => {
    const v = verifyStablecoinPayment(expectation(), observation());
    expect(v.outcome).toBe('fulfil');
    expect(v.evidence).toEqual({ chainId: 137, txHash: '0xaa', logIndex: 3 });
  });

  it('fulfils the same way for USDC, where six decimals is not eighteen', () => {
    // 980 JPY at 150.00 JPY/USDC = 6.533334 USDC, rounded up.
    const amount = 6_533_334n;
    const exp = expectation({ token: USDC_POLYGON.address, amountAtomic: amount });
    const obs = observation({
      transaction: { ...observation().transaction, to: USDC_POLYGON.address, input: encodeTransferCalldata(RECEIVER, amount) },
      transferLogs: [{ token: USDC_POLYGON.address, from: PAYER, to: RECEIVER, value: amount, logIndex: 0, blockNumber: 1_200n }],
    });
    expect(verifyStablecoinPayment(exp, obs).outcome).toBe('fulfil');
  });
});

describe('refused outright', () => {
  const cases: Array<[string, Partial<ChainObservation>, string]> = [
    [
      'a failed transaction, however much it looks right',
      { receipt: { status: 0, blockNumber: 1_200n, blockHash: '0xbb' } },
      'receipt_failed',
    ],
    [
      'the wrong chain',
      { transaction: { ...observation().transaction, chainId: 1 } },
      'wrong_chain',
    ],
    [
      'a token with the same name and a different address',
      {
        transaction: { ...observation().transaction, to: FAKE_TOKEN },
        transferLogs: [{ token: FAKE_TOKEN, from: PAYER, to: RECEIVER, value: AMOUNT, logIndex: 0, blockNumber: 1_200n }],
      },
      'token_not_whitelisted',
    ],
    [
      'a transfer to somebody else',
      {
        transaction: { ...observation().transaction, input: encodeTransferCalldata(STRANGER, AMOUNT) },
        transferLogs: [{ token: JPYC_POLYGON.address, from: PAYER, to: STRANGER, value: AMOUNT, logIndex: 0, blockNumber: 1_200n }],
      },
      'wrong_receiver',
    ],
    [
      'a payer who is not the wallet that proved control',
      {
        transaction: { ...observation().transaction, from: STRANGER },
        transferLogs: [{ token: JPYC_POLYGON.address, from: STRANGER, to: RECEIVER, value: AMOUNT, logIndex: 0, blockNumber: 1_200n }],
      },
      'wrong_payer',
    ],
    [
      'a hash with no credible Transfer log behind it',
      { transferLogs: [] },
      'no_transfer_log',
    ],
    [
      'calldata that is not a plain transfer',
      { transaction: { ...observation().transaction, input: '0xdeadbeef' } },
      'calldata_not_transfer',
    ],
    [
      'native value riding along with the call',
      { transaction: { ...observation().transaction, value: 1n } },
      'unexpected_value',
    ],
    [
      'a block below where this quote started looking',
      {
        transaction: { ...observation().transaction, blockNumber: 900n },
        receipt: { status: 1, blockNumber: 900n, blockHash: '0xbb' },
        block: { number: 900n, hash: '0xbb', timestampMs: Date.parse('2026-10-05T12:05:00Z') },
        transferLogs: [{ token: JPYC_POLYGON.address, from: PAYER, to: RECEIVER, value: AMOUNT, logIndex: 0, blockNumber: 900n }],
      },
      'before_start_block',
    ],
    [
      'a block that is no longer the one at that height',
      { canonicalBlockHashAtHeight: '0xcc' },
      'reorged_out',
    ],
  ];

  for (const [name, over, reason] of cases) {
    it(name, () => {
      const v = verifyStablecoinPayment(expectation(), observation(over));
      expect(v.outcome, name).toBe('reject');
      expect(v.reason, name).toBe(reason);
    });
  }
});

describe('held, not refused and not fulfilled', () => {
  it('waits while the block is not finalized yet — status 1 is not finality', () => {
    const v = verifyStablecoinPayment(expectation(), observation({ finalizedBlockNumber: 1_199n }));
    expect(v.outcome).toBe('pending_finality');
  });

  it('sends an underpayment to review rather than keeping it quietly', () => {
    const short = AMOUNT - 1n;
    const v = verifyStablecoinPayment(
      expectation(),
      observation({
        transaction: { ...observation().transaction, input: encodeTransferCalldata(RECEIVER, short) },
        transferLogs: [{ token: JPYC_POLYGON.address, from: PAYER, to: RECEIVER, value: short, logIndex: 0, blockNumber: 1_200n }],
      }),
    );
    expect(v.outcome).toBe('review');
    expect(v.reason).toBe('amount_short');
  });

  it('sends an overpayment to review too, and never grants twice for it', () => {
    const over = AMOUNT + 1n;
    const v = verifyStablecoinPayment(
      expectation(),
      observation({
        transaction: { ...observation().transaction, input: encodeTransferCalldata(RECEIVER, over) },
        transferLogs: [{ token: JPYC_POLYGON.address, from: PAYER, to: RECEIVER, value: over, logIndex: 0, blockNumber: 1_200n }],
      }),
    );
    expect(v.outcome).toBe('review');
    expect(v.reason).toBe('amount_over');
  });

  it('honours a quote that was still live when the block was mined, even if finality came later', () => {
    // §8: the deadline is judged on the inclusion block's timestamp, not on
    // when an RPC first mentioned it and not on the browser clock.
    const v = verifyStablecoinPayment(
      expectation({ quoteExpiresAt: new Date('2026-10-05T12:05:30Z') }),
      observation({ finalizedBlockNumber: 5_000n }),
    );
    expect(v.outcome).toBe('fulfil');
  });

  it('sends a payment included after the quote expired to review', () => {
    const v = verifyStablecoinPayment(
      expectation({ quoteExpiresAt: new Date('2026-10-05T12:00:00Z') }),
      observation(),
    );
    expect(v.outcome).toBe('review');
    expect(v.reason).toBe('included_after_expiry');
  });
});

describe('the nonce is evidence, not the key', () => {
  /*
   * The specification binds an order to the payer's next account nonce. We
   * cannot reserve a nonce in someone else's wallet — it is predicted, and any
   * other dapp the owner touches while the quote is open consumes it. A
   * correct, exact, finalized payment from the proven payer must not be
   * refused because the number moved; it is recorded and reported instead.
   */
  it('fulfils an otherwise exact payment whose nonce moved', () => {
    const v = verifyStablecoinPayment(expectation(), observation({ transaction: { ...observation().transaction, nonce: 9 } }));
    expect(v.outcome).toBe('fulfil');
    expect(v.nonceMatched).toBe(false);
  });

  it('reports the match when it does hold', () => {
    expect(verifyStablecoinPayment(expectation(), observation()).nonceMatched).toBe(true);
  });
});
