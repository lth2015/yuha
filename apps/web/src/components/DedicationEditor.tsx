import { useEffect, useRef, useState } from 'react';
import {
  DEDICATION_NOTE_MAX,
  DEDICATION_TO_MAX,
  OCCASIONS,
  type Dedication,
  type Occasion,
} from '@yuha/contracts';
import { apiFetch } from '../lib/api';
import { clampToCodePoints } from '../lib/codepoints';
import { useI18n } from '../lib/i18n';
import { ErrorNotice } from './common';

/**
 * The owner correcting who a song is for (POST /v1/tracks/:id/dedication).
 *
 * The occasion used to be preselected, and an anniversary song went out as
 * 「お誕生日おめでとう」 on its page and on its X card, with nothing to do
 * about it but make another song. The same three fields as /create, opened
 * in place over the dedication they replace. What the song already sings is
 * not touched, and the editor says so: a corrected name above lyrics that
 * still sing the old one should not surprise the person who fixed it.
 */
export function DedicationEditor(props: {
  trackId: string;
  dedication: Dedication;
  onSaved: (d: Dedication) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [to, setTo] = useState(props.dedication.to);
  const [occasion, setOccasion] = useState<Occasion>(props.dedication.occasion);
  const [note, setNote] = useState(props.dedication.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);

  const save = async () => {
    if (!to.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ dedication: Dedication }>(`/v1/tracks/${props.trackId}/dedication`, {
        method: 'POST',
        body: { to: to.trim(), occasion, note: note.trim() },
      });
      props.onSaved(res.dedication);
    } catch (err) {
      // Stay open with what was typed: a refusal names the field to fix.
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="song-gift-edit stack"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          props.onCancel();
        }
      }}
    >
      <label htmlFor="gift-edit-to">{t('create.gift.to')}</label>
      <input
        id="gift-edit-to"
        ref={first}
        type="text"
        value={to}
        onChange={(e) => setTo(clampToCodePoints(e.target.value, DEDICATION_TO_MAX))}
        autoComplete="off"
      />
      <span className="studio__gift-label" id="gift-edit-occasion">
        {t('create.gift.occasion')}
      </span>
      <div className="composer__presets-row" role="group" aria-labelledby="gift-edit-occasion">
        {OCCASIONS.map((o) => (
          <button
            key={o}
            type="button"
            className={`chip chip--btn${occasion === o ? ' is-on' : ''}`}
            aria-pressed={occasion === o}
            onClick={() => setOccasion(o)}
          >
            {t(`gift.occasion.${o}`)}
          </button>
        ))}
      </div>
      <label htmlFor="gift-edit-note">{t('create.gift.note')}</label>
      <input
        id="gift-edit-note"
        type="text"
        value={note}
        onChange={(e) => setNote(clampToCodePoints(e.target.value, DEDICATION_NOTE_MAX))}
        autoComplete="off"
      />
      <p className="small muted">{t('song.gift.edit.note')}</p>
      <ErrorNotice error={error} />
      <div className="song-spread__rename-actions">
        <button type="submit" className="btn btn--primary btn--sm" disabled={busy || !to.trim()}>
          {busy ? t('song.rename.saving') : t('song.rename.save')}
        </button>
        <button type="button" className="text-action" onClick={props.onCancel} disabled={busy}>
          {t('song.rename.cancel')}
        </button>
      </div>
    </form>
  );
}
