import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import type { TrackView } from '@yuha/contracts';
import { apiFetch } from '../lib/api';
import { usePlayer } from '../lib/player';
import { useI18n } from '../lib/i18n';
import { useSession } from '../lib/session';
import { useDismiss } from '../lib/dismiss';
import { BrandLogo, PetalMark } from './Brand';
import { ErrorBoundary } from './ErrorBoundary';
import { LightField } from './LightField';
import { LANGS } from '../lib/i18n';
import { createInFlightGuard, PENDING_AFTER_MS } from '../lib/in-flight';
import { NowPlaying } from './NowPlaying';
import { PlayerBar } from './PlayerBar';
import { PageTitleContext, pageTitleKey } from '../lib/title';

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



/**
 * A signed-in person's name, never blank.
 *
 * This was `me.displayName ?? me.email`, and `??` only falls through on
 * null/undefined. Google's `name` claim is stored when it is any string, and
 * `COALESCE` in the upsert keeps an empty one, so a blank name reached the
 * header — where `(…)[0]!.toUpperCase()` threw on `""[0]`. The header renders
 * outside the ErrorBoundary, so that one throw unmounted the whole app: a white
 * screen on every page, for that account, for good. Reproduced by blanking a
 * dev user's name, not reasoned about.
 */
function accountName(me: { displayName: string | null; email: string }): string {
  return me.displayName?.trim() || me.email;
}

function SiteFooter() {
  const { t } = useI18n();
  const { runtime } = useSession();
  return (
    <footer className="site-foot">
      <span className="site-foot__brand">
        <BrandLogo width={104} />
      </span>
      {/*
        Two links, not five. A row ending in 「特定商取引法相关标示」 is a
        statutory label sitting in the middle of a product, and nobody reads
        it there.

        Reporting content stays, because that is something a visitor may
        actually need and needs to find fast. The rest — terms, privacy,
        company, 特商法 — collapse behind one quiet link to /legal, which
        lists them.
        
        Quiet, deliberately, and not hidden: 特商法 requires the disclosure to
        be accessible, and the purchase path keeps its own direct link to it
        from Checkout, which is the placement that actually matters.
      */}
      <span className="site-foot__links">
        <Link to="/help/rights">{t('footer.rights')}</Link>
        <Link to="/legal">{t('footer.legal')}</Link>
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
  const location = useLocation();
  const player = usePlayer();
  const credits = entitlements?.availableUnits ?? me?.creditsAvailable ?? 0;
  const [nowPlaying, setNowPlaying] = useState<NowPlayingSong | null>(null);
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [titleOverride, setTitleOverride] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<unknown>(null);
  /*
   * Two halves of the same fix. `downloading` is what the reader sees — the
   * label changes and the button goes disabled — and the ref is what actually
   * decides, because React state does not apply until the next render and two
   * presses inside one frame would both read it as false.
   */
  const [downloading, setDownloading] = useState(false);
  const downloadGuard = useRef(createInFlightGuard());

  // See lib/title.ts. Written here, once, so a page's override and the route's
  // default can never race each other on a language switch.
  useEffect(() => {
    const key = pageTitleKey(location.pathname);
    document.title =
      key === null ? `YUHA — ${t('footer.slogan')}` : `${titleOverride ?? t(key)} — YUHA`;
  }, [location.pathname, lang, t, titleOverride]);

  /*
   * Now Playing is a full-screen view, so people reach for the browser's Back
   * button (or the phone's back gesture) to leave it. That used to leave the
   * page entirely. Opening it now pushes a history entry; Back pops it and
   * closes the view, and closing it any other way (Esc, the collapse button)
   * goes back through that same entry so history stays balanced.
   */
  useEffect(() => {
    if (!nowPlayingOpen) return;
    const onPop = () => setNowPlayingOpen(false);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [nowPlayingOpen]);

  const closeNowPlaying = useCallback(() => {
    if ((window.history.state as { yuhaNowPlaying?: boolean } | null)?.yuhaNowPlaying) window.history.back();
    else setNowPlayingOpen(false);
  }, []);

  const openNowPlaying = useCallback(() => {
    window.history.pushState({ ...(window.history.state ?? {}), yuhaNowPlaying: true }, '');
    setNowPlayingOpen(true);
  }, []);

  /*
   * The song shown, kept in step with the song playing.
   *
   * This fetch used to live inside `openNowPlaying`, so it ran once, when the
   * view was opened, and nothing ever re-ran it. Let a queue advance —
   * `player.onEnded` starts the next track — and the full-screen view kept
   * the previous song's title, lyrics and timings: the karaoke display
   * scrolled the wrong words against the new audio. Two opens in quick
   * succession could also let the first response paint over the second,
   * which the cancel flag now prevents.
   */
  const playingId = player.current?.trackId;
  useEffect(() => {
    if (!nowPlayingOpen || !playingId) return;
    let cancelled = false;
    apiFetch<NowPlayingSong>(`/v1/tracks/${playingId}`)
      .then((s) => !cancelled && setNowPlaying(s))
      .catch(() => !cancelled && setNowPlaying(null));
    return () => {
      cancelled = true;
    };
  }, [nowPlayingOpen, playingId]);

  /*
   * The account menu closes on an outside click, on Escape, and on a route
   * change. It used to be toggled by the avatar and by nothing else: no
   * outside-click handler, no Escape, no reset on navigation — so clicking
   * the avatar and then anywhere else left the panel floating over the page,
   * still reading `aria-expanded="true"`, until you found the avatar again.
   * `ShareMenu` has done this correctly since it was written; the shared
   * `useDismiss` is now the single copy of it.
   */
  const accountRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useDismiss(accountRef, menuOpen, closeMenu);

  useEffect(() => setMenuOpen(false), [location.pathname]);


  /*
   * Report ten seconds heard.
   *
   * The player has detected this moment since it was written and exposed
   * `onTenSeconds` for somebody to listen; nobody ever did, so the activation
   * metric queried an event that was never written. Subscribed here rather
   * than inside the provider so the player stays a player and does not learn
   * about the API.
   *
   * Failures are swallowed: a telemetry write must never interrupt playback,
   * and the person listening has no use for the news that counting failed.
   */
  useEffect(
    () =>
      player.onTenSeconds((trackId) => {
        void apiFetch('/v1/previews', { method: 'POST', body: { trackId } }).catch(() => undefined);
      }),
    [player],
  );

  const download = useCallback(async () => {
    if (!nowPlaying) return;
    if (!downloadGuard.current.begin()) return;
    /*
     * Deferred, not immediate. The export answers in about 12ms against a
     * local API, so showing it at once made the label swap and swap back
     * inside a frame — a flicker reads as a glitch and is worse than
     * silence. The guard above is already blocking the second press; this
     * only decides when to say so.
     */
    const pendingTimer = window.setTimeout(() => setDownloading(true), PENDING_AFTER_MS);
    setDownloadError(null);
    try {
      const res = await apiFetch<{ downloadUrl: string }>(`/v1/tracks/${nowPlaying.trackId}/exports`, {
        method: 'POST',
        body: { clipStartSeconds: 0, clipDurationSeconds: Math.round(nowPlaying.durationSeconds), fadeOut: false },
      });
      window.location.href = res.downloadUrl;
    } catch (err) {
      /*
       * The old comment here said "surfaced by the song page", which was
       * wrong about where the user is: this runs inside a full-screen overlay
       * covering that page, so a failed export showed them nothing at all.
       */
      setDownloadError(err);
    } finally {
      // Always, including after a failure: one network blip must not disable
      // download for the rest of the session.
      window.clearTimeout(pendingTimer);
      downloadGuard.current.end();
      setDownloading(false);
    }
  }, [nowPlaying]);

  return (
    <>
      <LightField />
      <div className="app">
      <a className="skip-link" href="#main">
        {t('nav.skip')}
      </a>

      {/*
       * Why the header and the tab bar have no boundary of their own, while the
       * footer and the player below do.
       *
       * An error boundary catches what its children render. The header and the
       * tab bar are inline JSX in this component, so anything they compute runs
       * during Layout's own render — before a boundary written here exists.
       * Wrapping them looks like protection and is none: with such a wrapper in
       * place, throwing from the header still produced a blank page, and React
       * said why — "the above error occurred in the Layout component".
       *
       * The backstop is one level up, around Layout in App.tsx. Giving these two
       * regions real isolation means extracting them into components, which is
       * worth doing and is not this change.
       */}
      <header className="topnav">
        <div className="topnav__inner">
          <Link to="/" className="topnav__home" aria-label={t('nav.homeAria')}>
            <BrandLogo width={128} />
          </Link>

          <nav className="topnav__nav" aria-label={t('nav.mainAria')}>
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
                <div ref={accountRef} className={`account${menuOpen ? ' is-open' : ''}`}>
                  <button
                    type="button"
                    className="account__btn"
                    // The button holds only an avatar (alt="") or an
                    // aria-hidden initial, so it had no name at all: every
                    // signed-in page failed axe's button-name, and a screen
                    // reader announced an unlabelled "menu button". Who is
                    // signed in is exactly what this control is about.
                    aria-label={t('account.menuAria', { name: accountName(me) })}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    onClick={() => setMenuOpen((v) => !v)}
                  >
                    {me.avatarUrl ? (
                      <img className="account__avatar" src={me.avatarUrl} alt="" referrerPolicy="no-referrer" />
                    ) : (
                      <span className="account__initial" aria-hidden="true">
                        {(accountName(me)[0] ?? '?').toUpperCase()}
                      </span>
                    )}
                  </button>
                  <div className="account__menu" role="menu">
                    <div className="account__who">
                      <strong>{me.displayName?.trim() || t('card.creator')}</strong>
                      <span className="small">{me.email}</span>
                      {/* The nav pill is hidden on narrow phones; the count lives here too. */}
                      <span className="small account__credits">{t('nav.credits', { n: credits })}</span>
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
        {/* Keyed on the path so navigating away clears a crashed route. A
            boundary that stays broken until a full reload turns one bad page
            into a bad session. */}
        <PageTitleContext.Provider value={setTitleOverride}>
          <ErrorBoundary key={location.pathname}>{children}</ErrorBoundary>
        </PageTitleContext.Provider>
      </main>

      <ErrorBoundary key={`chrome-foot-${location.pathname}`} fallback={null}>
        <SiteFooter />
      </ErrorBoundary>

      {/* Was labelled with nav.skip, so the mobile navigation landmark was
          announced as "skip to content". Only one of this and .topnav__nav is
          ever displayed (styles.css), so they share the main-navigation name. */}
      <nav className="tabbar" aria-label={t('nav.mainAria')}>
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

      {/* These two are real components, so their render happens inside the
          boundary and it works. */}
      <ErrorBoundary key={`chrome-player-${location.pathname}`} fallback={null}>
      <PlayerBar onExpand={openNowPlaying} />

      {nowPlayingOpen && (
        <NowPlaying
          title={nowPlaying?.title ?? player.current?.title ?? t('player.untitled')}
          artist={nowPlaying?.artistName ?? player.current?.artistName ?? t('player.unknownArtist')}
          coverSeed={nowPlaying?.coverSeed ?? player.current?.coverSeed ?? 1}
          styles={nowPlaying?.styles ?? player.current?.styles}
          lyrics={nowPlaying?.lyrics ?? null}
          timings={nowPlaying?.lyricTimings ?? null}
          onDownload={
            nowPlaying && (me?.userId === nowPlaying.artistId || nowPlaying.licensedByMe) ? download : undefined
          }
          downloading={downloading}
          downloadError={downloadError}
          onClose={closeNowPlaying}
        />
      )}
      </ErrorBoundary>

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
