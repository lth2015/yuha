/**
 * The only thing standing between a query string and where the browser goes.
 *
 * `next=` and `from=` are written by whoever composes the link, so every path
 * that reaches `navigate()` from a URL passes through here first. It is a pure
 * function and had no test — while the two pages that call it were reviewed
 * line by line, the rule they depend on was not pinned anywhere.
 *
 * The cases below are the ones that bite, not a sample: a protocol-relative
 * `//host` leaves the site, and browsers normalise `\` to `/`, so `/\host` is
 * the same attack wearing a backslash. Both are refused by prefix rather than
 * by parsing, which is why they are worth writing down — the rule is easy to
 * "simplify" into `value.startsWith('/')` by someone who has not met them.
 */
import { describe, expect, it } from 'vitest';
import { safeInternalPath } from '../apps/web/src/lib/paths.js';

describe('safeInternalPath', () => {
  it('passes an in-app path through unchanged, query and hash included', () => {
    expect(safeInternalPath('/create')).toBe('/create');
    expect(safeInternalPath('/settings/billing?tab=history')).toBe('/settings/billing?tab=history');
    expect(safeInternalPath('/song/abc#lyrics')).toBe('/song/abc#lyrics');
  });

  it('refuses anything that can leave the site', () => {
    // Protocol-relative: the browser reads this as https://evil.example.
    expect(safeInternalPath('//evil.example')).toBeNull();
    expect(safeInternalPath('///evil.example')).toBeNull();
    // Chrome normalises backslashes to forward slashes, so this is the same
    // thing and a `startsWith('//')` check alone would let it through.
    expect(safeInternalPath('/\\evil.example')).toBeNull();
    expect(safeInternalPath('/\\/evil.example')).toBeNull();
    expect(safeInternalPath('https://evil.example')).toBeNull();
    expect(safeInternalPath('javascript:alert(1)')).toBeNull();
    // Not anchored at the root, so it resolves against the current directory.
    expect(safeInternalPath('create')).toBeNull();
  });

  it('treats an absent or empty value as no destination', () => {
    expect(safeInternalPath(null)).toBeNull();
    expect(safeInternalPath(undefined)).toBeNull();
    expect(safeInternalPath('')).toBeNull();
  });

  it('allows a path that merely looks like a URL, because it is one of ours', () => {
    // `/https://…` is an in-app path with an odd name, not a redirect. Pinned
    // so the rule stays "may this leave the site", not "does it look scary".
    expect(safeInternalPath('/https://evil.example')).toBe('/https://evil.example');
  });
});
