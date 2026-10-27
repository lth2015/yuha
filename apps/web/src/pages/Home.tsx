import { OpenGenerations, QueueStatus } from '../components/GenerationQueue';
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
/**
 * A small framed picture of the page the card opens onto: the same pale hills,
 * still lake, distant sun in the east, koi and drifting petal (apps/air). Drawn
 * at a fixed aspect and cropped, never stretched, and kept beside the words
 * rather than under them, so nothing ever reads as overlapping text.
 */
function AirVignette() {
  return (
    <svg className="air-entry__scene" viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="air-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fbf8f3" />
          <stop offset="1" stopColor="#f6eee4" />
        </linearGradient>
        <linearGradient id="air-water" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#eef0e9" />
          <stop offset="1" stopColor="#f6f6f1" />
        </linearGradient>
        <radialGradient id="air-sun-halo">
          <stop offset="0" stopColor="#f46b45" stopOpacity="0.16" />
          <stop offset="1" stopColor="#f46b45" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="air-haze" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f6f5f0" stopOpacity="0" />
          <stop offset="0.65" stopColor="#f4f3ee" stopOpacity="0.9" />
          <stop offset="1" stopColor="#eef0e9" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="320" height="112" fill="url(#air-sky)" />
      <circle cx="78" cy="74" r="40" fill="url(#air-sun-halo)" />
      <circle cx="78" cy="74" r="12" fill="#ffd3bf" />
      <path d="M0 86 C40 70 70 74 104 80 S170 62 214 72 S280 82 320 74 V112 H0Z" fill="#7b8177" opacity="0.12" />
      <path d="M0 96 C46 86 92 92 136 94 S220 82 262 90 S304 96 320 92 V112 H0Z" fill="#6e7870" opacity="0.15" />
      <path d="M0 104 C60 98 120 103 176 102 S270 97 320 101 V112 H0Z" fill="#61665d" opacity="0.12" />
      <rect y="112" width="320" height="68" fill="url(#air-water)" />
      {/* The shore dissolves into haze on both sides of the waterline. */}
      <rect y="94" width="320" height="26" fill="url(#air-haze)" />
      <g fill="#f46b45">
        <rect x="71" y="116" width="13" height="1" rx="0.5" opacity="0.16" />
        <rect x="66" y="121.5" width="21" height="1" rx="0.5" opacity="0.12" />
        <rect x="74" y="127" width="9" height="1" rx="0.5" opacity="0.09" />
        <rect x="68" y="133" width="15" height="1" rx="0.5" opacity="0.06" />
      </g>
      <g fill="#7b8177" opacity="0.14">
        <rect x="150" y="124" width="70" height="0.8" rx="0.4" />
        <rect x="24" y="146" width="90" height="0.8" rx="0.4" />
        <rect x="190" y="166" width="100" height="0.8" rx="0.4" />
      </g>
      {/* Two koi, seen from above: white with petal markings, and warm gold. */}
      <g transform="translate(196 141) rotate(-16)">
        <path d="M0 0 C-4 -1.5 -8 -5.5 -11 -5 C-9 -2 -9 2 -11 5 C-8 5.5 -4 1.5 0 0 Z" fill="#fbf7f2" opacity="0.85" />
        <path d="M0 0 C1 -4.5 9 -6 17 -5 C23 -4.2 27 -2 27.6 0 C27 2 23 4.2 17 5 C9 6 1 4.5 0 0 Z" fill="#fdfaf6" stroke="#6e766e" strokeOpacity="0.22" strokeWidth="0.45" />
        <ellipse cx="18.5" cy="-1" rx="4.6" ry="2.4" fill="#f06842" opacity="0.78" />
        <ellipse cx="9.5" cy="1" rx="3.6" ry="1.9" fill="#f06842" opacity="0.62" />
        <circle cx="25" cy="-1.7" r="0.45" fill="#2c302b" opacity="0.6" />
        <circle cx="25" cy="1.7" r="0.45" fill="#2c302b" opacity="0.6" />
      </g>
      <g transform="translate(248 161) rotate(166) scale(0.85)">
        <path d="M0 0 C-4 -1.5 -8 -5.5 -11 -5 C-9 -2 -9 2 -11 5 C-8 5.5 -4 1.5 0 0 Z" fill="#f7c493" opacity="0.8" />
        <path d="M0 0 C1 -4.5 9 -6 17 -5 C23 -4.2 27 -2 27.6 0 C27 2 23 4.2 17 5 C9 6 1 4.5 0 0 Z" fill="#f4ab72" />
        <circle cx="25" cy="-1.7" r="0.5" fill="#2c302b" opacity="0.55" />
        <circle cx="25" cy="1.7" r="0.5" fill="#2c302b" opacity="0.55" />
      </g>
      {/* A petal, the YUHA mark, and two far birds. */}
      <g transform="translate(232 34) rotate(24) scale(0.12)" fill="#f46b45" opacity="0.3">
        <path d="M81 12C83 41 62 71 27 85C31 70 43 55 54 47C66 37 75 24 81 12Z" />
        <path d="M14 24C37 23 53 34 54 49C40 47 22 38 14 24Z" />
      </g>
      <path d="M176 44 q3 -2 5 0 q2 -2 5 0 M190 38 q2 -1.5 4 0 q1.5 -1.5 4 0" fill="none" stroke="#61665d" strokeOpacity="0.35" strokeWidth="0.7" strokeLinecap="round" />
    </svg>
  );
}

/** The iOS shell has no /air page (it ships apps/web only). */
const IOS_BUILD = import.meta.env['VITE_APP_PLATFORM'] === 'ios';

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

  /*
   * A mood chip does two things, and it used to do only one of them.
   *
   * Keeping the user's own words when they click a mood is right and was
   * deliberate — `composer.moodKept` says so. But the handler returned before
   * `setActiveMood`, so the mood itself was dropped: the chip never lit up
   * (`.chip--mood[aria-pressed='true']` is the only pressed style), and
   * `submit` reads `activeMood` for `styles`, so the style was never sent.
   * Somebody who wrote their own description and then chose 夜 got no style
   * at all, with a 12px grey line as the only acknowledgement.
   *
   * Clicking the active chip again clears it, because there was no way to
   * unset a mood once chosen. And typing no longer clears it: a mood is an
   * explicit choice, and losing it to one keystroke was its own surprise.
   *
   * The old guard was written `![MOOD_KEYS].some(() => MOOD_KEYS.some(...))`.
   * The outer array has one element and the callback ignores its arguments,
   * so it ran the inner test exactly once — it worked, by accident, and said
   * nothing about what it meant.
   */
  const pickMood = (mood: (typeof MOOD_KEYS)[number]) => {
    if (mood === activeMood) {
      setActiveMood(null);
      setFeedbackKey(null);
      return;
    }
    const ownWords = prompt.trim().length > 0 && !MOOD_KEYS.some((k) => t(`mood.${k}.text`) === prompt);
    setActiveMood(mood);
    if (ownWords) {
      setFeedbackKey({ key: 'composer.moodKept', params: { mood: t(`mood.${mood}`) } });
      return;
    }
    setPrompt(t(`mood.${mood}.text`));
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
          text={job.prompt}
          progress={failed ? undefined : fractionOfPhase(job.phase)}
          className="wait-page__score"
          height={200}
          label={t('wait.scoreAria')}
        />

        <QueueStatus job={job} onUpdate={setJob} onCancelled={startAnother} />

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
      {me && <OpenGenerations onResume={setJob} />}
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
              onChange={(e) => setPrompt(e.target.value)}
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

      {/* Air composition: a static page beside this app (apps/air), so a plain
          link, not a router one. Not in the iOS build, which does not carry it. */}
      {!IOS_BUILD && (
        <section className="air-entry" aria-labelledby="air-entry-heading">
          <div className="air-entry__text">
            <span className="air-entry__kicker">{t('home.air.kicker')}</span>
            <h2 id="air-entry-heading">{t('home.air.title')}</h2>
            <p>{t('home.air.body')}</p>
            <a className="btn btn--primary air-entry__go" href="/air/index.html">
              {t('home.air.cta')}
            </a>
          </div>
          <AirVignette />
        </section>
      )}

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
