import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Season } from '@yuha/contracts';
import { useI18n } from '../lib/i18n';

/**
 * The first thing the person a holiday song was written for sees
 * (docs/HOLIDAY_SPEC.md): a present to unwrap at Christmas, a nengajo to turn
 * over at New Year. Chosen by the song's occasion, not by the date, so a
 * Christmas song opened in January still arrives as a present.
 *
 * The tap that opens it is also what starts the song: browsers do not play
 * sound until a person has touched the page, and this is that touch.
 *
 * Once per song per browser: a second visit goes straight to the song. With
 * reduced motion asked for, it opens at once, without snow or sunrise.
 */
const SEEN_KEY = 'yuha.opened';

function seen(trackId: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[]).includes(trackId);
  } catch {
    return false;
  }
}

function remember(trackId: string): void {
  try {
    const all = (JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[]).filter((id) => id !== trackId);
    localStorage.setItem(SEEN_KEY, JSON.stringify([trackId, ...all].slice(0, 50)));
  } catch {
    /* ignore: it simply opens again next time */
  }
}

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

export function HolidayOpening({ trackId, season, to, onOpen }: { trackId: string; season: Season; to: string; onOpen: () => void }) {
  const { t } = useI18n();
  const [stage, setStage] = useState<'closed' | 'opening' | 'gone'>(() => (seen(trackId) ? 'gone' : 'closed'));
  const [afterglow, setAfterglow] = useState(false);

  /*
   * While the present covers the screen, the page under it is out of reach:
   * inert, so Tab cannot walk into links nobody can see, and hidden from
   * screen readers, which would otherwise read the whole page under it.
   */
  const covering = stage !== 'gone';
  useEffect(() => {
    const root = document.getElementById('root');
    if (!covering || !root) return;
    root.setAttribute('inert', '');
    root.setAttribute('aria-hidden', 'true');
    return () => {
      root.removeAttribute('inert');
      root.removeAttribute('aria-hidden');
    };
  }, [covering]);

  useEffect(() => {
    if (stage !== 'opening') return;
    const done = window.setTimeout(() => setStage('gone'), 1200);
    return () => window.clearTimeout(done);
  }, [stage]);

  useEffect(() => {
    if (!afterglow) return;
    const done = window.setTimeout(() => setAfterglow(false), 7000);
    return () => window.clearTimeout(done);
  }, [afterglow]);

  const open = () => {
    remember(trackId);
    onOpen();
    if (reducedMotion()) {
      setStage('gone');
      return;
    }
    setStage('opening');
    setAfterglow(true);
  };

  // Literal keys, so check:i18n sees each one in use.
  const copy =
    season === 'xmas'
      ? { title: 'holiday.open.xmas.title', cta: 'holiday.open.xmas.cta' }
      : { title: 'holiday.open.newyear.title', cta: 'holiday.open.newyear.cta' };

  /*
   * Into <body>, not in place: the song page sits inside elements that make a
   * containing block for `position: fixed`, so in place it covered the page
   * column and slid under the header instead of filling the screen.
   */
  return createPortal(
    <>
      {stage !== 'gone' && (
        <div className={`holiday-open holiday-open--${season}${stage === 'opening' ? ' is-opening' : ''}`} role="region" aria-label={t(copy.title, { to })}>
          <div className="holiday-open__object" aria-hidden="true">
            {season === 'xmas' ? (
              <>
                <span className="holiday-open__lid" />
                <span className="holiday-open__box" />
              </>
            ) : (
              <span className="holiday-open__card">
                <span className="holiday-open__sun" />
              </span>
            )}
          </div>
          <p className="holiday-open__title">{t(copy.title, { to })}</p>
          <p className="holiday-open__sub">{t('holiday.open.inside')}</p>
          <button type="button" className="btn btn--primary btn--lg" onClick={open} autoFocus disabled={stage === 'opening'}>
            {t(copy.cta)}
          </button>
        </div>
      )}
      {afterglow && season === 'xmas' && <Snow />}
      {afterglow && season === 'newyear' && <span className="holiday-sunrise" aria-hidden="true" />}
    </>,
    document.body,
  );
}

/** A short fall of snow over the page; nothing to click, nothing to read. */
export function Snow({ flakes = 28 }: { flakes?: number }) {
  return (
    <div className="holiday-snow" aria-hidden="true">
      {Array.from({ length: flakes }, (_, i) => (
        <span
          key={i}
          style={{
            left: `${(i * 37) % 100}%`,
            animationDelay: `${((i * 0.29) % 3).toFixed(2)}s`,
            animationDuration: `${(4 + ((i * 0.53) % 3)).toFixed(2)}s`,
            width: `${4 + (i % 4)}px`,
            height: `${4 + (i % 4)}px`,
          }}
        />
      ))}
    </div>
  );
}
