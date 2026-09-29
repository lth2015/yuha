import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Loading } from './components/common';
import { PlayerProvider } from './lib/player';
import { I18nProvider } from './lib/i18n';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SessionProvider, useSession } from './lib/session';
import Account from './pages/Account';
import Admin from './pages/Admin';
import Auth from './pages/Auth';
import Billing from './pages/Billing';
import { CheckoutComplete, CheckoutConfirm, CheckoutSimulate } from './pages/Checkout';
import Create from './pages/Create';
import Export from './pages/Export';
import GoogleCallback from './pages/GoogleCallback';
import MfaChallenge from './pages/MfaChallenge';
import Home from './pages/Home';
import { Company, Privacy, Terms } from './pages/Legal';
import { Tokushoho } from './pages/Tokushoho';
import Library from './pages/Library';
import NotFound from './pages/NotFound';
import Pricing from './pages/Pricing';
import Project from './pages/Project';
import Rights from './pages/Rights';
import SongDetail from './pages/SongDetail';

/** Sends unauthenticated visitors to sign-in, preserving where they were going. */
function RequireAuth({ children, roles }: { children: ReactNode; roles?: string[] }) {
  const { me, loading } = useSession();
  const location = useLocation();

  if (loading) return <Loading />;
  if (!me) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/auth?next=${next}`} replace />;
  }
  if (roles && !roles.includes(me.role)) {
    return (
      <div className="alert alert--error">
        <div className="alert__title">You do not have access to this screen</div>
        <div className="small">Please contact an administrator.</div>
      </div>
    );
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
      <I18nProvider>
      <SessionProvider>
        <PlayerProvider>
          {/* Above Layout, because a boundary only catches what its *children*
           *  render. Every boundary in this app used to sit inside Layout's own
           *  JSX, so anything Layout computed inline — the header's account
           *  initial, say — threw while Layout itself was rendering, before any
           *  of them existed. React said so plainly: "The above error occurred
           *  in the <Layout> component", and the tree unmounted to a blank page.
           *  Verified by throwing from the header on purpose, with the
           *  boundaries inside: still a white screen.
           *
           *  Inside I18nProvider so the panel can speak the reader's language. */}
          <ErrorBoundary>
          <Layout>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/auth" element={<Auth />} />
              <Route path="/auth/google/callback" element={<GoogleCallback />} />
              <Route path="/auth/mfa" element={<MfaChallenge />} />
              <Route path="/song/:id" element={<SongDetail />} />
              <Route path="/pricing" element={<Pricing />} />

              <Route
                path="/create"
                element={
                  <RequireAuth>
                    <Create />
                  </RequireAuth>
                }
              />
              <Route
                path="/projects/:id"
                element={
                  <RequireAuth>
                    <Project />
                  </RequireAuth>
                }
              />
              <Route
                path="/tracks/:id/export"
                element={
                  <RequireAuth>
                    <Export />
                  </RequireAuth>
                }
              />
              <Route
                path="/tracks/:id/license"
                element={
                  <RequireAuth>
                    <Export />
                  </RequireAuth>
                }
              />
              <Route
                path="/library"
                element={
                  <RequireAuth>
                    <Library />
                  </RequireAuth>
                }
              />

              <Route
                path="/checkout/confirm"
                element={
                  <RequireAuth>
                    <CheckoutConfirm />
                  </RequireAuth>
                }
              />
              <Route
                path="/checkout/complete"
                element={
                  <RequireAuth>
                    <CheckoutComplete />
                  </RequireAuth>
                }
              />
              {/* Demo only; the page itself refuses to render outside demo mode. */}
              <Route
                path="/checkout/simulate"
                element={
                  <RequireAuth>
                    <CheckoutSimulate />
                  </RequireAuth>
                }
              />

              <Route
                path="/settings/billing"
                element={
                  <RequireAuth>
                    <Billing />
                  </RequireAuth>
                }
              />
              <Route
                path="/settings/account"
                element={
                  <RequireAuth>
                    <Account />
                  </RequireAuth>
                }
              />

              <Route
                path="/admin"
                element={
                  <RequireAuth roles={['admin', 'support']}>
                    <Admin />
                  </RequireAuth>
                }
              />

              {/* Public on purpose: a rights holder must not need an account. */}
              <Route path="/help/rights" element={<Rights />} />
              <Route path="/legal/terms" element={<Terms />} />
              <Route path="/legal/privacy" element={<Privacy />} />
              <Route path="/legal/company" element={<Company />} />
              <Route path="/legal/tokushoho" element={<Tokushoho />} />

              <Route path="*" element={<NotFound />} />
            </Routes>
          </Layout>
          </ErrorBoundary>
        </PlayerProvider>
      </SessionProvider>
      </I18nProvider>
    </BrowserRouter>
  );
}
