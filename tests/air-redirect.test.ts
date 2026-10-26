/**
 * yuha.studio/air — the address people type and share links point at.
 *
 * The air page is a static file at /air/index.html beside the web app. The
 * edge answers a path with no object behind it (`/air`, and `/air/`, since S3
 * has no directory index) with the web app's index.html, so the web app is
 * what sees those two and has to hand over. The target must be the file
 * itself: sending `/air/` back to `/air/` would loop forever.
 *
 * No database: a pure function.
 */
import { describe, expect, it } from 'vitest';
import { AIR_PAGE, airRedirect } from '../apps/web/src/lib/air-redirect.js';

describe('handing /air over to the air page', () => {
  it('sends /air and /air/ to the file itself', () => {
    expect(airRedirect('/air', '')).toBe('/air/index.html');
    expect(airRedirect('/air/', '')).toBe('/air/index.html');
  });

  it('keeps the shared sketch in the fragment', () => {
    expect(airRedirect('/air', '#AQIDBA')).toBe('/air/index.html#AQIDBA');
    expect(airRedirect('/air/', '#observe')).toBe('/air/index.html#observe');
  });

  it('never sends anyone to a path it would itself redirect again', () => {
    expect(airRedirect(AIR_PAGE, '')).toBeNull();
    const target = airRedirect('/air', '#x')!;
    expect(airRedirect(new URL(target, 'https://yuha.studio').pathname, '')).toBeNull();
  });

  it('leaves every other page to the web app', () => {
    for (const path of ['/', '/create', '/airport', '/air/assets/x.js', '/song/air', '/AIR']) {
      expect(airRedirect(path, '')).toBeNull();
    }
  });
});
