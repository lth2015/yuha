import { useEffect, useMemo, useState } from 'react';
import { holidayMomentsAt, type HolidayMoment } from '@yuha/contracts';
import { useI18n } from '../lib/i18n';
import { useSession } from '../lib/session';
import { Snow } from './HolidayOpening';

/**
 * The small things the site does on particular days (docs/HOLIDAY_SPEC.md):
 * snow on the 24th and 25th, the countdown into the new year, a greeting in
 * the footer on the first three days. Drawn here only — no request, no count.
 *
 * The clock is the server's (GET /v1/runtime serverTime), carried forward
 * from when the page loaded, so a laptop set to the wrong day does not snow
 * in March. `?preview-moment=snow|countdown|new-year-greeting` shows one now;
 * it is decoration, so there is nothing to protect.
 */
export function useHolidayMoments(): { moments: HolidayMoment[]; now: () => Date } {
  const { runtime } = useSession();
  const offset = useMemo(() => (runtime?.serverTime ? Date.parse(runtime.serverTime) - Date.now() : 0), [runtime?.serverTime]);
  const now = useMemo(() => () => new Date(Date.now() + offset), [offset]);
  const preview = useMemo(() => {
    try {
      const asked = new URLSearchParams(window.location.search).get('preview-moment');
      return asked === 'snow' || asked === 'countdown' || asked === 'new-year-greeting' ? (asked as HolidayMoment) : null;
    } catch {
      return null;
    }
  }, []);
  const [moments, setMoments] = useState<HolidayMoment[]>(() => holidayMomentsAt(now()));
  useEffect(() => {
    const tick = () => setMoments(holidayMomentsAt(now()));
    tick();
    const id = window.setInterval(tick, 15_000);
    return () => window.clearInterval(id);
  }, [now]);
  return { moments: preview && !moments.includes(preview) ? [...moments, preview] : moments, now };
}

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/** On the 24th and 25th: a few flakes over the page once per visit, then still. */
export function SiteSnow() {
  const { moments } = useHolidayMoments();
  const [falling, setFalling] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (done || !moments.includes('snow') || reducedMotion()) return;
    setFalling(true);
    const stop = window.setTimeout(() => {
      setFalling(false);
      setDone(true);
    }, 10_000);
    return () => window.clearTimeout(stop);
  }, [moments, done]);
  return falling ? <Snow flakes={18} /> : null;
}

/**
 * The last hour of the year on the home page: minutes and seconds to
 * midnight in Japan, then at midnight a greeting and one burst of fireworks.
 */
export function NewYearCountdown() {
  const { t } = useI18n();
  const { moments, now } = useHolidayMoments();
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!moments.includes('countdown')) return;
    const tick = () => {
      const at = now();
      // Midnight in Japan: the next 15:00 UTC.
      const target = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), 15, 0, 0));
      if (target.getTime() <= at.getTime() - 3_600_000) target.setUTCDate(target.getUTCDate() + 1);
      setLeft(Math.round((target.getTime() - at.getTime()) / 1000));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [moments, now]);
  if (!moments.includes('countdown') || left === null) return null;
  const arrived = left <= 0;
  const mm = String(Math.floor(Math.max(0, left) / 60)).padStart(2, '0');
  const ss = String(Math.max(0, left) % 60).padStart(2, '0');
  return (
    <section className="newyear-countdown" aria-live="polite">
      {arrived ? (
        <>
          <strong className="newyear-countdown__greeting">{t('gift.line.new_year')}</strong>
          {!reducedMotion() && <Fireworks />}
        </>
      ) : (
        <>
          <span className="newyear-countdown__label">{t('holiday.countdown')}</span>
          <strong className="newyear-countdown__clock num">
            {mm}:{ss}
          </strong>
        </>
      )}
    </section>
  );
}

function Fireworks() {
  return (
    <div className="holiday-fireworks" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} style={{ left: `${15 + i * 17}%`, top: `${20 + ((i * 23) % 40)}%`, animationDelay: `${i * 0.35}s` }} />
      ))}
    </div>
  );
}
