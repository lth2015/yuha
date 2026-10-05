/**
 * The token whitelist.
 *
 * Two addresses on one chain, and nothing is accepted as proof of payment
 * unless it is one of them. Named-and-different is the whole attack: JPYC
 * Prepaid, the pre-資金移動業 JPYC, bridged USDC.e and outright counterfeits
 * all answer to the same symbol, and `symbol()` is a string anybody can set.
 *
 * `decimals` is written here because it is read from the contract at startup
 * and compared against this value (see `assertTokenShape`), not because the
 * name implies it. The specification is explicit: never infer precision from a
 * ticker. If the chain disagrees with this file, the process refuses to serve
 * stablecoin payments rather than quoting an amount a thousand times wrong.
 *
 * Re-verify both addresses against the official sources before enabling
 * either currency:
 *   JPYC  https://github.com/jpycoin
 *   USDC  https://developers.circle.com/stablecoins/usdc-contract-addresses
 */
const POLYGON_CHAIN_ID = 137;

export interface TokenSpec {
  readonly key: 'jpyc' | 'usdc';
  readonly chainId: number;
  readonly address: string;
  readonly decimals: number;
  readonly label: string;
}

export const JPYC_POLYGON: TokenSpec = {
  key: 'jpyc',
  chainId: POLYGON_CHAIN_ID,
  address: '0xe7c3d8c9a439fede00d2600032d5db0be71c3c29',
  decimals: 18,
  label: 'JPYC (Polygon PoS)',
};

export const USDC_POLYGON: TokenSpec = {
  key: 'usdc',
  chainId: POLYGON_CHAIN_ID,
  address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
  decimals: 6,
  label: 'USDC (Polygon PoS, native)',
};

/** Module-private until something outside needs to enumerate it. */
const WHITELISTED_TOKENS: readonly TokenSpec[] = [JPYC_POLYGON, USDC_POLYGON];

/**
 * Addresses are compared lowercased, never by string equality on whatever
 * casing arrived. EIP-55 checksum validation needs keccak256 and lands with
 * the RPC client; until then a well-formed 20-byte hex address is required and
 * mixed case is accepted as equal, which is correct for comparison and is not
 * a substitute for validating an address a user typed.
 */
function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function sameAddress(a: string, b: string): boolean {
  return isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();
}

export function tokenAt(chainId: number, address: string): TokenSpec | undefined {
  return WHITELISTED_TOKENS.find((t) => t.chainId === chainId && sameAddress(t.address, address));
}
