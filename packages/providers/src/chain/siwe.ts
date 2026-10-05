import { isAddress as viemIsAddress, getAddress, recoverMessageAddress } from 'viem';

/**
 * Proof that somebody controls a wallet, as EIP-4361 (Sign-In with Ethereum).
 *
 * The message is BUILT BY THE SERVER from its own stored challenge and never
 * parsed from the client. A verify request carries an address and a signature,
 * nothing else — so there is no message text to parse, no field to disagree
 * with the record, and no way to present a signature over a message whose
 * domain, chain or expiry was something other than what we issued. Accepting a
 * client-supplied SIWE string and checking its fields afterwards is the usual
 * shape, and it is a parser plus seven comparisons where this is zero of each.
 *
 * Connecting a wallet proves nothing; a signature over our nonce does.
 */
export interface SiweChallenge {
  domain: string;
  uri: string;
  chainId: number;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
  /** Shown in the wallet. Plain, and says what it does not authorise. */
  statement: string;
}

export const SIWE_STATEMENT =
  'Prove you control this wallet so YUHA can match your stablecoin payment to your order. This authorises no transfer and no spending.';

/** EIP-4361, in the order the standard fixes. Both sides build it identically. */
export function buildSiweMessage(c: SiweChallenge, address: string): string {
  const checksummed = getAddress(address);
  return [
    `${c.domain} wants you to sign in with your Ethereum account:`,
    checksummed,
    '',
    c.statement,
    '',
    `URI: ${c.uri}`,
    'Version: 1',
    `Chain ID: ${c.chainId}`,
    `Nonce: ${c.nonce}`,
    `Issued At: ${c.issuedAt.toISOString()}`,
    `Expiration Time: ${c.expiresAt.toISOString()}`,
  ].join('\n');
}

/**
 * Format check with the checksum enforced.
 *
 * `getAddress` is a normaliser, not a validator — it recomputes the checksum
 * and returns a value for input whose own checksum was wrong, which was
 * checked against viem 2.57.3 rather than assumed from the name.
 * `isAddress(x, { strict: true })` is the one that refuses a bad checksum, and
 * accepts an all-lowercase address, which carries no checksum information.
 */
export function isValidAddress(value: unknown): value is string {
  return typeof value === 'string' && viemIsAddress(value, { strict: true });
}

/** Addresses are stored and compared lowercased; display uses the checksum. */
export function toStoredAddress(value: string): string {
  return getAddress(value).toLowerCase();
}

export function toDisplayAddress(value: string): string {
  return getAddress(value);
}

/**
 * True when `signature` is a signature over the message this challenge and
 * address produce. Any recovery failure is a false, never a throw: a
 * malformed signature is a wrong answer, not an error in our code.
 */
export async function verifySiweSignature(params: {
  challenge: SiweChallenge;
  address: string;
  signature: string;
}): Promise<boolean> {
  if (!isValidAddress(params.address)) return false;
  if (typeof params.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(params.signature)) return false;
  try {
    const recovered = await recoverMessageAddress({
      message: buildSiweMessage(params.challenge, params.address),
      signature: params.signature as `0x${string}`,
    });
    return recovered.toLowerCase() === params.address.toLowerCase();
  } catch {
    return false;
  }
}
