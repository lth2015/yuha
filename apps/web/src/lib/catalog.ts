import { productView, type ProductView } from '@yuha/contracts';
import { apiFetch } from './api';

/**
 * The catalogue, fetched once and actually checked.
 *
 * `GET /v1/products` answers `{ items: [...] }`. Three pages fetched it and two
 * declared the response as a bare `ProductView[]`:
 *
 *   - `Pricing` called `.slice()` on the object and threw, which with no error
 *     boundary blanked the entire app. The page was a white screen for eight
 *     days.
 *   - `SongDetail` made the same mistake inside `.catch(() => undefined)`, so
 *     the licence button was permanently disabled and nothing was logged.
 *
 * `apiFetch<T>` is an unchecked cast, so both annotations type-checked, built
 * and passed the suite.
 *
 * The first fix here checked only that `items` was an array and then cast the
 * elements — half the class, with a comment claiming the whole of it. The
 * contracts package already exports the schema, and zod is in the bundle
 * regardless (`messages.ts` imports `ERROR_CODES` as a value), so there is no
 * cost to parsing properly.
 */
export async function fetchProducts(): Promise<ProductView[]> {
  const body = await apiFetch<unknown>('/v1/products');
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) {
    const shape = body === null ? 'null' : typeof body;
    // Logged as well as thrown: `messageFor` maps anything that is not an
    // ApiError to the generic UNKNOWN message, so a caller that renders this
    // through `ErrorNotice` shows none of it. Without the log the diagnostic
    // reached nobody at all.
    const detail = `GET /v1/products returned ${shape} without an items array`;
    console.error(detail, body);
    throw new Error(detail);
  }

  /*
   * A malformed entry is dropped rather than thrown on: one bad row should not
   * cost the whole pricing page. It is dropped *loudly* — silently showing
   * fewer products is the same failure mode as silently showing none, and
   * `Pricing` renders an explicit empty state when nothing survives.
   */
  const ok: ProductView[] = [];
  for (const item of items) {
    const parsed = productView.safeParse(item);
    if (parsed.success) ok.push(parsed.data);
    else console.error('dropping a malformed product from the catalogue', parsed.error.issues, item);
  }
  return ok;
}

/** The single-song licence, or null when the catalogue does not offer one. */
export function findLicenceProduct(products: ProductView[]): ProductView | null {
  return products.find((p) => p.priceKey === 'market_license') ?? null;
}
