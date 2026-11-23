import { useEffect, useRef, useState } from 'react';
import { apiPostForBlob } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { resolveLyricTimings } from '../lib/lyrics';
import { drawPhotoFrame, frameJpeg, loadPhoto, planPhotoClip, type ShareLabels, type ShareSong } from '../lib/share-art';
import { ErrorNotice } from './common';

/**
 * The photo MV (docs/PHOTO_MV_SPEC.md): the owner picks 3–10 photos and gets
 * thirty seconds of this song over them as a portrait MP4.
 *
 * The photos stay in this tab. They are decoded here, turned upright, scaled
 * down and drawn into whole frames; only the frames go to the server, which
 * puts them on the song's audio and keeps nothing. The page says so where the
 * photos are chosen, because it is the question anyone choosing a photo of
 * their child will have.
 */
const MIN_PHOTOS = 3;
const MAX_PHOTOS = 10;

interface Picked {
  key: string;
  canvas: HTMLCanvasElement;
  thumb: string;
}

type Result = { state: 'idle' | 'making' } | { state: 'ready'; file: File; url: string };

export function PhotoVideo({
  song,
  labels,
  lyrics,
  lyricTimings,
}: {
  song: ShareSong & { trackId: string; title: string; durationSeconds: number };
  labels: ShareLabels;
  lyrics: string | null;
  lyricTimings: Parameters<typeof resolveLyricTimings>[2];
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [photos, setPhotos] = useState<Picked[]>([]);
  const [skipped, setSkipped] = useState(0);
  const [result, setResult] = useState<Result>({ state: 'idle' });
  const [error, setError] = useState<unknown>(null);
  const input = useRef<HTMLInputElement>(null);

  // A finished video's object URL is released when it is replaced or the panel goes.
  useEffect(() => () => {
    if (result.state === 'ready') URL.revokeObjectURL(result.url);
  }, [result]);

  const add = async (files: FileList | null) => {
    if (!files) return;
    setResult({ state: 'idle' });
    let unread = 0;
    const next: Picked[] = [];
    for (const file of Array.from(files).slice(0, MAX_PHOTOS - photos.length)) {
      const canvas = await loadPhoto(file);
      if (!canvas) {
        unread += 1;
        continue;
      }
      next.push({ key: `${file.name}-${file.lastModified}-${Math.random()}`, canvas, thumb: canvas.toDataURL('image/jpeg', 0.6) });
    }
    setSkipped(unread);
    setPhotos((p) => [...p, ...next].slice(0, MAX_PHOTOS));
    if (input.current) input.current.value = '';
  };

  const make = async () => {
    if (photos.length < MIN_PHOTOS) return;
    setError(null);
    setResult({ state: 'making' });
    try {
      const lines = lyrics ? resolveLyricTimings(lyrics, song.durationSeconds, lyricTimings).lines : [];
      const plan = planPhotoClip(lines, song.durationSeconds, photos.length);
      const frames = [];
      for (const f of plan.frames) {
        const canvas = await drawPhotoFrame(song, labels, photos[f.photo]!.canvas, f.line);
        frames.push({ at: f.at, jpeg: await frameJpeg(canvas, 0.8) });
      }
      const blob = await apiPostForBlob(`/v1/tracks/${song.trackId}/photo-video`, { start: plan.start, duration: plan.duration, frames });
      const name = `${song.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'yuha'}.mp4`;
      const file = new File([blob], name, { type: 'video/mp4' });
      setResult({ state: 'ready', file, url: URL.createObjectURL(file) });
    } catch (err) {
      setError(err);
      setResult({ state: 'idle' });
    }
  };

  const share = async (file: File) => {
    if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
      } catch {
        /* closed the sheet; the video is still here */
      }
    }
  };
  const canShareFiles =
    result.state === 'ready' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [result.file] });

  if (!open) {
    return (
      <button type="button" className="text-action" onClick={() => setOpen(true)}>
        {t('photo.open')}
      </button>
    );
  }

  return (
    <section className="photo-video" aria-labelledby="photo-video-title">
      <div className="photo-video__head">
        <h2 id="photo-video-title">{t('photo.title')}</h2>
        <button type="button" className="text-action" onClick={() => setOpen(false)}>
          {t('photo.close')}
        </button>
      </div>
      <p className="photo-video__lead">{t('photo.lead')}</p>
      <p className="photo-video__notice">{t('photo.notice')}</p>

      {photos.length > 0 && (
        <ol className="photo-video__grid">
          {photos.map((p, i) => (
            <li key={p.key}>
              <img src={p.thumb} alt="" width={96} height={96} />
              <button
                type="button"
                className="photo-video__remove"
                aria-label={t('photo.remove', { n: i + 1 })}
                onClick={() => {
                  setResult({ state: 'idle' });
                  setPhotos((all) => all.filter((x) => x.key !== p.key));
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ol>
      )}
      <p className="photo-video__count" aria-live="polite">
        {t('photo.count', { n: photos.length })}
        {skipped > 0 && ` · ${t('photo.unreadable', { n: skipped })}`}
      </p>

      <div className="photo-video__actions">
        {photos.length < MAX_PHOTOS && (
          <label className="btn">
            {t('photo.pick')}
            <input
              ref={input}
              type="file"
              accept="image/*"
              multiple
              className="visually-hidden"
              onChange={(e) => void add(e.target.files)}
            />
          </label>
        )}
        <button
          type="button"
          className="btn btn--primary"
          disabled={photos.length < MIN_PHOTOS || result.state === 'making'}
          aria-busy={result.state === 'making'}
          onClick={() => void make()}
        >
          {result.state === 'making' ? t('photo.making') : t('photo.make')}
        </button>
      </div>

      <ErrorNotice error={error} />

      {result.state === 'ready' && (
        <div className="photo-video__result">
          <video src={result.url} controls playsInline className="photo-video__preview" />
          <div className="photo-video__actions">
            {canShareFiles && (
              <button type="button" className="btn btn--primary" onClick={() => void share(result.file)}>
                {t('photo.share')}
              </button>
            )}
            <a className="btn" href={result.url} download={result.file.name}>
              {t('photo.download')}
            </a>
          </div>
        </div>
      )}
    </section>
  );
}
