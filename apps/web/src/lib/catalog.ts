import type { ProductView } from '@yuha/contracts';
import { apiFetch } from './api';

/**
 * The catalogue, fetched once and shaped correctly.
 *
 * `GET /v1/products` answers `{ items: [...] }`. Three pages fetched it and two
 * of them declared the response as a bare `ProductView[]`:
 *
 *   - `Pricing` called `.slice()` on the object and threw, which with no error
 *     boundary blanked the entire app. The pricing page was a white screen from
 *     2026-09-18 to 2026-09-26.
 *   - `SongDetail` made the same mistake inside `.catch(() => undefined)`, so
 *     the licence button was permanently disabled and nothing was logged.
 *
 * `apiFetch<T>` is an unchecked cast, so both annotations type-checked, built
 * and passed the suite. One function with one runtime check removes the class
 * rather than the two instances.
 */
export async function fetchProducts(): Promise<ProductView[]> {
  const body = await apiFetch<unknown>('/v1/products');
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) {
    // Loud and specific. The failure this replaces was a TypeError thrown from
    // inside a render, which says nothing about which endpoint lied.
    throw new Error(
      `GET /v1/products returned ${body === null ? 'null' : typeof body} without an items array`,
    );
  }
  return items as ProductView[];
}

/** The single-song licence, or null when the catalogue does not offer one. */
export function findLicenceProduct(products: ProductView[]): ProductView | null {
  return products.find((p) => p.priceKey === 'market_license') ?? null;
}
