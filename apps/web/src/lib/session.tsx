import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { EntitlementsView, MeView, RuntimeInfo } from '@yuha/contracts';
import { SESSION_EXPIRED_EVENT, apiFetch, getToken, setToken } from './api';

/**
 * Session and runtime state.
 *
 * `runtime` comes from GET /v1/runtime and decides what the interface is even
 * allowed to offer (§3.1): the demo banner, whether subscriptions or WAV export
 * appear, whether payments are real. Nothing in the UI hard-codes those.
 */
interface SessionState {
  runtime: RuntimeInfo | null;
  me: MeView | null;
  entitlements: EntitlementsView | null;
  loading: boolean;
  signIn(token: string, me: MeView): void;
  signOut(): void;
  refreshEntitlements(): Promise<void>;
  /**
   * Hand the session a balance a page has just fetched itself, so the header
   * cannot show a different number from the page beneath it.
   */
  acceptEntitlements(fresh: EntitlementsView): void;
  refreshMe(): Promise<void>;
  refreshRuntime(): Promise<RuntimeInfo>;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [me, setMe] = useState<MeView | null>(null);
  const [entitlements, setEntitlements] = useState<EntitlementsView | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshRuntime = useCallback(async () => {
    const fresh = await apiFetch<RuntimeInfo>('/v1/runtime');
    setRuntime(fresh);
    return fresh;
  }, []);

  const refreshMe = useCallback(async () => {
    if (!getToken()) {
      setMe(null);
      return;
    }
    try {
      setMe(await apiFetch<MeView>('/v1/me'));
    } catch {
      // An invalid token is cleared by the fetch layer; treat as signed out.
      setMe(null);
    }
  }, []);

  const refreshEntitlements = useCallback(async () => {
    if (!getToken()) {
      setEntitlements(null);
      return;
    }
    try {
      setEntitlements(await apiFetch<EntitlementsView>('/v1/entitlements'));
    } catch {
      setEntitlements(null);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await refreshRuntime();
      } catch {
        setRuntime(null);
      }
      await refreshMe();
      await refreshEntitlements();
      setLoading(false);
    })();
  }, [refreshMe, refreshEntitlements, refreshRuntime]);

  /*
   * The balance in the header is a copy, taken at sign-in and after the
   * flows that know they spent or bought something. Anything else that moves
   * it — an operator's gift, a refund, a purchase finished in another tab, a
   * renewal overnight — left the header on the old number until a reload:
   * "可用 15 次" over a billing page that said 25. Coming back to the tab is
   * the moment someone looks again, so that is when it is re-read; at most
   * once every few seconds, because focus events arrive in bursts.
   */
  useEffect(() => {
    let last = 0;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - last < 5_000) return;
      last = now;
      void refreshRuntime().catch(() => undefined);
      void refreshEntitlements();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [refreshEntitlements, refreshRuntime]);

  /*
   * The fetch layer clears a rejected token; this clears the rest of the
   * session so the UI stops claiming somebody is signed in.
   */
  useEffect(() => {
    const onExpired = () => {
      setMe(null);
      setEntitlements(null);
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  const signIn = useCallback(
    (token: string, user: MeView) => {
      setToken(token);
      setMe(user);
      void refreshEntitlements();
    },
    [refreshEntitlements],
  );

  const signOut = useCallback(() => {
    setToken(null);
    setMe(null);
    setEntitlements(null);
  }, []);

  const value = useMemo<SessionState>(
    () => ({
      runtime,
      me,
      entitlements,
      loading,
      signIn,
      signOut,
      refreshEntitlements,
      acceptEntitlements: setEntitlements,
      refreshMe,
      refreshRuntime,
    }),
    [runtime, me, entitlements, loading, signIn, signOut, refreshEntitlements, refreshMe, refreshRuntime],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside a SessionProvider');
  return ctx;
}

/** Formats an ISO instant as a local date-time (billing history). */
export function formatJst(iso: string | null | undefined, withTime = true): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  // The zone is fixed (the operating entity is Japanese) but the *reading* of
  // the date should follow the interface. This util is called from modules
  // without i18n in scope, so it reads the same stored preference the
  // dictionary does rather than taking a locale through every call site.
  let locale = 'en-US';
  try {
    const l = localStorage.getItem('yuha.lang');
    locale = l === 'ja' ? 'ja-JP' : l === 'zh' ? 'zh-CN' : 'en-US';
  } catch {
    /* private browsing */
  }
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
  }).format(d);
}

/** Re-exported so existing callers keep working; the implementation is in lib/money. */
export { formatMoney } from './money';

/** Legacy name kept for the admin console; formats JPY-major integers. */
export function formatJpy(amount: number): string {
  return new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY' }).format(amount);
}
