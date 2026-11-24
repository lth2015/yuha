/**
 * The confirmation a person gives is recorded with the version of the wording
 * they were shown (users.consent_version; docs/legal/COUNSEL_RESPONSE_2026-11.md,
 * second round, 8). A version is only worth recording if it names one wording.
 *
 * So the wording is pinned here: the confirmation strings in all three
 * languages and the whole legal page. Change any of it and this fails until
 * CONSENT_VERSION moves on and the new fingerprint is added below — a record
 * can then never claim a wording its holder was not shown.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONSENT_VERSION } from '@yuha/contracts';
import zh from '../apps/web/src/lib/i18n-zh';
import ja from '../apps/web/src/lib/i18n-ja';
import en from '../apps/web/src/lib/i18n-en';

/** What a confirmation consists of, as shown. */
const KEYS = ['consent.body', 'auth.age', 'auth.terms', 'auth.termsLink', 'auth.privacyLink'] as const;
const LEGAL = fileURLToPath(new URL('../apps/web/src/pages/Legal.tsx', import.meta.url));

/** Each version's wording, by fingerprint. Add a line when the wording changes; never edit an old one. */
const PINNED: Record<string, string> = {
  '2026-11-24': '7ca85dba786a34ab7ae669bcd837274b2ba727305a409be9f49004f0bff3969f',
  // The free trial and photo videos disclosed on the legal page (marked under review).
  '2026-11-24b': 'db659b93146c28a402c7b64f3b3c434907abdca38a8fb539cbca4569d4f1aae2',
};

function fingerprint(): string {
  const dicts = { zh, ja, en } as Record<string, Record<string, string>>;
  const strings = Object.fromEntries(
    Object.entries(dicts).map(([lang, d]) => [lang, KEYS.map((k) => d[k] ?? null)]),
  );
  return createHash('sha256').update(JSON.stringify(strings)).update(readFileSync(LEGAL)).digest('hex');
}

describe('the consent wording version', () => {
  it('names exactly the wording on the page now', () => {
    const now = fingerprint();
    expect(
      PINNED[CONSENT_VERSION],
      `the confirmation wording or the legal page changed (fingerprint ${now}). ` +
        'Move CONSENT_VERSION (packages/contracts/src/common.ts) on and pin the new fingerprint here.',
    ).toBe(now);
  });

  it('never reuses a fingerprint for two versions', () => {
    const values = Object.values(PINNED);
    expect(new Set(values).size).toBe(values.length);
  });
});
