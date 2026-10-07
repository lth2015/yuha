/**
 * The decisions behind the stablecoin payment page, as pure functions.
 *
 * The page itself only renders. Everything that can be wrong — what an amount
 * in atomic units actually says, which step the customer is on, what a wallet's
 * error code means, and what to hand a wallet when asking it to change network
 * — lives here, where a test can ask it directly. A payment screen is the last
 * place to find out that a branch was never exercised.
 */

/**
 * Atomic units as a number a person can compare with their wallet balance.
 *
 * Done on the string, never through a float or a BigInt division: 980 JPYC is
 * 980000000000000000000 atomic units, which `Number` cannot hold, and the whole
 * point of this screen is that the figure shown is the figure sent. Trailing
 * zeros in the fraction are dropped so an exact amount reads as "980" rather
 * than "980.000000000000000000", and nothing is ever rounded — if a fraction
 * exists, every digit of it is shown.
 */
export function formatAtomic(amountAtomic: string, decimals: number): string {
  if (!/^[0-9]+$/.test(amountAtomic)) throw new Error('an atomic amount is digits only');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error('implausible decimals');
  }
  const padded = amountAtomic.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = decimals === 0 ? '' : padded.slice(padded.length - decimals).replace(/0+$/, '');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
}

/** `0x89` for 137: what `wallet_switchEthereumChain` wants. */
export function toHexChainId(chainId: number): string {
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error('not a chain id');
  return `0x${chainId.toString(16)}`;
}

/** The number behind whatever a wallet reported — hex string or number. */
export function parseChainId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value)) {
    const n = Number.parseInt(value, 16);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

export interface ChainParams {
  chainId: string;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrls: string[];
}

/**
 * What to hand `wallet_addEthereumChain`, for the chains we actually know.
 *
 * Returns null for anything else rather than assembling a plausible-looking
 * object: a fabricated RPC URL or a wrong native symbol in a wallet's network
 * list is a lasting piece of wrong configuration on someone's machine, and a
 * chain id we do not recognise means this build should not be asking.
 *
 * The URLs are Polygon's own public endpoints, used only to add the network to
 * the wallet; this application reads the chain through its own two configured
 * providers and never through these.
 */
export function knownChainParams(chainId: number): ChainParams | null {
  if (chainId === 137) {
    return {
      chainId: toHexChainId(137),
      chainName: 'Polygon',
      nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
      rpcUrls: ['https://polygon-rpc.com'],
      blockExplorerUrls: ['https://polygonscan.com'],
    };
  }
  return null;
}

/** A transaction on a chain we can link to, or null when we cannot. */
export function explorerTxUrl(chainId: number, txHash: string): string | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return null;
  if (chainId === 137) return `https://polygonscan.com/tx/${txHash}`;
  return null;
}

/**
 * Error keys the page can show. Every one is a dictionary key, so a wallet's
 * own English string is never rendered to a Japanese customer.
 */
export type WalletProblem =
  | 'noWallet'
  | 'rejected'
  | 'pending'
  | 'unknownChain'
  | 'wrongChain'
  | 'insufficientFunds'
  | 'unknown';

interface ProviderError {
  code?: unknown;
  message?: unknown;
  data?: { originalError?: { code?: unknown } };
}

/**
 * An EIP-1193 error to something the interface can say.
 *
 * The codes are the ones in the standard and in MetaMask's documentation:
 * 4001 is the user declining, 4902 is "this wallet does not have that chain",
 * and -32002 is a request already waiting in the wallet — which is the one
 * that most needs saying, because the window is often behind the browser and
 * the page otherwise looks frozen.
 *
 * The message is only ever consulted for insufficient funds, which has no
 * code of its own and is worth distinguishing because the remedy is the
 * customer's: more of the token, or gas.
 */
export function walletProblem(err: unknown): WalletProblem {
  if (err === undefined || err === null) return 'unknown';
  const e = err as ProviderError;
  const code = typeof e.code === 'number' ? e.code : parseNestedCode(e);
  if (code === 4001) return 'rejected';
  if (code === -32002) return 'pending';
  if (code === 4902) return 'unknownChain';
  const message = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  if (message.includes('insufficient funds') || message.includes('exceeds balance')) {
    return 'insufficientFunds';
  }
  if (message.includes('user rejected') || message.includes('user denied')) return 'rejected';
  return 'unknown';
}

function parseNestedCode(e: ProviderError): number | undefined {
  const nested = e.data?.originalError?.code;
  return typeof nested === 'number' ? nested : undefined;
}

export interface PayState {
  /** Whether an injected EIP-1193 provider exists at all. */
  hasProvider: boolean;
  /** The connected account, lowercased, or null. */
  account: string | null;
  /** What chain the wallet is on, or null when not asked yet. */
  chainId: number | null;
  /** The chain this deployment settles on. */
  wantChainId: number;
  /** Whether the connected account has proved control to this account. */
  walletVerified: boolean;
  /** A live quote for this order, if one has been taken. */
  hasQuote: boolean;
  /** Whether a transaction hash has been handed to the server. */
  reported: boolean;
  /** The order's status, as the server last reported it. */
  orderStatus: string | null;
  /** Whether the entitlement has been handed over. */
  delivered: boolean;
}

export type PayStep =
  | 'install'
  | 'connect'
  | 'switch-chain'
  | 'prove'
  | 'quote'
  | 'send'
  | 'waiting'
  | 'done';

/**
 * Which step the customer is on.
 *
 * A single function over the whole state rather than a chain of conditions
 * spread through the component, because the order matters and getting it wrong
 * is invisible: asking for a signature before the network is right produces a
 * prompt that cannot succeed, and showing "pay" before the wallet is proved
 * produces a quote the server will refuse. `done` is decided by delivery, not
 * by having sent a transaction — the one thing a payment page must not do is
 * claim success because the customer clicked.
 */
export function payStep(s: PayState): PayStep {
  if (s.delivered) return 'done';
  if (!s.hasProvider) return 'install';
  if (!s.account) return 'connect';
  if (s.chainId !== null && s.chainId !== s.wantChainId) return 'switch-chain';
  if (!s.walletVerified) return 'prove';
  if (!s.hasQuote) return 'quote';
  if (s.reported || s.orderStatus === 'paid') return 'waiting';
  return 'send';
}

/** Seconds left on a quote, floored at zero. */
export function secondsLeft(expiresAtIso: string, nowMs: number): number {
  const at = Date.parse(expiresAtIso);
  if (Number.isNaN(at)) return 0;
  return Math.max(0, Math.floor((at - nowMs) / 1000));
}

/** mm:ss for a countdown, from seconds. */
export function countdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${ss.toString().padStart(2, '0')}`;
}

/**
 * How long to wait before asking about an order again.
 *
 * Polygon's finality is a few seconds and the scanner's pass is fifteen, so
 * the first half-minute is checked briskly and then the gap stretches rather
 * than hammering an endpoint that is waiting on a block. The card path's
 * return page follows the same shape, for the same reason.
 */
export function pollDelayMs(attempt: number): number {
  if (attempt < 6) return 2000;
  if (attempt < 14) return 4000;
  return 8000;
}

/* -------------------------------------------------- the operations console */

/**
 * Which way a payment missed, and by how much.
 *
 * Both amounts are decimal strings in atomic units, so the comparison is
 * BigInt and never `Number`: at eighteen decimals, two amounts that differ by
 * a yen are the same double. An operator deciding whether to accept a payment
 * is deciding about money, and "short" versus "over" is the whole question.
 */
export interface AmountGap {
  direction: 'exact' | 'short' | 'over';
  /** The absolute difference, in atomic units, as a string. */
  magnitude: string;
}

export function amountGap(expectedAtomic: string, receivedAtomic: string | null): AmountGap | null {
  if (receivedAtomic === null) return null;
  if (!/^[0-9]+$/.test(expectedAtomic) || !/^[0-9]+$/.test(receivedAtomic)) return null;
  const expected = BigInt(expectedAtomic);
  const received = BigInt(receivedAtomic);
  if (received === expected) return { direction: 'exact', magnitude: '0' };
  return received < expected
    ? { direction: 'short', magnitude: (expected - received).toString() }
    : { direction: 'over', magnitude: (received - expected).toString() };
}

/**
 * The UTC instants bounding one JST calendar month.
 *
 * The export filters on `orders.paid_at`, which is stored in UTC, and the
 * month a 税理士 reconciles is a Japanese calendar month — so asking for
 * "October" with UTC boundaries would put nine hours of 1 October into
 * September's file and leave nine hours of 31 October out of October's. Japan
 * has no daylight saving, so the offset is a constant rather than a lookup.
 *
 * Returns null for anything that is not a real month, rather than a range
 * built from NaN.
 */
export function jstMonthRange(month: string): { from: string; to: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) return null;
  // 00:00 JST is 15:00 UTC the previous day.
  const from = Date.UTC(year, mon - 1, 1, -9, 0, 0);
  const to = Date.UTC(mon === 12 ? year + 1 : year, mon === 12 ? 0 : mon, 1, -9, 0, 0);
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/**
 * Who may decide about a payment.
 *
 * A function rather than an inline comparison because the console has to use
 * the same answer for whether to SHOW a button and whether to act on it. A
 * guard only the renderer consults is how a page ends up doing something it
 * does not offer.
 */
export function mayDecidePayments(role: string | undefined): boolean {
  return role === 'admin';
}
