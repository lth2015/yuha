/**
 * ERC-20 `transfer(address,uint256)` calldata, encoded and decoded by hand.
 *
 * Two 32-byte words after a four-byte selector. Hand-written rather than
 * pulled from an ABI library because this is the one call shape v1 ever makes
 * or ever accepts, the encoding is frozen by the standard, and a dependency
 * that can encode a hundred other calls is a larger surface than the fifteen
 * lines it would replace. The RPC client in phase C brings a real library with
 * it; this stays regardless, because *decoding* an arbitrary transaction's
 * input and refusing anything that is not exactly this call is a security
 * boundary, not a convenience.
 *
 * keccak256('transfer(address,uint256)')[0:4]
 */
const TRANSFER_SELECTOR = '0xa9059cbb';

/** Max uint256; an amount above this cannot be an ERC-20 value. */
const MAX_UINT256 = 2n ** 256n - 1n;

export function encodeTransferCalldata(to: string, amountAtomic: bigint): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error('transfer: recipient is not an address');
  if (amountAtomic < 0n || amountAtomic > MAX_UINT256) throw new Error('transfer: amount out of range');
  const addressWord = to.slice(2).toLowerCase().padStart(64, '0');
  const amountWord = amountAtomic.toString(16).padStart(64, '0');
  return `${TRANSFER_SELECTOR}${addressWord}${amountWord}`;
}

export interface DecodedTransfer {
  to: string;
  amountAtomic: bigint;
}

/**
 * Returns the call's arguments, or undefined when the input is anything other
 * than exactly one `transfer(address,uint256)` — a longer payload, a different
 * selector, extra trailing bytes, or a non-zero high word in the address slot
 * (which would mean the encoder did not put an address there).
 */
export function decodeTransferCalldata(input: string): DecodedTransfer | undefined {
  if (typeof input !== 'string' || !/^0x[0-9a-fA-F]*$/.test(input)) return undefined;
  const body = input.slice(2).toLowerCase();
  if (body.length !== 8 + 64 + 64) return undefined;
  if (`0x${body.slice(0, 8)}` !== TRANSFER_SELECTOR) return undefined;

  const addressWord = body.slice(8, 72);
  if (addressWord.slice(0, 24) !== '0'.repeat(24)) return undefined;
  const amountWord = body.slice(72);
  return { to: `0x${addressWord.slice(24)}`, amountAtomic: BigInt(`0x${amountWord}`) };
}
