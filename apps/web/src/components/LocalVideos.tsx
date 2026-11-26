import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../lib/i18n';
import { formatTime } from '../lib/player';
import { formatJst, useSession } from '../lib/session';
import { deleteLocalVideo, listLocalVideos, type LocalVideo } from '../lib/local-videos';
import { useConfirm } from './ConfirmDialog';

/**
 * The videos this device made, in "My songs" (lib/local-videos.ts).
 *
 * Only this account's, and only on this device: the section says so, because
 * the obvious next question — "where is it on my other phone?" — has the
 * answer "nowhere", and finding that out later is worse than reading it now.
 * Nothing is shown when there are none: an empty "videos" heading on every
 * visit would only advertise a feature with a box.
 */
const FIRST = 4;

export function LocalVideos() {
  const { t } = useI18n();
  const { me } = useSession();
  const [videos, setVideos] = useState<LocalVideo[]>([]);
  const [open, setOpen] = useState<{ id: string; url: string } | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  /** Four at first, so a long list of videos does not push the songs off the screen. */
  const [all, setAll] = useState(false);

  useEffect(() => {
    let live = true;
    void listLocalVideos(me?.userId).then((v) => live && setVideos(v));
    return () => {
      live = false;
    };
  }, [me?.userId]);

  // A playing video's object URL is released when another is opened or the page goes.
  useEffect(() => () => {
    if (open) URL.revokeObjectURL(open.url);
  }, [open]);

  if (!videos.length) return null;

  const fileOf = (v: LocalVideo) =>
    new File([v.blob], `${v.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'yuha'}.mp4`, { type: 'video/mp4' });
  const canShare = (v: LocalVideo) => typeof navigator.canShare === 'function' && navigator.canShare({ files: [fileOf(v)] });

  // The file's address is made on the click and let go of after it, not on every render.
  const download = (v: LocalVideo) => {
    const url = URL.createObjectURL(v.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileOf(v).name;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const remove = async (v: LocalVideo) => {
    if (!(await confirm({ message: t('lib.videos.deleteAsk'), confirmLabel: t('lib.videos.delete'), danger: true }))) return;
    await deleteLocalVideo(v.id);
    if (open?.id === v.id) setOpen(null);
    setVideos((all) => all.filter((x) => x.id !== v.id));
  };

  return (
    <section className="local-videos" aria-labelledby="local-videos-h">
      <h2 id="local-videos-h">{t('lib.videos.title')}</h2>
      <p className="local-videos__note">{t('lib.videos.note')}</p>
      <ul className="local-videos__list">
        {(all ? videos : videos.slice(0, FIRST)).map((v) => (
          <li key={v.id} className="local-videos__item">
            {open?.id === v.id ? (
              <video src={open.url} controls autoPlay playsInline className="local-videos__player" />
            ) : (
              <button
                type="button"
                className="local-videos__poster"
                style={v.poster ? { backgroundImage: `url(${v.poster})` } : undefined}
                aria-label={t('lib.videos.play', { title: v.title })}
                onClick={() => setOpen({ id: v.id, url: URL.createObjectURL(v.blob) })}
              >
                <span className="icon icon--play" aria-hidden="true" />
              </button>
            )}
            <div className="local-videos__meta">
              <Link to={`/song/${v.trackId}`} className="local-videos__title">
                {v.title}
              </Link>
              <span className="small muted num">
                {t(v.kind === 'photo' ? 'lib.videos.photo' : 'lib.videos.cover')} · {formatTime(v.seconds)} ·{' '}
                {formatJst(new Date(v.createdAt).toISOString(), true)}
              </span>
              <span className="local-videos__actions">
                {canShare(v) ? (
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => void navigator.share({ files: [fileOf(v)] }).catch(() => undefined)}
                  >
                    {t('video.saveOrShare')}
                  </button>
                ) : (
                  <button type="button" className="btn btn--sm" onClick={() => download(v)}>
                    {t('photo.download')}
                  </button>
                )}
                <button type="button" className="text-action is-danger" onClick={() => void remove(v)}>
                  {t('lib.videos.delete')}
                </button>
              </span>
            </div>
          </li>
        ))}
      </ul>
      {!all && videos.length > FIRST && (
        <button type="button" className="text-action" onClick={() => setAll(true)}>
          {t('lib.videos.showAll', { n: videos.length })}
        </button>
      )}
      {confirmDialog}
    </section>
  );
}
