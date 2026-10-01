import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { JobView, TrackView } from '@yuha/contracts';
import { ApiError, apiFetch, newIdempotencyKey } from '../lib/api';
import { messageFor } from '../lib/messages';
import { useI18n } from '../lib/i18n';
import { useSession } from '../lib/session';
import { Score } from '../components/Score';
import { SongCard } from '../components/SongCard';
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
  /**
   * Published songs, so the landing page can be heard before anyone signs up.
   *
   * `null` until answered and `[]` when there are none; neither renders, so a
   * fresh install never shows an empty shelf and a visitor never sees it flash
   * in. A failure is swallowed: this strip is an invitation, not the task, and
   * an error banner under a working composer would claim the page is broken.
   */
  const [showcase, setShowcase] = useState<TrackView[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ items: TrackView[] }>('/v1/explore')
      .then((r) => {
        if (!cancelled) setShowcase(r.items);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const navigate = useNavigate();
  /**
   * Hydrated lazily rather than in an effect.
   *
   * The previous shape — load in one effect, save in another keyed on
   * `prompt` — destroyed the draft it was meant to keep: on mount the save
   * effect runs in the same commit as the load, still holding the initial
   * empty string, and writes it over the stored draft. StrictMode's double
   * mount then made the loss deterministic, and any remount (navigating back
   * to the home screen) reproduced it in production too. Reading the stored
   * value as the initial state removes the race and the empty-textarea flash
   * with it.
   */
  const [prompt, setPrompt] = useState(() => {
    try {
      return localStorage.getItem(DRAFT_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [activeMood, setActiveMood] = useState<string | null>(null);
  const [instrumental, setInstrumental] = useState(false);
  const [feedbackKey, setFeedbackKey] = useState<{ key: string; params?: Record<string, string | number> } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const idemKey = useRef(newIdempotencyKey());
  /** The self-rescheduling poll timer, so the effect cleanup can actually stop it. */
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The backoff, in a ref because it has to outlive the effect.
   *
   * It was a local. Every tick calls `setJob`, `job` is in this effect's
   * dependencies, so the effect tore down and re-ran on each poll and the
   * local went back to 2000 — the `* 1.6` line ran, scheduled a longer timer,
   * and cleanup immediately cleared it. Measured before fixing: 14 polls in a
   * 26-second window, every gap exactly 2.0s, against a comment that said
   * "with backoff". A working one makes about 6 in the same window.
   */
  const pollDelay = useRef(2000);
  /** Which job the backoff belongs to; a new one starts at the floor again. */
  const polledJobId = useRef<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  const credits = entitlements?.availableUnits ?? me?.creditsAvailable ?? 0;

  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, prompt);
    } catch {
      /* private browsing */
    }
  }, [prompt]);

  const written = prompt.trim().length > 0;
  /** Signed in, has written something, and has nothing left to spend. */
  const outOfCredits = !!me && credits < 1;
  const canSubmit = written && !submitting && !outOfCredits;

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
      /*
       * The server's own English, printed to a Japanese or Chinese visitor.
       *
       * `err.message` here is the API's developer-facing text — "network
       * unreachable", "this idempotency key was already used for a different
       * request". Every other surface routes failures through `messageFor`,
       * which picks a translated line by error code. The landing page is the
       * first thing a new user touches, and it was the one place that did not.
       */
      const msg = messageFor(err);
      setError(t(msg.titleKey));
      /*
       * And rotate the key on a reuse conflict. The key is minted once per
       * mount, so without this a single 409 wedged this composer for good: the
       * body had changed, the server kept refusing the stale key, and no
       * amount of editing or re-pressing could ever produce a song again until
       * the page was reloaded. `Create` has always rotated here.
       */
      if (err instanceof ApiError && err.code === 'IDEMPOTENCY_KEY_REUSED') {
        idemKey.current = newIdempotencyKey();
      }
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * Back to the composer after a failed take.
   *
   * The prompt is deliberately kept: the failure was not the writer's doing,
   * and the error copy for these codes says the credit was not spent and to
   * try again — which needs somewhere to try again from. A fresh idempotency
   * key is minted so the retry is a new request rather than a replay that
   * would be deduplicated onto the job that just failed.
   */
  const startAnother = () => {
    setJob(null);
    setError(null);
    idemKey.current = newIdempotencyKey();
  };

  // Poll the job to terminal state, then hand over to the song page.
  useEffect(() => {
    if (!job || ['done', 'failed'].includes(job.phase)) {
      if (job?.phase === 'done' && job.trackId) {
        navigate(`/song/${job.trackId}`, { replace: true });
      } else if (job?.phase === 'failed') {
        // A failed generation is refunded server-side. Without this the
        // composer still shows the pre-failure balance, and a user who was
        // down to their last credit is told to buy the one just returned.
        void refreshEntitlements();
      }
      return;
    }

    let cancelled = false;
    if (polledJobId.current !== job.jobId) {
      polledJobId.current = job.jobId;
      pollDelay.current = 2000;
    }
    const tick = async () => {
      if (cancelled) return;
      try {
        const next = await apiFetch<JobView>(`/v1/jobs/${job.jobId}`);
        if (cancelled) return;
        setJob(next);
      } catch {
        /* transient poll failure */
      }
      if (cancelled) return;
      if (pollDelay.current < 10000) pollDelay.current = Math.min(pollDelay.current * 1.6, 10000);
      // Held in a ref, not a local: the previous shape lost this handle, so
      // cleanup could only ever clear the *first* timer. Every `setJob` then
      // re-ran the effect and started another chain beside the one still
      // running, and a surviving chain could revive a job the user had
      // already dismissed.
      pollTimer.current = setTimeout(tick, pollDelay.current);
    };
    pollTimer.current = setTimeout(tick, pollDelay.current);
    return () => {
      cancelled = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [job, navigate, refreshEntitlements]);


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
          {failed && (
            <button type="button" className="btn btn--primary" onClick={startAnother}>
              {t('wait.tryAgain')}
            </button>
          )}
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
                {outOfCredits ? t('composer.outOfCredits') : t('composer.cost')}
                <br />
                {me ? t('composer.credits', { n: credits }) : t('composer.creditsLogin')}
              </span>
              {outOfCredits ? (
                // The draft is already in localStorage, so it survives the
                // trip to checkout and back; say so, or nobody risks leaving.
                <Link to="/pricing?from=/" className="btn btn--primary">
                  {t('composer.getCredits')}
                  <span aria-hidden="true">↗</span>
                </Link>
              ) : (
                <button type="button" className="btn btn--primary" onClick={submit} disabled={!canSubmit}>
                  {submitting ? t('composer.submitting') : t('composer.submit')}
                  <span aria-hidden="true">↗</span>
                </button>
              )}
            </div>
            <p className="composer__feedback" aria-live="polite">
              {error ??
                (outOfCredits
                  ? t('composer.draftKept')
                  : feedbackKey
                  ? t(feedbackKey.key, feedbackKey.params)
                  : instrumental
                    ? t('composer.instrumentalHint')
                    : t('composer.vocalsHint'))}
            </p>
          </div>

          {/* The score echoes what is typed above it. It used to sit between the
              headline and the composer, and at 180px it was what pushed the
              composer below the fold (and under the player bar) on a laptop. */}
          <Score text={prompt} ghost={t('composer.placeholder')} className="hero__score" height={150} />
        </div>

      </section>

      {showcase && showcase.length > 0 && (
        <section className="showcase" aria-labelledby="showcase-heading">
          <div className="showcase__head">
            <h2 id="showcase-heading">{t('home.showcase.title')}</h2>
            <p className="showcase__sub">{t('home.showcase.sub')}</p>
          </div>
          <div className="showcase__row">
            {showcase.map((song, i) => (
              <SongCard key={song.trackId} song={song} queue={showcase} index={i} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
