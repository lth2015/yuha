import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../lib/i18n';
import { copyText, isPrivateHost, shareTargets } from '../lib/share';

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
export function ShareMenu({ url, title }: { url: string; title: string }) {
  const { t, lang } = useI18n();
  const [open, setOpen] = useState(false);
  const [copy, setCopy] = useState<'idle' | 'done' | 'failed'>('idle');
  const root = useRef<HTMLDivElement>(null);
  const text = t('song.share.text', { title });
  const internal = isPrivateHost(new URL(url).hostname);
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const doCopy = async () => {
    const ok = await copyText(url);
    setCopy(ok ? 'done' : 'failed');
    if (ok) setTimeout(() => setCopy('idle'), 2000);
  };

  const nativeShare = async () => {
    try {
      await navigator.share({ title, text, url });
      setOpen(false);
    } catch {
      /* the person closed the sheet; nothing to report */
    }
  };

  return (
    <div className="share" ref={root}>
      <button
        type="button"
        className="text-action"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
          setCopy('idle');
        }}
      >
        {t('song.share')}
      </button>
      {open && (
        <div className="share__menu" role="menu">
          <div className="share__link">
            <input className="share__url" readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label={t('song.share.link')} />
            <button type="button" className="share__copy" role="menuitem" onClick={doCopy}>
              {copy === 'done' ? t('song.copied') : t('song.share.copy')}
            </button>
          </div>
          {copy === 'failed' && <p className="share__note">{t('song.share.copyFailed')}</p>}
          {internal && <p className="share__note">{t('song.share.internal')}</p>}
          <div className="share__targets">
            {shareTargets(url, text, lang).map((target) => (
              <a
                key={target.id}
                className={`share__target share__target--${target.id}`}
                role="menuitem"
                href={target.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
              >
                {target.id === 'weibo' ? t('song.share.weibo') : target.label}
              </a>
            ))}
            {canNativeShare && (
              <button type="button" className="share__target" role="menuitem" onClick={nativeShare}>
                {t('song.share.more')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
