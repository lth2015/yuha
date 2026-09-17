import type { ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useSession } from '../lib/session';
import { PlayerBar } from './PlayerBar';

/**
 * App shell: sidebar navigation (desktop), bottom tab bar (mobile), top bar
 * with the credit pill and account menu, and the persistent player bar.
 *
 * The mode banner is part of the document flow, not a dismissible toast — a
 * demo deployment must say so continuously, and a banner users can close is a
 * banner users stop seeing.
 */
function ModeBanner() {
  const { runtime } = useSession();
  if (!runtime) return null;

  if (runtime.demo) {
    return (
      <div className="mode-banner" role="status">
        <strong>Demo mode</strong> — audio is synthesised for pipeline testing, payments are simulated. No
        real charges occur and no commercial licence is granted.
      </div>
    );
  }
  if (!runtime.features.commercialDeliveryEnabled) {
    return (
      <div className="mode-banner" role="status">
        <strong>Preview build</strong> — no commercial licence is in force yet. Songs are for evaluation use.
      </div>
    );
  }
  return null;
}

const NAV = [
  { to: '/', label: 'Home', icon: 'icon--home', end: true },
  { to: '/create', label: 'Create', icon: 'icon--create' },
  { to: '/explore', label: 'Explore', icon: 'icon--explore' },
  { to: '/library', label: 'Library', icon: 'icon--library' },
];

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
          <Link to="/help/rights" className="sidebar__small">
            Report a rights issue
          </Link>
          <div className="sidebar__small sidebar__small--dim">
            {runtime ? `${runtime.mode} · ${runtime.adapters.music}` : ''}
          </div>
        </div>
      </aside>

      <div className="app__main">
        <ModeBanner />
        <header className="topbar">
          <Link to="/" className="brand brand--mobile">
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
