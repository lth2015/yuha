import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  LYRICS_MAX_CODEPOINTS,
  MAX_STYLE_TAGS,
  PROMPT_MAX_CODEPOINTS,
  type JobView,
  type TrackView,
} from '@yuha/contracts';
import { ApiError, apiFetch, newIdempotencyKey } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { JOB_PHASES as PHASE_STEPS, fractionOfPhase } from '../lib/phases';
import { Score } from '../components/Score';
import { useSession } from '../lib/session';
import { ErrorNotice, Loading } from '../components/common';

/**
 * A failed submission, shown where the creator is looking.
 *
 * `ErrorNotice` used to sit at the top of this page, above the score and the
 * whole composer. On a filled-in form the submit button is a screenful or more
 * below that, so a rejected generation looked exactly like a dead button:
 * nothing moved anywhere near the pointer. That is not hypothetical — an
 * expired session answered 401, the notice rendered off-screen, and the
 * report that came back was "点击生成没有响应".
 *
 * `role="alert"` on the notice was already announcing this to screen readers.
 * This is the sighted half of the same job: put it beside the button, and
 * bring it into view for the case where the form is long enough that even
 * "beside the button" is below the fold.
 */
function SubmitError({ error }: { error: unknown }) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!error) return;
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    box.current?.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' });
  }, [error]);

  if (!error) return null;
  return (
    <div ref={box} className="studio__submit-error">
      <ErrorNotice error={error} />
    </div>
  );
}

const DRAFT_KEY = 'sonare.draft';

interface Draft {
  title: string;
  prompt: string;
  lyrics: string;
  styles: string[];
  instrumental: boolean;
  energy: number;
  durationSeconds: 30 | 60 | 120 | 180 | 240;
  visibility: 'private' | 'public';
}

const DEFAULT_DRAFT: Draft = {
  title: '',
  prompt: '',
  lyrics: '',
  styles: [],
  instrumental: false,
  energy: 0.5,
  durationSeconds: 120,
  visibility: 'private',
};

const STYLE_PRESETS = [
  'lofi',
  'synthwave',
  'trap',
  'pop',
  'acoustic',
  'ambient',
  'dnb',
  'rock',
  'jazz',
  'cinematic',
  'hyperpop',
  'house',
];

const DURATIONS: Array<{ value: Draft['durationSeconds']; label: string }> = [
  { value: 30, label: '0:30' },
  { value: 60, label: '1:00' },
  { value: 120, label: '2:00' },
  { value: 180, label: '3:00' },
  { value: 240, label: '4:00' },
];

function countCodePoints(s: string): number {
  return [...s].length;
}

/** The creator's own stored draft, or the defaults. */
function readStoredDraft(): Draft {
  try {
    const saved = localStorage.getItem(DRAFT_KEY);
    return saved ? { ...DEFAULT_DRAFT, ...(JSON.parse(saved) as Partial<Draft>) } : DEFAULT_DRAFT;
  } catch {
    return DEFAULT_DRAFT;
  }
}

/**
 * How many of the folded-away settings the creator has actually moved. Shown
 * on the closed disclosure, because progressive disclosure must hide controls
 * without hiding *state*: a folded panel holding a non-default setting that
 * the page gives no sign of is a worse failure than the long form it replaced.
 */
function advancedTouched(d: Draft): number {
  let n = 0;
  if (d.title.trim()) n += 1;
  if (d.lyrics.trim()) n += 1;
  if (d.energy !== DEFAULT_DRAFT.energy) n += 1;
  if (d.visibility !== DEFAULT_DRAFT.visibility) n += 1;
  return n;
}

/**
 * The Create studio.
 *
 * One column, and the score above it: the same band the home composer and the
 * waiting screen draw, reading the description as music while it is written.
 * The page it replaces was a two-column form with a sticky summary that
 * restated the controls sitting a few centimetres to its left.
 *
 * Description, style, length and vocals stand alone; title, your own lyrics,
 * energy and visibility fold away. `mode` is no longer a tab the creator has
 * to understand — the server reads it for exactly one thing, whether to pass
 * lyrics through, so it is derived from whether there are lyrics to pass.
 *
 * One credit = one song, shown before submission; the idempotency key is
 * minted when the form is first filled and reused for every retry of that
 * submission, so a double click cannot double charge.
 */
export default function Create() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [params] = useSearchParams();
  const editTrackId = params.get('edit');
  const { me, entitlements, refreshEntitlements, runtime } = useSession();
  /**
   * Hydrated lazily — see the note on the home composer. Loading in one effect
   * while saving in another keyed on the value means the save runs on mount
   * holding DEFAULT_DRAFT and writes it over the stored draft. Here it was
   * worse than losing the draft: the overwrite is valid JSON, so the next
   * mount restores it and the creator's work silently becomes the defaults.
   */
  const [draft, setDraft] = useState<Draft>(() => (editTrackId ? DEFAULT_DRAFT : readStoredDraft()));
  const [more, setMore] = useState(() => advancedTouched(readStoredDraft()) > 0);
  const [job, setJob] = useState<JobView | null>(null);
  const [result, setResult] = useState<TrackView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const [editSource, setEditSource] = useState<(TrackView & { lyrics: string | null }) | null>(null);
  const [instructions, setInstructions] = useState('');
  const idemKey = useRef<string>(newIdempotencyKey());
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
  const credits = entitlements?.availableUnits ?? me?.creditsAvailable ?? 0;

  useEffect(() => {
    if (!editTrackId) return;
    // Editing loads the source song so the studio can name it and state what
    // the rewrite will keep. Nothing is submitted until the creator writes
    // instructions and confirms the credit.
    apiFetch<TrackView & { lyrics: string | null }>(`/v1/tracks/${editTrackId}`)
      .then(setEditSource)
      .catch((err) => setError(err));
  }, [editTrackId]);

  /**
   * Ending a rewrite session, however it ends.
   *
   * `/create?edit=X` → `/create` is the same route, so React Router does not
   * remount and the lazy initializer does not re-run: the component keeps the
   * DEFAULT_DRAFT it chose because an edit id was present at mount. A ref used
   * to guard the save effect instead, and it outlived the edit id — so leaving
   * the rewrite surface by any route other than its own button left the
   * composer showing an empty form while the real draft sat in storage, and
   * every keystroke after that was silently dropped. Reproduced before fixing:
   * type on /create after an edit session and nothing is written.
   */
  useEffect(() => {
    if (editTrackId || !editSource) return;
    setEditSource(null);
    setInstructions('');
    setDraft(readStoredDraft());
  }, [editTrackId, editSource]);

  useEffect(() => {
    // Guarded on `editSource` rather than a ref: it is state, so it clears in
    // the same commit that restores the draft, and no render can slip through
    // holding the rewrite session's empty draft with the guard already down.
    if (editTrackId || editSource) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      /* private browsing */
    }
  }, [draft, editTrackId, editSource]);

  const patch = useCallback((p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p })), []);

  // ---- job polling with backoff (no request is held open waiting for audio)
  useEffect(() => {
    if (!job || ['done', 'failed'].includes(job.phase)) {
      if (job?.phase === 'done' && job.trackId) {
        apiFetch<TrackView>(`/v1/tracks/${job.trackId}`)
          .then(setResult)
          .catch(() => undefined);
      } else if (job?.phase === 'failed') {
        // A failed generation is refunded server-side. Without this the studio
        // still shows the pre-failure balance, and a creator who was down to
        // their last credit is told to buy the one just returned to them.
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
        if (next.phase === 'done' && next.trackId) {
          void refreshEntitlements();
        }
      } catch {
        /* transient poll failure: keep trying with backoff */
      }
      if (cancelled) return;
      if (pollDelay.current < 10000) pollDelay.current = Math.min(pollDelay.current * 1.6, 10000);
      // Held in a ref so cleanup can reach the timer this chain is actually
      // waiting on; a local would leave every re-run's chain alive beside it.
      pollTimer.current = setTimeout(tick, pollDelay.current);
    };
    pollTimer.current = setTimeout(tick, pollDelay.current);
    return () => {
      cancelled = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [job, refreshEntitlements]);

  const promptLength = countCodePoints(draft.prompt);
  const lyricsLength = countCodePoints(draft.lyrics);

  /**
   * The server reads `mode` for exactly one thing: whether to pass the
   * creator's lyrics to the text model (worker/pipeline). So it is that
   * question, not a tab — and instrumental songs have no lyrics to pass.
   */
  const mode: 'simple' | 'custom' =
    draft.lyrics.trim() && !draft.instrumental ? 'custom' : 'simple';

  const canSubmit = useMemo(() => {
    if (submitting || credits < 1) return false;
    if (editTrackId) return instructions.trim().length > 0;
    // Mirrors createGenerationRequest: simple mode requires a description,
    // custom mode is satisfied by the lyrics that made it custom.
    return mode === 'custom' || draft.prompt.trim().length > 0;
  }, [submitting, credits, editTrackId, instructions, mode, draft.prompt]);

  const toggleStyle = (style: string) => {
    setDraft((d) => ({
      ...d,
      styles: d.styles.includes(style)
        ? d.styles.filter((s) => s !== style)
        : [...d.styles, style].slice(0, MAX_STYLE_TAGS),
    }));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const endpoint = editTrackId ? `/v1/tracks/${editTrackId}/edit` : '/v1/generations';
      const body = editTrackId
        ? { instructions: instructions.trim() }
        : {
            mode,
            ...(draft.title.trim() ? { title: draft.title.trim() } : {}),
            prompt: draft.prompt.trim(),
            ...(mode === 'custom' ? { lyrics: draft.lyrics.trim() } : {}),
            styles: draft.styles,
            instrumental: draft.instrumental,
            energy: draft.energy,
            durationSeconds: draft.durationSeconds,
            visibility: draft.visibility,
          };
      const res = await apiFetch<JobView & { deduplicated: boolean }>(endpoint, {
        method: 'POST',
        idempotencyKey: idemKey.current,
        body,
      });
      setJob(res);
      void refreshEntitlements();
    } catch (err) {
      setError(err);
      // A used key means the browser retried a submission that already landed;
      // keep the key only for genuine retries of a failed request.
      if (err instanceof ApiError && err.code === 'IDEMPOTENCY_KEY_REUSED') {
        idemKey.current = newIdempotencyKey();
      }
    } finally {
      setSubmitting(false);
    }
  };

  const startAnother = () => {
    setJob(null);
    setResult(null);
    setError(null);
    idemKey.current = newIdempotencyKey();
    // Leaving an edit session is handled by the effect above, which also
    // covers the ways out that are not this button.
    if (!editTrackId) patch({ title: '', prompt: '', lyrics: '' });
    navigate('/create');
  };

  // ------------------------------------------------------------------ states

  if (job) {
    const failed = job.phase === 'failed';
    /*
     * `done` is a state of its own, not "still recording".
     *
     * This branched on `failed` only, so a finished job kept the "recording in
     * progress" eyebrow and fell through to the ETA line — whose estimate had
     * decayed to zero, printing "通常 0〜0 秒で完成します" under a heading that
     * said the take was still running, next to a link to open the finished
     * song. Seen on the acceptance run; it does not settle, because there is
     * no later state to settle into.
     */
    const done = job.phase === 'done';
    const stepIdx = PHASE_STEPS.indexOf(job.phase as (typeof PHASE_STEPS)[number]);
    return (
      <div className="wait-page" aria-live="polite">
        <p className="eyebrow">
          {failed ? t('wait.failedEyebrow') : done ? t('wait.doneEyebrow') : t('wait.eyebrow')}
        </p>
        <h1 className="wait-page__title">
          {failed ? t('create.job.failed') : (job.title ?? t('create.defaultTitle'))}
        </h1>
        <p className="muted wait-page__sub">
          {failed
            ? job.errorCode === 'upstream_rejected'
              ? t('create.job.failedUpstream')
              : t('create.job.failedTech')
            : done
              ? t('create.job.done')
              : job.estimate.delayed
                ? t('create.job.delayed')
                : t('create.job.eta', {
                    min: job.estimate.minSeconds,
                    max: job.estimate.maxSeconds,
                  })}
        </p>

        {/* The same recording surface as the home screen. There were two
            different progress UIs before, so one job looked like different
            progress depending on where you happened to be watching it. */}
        <Score
          text={instructions || draft.prompt || draft.lyrics}
          progress={failed ? undefined : fractionOfPhase(job.phase)}
          className="wait-page__score"
          height={200}
          label={t('wait.scoreAria')}
        />

        <ol className="wait-page__rail">
          {PHASE_STEPS.map((phase, i) => (
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
          {failed ? (
            <button type="button" className="btn btn--primary" onClick={startAnother}>
              {t('create.job.startAnother')}
            </button>
          ) : (
            <Link to="/library" className="btn">
              {t('wait.goLibrary')}
            </Link>
          )}
          {result && result.previewUrl && (
            <Link to={`/song/${result.trackId}`} className="btn btn--primary">
              {t('create.job.open', { title: result.title })}
            </Link>
          )}
        </div>

        <p className="small muted" style={{ marginTop: 'var(--s6)' }}>
          {job.jobId.slice(0, 8)} · {job.durationSeconds}s ·{' '}
          {job.instrumental ? t('create.vocals.instrumental') : t('composer.vocals')}
          {runtime?.demo ? ` · ${t('create.job.demoAudio')}` : ''}
        </p>
      </div>
    );
  }

  const balanceLine = (
    <span className="composer__cost">
      {t('create.aside.costValue')}
      <br />
      {t('create.balanceAfter', { n: Math.max(credits - 1, 0) })}
    </span>
  );

  const head = (
    <div className="studio__head">
      <h1>{editTrackId ? t('create.h1.edit') : t('create.h1')}</h1>
      <div className="studio__balance" aria-live="polite">
        <span className="credit-pill">
          <span className="icon icon--note" aria-hidden="true" />
          {t('create.credits', { n: credits })}
        </span>
        {credits < 1 && (
          <Link to="/pricing?from=/create" className="btn btn--primary btn--sm">
            {t('create.getCredits')}
          </Link>
        )}
      </div>
    </div>
  );

  const outOfCreditsNote = credits < 1 && (
    <p className="small studio__oop">
      {t('create.outOfCredits')} <Link to="/pricing?from=/create">{t('create.pickPlan')}</Link>
      {t('create.pickPlanTail')}
    </p>
  );

  // -------------------------------------------------------------- edit a song
  /*
   * A rewrite sends the instructions and nothing else: the server keeps the
   * original's length, vocal mode and visibility, and the revision supplies
   * the title, styles and lyrics. The old screen prefilled the whole create
   * form here and let all of it be edited, and every one of those changes was
   * silently discarded at submit — the form said "2:00" was a choice when it
   * was a fact. So the rewrite surface states what carries over instead of
   * offering controls that do nothing.
   */
  if (editTrackId) {
    if (!editSource) {
      return (
        <div className="studio">
          {head}
          <ErrorNotice error={error} />
          {!error && <Loading label={t('create.edit.loading')} />}
        </div>
      );
    }
    const kept = [
      DURATIONS.find((d) => d.value === Math.round(editSource.durationSeconds))?.label ??
        `${Math.round(editSource.durationSeconds)}s`,
      editSource.vocalMode === 'instrumental' ? t('create.vocals.instrumental') : t('composer.vocals'),
      editSource.visibility === 'public' ? t('create.aside.linkOpen') : t('create.aside.private'),
    ].join(' · ');

    return (
      <div className="studio">
        {head}
        <Score
          text={instructions}
          ghost={t('create.edit.placeholder')}
          className="studio__score"
          height={148}
          label={t('create.scoreAria')}
        />
        <form className="composer panel studio__composer" onSubmit={submit} noValidate>
          <div className="studio__edit" role="status">
            <div className="studio__edit-icon" aria-hidden="true">
              <span className="icon icon--edit" />
            </div>
            <div>
              <strong>{t('create.edit.banner', { title: editSource.title })}</strong>
              <p className="small muted" style={{ margin: 0 }}>
                {t('create.edit.hint')}
              </p>
            </div>
          </div>

          <label htmlFor="instructions">{t('create.edit.label')}</label>
          <textarea
            id="instructions"
            value={instructions}
            maxLength={PROMPT_MAX_CODEPOINTS}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder={t('create.edit.placeholder')}
            aria-describedby="instructions-format instructions-count"
            required
          />
          <div className="composer__meta">
            <span id="instructions-format">{t('create.edit.keeps', { kept })}</span>
            <span id="instructions-count" className="num">
              {countCodePoints(instructions)} / {PROMPT_MAX_CODEPOINTS}
            </span>
          </div>

          <SubmitError error={error} />

          <div className="composer__row studio__submit">
            {balanceLine}
            <div className="studio__submit-actions">
              <button type="button" className="btn" onClick={startAnother}>
                {t('create.edit.cancel')}
              </button>
              <button type="submit" className="btn btn--primary btn--lg" disabled={!canSubmit}>
                {submitting ? t('create.submitting') : t('create.submit')}
              </button>
            </div>
          </div>
          {outOfCreditsNote}
          <p className="composer__feedback">{t('create.guarantee')}</p>
        </form>
      </div>
    );
  }

  // ------------------------------------------------------------------ studio

  const touched = advancedTouched(draft);
  const format = t('create.format', {
    length: DURATIONS.find((d) => d.value === draft.durationSeconds)?.label ?? '',
    vocals: draft.instrumental
      ? t('create.vocals.instrumental')
      : draft.lyrics.trim()
        ? t('create.aside.vocalsYours')
        : t('composer.vocals'),
    visibility: draft.visibility === 'public' ? t('create.aside.linkOpen') : t('create.aside.private'),
  });

  return (
    <div className="studio">
      {head}

      {/* Their own words, read as music, before anything else on the page. */}
      <Score
        text={draft.prompt || draft.lyrics}
        ghost={t('create.prompt.placeholderSimple')}
        className="studio__score"
        height={148}
        label={t('create.scoreAria')}
      />

      <form className="composer panel studio__composer" onSubmit={submit} noValidate>
        <label htmlFor="prompt">{t('create.prompt.simple')}</label>
        <textarea
          id="prompt"
          value={draft.prompt}
          maxLength={PROMPT_MAX_CODEPOINTS}
          onChange={(e) => patch({ prompt: e.target.value })}
          placeholder={t('create.prompt.placeholderSimple')}
          aria-describedby="prompt-format prompt-count"
        />
        <div className="composer__meta">
          <span id="prompt-format">{format}</span>
          <span id="prompt-count" className="num">
            {promptLength} / {PROMPT_MAX_CODEPOINTS}
          </span>
        </div>

        <div className="studio__dial studio__dial--styles">
          <span className="studio__dial-label" id="styles-label">
            {t('create.styles', { n: MAX_STYLE_TAGS })}
          </span>
          <div className="chips" role="group" aria-labelledby="styles-label">
            {STYLE_PRESETS.map((s) => (
              <button
                key={s}
                type="button"
                className={`chip chip--btn${draft.styles.includes(s) ? ' is-on' : ''}`}
                aria-pressed={draft.styles.includes(s)}
                disabled={draft.styles.length >= MAX_STYLE_TAGS && !draft.styles.includes(s)}
                onClick={() => toggleStyle(s)}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <div className="studio__dials">
          <div className="studio__dial">
            <span className="studio__dial-label" id="dur-label">
              {t('create.length')}
            </span>
            <div className="chips" role="group" aria-labelledby="dur-label">
              {DURATIONS.map((d) => (
                <button
                  key={d.value}
                  type="button"
                  className={`chip chip--btn${draft.durationSeconds === d.value ? ' is-on' : ''}`}
                  aria-pressed={draft.durationSeconds === d.value}
                  onClick={() => patch({ durationSeconds: d.value })}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>

          <div className="studio__dial">
            <span className="studio__dial-label" id="voc-label">
              {t('create.vocals')}
            </span>
            <div className="seg" role="group" aria-labelledby="voc-label">
              <button
                type="button"
                className={`seg__btn${!draft.instrumental ? ' is-active' : ''}`}
                aria-pressed={!draft.instrumental}
                onClick={() => patch({ instrumental: false })}
              >
                {t('create.vocals.sing')}
              </button>
              <button
                type="button"
                className={`seg__btn${draft.instrumental ? ' is-active' : ''}`}
                aria-pressed={draft.instrumental}
                onClick={() => patch({ instrumental: true })}
              >
                {t('create.vocals.instrumental')}
              </button>
            </div>
          </div>
        </div>

        <div className="studio__more">
          <button
            type="button"
            className="studio__more-toggle"
            aria-expanded={more}
            aria-controls="studio-more"
            onClick={() => setMore((v) => !v)}
          >
            <span className="studio__more-caret" aria-hidden="true" />
            {more ? t('create.more.hide') : t('create.more')}
            {!more && touched > 0 && (
              <span className="studio__more-badge">{t('create.more.count', { n: touched })}</span>
            )}
          </button>

          <div id="studio-more" className="studio__more-panel stack" hidden={!more}>
            <div>
              <label htmlFor="title">{t('create.title')}</label>
              <input
                id="title"
                value={draft.title}
                maxLength={120}
                onChange={(e) => patch({ title: e.target.value })}
                placeholder={t('create.title.placeholder')}
              />
            </div>

            <div>
              <label htmlFor="lyrics">
                {t('create.lyrics')}{' '}
                {draft.instrumental && <span className="muted">{t('create.lyrics.unused')}</span>}
              </label>
              <textarea
                id="lyrics"
                rows={7}
                value={draft.lyrics}
                onChange={(e) => patch({ lyrics: e.target.value })}
                placeholder={'[Verse]\nCity lights blur into gold\n…'}
                disabled={draft.instrumental}
                aria-describedby="lyrics-hint lyrics-count"
              />
              <div className="composer__meta">
                <span id="lyrics-hint">{t('create.lyrics.hint')}</span>
                <span id="lyrics-count" className="num">
                  {lyricsLength} / {LYRICS_MAX_CODEPOINTS}
                </span>
              </div>
            </div>

            <div>
              <label htmlFor="energy">
                {t('create.energy')}{' '}
                <span className="muted num">{Math.round(draft.energy * 100)}%</span>
              </label>
              <input
                id="energy"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={draft.energy}
                onChange={(e) => patch({ energy: Number(e.target.value) })}
              />
            </div>

            <div className="checkbox-row">
              <input
                id="visibility"
                type="checkbox"
                checked={draft.visibility === 'public'}
                onChange={(e) => patch({ visibility: e.target.checked ? 'public' : 'private' })}
              />
              <label htmlFor="visibility">{t('create.visibility')}</label>
            </div>
          </div>
        </div>

        <SubmitError error={error} />

        <div className="composer__row studio__submit">
          {balanceLine}
          {credits < 1 ? (
            <Link to="/pricing?from=/create" className="btn btn--primary btn--lg">
              {t('create.getCredits')}
              <span aria-hidden="true">↗</span>
            </Link>
          ) : (
            <button type="submit" className="btn btn--primary btn--lg" disabled={!canSubmit}>
              {submitting ? t('create.submitting') : t('create.submit')}
            </button>
          )}
        </div>
        {outOfCreditsNote}
        <p className="composer__feedback">{t('create.guarantee')}</p>
      </form>
    </div>
  );
}
