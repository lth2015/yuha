/**
 * The payment page's decisions, without a browser.
 *
 * Everything here is a pure function the page calls, and each one has a wrong
 * answer that would be invisible on screen: an amount that reads right and
 * sends something else, a step order that produces a wallet prompt which
 * cannot succeed, a wallet error rendered as a wallet's own English string to
 * a Japanese customer, or a fabricated network handed to `addEthereumChain`
 * and left in somebody's wallet.
 */
import { describe, expect, it } from 'vitest';
import {
  amountGap,
  countdown,
  explorerTxUrl,
  formatAtomic,
  jstMonthRange,
  knownChainParams,
  mayDecidePayments,
  parseChainId,
  payStep,
  pollDelayMs,
  secondsLeft,
  toHexChainId,
  walletProblem,
  type PayState,
} from '../apps/web/src/lib/stablecoin';

describe('an amount in atomic units', () => {
  it('reads as the number the customer will compare with their balance', () => {
    // 980 JPYC, 18 decimals. Number cannot hold this, which is the point.
    expect(formatAtomic('980000000000000000000', 18)).toBe('980');
    expect(formatAtomic('1980000000000000000000', 18)).toBe('1,980');
    // USDC's six decimals, for when a rate provider exists.
    expect(formatAtomic('980000000', 6)).toBe('980');
  });

  it('shows every digit of a fraction and rounds nothing', () => {
    expect(formatAtomic('980123456789012345678', 18)).toBe('980.123456789012345678');
    expect(formatAtomic('1', 18)).toBe('0.000000000000000001');
    expect(formatAtomic('6543210', 6)).toBe('6.54321');
  });

  it('handles zero and no decimals', () => {
    expect(formatAtomic('0', 18)).toBe('0');
    expect(formatAtomic('42', 0)).toBe('42');
  });

  it('refuses anything that is not an atomic amount', () => {
    // A float that arrived as a string, a negative, scientific notation, or a
    // precision nobody has: all of these would otherwise render something.
    for (const bad of ['', '98.0', '-1', '1e21', '0x10', ' 980']) {
      expect(() => formatAtomic(bad, 18), bad).toThrow(/digits only/);
    }
    expect(() => formatAtomic('1', 1.5)).toThrow(/implausible/);
    expect(() => formatAtomic('1', 99)).toThrow(/implausible/);
  });
});

describe('chain ids across the wallet boundary', () => {
  it('goes out as hex and comes back from either form', () => {
    expect(toHexChainId(137)).toBe('0x89');
    expect(parseChainId('0x89')).toBe(137);
    expect(parseChainId(137)).toBe(137);
  });

  it('refuses what is not a chain id rather than guessing zero', () => {
    for (const bad of [null, undefined, '', 'polygon', '0x', -1, 0, 1.5, {}]) {
      expect(parseChainId(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(() => toHexChainId(0)).toThrow();
  });
});

describe('asking a wallet to add a network', () => {
  it('describes Polygon from values that are checked in, not assembled', () => {
    const params = knownChainParams(137);
    expect(params?.chainId).toBe('0x89');
    expect(params?.nativeCurrency.symbol).toBe('POL');
    expect(params?.nativeCurrency.decimals).toBe(18);
    expect(params?.rpcUrls[0]).toMatch(/^https:/);
  });

  it('refuses to invent one for a chain it does not know', () => {
    /*
     * A fabricated RPC URL or a wrong native symbol is a lasting piece of
     * wrong configuration left in somebody's wallet, and a chain id this
     * build does not recognise means it should not be asking at all.
     */
    for (const chainId of [1, 80_002, 11_155_111, 999]) {
      expect(knownChainParams(chainId), String(chainId)).toBeNull();
    }
  });

  it('links to an explorer only for a real hash on a chain it knows', () => {
    expect(explorerTxUrl(137, `0x${'ab'.repeat(32)}`)).toBe(
      `https://polygonscan.com/tx/0x${'ab'.repeat(32)}`,
    );
    expect(explorerTxUrl(137, '0xabc')).toBeNull();
    expect(explorerTxUrl(1, `0x${'ab'.repeat(32)}`)).toBeNull();
  });
});

describe('what a wallet error means', () => {
  it('names the three codes the standard defines', () => {
    expect(walletProblem({ code: 4001 })).toBe('rejected');
    expect(walletProblem({ code: -32002 })).toBe('pending');
    expect(walletProblem({ code: 4902 })).toBe('unknownChain');
  });

  it('finds a code a wallet buried in data.originalError', () => {
    // Which is where MetaMask puts it for a failed chain switch.
    expect(walletProblem({ data: { originalError: { code: 4902 } } })).toBe('unknownChain');
  });

  it('separates not enough funds, because the remedy is the customer’s', () => {
    expect(walletProblem({ message: 'insufficient funds for gas * price + value' })).toBe(
      'insufficientFunds',
    );
    expect(walletProblem({ message: 'transfer amount exceeds balance' })).toBe('insufficientFunds');
  });

  it('falls back to a key, never to the wallet’s own sentence', () => {
    // The page renders a dictionary key for every one of these, so a wallet's
    // English is never shown to a Japanese customer.
    expect(walletProblem(new Error('something a wallet said'))).toBe('unknown');
    expect(walletProblem(null)).toBe('unknown');
    expect(walletProblem({ code: 'weird' })).toBe('unknown');
  });

  it('reads a rejection stated in words when there is no code', () => {
    expect(walletProblem({ message: 'User rejected the request.' })).toBe('rejected');
  });
});

describe('which step the customer is on', () => {
  const base: PayState = {
    hasProvider: true,
    account: '0x1111111111111111111111111111111111111111',
    chainId: 137,
    wantChainId: 137,
    walletVerified: true,
    hasQuote: true,
    reported: false,
    orderStatus: 'pending',
    delivered: false,
  };

  it('asks for a wallet before anything else', () => {
    expect(payStep({ ...base, hasProvider: false })).toBe('install');
    // Even with everything else somehow set: no provider, no flow.
    expect(payStep({ ...base, hasProvider: false, account: null })).toBe('install');
  });

  it('connects, then switches network, then proves, then quotes, then sends', () => {
    expect(payStep({ ...base, account: null })).toBe('connect');
    expect(payStep({ ...base, chainId: 1 })).toBe('switch-chain');
    expect(payStep({ ...base, walletVerified: false })).toBe('prove');
    expect(payStep({ ...base, hasQuote: false })).toBe('quote');
    expect(payStep(base)).toBe('send');
  });

  it('does not ask for a signature while the wallet is on the wrong network', () => {
    /*
     * The order is the point. A SIWE prompt on the wrong chain is a popup that
     * cannot lead anywhere, and a quote taken before the wallet is proved is a
     * request the server refuses — both of which look like the page being
     * broken rather than a step being out of order.
     */
    expect(payStep({ ...base, chainId: 1, walletVerified: false, hasQuote: false })).toBe(
      'switch-chain',
    );
    expect(payStep({ ...base, walletVerified: false, hasQuote: false })).toBe('prove');
  });

  it('waits once a hash is in, and only delivery says done', () => {
    expect(payStep({ ...base, reported: true })).toBe('waiting');
    // Paid but not yet handed over: still waiting, not done. The one thing
    // this page must never do is claim success because the customer clicked.
    expect(payStep({ ...base, orderStatus: 'paid', delivered: false })).toBe('waiting');
    expect(payStep({ ...base, orderStatus: 'paid', delivered: true })).toBe('done');
  });

  it('reports done even if the page never saw the transaction', () => {
    // A payment the scanner found by itself, or one made from another device.
    expect(payStep({ ...base, reported: false, delivered: true })).toBe('done');
  });

  it('does not treat an unasked chain as the wrong chain', () => {
    // null is "we have not asked yet", and asking the customer to switch
    // networks on the strength of not knowing is how a working wallet gets
    // told it is misconfigured.
    expect(payStep({ ...base, chainId: null })).toBe('send');
  });
});

describe('the quote clock', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');

  it('counts down and stops at zero', () => {
    expect(secondsLeft('2026-10-07T12:10:00Z', now)).toBe(600);
    expect(secondsLeft('2026-10-07T11:59:00Z', now)).toBe(0);
    expect(secondsLeft('not a date', now)).toBe(0);
  });

  it('reads as minutes and seconds', () => {
    expect(countdown(600)).toBe('10:00');
    expect(countdown(65)).toBe('1:05');
    expect(countdown(9)).toBe('0:09');
    expect(countdown(-5)).toBe('0:00');
  });

  it('stretches the gap between checks instead of hammering', () => {
    expect(pollDelayMs(0)).toBe(2000);
    expect(pollDelayMs(10)).toBe(4000);
    expect(pollDelayMs(20)).toBe(8000);
    // Monotonic: a later attempt never waits less than an earlier one.
    const delays = Array.from({ length: 25 }, (_, i) => pollDelayMs(i));
    expect(delays.every((d, i) => i === 0 || d >= delays[i - 1]!)).toBe(true);
  });
});

describe('the operations console', () => {
  it('says which way a payment missed, and by how much', () => {
    const exact = amountGap('980000000000000000000', '980000000000000000000');
    expect(exact).toEqual({ direction: 'exact', magnitude: '0' });

    // One atomic unit short, at eighteen decimals: the same double, and the
    // whole question an operator is deciding.
    const short = amountGap('980000000000000000000', '979999999999999999999');
    expect(short).toEqual({ direction: 'short', magnitude: '1' });

    const over = amountGap('980000000000000000000', '981000000000000000000');
    expect(over).toEqual({ direction: 'over', magnitude: '1000000000000000000' });
  });

  it('has nothing to say when nothing arrived, or when the figures are not figures', () => {
    expect(amountGap('980000000000000000000', null)).toBeNull();
    expect(amountGap('980000000000000000000', '98.5')).toBeNull();
    expect(amountGap('not a number', '1')).toBeNull();
  });

  it('bounds a month in JST, because that is the month being reconciled', () => {
    /*
     * `paid_at` is stored in UTC and the month a tax accountant reconciles is
     * a Japanese calendar month. UTC boundaries would put nine hours of
     * 1 October into September's file and leave nine hours of 31 October out
     * of October's — a reconciliation that does not reconcile.
     */
    expect(jstMonthRange('2026-10')).toEqual({
      from: '2026-09-30T15:00:00.000Z',
      to: '2026-10-31T15:00:00.000Z',
    });
  });

  it('rolls December into the next January', () => {
    expect(jstMonthRange('2026-12')).toEqual({
      from: '2026-11-30T15:00:00.000Z',
      to: '2026-12-31T15:00:00.000Z',
    });
  });

  it('refuses anything that is not a month instead of building a range from NaN', () => {
    for (const bad of ['', '2026', '2026-13', '2026-00', '2026-1', 'october', '2026-10-01']) {
      expect(jstMonthRange(bad), bad).toBeNull();
    }
  });

  it('lets only an admin decide about a payment', () => {
    expect(mayDecidePayments('admin')).toBe(true);
    expect(mayDecidePayments('support')).toBe(false);
    expect(mayDecidePayments('user')).toBe(false);
    expect(mayDecidePayments(undefined)).toBe(false);
  });
});
