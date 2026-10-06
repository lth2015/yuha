import { http } from 'viem';
import type { JsonRpcParams, JsonRpcTransport } from './rpc.js';

/**
 * A real JSON-RPC transport, over viem's HTTP client.
 *
 * Thin on purpose: viem does the framing, retries and timeouts, and `ChainNode`
 * does the parsing. Everything that decides whether a payment is real lives
 * behind the `JsonRpcTransport` interface, so it is reachable from a test with
 * no network — which is why that interface exists rather than a client type.
 *
 * `label` is what appears in an alert when the two nodes disagree, so it must
 * never be the URL: the URL carries an API key. The caller passes a name.
 */
export function httpTransport(params: { label: string; url: string }): JsonRpcTransport {
  const inner = http(params.url, {
    // A payment scanner would rather see an error and try the next pass than
    // hold a request open; the loop re-reads overlapping ranges anyway.
    timeout: 15_000,
    retryCount: 2,
  })({ chain: undefined });

  return {
    label: params.label,
    async request(method: string, rpcParams: JsonRpcParams): Promise<unknown> {
      return inner.request({ method, params: rpcParams as never });
    },
  };
}
