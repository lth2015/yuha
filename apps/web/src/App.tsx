import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Loading } from './components/common';
import { ConsentGate } from './components/ConsentGate';
import { PlayerProvider } from './lib/player';
import { I18nProvider } from './lib/i18n';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SessionProvider, useSession } from './lib/session';
import Home from './pages/Home';
import NotFound from './pages/NotFound';
import Pricing from './pages/Pricing';
import Rights from './pages/Rights';
import SongDetail from './pages/SongDetail';
import ScenePage from './pages/Scene';

/*
 * In the first download: the pages people arrive on from outside — the home
 * page, a scene page, a song someone sent, pricing, the report form. The rest
 * load when someone goes to them, so a visitor from a short video on a phone
 * is not made to fetch the studio, checkout and the statutory pages before
 * seeing anything. The prerender (prerender.tsx) imports pages directly and
 * is unaffected.
 */
const Auth = lazy(() => import('./pages/Auth'));
const Billing = lazy(() => import('./pages/Billing'));
const CheckoutComplete = lazy(() => import('./pages/Checkout').then((m) => ({ default: m.CheckoutComplete })));
const CheckoutConfirm = lazy(() => import('./pages/Checkout').then((m) => ({ default: m.CheckoutConfirm })));
const CheckoutSimulate = lazy(() => import('./pages/Checkout').then((m) => ({ default: m.CheckoutSimulate })));
const Create = lazy(() => import('./pages/Create'));
const Export = lazy(() => import('./pages/Export'));
const GoogleCallback = lazy(() => import('./pages/GoogleCallback'));
const MfaChallenge = lazy(() => import('./pages/MfaChallenge'));
const Library = lazy(() => import('./pages/Library'));
const LegalIndex = lazy(() => import('./pages/Legal').then((m) => ({ default: m.LegalIndex })));
const Terms = lazy(() => import('./pages/Legal').then((m) => ({ default: m.Terms })));
const Privacy = lazy(() => import('./pages/Legal').then((m) => ({ default: m.Privacy })));
const Company = lazy(() => import('./pages/Legal').then((m) => ({ default: m.Company })));
const Tokushoho = lazy(() => import('./pages/Tokushoho').then((m) => ({ default: m.Tokushoho })));

const Account = lazy(() => import('./pages/Account'));
const Admin = lazy(() => import('./pages/Admin'));
const StablecoinPay = lazy(() => import('./pages/StablecoinPay').then((page) => ({ default: page.StablecoinPay })));

/** Sends unauthenticated visitors to sign-in, preserving where they were going. */
function RequireAuth({ children, roles }: { children: ReactNode; roles?: string[] }) {
  const { me, loading } = useSession();
  const location = useLocation();

  if (loading) return <Loading />;
  // A trial without an account (docs/GROWTH_SPEC.md) has one song and its
  // page; everything behind sign-in is behind signing up.
  if (!me || me.role === 'guest') {
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
            {/* Above the routes, so it is the first thing on whatever screen
                the visitor lands on after signing in. */}
            <ConsentGate />
            <Suspense fallback={<Loading />}>
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
              {/*
                Paying from the customer's own wallet. The page refuses to
                render when the runtime descriptor says the channel is off, so
                a bookmarked URL cannot offer a payment method this deployment
                does not have.
              */}
              <Route
                path="/checkout/stablecoin"
                element={
                  <RequireAuth>
                    <StablecoinPay />
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
              <Route
                path="/admin/:tab"
                element={
                  <RequireAuth roles={['admin', 'support']}>
                    <Admin />
                  </RequireAuth>
                }
              />

              {/* Public on purpose: a rights holder must not need an account. */}
              {/* Scene landing pages (docs/GROWTH_SPEC.md). Written out, one per path, so tests/seo.test.ts and check:ui see each. */}
              <Route path="/birthday" element={<ScenePage slug="birthday" />} />
              <Route path="/love" element={<ScenePage slug="love" />} />
              <Route path="/thanks" element={<ScenePage slug="thanks" />} />
              <Route path="/miss" element={<ScenePage slug="miss" />} />
              <Route path="/memory" element={<ScenePage slug="memory" />} />
              <Route path="/travel" element={<ScenePage slug="travel" />} />
              <Route path="/cheer" element={<ScenePage slug="cheer" />} />
              <Route path="/help/rights" element={<Rights />} />
              <Route path="/legal" element={<LegalIndex />} />
              <Route path="/legal/terms" element={<Terms />} />
              <Route path="/legal/privacy" element={<Privacy />} />
              <Route path="/legal/company" element={<Company />} />
              <Route path="/legal/tokushoho" element={<Tokushoho />} />

              <Route path="*" element={<NotFound />} />
            </Routes>
            </Suspense>
          </Layout>
          </ErrorBoundary>
        </PlayerProvider>
      </SessionProvider>
      </I18nProvider>
    </BrowserRouter>
  );
}
