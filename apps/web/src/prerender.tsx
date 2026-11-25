/**
 * The public pages, written out as HTML at build time (docs/SEO_SPEC.md,
 * second stage).
 *
 * The SPA answers every address with one shell: an empty #root, a Chinese
 * title, the home page's description. A crawler that runs JavaScript sees the
 * page; most language-model crawlers fetch the HTML and stop, so they saw the
 * shell, and `?lang=` changed nothing for them. Each page here is the real
 * component tree rendered to a string, in each language, with that page's own
 * title, description and addresses, written to `staticPath` (lib/seo.ts).
 *
 * A person who opens one of these files gets the same page: the bundle loads,
 * main.tsx puts the app address back in the address bar, and React draws over
 * the markup (createRoot().render replaces #root's children; nothing hydrates,
 * so a difference between this render and the browser's cannot break it).
 *
 * Rendered with no session, no API and no effects: what the page shows before
 * it has loaded anything. That is also why the operator's pages are not here
 * (lib/seo.ts, PUBLIC_PAGES), and why the pricing page has its terms and not
 * its prices, which come from the catalogue at run time.
 *
 * Built by `vite build --ssr` and run by scripts/prerender.mjs after the client
 * build; tests/prerender.test.ts checks the output.
 */
import type { ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { Layout } from './components/Layout';
import { I18nProvider, loadAllLangs, textIn } from './lib/i18n';
import { PlayerProvider } from './lib/player';
import { PUBLIC_PAGES, SEO_LANGS, headFor, staticPath, type SeoLang } from './lib/seo';
import { pageDocument } from './lib/static-page';
import { sceneBySlug } from './lib/scenes';
import { SessionProvider } from './lib/session';
import { pageTitleKey } from './lib/title';
import Home from './pages/Home';
import { LegalIndex } from './pages/Legal';
import Pricing from './pages/Pricing';
import Rights from './pages/Rights';
import ScenePage from './pages/Scene';

const COMPONENTS: Record<string, () => ReactElement> = {
  '/': () => <Home />,
  '/pricing': () => <Pricing />,
  '/help/rights': () => <Rights />,
  '/legal': () => <LegalIndex />,
  '/birthday': () => <ScenePage slug="birthday" />,
  '/love': () => <ScenePage slug="love" />,
  '/thanks': () => <ScenePage slug="thanks" />,
  '/miss': () => <ScenePage slug="miss" />,
  '/memory': () => <ScenePage slug="memory" />,
  '/cheer': () => <ScenePage slug="cheer" />,
};

function renderPage(path: string, lang: SeoLang): string {
  const Page = COMPONENTS[path];
  if (!Page) throw new Error(`prerender: ${path} is marked prerender in lib/seo.ts but has no component here`);
  return renderToString(
    <StaticRouter location={path}>
      <I18nProvider initialLang={lang}>
        <SessionProvider>
          <PlayerProvider>
            <Layout>
              <Page />
            </Layout>
          </PlayerProvider>
        </SessionProvider>
      </I18nProvider>
    </StaticRouter>,
  );
}

export async function prerenderPages(template: string, origin: string): Promise<Array<{ file: string; html: string }>> {
  // Every language's dictionary, before any page is written in it.
  await loadAllLangs();
  return PUBLIC_PAGES.filter((p) => p.prerender).flatMap((page) =>
    SEO_LANGS.map((lang) => {
      const head = headFor(page.path, lang, origin);
      const t = (key: string) => textIn(lang, key);
      const key = pageTitleKey(page.path);
      const html = pageDocument(template, {
        lang,
        head,
        title: key === null ? `YUHA · ${t('seo.title.home')}` : `${t(key)} — YUHA`,
        description: t(head.description ?? 'seo.desc.home'),
        rendered: renderPage(page.path, lang),
        // A scene page's own card (Codex, PR #96): text-free, so one image serves all three languages.
        ...(sceneBySlug(page.path.slice(1)) ? { ogImage: new URL(`/scene/og-scene-${page.path.slice(1)}.png`, origin).toString() } : {}),
      });
      return { file: staticPath(page.path, lang), html };
    }),
  );
}
