import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../lib/i18n';

/**
 * A render throw degrades to a panel, not to a blank page.
 *
 * Without this, one component throwing unmounted the whole tree — nav, footer
 * and content — to bare `--bg`. On a near-black design that is indistinguishable
 * from a page still loading, which is how `/pricing` stayed a white screen from
 * 2026-09-18 to 2026-09-26: it had been *looked at* and read as "still loading".
 *
 * Mounted inside `I18nProvider` so the fallback can translate. A throw from the
 * providers themselves is still fatal; that is a deliberate limit, not an
 * oversight — there is no language to apologise in above them.
 */
function Fallback({ error, onDismiss }: { error: Error | null; onDismiss: () => void }) {
  const { t } = useI18n();
  return (
    <div className="crash" role="alert">
      <div className="panel crash__panel stack">
        <h1 className="crash__title">{t('crash.title')}</h1>
        <p className="muted">{t('crash.body')}</p>
        <div className="crash__actions">
          {/* An actual reload, because the label says so.
              Clearing the error state instead only re-renders the same
              children, so a deterministic crash — which is what the one this
              was built for was — throws again on the next tick and the user
              sees a button that visibly does nothing. A reload also drops the
              corrupt state that may have caused the throw. */}
          <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
            {t('crash.retry')}
          </button>
          <Link to="/" className="btn" onClick={onDismiss}>
            {t('crash.home')}
          </Link>
        </div>
        {/* The message, not the stack: enough for a support conversation,
            without a wall of minified frames. */}
        {error?.message && <p className="crash__detail small">{error.message}</p>}
      </div>
    </div>
  );
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the component trail: `getDerivedStateFromError` does not receive it,
    // and it is the part that says *where*.
    console.error('render failed', error, info.componentStack);
  }

  override render() {
    if (this.state.error) {
      // Dismiss, not retry: the link is already navigating away, and leaving
      // the boundary latched would show the panel again at the destination.
      return <Fallback error={this.state.error} onDismiss={() => this.setState({ error: null })} />;
    }
    return this.props.children;
  }
}
