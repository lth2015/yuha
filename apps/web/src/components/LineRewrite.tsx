import { useEffect, useState } from 'react';
import { isSungLine, type LyricLineResponse } from '@yuha/contracts';
import { apiFetch } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { LyricDraftError } from './common';

/**
 * One line said three other ways (docs/LYRIC_LINE_SPEC.md), under the lyrics
 * box: the line is the one the cursor is on, so choosing it is the same
 * gesture as editing it, on a phone as on a desktop.
 *
 * The alternatives belong to the line they were asked for. Moving the cursor
 * to another line, or editing that line, puts them away: an alternative for
 * line 3 must never land on line 4.
 */
export function LineRewrite({
  lyrics,
  line,
  prompt,
  styles,
  onReplace,
}: {
  lyrics: string;
  /** Index into `lyrics.split('\n')` of the line the cursor is on; null before the box was touched. */
  line: number | null;
  prompt: string;
  styles: string[];
  onReplace: (line: number, text: string) => void;
}) {
  const { t } = useI18n();
  const target = line === null ? undefined : lyrics.split('\n')[line];
  const sung = line !== null && isSungLine(target);
  const [asked, setAsked] = useState<{ line: number; text: string; lines: string[] } | null>(null);
  const [state, setState] = useState<'idle' | 'writing'>('idle');
  const [remaining, setRemaining] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);

  // Alternatives for a line that is no longer the one under the cursor, as it was, are put away.
  const current = asked && asked.line === line && asked.text === target ? asked : null;
  useEffect(() => {
    if (asked && !current) setAsked(null);
  }, [asked, current]);

  const ask = async () => {
    if (line === null || !sung) return;
    setState('writing');
    setError(null);
    try {
      const res = await apiFetch<LyricLineResponse>('/v1/lyrics/line', {
        method: 'POST',
        body: { prompt: prompt.trim(), lyrics, line, styles },
      });
      setAsked({ line, text: target!, lines: res.lines });
      setRemaining(res.remaining);
      setState('idle');
    } catch (err) {
      setError(err);
      setState('idle');
    }
  };

  return (
    <div className="line-rewrite">
      <div className="line-rewrite__ask">
        {sung ? (
          <>
            <span className="line-rewrite__target">{t('linefix.target', { line: target!.trim() })}</span>
            <button
              type="button"
              className="btn btn--sm"
              disabled={state === 'writing' || remaining === 0}
              aria-busy={state === 'writing'}
              onClick={() => void ask()}
            >
              {state === 'writing' ? t('linefix.writing') : t('linefix.cta')}
            </button>
          </>
        ) : (
          <span className="line-rewrite__hint">{t('linefix.pick')}</span>
        )}
        {sung && (
          <span className="line-rewrite__hint">
            {remaining !== null ? t('cowrite.left', { n: remaining }) : t('linefix.hint')}
          </span>
        )}
      </div>
      <LyricDraftError error={error} />
      {current && current.lines.length > 0 && (
        <ul className="line-rewrite__list">
          {current.lines.map((alt) => (
            <li key={alt}>
              <button
                type="button"
                className="line-rewrite__alt"
                aria-label={t('linefix.use', { line: alt })}
                onClick={() => {
                  // The box now shows the new line under the cursor; that is the confirmation.
                  onReplace(current.line, alt);
                  setAsked(null);
                }}
              >
                {alt}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
