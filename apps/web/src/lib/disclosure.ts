/**
 * Which 特定商取引法 fields the deployment has actually set.
 *
 * `GET /v1/legal/business-disclosure` never returns an empty string: an unset
 * field comes back as `(not configured)`, and an unset telephone number as a
 * dash, so that a default can never name a party (SEC-13). Both are fine on
 * an about-us page behind a draft banner. Neither is fine in a statutory row:
 * 特商法 requires the 運営統括責任者 and a telephone number, and `loadConfig`
 * requires neither — production starts on NAME, ADDRESS and CONTACT alone, and
 * `legalEntityConfigured` is derived from the same three, so the banner is not
 * showing either. `(not configured)` printed under 運営統括責任者 reads as the
 * name of the person responsible for the business.
 *
 * So the page needs to tell "set" from "the endpoint's way of saying unset",
 * and that is one predicate rather than a condition repeated per row — the
 * telephone row had it and the representative row did not, which is exactly
 * how the second one shipped blank.
 */
export function unconfiguredDisclosureField(value: string | undefined | null): boolean {
  if (!value) return true;
  const v = value.trim();
  return v === '' || v === '—' || v === '-' || v === '(not configured)';
}
