/**
 * A campaign tag from a link's `?src=` (docs/ATTRIBUTION_SPEC.md), in the one
 * spelling it is stored and counted under: lower case, spaces as hyphens, at
 * most 48 of [a-z0-9._-], starting with a letter or digit. Anything else is
 * not a tag (null) — it is never stored "as near as possible", because a
 * field anyone can type into would otherwise become a place to put an email.
 */
export function normalizeSource(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase().replace(/\s+/g, '-');
  return /^[a-z0-9][a-z0-9._-]{0,47}$/.test(s) ? s : null;
}
