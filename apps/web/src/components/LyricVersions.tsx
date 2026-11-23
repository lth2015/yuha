import { useState } from 'react';
import type { LyricDraftResponse } from '@yuha/contracts';
import { apiFetch } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { ErrorNotice } from './common';

/**
 * Three versions of the lyrics before any credit is spent
 * (docs/LYRIC_COWRITE_SPEC.md): plain, in pictures, as a story. Picking one
 * puts it in the lyrics box, switched to "my own words", to be edited.
 *
 * Literal keys below so check:i18n sees each in use.
 */
const ANGLE_LABEL: Record<string, string> = {
  plain: 'cowrite.angle.plain',
  images: 'cowrite.angle.images',
  story: 'cowrite.angle.story',
};

export function LyricVersions({
  prompt,
  styles,
  durationSeconds,
  onPick,
}: {
  prompt: string;
  styles: string[];
  durationSeconds: number | 'auto';
  onPick: (lyrics: string) => void;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<'idle' | 'writing'>('idle');
  const [versions, setVersions] = useState<NonNullable<LyricDraftResponse['variants']>>([]);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const written = prompt.trim().length > 0;

  const write = async () => {
    setState('writing');
    setError(null);
    try {
      const res = await apiFetch<LyricDraftResponse>('/v1/lyrics/draft', {
        method: 'POST',
        body: { prompt: prompt.trim(), styles, durationSeconds, variants: 3 },
      });
      setVersions(res.variants ?? [{ angle: 'plain', lyrics: res.lyrics }]);
      setRemaining(res.remaining);
    } catch (err) {
      setError(err);
    } finally {
      setState('idle');
    }
  };

  return (
    <div className="lyric-versions">
      <div className="lyric-versions__ask">
        <button
          type="button"
          className="btn btn--sm"
          disabled={!written || state === 'writing' || remaining === 0 || (remaining !== null && remaining < 3)}
          aria-busy={state === 'writing'}
          onClick={() => void write()}
        >
          {state === 'writing' ? t('cowrite.writing') : t('cowrite.cta')}
        </button>
        <span className="lyric-versions__hint">
          {!written ? t('cowrite.needPrompt') : remaining !== null ? t('cowrite.left', { n: remaining }) : t('cowrite.hint')}
        </span>
      </div>
      <ErrorNotice error={error} />
      {versions.length > 0 && (
        <ol className="lyric-versions__list">
          {versions.map((v) => (
            <li key={v.angle} className="lyric-versions__card">
              <strong>{t(ANGLE_LABEL[v.angle] ?? 'cowrite.angle.plain')}</strong>
              <pre className="lyric-versions__text">{v.lyrics}</pre>
              <button type="button" className="btn btn--primary btn--sm" onClick={() => onPick(v.lyrics)}>
                {t('cowrite.use')}
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
