import { AppError } from '@yuha/contracts';
import { whitelistedTokens, type TokenSpec } from '@yuha/providers';
import type { AppConfig } from '../config.js';

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
  };
}

/** Enabled currencies on the configured chain. Empty when the feature is off. */
export function enabledStablecoinTokens(cfg: AppConfig): TokenSpec[] {
  if (!cfg.STABLECOIN_ENABLED) return [];
  const on = switchesFor(cfg);
  return whitelistedTokens().filter((t) => t.chainId === cfg.STABLECOIN_CHAIN_ID && on[t.key]);
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
  if (token.chainId !== cfg.STABLECOIN_CHAIN_ID) {
    throw new AppError('SERVICE_DISABLED', 'that currency is not available on the configured chain');
  }
  if (!switchesFor(cfg)[token.key]) {
    throw new AppError('SERVICE_DISABLED', 'that currency is not available yet');
  }
  return token;
}
