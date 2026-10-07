/**
 * The token whitelist.
 *
 * Two addresses on one chain, and nothing is accepted as proof of payment
 * unless it is one of them. Named-and-different is the whole attack: JPYC
 * Prepaid, the pre-資金移動業 JPYC, bridged USDC.e and outright counterfeits
 * all answer to the same symbol, and `symbol()` is a string anybody can set.
 *
 * `decimals` is written here and checked against the contract by
 * `verifyTokenDecimals` before the scanner starts. The specification is
 * explicit: never infer precision from a ticker. If the chain disagrees with
 * this file, scanning does not start rather than quoting an amount a trillion
 * times wrong.
 *
 * That sentence used to name a function called `assertTokenShape` which
 * existed nowhere but in this comment — a check described, never written, and
 * believed for a week. Found by an adversarial review.
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

/**
 * The spec for a currency ON A CHAIN.
 *
 * `chainId` is not optional, and that is the point: this matched on `key`
 * alone while `tokenAt` matched on both, so the scanner's filter and the
 * verifier's lookup could answer about different chains. Today the whitelist
 * holds one chain and the two agree by accident; adding a second chain's JPYC
 * would have made them disagree silently, with the scanner watching one
 * contract and the verifier accepting another. That is the same shape as the
 * five "a list that quietly excludes the new thing" defects in this codebase,
 * inverted — a lookup narrower than the list it reads.
 */
export function tokenByKey(key: TokenSpec['key'], chainId: number): TokenSpec {
  const spec = WHITELISTED_TOKENS.find((t) => t.key === key && t.chainId === chainId);
  if (!spec) throw new Error(`no whitelisted token called ${key} on chain ${chainId}`);
  return spec;
}

/** keccak256('decimals()')[0:4] — a constant of the ERC-20 standard. */
const DECIMALS_SELECTOR = '0x313ce567';

export interface TokenShapeProblem {
  /** A currency, or 'chain' for a problem with the endpoint itself. */
  token: TokenSpec['key'] | 'chain';
  /**
   * Which kind of problem, because the two deserve opposite responses.
   *
   * `mismatch` is a build that cannot be trusted: the contract says one
   * precision and this file says another, so every quote is wrong by a power
   * of ten and the only safe answer is to refuse, permanently, until a person
   * looks. `unavailable` is not knowing — an RPC timeout, a rate limit, two
   * nodes disagreeing — which must be RETRIED rather than latched.
   *
   * They were one kind, and the only caller latched on both: one 429 at worker
   * boot permanently stopped the scanner, the quote-expiry sweep and the scan
   * cursor for the life of the process, while the API went on selling.
   */
  kind: 'mismatch' | 'unavailable';
  reason: string;
}

/**
 * Reads `decimals()` off each contract and compares it with this file.
 *
 * A quote for a six-decimal token computed at eighteen overpays by a factor of
 * a trillion, and the wrong way underpays by the same; both are "a number" and
 * both read fine in a log line. The only defence against a wrong address or a
 * mistyped constant here is asking the contract, which is why the
 * specification says precision is read from the chain and locked into
 * configuration rather than inferred from a ticker.
 *
 * Returns the problems rather than throwing, so a caller can report all of
 * them at once and decide whether to refuse to start or to refuse one
 * currency.
 */
export async function verifyTokenDecimals(
  call: (params: { to: string; data: string }) => Promise<string>,
  tokens: readonly TokenSpec[],
): Promise<TokenShapeProblem[]> {
  const problems: TokenShapeProblem[] = [];
  for (const token of tokens) {
    let raw: string;
    try {
      raw = await call({ to: token.address, data: DECIMALS_SELECTOR });
    } catch (e) {
      problems.push({
        token: token.key,
        kind: 'unavailable',
        reason: `decimals() could not be read: ${(e as Error).message}`,
      });
      continue;
    }
    /*
     * One 32-byte word of hex, and nothing else.
     *
     * `/^0x[0-9a-fA-F]+$/` accepted any length, and `Number(BigInt(raw))` then
     * made a number out of whatever arrived — including an address-shaped
     * answer from a contract that is not a token at all. An EOA answers `0x`,
     * which this rejects; a contract returning a 20-byte word now fails here
     * rather than being silently read as an enormous "decimals".
     */
    if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
      problems.push({
        token: token.key,
        kind: 'mismatch',
        reason: `decimals() answered ${raw}, which is not a uint256 word`,
      });
      continue;
    }
    const onChain = Number(BigInt(raw));
    if (onChain !== token.decimals) {
      problems.push({
        token: token.key,
        kind: 'mismatch',
        reason: `the contract reports ${onChain} decimals and this build is configured for ${token.decimals}`,
      });
    }
  }
  return problems;
}
