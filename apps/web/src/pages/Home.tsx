import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { JobView } from '@yuha/contracts';
import { apiFetch, newIdempotencyKey } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useSession } from '../lib/session';
import { Score } from '../components/Score';
import { JOB_PHASES, fractionOfPhase, phaseKey } from '../lib/phases';

const DRAFT_KEY = 'yuha.home-draft';

const MOOD_KEYS = ['city', 'sunset', 'rain', 'night'] as const;

/** The simple path commits to one shape: a full song, two minutes, private.
    Everything else lives in the studio at /create. */
const SIMPLE_DURATION_SECONDS = 120;

/**
 * YUHA home — the create screen itself: the slogan, a one-line explainer and
 * a composer with mood starters. It makes exactly one decision available
 * beyond the description — vocals or instrumental — because that is the only
 * choice that changes what the listener gets. Length, style tags, lyrics and
 * visibility live in the studio at /create.
 *
 * Visitors can write first and sign in at submit; the draft survives the
 * round trip.
 */
export default function Home() {
  const { t } = useI18n();
  const { me, entitlements, refreshEntitlements } = useSession();
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState('');
  const [activeMood, setActiveMood] = useState<string | null>(null);
  const [instrumental, setInstrumental] = useState(false);
  const [feedbackKey, setFeedbackKey] = useState<{ key: string; params?: Record<string, string | number> } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const idemKey = useRef(newIdempotencyKey());
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  const credits = entitlements?.availableUnits ?? me?.creditsAvailable ?? 0;

  useEffect(() => {
    try {
      setPrompt(localStorage.getItem(DRAFT_KEY) ?? '');
    } catch {
      /* ignore */
    }
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
          instrumental,
          energy: 0.5,
          durationSeconds: SIMPLE_DURATION_SECONDS,
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


  // ---- generation state (real stages only, no fake progress) ----
  if (job) {
    const failed = job.phase === 'failed';
    const stepIdx = JOB_PHASES.indexOf(job.phase as (typeof JOB_PHASES)[number]);
    return (
      <div className="wait-page" aria-live="polite">
        <p className="eyebrow">{failed ? t('wait.failedEyebrow') : t('wait.eyebrow')}</p>
        <h1 className="wait-page__title">{failed ? t('wait.failedTitle') : t(phaseKey(job.phase))}</h1>
        <p className="muted wait-page__sub">{failed ? t('wait.failed') : t('wait.sub')}</p>

        {/* Their own description, being written to tape. The written region is
            the job's real phase — nothing here moves on a timer. */}
        <Score
          text={prompt}
          progress={failed ? undefined : fractionOfPhase(job.phase)}
          className="wait-page__score"
          height={200}
          label={t('wait.scoreAria')}
        />

        <ol className="wait-page__rail">
          {JOB_PHASES.map((phase, i) => (
            <li
              key={phase}
              className={i < stepIdx ? 'is-done' : i === stepIdx ? 'is-current' : 'is-future'}
              aria-current={i === stepIdx ? 'step' : undefined}
            >
              <span className="status-dot" aria-hidden="true" />
              {t(`create.phase.${phase}`)}
            </li>
          ))}
        </ol>

        <div className="wait-page__actions">
          <Link to="/library" className="btn">
            {t('wait.goLibrary')}
          </Link>
        </div>
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

          <Score text={prompt} ghost={t('composer.placeholder')} className="hero__score" height={180} />

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
              <span id="home-prompt-format">
                {t('composer.format', {
                  mode: instrumental ? t('composer.instrumental') : t('composer.vocals'),
                })}
              </span>
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

            <div className="composer__vocal">
              <div className="seg" role="group" aria-label={t('composer.vocalMode')}>
                <button
                  type="button"
                  className={`seg__btn${!instrumental ? ' is-active' : ''}`}
                  aria-pressed={!instrumental}
                  onClick={() => setInstrumental(false)}
                >
                  {t('composer.vocals')}
                </button>
                <button
                  type="button"
                  className={`seg__btn${instrumental ? ' is-active' : ''}`}
                  aria-pressed={instrumental}
                  onClick={() => setInstrumental(true)}
                >
                  {t('composer.instrumental')}
                </button>
              </div>
              <Link to="/create" className="composer__advanced">
                {t('composer.advanced')}
              </Link>
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
              {error ??
                (feedbackKey
                  ? t(feedbackKey.key, feedbackKey.params)
                  : instrumental
                    ? t('composer.instrumentalHint')
                    : t('composer.vocalsHint'))}
            </p>
          </div>
        </div>

      </section>
    </div>
  );
}
