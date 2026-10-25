import { useEffect } from 'react';
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { BrandLogo } from '../components/Brand';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { I18nProvider, LANGS, useI18n } from '../lib/i18n';
import { PlayerProvider } from '../lib/player';
import { SessionProvider } from '../lib/session';
import Home from '../pages/Home';
import { Company, LegalIndex, Privacy, Terms } from '../pages/Legal';
import { Tokushoho } from '../pages/Tokushoho';
import '@fontsource-variable/noto-sans-sc';
import '@fontsource-variable/noto-sans-jp';
import './ios.css';

function PreviewStatus({ kind }: { kind: 'auth' | 'library' | 'unavailable' }) {
  const { t } = useI18n();
  return <section className="ios-status glass">
    <h1>{t(`ios.${kind}.title`)}</h1>
    <p>{t(`ios.${kind}.body`)}</p>
    <Link className="btn btn--primary" to="/">{t('notFound.back')}</Link>
  </section>;
}

function Shell() {
  const { t, lang, setLang } = useI18n();
  const location = useLocation();
  useEffect(() => {
    document.documentElement.dataset.platform = 'ios';
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', 'light dark');
    return () => { delete document.documentElement.dataset.platform; };
  }, []);
  useEffect(() => {
    window.scrollTo(0, 0);
    document.getElementById('main')?.focus({ preventScroll: true });
    document.title = `YUHA · ${t('ios.preview')}`;
  }, [location.pathname, t]);
  return <div className="ios-app">
    <a className="skip-link" href="#main">{t('nav.skip')}</a>
    <header className="ios-header">
      <Link to="/" aria-label="YUHA"><BrandLogo width={112} /></Link>
      <div className="lang-switch" role="group" aria-label={t('a11y.lang')}>
        {LANGS.map((l) => <button key={l.code} className="lang-switch__btn" type="button"
          aria-pressed={l.code === lang} onClick={() => setLang(l.code)}>{l.label}</button>)}
      </div>
    </header>
    <p className="ios-preview-note">{t('ios.preview')}</p>
    <main id="main" className="ios-main" tabIndex={-1}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/auth" element={<PreviewStatus kind="auth" />} />
        <Route path="/library" element={<PreviewStatus kind="library" />} />
        <Route path="/legal" element={<LegalIndex />} />
        <Route path="/legal/terms" element={<Terms />} />
        <Route path="/legal/privacy" element={<Privacy />} />
        <Route path="/legal/company" element={<Company />} />
        <Route path="/legal/tokushoho" element={<Tokushoho />} />
        <Route path="*" element={<PreviewStatus kind="unavailable" />} />
      </Routes>
      <footer className="ios-footer"><Link to="/legal">{t('footer.legal')}</Link></footer>
    </main>
    <nav className="ios-tabs" aria-label={t('nav.mainAria')}>
      {[['/', 'nav.create'], ['/library', 'nav.library'], ['/auth', 'nav.signin']].map(([to, key]) =>
        <NavLink key={to} to={to!} end={to === '/'}>{t(key!)}</NavLink>)}
    </nav>
  </div>;
}

/** PR-A consumer-only route tree. Web auth, admin and checkout are never mounted.
 * PR-B replaces the explicit authentication/library placeholders; PR-C supplies
 * the native player. The shared homepage can keep drafts without sending jobs.
 */
export default function IosApp() {
  return <BrowserRouter><I18nProvider><ErrorBoundary><SessionProvider><PlayerProvider>
    <Shell />
  </PlayerProvider></SessionProvider></ErrorBoundary></I18nProvider></BrowserRouter>;
}
