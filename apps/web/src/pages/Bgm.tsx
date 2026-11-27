import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  BGM_DEFAULTS,
  BGM_DURATIONS,
  BGM_GENRES,
  BGM_MOODS,
  BGM_NOTE_MAX,
  BGM_SCENARIOS,
  BGM_TEMPOS,
  type BgmRequest,
  type JobView,
  type TrackView,
} from '@yuha/contracts';
import { JobOutcome, QueueStatus, etaText } from '../components/GenerationQueue';
import { ErrorNotice } from '../components/common';
import { apiFetch, newIdempotencyKey } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { formatTime, usePlayer } from '../lib/player';
import { useSession } from '../lib/session';

/**
 * AI BGM (docs/BGM_STUDIO_PLAN.md): background music for a video, from a few
 * choices. Instrumental only; one credit, like a song.
 *
 * Every choice here reaches the music model as words (contracts/bgm.ts), and
 * nothing is claimed that is not sent: "tempo feel" because the model takes no
 * BPM, and "personal use" because commercial terms are not yet confirmed.
 */
export default function Bgm() {
  const { t, lang } = useI18n();
  const { runtime, refreshEntitlements } = useSession();
  const player = usePlayer();
  const [choice, setChoice] = useState<BgmRequest>(BGM_DEFAULTS);
  const [job, setJob] = useState<JobView | null>(null);
  const [track, setTrack] = useState<TrackView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const idemKey = useRef(newIdempotencyKey());
  const set = (patch: Partial<BgmRequest>) => setChoice((c) => ({ ...c, ...patch }));

  // The job, every few seconds while it runs; the track once it is delivered.
  useEffect(() => {
    if (!job || job.phase === 'done' || job.phase === 'failed') return undefined;
    let gone = false;
    const timer = window.setTimeout(async () => {
      try {
        const next = await apiFetch<JobView>(`/v1/jobs/${job.jobId}`);
        if (!gone) setJob(next);
      } catch {
        /* a dropped poll; the next one tries again */
      }
    }, 3000);
    return () => {
      gone = true;
      window.clearTimeout(timer);
    };
  }, [job]);
  useEffect(() => {
    if (job?.phase !== 'done' || !job.trackId || track?.trackId === job.trackId) return;
    apiFetch<TrackView>(`/v1/tracks/${job.trackId}`).then(setTrack, setError);
  }, [job, track?.trackId]);

  const generate = async () => {
    setSubmitting(true);
    setError(null);
    setTrack(null);
    try {
      const res = await apiFetch<JobView>('/v1/generations', {
        method: 'POST',
        idempotencyKey: idemKey.current,
        body: { bgm: { ...choice, note: choice.note.trim() } },
      });
      setJob(res);
      void refreshEntitlements();
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };
  /** The same choices again: a new request, so a new key. */
  const again = () => {
    idemKey.current = newIdempotencyKey();
    setJob(null);
    setTrack(null);
    void generate();
  };

  if (runtime && !runtime.features.bgmStudio) {
    return (
      <main className="page bgm" id="main">
        <h1>{t('bgm.title')}</h1>
        <p className="muted">{t('bgm.unavailable')}</p>
      </main>
    );
  }

  const group = (id: string, label: string, values: readonly (string | number)[], value: string | number, pick: (v: never) => void, key: (v: string | number) => string) => (
    <div className="studio__dial">
      <span className="studio__dial-label" id={id}>{label}</span>
      <div className="chips" role="group" aria-labelledby={id}>
        {values.map((v) => (
          <button key={v} type="button" className={`chip chip--btn${value === v ? ' is-on' : ''}`} aria-pressed={value === v} onClick={() => pick(v as never)} disabled={Boolean(job && !track && job.phase !== 'failed')}>
            {t(key(v))}
          </button>
        ))}
      </div>
    </div>
  );

  const running = Boolean(job && job.phase !== 'done' && job.phase !== 'failed');
  return (
    <main className="page bgm" id="main">
      <header className="bgm__head">
        <h1>{t('bgm.title')}</h1>
        <p className="muted">{t('bgm.lede')}</p>
      </header>

      <section className="panel bgm__form" aria-labelledby="bgm-form-heading">
        <h2 id="bgm-form-heading" className="sr-only">{t('bgm.form')}</h2>
        {group('bgm-scenario', t('bgm.scenario'), BGM_SCENARIOS, choice.scenario, (v) => set({ scenario: v }), (v) => `bgm.scenario.${v}`)}
        {group('bgm-genre', t('bgm.genre'), BGM_GENRES, choice.genre, (v) => set({ genre: v }), (v) => `bgm.genre.${v}`)}
        {group('bgm-mood', t('bgm.mood'), BGM_MOODS, choice.mood, (v) => set({ mood: v }), (v) => `bgm.mood.${v}`)}
        {group('bgm-length', t('bgm.length'), BGM_DURATIONS, choice.durationSeconds, (v) => set({ durationSeconds: v }), (v) => `bgm.length.${v}`)}
        {group('bgm-tempo', t('bgm.tempo'), BGM_TEMPOS, choice.tempo, (v) => set({ tempo: v }), (v) => `bgm.tempo.${v}`)}
        <p className="small muted">{t('bgm.tempo.hint')}</p>
        <label htmlFor="bgm-note" className="studio__dial-label">{t('bgm.note')}</label>
        <textarea
          id="bgm-note"
          rows={2}
          maxLength={BGM_NOTE_MAX}
          value={choice.note}
          placeholder={t('bgm.note.placeholder')}
          onChange={(e) => set({ note: e.target.value })}
          disabled={running}
        />
        <p className="small muted">{t('bgm.instrumental')}</p>
        <p className="small muted">{t('bgm.use')} <Link to="/legal/terms#bgm">{t('bgm.use.terms')}</Link></p>
        <button type="button" className="btn btn--primary" onClick={() => void generate()} disabled={submitting || running}>
          {submitting ? t('bgm.submitting') : t('bgm.generate')}
        </button>
        <p className="small muted">{t('bgm.cost')}</p>
        {error ? <ErrorNotice error={error} /> : null}
      </section>

      {job && (
        <section className="panel bgm__job" aria-live="polite">
          {job.phase === 'failed' ? (
            <>
              <h2>{t('bgm.failed')}</h2>
              <p className="muted">{t(`job.failure.${job.failure ?? 'technical'}`)}</p>
              <JobOutcome job={job} />
            </>
          ) : track ? (
            <>
              <h2>{track.title}</h2>
              <p className="small muted">
                {formatTime(track.durationSeconds)} · {t(`bgm.genre.${track.bgm?.genre ?? choice.genre}`)} · {t(`bgm.scenario.${track.bgm?.scenario ?? choice.scenario}`)} ·{' '}
                {new Date(track.createdAt).toLocaleString(lang)}
              </p>
              <div className="bgm__actions">
                <button type="button" className="btn btn--primary" onClick={() => player.play({ ...track, previewUrl: track.previewUrl })}>
                  {t('bgm.play')}
                </button>
                <Link to={`/song/${track.trackId}`} className="btn">{t('bgm.open')}</Link>
                <button type="button" className="btn" onClick={again}>{t('bgm.again')}</button>
              </div>
              <p className="small muted">{t('bgm.use')} <Link to="/legal/terms#bgm">{t('bgm.use.terms')}</Link></p>
            </>
          ) : (
            <>
              <h2>{t('bgm.making')}</h2>
              <p className="muted">{etaText(job, t)}</p>
              <QueueStatus job={job} onUpdate={setJob} onCancelled={() => { setJob(null); idemKey.current = newIdempotencyKey(); }} />
            </>
          )}
        </section>
      )}
    </main>
  );
}
