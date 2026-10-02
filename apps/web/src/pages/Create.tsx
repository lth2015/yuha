import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ENERGY_LEVELS,
  LYRICS_MAX_CODEPOINTS,
  MAX_STYLE_TAGS,
  PROMPT_MAX_CODEPOINTS,
  STYLE_TAG_MAX_LENGTH,
  type JobView,
  type TrackView,
  type VoiceChoice,
} from '@yuha/contracts';
import { ApiError, apiFetch, newIdempotencyKey } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { JOB_PHASES as PHASE_STEPS, fractionOfPhase } from '../lib/phases';
import { Score } from '../components/Score';
import { useSession } from '../lib/session';
import { ErrorNotice, Loading } from '../components/common';
import { SongCard } from '../components/SongCard';

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
  /**
   * Who writes the words.
   *
   * Lyrics used to live inside "more settings", collapsed, next to visibility
   * and energy — sorted by how advanced the control is rather than by what the
   * writer came to do. It is the one input the product has real control over,
   * and the capability was invisible unless you opened a drawer. This makes the
   * choice itself visible; the box only appears once it has been made.
   */
  lyricsBy: 'ai' | 'me';
  lyrics: string;
  styles: string[];
  voice: VoiceChoice;
  instrumental: boolean;
  energy: number;
  durationSeconds: 30 | 60 | 120 | 180 | 240 | 'auto';
  visibility: 'private' | 'public';
}

const DEFAULT_DRAFT: Draft = {
  title: '',
  prompt: '',
  lyricsBy: 'ai',
  lyrics: '',
  styles: [],
  voice: 'auto',
  instrumental: false,
  energy: 0.5,
  durationSeconds: 120,
  visibility: 'private',
};

/**
 * Section markers offered as one-tap inserts.
 *
 * The label is the creator's own language and the marker is written in it —
 * a Chinese creator gets `[副歌]`, which is what they then see on the song
 * page. The music model is given the English tag instead; `withCanonicalSections`
 * does that translation at the wire, so the two needs never have to agree.
 */
const SECTION_PRESETS = ['intro', 'verse', 'chorus', 'bridge', 'rap', 'interlude'] as const;

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

/**
 * Four ways in, for the creator who opened this page with nothing in mind.
 *
 * The scenes are the four the intent schema actually knows
 * (`night_walk | daily_log | outfit | gaming`), not four invented for the UI:
 * a preset that describes something the model has no category for would be a
 * promise the pipeline cannot keep.
 *
 * Each one fills the description, the styles, the length and the vocal mode
 * together, because those are the four decisions that stop someone who has
 * never made a song before — and a half-filled form is not an on-ramp.
 */
const PRESETS: Array<{
  nameKey: string;
  promptKey: string;
  styles: string[];
  durationSeconds: Draft['durationSeconds'];
  instrumental: boolean;
}> = [
  // The keys are spelled out rather than built from a short id on purpose:
  // `scripts/check-i18n.mjs` proves every key a file uses is defined in all
  // three dictionaries, and it can only do that for keys it can see.
  {
    nameKey: 'create.presets.nightWalk.name',
    promptKey: 'create.presets.nightWalk.prompt',
    styles: ['lofi', 'ambient'],
    durationSeconds: 120,
    instrumental: true,
  },
  {
    nameKey: 'create.presets.commute.name',
    promptKey: 'create.presets.commute.prompt',
    styles: ['acoustic', 'pop'],
    durationSeconds: 60,
    instrumental: false,
  },
  {
    nameKey: 'create.presets.outfit.name',
    promptKey: 'create.presets.outfit.prompt',
    styles: ['trap', 'hyperpop'],
    durationSeconds: 30,
    instrumental: false,
  },
  {
    nameKey: 'create.presets.gaming.name',
    promptKey: 'create.presets.gaming.prompt',
    styles: ['synthwave', 'dnb'],
    durationSeconds: 120,
    instrumental: true,
  },
];

const VOICES: VoiceChoice[] = ['auto', 'female', 'male', 'duet', 'choir'];

const DURATIONS: Array<{ value: Draft['durationSeconds']; label: string }> = [
  { value: 'auto', label: '' },
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
    if (!saved) return DEFAULT_DRAFT;
    const stored = { ...DEFAULT_DRAFT, ...(JSON.parse(saved) as Partial<Draft>) };
    /*
     * Drafts written before `lyricsBy` existed carry lyrics and no choice, and
     * the default is 'ai' — which would quietly drop the words someone had
     * already written from the request. Having lyrics *was* the choice back
     * then, so read it that way.
     */
    if (stored.lyrics.trim() && !(JSON.parse(saved) as Partial<Draft>).lyricsBy) {
      stored.lyricsBy = 'me';
    }
    return stored;
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
  // Lyrics are not in this panel any more; counting them here would put a
  // badge on a drawer that no longer holds what the badge is about.
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
  const writesOwnLyrics = draft.lyricsBy === 'me' && !draft.instrumental;
  const [more, setMore] = useState(() => advancedTouched(readStoredDraft()) > 0);
  const [job, setJob] = useState<JobView | null>(null);
  const [result, setResult] = useState<TrackView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const [editSource, setEditSource] = useState<(TrackView & { lyrics: string | null }) | null>(null);
  /**
   * The creator's last few songs, under the composer.
   *
   * `null` means "not answered yet" and an empty array means "answered, and
   * there are none" — the strip renders in neither case, so a first-time
   * creator never sees an empty shelf and a returning one never sees it flash
   * in. The library's own empty state is the place that speaks for zero songs.
   */
  const [recent, setRecent] = useState<TrackView[] | null>(null);
  const [instructions, setInstructions] = useState('');
  const [styleInput, setStyleInput] = useState('');
  const lyricsRef = useRef<HTMLTextAreaElement>(null);
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

  /*
   * Anything still generating is in this list too: `/v1/tracks` orders by
   * creation and does not filter by state, so a take that is still running
   * appears at the front and `SongCard` renders its own progress. That is the
   * point — the page should show that something of yours is happening, not
   * just an empty form.
   *
   * A failure here is swallowed on purpose. This strip is context, not the
   * task; an error banner about it would sit next to a working composer and
   * claim the page is broken.
   */
  useEffect(() => {
    if (editTrackId || !me) return;
    let cancelled = false;
    apiFetch<{ items: TrackView[] }>('/v1/tracks?limit=4')
      .then((r) => {
        if (!cancelled) setRecent(r.items);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [editTrackId, me]);

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
    writesOwnLyrics && draft.lyrics.trim() ? 'custom' : 'simple';

  /*
   * The on-ramp gets out of the way once the creator writes their own words.
   *
   * A preset replaces the description outright, which is fine over an empty
   * box or over another preset, and destructive over something someone typed.
   * Rather than ask "are you sure" — this file already carries a scar from
   * silently overwriting a stored draft — the row is simply not offered once
   * the text is the creator's own. It comes back if they clear the box.
   */
  const showPresets = useMemo(
    () =>
      draft.prompt.trim().length === 0 ||
      PRESETS.some((preset) => draft.prompt === t(preset.promptKey)),
    [draft.prompt, t],
  );

  const canSubmit = useMemo(() => {
    if (submitting || credits < 1) return false;
    if (editTrackId) return instructions.trim().length > 0;
    // Mirrors createGenerationRequest: simple mode requires a description,
    // custom mode is satisfied by the lyrics that made it custom.
    return mode === 'custom' || draft.prompt.trim().length > 0;
  }, [submitting, credits, editTrackId, instructions, mode, draft.prompt]);

  /*
   * Why the button is off, when it is off for something the writer can fix.
   *
   * `canSubmit` had three reasons and the button showed none of them: it simply
   * greyed out. With styles, length and voice all chosen it looks finished, so
   * the missing description is invisible and the only number in view is the
   * credit balance — which is how a full balance got read as a credit fault.
   * Submitting is blocked by one thing at a time, so one line is enough.
   *
   * Nothing is said while submitting (the label already says so) or at zero
   * credits (that branch swaps in a link to buy some, with its own note).
   */
  const blockedReason = useMemo(() => {
    if (submitting || credits < 1 || canSubmit) return null;
    return editTrackId ? 'create.needInstructions' : 'create.needPrompt';
  }, [submitting, credits, canSubmit, editTrackId]);

  const promptAtLimit = promptLength >= PROMPT_MAX_CODEPOINTS;
  const lyricsAtLimit = lyricsLength >= LYRICS_MAX_CODEPOINTS;

  /*
   * Which field a refusal is about.
   *
   * The server names the rule it applied; the field follows from that. Without
   * this a refusal was a paragraph above the button and nothing else — the
   * reader had to work out which of two long text areas it meant, after
   * scrolling back up to find them. `lyrics.tooLong` is the only hint that can
   * only mean the lyrics; every other rule runs over whichever field tripped
   * it, and the description is the one in view, so it is the better default.
   */
  const fieldForError = (err: unknown): 'prompt' | 'lyrics' | 'instructions' | null => {
    if (!(err instanceof ApiError)) return null;
    // The server names the field; it is the only side that knows which text it
    // was screening. An older API that does not say falls back to the box in
    // view rather than to nothing.
    const named = (err.details as { field?: string } | undefined)?.field;
    if (named === 'lyrics') return 'lyrics';
    if (named === 'prompt') return editTrackId ? 'instructions' : 'prompt';
    if (err.code === 'PROMPT_BLOCKED') return editTrackId ? 'instructions' : 'prompt';
    return null;
  };

  const toggleStyle = (style: string) => {
    setDraft((d) => ({
      ...d,
      styles: d.styles.includes(style)
        ? d.styles.filter((s) => s !== style)
        : [...d.styles, style].slice(0, MAX_STYLE_TAGS),
    }));
  };

  const customStyles = draft.styles.filter((s) => !STYLE_PRESETS.includes(s));
  const stylesFull = draft.styles.length >= MAX_STYLE_TAGS;

  const addStyle = () => {
    // Collapse internal runs of space so "city  pop" and "city pop" are one tag.
    const tag = styleInput.trim().replace(/\s+/gu, ' ').slice(0, STYLE_TAG_MAX_LENGTH);
    setStyleInput('');
    if (!tag || stylesFull) return;
    // Case-insensitive: the model reads "Lofi" and "lofi" as the same word, so
    // letting both in spends one of six slots on nothing.
    if (draft.styles.some((s) => s.toLowerCase() === tag.toLowerCase())) return;
    setDraft((d) => ({ ...d, styles: [...d.styles, tag] }));
  };

  /**
   * Drops a section marker at the cursor, on a line of its own.
   *
   * On its own line is the whole point: the parser only treats a bracketed
   * line as structure when nothing else shares it, and a marker that ends up
   * mid-line is sung instead.
   */
  const insertSection = (label: string) => {
    const el = lyricsRef.current;
    const tag = `[${label}]`;
    const at = el ? el.selectionStart : draft.lyrics.length;
    const before = draft.lyrics.slice(0, at).replace(/\s+$/u, '');
    const after = draft.lyrics.slice(at).replace(/^\s+/u, '');
    const head = before ? `${before}\n\n` : '';
    const next = [...`${head}${tag}\n${after}`].slice(0, LYRICS_MAX_CODEPOINTS).join('');
    patch({ lyrics: next });
    const caret = head.length + tag.length + 1;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
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
            voice: draft.voice,
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
      /*
       * Move to the field, do not just describe it. WCAG 3.3.1 wants the error
       * identified; identifying it at the top of a form the reader has
       * scrolled past is identification they have to go looking for.
       * `preventScroll` then an explicit scroll, so the field lands with room
       * above it rather than jammed under the sticky header.
       */
      const field = fieldForError(err);
      if (field) {
        // After the re-render that shows the message, so the field is measured
        // in its final position. Plain `focus()` — the browser's own scroll is
        // immediate, lands correctly whatever the scroll container, and honours
        // prefers-reduced-motion without being asked. `scroll-margin-block` on
        // the field keeps it clear of the sticky header. A smooth
        // `scrollIntoView` was tried first and animated for seconds across a
        // long page, with the field still out of view when the message arrived.
        // Lyrics live inside "more settings", which is collapsed by default and
        // unmounts the field — so focusing it did nothing at all, and a refusal
        // about the lyrics pointed at a box that was not on the screen. Open
        // the panel first; the extra frame lets it mount before we reach for it.
        if (field === 'lyrics') setMore(true);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => document.getElementById(field)?.focus()),
        );
      }
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
        {/*
          The band draws the writing this song is made of — all of it.

          It read `prompt || lyrics`, so any description at all, however
          short, hid the lyrics completely. A song written as four hundred
          characters of verse and described as 「中国风 戏腔」 was drawn from
          the six: five notes spread across 880px, which looks like a fault
          rather than like a short description. Measured, not guessed —
          scoreFromText gives 5 notes for that prompt and 73 for the prompt
          and lyrics together.

          Lyrics only when they are actually sung: on an instrumental they
          are not part of the song, and drawing them would be drawing
          something the recording does not contain.
        */}
        <Score
          text={instructions || [draft.prompt, draft.instrumental ? '' : draft.lyrics].filter((t) => t.trim()).join('\n')}
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
          {runtime?.syntheticAudio ? ` · ${t('create.job.demoAudio')}` : ''}
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
              <button
                type="submit"
                className="btn btn--primary btn--lg"
                disabled={!canSubmit}
                aria-describedby={blockedReason ? 'submit-blocked' : undefined}
              >
                {submitting ? t('create.submitting') : t('create.submit')}
              </button>
            </div>
          </div>
          {blockedReason && (
            <p className="composer__feedback" id="submit-blocked">
              {t(blockedReason)}
            </p>
          )}
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
        {showPresets && (
          <div className="composer__presets">
            <span className="composer__presets-label" id="presets-label">
              {t('create.presets.label')}
            </span>
            <div className="composer__presets-row" role="group" aria-labelledby="presets-label">
              {PRESETS.map((preset) => (
                <button
                  key={preset.nameKey}
                  type="button"
                  className={`chip chip--btn chip--preset${draft.prompt === t(preset.promptKey) ? ' is-on' : ''}`}
                  aria-pressed={draft.prompt === t(preset.promptKey)}
                  onClick={() =>
                    patch({
                      prompt: t(preset.promptKey),
                      styles: preset.styles,
                      durationSeconds: preset.durationSeconds,
                      instrumental: preset.instrumental,
                    })
                  }
                >
                  {t(preset.nameKey)}
                </button>
              ))}
            </div>
          </div>
        )}

        <label htmlFor="prompt">{t('create.prompt.simple')}</label>
        <textarea
          id="prompt"
          value={draft.prompt}
          maxLength={PROMPT_MAX_CODEPOINTS}
          onChange={(e) => patch({ prompt: e.target.value })}
          placeholder={t('create.prompt.placeholderSimple')}
          className={promptAtLimit ? 'is-full' : undefined}
          aria-describedby="prompt-format prompt-count"
        />
        <div className={`composer__meta${promptAtLimit ? ' is-full' : ''}`}>
          <span id="prompt-format">{promptAtLimit ? t('create.atLimit') : format}</span>
          <span id="prompt-count" className="num" aria-live="polite">
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
                disabled={stylesFull && !draft.styles.includes(s)}
                onClick={() => toggleStyle(s)}
              >
                {s}
              </button>
            ))}
            {customStyles.map((s) => (
              <button
                key={s}
                type="button"
                className="chip chip--btn is-on"
                aria-pressed={true}
                aria-label={t('create.styles.remove', { s })}
                onClick={() => toggleStyle(s)}
              >
                {s} <span aria-hidden="true">×</span>
              </button>
            ))}
          </div>
          <div className="tag-add">
            <input
              id="style-add"
              type="text"
              value={styleInput}
              maxLength={STYLE_TAG_MAX_LENGTH}
              disabled={stylesFull}
              placeholder={t('create.styles.custom')}
              aria-label={t('create.styles.custom')}
              onChange={(e) => setStyleInput(e.target.value)}
              onKeyDown={(e) => {
                // Without this the form submits: Enter in a lone text input is
                // a form submit, and generating a song is not what Enter means
                // while someone is still naming the styles.
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addStyle();
                }
              }}
            />
            <button type="button" className="btn btn--ghost btn--sm" disabled={stylesFull || !styleInput.trim()} onClick={addStyle}>
              {t('create.styles.add')}
            </button>
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
                  {d.value === 'auto' ? t('create.length.auto') : d.label}
                </button>
              ))}
            </div>
            {draft.durationSeconds === 'auto' && (
              <span className="studio__dial-hint">{t('create.length.auto.hint')}</span>
            )}
          </div>

          {/*
            Who sings. Hidden on an instrumental, because there is nobody to
            choose — a control that cannot affect anything is worse than one
            that is absent. The choice reaches the music service as a word in
            the production brief, which is how that service has always read a
            voice, so none of this needed it redeployed.
          */}
          {!draft.instrumental && (
            <div className="studio__dial">
              <span className="studio__dial-label" id="voice-label">
                {t('create.voice')}
              </span>
              <div className="chips" role="group" aria-labelledby="voice-label">
                {VOICES.map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={`chip chip--btn${draft.voice === v ? ' is-on' : ''}`}
                    aria-pressed={draft.voice === v}
                    onClick={() => patch({ voice: v })}
                  >
                    {t(`create.voice.${v}`)}
                  </button>
                ))}
              </div>
            </div>
          )}

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

        {/*
          Who writes the words, in the open.
          -------------------------------------------------------------------
          This choice used to be implicit — type into a box inside a collapsed
          drawer and the request quietly became `custom`. The capability the
          product is built around was invisible unless you went looking, and
          sorted next to visibility and energy as though it were a preference.
          The control is the choice; the editor appears once it is made.

          Switching back to "written for you" keeps the text. `lyrics` is only
          sent when the mode is custom, so nothing has to be cleared to stop it
          being used — and a draft someone spent ten minutes on survives a
          misclick.
        */}
        {!draft.instrumental && (
          <div className="studio__dial studio__dial--lyricsby">
            <span className="studio__dial-label" id="lyricsby-label">
              {t('create.lyricsBy')}
            </span>
            <div className="seg" role="group" aria-labelledby="lyricsby-label">
              <button
                type="button"
                className={`seg__btn${draft.lyricsBy === 'ai' ? ' is-active' : ''}`}
                aria-pressed={draft.lyricsBy === 'ai'}
                onClick={() => patch({ lyricsBy: 'ai' })}
              >
                {t('create.lyricsBy.ai')}
              </button>
              <button
                type="button"
                className={`seg__btn${draft.lyricsBy === 'me' ? ' is-active' : ''}`}
                aria-pressed={draft.lyricsBy === 'me'}
                onClick={() => patch({ lyricsBy: 'me' })}
              >
                {t('create.lyricsBy.me')}
              </button>
            </div>
            <span className="studio__dial-hint">
              {draft.lyricsBy === 'ai' && draft.lyrics.trim()
                ? t('create.lyricsBy.kept')
                : draft.lyricsBy === 'ai'
                  ? t('create.lyricsBy.aiHint')
                  : t('create.lyrics.hint')}
            </span>
          </div>
        )}

        {writesOwnLyrics && (
          <div>
            <label htmlFor="lyrics">{t('create.lyrics')}</label>
            {/*
              The prompt box carries `maxLength` and this one did not, while
              the counter beside it promised a limit. `canSubmit` does not
              check it either, so pasting a long lyric sheet looked fine all
              the way to a VALIDATION_FAILED after pressing generate.
              Measured in code points, as the counter and the contract are.
            */}
            <textarea
              id="lyrics"
              ref={lyricsRef}
              rows={7}
              value={draft.lyrics}
              onChange={(e) => {
                const next = [...e.target.value].slice(0, LYRICS_MAX_CODEPOINTS).join('');
                patch({ lyrics: next });
              }}
              placeholder={t('create.lyrics.placeholder')}
              aria-describedby="lyrics-hint lyrics-count"
            />
            <div className="chips chips--sections" role="group" aria-labelledby="sections-label">
              <span className="studio__dial-label" id="sections-label">
                {t('create.sections')}
              </span>
              {SECTION_PRESETS.map((id) => (
                <button
                  key={id}
                  type="button"
                  className="chip chip--btn"
                  onClick={() => insertSection(t(`create.section.${id}`))}
                >
                  {t(`create.section.${id}`)}
                </button>
              ))}
            </div>
            <div className={`composer__meta${lyricsAtLimit ? ' is-full' : ''}`}>
              <span id="lyrics-hint">{lyricsAtLimit ? t('create.atLimit') : t('create.lyrics.hint')}</span>
              <span id="lyrics-count" className="num" aria-live="polite">
                {lyricsLength} / {LYRICS_MAX_CODEPOINTS}
              </span>
            </div>
          </div>
        )}

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

            </div>

            {/*
              Three buttons, not a slider. `energy` reaches the music service
              as a float and is immediately compressed into one of three
              words, so a percentage readout promised a precision that nothing
              downstream could act on — and its default, 50%, sat in the band
              that adds nothing at all. See ENERGY_LEVELS.
            */}
            <div className="studio__dial">
              <span className="studio__dial-label" id="energy-label">
                {t('create.energy')}
              </span>
              <div className="chips" role="group" aria-labelledby="energy-label">
                {ENERGY_LEVELS.map((level) => (
                  <button
                    key={level.id}
                    type="button"
                    className={`chip chip--btn${draft.energy === level.value ? ' is-on' : ''}`}
                    aria-pressed={draft.energy === level.value}
                    onClick={() => patch({ energy: level.value })}
                  >
                    {t(`create.energy.${level.id}`)}
                  </button>
                ))}
              </div>
              <span className="studio__dial-hint">{t('create.energy.hint')}</span>
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

        <SubmitError error={error} />

        <div className="composer__row studio__submit">
          {balanceLine}
          {credits < 1 ? (
            <Link to="/pricing?from=/create" className="btn btn--primary btn--lg">
              {t('create.getCredits')}
              <span aria-hidden="true">↗</span>
            </Link>
          ) : (
            <button
              type="submit"
              className="btn btn--primary btn--lg"
              disabled={!canSubmit}
              aria-describedby={blockedReason ? 'submit-blocked' : undefined}
            >
              {submitting ? t('create.submitting') : t('create.submit')}
            </button>
          )}
        </div>
        {blockedReason && (
          <p className="composer__feedback" id="submit-blocked">
            {t(blockedReason)}
          </p>
        )}
        {outOfCreditsNote}
        <p className="composer__feedback">{t('create.guarantee')}</p>
      </form>

      {recent && recent.length > 0 && (
        <section className="studio__recent" aria-labelledby="recent-heading">
          <div className="studio__recent-head">
            <h2 id="recent-heading">{t('create.recent.title')}</h2>
            <Link to="/library" className="studio__recent-all">
              {t('create.recent.all')}
            </Link>
          </div>
          <div className="studio__recent-row">
            {recent.map((song, i) => (
              <SongCard key={song.trackId} song={song} queue={recent} index={i} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
