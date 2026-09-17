import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  LYRICS_MAX_CODEPOINTS,
  PROMPT_MAX_CODEPOINTS,
  type JobView,
  type TrackView,
} from '@loopscene/contracts';
import { ApiError, apiFetch, newIdempotencyKey } from '../lib/api';
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

const PHASE_STEPS: Array<{ key: JobView['phase']; label: string }> = [
  { key: 'validating', label: 'Validating' },
  { key: 'queued', label: 'Queued' },
  { key: 'generating', label: 'Generating' },
  { key: 'processing', label: 'Processing' },
  { key: 'verifying', label: 'Verifying' },
  { key: 'done', label: 'Done' },
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
  const { me, entitlements, refreshEntitlements, runtime } = useSession();
  const [draft, setDraft] = useState<Draft>(DEFAULT_DRAFT);
  const [job, setJob] = useState<JobView | null>(null);
  const [result, setResult] = useState<TrackView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const idemKey = useRef<string>(newIdempotencyKey());
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const credits = entitlements?.availableUnits ?? me?.creditsAvailable ?? 0;

  useEffect(() => {
    try {
      const saved = localStorage.getItem(DRAFT_KEY);
      if (saved) setDraft({ ...DEFAULT_DRAFT, ...(JSON.parse(saved) as Partial<Draft>) });
    } catch {
      /* ignore a corrupt draft */
    }
  }, []);

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
    if (draft.mode === 'simple') return draft.prompt.trim().length > 0;
    return draft.prompt.trim().length > 0 || draft.styles.length > 0 || draft.lyrics.trim().length > 0;
  }, [submitting, credits, draft]);

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
      const res = await apiFetch<JobView & { deduplicated: boolean }>('/v1/generations', {
        method: 'POST',
        idempotencyKey: idemKey.current,
        body: {
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
        },
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
    const stepIdx = PHASE_STEPS.findIndex((s) => s.key === job.phase);
    return (
      <div className="studio stack stack--loose">
        <h1>{job.title ?? 'Your song'}</h1>
        <div className={`progress-card panel${job.phase === 'failed' ? ' progress-card--failed' : ''}`}>
          {job.phase === 'failed' ? (
            <>
              <h2>Generation failed</h2>
              <p className="small">
                {job.errorCode === 'upstream_rejected'
                  ? 'The model declined this request. No credit was used — try rephrasing.'
                  : 'A technical problem interrupted this song. Your credit was returned automatically.'}
              </p>
              <div className="progress-card__actions">
                <button type="button" className="btn btn--primary" onClick={startAnother}>
                  Start another
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="progress-card__head">
                <div className="spinner" aria-hidden="true" />
                <div>
                  <h2>{PHASE_STEPS[Math.max(stepIdx, 0)]?.label ?? 'Working'}…</h2>
                  <p className="small muted">
                    {job.estimate.delayed
                      ? 'This is taking longer than usual — it is still running. You can leave this page; the song will be in your Library.'
                      : `Usually ready in ${job.estimate.minSeconds}–${job.estimate.maxSeconds}s. You can leave this page — the song will be in your Library.`}
                  </p>
                </div>
              </div>
              <ol className="progress-steps" aria-live="polite">
                {PHASE_STEPS.filter((s) => s.key !== 'failed').map((s, i) => (
                  <li
                    key={s.key}
                    className={i < stepIdx ? 'is-done' : i === stepIdx ? 'is-current' : ''}
                    aria-current={i === stepIdx ? 'step' : undefined}
                  >
                    {s.label}
                  </li>
                ))}
              </ol>
              {result && result.previewUrl && (
                <div className="progress-card__done">
                  <p className="small">
                    ✅ Done — <Link to={`/song/${result.trackId}`}>open “{result.title}”</Link>, or{' '}
                    <button type="button" className="linklike" onClick={startAnother}>
                      start another
                    </button>
                    .
                  </p>
                </div>
              )}
            </>
          )}
        </div>
        <p className="small muted">
          Job {job.jobId.slice(0, 8)} · {job.durationSeconds}s ·{' '}
          {job.instrumental ? 'instrumental' : 'with vocals'}
          {runtime?.demo ? ' · demo audio (synthesised)' : ''}
        </p>
      </div>
    );
  }

  // ------------------------------------------------------------------ studio

  return (
    <div className="studio">
      <div className="studio__head">
        <h1>Create</h1>
        <div className="studio__balance" aria-live="polite">
          <span className="credit-pill">
            <span className="icon icon--note" aria-hidden="true" />
            {credits} credit{credits === 1 ? '' : 's'}
          </span>
          {credits < 1 && (
            <Link to="/pricing" className="btn btn--primary btn--sm">
              Get credits
            </Link>
          )}
        </div>
      </div>

      <ErrorNotice error={error} />

      <form className="studio__grid" onSubmit={submit} noValidate>
        <div className="panel studio__form stack">
          <div className="seg seg--wide" role="tablist" aria-label="Creation mode">
            <button
              type="button"
              role="tab"
              aria-selected={draft.mode === 'simple'}
              className={`seg__btn${draft.mode === 'simple' ? ' is-active' : ''}`}
              onClick={() => patch({ mode: 'simple' })}
            >
              Simple
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={draft.mode === 'custom'}
              className={`seg__btn${draft.mode === 'custom' ? ' is-active' : ''}`}
              onClick={() => patch({ mode: 'custom' })}
            >
              Custom
            </button>
          </div>
          <p className="small muted" style={{ marginTop: 0 }}>
            {draft.mode === 'simple'
              ? 'Describe the song; the studio handles the rest.'
              : 'Your lyrics, your style tags — full control.'}
          </p>

          {draft.mode === 'custom' && (
            <div>
              <label htmlFor="title">Title (optional)</label>
              <input
                id="title"
                value={draft.title}
                maxLength={120}
                onChange={(e) => patch({ title: e.target.value })}
                placeholder="Untitled songs still get named automatically"
              />
            </div>
          )}

          <div>
            <label htmlFor="prompt">
              {draft.mode === 'simple' ? 'Describe your song' : 'Description (optional)'}
            </label>
            <textarea
              id="prompt"
              rows={draft.mode === 'simple' ? 5 : 3}
              value={draft.prompt}
              onChange={(e) => patch({ prompt: e.target.value })}
              placeholder={
                draft.mode === 'simple'
                  ? 'A dreamy synthwave night drive, airy female vocals, wistful but hopeful'
                  : 'Slow build, warm analog feel, saxophone outro'
              }
              aria-describedby="prompt-count"
            />
            <div id="prompt-count" className="field-count">
              {promptLength}/{PROMPT_MAX_CODEPOINTS}
            </div>
          </div>

          {draft.mode === 'custom' && (
            <div>
              <label htmlFor="lyrics">Lyrics {draft.instrumental && <span className="muted">(unused while instrumental)</span>}</label>
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
            <label id="styles-label">Styles (up to 6)</label>
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
              <label id="dur-label">Length</label>
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
              <label htmlFor="instrumental">Vocals</label>
              <div className="seg" role="group" aria-label="Vocals">
                <button
                  type="button"
                  className={`seg__btn${draft.instrumental ? ' is-active' : ''}`}
                  aria-pressed={draft.instrumental}
                  onClick={() => patch({ instrumental: true })}
                >
                  Instrumental
                </button>
                <button
                  type="button"
                  className={`seg__btn${!draft.instrumental ? ' is-active' : ''}`}
                  aria-pressed={!draft.instrumental}
                  onClick={() => patch({ instrumental: false })}
                >
                  Sing lyrics
                </button>
              </div>
            </div>
          </div>

          <div>
            <label htmlFor="energy">
              Energy <span className="muted">({Math.round(draft.energy * 100)}%)</span>
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
            <label htmlFor="visibility">Publish to Explore when finished (you can change this anytime)</label>
          </div>
        </div>

        <aside className="panel studio__aside stack">
          <h2 className="studio__aside-title">This generation</h2>
          <dl className="studio__facts">
            <div>
              <dt>Cost</dt>
              <dd>1 credit</dd>
            </div>
            <div>
              <dt>Balance after</dt>
              <dd>{Math.max(credits - 1, 0)} credits</dd>
            </div>
            <div>
              <dt>Length</dt>
              <dd>{DURATIONS.find((d) => d.value === draft.durationSeconds)?.label}</dd>
            </div>
            <div>
              <dt>Vocals</dt>
              <dd>{draft.instrumental ? 'Instrumental' : draft.lyrics.trim() ? 'Your lyrics' : 'AI lyrics'}</dd>
            </div>
            <div>
              <dt>Visibility</dt>
              <dd>{draft.visibility === 'public' ? 'Public on Explore' : 'Private'}</dd>
            </div>
          </dl>
          <button type="submit" className="btn btn--primary btn--lg btn--block" disabled={!canSubmit}>
            {submitting ? 'Submitting…' : 'Create song · 1 credit'}
          </button>
          {credits < 1 && (
            <p className="small">
              Out of credits —{' '}
              <Link to="/pricing">pick a plan</Link> (the Starter Pack is one-time, no subscription).
            </p>
          )}
          <p className="small muted">
            A failed generation never costs a credit. Nothing is shared publicly unless you choose to publish.
          </p>
        </aside>
      </form>
    </div>
  );
}
