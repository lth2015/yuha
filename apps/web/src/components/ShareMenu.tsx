import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../lib/i18n';
import { copyText, isPrivateHost, shareTargets } from '../lib/share';
import { useDismiss } from '../lib/dismiss';

/**
 * The song's Share control: a small menu rather than a silent copy.
 *
 * People pressing "Share" expect somewhere to send it, and they expect to be
 * told something happened. The menu offers the link itself first (the one
 * thing that always works), then the social intents for the reader's
 * language, then the phone's own share sheet where the browser has one. On an
 * intranet address it says so, because a 10.x link posted to X opens for
 * nobody outside the office.
 */
export function ShareMenu({
  url,
  title,
  primary = false,
  label,
  text: textOverride,
  autoOpen = false,
  onOpen,
}: {
  url: string;
  title: string;
  /** The button's words; "Share" unless the song is a gift ("送给 TA"). */
  label?: string;
  /** What the post says; defaults to the song's own line. */
  text?: string;
  /** Open as soon as it appears — straight after "send it to them" published the song. */
  autoOpen?: boolean;
  /** Each time the menu opens: the owner's page uses it to upload the link-preview card. */
  onOpen?: () => void;
  /**
   * Once a song is public, sharing it is the thing the page is for, so it is
   * the one filled action in the row. Before that the row has no primary at
   * all and reads as five equal choices.
   */
  primary?: boolean;
}) {
  const { t, lang } = useI18n();
  const [open, setOpen] = useState(autoOpen);
  const [copy, setCopy] = useState<'idle' | 'done' | 'failed'>('idle');
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const link = useRef<HTMLInputElement>(null);
  const panelId = useId();
  const copyAttempt = useRef(0);
  const text = textOverride ?? t('song.share.text', { title });
  const internal = isPrivateHost(new URL(url).hostname);
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const closeMenu = useCallback(() => {
    copyAttempt.current += 1;
    setOpen(false);
  }, []);
  useDismiss(root, open, closeMenu);
  const closeFromPanel = () => {
    closeMenu();
    trigger.current?.focus();
  };
  const opened = useRef(onOpen);
  opened.current = onOpen;
  useEffect(() => {
    if (open) opened.current?.();
  }, [open]);

  const doCopy = async () => {
    const attempt = ++copyAttempt.current;
    const ok = await copyText(url);
    if (copyAttempt.current !== attempt) return;
    setCopy(ok ? 'done' : 'failed');
    if (!ok) link.current?.focus();
  };

  const nativeShare = async () => {
    try {
      await navigator.share({ title, text, url });
      closeFromPanel();
    } catch {
      /* the person closed the sheet; nothing to report */
    }
  };

  return (
    <div className="share" ref={root} onKeyDown={(event) => {
      if (!open || event.key !== 'Escape') return;
      event.stopPropagation();
      closeFromPanel();
    }}>
      <button
        ref={trigger}
        type="button"
        className={`text-action${primary ? ' is-strong' : ''}`}
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        onClick={() => {
          if (open) closeMenu();
          else {
            setCopy('idle');
            setOpen(true);
          }
        }}
      >
        {label ?? t('song.share')}
      </button>
      {open && (
        <div className="share__menu" id={panelId} role="group" aria-label={label ?? t('song.share')}>
          <div className="share__link">
            <input ref={link} className="share__url" readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label={t('song.share.link')} />
            <button type="button" className="share__copy" onClick={() => void doCopy()}>
              {t('song.share.copy')}
            </button>
          </div>
          <p role="status" className={copy === 'idle' ? 'sr-only' : 'share__note'}>
            {copy === 'done' ? t('song.copied') : copy === 'failed' ? t('song.share.copyFailed') : null}
          </p>
          {internal && <p className="share__note">{t('song.share.internal')}</p>}
          <div className="share__targets">
            {shareTargets(url, text, lang).map((target) => (
              <a
                key={target.id}
                className={`share__target share__target--${target.id}`}
                href={target.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={closeFromPanel}
              >
                {target.id === 'weibo' ? t('song.share.weibo') : target.label}
              </a>
            ))}
            {canNativeShare && (
              <button type="button" className="share__target" onClick={() => void nativeShare()}>
                {t('song.share.more')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
