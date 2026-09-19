import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import type { TrackView } from '@loopscene/contracts';
import { apiFetch } from '../lib/api';
import { usePlayer } from '../lib/player';
import { useSession } from '../lib/session';
import { NowPlaying } from './NowPlaying';
import { PlayerBar } from './PlayerBar';

const NAV = [
  { to: '/', label: 'Home', icon: 'icon--home', end: true },
  { to: '/create', label: 'Create', icon: 'icon--create' },
  { to: '/explore', label: 'Market', icon: 'icon--explore' },
  { to: '/library', label: 'Library', icon: 'icon--library' },
];

function SiteFooter() {
  const { runtime } = useSession();
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <div className="site-footer__brand">
          <Link to="/" className="brand">
            <span className="brand__mark" aria-hidden="true" />
            SONARE
          </Link>
          <p className="small muted" style={{ margin: 0 }}>
            Any song you can describe. An AI song studio by NetStars.
          </p>
        </div>
        <nav className="site-footer__links" aria-label="Footer">
          <Link to="/explore">Explore</Link>
          <Link to="/pricing">Plans</Link>
          <Link to="/legal/terms">Terms of Service</Link>
          <Link to="/legal/privacy">Privacy Policy</Link>
          <Link to="/legal/company">Company</Link>
          <Link to="/help/rights">Report content</Link>
        </nav>
      </div>
      <div className="site-footer__fine">
        <span>© {new Date().getFullYear()} NetStars Co., Ltd. — https://netstars.co.jp</span>
        <span>
          {runtime && !runtime.demo ? runtime.mode + ' deployment' : 'demo environment'} · songs are AI-generated
        </span>
      </div>
    </footer>
  );
}

interface NowPlayingSong extends TrackView {
  lyrics: string | null;
}

export function Layout({ children }: { children: ReactNode }) {
  const { me, entitlements, signOut, runtime } = useSession();
  const navigate = useNavigate();
  const player = usePlayer();
  const credits = entitlements?.availableUnits ?? me?.creditsAvailable ?? 0;
  const [nowPlaying, setNowPlaying] = useState<NowPlayingSong | null>(null);
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false);

  // Escape closes the full-screen player, like every music app.
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
    // Best-effort load of lyrics/like state; the overlay renders regardless.
    apiFetch<NowPlayingSong>(`/v1/tracks/${id}`)
      .then(setNowPlaying)
      .catch(() => setNowPlaying(null));
  }, [player.current?.trackId]);

  const toggleLike = useCallback(async () => {
    if (!nowPlaying || nowPlaying.likedByMe === null) return;
    try {
      const res = await apiFetch<{ liked: boolean; likeCount: number }>(
        `/v1/explore/${nowPlaying.trackId}/like`,
        { method: 'POST', body: { action: nowPlaying.likedByMe ? 'unlike' : 'like' } },
      );
      setNowPlaying({ ...nowPlaying, likedByMe: res.liked, likeCount: res.likeCount });
    } catch {
      /* optimistic UI only */
    }
  }, [nowPlaying]);

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
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <aside className="sidebar" aria-label="Primary">
        <Link to="/" className="brand">
          <span className="brand__mark" aria-hidden="true" />
          SONARE
        </Link>

        <Link
          to={me ? '/create' : '/auth?next=/create'}
          className="sidebar__cta"
          title="Create a song"
        >
          <span className="icon icon--create" aria-hidden="true" />
          <span>Create</span>
          <span className="sidebar__cta-glow" aria-hidden="true" />
        </Link>

        <nav className="sidebar__nav">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={'end' in item ? item.end : false}
              className={({ isActive }) => `sidebar__link${isActive ? ' is-active' : ''}`}
            >
              <span className={`icon ${item.icon}`} aria-hidden="true" />
              <span>{item.label}</span>
            </NavLink>
          ))}
          {me && (
            <>
              <NavLink
                to="/pricing"
                className={({ isActive }) => `sidebar__link${isActive ? ' is-active' : ''}`}
              >
                <span className="icon icon--pricing" aria-hidden="true" />
                <span>Plans</span>
              </NavLink>
              {(me.role === 'admin' || me.role === 'support') && (
                <NavLink
                  to="/admin"
                  className={({ isActive }) => `sidebar__link${isActive ? ' is-active' : ''}`}
                >
                  <span className="icon icon--admin" aria-hidden="true" />
                  <span>Console</span>
                </NavLink>
              )}
            </>
          )}
        </nav>
        <div className="sidebar__foot">
          <a className="sidebar__small" href="https://netstars.co.jp" target="_blank" rel="noreferrer">
            A NetStars product
          </a>
          <div className="sidebar__small sidebar__small--dim">
            {runtime?.demo ? 'demo environment' : `v1 · ${runtime?.mode ?? 'production'}`}
          </div>
        </div>
      </aside>

      <div className="app__main">
        <header className="topbar">
          <Link to="/" className="brand brand--mobile">
            <span className="brand__mark" aria-hidden="true" />
            SONARE
          </Link>
          <div className="topbar__spacer" />
          {me ? (
            <>
              <Link to="/pricing" className="credit-pill" title="Songs you can generate now">
                <span className="icon icon--note" aria-hidden="true" />
                {credits} credit{credits === 1 ? '' : 's'}
              </Link>
              <div className="account">
                <button type="button" className="account__btn" aria-haspopup="menu">
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
                    <strong>{me.displayName ?? 'Creator'}</strong>
                    <span className="small">{me.email}</span>
                  </div>
                  <Link role="menuitem" to="/library">
                    My songs
                  </Link>
                  <Link role="menuitem" to="/settings/billing">
                    Billing
                  </Link>
                  <Link role="menuitem" to="/settings/account">
                    Account
                  </Link>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      signOut();
                      navigate('/');
                    }}
                  >
                    Sign out
                  </button>
                </div>
              </div>
            </>
          ) : (
            <>
              <Link className="btn btn--ghost btn--sm" to="/auth">
                Sign in
              </Link>
              <Link className="btn btn--primary btn--sm" to="/auth">
                Start creating
              </Link>
            </>
          )}
        </header>

        <main id="main" className="content">
          {children}
        </main>

        <SiteFooter />
      </div>

      <nav className="tabbar" aria-label="Primary, mobile">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={'end' in item ? item.end : false}
            className={({ isActive }) => `tabbar__link${isActive ? ' is-active' : ''}`}
          >
            <span className={`icon ${item.icon}`} aria-hidden="true" />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <PlayerBar onExpand={openNowPlaying} />

      {nowPlayingOpen && (
        <NowPlaying
          title={nowPlaying?.title ?? player.current?.title ?? 'Now playing'}
          artist={nowPlaying?.artistName ?? player.current?.artistName ?? 'Creator'}
          coverSeed={nowPlaying?.coverSeed ?? player.current?.coverSeed ?? 1}
          lyrics={nowPlaying?.lyrics ?? null}
          liked={nowPlaying?.likedByMe ?? undefined}
          likeCount={nowPlaying?.likeCount ?? undefined}
          onLike={nowPlaying && nowPlaying.likedByMe !== null ? toggleLike : undefined}
          onDownload={nowPlaying && (me?.userId === nowPlaying.artistId || nowPlaying.licensedByMe) ? download : undefined}
          onClose={() => setNowPlayingOpen(false)}
        />
      )}
    </div>
  );
}
