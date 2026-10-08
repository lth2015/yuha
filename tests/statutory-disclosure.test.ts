/**
 * A statutory row that is unset must say so, not print the endpoint's way of
 * saying unset.
 *
 * 特定商取引法 requires the 運営統括責任者 and a telephone number. `loadConfig`
 * requires neither: production starts on LEGAL_ENTITY_NAME, _ADDRESS and
 * _CONTACT, and `legalEntityConfigured` — which the draft banner reads — is
 * derived from the same three. So a deployment that sets those three and not
 * the other two boots, reports `isPlaceholder: false`, shows no banner, and
 * renders `運営統括責任者: (not configured)` as a statutory disclosure. That is
 * the name of the person responsible for the business, published as a string
 * that came from a default.
 *
 * The telephone row had a guard and the representative row did not, which is
 * how the second one shipped. The guard is one predicate now, so the two rows
 * cannot drift apart again, and this pins both: the predicate's behaviour, and
 * that both rows go through it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { unconfiguredDisclosureField } from '../apps/web/src/lib/disclosure.js';

const page = readFileSync(new URL('../apps/web/src/pages/Tokushoho.tsx', import.meta.url), 'utf8');

/** The `<dd>` of one row of the statutory `<dl>`, by its `<dt>` label. */
function cell(label: string): string {
  const dl = page.slice(page.indexOf('<dl className="company-facts tokushoho">'), page.indexOf('</dl>'));
  for (const m of dl.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)) {
    if (m[1].replace(/\s+/g, ' ').trim() === label) return m[2];
  }
  throw new Error(`no row labelled ${label} in the 特商法 disclosure`);
}

describe('what the endpoint returns for a field nobody set', () => {
  it('reads as unset', () => {
    // The two the API actually serves (apps/api/src/routes/public.ts).
    expect(unconfiguredDisclosureField('(not configured)')).toBe(true);
    expect(unconfiguredDisclosureField('—')).toBe(true);
    // And the shapes a deployment produces by setting a variable to nothing.
    expect(unconfiguredDisclosureField('')).toBe(true);
    expect(unconfiguredDisclosureField('   ')).toBe(true);
    expect(unconfiguredDisclosureField('-')).toBe(true);
    expect(unconfiguredDisclosureField(undefined)).toBe(true);
    expect(unconfiguredDisclosureField(null)).toBe(true);
  });

  it('does not swallow a real value', () => {
    expect(unconfiguredDisclosureField('山田太郎')).toBe(false);
    expect(unconfiguredDisclosureField('03-0000-0000')).toBe(false);
    // A name that merely contains a dash is a name.
    expect(unconfiguredDisclosureField('Jean-Pierre')).toBe(false);
  });
});

describe('the statutory rows 特商法 requires and loadConfig does not', () => {
  for (const [label, field] of [
    ['運営統括責任者', 'd.representative'],
    ['電話番号', 'd.phone'],
  ] as const) {
    it(`${label} is marked 要法務確認 when it is unset`, () => {
      const dd = cell(label);
      expect(dd).toContain(`unconfiguredDisclosureField(${field})`);
      expect(dd).toContain('<Pending');
      // The marker has to name the variable, or nobody can act on it.
      expect(dd).toMatch(/LEGAL_ENTITY_(REPRESENTATIVE|PHONE)/);
      // And the real value is still what shows when it is set.
      expect(dd).toContain(field);
    });
  }

  it('the three loadConfig does require are printed without a guard', () => {
    // Not a style point: production cannot start without these, so a guard
    // here would be dead code pretending to be a safeguard.
    for (const [label, field] of [
      ['販売業者', 'd.entityName'],
      ['所在地', 'd.address'],
      ['メールアドレス', 'd.contact'],
    ] as const) {
      expect(cell(label).replace(/\s+/g, ' ').trim()).toBe(`{${field}}`);
    }
  });
});
