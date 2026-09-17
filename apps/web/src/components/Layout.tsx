import type { ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useSession } from '../lib/session';
import { PlayerBar } from './PlayerBar';

const NAV = [
  { to: '/', label: 'Home', icon: 'icon--home', end: true },
  { to: '/create', label: 'Create', icon: 'icon--create' },
  { to: '/explore', label: 'Explore', icon: 'icon--explore' },
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

export function Layout({ children }: { children: ReactNode }) {
  const { me, entitlements, signOut, runtime } = useSession();
  const navigate = useNavigate();
  const credits = entitlements?.availableUnits ?? me?.creditsAvailable ?? 0;

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

      <PlayerBar />
    </div>
  );
}
