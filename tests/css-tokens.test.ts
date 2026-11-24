/**
 * Every custom property the stylesheet reads is one it defines.
 *
 * A `var(--x)` with no definition and no fallback is not an error anywhere:
 * the declaration is simply dropped. `.studio__fork` asked for
 * `padding-top: var(--s5)` on a spacing scale that skips from --s4 to --s6,
 * so the lyrics fork's label sat on its hairline for a month while the rule
 * read as if it had room. Properties set from script at run time
 * (`style={{ '--progress': … }}`) carry a fallback and are allowed.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../apps/web/src/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('styles.css custom properties', () => {
  it('reads none it does not define, unless it gives a fallback', () => {
    const defined = new Set([...css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]));
    const undefinedReads = [...css.matchAll(/var\((--[a-zA-Z0-9-]+)\s*([,)])/g)]
      .filter((m) => m[2] === ')' && !defined.has(m[1]!))
      .map((m) => m[1]);
    expect(undefinedReads.length + defined.size).toBeGreaterThan(20); // the patterns found the file's variables at all
    expect([...new Set(undefinedReads)]).toEqual([]);
  });
});
