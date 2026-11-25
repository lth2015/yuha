/**
 * Scene landing pages (docs/GROWTH_SPEC.md, part one): each one routed,
 * public, prerendered and titled, and its button opening /create on its own
 * occasion with a source that names the scene.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SCENES, sceneCreateHref, sceneTryHref, startersFor, isStarterKey } from '../apps/web/src/lib/scenes.js';
import { applyCreateLink } from '../apps/web/src/lib/create-link.js';
import { PUBLIC_PAGES, staticPath } from '../apps/web/src/lib/seo.js';
import { pageTitleKey } from '../apps/web/src/lib/title.js';
import { prerenderPages } from '../apps/web/src/prerender.js';
import { textIn, loadAllLangs } from '../apps/web/src/lib/i18n.js';

// The dictionaries load on demand in the browser (lib/i18n.tsx); here, all of them first.
await loadAllLangs();

const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
const checkUi = readFileSync(new URL('../scripts/check-ui.mjs', import.meta.url), 'utf8');

describe('scene pages', () => {
  it('are each routed, public, prerendered, titled and visited by check:ui', () => {
    expect(SCENES.map((s) => s.slug)).toEqual(['birthday', 'travel', 'love', 'thanks', 'miss', 'memory', 'cheer']);
    for (const s of SCENES) {
      const path = `/${s.slug}`;
      expect(app).toContain(`<Route path="${path}" element={<ScenePage slug="${s.slug}" />} />`);
      expect(PUBLIC_PAGES.find((p) => p.path === path)).toEqual({ path, description: s.description, prerender: true });
      expect(pageTitleKey(path)).toBe(s.seoTitle ?? s.name);
      expect(checkUi).toContain(`path: '${path}'`);
    }
  });

  it('open /create on their own occasion, tagged with the scene', () => {
    const birthday = SCENES.find((s) => s.slug === 'birthday')!;
    expect(sceneCreateHref(birthday)).toBe('/create?gift=1&occasion=birthday&src=scene-birthday');
    expect(sceneCreateHref(birthday, 'scene.birthday.starter2')).toBe(
      '/create?gift=1&occasion=birthday&starter=scene.birthday.starter2&src=scene-birthday',
    );
    // A starter from another scene is not this scene's to pass on.
    expect(sceneCreateHref(birthday, 'scene.love.starter1')).toBe('/create?gift=1&occasion=birthday&src=scene-birthday');
    // A song about a memory is for oneself: no gift.
    expect(sceneCreateHref(SCENES.find((s) => s.slug === 'memory')!)).toBe('/create?src=scene-memory');
  });

  it('are written out with their copy, and their button pointing into /create', async () => {
    const pages = await prerenderPages(
      '<html lang="zh-CN"><title>x</title><meta name="description" content="x"/><meta property="og:title" content="x" />' +
        '<meta property="og:description" content="x" /><meta property="og:image" content="https://example.test/brand/og-card.png" />' +
        '<div id="root"><main></main></div></html>',
      'https://example.test',
    );
    const ja = pages.find((p) => p.file === staticPath('/birthday', 'ja'))!.html;
    // The MV scenes are titled for search (docs/ITERATION_EN_JA_MV.md), not by their nav name.
    expect(ja).toContain(`<title>${textIn('ja', 'scene.birthday.seoTitle')} — YUHA</title>`);
    expect(ja).toContain(textIn('ja', 'scene.birthday.title'));
    // Tagged with the page's language too, for the dashboard's totals (lib/funnel.ts).
    expect(ja).toContain('href="/create?gift=1&amp;occasion=birthday&amp;src=scene-birthday-ja"');
    // Its own card: Codex's illustration, the same in every language.
    expect(ja).toContain('<meta property="og:image" content="https://example.test/scene/og-scene-birthday.png"');
    expect(ja).toContain(`<meta property="og:title" content="${textIn('ja', 'scene.birthday.seoTitle')} — YUHA"`);
    // The other scenes are linked as files a crawler can read.
    expect(ja).toContain('href="/ja/love.html"');
  });
});

describe('the photo-MV scenes (PR #122 review)', () => {
  it('say only what stays true whichever switch is off, in the page a crawler reads', async () => {
    const pages = await prerenderPages(
      '<html lang="zh-CN"><title>x</title><meta name="description" content="x"/><meta property="og:title" content="x" />' +
        '<meta property="og:description" content="x" /><meta property="og:image" content="https://example.test/brand/og-card.png" />' +
        '<div id="root"><main></main></div></html>',
      'https://example.test',
    );
    for (const lang of ['zh', 'ja', 'en'] as const) {
      for (const slug of ['birthday', 'travel']) {
        const html = pages.find((p) => p.file === staticPath(`/${slug}`, lang))!.html;
        // The MV section and its five questions are in the HTML itself.
        expect(html).toContain(textIn(lang, 'scene.mv.title'));
        expect(html.match(/<dt>/g)).toHaveLength(5);
        // No promise of free songs or a no-sign-up trial: those are switches.
        expect(html).not.toContain(textIn(lang, 'scene.faq.free.trial'));
        expect(html).toContain(textIn(lang, 'scene.faq.free.a'));
        // A trial song is downloaded and made into a video only once kept in an account.
        expect(html).toContain(textIn(lang, 'scene.faq.formats.a'));
      }
    }
    expect(textIn('en', 'scene.faq.formats.a')).toMatch(/sign up/i);
    expect(textIn('en', 'scene.faq.free.a')).not.toMatch(/without signing up|\bget free songs\b/i);
  });

  it('tag the no-sign-up entry with the scene and language, as the create button is', () => {
    const travel = SCENES.find((s) => s.slug === 'travel')!;
    expect(sceneTryHref(travel, 'ja')).toBe('/?src=scene-travel-ja');
  });
});

describe('a link into /create', () => {
  const t = (k: string) => textIn('zh', k);
  const draft = { prompt: '', gift: false, giftOccasion: null, other: 1 } as const;
  const q = (s: string) => new URLSearchParams(s);

  it("opens on the link's occasion, even over one left in the draft", () => {
    expect(applyCreateLink({ ...draft, gift: true, giftOccasion: 'thanks' as const }, q('gift=1&occasion=birthday'), t)).toMatchObject({
      gift: true,
      giftOccasion: 'birthday',
      other: 1,
    });
    expect(applyCreateLink({ ...draft, giftOccasion: 'thanks' as const }, q('gift=1&occasion=nope'), t).giftOccasion).toBe('thanks');
    expect(applyCreateLink(draft, q('occasion=birthday'), t)).toEqual(draft);
  });

  it('adds a known opening line once, after what is written', () => {
    const line = t('scene.memory.starter1');
    expect(applyCreateLink(draft, q('starter=scene.memory.starter1'), t).prompt).toBe(line);
    expect(applyCreateLink({ ...draft, prompt: '夏天' }, q('starter=scene.memory.starter1'), t).prompt).toBe(`夏天\n${line}`);
    expect(applyCreateLink({ ...draft, prompt: line }, q('starter=scene.memory.starter1'), t).prompt).toBe(line);
  });

  it('writes nothing a link makes up', () => {
    expect(isStarterKey('price.h1')).toBe(false);
    expect(applyCreateLink(draft, q('starter=price.h1'), t).prompt).toBe('');
    expect(applyCreateLink(draft, q('starter=Hello'), t).prompt).toBe('');
  });

  it('offers opening lines for every occasion a scene or a holiday has', () => {
    expect(startersFor('birthday')).toEqual(['scene.birthday.starter1', 'scene.birthday.starter2', 'scene.birthday.starter3']);
    expect(startersFor('christmas')[0]).toBe('holiday.xmas.starter1');
    expect(startersFor('sorry')).toEqual([]);
    expect(startersFor(null)).toEqual([]);
  });
});

describe('"write one too" on a shared song', () => {
  it('opens /create on the same occasion, tagged as a share', async () => {
    const { shareCreateHref } = await import('../apps/web/src/lib/create-link.js');
    expect(shareCreateHref('birthday')).toBe('/create?gift=1&occasion=birthday&src=share-birthday');
    expect(shareCreateHref('new_year')).toBe('/create?gift=1&occasion=new_year&src=share-new-year');
    expect(shareCreateHref(null)).toBe('/create?src=share-song');
    expect(shareCreateHref(undefined)).toBe('/create?src=share-song');
  });
});
