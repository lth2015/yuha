import { AppError } from '@yuha/contracts';
import { BSC_CHAIN_ID, whitelistedTokens, type TokenSpec } from '@yuha/providers';
import type { AppConfig, FeatureFlags } from '../config.js';

/**
 * Which currencies this deployment accepts, in one place.
 *
 * There were three: a `SUPPORTED` map in the quote service, a pair of
 * `tokenByKey` calls in the scanner, and — the moment the browser needed to
 * render a choice — a third would have been written here. A list repeated
 * three times is the defect shape this repository has shipped five times, and
 * for this list the consequence is quoting in one currency while watching for
 * another.
 *
 * The switch lookup is a `Record` over the key union rather than an if/else
 * chain, so adding a currency to `TokenSpec['key']` fails to compile until
 * somebody says whether it has a switch.
 */
function switchesFor(cfg: AppConfig): Record<TokenSpec['key'], boolean> {
  return {
    jpyc: cfg.STABLECOIN_JPYC_ENABLED,
    usdc: cfg.STABLECOIN_USDC_ENABLED,
    netx: cfg.STABLECOIN_NETX_ENABLED,
  };
}

/**
 * The chains this deployment can serve: the configured Polygon chain, and BNB
 * Smart Chain while NETX is switched on. A token on any other chain is never
 * offered, and no wallet is asked to prove itself on a chain nothing uses.
 */
export function servedChain(cfg: AppConfig, chainId: number): boolean {
  return chainId === cfg.STABLECOIN_CHAIN_ID || (chainId === BSC_CHAIN_ID && cfg.STABLECOIN_NETX_ENABLED);
}

/**
 * The runtime pauses, by key. A `Record` for the same reason as the switches:
 * a new currency does not compile until somebody decides whether it can be
 * paused. Only NETX can — its price is fixed while its market moves.
 */
function pausedBy(features: FeatureFlags): Record<TokenSpec['key'], boolean> {
  return { jpyc: false, usdc: false, netx: !features.netxPaymentsEnabled };
}

/**
 * Enabled, and not paused by an operator: what may be OFFERED and QUOTED now.
 *
 * Distinct from `enabledStablecoinTokens`, which is what the scanner watches.
 * Pausing a currency must stop new quotes without stopping the watch for a
 * payment already sent against an earlier one.
 */
export function acceptingStablecoinTokens(cfg: AppConfig, features: FeatureFlags): TokenSpec[] {
  const paused = pausedBy(features);
  return enabledStablecoinTokens(cfg).filter((t) => !paused[t.key]);
}

/** Enabled currencies on one chain: what that chain's scanner watches for. */
export function enabledTokensOn(cfg: AppConfig, chainId: number): TokenSpec[] {
  return enabledStablecoinTokens(cfg).filter((t) => t.chainId === chainId);
}

/** Enabled currencies on the configured chain. Empty when the feature is off. */
function enabledStablecoinTokens(cfg: AppConfig): TokenSpec[] {
  if (!cfg.STABLECOIN_ENABLED) return [];
  const on = switchesFor(cfg);
  return whitelistedTokens().filter((t) => servedChain(cfg, t.chainId) && on[t.key]);
}

/**
 * One currency by key, with the refusals a request path needs.
 *
 * Deliberately separate from the list above: a browser asking what it may pay
 * in wants an empty array, and a request asking to be quoted in something
 * unavailable wants to be told which of the three reasons applies.
 */
export function stablecoinTokenFor(cfg: AppConfig, key: string): TokenSpec {
  if (!cfg.STABLECOIN_ENABLED) {
    throw new AppError('SERVICE_DISABLED', 'stablecoin payments are not available');
  }
  const token = whitelistedTokens().find((t) => t.key === key);
  if (!token) throw new AppError('VALIDATION_FAILED', 'unknown currency');
  if (!servedChain(cfg, token.chainId)) {
    throw new AppError('SERVICE_DISABLED', 'that currency is not available on the configured chain');
  }
  if (!switchesFor(cfg)[token.key]) {
    throw new AppError('SERVICE_DISABLED', 'that currency is not available yet');
  }
  return token;
}

/**
 * Where scanning starts on a chain that has no cursor yet. Per chain because a
 * block number only means something on the chain it was read from.
 */
export function scanStartBlockFor(cfg: AppConfig, chainId: number): number | undefined {
  return chainId === BSC_CHAIN_ID ? cfg.BSC_SCAN_START_BLOCK : cfg.STABLECOIN_SCAN_START_BLOCK;
}
