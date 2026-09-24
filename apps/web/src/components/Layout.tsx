import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import type { TrackView } from '@yuha/contracts';
import { apiFetch } from '../lib/api';
import { usePlayer } from '../lib/player';
import { useI18n } from '../lib/i18n';
import { useSession } from '../lib/session';
import { BrandLogo, PetalMark } from './Brand';
import { LightField } from './LightField';
import { LANGS } from '../lib/i18n';
import { NowPlaying } from './NowPlaying';
import { PlayerBar } from './PlayerBar';

/**
 * YUHA app shell — top navigation per the acceptance spec: 88px desktop / 72px
 * mobile, 创作 · 我的作品 · 市场, account entry on the right carrying credits.
 * The nav and player bar use the liquid-glass treatment: translucent surfaces
 * that pick up what scrolls beneath them (component-level glass; the page
 * itself stays the calm warm-white canvas the spec requires).
 */
interface NowPlayingSong extends TrackView {
  lyrics: string | null;
}



function SiteFooter() {
  const { t } = useI18n();
  const { runtime } = useSession();
  return (
    <footer className="site-foot">
      <span className="site-foot__brand">
        <BrandLogo width={104} />
      </span>
      <span className="site-foot__links">
        <Link to="/legal/terms">{t('footer.terms')}</Link>
        <Link to="/legal/privacy">{t('footer.privacy')}</Link>
        <Link to="/legal/company">{t('footer.company')}</Link>
        <Link to="/help/rights">{t('footer.rights')}</Link>
        <a href="https://netstars.co.jp" target="_blank" rel="noreferrer">
          NetStars
        </a>
      </span>
      <span className="site-foot__fine">
        {t('footer.made', { year: new Date().getFullYear() })} · {t('footer.slogan')}
        {runtime && !runtime.demo ? ` · ${runtime.mode}` : ''}
      </span>
    </footer>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { t, lang, setLang } = useI18n();
  const { me, entitlements, signOut, runtime } = useSession();
  const navigate = useNavigate();
  const player = usePlayer();
  const credits = entitlements?.availableUnits ?? me?.creditsAvailable ?? 0;
  const [nowPlaying, setNowPlaying] = useState<NowPlayingSong | null>(null);
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!nowPlayingOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setNowPlayingOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nowPlayingOpen]);

  const openNowPlaying = useCallback(() => {
    setNowPlayingOpen(true);
    const id = player.current?.trackId;
    if (!id) return;
    apiFetch<NowPlayingSong>(`/v1/tracks/${id}`)
      .then(setNowPlaying)
      .catch(() => setNowPlaying(null));
  }, [player.current?.trackId]);


  const download = useCallback(async () => {
    if (!nowPlaying) return;
    try {
      const res = await apiFetch<{ downloadUrl: string }>(`/v1/tracks/${nowPlaying.trackId}/exports`, {
        method: 'POST',
        body: { clipStartSeconds: 0, clipDurationSeconds: Math.round(nowPlaying.durationSeconds), fadeOut: false },
      });
      window.location.href = res.downloadUrl;
    } catch {
      /* surfaced by the song page */
    }
  }, [nowPlaying]);

  return (
    <>
      <LightField />
      <div className="app">
      <a className="skip-link" href="#main">
        {t('nav.skip')}
      </a>

      <header className="topnav">
        <div className="topnav__inner">
          <Link to="/" className="topnav__home" aria-label="YUHA 创作首页">
            <BrandLogo width={128} />
          </Link>

          <nav className="topnav__nav" aria-label={t('nav.skip').replace('跳到内容', '主导航')}>
            {[
              { to: '/', key: 'nav.create', end: true },
              { to: '/library', key: 'nav.library', end: false },
            ].map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) => `topnav__link${isActive ? ' is-active' : ''}`}
              >
                {t(item.key)}
              </NavLink>
            ))}
          </nav>

          <div className="topnav__account">
            <div className="lang-switch" role="group" aria-label={t('a11y.lang')}>
              {LANGS.map((l) => (
                <button
                  key={l.code}
                  type="button"
                  className={`lang-switch__btn${lang === l.code ? ' is-active' : ''}`}
                  aria-pressed={lang === l.code}
                  onClick={() => setLang(l.code)}
                >
                  {l.label}
                </button>
              ))}
            </div>
            {me ? (
              <>
                <Link to="/pricing" className="credit-pill">
                  {t('nav.credits', { n: credits })}
                </Link>
                <div className={`account${menuOpen ? ' is-open' : ''}`}>
                  <button
                    type="button"
                    className="account__btn"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    onClick={() => setMenuOpen((v) => !v)}
                  >
                    {me.avatarUrl ? (
                      <img className="account__avatar" src={me.avatarUrl} alt="" referrerPolicy="no-referrer" />
                    ) : (
                      <span className="account__initial" aria-hidden="true">
                        {(me.displayName ?? me.email)[0]!.toUpperCase()}
                      </span>
                    )}
                  </button>
                  <div className="account__menu" role="menu">
                    <div className="account__who">
                      <strong>{me.displayName ?? t('card.creator')}</strong>
                      <span className="small">{me.email}</span>
                    </div>
                    <Link role="menuitem" to="/library" onClick={() => setMenuOpen(false)}>
                      {t('account.mySongs')}
                    </Link>
                    <Link role="menuitem" to="/settings/billing" onClick={() => setMenuOpen(false)}>
                      {t('account.billing')}
                    </Link>
                    <Link role="menuitem" to="/settings/account" onClick={() => setMenuOpen(false)}>
                      {t('account.settings')}
                    </Link>
                    {(me.role === 'admin' || me.role === 'support') && (
                      <Link role="menuitem" to="/admin" onClick={() => setMenuOpen(false)}>
                        {t('account.console')}
                      </Link>
                    )}
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        signOut();
                        navigate('/');
                      }}
                    >
                      {t('account.signOut')}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <>
                <Link className="btn btn--ghost btn--sm" to="/auth">
                  {t('nav.signin')}
                </Link>
                <Link className="btn btn--primary btn--sm" to="/auth">
                  {t('nav.start')}
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      <main id="main" className="content">
        {children}
      </main>

      <SiteFooter />

      <nav className="tabbar" aria-label={t('nav.skip')}>
        {[
          { to: '/', key: 'nav.create', end: true },
          { to: '/library', key: 'nav.library', end: false },
        ].map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => `tabbar__link${isActive ? ' is-active' : ''}`}
          >
            {t(item.key)}
          </NavLink>
        ))}
      </nav>

      <PlayerBar onExpand={openNowPlaying} />

      {nowPlayingOpen && (
        <NowPlaying
          title={nowPlaying?.title ?? player.current?.title ?? '正在播放'}
          artist={nowPlaying?.artistName ?? player.current?.artistName ?? '创作者'}
          coverSeed={nowPlaying?.coverSeed ?? player.current?.coverSeed ?? 1}
          lyrics={nowPlaying?.lyrics ?? null}
          timings={nowPlaying?.lyricTimings ?? null}
          onDownload={
            nowPlaying && (me?.userId === nowPlaying.artistId || nowPlaying.licensedByMe) ? download : undefined
          }
          onClose={() => setNowPlayingOpen(false)}
        />
      )}

      {/* Brand moment: the drifting petal only shows while music plays. */}
      {player.status === 'playing' && (
        <span className="app__drift-petal" aria-hidden="true">
          <PetalMark size={26} shadow={false} rotate={-12} title="YUHA" />
        </span>
      )}
      </div>
    </>
  );
}
