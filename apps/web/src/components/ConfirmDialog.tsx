import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../lib/i18n';

/**
 * An in-page confirmation, in place of `window.confirm` (UX audit #28).
 *
 * The browser's own dialog is unstyled, names the site's host in its title on
 * some phones, and can be suppressed after a few uses ("prevent this page from
 * creating additional dialogs"), at which point `confirm()` answers false and
 * the button silently does nothing. A `<dialog>` opened with `showModal()`
 * keeps focus inside, closes on Escape (answering no), and returns focus to the
 * button that opened it.
 *
 * `const [confirm, dialog] = useConfirm();` then `if (!(await confirm({...}))) return;`
 * and render `{dialog}` once.
 */
interface Ask {
  message: string;
  /** The confirming button's words; defaults to "OK". */
  confirmLabel?: string;
  /** A destructive action gets the danger style. */
  danger?: boolean;
}

export function useConfirm(): [(ask: Ask) => Promise<boolean>, ReactNode] {
  const { t } = useI18n();
  const [ask, setAsk] = useState<Ask | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const ref = useRef<HTMLDialogElement>(null);

  const confirm = useCallback((next: Ask) => {
    resolver.current?.(false);
    setAsk(next);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const answer = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    ref.current?.close();
    setAsk(null);
  };

  useEffect(() => {
    const el = ref.current;
    if (ask && el && !el.open) el.showModal();
  }, [ask]);

  // Left unanswered when the page goes: the caller is told "no".
  useEffect(() => () => resolver.current?.(false), []);

  const dialog = (
    <dialog
      ref={ref}
      className="confirm-dialog"
      aria-labelledby="confirm-dialog-text"
      onCancel={(e) => {
        e.preventDefault();
        answer(false);
      }}
    >
      {ask && (
        <>
          <p id="confirm-dialog-text">{ask.message}</p>
          <div className="confirm-dialog__actions">
            <button type="button" className="btn" onClick={() => answer(false)} autoFocus>
              {t('common.cancel')}
            </button>
            <button type="button" className={`btn ${ask.danger ? 'btn--danger' : 'btn--primary'}`} onClick={() => answer(true)}>
              {ask.confirmLabel ?? t('common.ok')}
            </button>
          </div>
        </>
      )}
    </dialog>
  );

  return [confirm, dialog];
}
