import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { JobView, TrackView } from '@loopscene/contracts';
import { apiFetch, newIdempotencyKey } from '../lib/api';
import { usePlayer } from '../lib/player';
import { useI18n } from '../lib/i18n';
import { useSession } from '../lib/session';
import { PetalMark } from '../components/Brand';
import { Eq } from '../components/Eq';
import { SongCard } from '../components/SongCard';

const DRAFT_KEY = 'yuha.home-draft';

const MOOD_KEYS = ['city', 'sunset', 'rain', 'night'] as const;

/**
 * YUHA home — the create screen itself (acceptance UI-01): the slogan, a
 * one-line explainer, a composer with mood starters, and the fixed 30s /
 * instrumental note. Visitors can write first and sign in at submit; the
 * draft survives the round trip. Finished work surfaces beneath.
 */
export default function Home() {
  const { t } = useI18n();
  const { me, entitlements, refreshEntitlements } = useSession();
  const player = usePlayer();
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState('');
  const [activeMood, setActiveMood] = useState<string | null>(null);
  const [feedbackKey, setFeedbackKey] = useState<{ key: string; params?: Record<string, string | number> } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [songs, setSongs] = useState<TrackView[] | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const idemKey = useRef(newIdempotencyKey());
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  const credits = entitlements?.availableUnits ?? me?.creditsAvailable ?? 0;
  const playing = player.status === 'playing';

  useEffect(() => {
    try {
      setPrompt(localStorage.getItem(DRAFT_KEY) ?? '');
    } catch {
      /* ignore */
    }
    apiFetch<{ items: TrackView[] }>('/v1/explore?limit=6&sort=trending')
      .then((r) => setSongs(r.items))
      .catch(() => setSongs([]));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, prompt);
    } catch {
      /* private browsing */
    }
  }, [prompt]);

  const canSubmit = prompt.trim().length > 0 && !submitting;

  const pickMood = (mood: (typeof MOOD_KEYS)[number]) => {
    const seeded = t(`mood.${mood}.text`);
    if (prompt.trim() && ![MOOD_KEYS].some(() => MOOD_KEYS.some((k) => t(`mood.${k}.text`) === prompt))) {
      setFeedbackKey({ key: 'composer.moodKept', params: { mood: t(`mood.${mood}`) } });
      return;
    }
    setPrompt(seeded);
    setActiveMood(mood);
    setFeedbackKey({ key: 'composer.moodSeeded' });
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      if (!me) {
        const next = encodeURIComponent('/');
        navigate(`/auth?next=${next}`);
        return;
      }
      const res = await apiFetch<JobView & { deduplicated: boolean }>('/v1/generations', {
        method: 'POST',
        idempotencyKey: idemKey.current,
        body: {
          mode: 'simple',
          prompt: prompt.trim(),
          styles: activeMood ? [t(`mood.${activeMood}`)] : [],
          instrumental: true,
          energy: 0.5,
          durationSeconds: 30,
          visibility: 'private',
        },
      });
      setJob(res);
      void refreshEntitlements();
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  // Poll the job to terminal state, then hand over to the song page.
  useEffect(() => {
    if (!job || ['done', 'failed'].includes(job.phase)) {
      if (job?.phase === 'done' && job.trackId) navigate(`/song/${job.trackId}`, { replace: true });
      return;
    }
    let delay = 2000;
    const tick = async () => {
      try {
        const next = await apiFetch<JobView>(`/v1/jobs/${job.jobId}`);
        setJob(next);
      } catch {
        /* transient poll failure */
      }
      if (delay < 10000) delay = Math.min(delay * 1.6, 10000);
      setTimeout(tick, delay);
    };
    const t = setTimeout(tick, delay);
    return () => clearTimeout(t);
  }, [job, navigate]);

  const waitSteps = useMemo(
    () => [
      { key: 'validating', label: t('wait.s1') },
      { key: 'queued', label: t('wait.s2') },
      { key: 'generating', label: t('wait.s3') },
      { key: 'done', label: t('wait.s4') },
    ],
    [t],
  );

  // ---- generation state (real stages only, no fake progress) ----
  if (job) {
    const stepIdx = waitSteps.findIndex((s) => s.key === job.phase);
    return (
      <div className="wait-page" aria-live="polite">
        <PetalMark size={100} className="wait-page__mark is-moving" shadow={false} title="YUHA" />
        <h1>{t('wait.heading')}</h1>
        <p className="muted">{t('wait.sub')}</p>
        <ol className="wait-page__steps panel">
          {waitSteps.map((s, i) => (
            <li key={s.key} className={i < stepIdx ? 'is-done' : i === stepIdx ? 'is-current' : 'is-future'}>
              <span className="status-dot" aria-hidden="true" />
              {s.label}
              <b>{i < stepIdx ? t('wait.done') : i === stepIdx ? t('wait.doing') : t('wait.todo')}</b>
            </li>
          ))}
        </ol>
        {job.phase === 'failed' && (
          <p className="state-note" role="alert">
            {t('wait.failed')}
          </p>
        )}
        <Link to="/library" className="btn">
          {t('wait.goLibrary')}
        </Link>
      </div>
    );
  }

  return (
    <div className="stack">
      <section className="hero">
        <div className="hero__copy">
          <p className="eyebrow">{t('hero.eyebrow')}</p>
          <h1 className="hero__title">
            {t('hero.slogan1')}
            <br />
            {t('hero.slogan2')}
          </h1>
          <p className="hero__intro">{t('hero.intro')}</p>

          <div className="composer panel">
            <label htmlFor="home-prompt">{t('composer.label')}</label>
            <textarea
              id="home-prompt"
              ref={promptRef}
              value={prompt}
              maxLength={400}
              onChange={(e) => {
                setPrompt(e.target.value);
                setActiveMood(null);
              }}
              placeholder={t('composer.placeholder')}
              aria-describedby="home-prompt-format home-prompt-count"
            />
            <div className="composer__meta">
              <span id="home-prompt-format">{t('composer.format')}</span>
              <span id="home-prompt-count" className="num">
                {prompt.length} / 400
              </span>
            </div>

            <div className="chips" role="group" aria-label={t('composer.feedback')}>
              {MOOD_KEYS.map((mood) => (
                <button
                  key={mood}
                  type="button"
                  className="chip chip--mood"
                  aria-pressed={activeMood === mood}
                  onClick={() => pickMood(mood)}
                >
                  {t(`mood.${mood}`)}
                </button>
              ))}
            </div>

            <div className="composer__row">
              <span className="composer__cost">
                {t('composer.cost')}
                <br />
                {me ? t('composer.credits', { n: credits }) : t('composer.creditsLogin')}
              </span>
              <button type="button" className="btn btn--primary" onClick={submit} disabled={!canSubmit}>
                {submitting ? t('composer.submitting') : t('composer.submit')}
                <span aria-hidden="true">↗</span>
              </button>
            </div>
            <p className="composer__feedback" aria-live="polite">
              {error ?? (feedbackKey ? t(feedbackKey.key, feedbackKey.params) : t('composer.feedback'))}
            </p>
          </div>
        </div>

        <aside className="art-panel" aria-label="品牌意象：一片被风托起的羽花">
          <div className="art-panel__index" aria-hidden="true">
            <span>{t('art.index1')}</span>
            <span>{t('art.index2')}</span>
          </div>
          <PetalMark size={380} className="art-panel__petal is-entering" shadow={false} title="一片花瓣。一点风。" />
          <div className="art-panel__caption">
            <span className="art-panel__line" aria-hidden="true" />
            <h2>
              {t('art.h2a')}
              <br />
              {t('art.h2b')}
            </h2>
            <p>
              {t('art.pa')}
              <br />
              {t('art.pb')}
            </p>
          </div>
        </aside>
      </section>

      {songs && songs.length > 0 && (
        <section aria-labelledby="home-works">
          <div className="section-head">
            <h2 id="home-works">
              <Eq live={playing} /> {t('home.echoes')}
            </h2>
            <Link to="/explore" className="section-head__more">
              {t('home.toMarket')}
            </Link>
          </div>
          <div className="masonry">
            {songs.map((song, i) => (
              <SongCard key={song.trackId} song={song} queue={songs} index={i} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
