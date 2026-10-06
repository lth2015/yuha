/**
 * The payment path against a real EVM.
 *
 * Everything else in this suite runs against fake nodes, which is right for
 * arranging a reorg or two nodes at odds, and wrong for one thing: a fake
 * agrees with whatever the code believes about encoding. Here the calldata is
 * executed by an actual EVM, the Transfer log is emitted by an actual ERC-20,
 * and the receipt comes back through an actual JSON-RPC implementation.
 *
 * The token is a mock and is labelled one. It is not JPYC, not USDC, not
 * redeemable for anything, and it never touches a mainnet address — §16 D.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ganache from 'ganache';
import { encodeDeployData, encodeFunctionData, parseAbi } from 'viem';
import {
  ChainNode,
  TRANSFER_TOPIC,
  addressTopic,
  decodeTransferCalldata,
  decodeTransferLog,
  encodeTransferCalldata,
  probeFinality,
  quoteAmountAtomic,
  scanIncomingTransfers,
  verifyStablecoinPayment,
  type JsonRpcParams,
  type JsonRpcTransport,
  type TokenSpec,
} from '@yuha/providers';

const artifact = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/evm/MockToken.json', import.meta.url)), 'utf8'),
) as { abi: unknown[]; bytecode: `0x${string}` };

/** Ganache's deterministic accounts: [0] deploys and pays, [1] receives. */
let provider: ReturnType<typeof Ganache.provider>;
let node: ChainNode;
let accounts: string[];

const rpc = async (method: string, params: unknown[] = []): Promise<any> =>
  provider.request({ method, params } as never);

beforeAll(async () => {
  provider = Ganache.provider({ logging: { quiet: true }, wallet: { deterministic: true } });
  accounts = (await rpc('eth_accounts')) as string[];
  const transport: JsonRpcTransport = {
    label: 'local-evm',
    async request(method: string, params: JsonRpcParams) {
      return rpc(method, params as unknown[]);
    },
  };
  node = new ChainNode(transport);
});
afterAll(async () => {
  await provider.disconnect();
});

async function deployToken(decimals: number): Promise<string> {
  // `encodeDeployData`, not `encodeFunctionData`: a constructor has no
  // selector, and asking the function encoder for one answers "not found".
  const data = encodeDeployData({
    abi: parseAbi(['constructor(string,string,uint8,uint256)']),
    bytecode: artifact.bytecode,
    args: ['Mock Token', 'MOCK', decimals, 10n ** 30n],
  });
  const hash = (await rpc('eth_sendTransaction', [{ from: accounts[0], data, gas: '0x1e8480' }])) as string;
  const receipt = await rpc('eth_getTransactionReceipt', [hash]);
  expect(receipt.status).toBe('0x1');
  return (receipt.contractAddress as string).toLowerCase();
}

describe('a real node that serves latest for finalized', () => {
  it('is refused, which is the point of asking rather than assuming', async () => {
    /*
     * Ganache answers `eth_getBlockByNumber('finalized')` with its own head.
     * It is not a Polygon node, but it is a REAL implementation exhibiting the
     * exact failure the provider documentation warns about — and the probe had
     * no check for it until that was read. Confirmed here at block 12 rather
     * than at genesis, where equality would prove nothing.
     */
    await rpc('evm_mine', [{ blocks: 12 }]);
    const probe = await probeFinality(node);
    expect(probe.supported).toBe(false);
    expect(probe.reason).toMatch(/serving latest for finalized/);
  });
});

describe('calldata, executed rather than asserted', () => {
  it('moves the money a quote asked for, and emits the log the scanner reads', async () => {
    const token = await deployToken(18);
    const jpyc: TokenSpec = { key: 'jpyc', chainId: 1337, address: token, decimals: 18, label: 'mock' };
    const { amountAtomic } = quoteAmountAtomic({ priceJpy: 980, token: jpyc, rate: null });

    // The exact bytes `prepare` hands a wallet, run by an actual EVM.
    const hash = (await rpc('eth_sendTransaction', [
      { from: accounts[0], to: token, data: encodeTransferCalldata(accounts[1]!, amountAtomic), gas: '0x30d40' },
    ])) as string;
    const receipt = await rpc('eth_getTransactionReceipt', [hash]);
    expect(receipt.status).toBe('0x1');

    // The event shape the scanner decodes, from a real contract rather than a
    // fixture written to match the decoder.
    expect(receipt.logs).toHaveLength(1);
    expect(receipt.logs[0].topics[0]).toBe(TRANSFER_TOPIC);
    expect(receipt.logs[0].topics[1]).toBe(addressTopic(accounts[0]!));
    expect(receipt.logs[0].topics[2]).toBe(addressTopic(accounts[1]!));

    const parsed = await node.receipt(hash);
    const transfer = decodeTransferLog(parsed!.logs[0]!, 1337)!;
    expect(transfer.amountAtomic).toBe(amountAtomic);
    expect(transfer.to).toBe(accounts[1]!.toLowerCase());
  });

  it('round-trips through the decoder the verifier uses', async () => {
    const amount = 123_456_789n;
    const decoded = decodeTransferCalldata(encodeTransferCalldata(accounts[1]!, amount))!;
    expect(decoded.amountAtomic).toBe(amount);
    expect(decoded.to).toBe(accounts[1]!.toLowerCase());
  });
});

describe('eighteen decimals and six are not the same number', () => {
  it('sends a thousand times less for USDC than a careless build would', async () => {
    /*
     * The failure this guards: quoting a six-decimal token with eighteen
     * decimals overpays by 10^12, and quoting the other way underpays by the
     * same. Both are "a number" and both look fine in a log line. Two real
     * contracts, deployed with different decimals, and the amounts compared.
     */
    const token18 = await deployToken(18);
    const token6 = await deployToken(6);

    const asJpyc: TokenSpec = { key: 'jpyc', chainId: 1337, address: token18, decimals: 18, label: 'mock-18' };
    const asUsdc: TokenSpec = { key: 'usdc', chainId: 1337, address: token6, decimals: 6, label: 'mock-6' };

    const jpycAmount = quoteAmountAtomic({ priceJpy: 980, token: asJpyc, rate: null }).amountAtomic;
    const { parseDecimalRate } = await import('@yuha/providers');
    const usdcAmount = quoteAmountAtomic({
      priceJpy: 980,
      token: asUsdc,
      rate: parseDecimalRate('150.00'),
    }).amountAtomic;

    expect(jpycAmount).toBe(980n * 10n ** 18n);
    expect(usdcAmount).toBe(6_533_334n);
    expect(jpycAmount / usdcAmount).toBeGreaterThan(10n ** 14n);

    // And each contract really holds what it was sent, at its own precision.
    for (const [token, amount] of [
      [token18, jpycAmount],
      [token6, usdcAmount],
    ] as const) {
      const hash = (await rpc('eth_sendTransaction', [
        { from: accounts[0], to: token, data: encodeTransferCalldata(accounts[1]!, amount), gas: '0x30d40' },
      ])) as string;
      const receipt = await rpc('eth_getTransactionReceipt', [hash]);
      expect(receipt.status).toBe('0x1');
      const balance = await rpc('eth_call', [
        {
          to: token,
          data: encodeFunctionData({ abi: parseAbi(['function balanceOf(address) view returns (uint256)']), args: [accounts[1] as `0x${string}`] }),
        },
        'latest',
      ]);
      expect(BigInt(balance as string)).toBe(amount);
    }
  });

  it('reads decimals() off the contract, never off the ticker', async () => {
    // §4: precision is read from the chain and locked into configuration. A
    // token called JPYC with six decimals is a different token.
    const token6 = await deployToken(6);
    const result = await rpc('eth_call', [
      { to: token6, data: encodeFunctionData({ abi: parseAbi(['function decimals() view returns (uint8)']), args: [] }) },
      'latest',
    ]);
    expect(Number(BigInt(result as string))).toBe(6);
  });
});

describe('the scanner, against a real log index', () => {
  it('finds a payment among a block’s other transfers', async () => {
    const token = await deployToken(18);
    const payer = accounts[0]!.toLowerCase();
    const receiver = accounts[1]!.toLowerCase();
    const stranger = accounts[2]!.toLowerCase();
    const amount = 980n * 10n ** 18n;

    const from = BigInt(await rpc('eth_blockNumber')) + 1n;
    // Noise first, then the payment, then more noise.
    for (const [to, value] of [
      [stranger, 1n],
      [receiver, amount],
      [stranger, 2n],
    ] as const) {
      await rpc('eth_sendTransaction', [
        { from: accounts[0], to: token, data: encodeTransferCalldata(to, value), gas: '0x30d40' },
      ]);
    }
    const to = BigInt(await rpc('eth_blockNumber'));

    const found = await scanIncomingTransfers({
      node,
      chainId: 1337,
      receiver,
      tokenAddresses: [token],
      window: { fromBlock: from, toBlock: to },
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.amountAtomic).toBe(amount);
    expect(found[0]!.from).toBe(payer);
  });

  it('refuses a real, perfect transfer of a token that is not on the whitelist', async () => {
    /*
     * This test wanted to end in `fulfil` and cannot, which is the finding.
     *
     * The whitelist is two addresses compiled into the code, not a runtime
     * input, so a mock token on a local chain is refused however correct the
     * payment is — right sender, right recipient, right amount, real receipt,
     * real log, valid nonce. That is the same-named-counterfeit defence, and
     * here it is demonstrated against a real contract rather than a fixture.
     *
     * Making the whitelist injectable would let this say `fulfil` and would
     * turn the one thing that cannot be faked into something a configuration
     * mistake could widen. The test asserts what is true instead.
     */
    const token = await deployToken(18);
    const payer = accounts[0]!.toLowerCase();
    const receiver = accounts[1]!.toLowerCase();
    const amount = 980n * 10n ** 18n;

    const hash = (await rpc('eth_sendTransaction', [
      { from: accounts[0], to: token, data: encodeTransferCalldata(receiver, amount), gas: '0x30d40' },
    ])) as string;
    const tx = (await node.transaction(hash))!;
    const receipt = (await node.receipt(hash))!;
    const header = (await node.blockAt(receipt.blockNumber))!;
    const log = decodeTransferLog(receipt.logs[0]!, 1337)!;

    // Everything below the whitelist is correct, and checked here so the
    // refusal is known to be about the token and not about a broken fixture.
    expect(receipt.status).toBe(1);
    expect(log.from).toBe(payer);
    expect(log.to).toBe(receiver);
    expect(log.amountAtomic).toBe(amount);
    expect(decodeTransferCalldata(tx.input)!.amountAtomic).toBe(amount);

    const verdict = verifyStablecoinPayment(
      {
        chainId: 1337,
        token,
        receiver,
        amountAtomic: amount,
        verifiedPayer: payer,
        startBlock: 0n,
        expectedNonce: tx.nonce,
        quoteExpiresAt: new Date(header.timestampMs + 60_000),
      },
      {
        transaction: { ...tx, chainId: 1337, to: tx.to, blockNumber: tx.blockNumber!, blockHash: tx.blockHash! },
        receipt: { status: receipt.status, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash },
        transferLogs: [
          { token: log.tokenAddress, from: log.from, to: log.to, value: log.amountAtomic, logIndex: log.logIndex, blockNumber: log.blockNumber },
        ],
        block: header,
        canonicalBlockHashAtHeight: header.hash,
        finalizedBlockNumber: receipt.blockNumber,
      },
    );
    expect(verdict.outcome).toBe('reject');
    expect(verdict.reason).toBe('token_not_whitelisted');
    // The nonce still matched; it just never got to matter.
    expect(verdict.nonceMatched).toBe(true);
  });
});
