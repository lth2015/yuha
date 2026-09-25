import type { Lang } from './i18n';

/**
 * The one place amounts become text.
 *
 * There were three: a correct one in `session`, a locale-blind one in
 * `Pricing`, and an open-coded `amountMinor / 100` in `SongDetail`. The last
 * was a silent 100× error waiting for the catalogue to move to JPY, which
 * for a Japan-first product is a question of when: JPY is zero-decimal, so
 * the stored integer IS the amount, while USD needs dividing by 100. The
 * columns that invited that mistake were called `amount_jpy` while holding
 * USD minor units; migration 0006 renamed them to `amount_minor`.
 *
 * Currency symbols belong here too, never in a translated string: a dictionary
 * entry with a hardcoded `$` renders "$499" the day prices are in yen.
 */

/** Currencies with no minor unit: the stored integer *is* the amount. */
const ZERO_DECIMAL = new Set(['jpy', 'krw', 'vnd']);

export const LOCALES: Record<Lang, string> = { zh: 'zh-CN', ja: 'ja-JP', en: 'en-US' };

export function isZeroDecimal(currency: string): boolean {
  return ZERO_DECIMAL.has(currency.toLowerCase());
}

/** Minor units → the major-unit number, respecting zero-decimal currencies. */
export function toMajor(amountMinor: number, currency: string): number {
  return isZeroDecimal(currency) ? amountMinor : amountMinor / 100;
}

/**
 * `currency` is required, and deliberately has no default.
 *
 * It used to default to `'usd'`. Four call sites in the checkout flow omitted
 * it, so a ¥980 pack rendered as **$9.80** — including on the 最終確認画面,
 * directly in front of the characters（税込）, which is the one screen
 * 特定商取引法 requires to state the real price at the moment the payment
 * obligation is created. Centralising the formatter did not fix that; the
 * default did. A required parameter turns every such call into a build error.
 */
export function formatMoney(
  amountMinor: number,
  currency: string,
  locale = 'en-US',
  opts: { fractionDigits?: number } = {},
): string {
  // Reporting can legitimately answer "mixed" for a window that spans more
  // than one currency. Intl would throw on that, and a thrown formatter in an
  // admin console is worse than saying plainly that the figure is not summable.
  if (currency === 'mixed') return `${amountMinor} (mixed currencies)`;
  const zero = isZeroDecimal(currency);
  const digits = opts.fractionDigits ?? (zero ? 0 : amountMinor % 100 === 0 ? 0 : 2);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(toMajor(amountMinor, currency));
}

/**
 * The unit price of a pack — the figure a buyer actually compares plans on.
 * Kept to real precision rather than rounded to the currency's usual digits,
 * because at ¥1 or $0.07 per song the rounding is the whole story.
 */
export function formatPerUnit(
  amountMinor: number,
  units: number,
  currency: string,
  locale: string,
): string {
  const each = amountMinor / Math.max(1, units);
  return formatMoney(each, currency, locale, { fractionDigits: isZeroDecimal(currency) ? 0 : 2 });
}
