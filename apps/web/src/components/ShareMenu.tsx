import { useCallback, useEffect, useRef, useState } from 'react';
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
  makeVideo,
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
  /** Makes the share video (owner only). Absent, the menu offers no video. */
  makeVideo?: () => Promise<File>;
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
  /*
   * Two taps, not one. A phone opens its share sheet only within a few
   * seconds of a tap, and the video takes longer than that to make — so the
   * first tap makes it, and the second, on a button that says it is ready,
   * sends it.
   */
  const [video, setVideo] = useState<{ state: 'idle' | 'making' | 'failed' } | { state: 'ready' | 'saved'; file: File }>({ state: 'idle' });
  const startVideo = async () => {
    if (!makeVideo) return;
    setVideo({ state: 'making' });
    try {
      setVideo({ state: 'ready', file: await makeVideo() });
    } catch {
      setVideo({ state: 'failed' });
    }
  };
  const sendVideo = async (file: File) => {
    if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], text });
        setOpen(false);
      } catch {
        /* closed the sheet; the video is still ready */
      }
      return;
    }
    // No file sharing here (most desktops): save it, and say where it goes.
    const href = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = href;
    a.download = file.name;
    // In the document: a detached link's download name is ignored by some browsers.
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
    setVideo({ state: 'saved', file });
  };
  const root = useRef<HTMLDivElement>(null);
  const text = textOverride ?? t('song.share.text', { title });
  const internal = isPrivateHost(new URL(url).hostname);
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const closeMenu = useCallback(() => setOpen(false), []);
  useDismiss(root, open, closeMenu);
  const opened = useRef(onOpen);
  opened.current = onOpen;
  useEffect(() => {
    if (open) opened.current?.();
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
        className={`text-action${primary ? ' is-strong' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
          setCopy('idle');
        }}
      >
        {label ?? t('song.share')}
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
          {makeVideo && (
            <div className="share__video">
              {video.state === 'ready' || video.state === 'saved' ? (
                <button type="button" className="share__copy is-strong" role="menuitem" onClick={() => void sendVideo(video.file)}>
                  {t('song.share.videoSend')}
                </button>
              ) : (
                <button
                  type="button"
                  className="share__copy"
                  role="menuitem"
                  onClick={() => void startVideo()}
                  disabled={video.state === 'making'}
                  aria-busy={video.state === 'making'}
                >
                  {t(video.state === 'making' ? 'song.share.videoMaking' : 'song.share.video')}
                </button>
              )}
              <p className="share__note" aria-live="polite">
                {video.state === 'failed'
                  ? t('song.share.videoFailed')
                  : video.state === 'saved'
                    ? t('song.share.videoSaved')
                    : video.state === 'ready'
                      ? t('song.share.videoReady')
                      : t('song.share.videoHint')}
              </p>
            </div>
          )}
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
