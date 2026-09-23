import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  LYRICS_MAX_CODEPOINTS,
  MAX_STYLE_TAGS,
  PROMPT_MAX_CODEPOINTS,
  type JobView,
  type TrackView,
} from '@loopscene/contracts';
import { ApiError, apiFetch, newIdempotencyKey } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useSession } from '../lib/session';
import { ErrorNotice } from '../components/common';

const DRAFT_KEY = 'sonare.draft';

interface Draft {
  mode: 'simple' | 'custom';
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
  mode: 'simple',
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

/** Phase order for the progress rail; the label comes from the dictionary. */
const PHASE_STEPS: Array<JobView['phase']> = [
  'validating',
  'queued',
  'generating',
  'processing',
  'verifying',
  'done',
];

function countCodePoints(s: string): number {
  return [...s].length;
}

/**
 * The Create studio.
 *
 * Simple mode: describe the song; the platform writes the brief. Custom mode:
 * your lyrics and style tags. One credit = one song, shown before submission;
 * the idempotency key is minted when the form is first filled and reused for
 * every retry of that submission, so a double click cannot double charge.
 */
export default function Create() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [params] = useSearchParams();
  const editTrackId = params.get('edit');
  const { me, entitlements, refreshEntitlements, runtime } = useSession();
  const [draft, setDraft] = useState<Draft>(DEFAULT_DRAFT);
  const [job, setJob] = useState<JobView | null>(null);
  const [result, setResult] = useState<TrackView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const [editSource, setEditSource] = useState<TrackView & { lyrics: string | null } | null>(null);
  const [instructions, setInstructions] = useState('');
  const idemKey = useRef<string>(newIdempotencyKey());
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const credits = entitlements?.availableUnits ?? me?.creditsAvailable ?? 0;

  useEffect(() => {
    if (!editTrackId) return;
    // Editing loads the source song and prefills the studio; nothing is
    // submitted until the creator writes instructions and confirms the credit.
    apiFetch<TrackView & { lyrics: string | null }>(`/v1/tracks/${editTrackId}`)
      .then((track) => {
        setEditSource(track);
        setDraft((d) => ({
          ...d,
          mode: 'custom',
          title: d.title || track.title,
          lyrics: track.lyrics ?? d.lyrics,
          styles: track.styles.length ? track.styles : d.styles,
          instrumental: track.vocalMode === 'instrumental',
          durationSeconds: (DURATIONS.find((x) => x.value === Math.round(track.durationSeconds))?.value ??
            d.durationSeconds) as Draft['durationSeconds'],
          visibility: track.visibility,
        }));
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editTrackId]);

  useEffect(() => {
    if (editTrackId) return;
    try {
      const saved = localStorage.getItem(DRAFT_KEY);
      if (saved) setDraft({ ...DEFAULT_DRAFT, ...(JSON.parse(saved) as Partial<Draft>) });
    } catch {
      /* ignore a corrupt draft */
    }
  }, [editTrackId]);

  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      /* private browsing */
    }
  }, [draft]);

  const patch = useCallback((p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p })), []);

  // ---- job polling with backoff (no request is held open waiting for audio)
  useEffect(() => {
    if (!job || ['done', 'failed'].includes(job.phase)) {
      if (job?.phase === 'done' && job.trackId) {
        apiFetch<TrackView>(`/v1/tracks/${job.trackId}`)
          .then(setResult)
          .catch(() => undefined);
      }
      return;
    }
    let delay = 2000;
    const tick = async () => {
      try {
        const next = await apiFetch<JobView>(`/v1/jobs/${job.jobId}`);
        setJob(next);
        if (next.phase === 'done' && next.trackId) {
          void refreshEntitlements();
        }
      } catch {
        /* transient poll failure: keep trying with backoff */
      }
      if (delay < 10000) delay = Math.min(delay * 1.6, 10000);
      pollTimer.current = setTimeout(tick, delay);
    };
    pollTimer.current = setTimeout(tick, delay);
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [job, refreshEntitlements]);

  const promptLength = countCodePoints(draft.prompt);
  const lyricsLength = countCodePoints(draft.lyrics);
  const canSubmit = useMemo(() => {
    if (submitting || credits < 1) return false;
    if (editTrackId) return instructions.trim().length > 0;
    if (draft.mode === 'simple') return draft.prompt.trim().length > 0;
    return draft.prompt.trim().length > 0 || draft.styles.length > 0 || draft.lyrics.trim().length > 0;
  }, [submitting, credits, draft, instructions, editTrackId]);

  const toggleStyle = (style: string) => {
    setDraft((d) => ({
      ...d,
      styles: d.styles.includes(style) ? d.styles.filter((s) => s !== style) : [...d.styles, style].slice(0, 6),
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
            mode: draft.mode,
            ...(draft.title.trim() ? { title: draft.title.trim() } : {}),
            prompt: draft.prompt.trim(),
            ...(draft.mode === 'custom' && draft.lyrics.trim() && !draft.instrumental
              ? { lyrics: draft.lyrics.trim() }
              : {}),
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
    idemKey.current = newIdempotencyKey();
    patch({ title: '', prompt: '', lyrics: '' });
    navigate('/create');
  };

  // ------------------------------------------------------------------ states

  if (job) {
    const stepIdx = PHASE_STEPS.indexOf(job.phase);
    return (
      <div className="studio stack stack--loose">
        <h1>{job.title ?? t('create.defaultTitle')}</h1>
        <div className={`progress-card panel${job.phase === 'failed' ? ' progress-card--failed' : ''}`}>
          {job.phase === 'failed' ? (
            <>
              <h2>{t('create.job.failed')}</h2>
              <p className="small">
                {job.errorCode === 'upstream_rejected'
                  ? t('create.job.failedUpstream')
                  : t('create.job.failedTech')}
              </p>
              <div className="progress-card__actions">
                <button type="button" className="btn btn--primary" onClick={startAnother}>
                  {t('create.job.startAnother')}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="progress-card__head">
                <div className="spinner" aria-hidden="true" />
                <div>
                  <h2>{t(`create.phase.${PHASE_STEPS[Math.max(stepIdx, 0)] ?? 'working'}`)}…</h2>
                  <p className="small muted">
                    {job.estimate.delayed
                      ? t('create.job.delayed')
                      : t('create.job.eta', {
                          min: job.estimate.minSeconds,
                          max: job.estimate.maxSeconds,
                        })}
                  </p>
                </div>
              </div>
              <ol className="progress-steps" aria-live="polite">
                {PHASE_STEPS.map((phase, i) => (
                  <li
                    key={phase}
                    className={i < stepIdx ? 'is-done' : i === stepIdx ? 'is-current' : ''}
                    aria-current={i === stepIdx ? 'step' : undefined}
                  >
                    {t(`create.phase.${phase}`)}
                  </li>
                ))}
              </ol>
              {result && result.previewUrl && (
                <div className="progress-card__done">
                  <p className="small">
                    <span className="icon icon--check" aria-hidden="true" /> {t('create.job.doneOpen')}{' '}
                    <Link to={`/song/${result.trackId}`}>
                      {t('create.job.open', { title: result.title })}
                    </Link>
                    {t('create.job.or')}{' '}
                    <button type="button" className="linklike" onClick={startAnother}>
                      {t('create.job.startAnother')}
                    </button>
                    .
                  </p>
                </div>
              )}
            </>
          )}
        </div>
        <p className="small muted">
          {job.jobId.slice(0, 8)} · {job.durationSeconds}s ·{' '}
          {job.instrumental ? t('create.vocals.instrumental') : t('composer.vocals')}
          {runtime?.demo ? ` · ${t('create.job.demoAudio')}` : ''}
        </p>
      </div>
    );
  }

  // ------------------------------------------------------------------ studio

  return (
    <div className="studio">
      {editSource && (
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
      )}
      <div className="studio__head">
        <h1>{editSource ? t('create.h1.edit') : t('create.h1')}</h1>
        <div className="studio__balance" aria-live="polite">
          <span className="credit-pill">
            <span className="icon icon--note" aria-hidden="true" />
            {t('create.credits', { n: credits })}
          </span>
          {credits < 1 && (
            <Link to="/pricing" className="btn btn--primary btn--sm">
              {t('create.getCredits')}
            </Link>
          )}
        </div>
      </div>

      <ErrorNotice error={error} />

      <form className="studio__grid" onSubmit={submit} noValidate>
        <div className="panel studio__form stack">
          {editSource && (
            <div>
              <label htmlFor="instructions">{t('create.edit.label')}</label>
              <textarea
                id="instructions"
                rows={3}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder={t('create.edit.placeholder')}
                required
              />
            </div>
          )}
          <div className="seg seg--wide" role="tablist" aria-label={t('create.mode')}>
            <button
              type="button"
              role="tab"
              aria-selected={draft.mode === 'simple'}
              className={`seg__btn${draft.mode === 'simple' ? ' is-active' : ''}`}
              onClick={() => patch({ mode: 'simple' })}
            >
              {t('create.mode.simple')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={draft.mode === 'custom'}
              className={`seg__btn${draft.mode === 'custom' ? ' is-active' : ''}`}
              onClick={() => patch({ mode: 'custom' })}
            >
              {t('create.mode.custom')}
            </button>
          </div>
          <p className="small muted" style={{ marginTop: 0 }}>
            {draft.mode === 'simple' ? t('create.mode.simpleHint') : t('create.mode.customHint')}
          </p>

          {draft.mode === 'custom' && (
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
          )}

          <div>
            <label htmlFor="prompt">
              {draft.mode === 'simple' ? t('create.prompt.simple') : t('create.prompt.custom')}
            </label>
            <textarea
              id="prompt"
              rows={draft.mode === 'simple' ? 5 : 3}
              value={draft.prompt}
              onChange={(e) => patch({ prompt: e.target.value })}
              placeholder={
                draft.mode === 'simple'
                  ? t('create.prompt.placeholderSimple')
                  : t('create.prompt.placeholderCustom')
              }
              aria-describedby="prompt-count"
            />
            <div id="prompt-count" className="field-count">
              {promptLength}/{PROMPT_MAX_CODEPOINTS}
            </div>
          </div>

          {draft.mode === 'custom' && (
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
                aria-describedby="lyrics-count"
              />
              <div id="lyrics-count" className="field-count">
                {lyricsLength}/{LYRICS_MAX_CODEPOINTS}
              </div>
            </div>
          )}

          <div>
            <label id="styles-label">{t('create.styles', { n: MAX_STYLE_TAGS })}</label>
            <div className="chips" role="group" aria-labelledby="styles-label">
              {STYLE_PRESETS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`chip chip--btn${draft.styles.includes(s) ? ' is-on' : ''}`}
                  aria-pressed={draft.styles.includes(s)}
                  onClick={() => toggleStyle(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="studio__row">
            <div>
              <label id="dur-label">{t('create.length')}</label>
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

            <div>
              <label htmlFor="instrumental">{t('create.vocals')}</label>
              <div className="seg" role="group" aria-label={t('create.vocals')}>
                <button
                  type="button"
                  className={`seg__btn${draft.instrumental ? ' is-active' : ''}`}
                  aria-pressed={draft.instrumental}
                  onClick={() => patch({ instrumental: true })}
                >
                  {t('create.vocals.instrumental')}
                </button>
                <button
                  type="button"
                  className={`seg__btn${!draft.instrumental ? ' is-active' : ''}`}
                  aria-pressed={!draft.instrumental}
                  onClick={() => patch({ instrumental: false })}
                >
                  {t('create.vocals.sing')}
                </button>
              </div>
            </div>
          </div>

          <div>
            <label htmlFor="energy">
              {t('create.energy')} <span className="muted">({Math.round(draft.energy * 100)}%)</span>
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

        <aside className="panel studio__aside stack">
          <h2 className="studio__aside-title">{t('create.aside.h2')}</h2>
          <dl className="studio__facts">
            <div>
              <dt>{t('create.aside.cost')}</dt>
              <dd>{t('create.aside.costValue')}</dd>
            </div>
            <div>
              <dt>{t('create.aside.balance')}</dt>
              <dd>{t('create.aside.balanceValue', { n: Math.max(credits - 1, 0) })}</dd>
            </div>
            <div>
              <dt>{t('create.length')}</dt>
              <dd>{DURATIONS.find((d) => d.value === draft.durationSeconds)?.label}</dd>
            </div>
            <div>
              <dt>{t('create.vocals')}</dt>
              <dd>
                {draft.instrumental
                  ? t('create.vocals.instrumental')
                  : draft.lyrics.trim()
                    ? t('create.aside.vocalsYours')
                    : t('create.aside.vocalsAi')}
              </dd>
            </div>
            <div>
              <dt>{t('create.aside.visibility')}</dt>
              <dd>
                {draft.visibility === 'public'
                  ? t('create.aside.linkOpen')
                  : t('create.aside.private')}
              </dd>
            </div>
          </dl>
          <button type="submit" className="btn btn--primary btn--lg btn--block" disabled={!canSubmit}>
            {submitting ? t('create.submitting') : t('create.submit')}
          </button>
          {credits < 1 && (
            <p className="small">
              {t('create.outOfCredits')}{' '}
              <Link to="/pricing">{t('create.pickPlan')}</Link>
              {t('create.pickPlanTail')}
            </p>
          )}
          <p className="small muted">
            {t('create.guarantee')}
          </p>
        </aside>
      </form>
    </div>
  );
}
